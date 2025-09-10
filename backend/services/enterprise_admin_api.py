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

class SetGlobalDefaultRequest(BaseModel):
    monthly_limit: float

class GlobalSettingRequest(BaseModel):
    setting_key: str
    setting_value: Dict[str, Any]
    description: Optional[str] = None

async def verify_simple_admin(user_id: str = Depends(verify_and_get_user_id_from_jwt)):
    """Simple admin check - checks if user email is in ADMIN_EMAILS or OMNI_ADMIN env vars."""
    if not config.ENTERPRISE_MODE:
        raise HTTPException(status_code=400, detail="Enterprise mode not enabled")
    
    if not config.ADMIN_EMAILS and not config.OMNI_ADMIN:
        raise HTTPException(status_code=500, detail="No admin emails configured")
    
    try:
        db = DBConnection()
        client = await db.client
        
        # Get user info using admin API
        user_result = await client.auth.admin.get_user_by_id(user_id)
        
        if not user_result.user or not user_result.user.email:
            raise HTTPException(status_code=403, detail="User not found")
        
        user_email = user_result.user.email.lower()
        
        # Check OMNI_ADMIN emails first
        omni_admin_emails = []
        if config.OMNI_ADMIN:
            omni_admin_emails = [email.strip().lower() for email in config.OMNI_ADMIN.split(',') if email.strip()]
        
        # Check regular ADMIN_EMAILS
        admin_emails = []
        if config.ADMIN_EMAILS:
            admin_emails = [email.strip().lower() for email in config.ADMIN_EMAILS.split(',') if email.strip()]
        
        # Allow access if user is in either admin list
        if user_email not in omni_admin_emails and user_email not in admin_emails:
            raise HTTPException(status_code=403, detail=f"Access denied. Contact admin for access.")
        
        return user_id
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error verifying admin: {e}")
        raise HTTPException(status_code=500, detail="Error checking admin access")


async def verify_omni_admin(user_id: str = Depends(verify_and_get_user_id_from_jwt)):
    """OMNI admin check - checks if user email is specifically in OMNI_ADMIN env var (super admin with credit loading access)."""
    if not config.ENTERPRISE_MODE:
        raise HTTPException(status_code=400, detail="Enterprise mode not enabled")
    
    if not config.OMNI_ADMIN:
        raise HTTPException(status_code=500, detail="No OMNI admin emails configured")
    
    try:
        db = DBConnection()
        client = await db.client
        
        # Get user info using admin API
        user_result = await client.auth.admin.get_user_by_id(user_id)
        
        if not user_result.user or not user_result.user.email:
            raise HTTPException(status_code=403, detail="User not found")
        
        user_email = user_result.user.email.lower()
        omni_admin_emails = [email.strip().lower() for email in config.OMNI_ADMIN.split(',') if email.strip()]
        
        if user_email not in omni_admin_emails:
            raise HTTPException(status_code=403, detail=f"Super admin access required. Contact OMNI admin for access.")
        
        return user_id
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error verifying OMNI admin: {e}")
        raise HTTPException(status_code=500, detail="Error checking OMNI admin access")

@router.get("/check-admin")
async def check_admin_access(user_id: str = Depends(verify_and_get_user_id_from_jwt)):
    """Check if current user has admin access."""
    logger.info(f"Admin check requested for user: {user_id}")
    
    if not config.ENTERPRISE_MODE:
        logger.info("Enterprise mode not enabled")
        return {"is_admin": False, "is_omni_admin": False, "reason": "Enterprise mode not enabled"}
    
    if not config.ADMIN_EMAILS and not config.OMNI_ADMIN:
        logger.warning("No admin emails configured")
        return {"is_admin": False, "is_omni_admin": False, "reason": "No admin emails configured"}
    
    try:
        db = DBConnection()
        client = await db.client
        
        user_result = await client.auth.admin.get_user_by_id(user_id)
        
        if not user_result.user or not user_result.user.email:
            logger.warning(f"Unable to get email for user {user_id}")
            return {"is_admin": False, "is_omni_admin": False, "reason": "Unable to get user email"}
        
        user_email = user_result.user.email.lower()
        
        # Check OMNI_ADMIN emails
        omni_admin_emails = []
        if config.OMNI_ADMIN:
            omni_admin_emails = [email.strip().lower() for email in config.OMNI_ADMIN.split(',') if email.strip()]
        
        # Check regular ADMIN_EMAILS
        admin_emails = []
        if config.ADMIN_EMAILS:
            admin_emails = [email.strip().lower() for email in config.ADMIN_EMAILS.split(',') if email.strip()]
        
        is_omni_admin = user_email in omni_admin_emails
        is_regular_admin = user_email in admin_emails
        is_admin = is_omni_admin or is_regular_admin
        
        logger.info(f"Admin check for {user_email}: {'OMNI_ADMIN' if is_omni_admin else 'REGULAR_ADMIN' if is_regular_admin else 'DENIED'}")
        
        return {
            "is_admin": is_admin, 
            "is_omni_admin": is_omni_admin,
            "user_id": user_id
        }
        
    except Exception as e:
        logger.error(f"Error checking admin access: {e}")
        return {"is_admin": False, "is_omni_admin": False, "reason": f"Error: {str(e)}"}

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
    admin_user_id: str = Depends(verify_omni_admin)
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
        result = await enterprise_billing.get_user_hierarchical_usage(
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

# =====================================================
# GLOBAL DEFAULTS MANAGEMENT
# =====================================================

@router.get("/global-defaults")
async def get_global_defaults(admin_user_id: str = Depends(verify_simple_admin)):
    """Get current global default settings."""
    try:
        default_limit = await enterprise_billing.get_default_monthly_limit()
        
        # Get the full setting to see description and metadata
        default_setting = await enterprise_billing.get_global_setting('default_monthly_limit')
        
        return {
            "default_monthly_limit": default_limit,
            "setting_details": {
                "description": default_setting.get('description') if default_setting else 'Default monthly spending limit for new enterprise users',
                "created_at": default_setting.get('created_at') if default_setting else None,
                "updated_at": default_setting.get('updated_at') if default_setting else None,
                "updated_by": default_setting.get('updated_by') if default_setting else None
            }
        }
        
    except Exception as e:
        logger.error(f"Error getting global defaults: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/global-defaults")
async def set_global_default(
    request: SetGlobalDefaultRequest,
    admin_user_id: str = Depends(verify_simple_admin)
):
    """Set the global default monthly limit for new users and update existing users using the default."""
    try:
        if request.monthly_limit <= 0:
            raise HTTPException(status_code=400, detail="Monthly limit must be greater than 0")
        
        # Get the current default limit before changing it
        old_default = await enterprise_billing.get_default_monthly_limit()
        
        # Update the global setting
        await enterprise_billing.set_global_setting(
            'default_monthly_limit',
            {'value': request.monthly_limit},
            'Default monthly spending limit for new enterprise users (in USD)',
            admin_user_id
        )
        
        # Update existing users who are currently using the old default
        updated_count = await enterprise_billing.update_users_with_default_limit(
            old_default=old_default,
            new_default=request.monthly_limit
        )
        
        message = f"Global default monthly limit set to ${request.monthly_limit:.2f}"
        if updated_count > 0:
            message += f" and updated ALL {updated_count} users to this new limit"
        
        return {
            "success": True,
            "default_monthly_limit": request.monthly_limit,
            "updated_users_count": updated_count,
            "message": message
        }
        
    except Exception as e:
        logger.error(f"Error setting global default: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/users-with-custom-limits")
async def get_users_with_custom_limits(
    admin_user_id: str = Depends(verify_simple_admin),
    page: int = Query(default=0, ge=0),
    items_per_page: int = Query(default=50, ge=1, le=200)
):
    """Get all users who have custom limits different from the global default."""
    try:
        default_limit = await enterprise_billing.get_default_monthly_limit()
        
        db = DBConnection()
        client = await db.client
        
        # Get users with explicit limits that differ from default
        result = await client.table('enterprise_user_limits')\
            .select('*')\
            .neq('monthly_limit', default_limit)\
            .eq('is_active', True)\
            .order('updated_at', desc=True)\
            .range(page * items_per_page, (page + 1) * items_per_page - 1)\
            .execute()
        
        users_with_custom_limits = []
        if result.data:
            for user in result.data:
                # Get user email for display
                try:
                    user_info = await client.auth.admin.get_user_by_id(user['account_id'])
                    email = user_info.user.email if user_info and user_info.user else 'Unknown'
                except Exception:
                    email = 'Unknown'
                
                users_with_custom_limits.append({
                    'account_id': user['account_id'],
                    'email': email,
                    'monthly_limit': user['monthly_limit'],
                    'current_month_usage': user['current_month_usage'],
                    'difference_from_default': user['monthly_limit'] - default_limit,
                    'updated_at': user['updated_at']
                })
        
        # Count total users with custom limits
        count_result = await client.table('enterprise_user_limits')\
            .select('*', count='exact')\
            .neq('monthly_limit', default_limit)\
            .eq('is_active', True)\
            .execute()
        
        total_custom_users = count_result.count if hasattr(count_result, 'count') else 0
        
        return {
            "users_with_custom_limits": users_with_custom_limits,
            "total_custom_users": total_custom_users,
            "default_monthly_limit": default_limit,
            "page": page,
            "items_per_page": items_per_page
        }
        
    except Exception as e:
        logger.error(f"Error getting users with custom limits: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/users/{account_id}/reset-to-default")
async def reset_user_to_default(
    account_id: str,
    admin_user_id: str = Depends(verify_simple_admin)
):
    """Reset a user's limit to the global default (removes their custom limit)."""
    try:
        db = DBConnection()
        client = await db.client
        
        # Remove the custom limit, which will cause the system to use the default
        result = await client.table('enterprise_user_limits')\
            .delete()\
            .eq('account_id', account_id)\
            .execute()
        
        default_limit = await enterprise_billing.get_default_monthly_limit()
        
        return {
            "success": True,
            "account_id": account_id,
            "message": f"User reset to global default limit of ${default_limit:.2f}",
            "default_limit": default_limit
        }
        
    except Exception as e:
        logger.error(f"Error resetting user to default: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/users/{account_id}")
async def get_user_usage_logs(
    account_id: str,
    admin_user_id: str = Depends(verify_simple_admin),
    page: int = Query(default=0, ge=0),
    items_per_page: int = Query(default=100, ge=1, le=1000),
    days: int = Query(default=30, ge=1, le=365)
):
    """Get hierarchical usage logs for a specific user (Admin only)."""
    try:
        # Get hierarchical usage data for the specified user
        hierarchical_data = await enterprise_billing.get_user_hierarchical_usage(
            account_id=account_id,
            days=days,
            page=page,
            items_per_page=items_per_page
        )
        
        if not hierarchical_data:
            return {
                "hierarchical_usage": {},
                "enterprise_info": {
                    "monthly_limit": await enterprise_billing.get_default_monthly_limit(),
                    "current_usage": 0,
                    "remaining": await enterprise_billing.get_default_monthly_limit()
                },
                "total_cost_period": 0,
                "page": page,
                "items_per_page": items_per_page,
                "days": days,
                "is_hierarchical": True
            }
        
        return {
            "hierarchical_usage": hierarchical_data.get('hierarchical_usage', {}),
            "enterprise_info": {
                "monthly_limit": hierarchical_data.get('monthly_limit', await enterprise_billing.get_default_monthly_limit()),
                "current_usage": hierarchical_data.get('current_month_usage', 0),
                "remaining": hierarchical_data.get('remaining_monthly', await enterprise_billing.get_default_monthly_limit())
            },
            "total_cost_period": hierarchical_data.get('total_cost_period', 0),
            "page": page,
            "items_per_page": items_per_page,
            "days": days,
            "is_hierarchical": True
        }
        
    except Exception as e:
        logger.error(f"Error getting user usage logs for {account_id}: {str(e)}")
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