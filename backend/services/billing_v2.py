from fastapi import APIRouter, HTTPException, Depends, Request
from typing import Optional, Dict, Tuple, List
from decimal import Decimal
from datetime import datetime, timezone, timedelta
from pydantic import BaseModel
import stripe
from core.credits import credit_service
from core.services.supabase import DBConnection
from core.utils.auth_utils import verify_and_get_user_id_from_jwt
from core.utils.config import config, EnvMode
from core.utils.logger import logger
from core.utils.cache import Cache
from core.ai_models import model_manager
from core.billing_config import TOKEN_PRICE_MULTIPLIER, get_tier_by_price_id, TIERS, get_monthly_credits

router = APIRouter(prefix="/billing/v2", tags=["billing-v2"])

stripe.api_key = config.STRIPE_SECRET_KEY

class CreateCheckoutSessionRequest(BaseModel):
    price_id: str
    success_url: str
    cancel_url: str

class CreatePortalSessionRequest(BaseModel):
    return_url: str

class PurchaseCreditsRequest(BaseModel):
    amount: Decimal
    success_url: str
    cancel_url: str

class TokenUsageRequest(BaseModel):
    prompt_tokens: int
    completion_tokens: int
    model: str
    thread_id: Optional[str] = None
    message_id: Optional[str] = None

class CancelSubscriptionRequest(BaseModel):
    feedback: Optional[str] = None

def calculate_token_cost(prompt_tokens: int, completion_tokens: int, model: str) -> Decimal:
    try:
        resolved_model = model_manager.resolve_model_id(model)
        model_obj = model_manager.get_model(resolved_model)
        
        if model_obj and model_obj.pricing:
            input_cost = Decimal(prompt_tokens) / Decimal('1000000') * Decimal(str(model_obj.pricing.input_cost_per_million_tokens))
            output_cost = Decimal(completion_tokens) / Decimal('1000000') * Decimal(str(model_obj.pricing.output_cost_per_million_tokens))
            return (input_cost + output_cost) * TOKEN_PRICE_MULTIPLIER
        
        return Decimal('0.01')
    except Exception as e:
        logger.error(f"Error calculating token cost: {e}")
        return Decimal('0.01')

async def get_user_subscription_tier(user_id: str) -> Dict:
    cache_key = f"subscription_tier:{user_id}"
    cached = await Cache.get(cache_key)
    if cached:
        return cached
    
    db = DBConnection()
    client = await db.client
    
    credit_result = await client.from_('credit_accounts').select('tier').eq('user_id', user_id).execute()
    
    if credit_result.data and len(credit_result.data) > 0:
        tier_name = credit_result.data[0].get('tier', 'free')
    else:
        result = await client.schema('basejump').from_('billing_subscriptions').select('price_id, status').eq('account_id', user_id).in_('status', ['active', 'trialing']).order('created', desc=True).limit(1).execute()
        
        if result.data:
            price_id = result.data[0]['price_id']
            tier_obj = get_tier_by_price_id(price_id)
            tier_name = tier_obj.name if tier_obj else 'free'
        else:
            tier_name = 'free'
    
    tier_obj = TIERS.get(tier_name, TIERS['free'])
    tier_info = {
        'name': tier_obj.name,
        'credits': float(tier_obj.monthly_credits),
        'can_purchase_credits': tier_obj.can_purchase_credits,
        'models': tier_obj.models,
        'project_limit': tier_obj.project_limit
    }
    
    await Cache.set(cache_key, tier_info, ttl=60)
    return tier_info

async def get_or_create_stripe_customer(user_id: str) -> str:
    db = DBConnection()
    client = await db.client
    
    customer_result = await client.schema('basejump').from_('billing_customers').select('id').eq('account_id', user_id).execute()
    
    if customer_result.data and len(customer_result.data) > 0:
        return customer_result.data[0]['id']
    
    email = None
    try:
        user_result = await client.auth.admin.get_user_by_id(user_id)
        if user_result and user_result.user:
            email = user_result.user.email
    except Exception as e:
        logger.warning(f"Could not get user email from auth: {e}")
    
    if not email:
        email = f"{user_id}@users.kortix.ai"
        logger.warning(f"Using placeholder email for user {user_id}: {email}")
    
    customer = await stripe.Customer.create_async(
        email=email,
        metadata={'user_id': user_id, 'account_type': 'personal'}
    )
    
    await client.schema('basejump').from_('billing_customers').insert({
        'id': customer.id,
        'account_id': user_id,
        'email': email
    }).execute()
    
    logger.info(f"Created new Stripe customer {customer.id} for user {user_id}")
    return customer.id

@router.post("/check")
async def check_billing_status(
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict:
    if config.ENV_MODE == EnvMode.LOCAL:
        return {'can_run': True, 'message': 'Local mode', 'balance': 999999}
    
    balance = await credit_service.get_balance(user_id)
    tier = await get_user_subscription_tier(user_id)
    
    return {
        'can_run': balance > 0,
        'balance': float(balance),
        'tier': tier['name'],
        'message': 'Sufficient credits' if balance > 0 else 'Insufficient credits'
    }

@router.get("/check-status")
async def check_status(
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict:
    try:
        if config.ENV_MODE == EnvMode.LOCAL:
            return {
                "can_run": True,
                "message": "Local development mode",
                "subscription": {
                    "price_id": "local_dev",
                    "plan_name": "Local Development"
                },
                "credit_balance": 999999,
                "can_purchase_credits": False
            }
        
        balance = await credit_service.get_balance(user_id)
        summary = await credit_service.get_account_summary(user_id)
        tier = await get_user_subscription_tier(user_id)
        
        can_run = balance >= Decimal('0.01')
        
        subscription = {
            "price_id": "credit_based",
            "plan_name": tier['name'],
            "tier": tier['name']
        }
        
        return {
            "can_run": can_run,
            "message": "Sufficient credits" if can_run else "Insufficient credits - please add more credits",
            "subscription": subscription,
            "credit_balance": float(balance),
            "can_purchase_credits": tier['name'] == 'tier_200_1000',
            "tier_info": tier,
            "credits_summary": {
                "balance": float(balance),
                "lifetime_granted": summary['lifetime_granted'],
                "lifetime_purchased": summary['lifetime_purchased'],
                "lifetime_used": summary['lifetime_used']
            }
        }
        
    except Exception as e:
        logger.error(f"Error checking billing status: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/project-limits")
async def get_project_limits(user_id: str = Depends(verify_and_get_user_id_from_jwt)):
    try:
        async with DBConnection() as db:
            credit_result = await db.client.table('credit_accounts').select('tier').eq('user_id', user_id).execute()
            tier = credit_result.data[0].get('tier', 'free') if credit_result.data else 'free'
            
            projects_result = await db.client.table('projects').select('project_id').eq('account_id', user_id).execute()
            current_count = len(projects_result.data or [])
            
            from core.billing_config import get_project_limit, get_tier_by_name
            project_limit = get_project_limit(tier)
            tier_info = get_tier_by_name(tier)
            
            return {
                'tier': tier,
                'tier_display_name': tier_info.display_name if tier_info else 'Free',
                'current_count': current_count,
                'limit': project_limit,
                'can_create': current_count < project_limit,
                'percent_used': round((current_count / project_limit) * 100, 2) if project_limit > 0 else 0
            }
    except Exception as e:
        logger.error(f"Error getting project limits: {e}")
        return {
            'tier': 'free',
            'tier_display_name': 'Free',
            'current_count': 0,
            'limit': 3,
            'can_create': True,
            'percent_used': 0
        }

@router.post("/deduct")
async def deduct_token_usage(
    usage: TokenUsageRequest,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict:
    if config.ENV_MODE == EnvMode.LOCAL:
        return {'success': True, 'cost': 0, 'new_balance': 999999}
    
    cost = calculate_token_cost(usage.prompt_tokens, usage.completion_tokens, usage.model)
    
    if cost <= 0:
        return {'success': True, 'cost': 0, 'new_balance': float(await credit_service.get_balance(user_id))}
    
    result = await credit_service.deduct_credits(
        user_id=user_id,
        amount=cost,
        description=f"Usage: {usage.model} ({usage.prompt_tokens}+{usage.completion_tokens} tokens)",
        reference_id=usage.message_id,
        reference_type='message'
    )
    
    if not result['success']:
        raise HTTPException(status_code=402, detail="Insufficient credits")
    
    return {
        'success': True,
        'cost': float(cost),
        'new_balance': float(result['new_balance']),
        'transaction_id': result['transaction_id']
    }

@router.get("/balance")
async def get_credit_balance(
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict:
    balance = await credit_service.get_balance(user_id)
    summary = await credit_service.get_account_summary(user_id)
    tier = await get_user_subscription_tier(user_id)
    
    can_purchase = tier['name'] == 'tier_200_1000'
    
    return {
        'balance': float(balance),
        'lifetime_granted': summary['lifetime_granted'],
        'lifetime_purchased': summary['lifetime_purchased'],
        'lifetime_used': summary['lifetime_used'],
        'can_purchase_credits': can_purchase,
        'tier': tier['name']
    }

@router.post("/purchase-credits")
async def purchase_credits_checkout(
    request: PurchaseCreditsRequest,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict:
    tier = await get_user_subscription_tier(user_id)
    if tier['name'] != 'tier_200_1000':
        raise HTTPException(status_code=403, detail="Credit purchases only available for highest tier")
    
    db = DBConnection()
    client = await db.client
    
    customer_result = await client.schema('basejump').from_('billing_customers').select('id, email').eq('account_id', user_id).execute()
    
    if not customer_result.data or len(customer_result.data) == 0:
        raise HTTPException(status_code=400, detail="No billing customer found")
    
    session = await stripe.checkout.Session.create_async(
        customer=customer_result.data[0]['id'],
        payment_method_types=['card'],
        line_items=[{
            'price_data': {
                'currency': 'usd',
                'product_data': {'name': f'${request.amount} Credits'},
                'unit_amount': int(request.amount * 100)
            },
            'quantity': 1
        }],
        mode='payment',
        success_url=request.success_url,
        cancel_url=request.cancel_url,
        metadata={
            'type': 'credit_purchase',
            'user_id': user_id,
            'credit_amount': str(request.amount)
        }
    )
    
    await client.table('credit_purchases').insert({
        'user_id': user_id,
        'amount_dollars': float(request.amount),
        'stripe_payment_intent_id': session.payment_intent,
        'status': 'pending',
        'metadata': {'session_id': session.id}
    }).execute()
    
    return {'checkout_url': session.url}

@router.post("/webhook")
async def stripe_webhook(request: Request):
    try:
        payload = await request.body()
        sig_header = request.headers.get('stripe-signature')
        
        event = stripe.Webhook.construct_event(
            payload, sig_header, config.STRIPE_WEBHOOK_SECRET
        )
        
        if event.type == 'checkout.session.completed':
            session = event.data.object
            
            if session.get('metadata', {}).get('type') == 'credit_purchase':
                user_id = session['metadata']['user_id']
                credit_amount = Decimal(session['metadata']['credit_amount'])
                
                db = DBConnection()
                client = await db.client
                
                await client.table('credit_purchases').update({
                    'status': 'completed',
                    'completed_at': datetime.now(timezone.utc).isoformat()
                }).eq('stripe_payment_intent_id', session.payment_intent).execute()
                
                await credit_service.add_credits(
                    user_id=user_id,
                    amount=credit_amount,
                    type='purchase',
                    description=f"Purchased ${credit_amount} credits"
                )
                
                logger.info(f"Credit purchase completed for user {user_id}: ${credit_amount}")
        
        elif event.type in ['customer.subscription.created', 'customer.subscription.updated']:
            subscription = event.data.object
            if subscription.status in ['active', 'trialing']:
                await handle_subscription_change(subscription)
        
        elif event.type == 'invoice.payment_succeeded':
            invoice = event.data.object
            if invoice.get('subscription') and invoice.get('billing_reason') in ['subscription_cycle', 'subscription_update']:
                await handle_subscription_renewal(invoice)
        
        return {'status': 'success'}
    
    except Exception as e:
        logger.error(f"Webhook error: {e}")
        raise HTTPException(status_code=400, detail=str(e))

async def handle_subscription_change(subscription: Dict):
    db = DBConnection()
    client = await db.client
    
    customer_result = await client.schema('basejump').from_('billing_customers').select('account_id').eq('id', subscription['customer']).execute()
    
    if not customer_result.data or len(customer_result.data) == 0:
        return
    
    user_id = customer_result.data[0]['account_id']
    price_id = subscription['items']['data'][0]['price']['id'] if subscription.get('items') else None
    
    new_tier_info = get_tier_by_price_id(price_id)
    if not new_tier_info:
        logger.warning(f"Unknown price ID in subscription: {price_id}")
        return
    
    new_tier = {
        'name': new_tier_info.name,
        'credits': float(new_tier_info.monthly_credits)
    }
    
    billing_anchor = datetime.fromtimestamp(subscription['current_period_start'], tz=timezone.utc)
    next_grant_date = datetime.fromtimestamp(subscription['current_period_end'], tz=timezone.utc)
    
    account_result = await client.from_('credit_accounts').select('tier, billing_cycle_anchor').eq('user_id', user_id).execute()
    
    if account_result.data and len(account_result.data) > 0:
        current_tier_name = account_result.data[0].get('tier')
        existing_anchor = account_result.data[0].get('billing_cycle_anchor')

        current_tier_info = TIERS.get(current_tier_name)
        current_tier = None
        if current_tier_info:
            current_tier = {
                'name': current_tier_info.name,
                'credits': float(current_tier_info.monthly_credits)
            }
        
        if current_tier and current_tier['name'] != new_tier['name']:
            if new_tier['credits'] > current_tier['credits']:
                full_amount = Decimal(new_tier['credits'])
                await credit_service.add_credits(
                    user_id=user_id,
                    amount=full_amount,
                    type='tier_upgrade',
                    description=f"Upgrade to {new_tier['name']} - Full tier credits"
                )
                logger.info(f"Granted {full_amount} credits for tier upgrade: {current_tier['name']} -> {new_tier['name']}")
            elif new_tier['credits'] < current_tier['credits']:
                logger.info(f"Tier downgrade: {current_tier['name']} -> {new_tier['name']} - No credit adjustment")
        
        await client.from_('credit_accounts').update({
            'tier': new_tier['name'],
            'stripe_subscription_id': subscription['id'],
            'billing_cycle_anchor': billing_anchor.isoformat(),
            'next_credit_grant': next_grant_date.isoformat()
        }).eq('user_id', user_id).execute()
    else:
        await client.from_('credit_accounts').insert({
            'user_id': user_id,
            'balance': new_tier['credits'],
            'tier': new_tier['name'],
            'stripe_subscription_id': subscription['id'],
            'billing_cycle_anchor': billing_anchor.isoformat(),
            'next_credit_grant': next_grant_date.isoformat(),
            'last_grant_date': datetime.now(timezone.utc).isoformat()
        }).execute()
        
        await credit_service.add_credits(
            user_id=user_id,
            amount=Decimal(new_tier['credits']),
            type='tier_grant',
            description=f"Initial grant for {new_tier['name']} subscription"
        )

async def handle_subscription_renewal(invoice: Dict):
    try:
        db = DBConnection()
        client = await db.client
        
        subscription_id = invoice.get('subscription')
        if not subscription_id:
            return
        
        customer_result = await client.schema('basejump').from_('billing_customers')\
            .select('account_id')\
            .eq('id', invoice['customer'])\
            .execute()
        
        if not customer_result.data:
            return
        
        user_id = customer_result.data[0]['account_id']
        
        account_result = await client.from_('credit_accounts')\
            .select('tier, last_grant_date, next_credit_grant')\
            .eq('user_id', user_id)\
            .execute()
        
        if not account_result.data:
            return
        
        account = account_result.data[0]
        tier = account['tier']
        
        if account.get('last_grant_date'):
            last_grant = datetime.fromisoformat(account['last_grant_date'].replace('Z', '+00:00'))
            if (datetime.now(timezone.utc) - last_grant).days < 25:
                logger.info(f"Skipping credit grant for {user_id} - already granted {(datetime.now(timezone.utc) - last_grant).days} days ago")
                return
        
        monthly_credits = get_monthly_credits(tier)
        if monthly_credits > 0:
            await credit_service.add_credits(
                user_id=user_id,
                amount=monthly_credits,
                type='tier_grant',
                description=f"Monthly {tier} tier credits",
                metadata={'invoice_id': invoice['id'], 'subscription_id': subscription_id}
            )
            
            next_grant = datetime.now(timezone.utc) + timedelta(days=30)
            await client.from_('credit_accounts').update({
                'last_grant_date': datetime.now(timezone.utc).isoformat(),
                'next_credit_grant': next_grant.isoformat()
            }).eq('user_id', user_id).execute()
            
            logger.info(f"Granted {monthly_credits} credits to user {user_id} for subscription renewal")
    
    except Exception as e:
        logger.error(f"Error handling subscription renewal: {e}")

@router.get("/subscription")
async def get_subscription(
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict:
    try:
        db = DBConnection()
        client = await db.client
        
        subscription_result = await client.schema('basejump').from_('billing_subscriptions')\
            .select('*')\
            .eq('account_id', user_id)\
            .in_('status', ['active', 'trialing'])\
            .order('created', desc=True)\
            .limit(1)\
            .execute()
        
        subscription_data = None
        
        credit_result = await client.from_('credit_accounts').select('*').eq('user_id', user_id).execute()
        
        if credit_result.data:
            credit_account = credit_result.data[0]
            tier_name = credit_account.get('tier', 'free')
            tier_obj = TIERS.get(tier_name, TIERS['free'])
            
            actual_credits = float(tier_obj.monthly_credits)
            if tier_name != 'free':
                parts = tier_name.split('_')
                if len(parts) >= 3 and parts[0] == 'tier':
                    subscription_cost = float(parts[-1])
                    actual_credits = subscription_cost + 5.0
            
            tier_info = {
                'name': tier_obj.name,
                'credits': actual_credits
            }
            
            if tier_obj and len(tier_obj.price_ids) > 0:
                price_id = tier_obj.price_ids[0]
                
                if subscription_result.data:
                    subscription = subscription_result.data[0]
                    if subscription.get('price_id'):
                        price_id = subscription['price_id']
            else:
                price_id = config.STRIPE_FREE_TIER_ID
        else:
            tier_name = 'free'
            tier_obj = TIERS['free']
            tier_info = {
                'name': 'free',
                'credits': float(TIERS['free'].monthly_credits)
            }
            price_id = config.STRIPE_FREE_TIER_ID
        
        if subscription_result.data:
            subscription = subscription_result.data[0]
            
            stripe_subscription = None
            try:
                stripe_subscription = await stripe.Subscription.retrieve_async(
                    subscription['id'],
                    expand=['items.data.price']
                )
            except Exception as stripe_error:
                logger.warning(f"Could not retrieve Stripe subscription {subscription['id']}: {stripe_error}")
            
            current_period_end = None
            if stripe_subscription and stripe_subscription.get('current_period_end'):
                current_period_end = stripe_subscription['current_period_end']
            elif subscription.get('current_period_end'):
                try:
                    from datetime import datetime
                    dt = datetime.fromisoformat(subscription['current_period_end'].replace('Z', '+00:00'))
                    current_period_end = int(dt.timestamp())
                except:
                    current_period_end = None
            
            cancel_at = None
            if stripe_subscription and stripe_subscription.get('cancel_at'):
                cancel_at = stripe_subscription['cancel_at']
            elif subscription.get('cancel_at'):
                try:
                    from datetime import datetime
                    dt = datetime.fromisoformat(subscription['cancel_at'].replace('Z', '+00:00'))
                    cancel_at = int(dt.timestamp())
                except:
                    cancel_at = None
            
            subscription_data = {
                'id': subscription['id'],
                'status': subscription['status'],
                'cancel_at_period_end': bool(stripe_subscription.get('cancel_at_period_end') if stripe_subscription else subscription.get('cancel_at_period_end')),
                'cancel_at': cancel_at,
                'current_period_end': current_period_end
            }
        
        balance = await credit_service.get_balance(user_id)
        summary = await credit_service.get_account_summary(user_id)
        
        if subscription_data:
            status = 'active'
        elif tier_name != 'free':
            status = 'cancelled'
        else:
            status = 'no_subscription'
        
        return {
            'status': status,
            'plan_name': tier_info['name'],
            'price_id': price_id,
            'subscription': subscription_data,
            'subscription_id': subscription_data['id'] if subscription_data else None,
            'current_usage': float(summary['lifetime_used']),
            'cost_limit': tier_info['credits'],
            'credit_balance': float(balance),
            'can_purchase_credits': tier_info.get('name') in ['tier_200_1000', 'tier_50_400', 'tier_125_800'],
            'tier': tier_info,
            'credits': {
                'balance': float(balance),
                'tier_credits': tier_info['credits'],
                'lifetime_granted': float(summary['lifetime_granted']),
                'lifetime_purchased': float(summary['lifetime_purchased']),
                'lifetime_used': float(summary['lifetime_used']),
                'can_purchase': tier_info.get('name') in ['tier_200_1000', 'tier_50_400', 'tier_125_800']
            }
        }
        
    except Exception as e:
        logger.error(f"Error getting subscription: {e}", exc_info=True)
        free_tier = TIERS['free']
        tier_info = {
            'name': free_tier.name,
            'credits': float(free_tier.monthly_credits)
        }
        return {
            'status': 'no_subscription',
            'plan_name': 'free',
            'price_id': config.STRIPE_FREE_TIER_ID,
            'subscription': None,
            'subscription_id': None,
            'current_usage': 0,
            'cost_limit': tier_info['credits'],
            'credit_balance': 0,
            'can_purchase_credits': False,
            'tier': tier_info,
            'credits': {
                'balance': 0,
                'tier_credits': tier_info['credits'],
                'lifetime_granted': 0,
                'lifetime_purchased': 0,
                'lifetime_used': 0,
                'can_purchase': False
            }
        }

@router.post("/create-checkout-session")
async def create_checkout_session(
    request: CreateCheckoutSessionRequest,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict:
    try:
        customer_id = await get_or_create_stripe_customer(user_id)
        
        db = DBConnection()
        client = await db.client
        
        existing_sub = await client.schema('basejump').from_('billing_subscriptions').select('id').eq('account_id', user_id).in_('status', ['active', 'trialing']).execute()
        
        if existing_sub.data and len(existing_sub.data) > 0:
            subscription = await stripe.Subscription.retrieve_async(existing_sub.data[0]['id'])
            
            updated_subscription = await stripe.Subscription.modify_async(
                existing_sub.data[0]['id'],
                items=[{
                    'id': subscription['items']['data'][0].id,
                    'price': request.price_id,
                }],
                proration_behavior='always_invoice',
                payment_behavior='pending_if_incomplete'
            )
            
            await handle_subscription_change(updated_subscription)

            await Cache.invalidate(f"subscription_tier:{user_id}")
            await Cache.invalidate(f"credit_balance:{user_id}")
            await Cache.invalidate(f"credit_summary:{user_id}")
            
            old_price_id = subscription['items']['data'][0].price.id
            old_tier = get_tier_by_price_id(old_price_id)
            new_tier = get_tier_by_price_id(request.price_id)
            
            old_amount = float(old_tier.monthly_credits) if old_tier else 0
            new_amount = float(new_tier.monthly_credits) if new_tier else 0
            
            return {
                'status': 'upgraded' if new_amount > old_amount else 'updated',
                'subscription_id': updated_subscription.id,
                'message': 'Subscription updated successfully',
                'details': {
                    'is_upgrade': new_amount > old_amount,
                    'current_price': old_amount,
                    'new_price': new_amount
                }
            }
        else:
            session = await stripe.checkout.Session.create_async(
                customer=customer_id,
                payment_method_types=['card'],
                line_items=[{'price': request.price_id, 'quantity': 1}],
                mode='subscription',
                success_url=request.success_url,
                cancel_url=request.cancel_url,
                subscription_data={
                    'metadata': {
                        'user_id': user_id,
                        'account_type': 'personal'
                    }
                }
            )
            return {'checkout_url': session.url}
            
    except Exception as e:
        logger.error(f"Error creating checkout session: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/create-portal-session")
async def create_portal_session(
    request: CreatePortalSessionRequest,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict:
    try:
        customer_id = await get_or_create_stripe_customer(user_id)
        
        session = await stripe.billing_portal.Session.create_async(
            customer=customer_id,
            return_url=request.return_url
        )
        
        return {'portal_url': session.url}
        
    except Exception as e:
        logger.error(f"Error creating portal session: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/sync-subscription")
async def sync_subscription(
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict:
    try:
        db = DBConnection()
        client = await db.client
        
        sub_result = await client.schema('basejump').from_('billing_subscriptions')\
            .select('*')\
            .eq('account_id', user_id)\
            .in_('status', ['active', 'trialing'])\
            .limit(1)\
            .execute()
        
        if not sub_result.data or len(sub_result.data) == 0:
            return {
                'success': False,
                'message': 'No active subscription found'
            }
        
        subscription = await stripe.Subscription.retrieve_async(
            sub_result.data[0]['id'],
            expand=['items.data.price']
        )
        
        await handle_subscription_change(subscription)
        
        await Cache.invalidate(f"subscription_tier:{user_id}")
        await Cache.invalidate(f"credit_balance:{user_id}")
        await Cache.invalidate(f"credit_summary:{user_id}")
        
        balance = await credit_service.get_balance(user_id)
        summary = await credit_service.get_account_summary(user_id)
        
        return {
            'success': True,
            'message': 'Subscription synced successfully',
            'credits': {
                'balance': float(balance),
                'lifetime_granted': float(summary['lifetime_granted']),
                'lifetime_used': float(summary['lifetime_used'])
            }
        }
        
    except Exception as e:
        logger.error(f"Error syncing subscription: {e}", exc_info=True)
        return {
            'success': False,
            'message': f'Failed to sync subscription: {str(e)}'
        }

@router.post("/cancel-subscription")
async def cancel_subscription(
    request: CancelSubscriptionRequest,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict:
    try:
        db = DBConnection()
        client = await db.client
        
        sub_result = await client.schema('basejump').from_('billing_subscriptions').select('id').eq('account_id', user_id).in_('status', ['active', 'trialing']).execute()
        
        if not sub_result.data or len(sub_result.data) == 0:
            raise HTTPException(status_code=404, detail="No active subscription found")
        
        subscription = await stripe.Subscription.modify_async(
            sub_result.data[0]['id'],
            cancel_at_period_end=True,
            metadata={'cancellation_feedback': request.feedback} if request.feedback else None
        )
        
        await Cache.invalidate(f"subscription_tier:{user_id}")
        
        return {
            'success': True,
            'cancel_at': subscription.cancel_at,
            'message': 'Subscription will be canceled at the end of the billing period'
        }
        
    except Exception as e:
        logger.error(f"Error canceling subscription: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/reactivate-subscription")
async def reactivate_subscription(
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict:
    try:
        db = DBConnection()
        client = await db.client
        
        sub_result = await client.schema('basejump').from_('billing_subscriptions').select('id').eq('account_id', user_id).in_('status', ['active', 'trialing']).execute()
        
        if not sub_result.data or len(sub_result.data) == 0:
            raise HTTPException(status_code=404, detail="No active subscription found")
        
        subscription = await stripe.Subscription.modify_async(
            sub_result.data[0]['id'],
            cancel_at_period_end=False
        )
        
        await Cache.invalidate(f"subscription_tier:{user_id}")
        
        return {
            'success': True,
            'message': 'Subscription reactivated successfully'
        }
        
    except Exception as e:
        logger.error(f"Error reactivating subscription: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/transactions")
async def get_user_transactions(
    limit: int = 50,
    offset: int = 0,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict:
    transactions = await credit_service.get_ledger(user_id, limit, offset)
    return {
        'transactions': transactions,
        'count': len(transactions)
    } 

@router.get("/usage-history")
async def get_usage_history(
    days: int = 30,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict:
    try:
        db = DBConnection()
        client = await db.client
        
        start_date = datetime.now(timezone.utc) - timedelta(days=days)
        
        result = await client.from_('credit_ledger').select('created_at, amount, type, description').eq('user_id', user_id).gte('created_at', start_date.isoformat()).order('created_at', desc=True).execute()
        
        daily_usage = {}
        for entry in result.data:
            date_key = entry['created_at'][:10]
            if date_key not in daily_usage:
                daily_usage[date_key] = {'credits': 0, 'debits': 0, 'count': 0}
            
            amount = float(entry['amount'])
            if entry['type'] == 'debit':
                daily_usage[date_key]['debits'] += amount
                daily_usage[date_key]['count'] += 1
            else:
                daily_usage[date_key]['credits'] += amount
        
        return {
            'daily_usage': daily_usage,
            'total_period_usage': sum(day['debits'] for day in daily_usage.values()),
            'total_period_credits': sum(day['credits'] for day in daily_usage.values())
        }
        
    except Exception as e:
        logger.error(f"Error getting usage history: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e)) 


@router.get("/available-models")
async def get_available_models(
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict:
    try:
        from core.ai_models import model_manager
        from core.services.supabase import DBConnection
        from core.services.billing import get_allowed_models_for_user
        
        if config.ENV_MODE == EnvMode.LOCAL:
            logger.debug("Running in local development mode - all models available")

            all_models = model_manager.list_available_models(include_disabled=False)
            model_info = []
            
            for model_data in all_models:
                model_info.append({
                    "id": model_data["id"],
                    "display_name": model_data["name"],
                    "short_name": model_data.get("aliases", [model_data["name"]])[0] if model_data.get("aliases") else model_data["name"],
                    "requires_subscription": False,
                    "input_cost_per_million_tokens": model_data["pricing"]["input_per_million"] if model_data["pricing"] else None,
                    "output_cost_per_million_tokens": model_data["pricing"]["output_per_million"] if model_data["pricing"] else None,
                    "context_window": model_data["context_window"],
                    "capabilities": model_data["capabilities"],
                    "recommended": model_data["recommended"],
                    "priority": model_data["priority"]
                })
            
            return {
                "models": model_info,
                "subscription_tier": "Local Development",
                "total_models": len(model_info)
            }
        
        db = DBConnection()
        client = await db.client
        account_result = await client.from_('credit_accounts').select('tier').eq('user_id', user_id).execute()
        
        tier_name = 'free'
        if account_result.data and len(account_result.data) > 0:
            tier_name = account_result.data[0].get('tier', 'free')
        
        tier = await get_user_subscription_tier(user_id)
        
        all_models = model_manager.list_available_models(tier=None, include_disabled=False)
        logger.debug(f"Found {len(all_models)} total models available")
        
        allowed_models = await get_allowed_models_for_user(client, user_id)
        logger.debug(f"User {user_id} allowed models: {allowed_models}")
        logger.debug(f"User tier: {tier_name}")
        
        model_info = []
        for model_data in all_models:
            model_id = model_data["id"]
            
            can_access = model_id in allowed_models
            
            model_info.append({
                "id": model_id,
                "display_name": model_data["name"],
                "short_name": model_data.get("aliases", [model_data["name"]])[0] if model_data.get("aliases") else model_data["name"],
                "requires_subscription": not can_access,
                "input_cost_per_million_tokens": model_data["pricing"]["input_per_million"] if model_data["pricing"] else None,
                "output_cost_per_million_tokens": model_data["pricing"]["output_per_million"] if model_data["pricing"] else None,
                "context_window": model_data["context_window"],
                "capabilities": model_data["capabilities"],
                "recommended": model_data["recommended"],
                "priority": model_data["priority"]
            })
        
        model_info.sort(key=lambda x: (-x["priority"], x["display_name"]))
        
        return {
            "models": model_info,
            "subscription_tier": tier_name,
            "total_models": len(model_info),
            "allowed_models_count": len([m for m in model_info if not m["requires_subscription"]])
        }
        
    except Exception as e:
        logger.error(f"Error getting available models: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/subscription-commitment/{subscription_id}")
async def get_subscription_commitment(
    subscription_id: str,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict:
    return {
        'has_commitment': False,
        'can_cancel': True,
        'commitment_type': None,
        'months_remaining': None,
        'commitment_end_date': None
    }

@router.post("/test/trigger-renewal")
async def test_trigger_renewal(
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict:
    if config.ENV_MODE == EnvMode.PRODUCTION:
        raise HTTPException(status_code=403, detail="Test endpoints disabled in production")
    
    try:
        db = DBConnection()
        client = await db.client
        
        # Check credit_accounts as primary source of truth
        account_result = await client.from_('credit_accounts')\
            .select('*')\
            .eq('user_id', user_id)\
            .execute()
        
        if not account_result.data or len(account_result.data) == 0:
            return {
                'success': False,
                'message': 'No credit account found. Please subscribe to a plan first.'
            }
        
        account = account_result.data[0]
        
        # Only check if tier is not free (means they have a subscription)
        if account.get('tier', 'free') == 'free':
            return {
                'success': False,
                'message': 'No active subscription found. Please subscribe to a plan first.'
            }
        
        tier = account['tier']
        
        yesterday = datetime.now(timezone.utc) - timedelta(days=26)
        await client.from_('credit_accounts').update({
            'last_grant_date': yesterday.isoformat()
        }).eq('user_id', user_id).execute()
        
        monthly_credits = get_monthly_credits(tier)
        if monthly_credits > 0:
            await credit_service.add_credits(
                user_id=user_id,
                amount=monthly_credits,
                type='tier_grant',
                description=f"TEST: Monthly {tier} tier credits",
                metadata={'test': True, 'triggered_by': 'manual_test'}
            )
            
            next_grant = datetime.now(timezone.utc) + timedelta(days=30)
            await client.from_('credit_accounts').update({
                'last_grant_date': datetime.now(timezone.utc).isoformat(),
                'next_credit_grant': next_grant.isoformat()
            }).eq('user_id', user_id).execute()
            
            await Cache.invalidate(f"credit_balance:{user_id}")
            await Cache.invalidate(f"credit_summary:{user_id}")
            await Cache.invalidate(f"subscription_tier:{user_id}")
            
            new_balance = await credit_service.get_balance(user_id)
            
            return {
                'success': True,
                'message': f'Successfully granted {monthly_credits} credits',
                'tier': tier,
                'credits_granted': float(monthly_credits),
                'new_balance': float(new_balance),
                'next_grant_date': next_grant.isoformat()
            }
        else:
            return {
                'success': False,
                'message': f'No credits to grant for tier: {tier}'
            }
    
    except Exception as e:
        logger.error(f"Error in test renewal trigger: {e}", exc_info=True)
        return {
            'success': False,
            'message': str(e)
        } 