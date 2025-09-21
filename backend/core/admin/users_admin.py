from fastapi import APIRouter, HTTPException, Depends, Query
from typing import Optional, List, Dict, Any
from datetime import datetime, timedelta
from pydantic import BaseModel
from core.auth import require_admin, require_super_admin
from core.services.supabase import DBConnection
from core.utils.logger import logger
from core.utils.pagination import PaginationService, PaginationParams, PaginatedResponse

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
    trial_status: Optional[str] = None

class AdvancedSearchRequest(BaseModel):
    email_contains: Optional[str] = None
    tier_in: Optional[List[str]] = None
    subscription_status_in: Optional[List[str]] = None
    trial_status_in: Optional[List[str]] = None
    balance_min: Optional[float] = None
    balance_max: Optional[float] = None
    created_after: Optional[datetime] = None
    created_before: Optional[datetime] = None
    has_activity_since: Optional[datetime] = None
    sort_by: str = "created_at"
    sort_order: str = "desc"

@router.post("/search/advanced")
async def advanced_user_search(
    request: AdvancedSearchRequest,
    page: int = Query(1, ge=1, description="Page number"),
    page_size: int = Query(20, ge=1, le=100, description="Items per page"),
    admin: dict = Depends(require_admin)
) -> PaginatedResponse[UserSummary]:
    try:
        db = DBConnection()
        client = await db.client
        
        pagination_params = PaginationParams(page=page, page_size=page_size)
        
        account_ids_to_filter = None
        
        if request.email_contains:
            email_result = await client.schema('basejump').from_('billing_customers').select(
                'account_id'
            ).ilike('email', f'%{request.email_contains}%').limit(1000).execute()
            
            account_ids_to_filter = [item['account_id'] for item in email_result.data or []]
            
            if not account_ids_to_filter:
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
        )
        
        if account_ids_to_filter:
            base_query = base_query.in_('id', account_ids_to_filter)
        
        if request.created_after:
            base_query = base_query.gte('created_at', request.created_after.isoformat())
        
        if request.created_before:
            base_query = base_query.lte('created_at', request.created_before.isoformat())
        
        if request.subscription_status_in:
            base_query = base_query.in_('billing_subscriptions.status', request.subscription_status_in)
        
        data_result = await base_query.execute()
        
        user_ids = [item['id'] for item in data_result.data or []]
        
        credit_accounts = {}
        trial_statuses = {}
        if user_ids:
            credit_result = await client.from_('credit_accounts').select(
                'account_id, balance, tier, lifetime_purchased, lifetime_used, trial_status'
            ).in_('account_id', user_ids).execute()
            
            for credit in credit_result.data or []:
                credit_accounts[credit['account_id']] = credit
                trial_statuses[credit['account_id']] = credit.get('trial_status')
        
        recent_activity = {}
        if request.has_activity_since and user_ids:
            activity_result = await client.from_('agent_runs').select(
                'threads!inner(account_id), created_at'
            ).in_('threads.account_id', user_ids).gte('created_at', request.has_activity_since.isoformat()).execute()
            
            for activity in activity_result.data or []:
                account_id = activity['threads']['account_id']
                if account_id not in recent_activity or activity['created_at'] > recent_activity[account_id]:
                    recent_activity[account_id] = activity['created_at']
        
        filtered_data = []
        for item in data_result.data or []:
            credit_account = credit_accounts.get(item['id'], {})
            balance = float(credit_account.get('balance', 0))
            tier = credit_account.get('tier', 'free')
            trial_status = trial_statuses.get(item['id'])
            
            if request.tier_in and tier not in request.tier_in:
                continue
            
            if request.trial_status_in and trial_status not in request.trial_status_in:
                continue
            
            if request.balance_min is not None and balance < request.balance_min:
                continue
            
            if request.balance_max is not None and balance > request.balance_max:
                continue
            
            if request.has_activity_since and item['id'] not in recent_activity:
                continue
            
            filtered_data.append(item)
        
        def get_sort_value(item):
            credit = credit_accounts.get(item['id'], {})
            if request.sort_by == "balance":
                return float(credit.get('balance', 0))
            elif request.sort_by == "tier":
                return credit.get('tier', 'free')
            elif request.sort_by == "email":
                return item['billing_customers'][0]['email'] if item.get('billing_customers') else ''
            elif request.sort_by == "last_activity":
                return recent_activity.get(item['id'], '')
            else:
                return item.get('created_at', '')
        
        ascending = request.sort_order.lower() == "asc"
        sorted_data = sorted(filtered_data, key=get_sort_value, reverse=not ascending)
        
        total_count = len(sorted_data)
        offset = (pagination_params.page - 1) * pagination_params.page_size
        paginated_data = sorted_data[offset:offset + pagination_params.page_size]
        
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
                last_activity=datetime.fromisoformat(recent_activity[item['id']].replace('Z', '+00:00')) if item['id'] in recent_activity else None,
                trial_status=trial_statuses.get(item['id'])
            ))
        
        return await PaginationService.paginate_with_total_count(
            items=users,
            total_count=total_count,
            params=pagination_params
        )
        
    except Exception as e:
        logger.error(f"Failed to perform advanced search: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to search users")

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
) -> PaginatedResponse[UserSummary]:
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
            
            # Get email from billing_customers or fetch from auth.users for OAuth users
            email = 'N/A'
            if item.get('billing_customers') and item['billing_customers'][0].get('email'):
                email = item['billing_customers'][0]['email']
            elif item.get('primary_owner_user_id'):
                # Try to get email for OAuth users
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
            primary_owner_user_id,
            billing_customers(email),
            billing_subscriptions(status, created, current_period_end)
            '''
        ).eq('id', user_id).execute()
        
        if not account_result.data:
            raise HTTPException(status_code=404, detail="User not found")
        
        account = account_result.data[0]
        
        # Get email if not present (OAuth users)
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

@router.get("/search/email")
async def search_users_by_email(
    email: str = Query(..., description="Email to search for"),
    page: int = Query(1, ge=1, description="Page number"),
    page_size: int = Query(10, ge=1, le=50, description="Items per page"),
    admin: dict = Depends(require_admin)
) -> PaginatedResponse[Dict[str, Any]]:
    try:
        db = DBConnection()
        client = await db.client
        
        pagination_params = PaginationParams(page=page, page_size=page_size)
        
        email_query = client.schema('basejump').from_('billing_customers').select(
            'account_id, email'
        ).ilike('email', f'%{email}%').limit(500)
        
        email_result = await email_query.execute()
        matching_customers = email_result.data or []
        total_count = len(matching_customers)
        
        offset = (pagination_params.page - 1) * pagination_params.page_size
        paginated_customers = matching_customers[offset:offset + pagination_params.page_size]
        
        if not paginated_customers:
            return await PaginationService.paginate_with_total_count(
                items=[],
                total_count=total_count,
                params=pagination_params
            )
        
        account_ids = [item['account_id'] for item in paginated_customers]
        email_map = {item['account_id']: item['email'] for item in paginated_customers}
        
        accounts_result = await client.schema('basejump').from_('accounts').select(
            'id, created_at'
        ).in_('id', account_ids).execute()
        
        accounts_map = {item['id']: item['created_at'] for item in accounts_result.data or []}
        
        credit_accounts = {}
        if account_ids:
            credit_result = await client.from_('credit_accounts').select(
                'account_id, balance, tier, trial_status'
            ).in_('account_id', account_ids).execute()
            
            for credit in credit_result.data or []:
                credit_accounts[credit['account_id']] = credit
        
        users = []
        for account_id in account_ids:
            credit_account = credit_accounts.get(account_id, {})
            users.append({
                "id": account_id,
                "email": email_map[account_id],
                "created_at": accounts_map.get(account_id, ''),
                "tier": credit_account.get('tier', 'free'),
                "credit_balance": float(credit_account.get('balance', 0)),
                "trial_status": credit_account.get('trial_status')
            })
        
        return await PaginationService.paginate_with_total_count(
            items=users,
            total_count=total_count,
            params=pagination_params
        )
        
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

class UserActivityRequest(BaseModel):
    days: int = 30
    
@router.post("/activity/summary")
async def get_user_activity_summary(
    request: UserActivityRequest,
    admin: dict = Depends(require_admin)
):
    try:
        db = DBConnection()
        client = await db.client
        
        cutoff_date = (datetime.utcnow() - timedelta(days=request.days)).isoformat()
        
        runs_result = await client.from_('agent_runs').select(
            '''
            created_at,
            status,
            threads!inner(account_id)
            '''
        ).gte('created_at', cutoff_date).execute()
        
        daily_activity = {}
        user_activity = {}
        status_counts = {'completed': 0, 'failed': 0, 'running': 0, 'pending': 0}
        
        for run in runs_result.data or []:
            date_str = run['created_at'][:10]
            daily_activity[date_str] = daily_activity.get(date_str, 0) + 1
            
            account_id = run['threads']['account_id']
            user_activity[account_id] = user_activity.get(account_id, 0) + 1
            
            status = run.get('status', 'unknown')
            if status in status_counts:
                status_counts[status] += 1
        
        sorted_dates = sorted(daily_activity.keys())
        daily_data = [
            {"date": date, "runs": daily_activity[date]} 
            for date in sorted_dates
        ]
        
        most_active_users = sorted(
            user_activity.items(), 
            key=lambda x: x[1], 
            reverse=True
        )[:10]
        
        return {
            "summary": {
                "total_runs": len(runs_result.data or []),
                "unique_users": len(user_activity),
                "average_runs_per_user": round(len(runs_result.data or []) / max(1, len(user_activity)), 2),
                "status_distribution": status_counts
            },
            "daily_activity": daily_data,
            "top_users": [
                {"account_id": user_id, "run_count": count}
                for user_id, count in most_active_users
            ]
        }
        
    except Exception as e:
        logger.error(f"Failed to get activity summary: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to retrieve activity summary")

class CreditAdjustmentRequest(BaseModel):
    user_id: str
    amount: float
    reason: str
    
@router.post("/credits/adjust")
async def adjust_user_credits(
    request: CreditAdjustmentRequest,
    admin: dict = Depends(require_super_admin)
):
    try:
        db = DBConnection()
        client = await db.client
        
        current_result = await client.from_('credit_accounts').select(
            'balance'
        ).eq('account_id', request.user_id).execute()
        
        if not current_result.data:
            raise HTTPException(status_code=404, detail="User credit account not found")
        
        current_balance = float(current_result.data[0]['balance'])
        new_balance = current_balance + request.amount
        
        if new_balance < 0:
            raise HTTPException(status_code=400, detail="Cannot set negative balance")
        
        await client.from_('credit_accounts').update({
            'balance': new_balance
        }).eq('account_id', request.user_id).execute()
        
        await client.from_('credit_ledger').insert({
            'account_id': request.user_id,
            'amount': request.amount,
            'balance_after': new_balance,
            'type': 'admin_adjustment',
            'description': f"Admin adjustment: {request.reason}"
        }).execute()
        
        logger.info(f"Admin {admin['user_id']} adjusted credits for user {request.user_id} by {request.amount}")
        
        return {
            "success": True,
            "previous_balance": current_balance,
            "new_balance": new_balance,
            "adjustment": request.amount
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to adjust credits: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to adjust user credits") 