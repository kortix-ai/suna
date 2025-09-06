"""
Simplified Enterprise Admin API

When ENTERPRISE_MODE is enabled:
- Admins can manage the single enterprise billing account
- Set per-user monthly limits  
- View usage across all users
- Load credits manually
"""

from fastapi import APIRouter, HTTPException, Query, Depends
from typing import Optional, Dict, Any, List
from datetime import datetime, timezone
from pydantic import BaseModel
import structlog

from utils.config import config
from utils.auth_utils import verify_and_get_user_id_from_jwt
from services.enterprise_billing import enterprise_billing
from services.supabase import DBConnection

logger = structlog.get_logger(__name__)

router = APIRouter(prefix="/enterprise", tags=["enterprise"])

# Request models
class LoadCreditsRequest(BaseModel):
    amount: float
    description: Optional[str] = None

class SetUserLimitRequest(BaseModel):
    account_id: str
    monthly_limit: float

async def verify_simple_admin(user_id: str = Depends(verify_and_get_user_id_from_jwt)):
    """Simple admin check - checks if user email is in ADMIN_EMAILS env var."""
    if not config.ENTERPRISE_MODE:
        raise HTTPException(status_code=400, detail="Enterprise mode not enabled")
    
    if not config.ADMIN_EMAILS:
        raise HTTPException(status_code=500, detail="No admin emails configured")
    
    try:
        db = DBConnection()
        client = await db.client
        
        # Get user info using admin API
        user_result = await client.auth.admin.get_user_by_id(user_id)
        
        if not user_result.user or not user_result.user.email:
            raise HTTPException(status_code=403, detail="User not found")
        
        user_email = user_result.user.email
        admin_emails = [email.strip().lower() for email in config.ADMIN_EMAILS.split(',') if email.strip()]
        
        if user_email.lower() not in admin_emails:
            raise HTTPException(status_code=403, detail=f"Access denied. Contact admin for access.")
        
        return user_id
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error verifying admin: {e}")
        raise HTTPException(status_code=500, detail="Error checking admin access")

@router.get("/check-admin")
async def check_admin_access(user_id: str = Depends(verify_and_get_user_id_from_jwt)):
    """Check if current user has admin access."""
    logger.info(f"Admin check requested for user: {user_id}")
    
    if not config.ENTERPRISE_MODE:
        logger.info("Enterprise mode not enabled")
        return {"is_admin": False, "reason": "Enterprise mode not enabled"}
    
    if not config.ADMIN_EMAILS:
        logger.warning("No admin emails configured")
        return {"is_admin": False, "reason": "No admin emails configured"}
    
    try:
        db = DBConnection()
        client = await db.client
        
        user_result = await client.auth.admin.get_user_by_id(user_id)
        
        if not user_result.user or not user_result.user.email:
            logger.warning(f"Unable to get email for user {user_id}")
            return {"is_admin": False, "reason": "Unable to get user email"}
        
        user_email = user_result.user.email
        admin_emails = [email.strip().lower() for email in config.ADMIN_EMAILS.split(',') if email.strip()]
        
        is_admin = user_email.lower() in admin_emails
        
        logger.info(f"Admin check for {user_email}: {'GRANTED' if is_admin else 'DENIED'}")
        
        return {"is_admin": is_admin, "user_id": user_id}
        
    except Exception as e:
        logger.error(f"Error checking admin access: {e}")
        return {"is_admin": False, "reason": f"Error: {str(e)}"}

@router.get("/status")
async def get_enterprise_status(admin_user_id: str = Depends(verify_simple_admin)):
    """Get overall enterprise billing status."""
    try:
        # Get enterprise balance
        enterprise = await enterprise_billing.get_enterprise_balance()
        
        # Get all user usage summary
        usage_stats = await enterprise_billing.get_all_user_usage(
            days=30,
            page=0,
            items_per_page=1000  # Get all for summary
        )
        
        return {
            "credit_balance": enterprise['credit_balance'] if enterprise else 0,
            "total_loaded": enterprise['total_loaded'] if enterprise else 0,
            "total_used": enterprise['total_used'] if enterprise else 0,
            "total_users": usage_stats['total_users'] if usage_stats else 0,
            "total_monthly_usage": usage_stats['total_monthly_usage'] if usage_stats else 0,
            "total_monthly_limit": usage_stats['total_monthly_limit'] if usage_stats else 0
        }
        
    except Exception as e:
        logger.error(f"Error getting enterprise status: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/load-credits")
async def load_credits(
    request: LoadCreditsRequest,
    admin_user_id: str = Depends(verify_simple_admin)
):
    """Load credits into the enterprise account."""
    try:
        result = await enterprise_billing.load_credits(
            amount=request.amount,
            description=request.description,
            performed_by=admin_user_id
        )
        
        if result['success']:
            return {
                "success": True,
                "new_balance": result['new_balance'],
                "amount_loaded": request.amount
            }
        else:
            raise HTTPException(status_code=400, detail=result.get('error', 'Failed to load credits'))
            
    except Exception as e:
        logger.error(f"Error loading credits: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/users")
async def get_all_users(
    page: int = Query(default=0, ge=0),
    items_per_page: int = Query(default=50, ge=1, le=500),
    admin_user_id: str = Depends(verify_simple_admin)
):
    """Get all users with their usage and limits."""
    try:
        result = await enterprise_billing.get_all_user_usage(
            days=30,
            page=page,
            items_per_page=items_per_page
        )
        
        return result
        
    except Exception as e:
        logger.error(f"Error getting users: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/users/{account_id}")
async def get_user_details(
    account_id: str,
    days: int = Query(default=30, ge=1, le=365),
    page: int = Query(default=0, ge=0),
    items_per_page: int = Query(default=100, ge=1, le=500),
    admin_user_id: str = Depends(verify_simple_admin)
):
    """Get detailed usage for a specific user."""
    try:
        result = await enterprise_billing.get_user_usage_details(
            account_id=account_id,
            days=days,
            page=page,
            items_per_page=items_per_page
        )
        
        if not result:
            raise HTTPException(status_code=404, detail="User not found")
        
        return result
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting user details: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/users/{account_id}/limit")
async def set_user_limit(
    account_id: str,
    request: SetUserLimitRequest,
    admin_user_id: str = Depends(verify_simple_admin)
):
    """Set a user's monthly spending limit."""
    try:
        if request.account_id != account_id:
            raise HTTPException(status_code=400, detail="Account ID mismatch")
        
        result = await enterprise_billing.set_user_limit(
            account_id=account_id,
            monthly_limit=request.monthly_limit
        )
        
        return {
            "success": True,
            "account_id": account_id,
            "monthly_limit": request.monthly_limit
        }
        
    except Exception as e:
        logger.error(f"Error setting user limit: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/reset-monthly-usage")
async def reset_monthly_usage(admin_user_id: str = Depends(verify_simple_admin)):
    """Manually reset all users' monthly usage counters."""
    try:
        success = await enterprise_billing.reset_monthly_usage()
        
        if success:
            return {"success": True, "message": "Monthly usage reset for all users"}
        else:
            raise HTTPException(status_code=500, detail="Failed to reset monthly usage")
            
    except Exception as e:
        logger.error(f"Error resetting monthly usage: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/debug")
async def debug_enterprise_api():
    """Debug endpoint to test enterprise API is working."""
    try:
        return {
            "status": "ok",
            "enterprise_mode": config.ENTERPRISE_MODE,
            "admin_emails_configured": bool(config.ADMIN_EMAILS),
            "admin_email_count": len([e for e in config.ADMIN_EMAILS.split(',') if e.strip()]) if config.ADMIN_EMAILS else 0,
            "timestamp": datetime.now(timezone.utc).isoformat()
        }
    except Exception as e:
        logger.error(f"Debug endpoint error: {e}")
        return {"error": str(e)}