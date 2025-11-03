from fastapi import APIRouter, HTTPException, Depends, Request, Query
from typing import Optional, Dict, List
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
    get_tier_by_name,
    TIERS
)
from .credit_manager import credit_manager
from .webhook_service import webhook_service
from .subscription_service import subscription_service
from .trial_service import trial_service
from .payment_service import payment_service
from .reconciliation_service import reconciliation_service
from .stripe_circuit_breaker import StripeAPIWrapper, stripe_circuit_breaker
 
router = APIRouter(prefix="/billing", tags=["billing"])

stripe.api_key = config.STRIPE_SECRET_KEY

class CreateCheckoutSessionRequest(BaseModel):
    price_id: str
    success_url: str
    cancel_url: str
    commitment_type: Optional[str] = None

class CreatePortalSessionRequest(BaseModel):
    return_url: str
 
class PurchaseCreditsRequest(BaseModel):
    amount: Decimal
    success_url: str
    cancel_url: str

class TrialStartRequest(BaseModel):
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
        logger.debug(f"[COST_CALC] Calculating cost for model '{model}' with {prompt_tokens} prompt + {completion_tokens} completion tokens")
        
        resolved_model = model_manager.resolve_model_id(model)
        logger.debug(f"[COST_CALC] Model '{model}' resolved to '{resolved_model}'")
        
        model_obj = model_manager.get_model(resolved_model)
        
        if model_obj and model_obj.pricing:
            input_cost = Decimal(prompt_tokens) / Decimal('1000000') * Decimal(str(model_obj.pricing.input_cost_per_million_tokens))
            output_cost = Decimal(completion_tokens) / Decimal('1000000') * Decimal(str(model_obj.pricing.output_cost_per_million_tokens))
            total_cost = (input_cost + output_cost) * TOKEN_PRICE_MULTIPLIER
            
            logger.debug(f"[COST_CALC] Model '{model}' pricing: input=${model_obj.pricing.input_cost_per_million_tokens}/M, output=${model_obj.pricing.output_cost_per_million_tokens}/M")
            logger.debug(f"[COST_CALC] Calculated: input=${input_cost:.6f}, output=${output_cost:.6f}, total with {TOKEN_PRICE_MULTIPLIER}x markup=${total_cost:.6f}")
            
            return total_cost
        
        logger.warning(f"[COST_CALC] No pricing found for model '{model}' (resolved: '{resolved_model}'), using default $0.01")
        return Decimal('0.01')
    except Exception as e:
        logger.error(f"[COST_CALC] Error calculating token cost for model '{model}': {e}")
        return Decimal('0.01')

async def calculate_credit_breakdown(account_id: str, client) -> Dict:
    current_balance = await credit_service.get_balance(account_id)
    current_balance = float(current_balance)
    
    purchase_result = await client.from_('credit_ledger')\
        .select('amount, created_at, description')\
        .eq('account_id', account_id)\
        .eq('type', 'purchase')\
        .execute()
    
    total_purchased = sum(float(row['amount']) for row in purchase_result.data) if purchase_result.data else 0
    
    logger.info(f"🔍 Credit breakdown for user {account_id}:")
    logger.info(f"  Current balance: ${current_balance}")
    logger.info(f"  Total purchased (topups): ${total_purchased}")
    if purchase_result.data:
        for purchase in purchase_result.data:
            logger.info(f"    Purchase: ${purchase['amount']} - {purchase['description']}")
    
    topup_credits = total_purchased
    subscription_credits = max(0, current_balance - topup_credits)
    
    return {
        'total_balance': current_balance,
        'topup_credits': topup_credits,
        'subscription_credits': subscription_credits,
        'total_purchased': total_purchased
    }

@router.post("/check")
async def check_billing_status(
    account_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict:
    if config.ENV_MODE == EnvMode.LOCAL:
        return {'can_run': True, 'message': 'Local mode', 'balance': 999999}
    
    from .subscription_service import subscription_service
    balance = await credit_service.get_balance(account_id)
    tier = await subscription_service.get_user_subscription_tier(account_id)
    
    return {
        'can_run': balance > 0,
        'balance': float(balance),
        'tier': tier['name'],
        'message': 'Sufficient credits' if balance > 0 else 'Insufficient credits'
    }

@router.get("/check-status")
async def check_status(
    account_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict:
    try:
        from core.utils.ensure_suna import ensure_suna_installed
        await ensure_suna_installed(account_id)
        
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
        
        from .subscription_service import subscription_service
        balance = await credit_service.get_balance(account_id)
        summary = await credit_service.get_account_summary(account_id)
        tier = await subscription_service.get_user_subscription_tier(account_id)
        
        # Check trial status
        db = DBConnection()
        client = await db.client
        credit_account = await client.from_('credit_accounts')\
            .select('trial_status, trial_ends_at')\
            .eq('account_id', account_id)\
            .execute()
        
        trial_status = None
        trial_ends_at = None
        is_trial = False
        
        if credit_account.data:
            trial_status = credit_account.data[0].get('trial_status')
            trial_ends_at = credit_account.data[0].get('trial_ends_at')
            is_trial = trial_status == 'active'
        
        can_run = balance >= Decimal('0.01')
        
        if is_trial and tier['name'] == 'tier_2_20':
            display_name = f"{tier.get('display_name', 'Starter')} (Trial)"
        else:
            display_name = tier.get('display_name', tier['name'])
        
        subscription = {
            "price_id": "credit_based",
            "plan_name": tier['name'],
            "display_name": display_name,
            "tier": tier['name'],
            "is_trial": is_trial
        }
        
        from .config import CREDITS_PER_DOLLAR
        
        return {
            "can_run": can_run,
            "message": "Sufficient credits" if can_run else "Insufficient credits - please add more credits",
            "subscription": subscription,
            "credit_balance": float(balance) * CREDITS_PER_DOLLAR,
            "can_purchase_credits": tier.get('can_purchase_credits', False),
            "tier_info": tier,
            "is_trial": is_trial,
            "trial_status": trial_status,
            "trial_ends_at": trial_ends_at,
            "credits_summary": {
                "balance": float(balance) * CREDITS_PER_DOLLAR,
                "lifetime_granted": summary['lifetime_granted'] * CREDITS_PER_DOLLAR,
                "lifetime_purchased": summary['lifetime_purchased'] * CREDITS_PER_DOLLAR,
                "lifetime_used": summary['lifetime_used'] * CREDITS_PER_DOLLAR
            }
        }
        
    except Exception as e:
        logger.error(f"Error checking billing status: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/project-limits")
async def get_project_limits(account_id: str = Depends(verify_and_get_user_id_from_jwt)):
    try:
        async with DBConnection() as db:
            credit_result = await db.client.table('credit_accounts').select('tier').eq('account_id', account_id).execute()
            tier = credit_result.data[0].get('tier', 'none') if credit_result.data else 'none'
            
            projects_result = await db.client.table('projects').select('project_id').eq('account_id', account_id).execute()
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
            'tier': 'none',
            'tier_display_name': 'No Plan',
            'current_count': 0,
            'limit': 3,
            'can_create': True,
            'percent_used': 0
        }

@router.post("/deduct")
async def deduct_token_usage(
    usage: TokenUsageRequest,
    account_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict:
    if config.ENV_MODE == EnvMode.LOCAL:
        return {'success': True, 'cost': 0, 'new_balance': 999999}
    
    cost = calculate_token_cost(usage.prompt_tokens, usage.completion_tokens, usage.model)
    
    if cost <= 0:
        balance = await credit_manager.get_balance(account_id)
        return {'success': True, 'cost': 0, 'new_balance': balance['total']}

    result = await credit_manager.use_credits(
        account_id=account_id,
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
    account_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict:
    from .config import CREDITS_PER_DOLLAR
    
    db = DBConnection()
    client = await db.client
    
    result = await client.from_('credit_accounts').select(
        'balance, expiring_credits, non_expiring_credits, tier, next_credit_grant, trial_status, trial_ends_at'
    ).eq('account_id', account_id).execute()
    
    if result.data and len(result.data) > 0:
        account = result.data[0]
        tier_name = account.get('tier', 'none')
        trial_status = account.get('trial_status')
        trial_ends_at = account.get('trial_ends_at')
        tier_info = get_tier_by_name(tier_name)
        
        is_trial = trial_status == 'active'
        
        balance_dollars = float(account.get('balance', 0))
        expiring_dollars = float(account.get('expiring_credits', 0))
        non_expiring_dollars = float(account.get('non_expiring_credits', 0))
        
        return {
            'balance': balance_dollars * CREDITS_PER_DOLLAR,
            'expiring_credits': expiring_dollars * CREDITS_PER_DOLLAR,
            'non_expiring_credits': non_expiring_dollars * CREDITS_PER_DOLLAR,
            'tier': tier_name,
            'tier_display_name': tier_info.display_name if tier_info else 'No Plan',
            'is_trial': is_trial,
            'trial_status': trial_status,
            'trial_ends_at': trial_ends_at,
            'can_purchase_credits': tier_info.can_purchase_credits if tier_info else False,
            'next_credit_grant': account.get('next_credit_grant'),
            'breakdown': {
                'expiring': expiring_dollars * CREDITS_PER_DOLLAR,
                'non_expiring': non_expiring_dollars * CREDITS_PER_DOLLAR,
                'total': balance_dollars * CREDITS_PER_DOLLAR
            }
        }
    
    return {
        'balance': 0,
        'expiring_credits': 0,
        'non_expiring_credits': 0,
        'tier': 'none',
        'tier_display_name': 'No Plan',
        'is_trial': False,
        'trial_status': None,
        'trial_ends_at': None,
        'can_purchase_credits': False,
        'next_credit_grant': None,
        'breakdown': {
            'expiring': 0,
            'non_expiring': 0,
            'total': 0
        }
    }

@router.post("/purchase-credits")
async def purchase_credits_checkout(
    request: PurchaseCreditsRequest,
    account_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict:
    result = await payment_service.create_credit_purchase_checkout(
        account_id=account_id,
        amount=request.amount,
        success_url=request.success_url,
        cancel_url=request.cancel_url,
        get_user_subscription_tier_func=subscription_service.get_user_subscription_tier
    )
    return result

@router.post("/webhook")
async def stripe_webhook(request: Request):
    return await webhook_service.process_stripe_webhook(request)


@router.get("/subscription")
async def get_subscription(
    account_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict:
    try:
        subscription_info = await subscription_service.get_subscription(account_id)
        
        balance = await credit_service.get_balance(account_id)
        summary = await credit_service.get_account_summary(account_id)
        
        tier_info = subscription_info['tier']
        subscription_data = subscription_info['subscription']
        trial_status = subscription_info.get('trial_status')
        trial_ends_at = subscription_info.get('trial_ends_at')

        if subscription_data:
            if subscription_data.get('status') == 'trialing' or trial_status == 'active':
                status = 'trialing'
            else:
                status = 'active'
        elif tier_info['name'] not in ['none', 'free']:
            status = 'cancelled'
        else:
            status = 'no_subscription'
        
        if trial_status == 'active' and tier_info['name'] == 'tier_2_20':
            display_plan_name = f"{tier_info.get('display_name', 'Starter')} (Trial)"
            is_trial = True
        else:
            display_plan_name = tier_info.get('display_name', tier_info['name'])
            is_trial = False
        
        from .config import CREDITS_PER_DOLLAR
        
        return {
            'status': status,
            'plan_name': tier_info['name'],
            'display_plan_name': display_plan_name,
            'price_id': subscription_info['price_id'],
            'subscription': subscription_data,
            'subscription_id': subscription_data['id'] if subscription_data else None,
            'current_usage': float(summary['lifetime_used']) * CREDITS_PER_DOLLAR,
            'cost_limit': tier_info['credits'] * CREDITS_PER_DOLLAR,
            'credit_balance': float(balance) * CREDITS_PER_DOLLAR,
            'can_purchase_credits': TIERS.get(tier_info['name'], TIERS['none']).can_purchase_credits,
            'tier': tier_info,
            'is_trial': is_trial,
            'trial_status': trial_status,
            'trial_ends_at': trial_ends_at,
            'credits': {
                'balance': float(balance) * CREDITS_PER_DOLLAR,
                'tier_credits': tier_info['credits'] * CREDITS_PER_DOLLAR,
                'lifetime_granted': float(summary['lifetime_granted']) * CREDITS_PER_DOLLAR,
                'lifetime_purchased': float(summary['lifetime_purchased']) * CREDITS_PER_DOLLAR,
                'lifetime_used': float(summary['lifetime_used']) * CREDITS_PER_DOLLAR,
                'can_purchase_credits': TIERS.get(tier_info['name'], TIERS['none']).can_purchase_credits
            }
        }
        
    except Exception as e:
        logger.error(f"Error getting subscription: {str(e)}")
        no_tier = TIERS['none']
        tier_info = {
            'name': no_tier.name,
            'credits': 0.0,
            'display_name': no_tier.display_name
        }
        return {
            'status': 'no_subscription',
            'plan_name': 'none',
            'display_plan_name': 'No Plan',
            'price_id': None,
            'subscription': None,
            'subscription_id': None,
            'current_usage': 0,
            'cost_limit': tier_info['credits'],
            'credit_balance': 0,
            'can_purchase_credits': False,
            'tier': tier_info,
            'is_trial': False,
            'trial_status': None,
            'trial_ends_at': None,
            'credits': {
                'balance': 0,
                'tier_credits': tier_info['credits'],
                'lifetime_granted': 0,
                'lifetime_purchased': 0,
                'lifetime_used': 0,
                'can_purchase_credits': False
            }
        }

@router.get("/subscription-cancellation-status")
async def get_subscription_cancellation_status(
    account_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict:
    try:
        subscription_info = await subscription_service.get_subscription(account_id)
        subscription_data = subscription_info.get('subscription')

        if not subscription_data or not subscription_data.get('id'):
            return {
                'has_subscription': False,
                'is_cancelled': False,
                'cancel_at': None,
                'cancel_at_period_end': False,
                'current_period_end': None,
                'status': None
            }
        
        try:
            stripe_subscription = await StripeAPIWrapper.retrieve_subscription(subscription_data['id'])
            is_cancelled = stripe_subscription.cancel_at_period_end or stripe_subscription.cancel_at is not None
            
            return {
                'has_subscription': True,
                'subscription_id': stripe_subscription.id,
                'is_cancelled': is_cancelled,
                'cancel_at': stripe_subscription.cancel_at,
                'cancel_at_period_end': stripe_subscription.cancel_at_period_end,
                'canceled_at': stripe_subscription.canceled_at,
                'current_period_end': stripe_subscription.current_period_end,
                'status': stripe_subscription.status,
                'cancellation_details': stripe_subscription.cancellation_details if hasattr(stripe_subscription, 'cancellation_details') else None
            }
        except stripe.error.StripeError as e:
            return {
                'has_subscription': True,
                'subscription_id': subscription_data.get('id'),
                'is_cancelled': False,
                'cancel_at': None,
                'cancel_at_period_end': False,
                'current_period_end': subscription_data.get('current_period_end'),
                'status': subscription_data.get('status'),
                'error': 'Could not retrieve cancellation status from Stripe'
            }
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/create-checkout-session")
async def create_checkout_session(
    request: CreateCheckoutSessionRequest,
    account_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict:
    try:
        result = await subscription_service.create_checkout_session(
            account_id=account_id,
            price_id=request.price_id,
            success_url=request.success_url,
            cancel_url=request.cancel_url,
            commitment_type=request.commitment_type
        )
        return result
            
    except Exception as e:
        logger.error(f"Error creating checkout session: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/create-portal-session")
async def create_portal_session(
    request: CreatePortalSessionRequest,
    account_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict:
    try:
        result = await subscription_service.create_portal_session(
            account_id=account_id,
            return_url=request.return_url
        )
        return result
    except Exception as e:
        logger.error(f"Error creating portal session: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/sync-subscription")
async def sync_subscription(
    account_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict:
    try:
        result = await subscription_service.sync_subscription(account_id)
        if result['success']:
            balance = await credit_service.get_balance(account_id)
            summary = await credit_service.get_account_summary(account_id)
            result['credits'] = {
                'balance': float(balance),
                'lifetime_granted': float(summary['lifetime_granted']),
                'lifetime_used': float(summary['lifetime_used'])
            }
        
        return result
        
    except Exception as e:
        logger.error(f"Error syncing subscription: {str(e)}")
        return {
            'success': False,
            'message': f'Failed to sync subscription: {str(e)}'
        }

@router.post("/cancel-subscription")
async def cancel_subscription(
    request: CancelSubscriptionRequest,
    account_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict:
    try:
        result = await subscription_service.cancel_subscription(
            account_id=account_id,
            feedback=request.feedback
        )
        
        await Cache.invalidate(f"subscription_tier:{account_id}")
        return result
        
    except HTTPException as e:
        raise e
    except Exception as e:
        logger.error(f"Error canceling subscription: {str(e)}")
        if "commitment period" in str(e).lower():
            raise HTTPException(status_code=403, detail=str(e))
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/reactivate-subscription")
async def reactivate_subscription(
    account_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict:
    try:
        result = await subscription_service.reactivate_subscription(account_id)
        await Cache.invalidate(f"subscription_tier:{account_id}")
        return result
        
    except HTTPException as e:
        # Re-raise HTTP exceptions as-is
        raise e
    except Exception as e:
        logger.error(f"Error reactivating subscription: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/transactions")
async def get_my_transactions(
    account_id: str = Depends(verify_and_get_user_id_from_jwt),
    limit: int = Query(50, ge=1, le=100, description="Number of transactions to fetch"),
    offset: int = Query(0, ge=0, description="Offset for pagination"),
    type_filter: Optional[str] = Query(None, description="Filter by transaction type")
) -> Dict:
    try:
        db = DBConnection()
        client = await db.client
        
        query = client.from_('credit_ledger').select('*').eq('account_id', account_id).order('created_at', desc=True)
        
        if type_filter:
            query = query.eq('type', type_filter)

        count_query = client.from_('credit_ledger').select('*', count='exact').eq('account_id', account_id)
        if type_filter:
            count_query = count_query.eq('type', type_filter)
        count_result = await count_query.execute()
        total_count = count_result.count or 0
        
        if offset:
            query = query.range(offset, offset + limit - 1)
        else:
            query = query.limit(limit)
        
        result = await query.execute()
        
        balance_info = await credit_manager.get_balance(account_id)
        
        transactions = []
        for tx in result.data or []:
            transactions.append({
                'id': tx.get('id'),
                'created_at': tx.get('created_at'),
                'amount': float(tx.get('amount', 0)),
                'balance_after': float(tx.get('balance_after', 0)),
                'type': tx.get('type'),
                'description': tx.get('description'),
                'is_expiring': tx.get('is_expiring', False),
                'expires_at': tx.get('expires_at'),
                'metadata': tx.get('metadata', {})
            })
        
        return {
            'transactions': transactions,
            'pagination': {
                'total': total_count,
                'limit': limit,
                'offset': offset,
                'has_more': offset + limit < total_count
            },
            'current_balance': balance_info
        }
        
    except Exception as e:
        logger.error(f"Failed to get transactions for account {account_id}: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to retrieve transactions")

@router.get("/transactions/summary")
async def get_transactions_summary(
    account_id: str = Depends(verify_and_get_user_id_from_jwt),
    days: int = Query(30, ge=1, le=365, description="Number of days to look back")
) -> Dict:
    try:
        db = DBConnection()
        client = await db.client
        
        since_date = (datetime.utcnow() - timedelta(days=days)).isoformat()
        
        result = await client.from_('credit_ledger').select('*').eq('account_id', account_id).gte('created_at', since_date).execute()
        
        total_added = Decimal('0')
        total_used = Decimal('0')
        total_refunded = Decimal('0')
        total_expired = Decimal('0')
        
        transaction_counts = {}
        
        for tx in result.data or []:
            amount = Decimal(str(tx.get('amount', 0)))
            tx_type = tx.get('type', 'unknown')
            
            transaction_counts[tx_type] = transaction_counts.get(tx_type, 0) + 1
            
            if amount > 0:
                if tx_type == 'refund':
                    total_refunded += amount
                else:
                    total_added += amount
            else:
                if tx_type == 'expired':
                    total_expired += abs(amount)
                else:
                    total_used += abs(amount)
        
        balance_info = await credit_manager.get_balance(account_id)
        
        return {
            'period_days': days,
            'since_date': since_date,
            'current_balance': balance_info,
            'summary': {
                'total_added': float(total_added),
                'total_used': float(total_used),
                'total_refunded': float(total_refunded),
                'total_expired': float(total_expired),
                'net_change': float(total_added - total_used - total_expired)
            },
            'transaction_counts': transaction_counts,
            'total_transactions': len(result.data or [])
        }
        
    except Exception as e:
        logger.error(f"Failed to get transaction summary for account {account_id}: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to retrieve transaction summary")

@router.get("/credit-breakdown")
async def get_credit_breakdown(
    account_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict:
    db = DBConnection()
    client = await db.client
    
    account_result = await client.from_('credit_accounts')\
        .select('balance, expiring_credits, non_expiring_credits, tier, next_credit_grant')\
        .eq('account_id', account_id)\
        .execute()
    
    if not account_result.data:
        return {
            'total_balance': 0,
            'expiring_credits': 0,
            'non_expiring_credits': 0,
            'tier': 'none',
            'next_credit_grant': None,
            'message': 'No credit account found'
        }
    
    account = account_result.data[0]
    total = float(account.get('balance', 0))
    expiring = float(account.get('expiring_credits', 0))
    non_expiring = float(account.get('non_expiring_credits', 0))
    
    purchase_result = await client.from_('credit_ledger')\
        .select('amount, created_at, description')\
        .eq('account_id', account_id)\
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
        'tier': account.get('tier', 'none'),
        'next_credit_grant': account.get('next_credit_grant'),
        'recent_purchases': recent_purchases,
        'message': f"Your ${total:.2f} balance includes ${expiring:.2f} expiring (plan) credits and ${non_expiring:.2f} non-expiring (purchased) credits"
    }

@router.get("/usage-history")
async def get_usage_history(
    days: int = 30,
    account_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict:
    try:
        db = DBConnection()
        client = await db.client
        
        start_date = datetime.now(timezone.utc) - timedelta(days=days)
        
        result = await client.from_('credit_ledger').select('created_at, amount, type, description').eq('account_id', account_id).gte('created_at', start_date.isoformat()).order('created_at', desc=True).execute()
        
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
        logger.error(f"Error getting usage history: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e)) 


@router.get("/available-models")
async def get_available_models(
    account_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict:
    try:
        from core.ai_models import model_manager
        from core.services.supabase import DBConnection
        # Use the implemented get_allowed_models_for_user function
        
        if config.ENV_MODE == EnvMode.LOCAL:
            logger.debug("Running in local development mode - all models available")
            all_models = model_manager.list_available_models(include_disabled=False)
            model_info = []
            
            for model_data in all_models:
                # Apply markup to pricing for display
                input_cost = model_data["pricing"]["input_per_million"] if model_data["pricing"] else None
                output_cost = model_data["pricing"]["output_per_million"] if model_data["pricing"] else None
                
                model_info.append({
                    "id": model_data["id"],
                    "display_name": model_data["name"],
                    "short_name": model_data.get("aliases", [model_data["name"]])[0] if model_data.get("aliases") else model_data["name"],
                    "requires_subscription": False,
                    "input_cost_per_million_tokens": float(Decimal(str(input_cost)) * TOKEN_PRICE_MULTIPLIER) if input_cost else None,
                    "output_cost_per_million_tokens": float(Decimal(str(output_cost)) * TOKEN_PRICE_MULTIPLIER) if output_cost else None,
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
        account_result = await client.from_('credit_accounts').select('tier').eq('account_id', account_id).execute()
        
        tier_name = 'none'
        if account_result.data and len(account_result.data) > 0:
            tier_name = account_result.data[0].get('tier', 'none')
        
        from .subscription_service import subscription_service
        tier = await subscription_service.get_user_subscription_tier(account_id)
        
        all_models = model_manager.list_available_models(tier=None, include_disabled=False)
        logger.debug(f"Found {len(all_models)} total models available")
        
        # Get allowed models using the service method
        allowed_models = await subscription_service.get_allowed_models_for_user(account_id, client)
            
        logger.debug(f"User {account_id} allowed models: {allowed_models}")
        logger.debug(f"User tier: {tier['name']}")
        
        model_info = []
        for model_data in all_models:
            model_id = model_data["id"]
            
            can_access = model_id in allowed_models
            
            # Apply markup to pricing for display
            input_cost = model_data["pricing"]["input_per_million"] if model_data["pricing"] else None
            output_cost = model_data["pricing"]["output_per_million"] if model_data["pricing"] else None
            
            model_info.append({
                "id": model_id,
                "display_name": model_data["name"],
                "short_name": model_data.get("aliases", [model_data["name"]])[0] if model_data.get("aliases") else model_data["name"],
                "requires_subscription": not can_access,
                "input_cost_per_million_tokens": float(Decimal(str(input_cost)) * TOKEN_PRICE_MULTIPLIER) if input_cost else None,
                "output_cost_per_million_tokens": float(Decimal(str(output_cost)) * TOKEN_PRICE_MULTIPLIER) if output_cost else None,
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
        logger.error(f"Error getting available models: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/subscription-commitment/{subscription_id}")
async def get_subscription_commitment(
    subscription_id: str,
    account_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict:
    try:
        commitment_status = await subscription_service.get_commitment_status(account_id)
        if commitment_status['has_commitment']:
            logger.info(f"[COMMITMENT] Account {account_id} has active commitment, {commitment_status['months_remaining']} months remaining")
        
        return commitment_status
        
    except Exception as e:
        logger.error(f"Error checking commitment status for account {account_id}: {e}")
        return {
            'has_commitment': False,
            'can_cancel': True,
            'commitment_type': None,
            'months_remaining': None,
            'commitment_end_date': None
        }

@router.get("/trial/status")
async def get_trial_status(
    account_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict:
    try:
        from core.utils.ensure_suna import ensure_suna_installed
        await ensure_suna_installed(account_id)
        
        result = await trial_service.get_trial_status(account_id)
        return result
        
    except Exception as e:
        logger.error(f"Error checking trial status: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/trial/cancel")
async def cancel_trial(
    account_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict:
    try:
        result = await trial_service.cancel_trial(account_id)
        return result
            
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error cancelling trial for account {account_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/trial/start")
async def start_trial(
    request: TrialStartRequest,
    account_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict:
    """
    Start a trial for the authenticated user.
    Security: Each account can only have ONE trial ever.
    """
    # Log the attempt for security monitoring
    logger.info(f"[TRIAL API] Trial start request from account {account_id}, IP: {request.success_url}")
    
    try:
        # The trial_service.start_trial method has comprehensive security checks:
        # 1. Checks trial_history table (permanent record)
        # 2. Checks credit_accounts trial_status
        # 3. Checks for existing Stripe subscriptions
        # 4. Checks credit_ledger for trial-related entries
        result = await trial_service.start_trial(
            account_id=account_id,
            success_url=request.success_url,
            cancel_url=request.cancel_url
        )
        
        logger.info(f"[TRIAL API SUCCESS] Trial checkout created for account {account_id}")
        return result
        
    except HTTPException as e:
        # Log security violations with high priority
        if e.status_code == 403:
            logger.warning(f"[TRIAL API SECURITY] Forbidden trial attempt for account {account_id}: {e.detail}")
        else:
            logger.info(f"[TRIAL API] Trial start failed for account {account_id}: {e.detail}")
        raise
    except Exception as e:
        logger.error(f"[TRIAL API ERROR] Unexpected error creating trial for account {account_id}: {str(e)}")
        # Don't expose internal errors to the client
        raise HTTPException(status_code=500, detail="An error occurred while processing your request")

@router.post("/trial/create-checkout")
async def create_trial_checkout(
    request: CreateCheckoutSessionRequest,
    account_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict:
    """
    Alternative endpoint for trial checkout creation.
    Security: Delegates to start_trial which has all security checks.
    """
    logger.info(f"[TRIAL API] Trial checkout request from account {account_id}")
    
    try:
        # This delegates to start_trial which has all the security checks
        result = await trial_service.create_trial_checkout(
            account_id=account_id,
            success_url=request.success_url,
            cancel_url=request.cancel_url
        )
        
        logger.info(f"[TRIAL API SUCCESS] Trial checkout created via create-checkout for account {account_id}")
        return result
        
    except HTTPException as e:
        if e.status_code == 403:
            logger.warning(f"[TRIAL API SECURITY] Forbidden trial checkout attempt for account {account_id}: {e.detail}")
        else:
            logger.info(f"[TRIAL API] Trial checkout failed for account {account_id}: {e.detail}")
        raise
    except Exception as e:
        logger.error(f"[TRIAL API ERROR] Unexpected error in trial checkout for account {account_id}: {str(e)}")
        raise HTTPException(status_code=500, detail="An error occurred while processing your request")

@router.get("/proration-preview")
async def preview_proration(
    new_price_id: str = Query(..., description="The price ID to change to"),
    account_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict:
    try:
        db = DBConnection()
        client = await db.client
        
        subscription_result = await client.from_('credit_accounts').select(
            'stripe_subscription_id'
        ).eq('account_id', account_id).execute()
        
        if not subscription_result.data or not subscription_result.data[0].get('stripe_subscription_id'):
            raise HTTPException(status_code=404, detail="No active subscription found")
        
        subscription_id = subscription_result.data[0]['stripe_subscription_id']
        subscription = await StripeAPIWrapper.retrieve_subscription(subscription_id)
        
        current_item = subscription['items']['data'][0]
        
        proration = await StripeAPIWrapper.upcoming_invoice(
            customer=subscription.customer,
            subscription=subscription_id,
            subscription_items=[{
                'id': current_item.id,
                'price': new_price_id,
            }],
            subscription_proration_behavior='always_invoice'
        )
        
        current_price = current_item.price
        new_price = await StripeAPIWrapper.retrieve_price(new_price_id)
        
        from billing.config import get_tier_by_price_id
        
        current_tier = get_tier_by_price_id(current_price.id)
        new_tier = get_tier_by_price_id(new_price_id)
        
        proration_amount = Decimal(str(proration.amount_due)) / 100
        
        return {
            'current_plan': {
                'price_id': current_price.id,
                'tier_name': current_tier.name if current_tier else 'unknown',
                'monthly_amount': float(current_price.unit_amount / 100)
            },
            'new_plan': {
                'price_id': new_price_id,
                'tier_name': new_tier.name if new_tier else 'unknown',
                'monthly_amount': float(new_price.unit_amount / 100)
            },
            'proration': {
                'amount_due_now': float(proration_amount),
                'credit_applied': float(abs(proration.starting_balance or 0) / 100),
                'next_payment_date': datetime.fromtimestamp(proration.period_end, tz=timezone.utc).isoformat(),
                'next_payment_amount': float(new_price.unit_amount / 100)
            },
            'is_upgrade': proration_amount > 0,
            'description': f"You will be {'charged' if proration_amount > 0 else 'credited'} ${abs(proration_amount):.2f} for the remaining time in your billing period"
        }
    
    except stripe.error.StripeError as e:
        logger.error(f"Stripe error in proration preview: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to calculate proration: {str(e)}")
    except Exception as e:
        logger.error(f"Error in proration preview: {e}")
        raise HTTPException(status_code=500, detail="Failed to preview proration")

@router.post("/reconcile")
async def trigger_reconciliation(
    admin_key: Optional[str] = Query(None, description="Admin API key"),
    account_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict:

    if admin_key != config.get('ADMIN_API_KEY'):
        raise HTTPException(status_code=403, detail="Unauthorized")
    
    try:
        payment_results = await reconciliation_service.reconcile_failed_payments()
        balance_results = await reconciliation_service.verify_balance_consistency()
        duplicate_results = await reconciliation_service.detect_double_charges()
        cleanup_results = await reconciliation_service.cleanup_expired_credits()
        
        return {
            'success': True,
            'timestamp': datetime.now(timezone.utc).isoformat(),
            'results': {
                'payment_reconciliation': payment_results,
                'balance_verification': balance_results,
                'duplicate_detection': duplicate_results,
                'expired_credit_cleanup': cleanup_results
            }
        }
    
    except Exception as e:
        logger.error(f"Reconciliation error: {e}")
        raise HTTPException(status_code=500, detail=f"Reconciliation failed: {str(e)}")

@router.get("/circuit-breaker-status")
async def get_circuit_breaker_status(
    admin_key: Optional[str] = Query(None, description="Admin API key")
) -> Dict:
    if admin_key != config.get('ADMIN_API_KEY'):
        raise HTTPException(status_code=403, detail="Unauthorized - admin key required")
    
    try:
        status = await stripe_circuit_breaker.get_status()
        
        db = DBConnection()
        client = await db.client
        all_circuits = await client.from_('circuit_breaker_state').select('*').execute()
        
        return {
            'primary_circuit': status,
            'all_circuits': all_circuits.data if all_circuits.data else [],
            'timestamp': datetime.now(timezone.utc).isoformat()
        }
    except Exception as e:
        logger.error(f"Error getting circuit breaker status: {e}")
        raise HTTPException(status_code=500, detail=str(e)) 