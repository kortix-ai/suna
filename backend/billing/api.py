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
    get_tier_by_name,
    TIERS
)
from .credit_manager import credit_manager
from .webhook_service import webhook_service
from .subscription_service import subscription_service
from .trial_service import trial_service
from .payment_service import payment_service

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

async def get_user_subscription_tier(account_id: str) -> Dict:
    cache_key = f"subscription_tier:{account_id}"
    cached = await Cache.get(cache_key)
    if cached:
        return cached
    
    db = DBConnection()
    client = await db.client

    credit_result = await client.from_('credit_accounts').select('tier').eq('account_id', account_id).execute()
    
    if credit_result.data and len(credit_result.data) > 0:
        tier_name = credit_result.data[0].get('tier', 'none')
    else:
        tier_name = 'none'
    
    tier_obj = TIERS.get(tier_name, TIERS['none'])
    tier_info = {
        'name': tier_obj.name,
        'credits': float(tier_obj.monthly_credits),
        'can_purchase_credits': tier_obj.can_purchase_credits,
        'models': tier_obj.models,
        'project_limit': tier_obj.project_limit
    }
    
    await Cache.set(cache_key, tier_info, ttl=60)
    return tier_info

    
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
    
    balance = await credit_service.get_balance(account_id)
    tier = await get_user_subscription_tier(account_id)
    
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
        
        balance = await credit_service.get_balance(account_id)
        summary = await credit_service.get_account_summary(account_id)
        tier = await get_user_subscription_tier(account_id)
        
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
    db = DBConnection()
    client = await db.client
    
    result = await client.from_('credit_accounts').select(
        'balance, expiring_credits, non_expiring_credits, tier, next_credit_grant'
    ).eq('account_id', account_id).execute()
    
    if result.data and len(result.data) > 0:
        account = result.data[0]
        tier_name = account.get('tier', 'none')
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
        'tier': 'none',
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
    account_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict:
    result = await payment_service.create_credit_purchase_checkout(
        account_id=account_id,
        amount=request.amount,
        success_url=request.success_url,
        cancel_url=request.cancel_url,
        get_user_subscription_tier_func=get_user_subscription_tier
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
        
        if subscription_data:
            status = 'active'
        elif tier_info['name'] not in ['none', 'free']:
            status = 'cancelled'
        else:
            status = 'no_subscription'
        
        return {
            'status': status,
            'plan_name': tier_info['name'],
            'price_id': subscription_info['price_id'],
            'subscription': subscription_data,
            'subscription_id': subscription_data['id'] if subscription_data else None,
            'current_usage': float(summary['lifetime_used']),
            'cost_limit': tier_info['credits'],
            'credit_balance': float(balance),
            'can_purchase_credits': TIERS.get(tier_info['name'], TIERS['none']).can_purchase_credits,
            'tier': tier_info,
            'credits': {
                'balance': float(balance),
                'tier_credits': tier_info['credits'],
                'lifetime_granted': float(summary['lifetime_granted']),
                'lifetime_purchased': float(summary['lifetime_purchased']),
                'lifetime_used': float(summary['lifetime_used']),
                'can_purchase_credits': TIERS.get(tier_info['name'], TIERS['none']).can_purchase_credits
            }
        }
        
    except Exception as e:
        logger.error(f"Error getting subscription: {e}", exc_info=True)
        no_tier = TIERS['none']
        tier_info = {
            'name': no_tier.name,
            'credits': 0.0
        }
        return {
            'status': 'no_subscription',
            'plan_name': 'none',
            'price_id': None,
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
                'can_purchase_credits': False
            }
        }

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
            cancel_url=request.cancel_url
        )
        return result
            
    except Exception as e:
        logger.error(f"Error creating checkout session: {e}", exc_info=True)
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
        logger.error(f"Error creating portal session: {e}", exc_info=True)
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
        logger.error(f"Error syncing subscription: {e}", exc_info=True)
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
        
    except Exception as e:
        logger.error(f"Error canceling subscription: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/reactivate-subscription")
async def reactivate_subscription(
    account_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict:
    try:
        result = await subscription_service.reactivate_subscription(account_id)
        await Cache.invalidate(f"subscription_tier:{account_id}")
        return result
        
    except Exception as e:
        logger.error(f"Error reactivating subscription: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/transactions")
async def get_user_transactions(
    limit: int = 50,
    offset: int = 0,
    account_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict:
    transactions = await credit_service.get_ledger(account_id, limit, offset)
    return {
        'transactions': transactions,
        'count': len(transactions)
    }

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
        logger.error(f"Error getting usage history: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e)) 


@router.get("/available-models")
async def get_available_models(
    account_id: str = Depends(verify_and_get_user_id_from_jwt)
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
        account_result = await client.from_('credit_accounts').select('tier').eq('account_id', account_id).execute()
        
        tier_name = 'none'
        if account_result.data and len(account_result.data) > 0:
            tier_name = account_result.data[0].get('tier', 'none')
        
        tier = await get_user_subscription_tier(account_id)
        
        all_models = model_manager.list_available_models(tier=None, include_disabled=False)
        logger.debug(f"Found {len(all_models)} total models available")
        
        allowed_models = await get_allowed_models_for_user(client, account_id)
        logger.debug(f"User {account_id} allowed models: {allowed_models}")
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
    account_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict:
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
        result = await trial_service.get_trial_status(account_id)
        return result
        
    except Exception as e:
        logger.error(f"Error checking trial status: {e}", exc_info=True)
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
        logger.error(f"Error cancelling trial for account {account_id}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/trial/start")
async def start_trial(
    request: TrialStartRequest,
    account_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict:
    try:
        result = await trial_service.start_trial(
            account_id=account_id,
            success_url=request.success_url,
            cancel_url=request.cancel_url
        )
        return result
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error creating trial checkout for account {account_id}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/trial/create-checkout")
async def create_trial_checkout(
    request: CreateCheckoutSessionRequest,
    account_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict:
    try:
        result = await trial_service.create_trial_checkout(
            account_id=account_id,
            success_url=request.success_url,
            cancel_url=request.cancel_url
        )
        return result
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error creating trial checkout: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e)) 