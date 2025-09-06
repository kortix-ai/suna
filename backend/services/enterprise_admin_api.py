"""
Enterprise Admin API endpoints for managing enterprise billing.

This module provides administrative endpoints for:
- Managing enterprise billing accounts
- Loading credits manually
- Setting and updating user monthly limits
- Viewing comprehensive usage statistics
- Managing enterprise membership

These endpoints are designed for administrative use and require proper
authentication and authorization.
"""

from fastapi import APIRouter, HTTPException, Depends, Query
from typing import Optional, List, Dict, Any
from datetime import datetime, timezone, timedelta
from pydantic import BaseModel, Field
from decimal import Decimal

from utils.auth_utils import verify_and_get_user_id_from_jwt
from services.supabase import DBConnection
from services.enterprise_billing import enterprise_billing
from utils.logger import logger, structlog
from utils.config import config

# Initialize router (no /api prefix since main api.py already adds /api)
router = APIRouter(prefix="/enterprise", tags=["enterprise-admin"])


# =====================================================
# ADMIN VERIFICATION
# =====================================================

async def verify_simple_admin(user_id: str = Depends(verify_and_get_user_id_from_jwt)):
    """Super simple admin check - just checks if user email is in ADMIN_EMAILS env var."""
    if not config.ENTERPRISE_MODE:
        raise HTTPException(status_code=400, detail="Enterprise mode not enabled")
    
    if not config.ADMIN_EMAILS:
        raise HTTPException(status_code=500, detail="No admin emails configured")
    
    try:
        # Get user email from JWT token for simpler implementation
        from fastapi import Request
        
        # Simple approach: get email from Supabase auth
        db = DBConnection()
        client = await db.client
        
        # Get user data from auth.users - use service role permissions
        user_result = await client.auth.admin.get_user_by_id(user_id)
        
        if not user_result.user or not user_result.user.email:
            raise HTTPException(status_code=403, detail="Unable to get user email")
        
        user_email = user_result.user.email
        
        admin_emails = [email.strip().lower() for email in config.ADMIN_EMAILS.split(',') if email.strip()]
        
        if user_email.lower() not in admin_emails:
            raise HTTPException(status_code=403, detail=f"Access denied. Contact admin for access.")
        
        logger.info(f"Admin access granted to {user_email}", user_id=admin_user_id, user_email=user_email)
        return user_id
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error verifying admin: {e}", user_id=admin_user_id, error=str(e))
        raise HTTPException(status_code=500, detail="Error checking admin access")


# =====================================================
# REQUEST/RESPONSE MODELS
# =====================================================

class CreateEnterpriseAccountRequest(BaseModel):
    name: str = Field(..., description="Name of the enterprise account")
    initial_credits: float = Field(default=0, ge=0, description="Initial credits to load")
    description: Optional[str] = Field(None, description="Optional description")


class LoadCreditsRequest(BaseModel):
    enterprise_id: str = Field(..., description="Enterprise billing account ID")
    amount: float = Field(..., gt=0, description="Amount in dollars to load")
    description: Optional[str] = Field(None, description="Description for the transaction")


class UpdateUserLimitRequest(BaseModel):
    account_id: str = Field(..., description="User account ID")
    monthly_limit: float = Field(..., ge=0, description="Monthly spend limit in dollars")


class AddUserToEnterpriseRequest(BaseModel):
    enterprise_id: str = Field(..., description="Enterprise billing account ID")
    account_id: str = Field(..., description="User account ID to add")
    monthly_limit: float = Field(default=1000.00, ge=0, description="Monthly spend limit")


class EnterpriseAccountResponse(BaseModel):
    id: str
    name: str
    credit_balance: float
    total_loaded: float
    total_used: float
    is_active: bool
    member_count: int
    created_at: str


class UsageStatsResponse(BaseModel):
    enterprise_info: Dict[str, Any]
    members: List[Dict[str, Any]]
    member_count: int
    usage_logs: List[Dict[str, Any]]
    total_monthly_usage: float
    total_monthly_limit: float
    remaining_monthly_budget: float
    recent_transactions: List[Dict[str, Any]]
    page: int
    has_more: bool


# =====================================================
# ADMIN ACCESS CHECK
# =====================================================

@router.get("/check-admin")
async def check_admin_access(user_id: str = Depends(verify_and_get_user_id_from_jwt)):
    """Check if current user has admin access."""
    # If enterprise mode is disabled, no one is admin
    if not config.ENTERPRISE_MODE:
        return {"is_admin": False, "reason": "Enterprise mode not enabled"}
    
    # If no admin emails configured, no one is admin
    if not config.ADMIN_EMAILS:
        return {"is_admin": False, "reason": "No admin emails configured"}
    
    try:
        # Get user email from database
        db = DBConnection()
        client = await db.client
        
        # Try to get user email - use admin.get_user_by_id which works with service role
        user_result = await client.auth.admin.get_user_by_id(user_id)
        
        if not user_result.user or not user_result.user.email:
            return {"is_admin": False, "reason": "Unable to get user email"}
        
        user_email = user_result.user.email
        admin_emails = [email.strip().lower() for email in config.ADMIN_EMAILS.split(',') if email.strip()]
        
        is_admin = user_email.lower() in admin_emails
        
        if is_admin:
            logger.info(f"Admin access granted to {user_email}", user_id=user_id, user_email=user_email)
        
        return {"is_admin": is_admin, "user_id": user_id}
        
    except Exception as e:
        logger.error(f"Error checking admin access for user {user_id}: {e}", user_id=user_id, error=str(e))
        return {"is_admin": False, "reason": "Error checking admin access"}


# =====================================================
# ENTERPRISE ACCOUNT MANAGEMENT
# =====================================================

@router.post("/accounts", response_model=Dict[str, Any])
async def create_enterprise_account(
    request: CreateEnterpriseAccountRequest,
    admin_user_id: str = Depends(verify_simple_admin)
):
    """Create a new enterprise billing account."""
    if not config.ENTERPRISE_MODE:
        raise HTTPException(status_code=400, detail="Enterprise mode not enabled")
    
    try:
        db = DBConnection()
        client = await db.client
        
        # Create enterprise account
        account_data = {
            'name': request.name,
            'credit_balance': request.initial_credits,
            'total_loaded': request.initial_credits,
            'is_active': True,
            'created_by': user_id,
            'metadata': {
                'description': request.description
            } if request.description else {}
        }
        
        result = await client.table('enterprise_billing_accounts')\
            .insert(account_data)\
            .execute()
        
        if not result.data:
            raise HTTPException(status_code=500, detail="Failed to create enterprise account")
        
        enterprise_account = result.data[0]
        
        # Log initial credit loading if any
        if request.initial_credits > 0:
            await client.table('enterprise_credit_transactions')\
                .insert({
                    'enterprise_billing_id': enterprise_account['id'],
                    'amount': request.initial_credits,
                    'transaction_type': 'load',
                    'description': 'Initial credit load',
                    'performed_by': admin_user_id
                })\
                .execute()
        
        logger.info(
            f"Created enterprise account: {enterprise_account['id']}",
            enterprise_id=enterprise_account['id'],
            name=request.name,
            created_by=admin_user_id,
            initial_credits=request.initial_credits
        )
        
        return {
            'success': True,
            'enterprise_account': enterprise_account,
            'message': f"Enterprise account '{request.name}' created successfully"
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error creating enterprise account: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Error creating enterprise account: {str(e)}")


@router.get("/accounts", response_model=List[EnterpriseAccountResponse])
async def list_enterprise_accounts(
    active_only: bool = Query(default=True, description="Only return active accounts"),
    admin_user_id: str = Depends(verify_simple_admin)
):
    """List all enterprise billing accounts."""
    if not config.ENTERPRISE_MODE:
        raise HTTPException(status_code=400, detail="Enterprise mode not enabled")
    
    try:
        db = DBConnection()
        client = await db.client
        
        # Build query
        query = client.table('enterprise_billing_accounts')\
            .select('*, enterprise_account_members(count)')\
            .order('created_at', desc=True)
        
        if active_only:
            query = query.eq('is_active', True)
        
        result = await query.execute()
        
        # Format response
        accounts = []
        for account in result.data:
            accounts.append(EnterpriseAccountResponse(
                id=account['id'],
                name=account['name'],
                credit_balance=float(account['credit_balance']),
                total_loaded=float(account['total_loaded']),
                total_used=float(account['total_used']),
                is_active=account['is_active'],
                member_count=len(account.get('enterprise_account_members', [])),
                created_at=account['created_at']
            ))
        
        return accounts
        
    except Exception as e:
        logger.error(f"Error listing enterprise accounts: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Error listing accounts: {str(e)}")


@router.get("/accounts/{enterprise_id}")
async def get_enterprise_account(
    enterprise_id: str,
    admin_user_id: str = Depends(verify_simple_admin)
):
    """Get detailed information about a specific enterprise account."""
    if not config.ENTERPRISE_MODE:
        raise HTTPException(status_code=400, detail="Enterprise mode not enabled")
    
    try:
        db = DBConnection()
        client = await db.client
        
        # Get account with members
        result = await client.table('enterprise_billing_accounts')\
            .select('*, enterprise_account_members(*, basejump.accounts(name))')\
            .eq('id', enterprise_id)\
            .limit(1)\
            .execute()
        
        if not result.data:
            raise HTTPException(status_code=404, detail="Enterprise account not found")
        
        account = result.data[0]
        
        return {
            'enterprise_account': account,
            'member_count': len(account.get('enterprise_account_members', []))
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting enterprise account {enterprise_id}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Error getting account: {str(e)}")


# =====================================================
# CREDIT MANAGEMENT
# =====================================================

@router.post("/load-credits")
async def load_credits(
    request: LoadCreditsRequest,
    admin_user_id: str = Depends(verify_simple_admin)
):
    """Manually load credits into an enterprise billing account."""
    if not config.ENTERPRISE_MODE:
        raise HTTPException(status_code=400, detail="Enterprise mode not enabled")
    
    try:
        success, message = await enterprise_billing.load_enterprise_credits(
            enterprise_id=request.enterprise_id,
            amount=request.amount,
            description=request.description,
            performed_by=admin_user_id
        )
        
        if success:
            logger.info(
                f"Loaded ${request.amount} into enterprise {request.enterprise_id}",
                enterprise_id=request.enterprise_id,
                amount=request.amount,
                performed_by=admin_user_id
            )
            return {
                'success': True,
                'message': message,
                'amount_loaded': request.amount
            }
        else:
            raise HTTPException(status_code=400, detail=message)
            
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error loading credits: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Error loading credits: {str(e)}")


# =====================================================
# USER MANAGEMENT
# =====================================================

@router.post("/add-user")
async def add_user_to_enterprise(
    request: AddUserToEnterpriseRequest,
    admin_user_id: str = Depends(verify_simple_admin)
):
    """Add a user account to an enterprise billing account."""
    if not config.ENTERPRISE_MODE:
        raise HTTPException(status_code=400, detail="Enterprise mode not enabled")
    
    try:
        db = DBConnection()
        client = await db.client
        
        # Check if enterprise account exists
        enterprise_check = await client.table('enterprise_billing_accounts')\
            .select('id')\
            .eq('id', request.enterprise_id)\
            .eq('is_active', True)\
            .limit(1)\
            .execute()
        
        if not enterprise_check.data:
            raise HTTPException(status_code=404, detail="Enterprise account not found or inactive")
        
        # Check if user account exists
        user_check = await client.table('basejump.accounts')\
            .select('id')\
            .eq('id', request.account_id)\
            .limit(1)\
            .execute()
        
        if not user_check.data:
            raise HTTPException(status_code=404, detail="User account not found")
        
        # Add user to enterprise
        member_data = {
            'account_id': request.account_id,
            'enterprise_billing_id': request.enterprise_id,
            'monthly_spend_limit': request.monthly_limit,
            'is_active': True
        }
        
        result = await client.table('enterprise_account_members')\
            .insert(member_data)\
            .execute()
        
        if not result.data:
            raise HTTPException(status_code=500, detail="Failed to add user to enterprise")
        
        logger.info(
            f"Added user {request.account_id} to enterprise {request.enterprise_id}",
            account_id=request.account_id,
            enterprise_id=request.enterprise_id,
            monthly_limit=request.monthly_limit,
            performed_by=admin_user_id
        )
        
        return {
            'success': True,
            'message': f"User added to enterprise with ${request.monthly_limit} monthly limit",
            'member': result.data[0]
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error adding user to enterprise: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Error adding user: {str(e)}")


@router.put("/update-user-limit")
async def update_user_limit(
    request: UpdateUserLimitRequest,
    admin_user_id: str = Depends(verify_simple_admin)
):
    """Update the monthly spend limit for a user in enterprise billing."""
    if not config.ENTERPRISE_MODE:
        raise HTTPException(status_code=400, detail="Enterprise mode not enabled")
    
    try:
        success, message = await enterprise_billing.update_user_monthly_limit(
            account_id=request.account_id,
            new_limit=request.monthly_limit,
            updated_by=admin_user_id
        )
        
        if success:
            return {
                'success': True,
                'message': message,
                'new_limit': request.monthly_limit
            }
        else:
            raise HTTPException(status_code=400, detail=message)
            
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating user limit: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Error updating limit: {str(e)}")


@router.delete("/remove-user/{account_id}")
async def remove_user_from_enterprise(
    account_id: str,
    admin_user_id: str = Depends(verify_simple_admin)
):
    """Remove a user from enterprise billing (deactivate membership)."""
    if not config.ENTERPRISE_MODE:
        raise HTTPException(status_code=400, detail="Enterprise mode not enabled")
    
    try:
        db = DBConnection()
        client = await db.client
        
        # Deactivate membership instead of deleting for audit purposes
        result = await client.table('enterprise_account_members')\
            .update({'is_active': False})\
            .eq('account_id', account_id)\
            .execute()
        
        if not result.data:
            raise HTTPException(status_code=404, detail="User not found in any enterprise")
        
        logger.info(
            f"Removed user {account_id} from enterprise billing",
            account_id=account_id,
            performed_by=admin_user_id
        )
        
        return {
            'success': True,
            'message': 'User removed from enterprise billing'
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error removing user from enterprise: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Error removing user: {str(e)}")


# =====================================================
# USAGE STATISTICS AND REPORTING
# =====================================================

@router.get("/usage/{enterprise_id}", response_model=UsageStatsResponse)
async def get_enterprise_usage(
    enterprise_id: str,
    page: int = Query(default=0, ge=0, description="Page number for pagination"),
    items_per_page: int = Query(default=100, ge=1, le=500, description="Items per page"),
    days: int = Query(default=30, ge=1, le=365, description="Number of days to look back"),
    admin_user_id: str = Depends(verify_simple_admin)
):
    """Get comprehensive usage statistics for an enterprise billing account."""
    if not config.ENTERPRISE_MODE:
        raise HTTPException(status_code=400, detail="Enterprise mode not enabled")
    
    try:
        # Calculate date range
        end_date = datetime.now(timezone.utc)
        start_date = end_date - timedelta(days=days)
        
        stats = await enterprise_billing.get_enterprise_usage_stats(
            enterprise_id=enterprise_id,
            page=page,
            items_per_page=items_per_page,
            start_date=start_date,
            end_date=end_date
        )
        
        if 'error' in stats:
            raise HTTPException(status_code=404, detail=stats['error'])
        
        return UsageStatsResponse(**stats)
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting enterprise usage for {enterprise_id}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Error getting usage stats: {str(e)}")


@router.get("/usage/{enterprise_id}/user/{account_id}")
async def get_user_usage_in_enterprise(
    enterprise_id: str,
    account_id: str,
    page: int = Query(default=0, ge=0),
    items_per_page: int = Query(default=50, ge=1, le=200),
    days: int = Query(default=30, ge=1, le=365),
    admin_user_id: str = Depends(verify_simple_admin)
):
    """Get usage statistics for a specific user within an enterprise."""
    if not config.ENTERPRISE_MODE:
        raise HTTPException(status_code=400, detail="Enterprise mode not enabled")
    
    try:
        db = DBConnection()
        client = await db.client
        
        # Verify user is in the enterprise
        membership = await client.table('enterprise_account_members')\
            .select('*')\
            .eq('enterprise_billing_id', enterprise_id)\
            .eq('account_id', account_id)\
            .limit(1)\
            .execute()
        
        if not membership.data:
            raise HTTPException(status_code=404, detail="User not found in this enterprise")
        
        # Get user's usage logs
        end_date = datetime.now(timezone.utc)
        start_date = end_date - timedelta(days=days)
        
        offset = page * items_per_page
        
        usage_query = client.table('enterprise_usage_logs')\
            .select('*')\
            .eq('enterprise_billing_id', enterprise_id)\
            .eq('account_id', account_id)\
            .gte('created_at', start_date.isoformat())\
            .lte('created_at', end_date.isoformat())\
            .order('created_at', desc=True)\
            .range(offset, offset + items_per_page - 1)
        
        usage_result = await usage_query.execute()
        
        # Calculate summary stats
        total_cost = sum(float(log['cost']) for log in usage_result.data)
        
        return {
            'user_info': membership.data[0],
            'usage_logs': usage_result.data,
            'summary': {
                'total_cost': total_cost,
                'log_count': len(usage_result.data),
                'date_range': {
                    'start': start_date.isoformat(),
                    'end': end_date.isoformat()
                }
            },
            'page': page,
            'items_per_page': items_per_page,
            'has_more': len(usage_result.data) == items_per_page
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting user usage: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Error getting user usage: {str(e)}")


# =====================================================
# SYSTEM MAINTENANCE
# =====================================================

@router.post("/reset-monthly-usage")
async def reset_monthly_usage(
    admin_user_id: str = Depends(verify_simple_admin)
):
    """Reset monthly usage for all enterprise users (typically run monthly via cron)."""
    if not config.ENTERPRISE_MODE:
        raise HTTPException(status_code=400, detail="Enterprise mode not enabled")
    
    try:
        db = DBConnection()
        client = await db.client
        
        # Call the database function
        result = await client.rpc('reset_enterprise_monthly_usage').execute()
        
        reset_count = result.data if result.data else 0
        
        logger.info(
            f"Reset monthly usage for {reset_count} enterprise users",
            reset_count=reset_count,
            performed_by=admin_user_id
        )
        
        return {
            'success': True,
            'message': f'Reset monthly usage for {reset_count} users',
            'reset_count': reset_count
        }
        
    except Exception as e:
        logger.error(f"Error resetting monthly usage: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Error resetting usage: {str(e)}")
