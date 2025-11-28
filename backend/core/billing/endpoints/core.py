"""
Core billing endpoints for mutations and analytics.

Note: For reading billing state, use GET /billing/account-state instead.
These endpoints are for mutations (deduct) and detailed analytics.
"""
from fastapi import APIRouter, HTTPException, Depends, Query
from typing import Dict
from decimal import Decimal
from datetime import datetime, timezone, timedelta
from core.credits import credit_service
from core.services.supabase import DBConnection
from core.utils.auth_utils import verify_and_get_user_id_from_jwt
from core.utils.config import config, EnvMode
from core.utils.logger import logger
from ..shared.config import (
    TOKEN_PRICE_MULTIPLIER, 
    get_tier_by_name,
    TIERS,
    CREDITS_PER_DOLLAR,
    get_tier_limits
)
from ..shared.models import TokenUsageRequest
from ..credits.calculator import calculate_token_cost
from ..credits.manager import credit_manager
from ..shared.cache_utils import invalidate_account_state_cache

router = APIRouter(tags=["billing-core"])


@router.post("/deduct")
async def deduct_token_usage(
    usage: TokenUsageRequest,
    account_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict:
    """Deduct credits for token usage."""
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
    
    # Invalidate account state cache after deduction
    await invalidate_account_state_cache(account_id)
    
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


@router.get("/tier-configurations") 
async def get_tier_configurations() -> Dict:
    """Get all available tier configurations (public, no auth needed for pricing page)."""
    try:
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


@router.get("/credit-breakdown")
async def get_credit_breakdown(
    account_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict:
    """Get detailed credit breakdown including purchase history."""
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
    """Get usage history for the specified number of days."""
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
