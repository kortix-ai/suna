from fastapi import APIRouter, HTTPException, Depends, Query
from typing import Optional, Dict
from decimal import Decimal
from datetime import datetime, timezone, timedelta
from core.credits import credit_service
from core.services.supabase import DBConnection
from core.utils.auth_utils import verify_and_get_user_id_from_jwt, get_optional_user_id_from_jwt
from core.utils.config import config, EnvMode
from core.utils.logger import logger
from core.ai_models import model_manager
from ..shared.config import (
    TOKEN_PRICE_MULTIPLIER, 
    get_tier_by_name,
    TIERS,
    CREDITS_PER_DOLLAR
)
from ..shared.models import TokenUsageRequest
from ..credits.calculator import calculate_token_cost
from ..credits.manager import credit_manager

router = APIRouter(tags=["billing-core"])

@router.post("/check")
async def check_billing_status(
    account_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict:
    if config.ENV_MODE == EnvMode.LOCAL:
        return {'can_run': True, 'message': 'Local mode', 'balance': 999999}
    
    from ..subscriptions import subscription_service
    
    balance_result = await credit_service.get_balance(account_id) 
    if isinstance(balance_result, dict):
        balance = Decimal(str(balance_result.get('total', 0)))
    else:
        balance = balance_result
        
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
        
        from ..subscriptions import subscription_service
        
        balance_result = await credit_service.get_balance(account_id)
        if isinstance(balance_result, dict):
            balance = Decimal(str(balance_result.get('total', 0)))
        else:
            balance = balance_result
            
        summary = await credit_service.get_account_summary(account_id)
        tier = await subscription_service.get_user_subscription_tier(account_id)
        
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
            "plan_name": display_name,
            "tier": tier['name'],
            "current_period_start": None,
            "current_period_end": None,
            "cancel_at_period_end": False,
            "status": "active",
            "trial_status": trial_status,
            "trial_ends_at": trial_ends_at,
            "is_trial": is_trial
        }
        
        from ..shared.config import CREDITS_PER_DOLLAR
        
        return {
            "can_run": can_run,
            "message": "Sufficient credits" if can_run else "Insufficient credits",
            "subscription": subscription,
            "credit_balance": float(balance),
            "credit_summary": {
                "total": float(balance),
                "monthly_allowance": float(summary.get('monthly_allowance', 0)),
                "purchased": float(summary.get('purchased', 0)),
                "usage_this_month": float(summary.get('usage_this_month', 0)),
                "credits_per_dollar": CREDITS_PER_DOLLAR
            },
            "can_purchase_credits": tier.get('can_purchase_credits', False)
        }
    except Exception as e:
        logger.error(f"[BILLING] Error in check_status: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/balance")
async def get_credit_balance(
    account_id: Optional[str] = Depends(get_optional_user_id_from_jwt)
) -> Dict:
    from ..shared.config import CREDITS_PER_DOLLAR
    
    if not account_id:
        return {"balance": 0.0, "message": "Guest user"}
    
    # Use the same structure as the legacy API
    from core.services.supabase import DBConnection
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
    else:
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

@router.post("/deduct")
async def deduct_token_usage(
    usage: TokenUsageRequest,
    account_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict:
    cost = calculate_token_cost(usage.prompt_tokens, usage.completion_tokens, usage.model)
    
    if cost <= 0:
        balance = await credit_manager.get_balance(account_id)
        return {'success': True, 'cost': 0, 'new_balance': balance['total'] * CREDITS_PER_DOLLAR}

    result = await credit_manager.deduct_credits(
        account_id=account_id,
        amount=cost,
        description=f"AI usage: {usage.model} ({usage.prompt_tokens}+{usage.completion_tokens} tokens)",
        type='usage',
        message_id=usage.message_id,
        thread_id=usage.thread_id
    )
    
    return {
        'success': result['success'],
        'cost': float(cost) * CREDITS_PER_DOLLAR,
        'new_balance': float(result['new_balance']) * CREDITS_PER_DOLLAR,
        'usage': {
            'prompt_tokens': usage.prompt_tokens,
            'completion_tokens': usage.completion_tokens,
            'model': usage.model
        }
    }

@router.get("/project-limits")
async def get_project_limits(account_id: str = Depends(verify_and_get_user_id_from_jwt)):
    try:
        async with DBConnection() as db:
            client = await db.client
            
            from ..shared.config import get_project_limit, get_tier_by_name
            from ..subscriptions import subscription_service
            
            tier_info = await subscription_service.get_user_subscription_tier(account_id)
            tier = tier_info.get('name')
            project_limit = get_project_limit(tier)
            tier_info = get_tier_by_name(tier)
            
            projects_result = await client.from_('projects').select('id').eq('account_id', account_id).execute()
            current_projects = len(projects_result.data) if projects_result.data else 0
            
            return {
                'project_limit': project_limit,
                'current_projects': current_projects,
                'remaining_projects': max(0, project_limit - current_projects),
                'tier': tier,
                'tier_display_name': tier_info.display_name if tier_info else tier
            }
    except Exception as e:
        logger.error(f"Error getting project limits: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/tier-limits")
async def get_tier_limits(account_id: str = Depends(verify_and_get_user_id_from_jwt)):
    try:
        db = DBConnection()
        client = await db.client
        
        from ..subscriptions import subscription_service
        tier_info = await subscription_service.get_user_subscription_tier(account_id)
        tier = tier_info.get('name')
        
        from ..shared.config import get_tier_limits
        limits = get_tier_limits(tier)
        
        projects_result = await client.from_('projects').select('id').eq('account_id', account_id).execute()
        current_projects = len(projects_result.data) if projects_result.data else 0
        
        threads_result = await client.from_('threads').select('thread_id').eq('account_id', account_id).execute()  
        current_threads = len(threads_result.data) if threads_result.data else 0
        
        return {
            **limits,
            'current_usage': {
                'projects': current_projects,
                'threads': current_threads
            },
            'tier_name': tier,
            'tier_display_name': tier_info.get('display_name', tier)
        }
    except Exception as e:
        logger.error(f"Error getting tier limits: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/tier-configurations") 
async def get_tier_configurations() -> Dict:
    try:
        from ..shared.config import TIERS
        
        tier_configs = []
        for tier_key, tier in TIERS.items():
            if tier_key == 'none':
                continue
                
            tier_config = {
                'tier_key': tier_key,  
                'name': tier.name,
                'display_name': tier.display_name,
                'monthly_credits': float(tier.monthly_credits),
                'can_purchase_credits': tier.can_purchase_credits,
                'project_limit': tier.project_limit,
                'price_ids': tier.price_ids,
            }
            tier_configs.append(tier_config)
        
        return {
            'success': True,
            'tiers': tier_configs,
            'timestamp': datetime.now(timezone.utc).isoformat()
        }
    
    except Exception as e:
        logger.error(f"Error getting tier configurations: {e}")
        raise HTTPException(status_code=500, detail="Failed to get tier configurations")

@router.get("/available-models")
async def get_available_models(
    account_id: Optional[str] = Depends(get_optional_user_id_from_jwt)
) -> Dict:
    if config.ENV_MODE == EnvMode.LOCAL:
        all_models = model_manager.list_available_models(include_disabled=True)
        return {
            'models': [
                {
                    'id': model['id'],
                    'display_name': model['name'],
                    'provider': model['provider'],
                    'allowed': True,
                    'reason': 'Local development mode'
                }
                for model in all_models
            ],
            'tier': 'local',
            'local_mode': True
        }
    
    if not account_id:
        tier_name = 'free'
    else:
        from ..subscriptions import subscription_service
        tier_info = await subscription_service.get_user_subscription_tier(account_id)
        tier_name = tier_info.get('name', 'free')
    
    all_models = model_manager.list_available_models(include_disabled=True)
    
    from ..shared.config import is_model_allowed
    
    result_models = []
    for model in all_models:
        allowed = is_model_allowed(tier_name, model['id'])
        result_models.append({
            'id': model['id'],
            'display_name': model['name'],
            'name': model['name'],
            'provider': model['provider'],
            'allowed': allowed,
            'requires_subscription': not allowed,
            'context_window': model.get('context_window', 128000),
            'capabilities': model.get('capabilities', []),
            'priority': model.get('priority', 0),
            'recommended': model.get('recommended', False),
            'reason': f'Available on {tier_name} tier' if allowed else f'Requires higher tier than {tier_name}'
        })
    
    return {
        'models': result_models,
        'tier': tier_name
    }

@router.get("/credit-breakdown")
async def get_credit_breakdown(
    account_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict:
    db = DBConnection()
    client = await db.client
    
    try:
        balance_result = await credit_service.get_balance(account_id)
        if isinstance(balance_result, dict):
            current_balance = float(balance_result.get('total', 0))
        else:
            current_balance = float(balance_result)
        
        purchase_result = await client.from_('credit_ledger')\
            .select('amount, created_at, description')\
            .eq('account_id', account_id)\
            .eq('type', 'purchase')\
            .execute()
        
        total_purchased = sum(float(row['amount']) for row in purchase_result.data) if purchase_result.data else 0
        
        return {
            "balance": current_balance * CREDITS_PER_DOLLAR,
            "total_purchased": total_purchased * CREDITS_PER_DOLLAR,
            "breakdown": purchase_result.data or []
        }
    except Exception as e:
        logger.error(f"[BILLING] Error getting credit breakdown: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/usage-history")
async def get_usage_history(
    days: int = 30,
    account_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict:
    try:
        db = DBConnection()
        client = await db.client
        
        since_date = datetime.now(timezone.utc) - timedelta(days=days)
        
        usage_result = await client.from_('credit_ledger')\
            .select('*')\
            .eq('account_id', account_id)\
            .eq('type', 'usage')\
            .gte('created_at', since_date.isoformat())\
            .order('created_at', desc=True)\
            .execute()
        
        usage_history = []
        total_usage = 0.0
        
        if usage_result.data:
            for record in usage_result.data:
                amount = abs(float(record['amount']))
                total_usage += amount
                usage_history.append({
                    'date': record['created_at'],
                    'amount': amount,
                    'description': record['description'],
                    'metadata': record.get('metadata', {})
                })
        
        return {
            'usage_history': usage_history,
            'total_usage': total_usage * CREDITS_PER_DOLLAR,
            'period_days': days,
            'period_start': since_date.isoformat()
        }
    except Exception as e:
        logger.error(f"[BILLING] Error getting usage history: {e}")
        raise HTTPException(status_code=500, detail=str(e))
