
"""
Enterprise Billing API - User-facing endpoints

When ENTERPRISE_MODE is enabled, these endpoints replace the normal billing endpoints
to show enterprise billing information to users.
"""

from fastapi import APIRouter, HTTPException, Depends, Query
from typing import Optional, Dict, Any
from datetime import datetime, timezone
import structlog

from utils.config import config
from utils.auth_utils import verify_and_get_user_id_from_jwt
from services.enterprise_billing import enterprise_billing
from services.billing_wrapper import check_billing_status_unified
from services.supabase import DBConnection

logger = structlog.get_logger(__name__)

router = APIRouter(prefix="/billing", tags=["billing"])

@router.get("/subscription")
async def get_subscription(
    current_user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """Get the current subscription status for the user - enterprise version."""
    if not config.ENTERPRISE_MODE:
        # This shouldn't be called if enterprise mode is disabled
        raise HTTPException(status_code=400, detail="Enterprise mode not enabled")
    
    try:
        logger.debug(f"Getting enterprise subscription status for user {current_user_id}")
        
        # Get user's limit and usage
        user_limit = await enterprise_billing.get_user_limit(current_user_id)
        enterprise_balance = await enterprise_billing.get_enterprise_balance()
        
        # Format as subscription-like response for frontend compatibility
        return {
            "status": "active",
            "plan_name": "Enterprise",
            "price_id": "enterprise",
            "current_period_end": None,  # Enterprise doesn't have periods
            "cancel_at_period_end": False,
            "trial_end": None,
            "minutes_limit": 999999,  # Unlimited for enterprise
            "cost_limit": user_limit['monthly_limit'] if user_limit else 1000.00,
            "current_usage": user_limit['current_month_usage'] if user_limit else 0,
            "has_schedule": False,
            "subscription_id": "enterprise",
            "subscription": {
                "id": "enterprise",
                "status": "active",
                "cancel_at_period_end": False,
                "cancel_at": None,
                "current_period_end": None
            },
            "credit_balance": enterprise_balance['credit_balance'] if enterprise_balance else 0,
            "can_purchase_credits": False,  # Enterprise users don't purchase credits
            "enterprise_info": {
                "is_enterprise": True,
                "monthly_limit": user_limit['monthly_limit'] if user_limit else 1000.00,
                "remaining_monthly": (user_limit['monthly_limit'] - user_limit['current_month_usage']) if user_limit else 1000.00,
                "enterprise_balance": enterprise_balance['credit_balance'] if enterprise_balance else 0
            }
        }
        
    except Exception as e:
        logger.error(f"Error getting enterprise subscription: {str(e)}")
        raise HTTPException(status_code=500, detail="Error retrieving subscription status")

@router.get("/check-status")
async def check_status(
    current_user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """Check if the user can run agents based on enterprise billing."""
    if not config.ENTERPRISE_MODE:
        raise HTTPException(status_code=400, detail="Enterprise mode not enabled")
    
    try:
        db = DBConnection()
        client = await db.client
        
        # Use the unified billing check
        can_run, message, billing_info = await check_billing_status_unified(client, current_user_id)
        
        # Get user's limit for additional info
        user_limit = await enterprise_billing.get_user_limit(current_user_id)
        enterprise_balance = await enterprise_billing.get_enterprise_balance()
        
        return {
            "can_run": can_run,
            "message": message,
            "subscription": billing_info,
            "credit_balance": enterprise_balance['credit_balance'] if enterprise_balance else 0,
            "can_purchase_credits": False,  # Enterprise users don't purchase credits
            "enterprise_info": {
                "monthly_limit": user_limit['monthly_limit'] if user_limit else 1000.00,
                "current_usage": user_limit['current_month_usage'] if user_limit else 0,
                "remaining": (user_limit['monthly_limit'] - user_limit['current_month_usage']) if user_limit else 1000.00
            }
        }
        
    except Exception as e:
        logger.error(f"Error checking enterprise billing status: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/usage-logs")
async def get_usage_logs(
    current_user_id: str = Depends(verify_and_get_user_id_from_jwt),
    page: int = Query(default=0, ge=0),
    items_per_page: int = Query(default=100, ge=1, le=1000)
):
    """Get usage logs for the current user."""
    if not config.ENTERPRISE_MODE:
        raise HTTPException(status_code=400, detail="Enterprise mode not enabled")
    
    try:
        # Get user's detailed usage
        usage_details = await enterprise_billing.get_user_usage_details(
            account_id=current_user_id,
            days=30,
            page=page,
            items_per_page=items_per_page
        )
        
        if not usage_details:
            return {
                "usage_logs": [],
                "total": 0,
                "page": page,
                "items_per_page": items_per_page
            }
        
        # Format logs for frontend compatibility
        formatted_logs = []
        for log in usage_details.get('usage_logs', []):
            formatted_logs.append({
                "id": log.get('id'),
                "created_at": log.get('created_at'),
                "model_name": log.get('model_name', 'Unknown'),
                "tokens_used": log.get('tokens_used', 0),
                "cost": log.get('cost', 0),
                "thread_id": log.get('thread_id'),
                "message_id": log.get('message_id')
            })
        
        return {
            "usage_logs": formatted_logs,
            "total": usage_details.get('total_logs', 0),
            "page": page,
            "items_per_page": items_per_page,
            "total_cost": usage_details.get('total_cost_period', 0),
            "enterprise_info": {
                "monthly_limit": usage_details.get('monthly_limit', 1000.00),
                "current_usage": usage_details.get('current_month_usage', 0),
                "remaining": usage_details.get('remaining_monthly', 1000.00)
            }
        }
        
    except Exception as e:
        logger.error(f"Error getting usage logs: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/tool-usage-analytics")
async def get_tool_usage_analytics(
    current_user_id: str = Depends(verify_and_get_user_id_from_jwt),
    days: int = Query(default=30, ge=1, le=365),
    page: int = Query(default=0, ge=0),
    items_per_page: int = Query(default=100, ge=1, le=1000)
):
    """Get tool usage analytics for the current user."""
    if not config.ENTERPRISE_MODE:
        raise HTTPException(status_code=400, detail="Enterprise mode not enabled")
    
    try:
        # Get user's tool usage analytics
        analytics = await enterprise_billing.get_tool_usage_analytics(
            account_id=current_user_id,
            days=days,
            page=page,
            items_per_page=items_per_page
        )
        
        if not analytics:
            return {
                "tool_usage": [],
                "total_logs": 0,
                "page": page,
                "items_per_page": items_per_page,
                "total_cost_period": 0,
                "period_days": days
            }
        
        # Format for frontend compatibility
        formatted_usage = []
        for usage in analytics.get('tool_usage', []):
            formatted_usage.append({
                "account_id": usage.get('account_id'),
                "thread_id": usage.get('thread_id'),
                "message_id": usage.get('message_id'),
                "tool_name": usage.get('tool_name'),
                "tool_cost": usage.get('tool_cost'),
                "created_at": usage.get('created_at'),
                "usage_date": usage.get('usage_date'),
                "usage_hour": usage.get('usage_hour'),
                "usage_month": usage.get('usage_month')
            })
        
        return {
            "tool_usage": formatted_usage,
            "total_logs": analytics.get('total_logs', 0),
            "page": page,
            "items_per_page": items_per_page,
            "total_cost_period": analytics.get('total_cost_period', 0),
            "period_days": days
        }
        
    except Exception as e:
        logger.error(f"Error getting tool usage analytics: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/available-models")
async def get_available_models(
    current_user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """Get available models for enterprise users - all models are available."""
    if not config.ENTERPRISE_MODE:
        raise HTTPException(status_code=400, detail="Enterprise mode not enabled")
    
    # Enterprise users get access to all models
    return {
        "available_models": [
            "openai/gpt-4o",
            "openai/gpt-4o-mini",
            "anthropic/claude-3-5-sonnet-20241022",
            "anthropic/claude-3-5-haiku-20241022",
            "google/gemini-2.0-flash-exp",
            "google/gemini-1.5-pro",
            "google/gemini-1.5-flash",
            "deepseek/deepseek-chat",
            "xai/grok-2-1212",
            "xai/grok-2-vision-1212"
        ],
        "tier": "enterprise",
        "message": "All models available for enterprise users"
    }

# Stub endpoints that don't apply to enterprise but might be called by frontend
@router.post("/create-checkout-session")
async def create_checkout_session(
    current_user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """Checkout not available in enterprise mode."""
    if not config.ENTERPRISE_MODE:
        raise HTTPException(status_code=400, detail="Enterprise mode not enabled")
    
    return {
        "error": "Billing is managed by your enterprise administrator",
        "url": None
    }

@router.post("/create-portal-session")
async def create_portal_session(
    current_user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """Portal not available in enterprise mode."""
    if not config.ENTERPRISE_MODE:
        raise HTTPException(status_code=400, detail="Enterprise mode not enabled")
    
    return {
        "error": "Billing is managed by your enterprise administrator",
        "url": None
    }

@router.post("/cancel-subscription")
async def cancel_subscription(
    current_user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """Cancellation not available in enterprise mode."""
    if not config.ENTERPRISE_MODE:
        raise HTTPException(status_code=400, detail="Enterprise mode not enabled")
    
    return {
        "error": "Your enterprise account cannot be cancelled by users",
        "success": False
    }
