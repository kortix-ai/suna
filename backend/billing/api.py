from fastapi import APIRouter, HTTPException, Depends, Request
from typing import Optional, Dict
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
from .config import (
    TOKEN_PRICE_MULTIPLIER, 
    get_tier_by_price_id, 
    get_tier_by_name,
    TIERS, 
    get_monthly_credits
)
from .credit_manager import credit_manager

router = APIRouter(prefix="/billing/v2", tags=["billing"])

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

async def calculate_credit_breakdown(user_id: str, client) -> Dict:
    current_balance = await credit_service.get_balance(user_id)
    current_balance = float(current_balance)
    
    purchase_result = await client.from_('credit_ledger')\
        .select('amount, created_at, description')\
        .eq('user_id', user_id)\
        .eq('type', 'purchase')\
        .execute()
    
    total_purchased = sum(float(row['amount']) for row in purchase_result.data) if purchase_result.data else 0
    
    logger.info(f"🔍 Credit breakdown for user {user_id}:")
    logger.info(f"  Current balance: ${current_balance}")
    logger.info(f"  Total purchased (topups): ${total_purchased}")
    if purchase_result.data:
        for purchase in purchase_result.data:
            logger.info(f"    Purchase: ${purchase['amount']} - {purchase['description']}")
    
    topup_credits = total_purchased
    subscription_credits = max(0, current_balance - topup_credits)
    
    logger.info(f"  → Topup credits to preserve: ${topup_credits}")
    logger.info(f"  → Current subscription credits: ${subscription_credits}")
    
    return {
        'total_balance': current_balance,
        'topup_credits': topup_credits,
        'subscription_credits': subscription_credits,
        'total_purchased': total_purchased
    }

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
            "can_purchase_credits": tier.get('can_purchase_credits', False),
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
            
            from .config import get_project_limit, get_tier_by_name
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
        balance = await credit_manager.get_balance(user_id)
        return {'success': True, 'cost': 0, 'new_balance': balance['total']}

    result = await credit_manager.use_credits(
        user_id=user_id,
        amount=cost,
        description=f"Usage: {usage.model} ({usage.prompt_tokens}+{usage.completion_tokens} tokens)",
        thread_id=usage.thread_id,
        message_id=usage.message_id
    )
    
    if not result.get('success'):
        raise HTTPException(status_code=402, detail=result.get('error', 'Insufficient credits'))
    
    return {
        'success': True,
        'cost': float(cost),
        'new_balance': result['new_total'],
        'from_expiring': result['from_expiring'],
        'from_non_expiring': result['from_non_expiring']
    }

@router.get("/balance")
async def get_credit_balance(
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict:
    db = DBConnection()
    client = await db.client
    
    result = await client.from_('credit_accounts').select(
        'balance, expiring_credits, non_expiring_credits, tier, next_credit_grant'
    ).eq('user_id', user_id).execute()
    
    if result.data and len(result.data) > 0:
        account = result.data[0]
        tier_name = account.get('tier', 'free')
        tier_info = get_tier_by_name(tier_name)
        
        return {
            'balance': float(account.get('balance', 0)),
            'expiring_credits': float(account.get('expiring_credits', 0)),
            'non_expiring_credits': float(account.get('non_expiring_credits', 0)),
            'tier': tier_name,
            'can_purchase_credits': tier_info.can_purchase_credits if tier_info else False,
            'next_credit_grant': account.get('next_credit_grant'),
            'breakdown': {
                'expiring': float(account.get('expiring_credits', 0)),
                'non_expiring': float(account.get('non_expiring_credits', 0)),
                'total': float(account.get('balance', 0))
            }
        }
    
    return {
        'balance': 0.0,
        'expiring_credits': 0.0,
        'non_expiring_credits': 0.0,
        'tier': 'free',
        'can_purchase_credits': False,
        'next_credit_grant': None,
        'breakdown': {
            'expiring': 0.0,
            'non_expiring': 0.0,
            'total': 0.0
        }
    }

@router.post("/purchase-credits")
async def purchase_credits_checkout(
    request: PurchaseCreditsRequest,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict:
    tier = await get_user_subscription_tier(user_id)
    if not tier.get('can_purchase_credits', False):
        raise HTTPException(status_code=403, detail="Credit purchases not available for your tier")
    
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
        
        logger.info(f"[WEBHOOK] Received event: type={event.type}, id={event.id}")
        db = DBConnection()
        client = await db.client
        
        cache_key = f"stripe_event:{event.id}"
        if await Cache.get(cache_key):
            logger.info(f"[WEBHOOK] Event {event.id} already processed, skipping")
            return {'status': 'success', 'message': 'Event already processed'}
        
        await Cache.set(cache_key, True, ttl=3600)
        
        if event.type == 'checkout.session.completed':
            session = event.data.object
            logger.info(f"[WEBHOOK] Checkout session completed: id={session.id}")
            logger.info(f"[WEBHOOK] Session metadata: {session.get('metadata', {})}")
            
            if session.get('metadata', {}).get('type') == 'credit_purchase':
                user_id = session['metadata']['user_id']
                credit_amount = Decimal(session['metadata']['credit_amount'])
                
                logger.info(f"[WEBHOOK] Processing credit purchase: user={user_id}, amount=${credit_amount}")
                
                current_state = await client.from_('credit_accounts').select(
                    'balance, expiring_credits, non_expiring_credits'
                ).eq('user_id', user_id).execute()
                
                if current_state.data:
                    logger.info(f"[WEBHOOK] State BEFORE purchase: {current_state.data[0]}")
                
                await client.table('credit_purchases').update({
                    'status': 'completed',
                    'completed_at': datetime.now(timezone.utc).isoformat()
                }).eq('stripe_payment_intent_id', session.payment_intent).execute()
                
                logger.info(f"[WEBHOOK] Calling credit_manager.add_credits with is_expiring=False")
                
                result = await credit_manager.add_credits(
                    user_id=user_id,
                    amount=credit_amount,
                    is_expiring=False,
                    description=f"Purchased ${credit_amount} credits"
                )
                
                logger.info(f"[WEBHOOK] Credit purchase completed for user {user_id}: ${credit_amount} (non-expiring)")
                logger.info(f"[WEBHOOK] Result from credit_manager: {result}")
                
                final_state = await client.from_('credit_accounts').select(
                    'balance, expiring_credits, non_expiring_credits'
                ).eq('user_id', user_id).execute()
                
                if final_state.data:
                    logger.info(f"[WEBHOOK] State AFTER purchase: {final_state.data[0]}")
                    
                    before = current_state.data[0] if current_state.data else {'balance': 0, 'expiring_credits': 0, 'non_expiring_credits': 0}
                    after = final_state.data[0]
                    
                    expected_total = float(before['balance']) + float(credit_amount)
                    actual_total = float(after['balance'])
                    
                    if abs(expected_total - actual_total) > 0.01:
                        logger.error(f"[WEBHOOK] BALANCE MISMATCH! Expected ${expected_total}, got ${actual_total}")
                        logger.error(f"[WEBHOOK] Before: {before}")
                        logger.error(f"[WEBHOOK] After: {after}")
                        logger.error(f"[WEBHOOK] Credit amount: ${credit_amount}")
            elif session.get('subscription'):
                logger.info(f"[WEBHOOK] Checkout completed for new subscription: {session['subscription']}")
        
        elif event.type in ['customer.subscription.created', 'customer.subscription.updated']:
            subscription = event.data.object
            logger.info(f"[WEBHOOK] Subscription event: type={event.type}, status={subscription.status}")
            if subscription.status in ['active', 'trialing']:
                logger.info(f"[WEBHOOK] Processing subscription change for customer: {subscription['customer']}")
                await handle_subscription_change(subscription)
        
        elif event.type == 'invoice.payment_succeeded':
            invoice = event.data.object
            billing_reason = invoice.get('billing_reason')
            logger.info(f"[WEBHOOK] Invoice payment succeeded - billing_reason: {billing_reason}, invoice_id: {invoice.get('id')}")
            
            if invoice.get('lines', {}).get('data'):
                for line in invoice['lines']['data']:
                    if 'Credit' in line.get('description', ''):
                        logger.info(f"[WEBHOOK] Skipping renewal - this is a credit purchase invoice")
                        return {'status': 'success'}
            
            if invoice.get('subscription') and billing_reason == 'subscription_cycle':
                logger.info(f"[WEBHOOK] Processing subscription renewal for subscription: {invoice['subscription']}")
                await handle_subscription_renewal(invoice)
            else:
                logger.info(f"[WEBHOOK] Skipping renewal handler for billing_reason: {billing_reason}")
        
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
    
    account_result = await client.from_('credit_accounts').select('tier, billing_cycle_anchor, stripe_subscription_id').eq('user_id', user_id).execute()
    
    if not account_result.data or len(account_result.data) == 0:
        logger.info(f"User {user_id} has no credit account, creating free tier account first")
        await client.from_('credit_accounts').insert({
            'user_id': user_id,
            'balance': 0,
            'tier': 'free'
        }).execute()
        account_result = await client.from_('credit_accounts').select('tier, billing_cycle_anchor, stripe_subscription_id').eq('user_id', user_id).execute()
    
    if account_result.data and len(account_result.data) > 0:
        current_tier_name = account_result.data[0].get('tier')
        existing_anchor = account_result.data[0].get('billing_cycle_anchor')
        old_subscription_id = account_result.data[0].get('stripe_subscription_id')

        current_tier_info = TIERS.get(current_tier_name)
        current_tier = None
        if current_tier_info:
            current_tier = {
                'name': current_tier_info.name,
                'credits': float(current_tier_info.monthly_credits)
            }
        
        should_grant_credits = False
        
        if current_tier_name == 'free' and new_tier['name'] != 'free':
            should_grant_credits = True
            logger.info(f"Upgrade from free tier to {new_tier['name']} - will grant credits")
        elif current_tier:
            if current_tier['name'] != new_tier['name']:
                if new_tier['credits'] > current_tier['credits']:
                    should_grant_credits = True
                    logger.info(f"Tier upgrade detected: {current_tier['name']} -> {new_tier['name']}")
                else:
                    logger.info(f"Tier change (not upgrade): {current_tier['name']} -> {new_tier['name']}")
            elif subscription['id'] != old_subscription_id and old_subscription_id is not None:
                should_grant_credits = True
                logger.info(f"New subscription for tier {new_tier['name']}: {old_subscription_id} -> {subscription['id']}")
            elif new_tier['credits'] > current_tier['credits']:
                should_grant_credits = True
                logger.info(f"Credit increase for tier {new_tier['name']}: {current_tier['credits']} -> {new_tier['credits']}")
        
        if should_grant_credits:
            full_amount = Decimal(new_tier['credits'])
            logger.info(f"Granting {full_amount} credits to user {user_id}")
            
            expires_at = billing_anchor.replace(month=billing_anchor.month + 1) if billing_anchor.month < 12 else billing_anchor.replace(year=billing_anchor.year + 1, month=1)
            result = await credit_manager.add_credits(
                user_id=user_id,
                amount=full_amount,
                is_expiring=True,
                description=f"Subscription update: {new_tier['name']} - Full tier credits",
                expires_at=expires_at
            )
            
            logger.info(f"Successfully granted {full_amount} expiring credits")
        else:
            logger.info(f"No credits granted - not an upgrade scenario")
        
        await client.from_('credit_accounts').update({
            'tier': new_tier['name'],
            'stripe_subscription_id': subscription['id'],
            'billing_cycle_anchor': billing_anchor.isoformat(),
            'next_credit_grant': next_grant_date.isoformat()
        }).eq('user_id', user_id).execute()
    else:
        expires_at = billing_anchor.replace(month=billing_anchor.month + 1) if billing_anchor.month < 12 else billing_anchor.replace(year=billing_anchor.year + 1, month=1)
        
        await credit_manager.add_credits(
            user_id=user_id,
            amount=Decimal(new_tier['credits']),
            is_expiring=True,
            description=f"Initial grant for {new_tier['name']} subscription",
            expires_at=expires_at
        )
        
        await client.from_('credit_accounts').update({
            'tier': new_tier['name'],
            'stripe_subscription_id': subscription['id'],
            'billing_cycle_anchor': billing_anchor.isoformat(),
            'next_credit_grant': next_grant_date.isoformat()
        }).eq('user_id', user_id).execute()

async def handle_subscription_renewal(invoice: Dict):
    try:
        db = DBConnection()
        client = await db.client
        
        subscription_id = invoice.get('subscription')
        if not subscription_id:
            return

        period_start = invoice.get('period_start')
        period_end = invoice.get('period_end')
        
        if not period_start or not period_end:
            logger.warning(f"Invoice missing period information: {invoice.get('id')}")
            return
        
        customer_result = await client.schema('basejump').from_('billing_customers')\
            .select('account_id')\
            .eq('id', invoice['customer'])\
            .execute()
        
        if not customer_result.data:
            return
        
        user_id = customer_result.data[0]['account_id']
        
        account_result = await client.from_('credit_accounts')\
            .select('tier, last_grant_date, next_credit_grant, billing_cycle_anchor')\
            .eq('user_id', user_id)\
            .execute()
        
        if not account_result.data:
            return
        
        account = account_result.data[0]
        tier = account['tier']
        period_start_dt = datetime.fromtimestamp(period_start, tz=timezone.utc)
        
        if account.get('last_grant_date'):
            last_grant = datetime.fromisoformat(account['last_grant_date'].replace('Z', '+00:00'))
            
            if period_start_dt <= last_grant:
                logger.info(f"Skipping renewal for user {user_id} - already processed")
                return
        
        monthly_credits = get_monthly_credits(tier)
        if monthly_credits > 0:
            logger.info(f"💰 [RENEWAL] Processing subscription renewal for user {user_id}, tier={tier}, monthly_credits=${monthly_credits}")
            
            # Get current state before renewal
            current_state = await client.from_('credit_accounts').select(
                'balance, expiring_credits, non_expiring_credits'
            ).eq('user_id', user_id).execute()
            
            if current_state.data:
                logger.info(f"[RENEWAL] State BEFORE renewal: {current_state.data[0]}")
            
            # Use the credit manager to reset expiring credits while preserving non-expiring
            result = await credit_manager.reset_expiring_credits(
                user_id=user_id,
                new_credits=monthly_credits,
                description=f"Monthly {tier} tier credits renewal"
            )
            
            if result['success']:
                logger.info(f"[RENEWAL] Renewal complete: Expiring=${result['new_expiring']:.2f}, "
                           f"Non-expiring=${result['non_expiring']:.2f}, Total=${result['total_balance']:.2f}")
            
            next_grant = datetime.fromtimestamp(period_end, tz=timezone.utc)
            
            await client.from_('credit_accounts').update({
                'last_grant_date': period_start_dt.isoformat(),
                'next_credit_grant': next_grant.isoformat()
            }).eq('user_id', user_id).execute()
            
            # Get final state after renewal
            final_state = await client.from_('credit_accounts').select(
                'balance, expiring_credits, non_expiring_credits'
            ).eq('user_id', user_id).execute()
            
            if final_state.data:
                logger.info(f"[RENEWAL] State AFTER renewal: {final_state.data[0]}")
            
            await Cache.invalidate(f"credit_balance:{user_id}")
            await Cache.invalidate(f"credit_summary:{user_id}")
            await Cache.invalidate(f"subscription_tier:{user_id}")
            
            logger.info(f"✅ [RENEWAL] Renewed credits for user {user_id}: ${monthly_credits} expiring + "
                       f"${result['non_expiring']:.2f} non-expiring = ${result['total_balance']:.2f} total")
    
    except Exception as e:
        logger.error(f"Error handling subscription renewal: {e}")

@router.get("/subscription")
async def get_subscription(
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict:
    try:
        db = DBConnection()
        client = await db.client
        
        credit_result = await client.from_('credit_accounts').select('*').eq('user_id', user_id).execute()
        
        subscription_data = None
        
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
            else:
                price_id = config.STRIPE_FREE_TIER_ID
            
            stripe_subscription_id = credit_account.get('stripe_subscription_id')
            if stripe_subscription_id:
                try:
                    stripe_subscription = await stripe.Subscription.retrieve_async(
                        stripe_subscription_id,
                        expand=['items.data.price']
                    )
                    
                    if stripe_subscription.get('price_id'):
                        price_id = stripe_subscription['price_id']
                    
                    current_period_end = stripe_subscription.get('current_period_end')
                    cancel_at = stripe_subscription.get('cancel_at')
                    
                    subscription_data = {
                        'id': stripe_subscription_id,
                        'status': stripe_subscription.get('status', 'active'),
                        'cancel_at_period_end': bool(stripe_subscription.get('cancel_at_period_end')),
                        'cancel_at': cancel_at,
                        'current_period_end': current_period_end
                    }
                except Exception as stripe_error:
                    logger.warning(f"Could not retrieve Stripe subscription {stripe_subscription_id}: {stripe_error}")
        else:
            tier_name = 'free'
            tier_obj = TIERS['free']
            tier_info = {
                'name': 'free',
                'credits': float(TIERS['free'].monthly_credits)
            }
            price_id = config.STRIPE_FREE_TIER_ID
        
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
            'can_purchase_credits': TIERS.get(tier_info.get('name', 'free'), TIERS['free']).can_purchase_credits,
            'tier': tier_info,
            'credits': {
                'balance': float(balance),
                'tier_credits': tier_info['credits'],
                'lifetime_granted': float(summary['lifetime_granted']),
                'lifetime_purchased': float(summary['lifetime_purchased']),
                'lifetime_used': float(summary['lifetime_used']),
                'can_purchase_credits': TIERS.get(tier_info.get('name', 'free'), TIERS['free']).can_purchase_credits
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
        
        credit_account = await client.from_('credit_accounts').select('stripe_subscription_id').eq('user_id', user_id).execute()
        
        existing_subscription_id = None
        if credit_account.data and len(credit_account.data) > 0:
            existing_subscription_id = credit_account.data[0].get('stripe_subscription_id')
        
        if existing_subscription_id:
            subscription = await stripe.Subscription.retrieve_async(existing_subscription_id)
            
            logger.info(f"Updating subscription {existing_subscription_id} to price {request.price_id}")
            
            updated_subscription = await stripe.Subscription.modify_async(
                existing_subscription_id,
                items=[{
                    'id': subscription['items']['data'][0].id,
                    'price': request.price_id,
                }],
                proration_behavior='always_invoice',
                payment_behavior='pending_if_incomplete'
            )
            
            logger.info(f"Stripe subscription updated, calling handle_subscription_change")
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
        
        credit_account = await client.from_('credit_accounts')\
            .select('stripe_subscription_id')\
            .eq('user_id', user_id)\
            .single()\
            .execute()
        
        if not credit_account.data or not credit_account.data.get('stripe_subscription_id'):
            return {
                'success': False,
                'message': 'No active subscription found'
            }
        
        subscription = await stripe.Subscription.retrieve_async(
            credit_account.data['stripe_subscription_id'],
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
        
        credit_account = await client.from_('credit_accounts').select('stripe_subscription_id').eq('user_id', user_id).single().execute()
        
        if not credit_account.data or not credit_account.data.get('stripe_subscription_id'):
            raise HTTPException(status_code=404, detail="No active subscription found")
        
        subscription = await stripe.Subscription.modify_async(
            credit_account.data['stripe_subscription_id'],
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
        
        credit_account = await client.from_('credit_accounts').select('stripe_subscription_id').eq('user_id', user_id).single().execute()
        
        if not credit_account.data or not credit_account.data.get('stripe_subscription_id'):
            raise HTTPException(status_code=404, detail="No active subscription found")
        
        subscription = await stripe.Subscription.modify_async(
            credit_account.data['stripe_subscription_id'],
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

@router.get("/credit-breakdown")
async def get_credit_breakdown(
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict:
    db = DBConnection()
    client = await db.client
    
    account_result = await client.from_('credit_accounts')\
        .select('balance, expiring_credits, non_expiring_credits, tier, next_credit_grant')\
        .eq('user_id', user_id)\
        .execute()
    
    if not account_result.data:
        return {
            'total_balance': 0,
            'expiring_credits': 0,
            'non_expiring_credits': 0,
            'tier': 'free',
            'next_credit_grant': None,
            'message': 'No credit account found'
        }
    
    account = account_result.data[0]
    total = float(account.get('balance', 0))
    expiring = float(account.get('expiring_credits', 0))
    non_expiring = float(account.get('non_expiring_credits', 0))
    
    purchase_result = await client.from_('credit_ledger')\
        .select('amount, created_at, description')\
        .eq('user_id', user_id)\
        .eq('type', 'purchase')\
        .order('created_at', desc=True)\
        .limit(5)\
        .execute()
    
    recent_purchases = [
        {
            'amount': float(p['amount']),
            'date': p['created_at'],
            'description': p['description']
        }
        for p in purchase_result.data
    ] if purchase_result.data else []
    
    return {
        'total_balance': total,
        'expiring_credits': expiring,
        'non_expiring_credits': non_expiring,
        'tier': account.get('tier', 'free'),
        'next_credit_grant': account.get('next_credit_grant'),
        'recent_purchases': recent_purchases,
        'message': f"Your ${total:.2f} balance includes ${expiring:.2f} expiring (plan) credits and ${non_expiring:.2f} non-expiring (purchased) credits"
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
    
    db = DBConnection()
    client = await db.client
    
    try:
        account_result = await client.from_('credit_accounts').select(
            'tier, balance, expiring_credits, non_expiring_credits'
        ).eq('user_id', user_id).execute()
        
        if not account_result.data:
            return {
                'success': False,
                'message': 'No credit account found'
            }
        
        account = account_result.data[0]
        tier = account.get('tier', 'free')
        
        monthly_credits = get_monthly_credits(tier)
        if monthly_credits > 0:
            result = await credit_manager.reset_expiring_credits(
                user_id=user_id,
                new_credits=monthly_credits,
                description=f"TEST: Monthly {tier} tier credits renewal"
            )
            
            next_grant = datetime.now(timezone.utc) + timedelta(days=30)
            await client.from_('credit_accounts').update({
                'last_grant_date': datetime.now(timezone.utc).isoformat(),
                'next_credit_grant': next_grant.isoformat()
            }).eq('user_id', user_id).execute()
            
            final_result = await client.from_('credit_accounts').select(
                'balance, expiring_credits, non_expiring_credits'
            ).eq('user_id', user_id).execute()
            
            await Cache.invalidate(f"credit_balance:{user_id}")
            await Cache.invalidate(f"credit_summary:{user_id}")
            await Cache.invalidate(f"subscription_tier:{user_id}")
            
            return {
                'success': True,
                'message': f'Successfully simulated renewal for {tier} tier',
                'tier': tier,
                'credits_granted': float(monthly_credits),
                'new_balance': result['total_balance'],
                'new_expiring': result['new_expiring'],
                'new_non_expiring': result['non_expiring'],
                'final_state': final_result.data[0] if final_result.data else None,
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