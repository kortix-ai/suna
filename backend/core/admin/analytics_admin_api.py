"""
Analytics Admin API
Provides analytics data for the admin dashboard including:
- Daily/Weekly signups, subscriptions, conversion rates
- Thread analytics with message count filters
- AI-powered thread summarization
- Retention metrics
"""

from fastapi import APIRouter, HTTPException, Depends, Query
from typing import Optional, List, Dict, Any
from datetime import datetime, timedelta, timezone
from pydantic import BaseModel
import asyncio
from core.auth import require_admin
from core.services.supabase import DBConnection
from core.utils.logger import logger
from core.utils.pagination import PaginationService, PaginationParams, PaginatedResponse
from core.utils.config import config
from core.utils.query_utils import batch_query_in
import openai

router = APIRouter(prefix="/admin/analytics", tags=["admin-analytics"])


# ============================================================================
# MODELS
# ============================================================================

class DailyStats(BaseModel):
    date: str
    signups: int
    subscriptions: int
    threads_created: int
    active_users: int
    conversion_rate: float


class ThreadAnalytics(BaseModel):
    thread_id: str
    project_id: Optional[str] = None
    project_name: Optional[str] = None
    project_category: Optional[str] = None
    account_id: Optional[str] = None
    user_email: Optional[str] = None
    message_count: int
    user_message_count: int
    first_user_message: Optional[str] = None
    first_message_summary: Optional[str] = None
    created_at: datetime
    updated_at: datetime
    is_public: bool


class RetentionData(BaseModel):
    user_id: str
    email: Optional[str] = None
    first_activity: datetime
    last_activity: datetime
    total_threads: int
    weeks_active: int
    is_recurring: bool


class AnalyticsSummary(BaseModel):
    total_users: int
    total_threads: int
    total_messages: int
    active_users_today: int
    active_users_week: int
    new_signups_today: int
    new_signups_week: int
    new_subscriptions_today: int
    new_subscriptions_week: int
    conversion_rate_today: float
    conversion_rate_week: float
    avg_messages_per_thread: float
    avg_threads_per_user: float


class TranslateRequest(BaseModel):
    text: str
    target_language: str = "English"


# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

async def get_openai_client():
    """Get OpenAI client for summarization."""
    api_key = config.OPENAI_API_KEY
    if not api_key:
        raise HTTPException(status_code=500, detail="OpenAI API key not configured")
    return openai.AsyncOpenAI(api_key=api_key)


# ============================================================================
# ANALYTICS ENDPOINTS
# ============================================================================

@router.get("/summary")
async def get_analytics_summary(
    admin: dict = Depends(require_admin)
) -> AnalyticsSummary:
    """Get overall analytics summary."""
    try:
        db = DBConnection()
        client = await db.client
        
        now = datetime.now(timezone.utc)
        today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        week_start = today_start - timedelta(days=7)
        
        # Run all queries in parallel for better latency
        (
            total_users_result,
            total_threads_result,
            total_messages_result,
            active_today_result,
            active_week_result,
            signups_today_result,
            signups_week_result,
            subs_today_result,
            subs_week_result,
        ) = await asyncio.gather(
            client.schema('basejump').from_('accounts').select('*', count='exact').execute(),
            client.from_('threads').select('*', count='exact').execute(),
            client.from_('messages').select('*', count='exact').execute(),
            client.from_('threads').select('account_id').gte('updated_at', today_start.isoformat()).execute(),
            client.from_('threads').select('account_id').gte('updated_at', week_start.isoformat()).execute(),
            client.schema('basejump').from_('accounts').select('*', count='exact').gte('created_at', today_start.isoformat()).execute(),
            client.schema('basejump').from_('accounts').select('*', count='exact').gte('created_at', week_start.isoformat()).execute(),
            client.schema('basejump').from_('billing_subscriptions').select('*', count='exact').gte('created', today_start.isoformat()).eq('status', 'active').execute(),
            client.schema('basejump').from_('billing_subscriptions').select('*', count='exact').gte('created', week_start.isoformat()).eq('status', 'active').execute(),
        )
        
        total_users = total_users_result.count or 0
        total_threads = total_threads_result.count or 0
        total_messages = total_messages_result.count or 0
        active_users_today = len(set(t['account_id'] for t in active_today_result.data or [] if t.get('account_id')))
        active_users_week = len(set(t['account_id'] for t in active_week_result.data or [] if t.get('account_id')))
        new_signups_today = signups_today_result.count or 0
        new_signups_week = signups_week_result.count or 0
        new_subscriptions_today = subs_today_result.count or 0
        new_subscriptions_week = subs_week_result.count or 0
        
        # Conversion rates
        conversion_rate_today = (new_subscriptions_today / new_signups_today * 100) if new_signups_today > 0 else 0
        conversion_rate_week = (new_subscriptions_week / new_signups_week * 100) if new_signups_week > 0 else 0
        
        # Average messages per thread
        avg_messages_per_thread = (total_messages / total_threads) if total_threads > 0 else 0
        
        # Average threads per user
        avg_threads_per_user = (total_threads / total_users) if total_users > 0 else 0
        
        return AnalyticsSummary(
            total_users=total_users,
            total_threads=total_threads,
            total_messages=total_messages,
            active_users_today=active_users_today,
            active_users_week=active_users_week,
            new_signups_today=new_signups_today,
            new_signups_week=new_signups_week,
            new_subscriptions_today=new_subscriptions_today,
            new_subscriptions_week=new_subscriptions_week,
            conversion_rate_today=round(conversion_rate_today, 2),
            conversion_rate_week=round(conversion_rate_week, 2),
            avg_messages_per_thread=round(avg_messages_per_thread, 2),
            avg_threads_per_user=round(avg_threads_per_user, 2)
        )
        
    except Exception as e:
        logger.error(f"Failed to get analytics summary: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to retrieve analytics summary")


@router.get("/daily")
async def get_daily_stats(
    days: int = Query(30, ge=1, le=90, description="Number of days to fetch"),
    admin: dict = Depends(require_admin)
) -> List[DailyStats]:
    """Get daily statistics for the past N days."""
    try:
        db = DBConnection()
        client = await db.client
        
        now = datetime.now(timezone.utc)
        start_date = (now - timedelta(days=days)).replace(hour=0, minute=0, second=0, microsecond=0)
        
        # Get signups by day
        signups_result = await client.schema('basejump').from_('accounts').select(
            'created_at'
        ).gte('created_at', start_date.isoformat()).execute()
        
        # Get subscriptions by day
        subs_result = await client.schema('basejump').from_('billing_subscriptions').select(
            'created'
        ).gte('created', start_date.isoformat()).eq('status', 'active').execute()
        
        # Get threads by day
        threads_result = await client.from_('threads').select(
            'created_at, account_id'
        ).gte('created_at', start_date.isoformat()).execute()
        
        # Aggregate by day
        daily_data = {}
        for i in range(days):
            date = (now - timedelta(days=i)).strftime('%Y-%m-%d')
            daily_data[date] = {
                'signups': 0,
                'subscriptions': 0,
                'threads_created': 0,
                'active_users': set()
            }
        
        # Count signups by day
        for signup in signups_result.data or []:
            date = signup['created_at'][:10]
            if date in daily_data:
                daily_data[date]['signups'] += 1
        
        # Count subscriptions by day
        for sub in subs_result.data or []:
            date = sub['created'][:10]
            if date in daily_data:
                daily_data[date]['subscriptions'] += 1
        
        # Count threads and active users by day
        for thread in threads_result.data or []:
            date = thread['created_at'][:10]
            if date in daily_data:
                daily_data[date]['threads_created'] += 1
                if thread.get('account_id'):
                    daily_data[date]['active_users'].add(thread['account_id'])
        
        # Convert to list
        result = []
        for date in sorted(daily_data.keys(), reverse=True):
            data = daily_data[date]
            signups = data['signups']
            subs = data['subscriptions']
            conversion = (subs / signups * 100) if signups > 0 else 0
            
            result.append(DailyStats(
                date=date,
                signups=signups,
                subscriptions=subs,
                threads_created=data['threads_created'],
                active_users=len(data['active_users']),
                conversion_rate=round(conversion, 2)
            ))
        
        return result
        
    except Exception as e:
        logger.error(f"Failed to get daily stats: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to retrieve daily statistics")


@router.get("/threads/browse")
async def browse_threads(
    page: int = Query(1, ge=1, description="Page number"),
    page_size: int = Query(20, ge=1, le=100, description="Items per page"),
    min_messages: Optional[int] = Query(None, description="Minimum user messages"),
    max_messages: Optional[int] = Query(None, description="Maximum user messages"),
    search_email: Optional[str] = Query(None, description="Filter by user email"),
    category: Optional[str] = Query(None, description="Filter by project category"),
    date_from: Optional[str] = Query(None, description="Filter from date (YYYY-MM-DD)"),
    date_to: Optional[str] = Query(None, description="Filter to date (YYYY-MM-DD)"),
    sort_by: str = Query("created_at", description="Sort field"),
    sort_order: str = Query("desc", description="Sort order: asc, desc"),
    admin: dict = Depends(require_admin)
) -> PaginatedResponse[ThreadAnalytics]:
    """
    Browse threads with optional filtering.
    
    When NO message count filter is applied: paginate directly from DB (fast).
    When message count filter IS applied: defaults to last 7 days to keep query manageable.
    """
    try:
        db = DBConnection()
        client = await db.client
        
        pagination_params = PaginationParams(page=page, page_size=page_size)
        has_message_filter = min_messages is not None or max_messages is not None
        has_category_filter = category is not None
        
        # If filtering by message count or category without date range, default to last 7 days
        if (has_message_filter or has_category_filter) and not date_from:
            date_from = (datetime.now(timezone.utc) - timedelta(days=7)).strftime('%Y-%m-%d')
        
        # SIMPLE PATH: No message/email/category filter - paginate directly from DB
        if not has_message_filter and not search_email and not has_category_filter:
            return await _browse_threads_simple(
                client, pagination_params, date_from, date_to, sort_by, sort_order
            )
        
        # FILTERED PATH: Need to check message counts, email, or category
        return await _browse_threads_filtered(
            client, pagination_params, min_messages, max_messages,
            search_email, category, date_from, date_to, sort_by, sort_order
        )
        
    except Exception as e:
        logger.error(f"Failed to browse threads: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to retrieve threads")


async def _browse_threads_simple(
    client, params: PaginationParams, 
    date_from: Optional[str], date_to: Optional[str],
    sort_by: str, sort_order: str
) -> PaginatedResponse[ThreadAnalytics]:
    """Fast path: paginate threads directly from DB, then enrich only the page."""
    
    # Get total count for pagination
    count_query = client.from_('threads').select('thread_id', count='exact')
    if date_from:
        count_query = count_query.gte('created_at', date_from)
    if date_to:
        count_query = count_query.lte('created_at', date_to)
    count_result = await count_query.execute()
    total_count = count_result.count or 0
    
    if total_count == 0:
        return await PaginationService.paginate_with_total_count(
            items=[], total_count=0, params=params
        )
    
    # Get just this page of threads
    offset = (params.page - 1) * params.page_size
    threads_query = client.from_('threads').select(
        'thread_id, project_id, account_id, is_public, created_at, updated_at, user_message_count, total_message_count'
    )
    if date_from:
        threads_query = threads_query.gte('created_at', date_from)
    if date_to:
        threads_query = threads_query.lte('created_at', date_to)
    
    if sort_by == 'created_at':
        threads_query = threads_query.order('created_at', desc=(sort_order == 'desc'))
    elif sort_by == 'updated_at':
        threads_query = threads_query.order('updated_at', desc=(sort_order == 'desc'))
    
    threads_query = threads_query.range(offset, offset + params.page_size - 1)
    threads_result = await threads_query.execute()
    page_threads = threads_result.data or []
    
    # Enrich only these threads (15-20 max)
    result = await _enrich_threads(client, page_threads)
    
    return await PaginationService.paginate_with_total_count(
        items=result, total_count=total_count, params=params
    )


async def _browse_threads_filtered(
    client, params: PaginationParams,
    min_messages: Optional[int], max_messages: Optional[int],
    search_email: Optional[str], category: Optional[str],
    date_from: Optional[str], date_to: Optional[str],
    sort_by: str, sort_order: str
) -> PaginatedResponse[ThreadAnalytics]:
    """Filtered path: fetch threads in date range, filter by message count/email/category."""
    
    # Get threads within date range (limited scope)
    threads_query = client.from_('threads').select(
        'thread_id, project_id, account_id, is_public, created_at, updated_at, user_message_count, total_message_count'
    )
    if date_from:
        threads_query = threads_query.gte('created_at', date_from)
    if date_to:
        threads_query = threads_query.lte('created_at', date_to)
    
    if sort_by == 'created_at':
        threads_query = threads_query.order('created_at', desc=(sort_order == 'desc'))
    elif sort_by == 'updated_at':
        threads_query = threads_query.order('updated_at', desc=(sort_order == 'desc'))
    
    # Limit to reasonable number for filtering
    threads_query = threads_query.limit(1000)
    threads_result = await threads_query.execute()
    all_threads = threads_result.data or []
    
    if not all_threads:
        return await PaginationService.paginate_with_total_count(
            items=[], total_count=0, params=params
        )
    
    # Filter by category if specified (fetch project categories first)
    project_categories = {}
    if category:
        project_ids = list(set(t['project_id'] for t in all_threads if t.get('project_id')))
        if project_ids:
            projects_result = await client.from_('projects').select(
                'project_id, category'
            ).in_('project_id', project_ids).execute()
            project_categories = {p['project_id']: p.get('category', 'Other') for p in projects_result.data or []}
    
    # Filter by message count and category
    filtered_threads = []
    for thread in all_threads:
        user_msg_count = thread.get('user_message_count') or 0
        
        if min_messages is not None and user_msg_count < min_messages:
            continue
        if max_messages is not None and user_msg_count > max_messages:
            continue
        
        # Filter by category
        if category:
            thread_category = project_categories.get(thread.get('project_id'), 'Other')
            if thread_category != category:
                continue
        
        filtered_threads.append(thread)
    
    # Filter by email if specified
    if search_email:
        account_ids = list(set(t['account_id'] for t in filtered_threads if t.get('account_id')))
        if account_ids:
            emails_data = await batch_query_in(
                client=client,
                table_name='billing_customers',
                select_fields='account_id, email',
                in_field='account_id',
                in_values=account_ids,
                schema='basejump'
            )
            account_emails = {e['account_id']: e['email'] for e in emails_data}
            
            search_lower = search_email.lower()
            filtered_threads = [
                t for t in filtered_threads
                if t.get('account_id') and 
                   account_emails.get(t['account_id'], '').lower().find(search_lower) >= 0
            ]
    
    total_count = len(filtered_threads)
    
    # Paginate
    offset = (params.page - 1) * params.page_size
    page_threads = filtered_threads[offset:offset + params.page_size]
    
    # Enrich only this page
    result = await _enrich_threads(client, page_threads)
    
    return await PaginationService.paginate_with_total_count(
        items=result, total_count=total_count, params=params
    )


async def _enrich_threads(client, threads: List[Dict]) -> List[ThreadAnalytics]:
    """Enrich a small list of threads with message counts, emails, project names."""
    if not threads:
        return []
    
    thread_ids = [t['thread_id'] for t in threads]
    account_ids = list(set(t['account_id'] for t in threads if t.get('account_id')))
    project_ids = list(set(t['project_id'] for t in threads if t.get('project_id')))
    
    # Counts are now stored directly on threads table (user_message_count, total_message_count)
    # No need for separate count queries - just use the values from threads
    thread_user_counts = {t['thread_id']: t.get('user_message_count', 0) or 0 for t in threads}
    thread_total_counts = {t['thread_id']: t.get('total_message_count', 0) or 0 for t in threads}
    
    # Run all enrichment queries in parallel for better latency
    threads_with_user_msgs = [tid for tid, count in thread_user_counts.items() if count > 0]
    
    # Build parallel tasks
    async def fetch_messages():
        if not threads_with_user_msgs:
            return []
        result = await client.from_('messages').select(
            'thread_id, content'
        ).in_('thread_id', threads_with_user_msgs).eq('type', 'user').order('created_at', desc=False).execute()
        return result.data or []
    
    async def fetch_emails():
        if not account_ids:
            return []
        result = await client.schema('basejump').from_('billing_customers').select(
            'account_id, email'
        ).in_('account_id', account_ids).execute()
        return result.data or []
    
    async def fetch_projects():
        if not project_ids:
            return []
        result = await client.from_('projects').select(
            'project_id, name, category'
        ).in_('project_id', project_ids).execute()
        return result.data or []
    
    # Execute all queries in parallel
    messages_data, emails_data, projects_data = await asyncio.gather(
        fetch_messages(),
        fetch_emails(),
        fetch_projects()
    )
    
    # Process results
    thread_first_messages = {}
    for msg in messages_data:
        tid = msg['thread_id']
        if tid not in thread_first_messages:
            content = msg.get('content', {})
            if isinstance(content, dict):
                thread_first_messages[tid] = content.get('content', '')
            elif isinstance(content, str):
                thread_first_messages[tid] = content
    
    account_emails = {e['account_id']: e['email'] for e in emails_data}
    
    project_names = {}
    project_categories = {}
    for p in projects_data:
        project_names[p['project_id']] = p['name']
        project_categories[p['project_id']] = p.get('category', 'Other')
    
    # Build result
    result = []
    for thread in threads:
        tid = thread['thread_id']
        first_msg = thread_first_messages.get(tid, '')
        result.append(ThreadAnalytics(
            thread_id=tid,
            project_id=thread.get('project_id'),
            project_name=project_names.get(thread.get('project_id')),
            project_category=project_categories.get(thread.get('project_id')),
            account_id=thread.get('account_id'),
            user_email=account_emails.get(thread.get('account_id')),
            message_count=thread_total_counts.get(tid, 0),
            user_message_count=thread_user_counts.get(tid, 0),
            first_user_message=first_msg[:500] if first_msg else None,
            first_message_summary=None,
            created_at=datetime.fromisoformat(thread['created_at'].replace('Z', '+00:00')),
            updated_at=datetime.fromisoformat(thread['updated_at'].replace('Z', '+00:00')),
            is_public=thread.get('is_public', False)
        ))
    
    return result


@router.get("/retention")
async def get_retention_data(
    page: int = Query(1, ge=1, description="Page number"),
    page_size: int = Query(20, ge=1, le=100, description="Items per page"),
    weeks_back: int = Query(4, ge=1, le=12, description="Weeks to analyze"),
    min_weeks_active: int = Query(2, ge=1, description="Minimum weeks active to be considered recurring"),
    admin: dict = Depends(require_admin)
) -> PaginatedResponse[RetentionData]:
    """Get retention data showing recurring users."""
    try:
        db = DBConnection()
        client = await db.client
        
        pagination_params = PaginationParams(page=page, page_size=page_size)
        
        now = datetime.now(timezone.utc)
        start_date = now - timedelta(weeks=weeks_back)
        
        # Get all threads in the period
        threads_result = await client.from_('threads').select(
            'account_id, created_at, updated_at'
        ).gte('created_at', start_date.isoformat()).execute()
        
        # Calculate activity by user by week
        user_weeks = {}  # account_id -> set of week numbers
        user_first_activity = {}
        user_last_activity = {}
        user_thread_counts = {}
        
        for thread in threads_result.data or []:
            account_id = thread.get('account_id')
            if not account_id:
                continue
            
            created = datetime.fromisoformat(thread['created_at'].replace('Z', '+00:00'))
            updated = datetime.fromisoformat(thread['updated_at'].replace('Z', '+00:00'))
            
            week_num = (created - start_date).days // 7
            
            if account_id not in user_weeks:
                user_weeks[account_id] = set()
                user_first_activity[account_id] = created
                user_last_activity[account_id] = updated
                user_thread_counts[account_id] = 0
            
            user_weeks[account_id].add(week_num)
            user_thread_counts[account_id] += 1
            
            if created < user_first_activity[account_id]:
                user_first_activity[account_id] = created
            if updated > user_last_activity[account_id]:
                user_last_activity[account_id] = updated
        
        # Filter to recurring users
        recurring_users = [
            uid for uid, weeks in user_weeks.items()
            if len(weeks) >= min_weeks_active
        ]
        
        # Sort by weeks active descending BEFORE pagination
        recurring_users.sort(key=lambda uid: len(user_weeks[uid]), reverse=True)
        
        total_count = len(recurring_users)
        
        # Paginate
        offset = (pagination_params.page - 1) * pagination_params.page_size
        paginated_users = recurring_users[offset:offset + pagination_params.page_size]
        
        # Get user emails
        user_emails = {}
        if paginated_users:
            emails_result = await client.schema('basejump').from_('billing_customers').select(
                'account_id, email'
            ).in_('account_id', paginated_users).execute()
            
            for e in emails_result.data or []:
                user_emails[e['account_id']] = e['email']
        
        # Build response
        result = []
        for uid in paginated_users:
            result.append(RetentionData(
                user_id=uid,
                email=user_emails.get(uid),
                first_activity=user_first_activity[uid],
                last_activity=user_last_activity[uid],
                total_threads=user_thread_counts[uid],
                weeks_active=len(user_weeks[uid]),
                is_recurring=True
            ))
        
        return await PaginationService.paginate_with_total_count(
            items=result,
            total_count=total_count,
            params=pagination_params
        )
        
    except Exception as e:
        logger.error(f"Failed to get retention data: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to retrieve retention data")


@router.post("/translate")
async def translate_text(
    request: TranslateRequest,
    admin: dict = Depends(require_admin)
) -> Dict[str, str]:
    """Translate text to target language using OpenAI."""
    text = request.text
    target_language = request.target_language
    if len(text) > 5000:
        raise HTTPException(status_code=400, detail="Text too long (max 5000 characters)")

    try:
        openai_client = await get_openai_client()

        response = await openai_client.chat.completions.create(
            model="gpt-5-mini",
            messages=[
                {
                    "role": "system",
                    "content": f"""You are a translator. Translate the user's message to {target_language}.

Rules:
- If the text is already in {target_language}, return it as-is
- Preserve the original meaning and intent
- Only output the translated text, nothing else
- Do not add explanations or notes"""
                },
                {
                    "role": "user",
                    "content": text
                }
            ],
        )

        return {
            "original": text,
            "translated": response.choices[0].message.content.strip(),
            "target_language": target_language
        }

    except Exception as e:
        logger.error(f"Failed to translate text: {e}")
        raise HTTPException(status_code=500, detail="Failed to translate text")


@router.get("/threads/message-distribution")
async def get_message_distribution(
    date: Optional[str] = Query(None, description="Date in YYYY-MM-DD format, defaults to today"),
    admin: dict = Depends(require_admin)
) -> Dict[str, Any]:
    """Get distribution of threads by user message count for a specific day."""
    try:
        db = DBConnection()
        client = await db.client
        
        # Parse date or default to today
        if date:
            try:
                selected_date = datetime.strptime(date, "%Y-%m-%d").replace(tzinfo=timezone.utc)
            except ValueError:
                raise HTTPException(status_code=400, detail="Invalid date format. Use YYYY-MM-DD")
        else:
            selected_date = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
        
        # Filter to selected day (start of day to end of day)
        start_of_day = selected_date.replace(hour=0, minute=0, second=0, microsecond=0).isoformat()
        end_of_day = selected_date.replace(hour=23, minute=59, second=59, microsecond=999999).isoformat()
        
        # Single query - user_message_count is now a column on threads table
        threads_result = await client.from_('threads').select(
            'user_message_count'
        ).gte('created_at', start_of_day).lte('created_at', end_of_day).limit(50000).execute()
        threads = threads_result.data or []
        
        if not threads:
            return {
                "distribution": {
                    "0_messages": 0,
                    "1_message": 0,
                    "2_3_messages": 0,
                    "5_plus_messages": 0
                },
                "total_threads": 0
            }
        
        # Calculate distribution from the column values
        distribution = {
            "0_messages": 0,
            "1_message": 0,
            "2_3_messages": 0,
            "5_plus_messages": 0
        }
        
        for thread in threads:
            count = thread.get('user_message_count') or 0
            if count == 0:
                distribution["0_messages"] += 1
            elif count == 1:
                distribution["1_message"] += 1
            elif count <= 3:
                distribution["2_3_messages"] += 1
            elif count >= 5:
                distribution["5_plus_messages"] += 1
            # count == 4 is intentionally not categorized
        
        return {
            "distribution": distribution,
            "total_threads": len(threads)
        }
        
    except Exception as e:
        logger.error(f"Failed to get message distribution: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to get message distribution")


@router.get("/projects/category-distribution")
async def get_category_distribution(
    date: Optional[str] = Query(None, description="Date in YYYY-MM-DD format, defaults to today"),
    admin: dict = Depends(require_admin)
) -> Dict[str, Any]:
    """Get distribution of projects by category for a specific day."""
    try:
        db = DBConnection()
        client = await db.client
        
        # Parse date or default to today
        if date:
            try:
                selected_date = datetime.strptime(date, "%Y-%m-%d").replace(tzinfo=timezone.utc)
            except ValueError:
                raise HTTPException(status_code=400, detail="Invalid date format. Use YYYY-MM-DD")
        else:
            selected_date = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
        
        # Filter to selected day
        start_of_day = selected_date.replace(hour=0, minute=0, second=0, microsecond=0).isoformat()
        end_of_day = selected_date.replace(hour=23, minute=59, second=59, microsecond=999999).isoformat()
        
        # Query projects created on the selected day
        projects_result = await client.from_('projects').select(
            'category'
        ).gte('created_at', start_of_day).lte('created_at', end_of_day).limit(50000).execute()
        projects = projects_result.data or []
        
        if not projects:
            return {
                "distribution": {},
                "total_projects": 0,
                "date": date or selected_date.strftime("%Y-%m-%d")
            }
        
        # Calculate distribution
        distribution = {}
        for project in projects:
            category = project.get('category') or 'Uncategorized'
            distribution[category] = distribution.get(category, 0) + 1
        
        # Sort by count descending
        sorted_distribution = dict(sorted(distribution.items(), key=lambda x: x[1], reverse=True))
        
        return {
            "distribution": sorted_distribution,
            "total_projects": len(projects),
            "date": date or selected_date.strftime("%Y-%m-%d")
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to get category distribution: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to get category distribution")
