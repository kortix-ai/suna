from fastapi import APIRouter, HTTPException, Depends, Query
from typing import Optional, List, Dict, Any
from datetime import datetime, timedelta
from pydantic import BaseModel
from core.auth import require_admin, require_super_admin
from core.services.supabase import DBConnection
from core.utils.logger import logger

router = APIRouter(prefix="/admin/users", tags=["admin-users"])

class UserListRequest(BaseModel):
    search_email: Optional[str] = None
    search_name: Optional[str] = None
    tier_filter: Optional[str] = None
    sort_by: str = "created_at"
    sort_order: str = "desc"

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

@router.get("/list")
async def list_users(
    page: int = Query(1, ge=1, description="Page number"),
    page_size: int = Query(20, ge=1, le=100, description="Items per page"),
    search_email: Optional[str] = Query(None, description="Search by email"),
    search_name: Optional[str] = Query(None, description="Search by name"),
    tier_filter: Optional[str] = Query(None, description="Filter by tier"),
    sort_by: str = Query("created_at", description="Sort field"),
    sort_order: str = Query("desc", description="Sort order: asc, desc"),
    admin: dict = Depends(require_admin)
):
    try:
        db = DBConnection()
        client = await db.client
        
        # First get accounts with billing info
        base_query = client.schema('basejump').from_('accounts').select(
            '''
            id,
            created_at,
            billing_customers!inner(email),
            billing_subscriptions(status)
            '''
        )
        
        if search_email:
            base_query = base_query.filter('billing_customers.email', 'ilike', f'%{search_email}%')
        
        sort_column = sort_by
        if sort_by == "email":
            sort_column = "billing_customers.email"
        
        if sort_by not in ["balance", "tier"]:
            ascending = sort_order.lower() == "asc"
            base_query = base_query.order(sort_column, desc=not ascending)
        
        offset = (page - 1) * page_size
        
        count_result = await client.schema('basejump').from_('accounts').select('*', count='exact').execute()
        total_count = count_result.count or 0
        
        data_result = await base_query.execute()
        
        user_ids = [item['id'] for item in data_result.data or []]
        credit_accounts = {}
        if user_ids:
            credit_result = await client.from_('credit_accounts').select(
                'user_id, balance, tier, lifetime_purchased, lifetime_used'
            ).in_('user_id', user_ids).execute()
            
            for credit in credit_result.data or []:
                credit_accounts[credit['user_id']] = credit
        
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
        
        paginated_data = (data_result.data or [])[offset:offset + page_size]
        
        users = []
        for item in paginated_data:
            subscription_status = None
            if item.get('billing_subscriptions'):
                subscription_status = item['billing_subscriptions'][0].get('status')
            
            credit_account = credit_accounts.get(item['id'], {})
            
            users.append(UserSummary(
                id=item['id'],
                email=item['billing_customers'][0]['email'] if item.get('billing_customers') else 'N/A',
                created_at=datetime.fromisoformat(item['created_at'].replace('Z', '+00:00')),
                tier=credit_account.get('tier', 'free'),
                credit_balance=float(credit_account.get('balance', 0)),
                total_purchased=float(credit_account.get('lifetime_purchased', 0)),
                total_used=float(credit_account.get('lifetime_used', 0)),
                subscription_status=subscription_status
            ))
        
        total_pages = max(1, (total_count + page_size - 1) // page_size)
        
        return {
            "users": users,
            "pagination": {
                "current_page": page,
                "page_size": page_size,
                "total_items": total_count,
                "total_pages": total_pages,
                "has_next": page < total_pages,
                "has_previous": page > 1
            }
        }
        
    except Exception as e:
        logger.error(f"Failed to list users: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to retrieve users")

@router.get("/{user_id}")
async def get_user_details(
    user_id: str,
    admin: dict = Depends(require_admin)
):
    try:
        db = DBConnection()
        client = await db.client

        account_result = await client.schema('basejump').from_('accounts').select(
            '''
            id,
            created_at,
            billing_customers(email),
            billing_subscriptions(status, created, current_period_end)
            '''
        ).eq('id', user_id).execute()
        
        if not account_result.data:
            raise HTTPException(status_code=404, detail="User not found")
        
        account = account_result.data[0]
        
        credit_result = await client.from_('credit_accounts').select(
            'balance, tier, lifetime_granted, lifetime_purchased, lifetime_used, last_grant_date'
        ).eq('user_id', user_id).execute()
        
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

@router.get("/search/email")
async def search_users_by_email(
    email: str = Query(..., description="Email to search for"),
    admin: dict = Depends(require_admin)
):
    try:
        db = DBConnection()
        client = await db.client
        
        result = await client.schema('basejump').from_('billing_customers').select(
            '''
            account_id,
            email,
            accounts!inner(created_at)
            '''
        ).ilike('email', f'%{email}%').limit(10).execute()
        
        user_ids = [item['account_id'] for item in result.data]
        credit_accounts = {}
        if user_ids:
            credit_result = await client.from_('credit_accounts').select(
                'user_id, balance, tier'
            ).in_('user_id', user_ids).execute()
            
            for credit in credit_result.data or []:
                credit_accounts[credit['user_id']] = credit
        
        users = []
        for item in result.data:
            credit_account = credit_accounts.get(item['account_id'], {})
            users.append({
                "id": item['account_id'],
                "email": item['email'],
                "created_at": item['accounts']['created_at'],
                "tier": credit_account.get('tier', 'free'),
                "credit_balance": float(credit_account.get('balance', 0))
            })
        
        return {"users": users}
        
    except Exception as e:
        logger.error(f"Failed to search users by email: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to search users")

@router.get("/stats/overview")
async def get_user_stats_overview(
    admin: dict = Depends(require_admin)
):
    try:
        db = DBConnection()
        client = await db.client
        
        total_users = await client.schema('basejump').from_('accounts').select('*', count='exact').execute()
        
        tier_stats = await client.from_('credit_accounts').select('tier', count='exact').execute()
        
        thirty_days_ago = (datetime.utcnow() - timedelta(days=30)).isoformat()
        active_users = await client.from_('agent_runs').select(
            'threads(account_id)', count='exact'
        ).gte('created_at', thirty_days_ago).execute()
        
        return {
            "total_users": total_users.count or 0,
            "active_users_30d": active_users.count or 0,
            "tier_distribution": tier_stats.data if tier_stats.data else []
        }
        
    except Exception as e:
        logger.error(f"Failed to get user stats: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to retrieve user statistics") 