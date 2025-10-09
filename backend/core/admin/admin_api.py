"""
Consolidated Admin API
Handles all administrative operations for user management, system configuration, and agent installations.
"""

from fastapi import APIRouter, HTTPException, Depends, Query
from typing import Optional, List, Dict, Any
from datetime import datetime, timedelta
from pydantic import BaseModel
from core.auth import require_admin
from core.services.supabase import DBConnection
from core.utils.logger import logger
from core.utils.pagination import PaginationService, PaginationParams, PaginatedResponse
from core.utils.auth_utils import verify_admin_api_key
from core.utils.suna_default_agent_service import SunaDefaultAgentService
from core.utils.config import config, EnvMode
from dotenv import load_dotenv, set_key, find_dotenv, dotenv_values
import os

router = APIRouter(prefix="/admin", tags=["admin"])

# ============================================================================
# MODELS
# ============================================================================

class UserSummary(BaseModel):
    id: str
    email: str
    created_at: datetime
    tier: str
    credit_balance: float
    total_purchased: float
    total_used: float
    subscription_status: Optional[str] = None
    last_activity: Optional[datetime] = None
    trial_status: Optional[str] = None

class UserThreadSummary(BaseModel):
    thread_id: str
    project_id: Optional[str] = None
    project_name: Optional[str] = None
    is_public: bool
    created_at: datetime
    updated_at: datetime

# ============================================================================
# USER MANAGEMENT ENDPOINTS
# ============================================================================

@router.get("/users/list")
async def list_users(
    page: int = Query(1, ge=1, description="Page number"),
    page_size: int = Query(20, ge=1, le=100, description="Items per page"),
    search_email: Optional[str] = Query(None, description="Search by email"),
    search_name: Optional[str] = Query(None, description="Search by name"),
    tier_filter: Optional[str] = Query(None, description="Filter by tier"),
    sort_by: str = Query("created_at", description="Sort field"),
    sort_order: str = Query("desc", description="Sort order: asc, desc"),
    admin: dict = Depends(require_admin)
) -> PaginatedResponse[UserSummary]:
    """List all users with pagination and filtering."""
    try:
        db = DBConnection()
        client = await db.client
        
        pagination_params = PaginationParams(page=page, page_size=page_size)
        
        if search_email:
            email_result = await client.schema('basejump').from_('billing_customers').select(
                'account_id'
            ).ilike('email', f'%{search_email}%').limit(1000).execute()
            
            matching_account_ids = [item['account_id'] for item in email_result.data or []]
            
            if not matching_account_ids:
                return await PaginationService.paginate_with_total_count(
                    items=[],
                    total_count=0,
                    params=pagination_params
                )
            
            base_query = client.schema('basejump').from_('accounts').select(
                '''
                id,
                created_at,
                primary_owner_user_id,
                billing_customers(email),
                billing_subscriptions(status)
                '''
            ).in_('id', matching_account_ids)
            
            total_count = len(matching_account_ids)
        else:
            base_query = client.schema('basejump').from_('accounts').select(
                '''
                id,
                created_at,
                primary_owner_user_id,
                billing_customers(email),
                billing_subscriptions(status)
                '''
            )
            
            count_result = await client.schema('basejump').from_('accounts').select('*', count='exact').execute()
            total_count = count_result.count or 0
        
        sort_column = sort_by
        if sort_by == "email":
            sort_column = "billing_customers.email"
        
        if sort_by not in ["balance", "tier"]:
            ascending = sort_order.lower() == "asc"
            base_query = base_query.order(sort_column, desc=not ascending)
        
        offset = (pagination_params.page - 1) * pagination_params.page_size
        data_result = await base_query.range(offset, offset + pagination_params.page_size - 1).execute()
        
        user_ids = [item['id'] for item in data_result.data or []]
        credit_accounts = {}
        if user_ids:
            credit_result = await client.from_('credit_accounts').select(
                'account_id, balance, tier, lifetime_purchased, lifetime_used, trial_status'
            ).in_('account_id', user_ids).execute()
            
            for credit in credit_result.data or []:
                credit_accounts[credit['account_id']] = credit
        
        if tier_filter:
            filtered_data = []
            for item in data_result.data or []:
                credit_account = credit_accounts.get(item['id'])
                if credit_account and credit_account.get('tier') == tier_filter:
                    filtered_data.append(item)
            data_result.data = filtered_data
            total_count = len(filtered_data)
        
        if sort_by in ["balance", "tier"]:
            def get_sort_value(item):
                credit = credit_accounts.get(item['id'], {})
                if sort_by == "balance":
                    return float(credit.get('balance', 0))
                else:
                    return credit.get('tier', 'free')
            
            ascending = sort_order.lower() == "asc"
            data_result.data = sorted(
                data_result.data or [], 
                key=get_sort_value,
                reverse=not ascending
            )
            if tier_filter:
                paginated_data = data_result.data[offset:offset + pagination_params.page_size]
            else:
                paginated_data = data_result.data
        else:
            paginated_data = data_result.data or []
        
        users = []
        for item in paginated_data:
            subscription_status = None
            if item.get('billing_subscriptions'):
                subscription_status = item['billing_subscriptions'][0].get('status')
            
            credit_account = credit_accounts.get(item['id'], {})
            
            email = 'N/A'
            if item.get('billing_customers') and item['billing_customers'][0].get('email'):
                email = item['billing_customers'][0]['email']
            elif item.get('primary_owner_user_id'):
                try:
                    user_email_result = await client.rpc('get_user_email', {'user_id': item['primary_owner_user_id']}).execute()
                    if user_email_result.data:
                        email = user_email_result.data
                except Exception as e:
                    logger.warning(f"Failed to get email for account {item['id']}: {e}")
            
            users.append(UserSummary(
                id=item['id'],
                email=email,
                created_at=datetime.fromisoformat(item['created_at'].replace('Z', '+00:00')),
                tier=credit_account.get('tier', 'free'),
                credit_balance=float(credit_account.get('balance', 0)),
                total_purchased=float(credit_account.get('lifetime_purchased', 0)),
                total_used=float(credit_account.get('lifetime_used', 0)),
                subscription_status=subscription_status,
                trial_status=credit_account.get('trial_status')
            ))
        
        return await PaginationService.paginate_with_total_count(
            items=users,
            total_count=total_count,
            params=pagination_params
        )
        
    except Exception as e:
        logger.error(f"Failed to list users: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to retrieve users")

@router.get("/users/{user_id}")
async def get_user_details(
    user_id: str,
    admin: dict = Depends(require_admin)
):
    """Get detailed information about a specific user."""
    try:
        db = DBConnection()
        client = await db.client

        account_result = await client.schema('basejump').from_('accounts').select(
            '''
            id,
            created_at,
            primary_owner_user_id,
            billing_customers(email),
            billing_subscriptions(status, created, current_period_end)
            '''
        ).eq('id', user_id).execute()
        
        if not account_result.data:
            raise HTTPException(status_code=404, detail="User not found")
        
        account = account_result.data[0]
        
        if not account.get('billing_customers') or not account['billing_customers'][0].get('email'):
            if account.get('primary_owner_user_id'):
                try:
                    user_email_result = await client.rpc('get_user_email', {'user_id': account['primary_owner_user_id']}).execute()
                    if user_email_result.data:
                        if not account.get('billing_customers'):
                            account['billing_customers'] = [{}]
                        account['billing_customers'][0]['email'] = user_email_result.data
                except Exception as e:
                    logger.warning(f"Failed to get email for account {user_id}: {e}")
        
        credit_result = await client.from_('credit_accounts').select(
            'balance, tier, lifetime_granted, lifetime_purchased, lifetime_used, last_grant_date'
        ).eq('account_id', user_id).execute()
        
        if credit_result.data:
            account['credit_accounts'] = credit_result.data
        else:
            account['credit_accounts'] = [{
                'balance': '0',
                'tier': 'free',
                'lifetime_granted': '0',
                'lifetime_purchased': '0',
                'lifetime_used': '0',
                'last_grant_date': None
            }]
        
        recent_activity = await client.from_('agent_runs').select(
            'id, created_at, status, thread_id, threads!inner(account_id)'
        ).eq('threads.account_id', user_id).order('created_at', desc=True).limit(10).execute()
        
        return {
            "user": account,
            "recent_activity": recent_activity.data or []
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to get user details: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to retrieve user details")

@router.get("/users/stats/overview")
async def get_user_stats_overview(
    admin: dict = Depends(require_admin)
):
    """Get overview statistics about all users."""
    try:
        db = DBConnection()
        client = await db.client
        
        total_users = await client.schema('basejump').from_('accounts').select('*', count='exact').execute()
        
        tier_result = await client.from_('credit_accounts').select('tier').execute()
        tier_counts = {}
        for item in tier_result.data or []:
            tier = item.get('tier', 'free')
            tier_counts[tier] = tier_counts.get(tier, 0) + 1
        
        tier_distribution = [
            {"tier": tier, "count": count} 
            for tier, count in tier_counts.items()
        ]
        
        thirty_days_ago = (datetime.utcnow() - timedelta(days=30)).isoformat()
        
        runs_result = await client.from_('agent_runs').select(
            'threads!inner(account_id)'
        ).gte('created_at', thirty_days_ago).execute()
        
        unique_accounts = set()
        for run in runs_result.data or []:
            if run.get('threads') and run['threads'].get('account_id'):
                unique_accounts.add(run['threads']['account_id'])
        active_count = len(unique_accounts)
        
        total_credits_result = await client.from_('credit_accounts').select('balance').execute()
        total_credits = sum(float(item.get('balance', 0)) for item in total_credits_result.data or [])
        
        avg_credits = total_credits / max(1, len(total_credits_result.data or []))
        
        return {
            "total_users": total_users.count or 0,
            "active_users_30d": active_count,
            "tier_distribution": tier_distribution,
            "total_credits_in_system": round(total_credits, 2),
            "average_credit_balance": round(avg_credits, 2)
        }
        
    except Exception as e:
        logger.error(f"Failed to get user stats: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to retrieve user statistics")

@router.get("/users/{user_id}/activity")
async def get_user_activity(
    user_id: str,
    page: int = Query(1, ge=1, description="Page number"),
    page_size: int = Query(20, ge=1, le=100, description="Items per page"),
    status_filter: Optional[str] = Query(None, description="Filter by status"),
    admin: dict = Depends(require_admin)
):
    """Get paginated activity (agent runs) for a specific user."""
    try:
        db = DBConnection()
        client = await db.client
        
        pagination_params = PaginationParams(page=page, page_size=page_size)
        
        # Build base query for agent runs with thread info
        base_query = client.from_('agent_runs').select(
            '*, threads!inner(account_id, thread_id)'
        ).eq('threads.account_id', user_id)
        
        if status_filter:
            base_query = base_query.eq('status', status_filter)
        
        # Get total count
        count_result = await client.from_('agent_runs').select(
            'id, threads!inner(account_id)', count='exact'
        ).eq('threads.account_id', user_id).execute()
        
        total_count = count_result.count or 0
        
        # Get paginated activity
        offset = (pagination_params.page - 1) * pagination_params.page_size
        activity_query = client.from_('agent_runs').select(
            '*, threads!inner(account_id, thread_id)'
        ).eq('threads.account_id', user_id)
        
        if status_filter:
            activity_query = activity_query.eq('status', status_filter)
            
        activity_result = await activity_query.order('created_at', desc=True).range(
            offset, offset + pagination_params.page_size - 1
        ).execute()
        
        # Format activity data
        activities = []
        for run in activity_result.data or []:
            thread = run.get('threads', {})
            
            activities.append({
                'id': run.get('id'),
                'created_at': run.get('created_at'),
                'updated_at': run.get('updated_at'),
                'status': run.get('status'),
                'thread_id': run.get('thread_id'),
                'thread_name': f"Thread {run.get('thread_id', '').split('-')[0] if run.get('thread_id') else 'Unknown'}",
                'agent_id': run.get('agent_id'),
                'agent_name': 'Agent',  # We'll need to fetch agent names separately if needed
                'credit_cost': float(run.get('credit_cost', 0) if run.get('credit_cost') else 0),
                'error': run.get('error'),
                'duration_ms': run.get('duration_ms')
            })
        
        return await PaginationService.paginate_with_total_count(
            items=activities,
            total_count=total_count,
            params=pagination_params
        )
        
    except Exception as e:
        logger.error(f"Failed to get user activity: {e}")
        raise HTTPException(status_code=500, detail="Failed to retrieve user activity")

@router.get("/users/threads/by-email")
async def get_user_threads_by_email(
    email: str = Query(..., description="User email to fetch threads for"),
    page: int = Query(1, ge=1, description="Page number"),
    page_size: int = Query(20, ge=1, le=100, description="Items per page"),
    admin: dict = Depends(require_admin)
) -> PaginatedResponse[UserThreadSummary]:
    """Get all project threads for a user by their email with clickable URLs."""
    try:
        db = DBConnection()
        client = await db.client
        
        pagination_params = PaginationParams(page=page, page_size=page_size)
        
        # Find account_id by email
        email_result = await client.schema('basejump').from_('billing_customers').select(
            'account_id'
        ).eq('email', email).execute()
        
        if not email_result.data:
            try:
                oauth_result = await client.rpc('get_account_by_email', {'search_email': email}).execute()
                if not oauth_result.data:
                    return await PaginationService.paginate_with_total_count(
                        items=[],
                        total_count=0,
                        params=pagination_params
                    )
                account_id = oauth_result.data
            except Exception as e:
                logger.warning(f"Could not find account for email {email}: {e}")
                return await PaginationService.paginate_with_total_count(
                    items=[],
                    total_count=0,
                    params=pagination_params
                )
        else:
            account_id = email_result.data[0]['account_id']
        
        # Get total count
        count_result = await client.from_('threads').select(
            'thread_id', count='exact'
        ).eq('account_id', account_id).execute()
        
        total_count = count_result.count or 0
        
        # Get paginated threads
        offset = (pagination_params.page - 1) * pagination_params.page_size
        threads_result = await client.from_('threads').select(
            'thread_id, project_id, is_public, created_at, updated_at'
        ).eq('account_id', account_id).order('updated_at', desc=True).range(
            offset, offset + pagination_params.page_size - 1
        ).execute()
        
        if not threads_result.data:
            return await PaginationService.paginate_with_total_count(
                items=[],
                total_count=total_count,
                params=pagination_params
            )
        
        # Get project information
        thread_ids = [t['thread_id'] for t in threads_result.data]
        project_ids = [t['project_id'] for t in threads_result.data if t.get('project_id')]
        
        projects_map = {}
        if project_ids:
            projects_result = await client.from_('projects').select(
                'project_id, name'
            ).in_('project_id', project_ids).execute()
            
            projects_map = {p['project_id']: p['name'] for p in projects_result.data or []}
        
        # Build thread summaries
        threads = []
        for thread in threads_result.data:
            project_id = thread.get('project_id')
            project_name = projects_map.get(project_id) if project_id else None
            
            threads.append(UserThreadSummary(
                thread_id=thread['thread_id'],
                project_id=project_id,
                project_name=project_name,
                is_public=thread.get('is_public', False),
                created_at=datetime.fromisoformat(thread['created_at'].replace('Z', '+00:00')),
                updated_at=datetime.fromisoformat(thread['updated_at'].replace('Z', '+00:00'))
            ))
        
        return await PaginationService.paginate_with_total_count(
            items=threads,
            total_count=total_count,
            params=pagination_params
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to get user threads by email: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to retrieve user threads")

# ============================================================================
# AGENT & SYSTEM MANAGEMENT
# ============================================================================

@router.post("/suna-agents/install-user/{account_id}")
async def admin_install_suna_for_user(
    account_id: str,
    replace_existing: bool = False,
    _: bool = Depends(verify_admin_api_key)
):
    """Install Suna agent for a specific user."""
    logger.debug(f"Admin installing Suna agent for user: {account_id}")
    
    service = SunaDefaultAgentService()
    agent_id = await service.install_suna_agent_for_user(account_id, replace_existing)
    
    if agent_id:
        return {
            "success": True,
            "message": f"Successfully installed Suna agent for user {account_id}",
            "agent_id": agent_id
        }
    else:
        raise HTTPException(
            status_code=500, 
            detail=f"Failed to install Suna agent for user {account_id}"
        )

@router.get("/env-vars")
def get_env_vars() -> Dict[str, str]:
    """Get environment variables (local mode only)."""
    if config.ENV_MODE != EnvMode.LOCAL:
        raise HTTPException(status_code=403, detail="Env vars management only available in local mode")
    
    try:
        env_path = find_dotenv()
        if not env_path:
            logger.error("Could not find .env file")
            return {}
        
        return dotenv_values(env_path)
    except Exception as e:
        logger.error(f"Failed to get env vars: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to get env variables: {e}")

@router.post("/env-vars")
def save_env_vars(request: Dict[str, str]) -> Dict[str, str]:
    """Save environment variables (local mode only)."""
    if config.ENV_MODE != EnvMode.LOCAL:
        raise HTTPException(status_code=403, detail="Env vars management only available in local mode")

    try:
        env_path = find_dotenv()
        if not env_path:
            raise HTTPException(status_code=500, detail="Could not find .env file")
        
        for key, value in request.items():
            set_key(env_path, key, value)
        
        load_dotenv(override=True)
        logger.debug(f"Env variables saved successfully: {request}")
        return {"message": "Env variables saved successfully"}
    except Exception as e:
        logger.error(f"Failed to save env variables: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to save env variables: {e}")

