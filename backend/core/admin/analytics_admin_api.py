"""
Analytics Admin API
Provides analytics data for the admin dashboard including:
- Daily/Weekly signups, subscriptions, conversion rates
- Thread analytics with message count filters
- AI-powered thread summarization
- Retention metrics
"""

from fastapi import APIRouter, HTTPException, Depends, Query
from typing import Optional, List, Dict, Any, Literal
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from pydantic import BaseModel
import asyncio
import httpx
import json
import os
from core.auth import require_admin, require_super_admin
from core.services.supabase import DBConnection
from core.utils.logger import logger
from core.utils.pagination import PaginationService, PaginationParams, PaginatedResponse
from core.utils.config import config
from core.utils.query_utils import batch_query_in
import openai
import stripe

# Google Analytics imports
try:
    from google.analytics.data_v1beta import BetaAnalyticsDataClient
    from google.analytics.data_v1beta.types import (
        RunReportRequest,
        DateRange,
        Dimension,
        Metric,
        FilterExpression,
        Filter,
    )
    from google.oauth2 import service_account
    GA_AVAILABLE = True
except ImportError:
    GA_AVAILABLE = False
    logger.warning("Google Analytics SDK not installed. Install with: pip install google-analytics-data")

# Berlin timezone for consistent date handling (UTC+1 / UTC+2 with DST)
BERLIN_TZ = ZoneInfo("Europe/Berlin")

router = APIRouter(prefix="/admin/analytics", tags=["admin-analytics"])


# ============================================================================
# MODELS
# ============================================================================

class ThreadAnalytics(BaseModel):
    thread_id: str
    project_id: Optional[str] = None
    project_name: Optional[str] = None
    project_categories: Optional[List[str]] = None  # Changed to array
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
    active_users_week: int
    new_signups_today: int
    new_signups_week: int
    conversion_rate_week: float
    avg_threads_per_user: float


class TranslateRequest(BaseModel):
    text: str
    target_language: str = "English"


class VisitorStats(BaseModel):
    total_visitors: int
    unique_visitors: int
    pageviews: int
    date: str


class ConversionFunnel(BaseModel):
    visitors: int
    signups: int
    subscriptions: int
    # Breakdown by platform (clickable to see emails)
    web_subscriber_emails: List[str] = []
    app_subscriber_emails: List[str] = []
    visitor_to_signup_rate: float
    signup_to_subscription_rate: float
    overall_conversion_rate: float
    date: str


class ActivationStats(BaseModel):
    """Signup activation stats: how many free signups tried tasks + distribution."""
    total_signups: int
    activated_signups: int
    activation_rate: float  # Percentage (0-100)
    distribution: Dict[str, int]  # {"0": 5078, "1": 4091, "2-5": 5356, "6-10": 1156, "10+": 659}
    date: str


class UserFunnelStats(BaseModel):
    """Full user funnel: Signup → Tried Task → Viewed Pricing → Clicked Checkout → Converted."""
    total_signups: int
    tried_task: int
    tried_task_rate: float  # % of signups who tried
    viewed_pricing: int  # Users who viewed pricing (from database)
    viewed_pricing_rate: float  # % of signups who viewed pricing
    tried_and_viewed: int  # Users who both tried task AND viewed pricing
    tried_and_viewed_rate: float
    clicked_checkout: int  # Users who clicked subscribe/checkout button
    clicked_checkout_rate: float  # % of signups who clicked checkout
    converted: int
    conversion_rate: float  # % of signups who converted
    # Detailed breakdown
    tried_then_viewed_rate: float  # % of tried users who viewed pricing
    viewed_then_clicked_rate: float  # % of pricing viewers who clicked checkout
    clicked_then_converted_rate: float  # % of checkout clickers who converted
    # Other users (signed up before date range but took action in date range)
    other_clicked_checkout: int  # Users who signed up earlier but clicked checkout in this period
    date_from: str
    date_to: str


# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

def parse_date_range(
    date: Optional[str],
    date_from: Optional[str],
    date_to: Optional[str]
) -> tuple[datetime, datetime]:
    """
    Parse date range parameters with backwards compatibility.

    Args:
        date: Legacy single date parameter (deprecated)
        date_from: Start date in YYYY-MM-DD format
        date_to: End date in YYYY-MM-DD format

    Returns:
        Tuple of (start_date, end_date) as datetime objects with Berlin timezone

    If only 'date' is provided, uses it for both start and end (single day).
    If no dates provided, defaults to today.
    """
    # Backwards compatibility: if 'date' is provided without date_from/date_to
    if date and not date_from:
        date_from = date
        date_to = date

    # Parse start date or default to today
    if date_from:
        try:
            start_date = datetime.strptime(date_from, "%Y-%m-%d").replace(tzinfo=BERLIN_TZ)
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid date_from format. Use YYYY-MM-DD")
    else:
        start_date = datetime.now(BERLIN_TZ).replace(hour=0, minute=0, second=0, microsecond=0)

    # Parse end date or use start date (single day)
    if date_to:
        try:
            end_date = datetime.strptime(date_to, "%Y-%m-%d").replace(tzinfo=BERLIN_TZ)
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid date_to format. Use YYYY-MM-DD")
    else:
        end_date = start_date

    # Ensure start <= end
    if start_date > end_date:
        raise HTTPException(status_code=400, detail="date_from must be before or equal to date_to")

    return start_date, end_date


async def get_openai_client():
    """Get OpenAI client for summarization."""
    api_key = config.OPENAI_API_KEY
    if not api_key:
        raise HTTPException(status_code=500, detail="OpenAI API key not configured")
    return openai.AsyncOpenAI(api_key=api_key)


def get_ga_client() -> "BetaAnalyticsDataClient":
    """Get Google Analytics client with service account credentials."""
    if not GA_AVAILABLE:
        raise HTTPException(
            status_code=500,
            detail="Google Analytics SDK not installed. Install with: pip install google-analytics-data"
        )
    
    credentials_json = config.GA_CREDENTIALS_JSON
    if not credentials_json:
        raise HTTPException(
            status_code=500,
            detail="Google Analytics not configured. Set GA_CREDENTIALS_JSON environment variable."
        )
    
    # Check if it's a file path or JSON string
    if os.path.isfile(credentials_json):
        credentials = service_account.Credentials.from_service_account_file(credentials_json)
    else:
        # Parse as JSON string
        try:
            credentials_info = json.loads(credentials_json)
            credentials = service_account.Credentials.from_service_account_info(credentials_info)
        except json.JSONDecodeError:
            raise HTTPException(
                status_code=500,
                detail="Invalid GA_CREDENTIALS_JSON: must be valid JSON or a file path"
            )
    
    return BetaAnalyticsDataClient(credentials=credentials)


async def search_paid_subscriptions(start_date: datetime, end_date: datetime, include_emails: bool = False) -> Dict[str, Any]:
    """
    Search Stripe for active paid subscriptions created within a date range.
    Excludes free tier subscriptions using metadata filter.
    
    Args:
        start_date: Start of the date range (inclusive)
        end_date: End of the date range (inclusive)
        include_emails: If True, also fetch customer emails (requires expand)
    
    Returns:
        Dict with 'count' and optionally 'emails' list
    """
    try:
        # Ensure stripe API key is set
        stripe.api_key = config.STRIPE_SECRET_KEY
        
        # Convert to Unix timestamps for Stripe Search API
        start_ts = int(start_date.timestamp())
        end_ts = int(end_date.timestamp())
        
        # Build search query:
        # - status:'active' - only active subscriptions
        # - -metadata['tier']:'free' - exclude free tier subscriptions
        # - created>=start_ts AND created<=end_ts - within date range
        query = f"status:'active' AND -metadata['tier']:'free' AND created>={start_ts} AND created<={end_ts}"
        
        count = 0
        emails: List[str] = []
        has_more = True
        next_page = None
        
        while has_more:
            search_params = {
                'query': query,
                'limit': 100,  # Max allowed by Stripe
            }
            if next_page:
                search_params['page'] = next_page
            
            # Expand customer to get email if needed
            if include_emails:
                search_params['expand'] = ['data.customer']
            
            result = await stripe.Subscription.search_async(**search_params)
            count += len(result.data)
            
            # Extract emails from expanded customer objects
            if include_emails:
                for sub in result.data:
                    customer = sub.customer
                    if customer and hasattr(customer, 'email') and customer.email:
                        emails.append(customer.email)
            
            has_more = result.has_more
            next_page = result.next_page if has_more else None
        
        logger.debug(f"Stripe subscription search: found {count} paid subscriptions between {start_date} and {end_date}")
        return {'count': count, 'emails': emails}
        
    except stripe.error.StripeError as e:
        logger.error(f"Stripe error searching subscriptions: {e}", exc_info=True)
        return {'count': 0, 'emails': []}
    except Exception as e:
        logger.error(f"Error searching Stripe subscriptions: {e}", exc_info=True)
        return {'count': 0, 'emails': []}


def query_google_analytics(date_str: str) -> Dict[str, int]:
    """
    Query Google Analytics for visitor stats on a specific date.
    Returns dict with 'pageviews' and 'unique_visitors'.
    """
    property_id = config.GA_PROPERTY_ID
    if not property_id:
        raise HTTPException(
            status_code=500,
            detail="Google Analytics not configured. Set GA_PROPERTY_ID environment variable."
        )
    
    client = get_ga_client()
    
    # Build the request - no hostname filter needed (dedicated kortix property)
    request = RunReportRequest(
        property=f"properties/{property_id}",
        date_ranges=[DateRange(start_date=date_str, end_date=date_str)],
        metrics=[
            Metric(name="screenPageViews"),
            Metric(name="newUsers"),
        ],
    )
    
    response = client.run_report(request)
    
    # Extract results
    pageviews = 0
    unique_visitors = 0
    
    if response.rows:
        row = response.rows[0]
        pageviews = int(row.metric_values[0].value) if row.metric_values else 0
        unique_visitors = int(row.metric_values[1].value) if len(row.metric_values) > 1 else 0
    
    return {
        "pageviews": pageviews,
        "unique_visitors": unique_visitors
    }


async def query_vercel_analytics(date_str: str) -> Dict[str, int]:
    """
    Query Vercel Analytics from our database (populated via drains).
    Returns dict with 'pageviews' and 'unique_visitors'.
    """
    try:
        db = DBConnection()
        client = await db.client
        
        result = await client.rpc('get_vercel_analytics', {
            'target_date': date_str
        }).execute()
        
        if result.data and len(result.data) > 0:
            row = result.data[0]
            return {
                "pageviews": row.get('pageviews', 0) or 0,
                "unique_visitors": row.get('unique_visitors', 0) or 0
            }
        
        return {"pageviews": 0, "unique_visitors": 0}
        
    except Exception as e:
        logger.error(f"Failed to query Vercel analytics: {e}", exc_info=True)
        return {"pageviews": 0, "unique_visitors": 0}


async def query_vercel_analytics_range(start_date: str, end_date: str) -> Dict[str, int]:
    """
    Query Vercel Analytics for a date range (for ARR views endpoint).
    Returns dict mapping date -> unique_visitors count.
    """
    try:
        db = DBConnection()
        client = await db.client
        
        result = await client.rpc('get_vercel_analytics_range', {
            'start_date': start_date,
            'end_date': end_date
        }).execute()
        
        views_by_date: Dict[str, int] = {}
        total = 0
        
        for row in result.data or []:
            date = row.get('analytics_date')
            unique_visitors = row.get('unique_visitors', 0) or 0
            if date:
                views_by_date[date] = unique_visitors
                total += unique_visitors
        
        return views_by_date, total
        
    except Exception as e:
        logger.error(f"Failed to query Vercel analytics range: {e}", exc_info=True)
        return {}, 0


# Analytics source type
AnalyticsSource = Literal["vercel", "ga"]


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
        
        now = datetime.now(BERLIN_TZ)
        today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        week_start = today_start - timedelta(days=7)
        
        # Run only necessary queries in parallel
        (
            total_users_result,
            total_threads_result,
            active_week_result,
            signups_today_result,
            signups_week_result,
            subs_result,
        ) = await asyncio.gather(
            client.schema('basejump').from_('accounts').select('id', count='exact').limit(1).execute(),
            client.from_('threads').select('thread_id', count='exact').limit(1).execute(),
            # Use RPC for COUNT(DISTINCT) - don't fetch rows in Python
            client.rpc('get_active_users_week', {'p_week_start': week_start.isoformat()}).execute(),
            client.schema('basejump').from_('accounts').select('id', count='exact').gte('created_at', today_start.isoformat()).limit(1).execute(),
            client.schema('basejump').from_('accounts').select('id', count='exact').gte('created_at', week_start.isoformat()).limit(1).execute(),
            # Use Stripe directly to count paid subscriptions (excludes free tier)
            search_paid_subscriptions(week_start, now, include_emails=False),
        )
        
        total_users = total_users_result.count or 0
        total_threads = total_threads_result.count or 0
        active_users_week = active_week_result.data[0]['count'] if active_week_result.data else 0
        new_signups_today = signups_today_result.count or 0
        new_signups_week = signups_week_result.count or 0
        # Extract count from search_paid_subscriptions result
        new_subscriptions_week = subs_result['count'] if isinstance(subs_result, dict) else 0
        
        # Conversion rate
        conversion_rate_week = (new_subscriptions_week / new_signups_week * 100) if new_signups_week > 0 else 0
        
        # Average threads per user
        avg_threads_per_user = (total_threads / total_users) if total_users > 0 else 0
        
        return AnalyticsSummary(
            total_users=total_users,
            total_threads=total_threads,
            active_users_week=active_users_week,
            new_signups_today=new_signups_today,
            new_signups_week=new_signups_week,
            conversion_rate_week=round(conversion_rate_week, 2),
            avg_threads_per_user=round(avg_threads_per_user, 2)
        )
        
    except Exception as e:
        logger.error(f"Failed to get analytics summary: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to retrieve analytics summary")


@router.get("/threads/browse")
async def browse_threads(
    page: int = Query(1, ge=1, description="Page number"),
    page_size: int = Query(20, ge=1, le=100, description="Items per page"),
    min_messages: Optional[int] = Query(None, description="Minimum user messages"),
    max_messages: Optional[int] = Query(None, description="Maximum user messages"),
    search_email: Optional[str] = Query(None, description="Filter by user email"),
    category: Optional[str] = Query(None, description="Filter by project category"),
    tier: Optional[str] = Query(None, description="Filter by subscription tier"),
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
        has_tier_filter = tier is not None
        
        # EMAIL SEARCH PATH: Query threads directly by account_id (no limit)
        # This must come first to avoid the 1000 thread limit in filtered path
        if search_email:
            return await _browse_threads_by_email(
                client, pagination_params, search_email,
                min_messages, max_messages, date_from, date_to, sort_by, sort_order
            )
        
        # If filtering by message count, category, or tier without date range, default to last 7 days
        if (has_message_filter or has_category_filter or has_tier_filter) and not date_from:
            date_from = (datetime.now(BERLIN_TZ) - timedelta(days=7)).strftime('%Y-%m-%d')
        
        # SIMPLE PATH: No message/email/category/tier filter - paginate directly from DB
        if not has_message_filter and not has_category_filter and not has_tier_filter:
            return await _browse_threads_simple(
                client, pagination_params, date_from, date_to, sort_by, sort_order
            )
        
        # FILTERED PATH: Need to check message counts, category, or tier
        return await _browse_threads_filtered(
            client, pagination_params, min_messages, max_messages,
            None, category, tier, date_from, date_to, sort_by, sort_order  # search_email already handled above
        )
        
    except Exception as e:
        logger.error(f"Failed to browse threads: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to retrieve threads")


async def _browse_threads_by_email(
    client, params: PaginationParams, search_email: str,
    min_messages: Optional[int], max_messages: Optional[int],
    date_from: Optional[str], date_to: Optional[str],
    sort_by: str, sort_order: str
) -> PaginatedResponse[ThreadAnalytics]:
    """Email search path: Find account by email, then query ALL threads for that account."""
    
    # First, find the account_id for this email using auth.users
    try:
        account_result = await client.rpc('get_user_account_by_email', {'email_input': search_email}).execute()
        if not account_result.data:
            # No user found with this email
            return await PaginationService.paginate_with_total_count(
                items=[], total_count=0, params=params
            )
        
        target_account_id = account_result.data.get('id')
        if not target_account_id:
            return await PaginationService.paginate_with_total_count(
                items=[], total_count=0, params=params
            )
    except Exception as e:
        logger.warning(f"Failed to find account by email '{search_email}': {e}")
        return await PaginationService.paginate_with_total_count(
            items=[], total_count=0, params=params
        )
    
    # Build query for threads by this account (no arbitrary limit!)
    base_query = client.from_('threads').select(
        'thread_id, project_id, account_id, is_public, created_at, updated_at, user_message_count, total_message_count'
    ).eq('account_id', target_account_id)
    
    if date_from:
        base_query = base_query.gte('created_at', date_from)
    if date_to:
        base_query = base_query.lte('created_at', date_to)
    
    # Apply message count filters if specified
    if min_messages is not None:
        base_query = base_query.gte('user_message_count', min_messages)
    if max_messages is not None:
        base_query = base_query.lte('user_message_count', max_messages)
    
    # Get total count for this user
    count_query = client.from_('threads').select('thread_id', count='exact').eq('account_id', target_account_id)
    if date_from:
        count_query = count_query.gte('created_at', date_from)
    if date_to:
        count_query = count_query.lte('created_at', date_to)
    if min_messages is not None:
        count_query = count_query.gte('user_message_count', min_messages)
    if max_messages is not None:
        count_query = count_query.lte('user_message_count', max_messages)
    
    count_result = await count_query.execute()
    total_count = count_result.count or 0
    
    if total_count == 0:
        return await PaginationService.paginate_with_total_count(
            items=[], total_count=0, params=params
        )
    
    # Get paginated threads for this user
    offset = (params.page - 1) * params.page_size
    
    if sort_by == 'created_at':
        base_query = base_query.order('created_at', desc=(sort_order == 'desc'))
    elif sort_by == 'updated_at':
        base_query = base_query.order('updated_at', desc=(sort_order == 'desc'))
    
    base_query = base_query.range(offset, offset + params.page_size - 1)
    threads_result = await base_query.execute()
    page_threads = threads_result.data or []
    
    # Enrich and return
    result = await _enrich_threads(client, page_threads)
    
    return await PaginationService.paginate_with_total_count(
        items=result, total_count=total_count, params=params
    )


async def _browse_threads_simple(
    client, params: PaginationParams,
    date_from: Optional[str], date_to: Optional[str],
    sort_by: str, sort_order: str
) -> PaginatedResponse[ThreadAnalytics]:
    """Fast path: paginate threads directly from DB, then enrich only the page."""

    # Convert date parameters to Berlin timezone (same as _browse_threads_filtered)
    date_from_param = None
    date_to_param = None

    if date_from:
        from_dt = datetime.strptime(date_from, "%Y-%m-%d").replace(tzinfo=BERLIN_TZ) if 'T' not in date_from else datetime.fromisoformat(date_from)
        date_from_param = from_dt.replace(hour=0, minute=0, second=0, microsecond=0).isoformat()
    if date_to:
        to_dt = datetime.strptime(date_to, "%Y-%m-%d").replace(tzinfo=BERLIN_TZ) if 'T' not in date_to else datetime.fromisoformat(date_to)
        date_to_param = to_dt.replace(hour=23, minute=59, second=59, microsecond=999999).isoformat()

    # Get total count for pagination
    count_query = client.from_('threads').select('thread_id', count='exact')
    if date_from_param:
        count_query = count_query.gte('created_at', date_from_param)
    if date_to_param:
        count_query = count_query.lte('created_at', date_to_param)
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
    if date_from_param:
        threads_query = threads_query.gte('created_at', date_from_param)
    if date_to_param:
        threads_query = threads_query.lte('created_at', date_to_param)
    
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
    tier: Optional[str],
    date_from: Optional[str], date_to: Optional[str],
    sort_by: str, sort_order: str
) -> PaginatedResponse[ThreadAnalytics]:
    """Filtered path: fetch threads with optional category/tier/date filtering using JOINs."""
    
    # Build date parameters for RPC using Berlin timezone
    date_from_param = None
    date_to_param = None
    
    if date_from:
        from_dt = datetime.strptime(date_from, "%Y-%m-%d").replace(tzinfo=BERLIN_TZ) if 'T' not in date_from else datetime.fromisoformat(date_from)
        date_from_param = from_dt.replace(hour=0, minute=0, second=0, microsecond=0).isoformat()
    if date_to:
        to_dt = datetime.strptime(date_to, "%Y-%m-%d").replace(tzinfo=BERLIN_TZ) if 'T' not in date_to else datetime.fromisoformat(date_to)
        date_to_param = to_dt.replace(hour=23, minute=59, second=59, microsecond=999999).isoformat()
    
    # Calculate offset for pagination
    offset = (params.page - 1) * params.page_size
    
    # COMBINED TIER + CATEGORY FILTER PATH: Use combined RPC function
    # Handles tier only, category only, or both together
    if tier or category:
        # Get total count first for pagination
        count_params = {
            'p_tier': tier,
            'p_category': category,
            'p_date_from': date_from_param,
            'p_date_to': date_to_param,
            'p_min_messages': min_messages,
            'p_max_messages': max_messages
        }
        count_result = await client.rpc('get_threads_by_tier_and_category_count', count_params).execute()
        total_count = count_result.data if isinstance(count_result.data, int) else 0
        
        # Get only the page of threads we need
        rpc_params = {
            'p_tier': tier,
            'p_category': category,
            'p_date_from': date_from_param,
            'p_date_to': date_to_param,
            'p_min_messages': min_messages,
            'p_max_messages': max_messages,
            'p_sort_by': sort_by,
            'p_sort_order': sort_order,
            'p_limit': params.page_size,
            'p_offset': offset
        }
        
        result = await client.rpc('get_threads_by_tier_and_category', rpc_params).execute()
        page_threads = result.data or []
        
        filter_desc = f"tier={tier}" if tier else ""
        if category:
            filter_desc += f"{', ' if filter_desc else ''}category={category}"
        logger.debug(f"Combined filter via RPC: {filter_desc}, page={params.page}, fetched {len(page_threads)} of {total_count} total")
        
        # Enrich threads with project/user data and return directly
        enriched_threads = await _enrich_threads(client, page_threads)
        
        return await PaginationService.paginate_with_total_count(
            items=enriched_threads, total_count=total_count, params=params
        )
    
    else:
        # No category/tier filter - message-only filter path
        # Apply all filters directly in DB query for accuracy

        # Build base query with all filters
        threads_query = client.from_('threads').select(
            'thread_id, project_id, account_id, is_public, created_at, updated_at, user_message_count, total_message_count'
        )
        # Use properly formatted ISO dates with timezone (same as distribution endpoint)
        if date_from_param:
            threads_query = threads_query.gte('created_at', date_from_param)
        if date_to_param:
            threads_query = threads_query.lte('created_at', date_to_param)

        # Apply message count filters directly in DB (not Python)
        if min_messages is not None:
            threads_query = threads_query.gte('user_message_count', min_messages)
        if max_messages is not None:
            threads_query = threads_query.lte('user_message_count', max_messages)

        # Get total count with same filters
        count_query = client.from_('threads').select('thread_id', count='exact')
        if date_from_param:
            count_query = count_query.gte('created_at', date_from_param)
        if date_to_param:
            count_query = count_query.lte('created_at', date_to_param)
        if min_messages is not None:
            count_query = count_query.gte('user_message_count', min_messages)
        if max_messages is not None:
            count_query = count_query.lte('user_message_count', max_messages)

        count_result = await count_query.execute()
        total_count = count_result.count or 0

        if total_count == 0:
            return await PaginationService.paginate_with_total_count(
                items=[], total_count=0, params=params
            )

        # Apply sorting
        if sort_by == 'created_at':
            threads_query = threads_query.order('created_at', desc=(sort_order == 'desc'))
        elif sort_by == 'updated_at':
            threads_query = threads_query.order('updated_at', desc=(sort_order == 'desc'))

        # Apply pagination in DB
        threads_query = threads_query.range(offset, offset + params.page_size - 1)
        threads_result = await threads_query.execute()
        page_threads = threads_result.data or []

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
            return {}
        
        # First try billing_customers (fast path for users with billing)
        billing_result = await client.schema('basejump').from_('billing_customers').select(
            'account_id, email'
        ).in_('account_id', account_ids).execute()
        
        account_emails = {e['account_id']: e['email'] for e in (billing_result.data or [])}
        
        # For accounts without billing email, get from auth.users via RPC
        missing_account_ids = [aid for aid in account_ids if aid not in account_emails]
        if missing_account_ids:
            # Get primary_owner_user_id for missing accounts
            accounts_result = await client.schema('basejump').from_('accounts').select(
                'id, primary_owner_user_id'
            ).in_('id', missing_account_ids).execute()
            
            for acc in (accounts_result.data or []):
                if acc.get('primary_owner_user_id'):
                    try:
                        email_result = await client.rpc('get_user_email', {'user_id': acc['primary_owner_user_id']}).execute()
                        if email_result.data:
                            account_emails[acc['id']] = email_result.data
                    except Exception as e:
                        logger.debug(f"Could not get email for account {acc['id']}: {e}")
        
        return account_emails
    
    async def fetch_projects():
        if not project_ids:
            return []
        result = await client.from_('projects').select(
            'project_id, name, categories'
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
    
    # emails_data is already a dict {account_id: email} from fetch_emails()
    account_emails = emails_data
    
    project_names = {}
    project_categories = {}
    for p in projects_data:
        project_names[p['project_id']] = p['name']
        # Use categories array, default to ['Uncategorized'] if empty
        cats = p.get('categories') or []
        project_categories[p['project_id']] = cats if cats else ['Uncategorized']
    
    # Build result
    result = []
    for thread in threads:
        tid = thread['thread_id']
        first_msg = thread_first_messages.get(tid, '')
        result.append(ThreadAnalytics(
            thread_id=tid,
            project_id=thread.get('project_id'),
            project_name=project_names.get(thread.get('project_id')),
            project_categories=project_categories.get(thread.get('project_id')),
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

        # Use RPC function to do aggregation in SQL
        rpc_result = await client.rpc('get_retention_data', {
            'p_weeks_back': weeks_back,
            'p_min_weeks_active': min_weeks_active,
            'p_page': page,
            'p_page_size': page_size
        }).execute()

        rows = rpc_result.data or []

        # Get total count from first row (all rows have same total_count)
        total_count = rows[0]['total_count'] if rows else 0

        # Build response
        result = [
            RetentionData(
                user_id=row['user_id'],
                email=row['email'],
                first_activity=datetime.fromisoformat(row['first_activity'].replace('Z', '+00:00')),
                last_activity=datetime.fromisoformat(row['last_activity'].replace('Z', '+00:00')),
                total_threads=row['total_threads'],
                weeks_active=row['weeks_active'],
                is_recurring=True
            )
            for row in rows
        ]

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
    date: Optional[str] = Query(None, description="Single date (deprecated, use date_from/date_to)"),
    date_from: Optional[str] = Query(None, description="Start date YYYY-MM-DD"),
    date_to: Optional[str] = Query(None, description="End date YYYY-MM-DD"),
    admin: dict = Depends(require_admin)
) -> Dict[str, Any]:
    """Get distribution of threads by user message count for a date range."""
    try:
        db = DBConnection()
        client = await db.client

        # Parse date range with backwards compatibility
        start_date, end_date = parse_date_range(date, date_from, date_to)

        # Convert to ISO format for queries
        start_of_range = start_date.replace(hour=0, minute=0, second=0, microsecond=0).isoformat()
        end_of_range = end_date.replace(hour=23, minute=59, second=59, microsecond=999999).isoformat()
        
        # Use database function for efficient GROUP BY aggregation (bypasses row limits)
        result = await client.rpc('get_thread_message_distribution', {
            'start_date': start_of_range,
            'end_date': end_of_range
        }).execute()
        
        if not result.data or len(result.data) == 0:
            return {
                "distribution": {
                    "0_messages": 0,
                    "1_message": 0,
                    "2_3_messages": 0,
                    "5_plus_messages": 0
                },
                "total_threads": 0
            }
        
        # Extract the aggregated results from the database function
        data = result.data[0]
        distribution = {
            "0_messages": data.get('zero_messages', 0),
            "1_message": data.get('one_message', 0),
            "2_3_messages": data.get('two_three_messages', 0),
            "5_plus_messages": data.get('five_plus_messages', 0)
        }
        
        return {
            "distribution": distribution,
            "total_threads": data.get('total_threads', 0)
        }
        
    except Exception as e:
        logger.error(f"Failed to get message distribution: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to get message distribution")


@router.get("/projects/category-distribution")
async def get_category_distribution(
    date: Optional[str] = Query(None, description="Single date (deprecated, use date_from/date_to)"),
    date_from: Optional[str] = Query(None, description="Start date YYYY-MM-DD"),
    date_to: Optional[str] = Query(None, description="End date YYYY-MM-DD"),
    tier: Optional[str] = Query(None, description="Filter by subscription tier"),
    admin: dict = Depends(require_admin)
) -> Dict[str, Any]:
    """Get distribution of projects by category for a date range, optionally filtered by tier."""
    try:
        db = DBConnection()
        client = await db.client

        # Parse date range with backwards compatibility
        start_date, end_date = parse_date_range(date, date_from, date_to)

        # Convert to ISO format for queries
        start_of_range = start_date.replace(hour=0, minute=0, second=0, microsecond=0).isoformat()
        end_of_range = end_date.replace(hour=23, minute=59, second=59, microsecond=999999).isoformat()

        # Use database function for efficient GROUP BY aggregation (bypasses row limits)
        # Build RPC params with optional tier filter
        rpc_params = {
            'start_date': start_of_range,
            'end_date': end_of_range,
            'p_tier': tier  # Will be NULL if not provided
        }

        # Build count query with optional tier filter
        count_query = client.from_('projects').select('project_id', count='exact').gte(
            'created_at', start_of_range
        ).lte('created_at', end_of_range)
        
        if tier:
            # Need to join with credit_accounts for tier filtering
            # For simplicity, we'll just use the RPC result count when tier is filtered
            pass
        
        # Run both queries in parallel
        result, count_result = await asyncio.gather(
            client.rpc('get_project_category_distribution', rpc_params).execute(),
            count_query.limit(1).execute() if not tier else asyncio.sleep(0)  # Skip count query if tier filter
        )
        
        if not result.data:
            return {
                "distribution": {},
                "total_projects": 0,
                "date": start_date.strftime("%Y-%m-%d"),
                "date_from": start_date.strftime("%Y-%m-%d"),
                "date_to": end_date.strftime("%Y-%m-%d"),
                "tier": tier
            }
        
        # Build distribution from aggregated results
        distribution = {}
        total_from_distribution = 0
        for row in result.data:
            category = row.get('category', 'Uncategorized')
            count = row.get('count', 0)
            distribution[category] = count
            total_from_distribution += count
        
        # Use actual distinct project count when no tier filter, otherwise use sum from distribution
        if tier:
            # When tier filter is applied, sum the distribution counts
            # Note: This may overcount multi-category projects, but is accurate for filtered view
            total_projects = total_from_distribution
        else:
            total_projects = count_result.count or 0
        
        return {
            "distribution": distribution,
            "total_projects": total_projects,
            "date": start_date.strftime("%Y-%m-%d"),
            "date_from": start_date.strftime("%Y-%m-%d"),
            "date_to": end_date.strftime("%Y-%m-%d"),
            "tier": tier
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to get category distribution: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to get category distribution")


@router.get("/threads/tier-distribution")
async def get_tier_distribution(
    date: Optional[str] = Query(None, description="Single date (deprecated, use date_from/date_to)"),
    date_from: Optional[str] = Query(None, description="Start date YYYY-MM-DD"),
    date_to: Optional[str] = Query(None, description="End date YYYY-MM-DD"),
    admin: dict = Depends(require_admin)
) -> Dict[str, Any]:
    """Get distribution of threads by subscription tier for a date range."""
    try:
        db = DBConnection()
        client = await db.client

        # Parse date range with backwards compatibility
        start_date, end_date = parse_date_range(date, date_from, date_to)

        # Convert to ISO format for queries
        start_of_range = start_date.replace(hour=0, minute=0, second=0, microsecond=0).isoformat()
        end_of_range = end_date.replace(hour=23, minute=59, second=59, microsecond=999999).isoformat()

        # Use database function for efficient GROUP BY aggregation
        result = await client.rpc('get_thread_tier_distribution', {
            'start_date': start_of_range,
            'end_date': end_of_range
        }).execute()

        if not result.data:
            return {
                "distribution": {},
                "total_threads": 0,
                "date": start_date.strftime("%Y-%m-%d"),
                "date_from": start_date.strftime("%Y-%m-%d"),
                "date_to": end_date.strftime("%Y-%m-%d")
            }

        # Build distribution from aggregated results
        distribution = {}
        total_threads = 0
        for row in result.data:
            tier = row.get('tier', 'none')
            count = row.get('count', 0)
            distribution[tier] = count
            total_threads += count

        return {
            "distribution": distribution,
            "total_threads": total_threads,
            "date": start_date.strftime("%Y-%m-%d"),
            "date_from": start_date.strftime("%Y-%m-%d"),
            "date_to": end_date.strftime("%Y-%m-%d")
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to get tier distribution: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to get tier distribution")


@router.get("/visitors")
async def get_visitor_stats(
    date: Optional[str] = Query(None, description="Date in YYYY-MM-DD format, defaults to today"),
    source: AnalyticsSource = Query("vercel", description="Analytics source: vercel (primary) or ga"),
    admin: dict = Depends(require_admin)
) -> VisitorStats:
    """Get visitor statistics for a specific day. Vercel is primary, GA is fallback."""
    try:
        # Parse date or default to today
        if date:
            try:
                selected_date = datetime.strptime(date, "%Y-%m-%d")
            except ValueError:
                raise HTTPException(status_code=400, detail="Invalid date format. Use YYYY-MM-DD")
        else:
            selected_date = datetime.now(BERLIN_TZ)
        
        date_str = selected_date.strftime("%Y-%m-%d")
        
        # Query based on source
        if source == "vercel":
            data = await query_vercel_analytics(date_str)
        else:
            data = query_google_analytics(date_str)
        
        return VisitorStats(
            total_visitors=data["unique_visitors"],
            unique_visitors=data["unique_visitors"],
            pageviews=data["pageviews"],
            date=date_str
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to get visitor stats: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to get visitor statistics")


@router.get("/conversion-funnel")
async def get_conversion_funnel(
    date: Optional[str] = Query(None, description="Single date (deprecated, use date_from/date_to)"),
    date_from: Optional[str] = Query(None, description="Start date YYYY-MM-DD"),
    date_to: Optional[str] = Query(None, description="End date YYYY-MM-DD"),
    source: AnalyticsSource = Query("vercel", description="Analytics source: vercel (primary) or ga"),
    admin: dict = Depends(require_admin)
) -> ConversionFunnel:
    """Get full conversion funnel: Visitors → Signups → Subscriptions for a date range."""
    try:
        db = DBConnection()
        client = await db.client

        # Parse date range with backwards compatibility
        start_date, end_date = parse_date_range(date, date_from, date_to)

        # Use UTC for all queries (matches profitability endpoint)
        UTC = ZoneInfo('UTC')
        start_of_range = datetime(start_date.year, start_date.month, start_date.day, 0, 0, 0, tzinfo=UTC).isoformat()
        end_of_range = datetime(end_date.year, end_date.month, end_date.day, 23, 59, 59, microsecond=999999, tzinfo=UTC).isoformat()

        # Define async functions for parallel execution
        async def get_visitors():
            """Sum visitors across all days in the range (single RPC call)."""
            try:
                start_str = start_date.strftime("%Y-%m-%d")
                end_str = end_date.strftime("%Y-%m-%d")
                if source == "vercel":
                    _, total = await query_vercel_analytics_range(start_str, end_str)
                    return total
                else:
                    # GA fallback - single day only
                    data = query_google_analytics(start_str)
                    return data["unique_visitors"]
            except Exception as e:
                logger.warning(f"Failed to get {source} visitors: {e}")
                return 0

        async def get_signups():
            result = await client.schema('basejump').from_('accounts').select(
                '*', count='exact'
            ).gte('created_at', start_of_range).lte('created_at', end_of_range).execute()
            return result.count or 0

        async def get_paid_subscribers():
            """
            Get unique paying customers from actual charges/transactions (not subscription creation).
            Includes both Stripe (web) and RevenueCat (app).
            """
            range_start_utc = datetime(start_date.year, start_date.month, start_date.day, 0, 0, 0, tzinfo=UTC)
            range_end_utc = datetime(end_date.year, end_date.month, end_date.day, 23, 59, 59, tzinfo=UTC)
            start_ts = int(range_start_utc.timestamp())
            end_ts = int(range_end_utc.timestamp())

            # Fetch from both Stripe and RevenueCat in parallel
            stripe_data, rc_data = await asyncio.gather(
                _fetch_stripe_revenue(start_ts, end_ts),
                _fetch_revenuecat_revenue(client, range_start_utc, range_end_utc)
            )

            # Collect unique paying customers by platform
            # Stripe (web): get emails from user_emails dict
            stripe_emails_dict = stripe_data.get('user_emails', {})
            web_emails = sorted(set([email for email in stripe_emails_dict.values() if email]))

            # RevenueCat (app): emails already fetched via RPC
            rc_emails_list = rc_data.get('user_emails', [])
            app_emails = sorted(set([email for email in rc_emails_list if email]))

            # Combined (deduplicated)
            all_emails = sorted(set(web_emails + app_emails))

            return {
                'count': len(all_emails),
                'web_emails': web_emails,
                'app_emails': app_emails,
            }

        # Execute all queries in parallel
        visitors, signups, subs_result = await asyncio.gather(
            get_visitors(),
            get_signups(),
            get_paid_subscribers()
        )

        # Extract count and emails from subs_result
        subscriptions = subs_result['count']
        web_subscriber_emails = subs_result['web_emails']
        app_subscriber_emails = subs_result['app_emails']

        # Calculate conversion rates
        visitor_to_signup = (signups / visitors * 100) if visitors > 0 else 0
        signup_to_sub = (subscriptions / signups * 100) if signups > 0 else 0
        overall = (subscriptions / visitors * 100) if visitors > 0 else 0

        return ConversionFunnel(
            visitors=visitors,
            signups=signups,
            subscriptions=subscriptions,
            web_subscriber_emails=web_subscriber_emails,
            app_subscriber_emails=app_subscriber_emails,
            visitor_to_signup_rate=round(visitor_to_signup, 2),
            signup_to_subscription_rate=round(signup_to_sub, 2),
            overall_conversion_rate=round(overall, 2),
            date=start_date.strftime("%Y-%m-%d")
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to get conversion funnel: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to get conversion funnel")


@router.get("/activation-stats")
async def get_activation_stats(
    date_from: Optional[str] = Query(None, description="Start date YYYY-MM-DD"),
    date_to: Optional[str] = Query(None, description="End date YYYY-MM-DD"),
    admin: dict = Depends(require_admin)
) -> ActivationStats:
    """Get signup activation stats: free tier signups activation rate + task distribution."""
    try:
        db = DBConnection()
        client = await db.client

        # Parse date range
        start_date, end_date = parse_date_range(None, date_from, date_to)

        # Use UTC for queries
        UTC = ZoneInfo('UTC')
        start_of_range = datetime(start_date.year, start_date.month, start_date.day, 0, 0, 0, tzinfo=UTC).isoformat()
        end_of_range = datetime(end_date.year, end_date.month, end_date.day, 23, 59, 59, microsecond=999999, tzinfo=UTC).isoformat()

        # Call the RPC function
        result = await client.rpc('get_signup_activation_stats', {
            'date_from': start_of_range,
            'date_to': end_of_range
        }).execute()

        if result.data and len(result.data) > 0:
            data = result.data[0]
            total = data.get('total_signups', 0) or 0
            activated = data.get('activated_signups', 0) or 0
            rate = (activated / total * 100) if total > 0 else 0
            distribution = {
                "0": data.get('bucket_0', 0) or 0,
                "1": data.get('bucket_1', 0) or 0,
                "2-5": data.get('bucket_2_5', 0) or 0,
                "6-10": data.get('bucket_6_10', 0) or 0,
                "10+": data.get('bucket_10_plus', 0) or 0,
            }
        else:
            total = 0
            activated = 0
            rate = 0
            distribution = {"0": 0, "1": 0, "2-5": 0, "6-10": 0, "10+": 0}

        return ActivationStats(
            total_signups=total,
            activated_signups=activated,
            activation_rate=round(rate, 2),
            distribution=distribution,
            date=start_date.strftime("%Y-%m-%d")
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to get activation stats: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to get activation stats")


@router.get("/user-funnel")
async def get_user_funnel(
    date_from: Optional[str] = Query(None, description="Start date YYYY-MM-DD"),
    date_to: Optional[str] = Query(None, description="End date YYYY-MM-DD"),
    admin: dict = Depends(require_admin)
) -> UserFunnelStats:
    """
    Get full user funnel: Signup → Tried Task → Viewed Pricing → Clicked Checkout → Converted.

    All data from Supabase - no GA4 cross-referencing needed.
    """
    try:
        db = DBConnection()
        client = await db.client

        # Parse date range
        start_date, end_date = parse_date_range(None, date_from, date_to)

        # Use UTC for Supabase queries
        UTC = ZoneInfo('UTC')
        start_of_range = datetime(start_date.year, start_date.month, start_date.day, 0, 0, 0, tzinfo=UTC).isoformat()
        end_of_range = datetime(end_date.year, end_date.month, end_date.day, 23, 59, 59, microsecond=999999, tzinfo=UTC).isoformat()

        # Get funnel counts directly from Supabase RPC (avoids 1000 row limit)
        counts_result = await client.rpc('get_free_signups_funnel_counts', {
            'date_from': start_of_range,
            'date_to': end_of_range
        }).execute()

        counts_data = counts_result.data[0] if counts_result.data else {}

        total_signups = counts_data.get('total_signups', 0)
        tried_task = counts_data.get('tried_task', 0)
        viewed_pricing = counts_data.get('viewed_pricing', 0)
        tried_and_viewed = counts_data.get('tried_and_viewed', 0)
        clicked_checkout = counts_data.get('clicked_checkout', 0)
        converted = counts_data.get('converted', 0)

        # Calculate rates
        tried_task_rate = (tried_task / total_signups * 100) if total_signups > 0 else 0
        viewed_pricing_rate = (viewed_pricing / total_signups * 100) if total_signups > 0 else 0
        tried_and_viewed_rate = (tried_and_viewed / total_signups * 100) if total_signups > 0 else 0
        clicked_checkout_rate = (clicked_checkout / total_signups * 100) if total_signups > 0 else 0
        conversion_rate = (converted / total_signups * 100) if total_signups > 0 else 0
        tried_then_viewed_rate = (tried_and_viewed / tried_task * 100) if tried_task > 0 else 0
        viewed_then_clicked_rate = (clicked_checkout / tried_and_viewed * 100) if tried_and_viewed > 0 else 0
        clicked_then_converted_rate = (converted / clicked_checkout * 100) if clicked_checkout > 0 else 0

        # Get "other" checkout clicks - free tier users who signed up BEFORE the date range
        # but clicked checkout DURING the date range
        other_clicked_checkout = 0
        try:
            # Use RPC to count free tier users who signed up before range but clicked during range
            result = await client.rpc('get_other_checkout_clicks_count', {
                'date_from': start_of_range,
                'date_to': end_of_range
            }).execute()
            other_clicked_checkout = result.data or 0
        except Exception as e:
            logger.warning(f"Failed to get other checkout clicks: {e}")

        return UserFunnelStats(
            total_signups=total_signups,
            tried_task=tried_task,
            tried_task_rate=round(tried_task_rate, 2),
            viewed_pricing=viewed_pricing,
            viewed_pricing_rate=round(viewed_pricing_rate, 2),
            tried_and_viewed=tried_and_viewed,
            tried_and_viewed_rate=round(tried_and_viewed_rate, 2),
            clicked_checkout=clicked_checkout,
            clicked_checkout_rate=round(clicked_checkout_rate, 2),
            converted=converted,
            conversion_rate=round(conversion_rate, 2),
            tried_then_viewed_rate=round(tried_then_viewed_rate, 2),
            viewed_then_clicked_rate=round(viewed_then_clicked_rate, 2),
            clicked_then_converted_rate=round(clicked_then_converted_rate, 2),
            other_clicked_checkout=other_clicked_checkout,
            date_from=start_date.strftime("%Y-%m-%d"),
            date_to=end_date.strftime("%Y-%m-%d")
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to get user funnel: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to get user funnel data")


# ============================================================================
# ARR WEEKLY ACTUALS ENDPOINTS
# ============================================================================

class FieldOverrides(BaseModel):
    """Tracks which fields have been manually overridden by admin.
    When a field is True, its value should NOT be overwritten by Stripe/API data."""
    views: Optional[bool] = False
    signups: Optional[bool] = False
    new_paid: Optional[bool] = False
    churn: Optional[bool] = False
    subscribers: Optional[bool] = False
    mrr: Optional[bool] = False
    arr: Optional[bool] = False


class WeeklyActualData(BaseModel):
    week_number: int
    week_start_date: str  # YYYY-MM-DD
    platform: str = 'web'  # 'web' (auto-sync) or 'app' (manual/RevenueCat)
    views: Optional[int] = 0
    signups: Optional[int] = 0
    new_paid: Optional[int] = 0
    churn: Optional[int] = 0
    subscribers: Optional[int] = 0
    mrr: Optional[float] = 0
    arr: Optional[float] = 0
    overrides: Optional[FieldOverrides] = None  # Tracks which fields are locked


class WeeklyActualsResponse(BaseModel):
    # Key is "{week_number}_{platform}" e.g. "1_web", "1_app"
    actuals: Dict[str, WeeklyActualData]


@router.get("/arr/signups")
async def get_signups_by_date(
    date_from: str = Query(..., description="Start date YYYY-MM-DD"),
    date_to: str = Query(..., description="End date YYYY-MM-DD"),
    admin: dict = Depends(require_super_admin)
) -> Dict[str, Any]:
    """
    Get signup counts grouped by date for a date range.
    Frontend can aggregate into weeks as needed.
    Super admin only.
    """
    try:
        db = DBConnection()
        client = await db.client
        
        # Use database function for efficient GROUP BY (bypasses row limits)
        result = await client.rpc('get_signups_by_date', {
            'start_date': f"{date_from}T00:00:00Z",
            'end_date': f"{date_to}T23:59:59.999999Z"
        }).execute()
        
        # Transform to dict format
        signups_by_date = {
            row['signup_date']: row['count'] 
            for row in (result.data or [])
        }
        total = sum(signups_by_date.values())
        
        return {
            "date_from": date_from,
            "date_to": date_to,
            "signups_by_date": signups_by_date,
            "total": total
        }
        
    except Exception as e:
        logger.error(f"Failed to get signups by date: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to get signups")


@router.get("/arr/views")
async def get_views_by_date(
    date_from: str = Query(..., description="Start date YYYY-MM-DD"),
    date_to: str = Query(..., description="End date YYYY-MM-DD"),
    source: AnalyticsSource = Query("vercel", description="Analytics source: vercel (primary) or ga"),
    admin: dict = Depends(require_super_admin)
) -> Dict[str, Any]:
    """
    Get view counts (unique visitors) grouped by date.
    Frontend can aggregate into weeks as needed.
    Super admin only.
    """
    try:
        if source == "vercel":
            # Query Vercel analytics from our database
            views_by_date, total = await query_vercel_analytics_range(date_from, date_to)
            return {
                "date_from": date_from,
                "date_to": date_to,
                "views_by_date": views_by_date,
                "total": total
            }
        else:
            # Query Google Analytics
            property_id = config.GA_PROPERTY_ID
            if not property_id:
                raise HTTPException(
                    status_code=500,
                    detail="Google Analytics not configured. Set GA_PROPERTY_ID environment variable."
                )
            
            client = get_ga_client()
            
            # Query GA with date dimension to get daily breakdown
            request = RunReportRequest(
                property=f"properties/{property_id}",
                date_ranges=[DateRange(start_date=date_from, end_date=date_to)],
                dimensions=[Dimension(name="date")],
                metrics=[Metric(name="newUsers")],
            )
            
            response = client.run_report(request)
            
            # Parse response into date -> count mapping
            views_by_date: Dict[str, int] = {}
            total = 0
            
            for row in response.rows or []:
                # Date comes in YYYYMMDD format, convert to YYYY-MM-DD
                raw_date = row.dimension_values[0].value
                formatted_date = f"{raw_date[:4]}-{raw_date[4:6]}-{raw_date[6:8]}"
                count = int(row.metric_values[0].value)
                views_by_date[formatted_date] = count
                total += count
            
            return {
                "date_from": date_from,
                "date_to": date_to,
                "views_by_date": views_by_date,
                "total": total
            }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to get views by date: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to get views")


@router.get("/arr/new-paid")
async def get_new_paid_by_date(
    date_from: str = Query(..., description="Start date YYYY-MM-DD"),
    date_to: str = Query(..., description="End date YYYY-MM-DD"),
    admin: dict = Depends(require_super_admin)
) -> Dict[str, Any]:
    """
    Get new paid subscription counts grouped by date for a date range.
    Uses Stripe Search API to find new subscriptions, excluding free tier.
    Frontend can aggregate into weeks as needed.
    Super admin only.
    """
    try:
        stripe.api_key = config.STRIPE_SECRET_KEY
        
        # Parse dates (using Berlin timezone)
        start_dt = datetime.strptime(date_from, "%Y-%m-%d").replace(tzinfo=BERLIN_TZ)
        end_dt = datetime.strptime(date_to, "%Y-%m-%d").replace(hour=23, minute=59, second=59, tzinfo=BERLIN_TZ)
        
        # Convert to Unix timestamps
        start_ts = int(start_dt.timestamp())
        end_ts = int(end_dt.timestamp())
        
        # Search for active paid subscriptions created in range
        query = f"status:'active' AND -metadata['tier']:'free' AND created>={start_ts} AND created<={end_ts}"
        
        new_paid_by_date: Dict[str, int] = {}
        has_more = True
        next_page = None
        
        while has_more:
            search_params = {
                'query': query,
                'limit': 100,
            }
            if next_page:
                search_params['page'] = next_page
            
            result = await stripe.Subscription.search_async(**search_params)
            
            for sub in result.data:
                # Convert created timestamp to date (Berlin timezone)
                created_date = datetime.fromtimestamp(sub.created, tz=BERLIN_TZ).strftime('%Y-%m-%d')
                new_paid_by_date[created_date] = new_paid_by_date.get(created_date, 0) + 1
            
            has_more = result.has_more
            next_page = result.next_page if has_more else None
        
        total = sum(new_paid_by_date.values())
        
        return {
            "date_from": date_from,
            "date_to": date_to,
            "new_paid_by_date": new_paid_by_date,
            "total": total
        }
        
    except stripe.error.StripeError as e:
        logger.error(f"Stripe error getting new paid by date: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to get new paid subscriptions from Stripe")
    except Exception as e:
        logger.error(f"Failed to get new paid by date: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to get new paid subscriptions")


async def _fetch_churn_from_stripe(start_ts: int, end_ts: int) -> Dict[str, Dict[str, int]]:
    """
    Fetch churn data from Stripe for a timestamp range.
    Returns dict with 'deleted' and 'downgrade' counts by date.
    """
    async def fetch_deleted_churns() -> Dict[str, int]:
        """Fetch subscription.deleted events for paid subscriptions."""
        churn_counts: Dict[str, int] = {}
        has_more = True
        starting_after = None
        
        while has_more:
            params = {
                "type": "customer.subscription.deleted",
                "created": {"gte": start_ts, "lte": end_ts},
                "limit": 100,
            }
            if starting_after:
                params["starting_after"] = starting_after
            
            result = await stripe.Event.list_async(**params)
            
            for event in result.data:
                sub = event.data.object
                metadata = sub.get("metadata", {}) or {}
                
                # Skip free tier
                if metadata.get("tier") == "free":
                    continue
                
                # Check if it had actual price > $0
                items = sub.get("items", {}).get("data", [])
                is_paid = any(
                    (item.get("price", {}).get("unit_amount", 0) or 0) > 0
                    for item in items
                )
                
                if is_paid:
                    event_date = datetime.fromtimestamp(event.created, tz=BERLIN_TZ).strftime('%Y-%m-%d')
                    churn_counts[event_date] = churn_counts.get(event_date, 0) + 1
            
            has_more = result.has_more
            starting_after = result.data[-1].id if has_more and result.data else None
        
        return churn_counts
    
    async def fetch_downgrade_churns() -> Dict[str, int]:
        """Fetch subscription.updated events where amount dropped from >0 to 0."""
        churn_counts: Dict[str, int] = {}
        has_more = True
        starting_after = None
        
        while has_more:
            params = {
                "type": "customer.subscription.updated",
                "created": {"gte": start_ts, "lte": end_ts},
                "limit": 100,
            }
            if starting_after:
                params["starting_after"] = starting_after
            
            result = await stripe.Event.list_async(**params)
            
            for event in result.data:
                sub = event.data.object
                previous = event.data.get("previous_attributes", {}) or {}
                
                # Skip if items didn't change
                if "items" not in previous:
                    continue
                
                # Get current amount
                current_items = sub.get("items", {}).get("data", [])
                current_amount = sum(
                    (item.get("price", {}).get("unit_amount", 0) or 0)
                    for item in current_items
                )
                
                # Skip if current is not $0
                if current_amount != 0:
                    continue
                
                # Get previous amount from previous_attributes.items
                prev_items_data = previous.get("items", {})
                prev_items = prev_items_data.get("data", []) if isinstance(prev_items_data, dict) else []
                
                prev_amount = sum(
                    (item.get("price", {}).get("unit_amount", 0) or 0)
                    for item in prev_items
                )
                
                # Count as churn if previous amount > 0 and current = 0
                if prev_amount > 0:
                    event_date = datetime.fromtimestamp(event.created, tz=BERLIN_TZ).strftime('%Y-%m-%d')
                    churn_counts[event_date] = churn_counts.get(event_date, 0) + 1
            
            has_more = result.has_more
            starting_after = result.data[-1].id if has_more and result.data else None
        
        return churn_counts
    
    # Run both queries in parallel
    deleted_churns, downgrade_churns = await asyncio.gather(
        fetch_deleted_churns(),
        fetch_downgrade_churns()
    )
    
    return {"deleted": deleted_churns, "downgrade": downgrade_churns}


@router.get("/arr/churn")
async def get_churn_by_date(
    date_from: str = Query(..., description="Start date YYYY-MM-DD"),
    date_to: str = Query(..., description="End date YYYY-MM-DD"),
    admin: dict = Depends(require_super_admin)
) -> Dict[str, Any]:
    """
    Get churned subscriber counts grouped by date for a date range.
    Uses database cache for historical data, only fetches from Stripe for today.
    Super admin only.
    """
    try:
        stripe.api_key = config.STRIPE_SECRET_KEY
        db = DBConnection()
        client = await db.client
        
        # Parse dates
        start_date = datetime.strptime(date_from, "%Y-%m-%d").date()
        end_date = datetime.strptime(date_to, "%Y-%m-%d").date()
        today = datetime.now(BERLIN_TZ).date()
        
        # Cap end date to today
        if end_date > today:
            end_date = today
        
        # 1. Get cached data from database
        cached_result = await client.from_('arr_daily_churn').select(
            'churn_date, deleted_count, downgrade_count'
        ).gte('churn_date', date_from).lte('churn_date', end_date.isoformat()).execute()
        
        cached_dates = {}
        for row in cached_result.data or []:
            cached_dates[row['churn_date']] = {
                'deleted': row['deleted_count'] or 0,
                'downgrade': row['downgrade_count'] or 0
            }
        
        # 2. Find dates that need fetching from Stripe
        # - Any date not in cache (except future dates)
        # - Today (always refresh since it's still updating)
        dates_to_fetch = []
        current = start_date
        while current <= end_date:
            date_str = current.isoformat()
            if date_str not in cached_dates or current == today:
                dates_to_fetch.append(current)
            current += timedelta(days=1)
        
        # 3. Fetch missing dates from Stripe (if any)
        if dates_to_fetch:
            # Group consecutive dates into ranges for efficiency
            fetch_start = min(dates_to_fetch)
            fetch_end = max(dates_to_fetch)
            
            fetch_start_dt = datetime.combine(fetch_start, datetime.min.time()).replace(tzinfo=BERLIN_TZ)
            fetch_end_dt = datetime.combine(fetch_end, datetime.max.time().replace(microsecond=0)).replace(tzinfo=BERLIN_TZ)
            
            start_ts = int(fetch_start_dt.timestamp())
            end_ts = int(fetch_end_dt.timestamp())
            
            logger.debug(f"Fetching churn from Stripe for {fetch_start} to {fetch_end}")
            stripe_data = await _fetch_churn_from_stripe(start_ts, end_ts)
            
            # 4. Store new data in database (upsert)
            for date in dates_to_fetch:
                date_str = date.isoformat()
                deleted = stripe_data["deleted"].get(date_str, 0)
                downgrade = stripe_data["downgrade"].get(date_str, 0)
                
                # Update cache dict
                cached_dates[date_str] = {'deleted': deleted, 'downgrade': downgrade}
                
                # Upsert to database (skip today - don't cache incomplete data)
                if date != today:
                    await client.from_('arr_daily_churn').upsert({
                        'churn_date': date_str,
                        'deleted_count': deleted,
                        'downgrade_count': downgrade
                    }, on_conflict='churn_date').execute()
        
        # 5. Build response
        churn_by_date: Dict[str, int] = {}
        for date_str, counts in cached_dates.items():
            total = counts['deleted'] + counts['downgrade']
            if total > 0:
                churn_by_date[date_str] = total
        
        total = sum(churn_by_date.values())
        
        return {
            "date_from": date_from,
            "date_to": date_to,
            "churn_by_date": churn_by_date,
            "total": total
        }
        
    except stripe.error.StripeError as e:
        logger.error(f"Stripe error getting churn by date: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to get churn data from Stripe")
    except Exception as e:
        logger.error(f"Failed to get churn by date: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to get churn data")


@router.get("/arr/actuals")
async def get_arr_weekly_actuals(
    admin: dict = Depends(require_super_admin)
) -> WeeklyActualsResponse:
    """Get all ARR weekly actuals for the simulator. Super admin only."""
    try:
        db = DBConnection()
        client = await db.client
        
        result = await client.from_('arr_weekly_actuals').select('*').order('week_number').execute()
        
        actuals = {}
        for row in result.data or []:
            # Parse overrides from JSONB
            overrides_data = row.get('overrides') or {}
            overrides = FieldOverrides(
                views=overrides_data.get('views', False),
                signups=overrides_data.get('signups', False),
                new_paid=overrides_data.get('new_paid', False),
                churn=overrides_data.get('churn', False),
                subscribers=overrides_data.get('subscribers', False),
                mrr=overrides_data.get('mrr', False),
                arr=overrides_data.get('arr', False),
            )
            
            # Use composite key: "{week_number}_{platform}"
            platform = row.get('platform', 'web')
            key = f"{row['week_number']}_{platform}"
            
            actuals[key] = WeeklyActualData(
                week_number=row['week_number'],
                week_start_date=row['week_start_date'],
                platform=platform,
                views=row.get('views', 0) or 0,
                signups=row.get('signups', 0) or 0,
                new_paid=row.get('new_paid', 0) or 0,
                churn=row.get('churn', 0) or 0,
                subscribers=row.get('subscribers', 0) or 0,
                mrr=float(row.get('mrr', 0) or 0),
                arr=float(row.get('arr', 0) or 0),
                overrides=overrides,
            )
        
        return WeeklyActualsResponse(actuals=actuals)
        
    except Exception as e:
        logger.error(f"Failed to get ARR weekly actuals: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to get ARR weekly actuals")


@router.put("/arr/actuals/{week_number}")
async def update_arr_weekly_actual(
    week_number: int,
    data: WeeklyActualData,
    platform: str = Query('web', description="Platform: 'web' or 'app'"),
    admin: dict = Depends(require_super_admin)
) -> WeeklyActualData:
    """Update or create ARR weekly actual data for a specific week and platform. Super admin only.
    
    When a value is explicitly provided (non-zero), it will be marked as overridden
    and will NOT be replaced by Stripe/API data on subsequent fetches.
    """
    try:
        if platform not in ('web', 'app'):
            raise HTTPException(status_code=400, detail="Platform must be 'web' or 'app'")
        
        db = DBConnection()
        client = await db.client
        
        # Get existing overrides (if any) to merge with new ones
        existing_result = await client.from_('arr_weekly_actuals').select('overrides').eq('week_number', week_number).eq('platform', platform).execute()
        existing_overrides = {}
        if existing_result.data and len(existing_result.data) > 0:
            existing_overrides = existing_result.data[0].get('overrides') or {}
        
        # Merge overrides: if data.overrides is provided, use it; otherwise keep existing
        new_overrides = existing_overrides.copy()
        if data.overrides:
            # Update overrides from the request
            if data.overrides.views is not None:
                new_overrides['views'] = data.overrides.views
            if data.overrides.signups is not None:
                new_overrides['signups'] = data.overrides.signups
            if data.overrides.new_paid is not None:
                new_overrides['new_paid'] = data.overrides.new_paid
            if data.overrides.churn is not None:
                new_overrides['churn'] = data.overrides.churn
            if data.overrides.subscribers is not None:
                new_overrides['subscribers'] = data.overrides.subscribers
            if data.overrides.mrr is not None:
                new_overrides['mrr'] = data.overrides.mrr
            if data.overrides.arr is not None:
                new_overrides['arr'] = data.overrides.arr
        
        # Upsert the data including overrides
        upsert_data = {
            'week_number': week_number,
            'week_start_date': data.week_start_date,
            'platform': platform,
            'views': data.views or 0,
            'signups': data.signups or 0,
            'new_paid': data.new_paid or 0,
            'churn': data.churn or 0,
            'subscribers': data.subscribers or 0,
            'mrr': data.mrr or 0,
            'arr': data.arr or 0,
            'overrides': new_overrides,
        }
        
        result = await client.from_('arr_weekly_actuals').upsert(
            upsert_data,
            on_conflict='week_number,platform'
        ).execute()
        
        # Return with updated overrides
        data.platform = platform
        data.overrides = FieldOverrides(**new_overrides)
        return data
        
    except Exception as e:
        logger.error(f"Failed to update ARR weekly actual: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to update ARR weekly actual")


@router.delete("/arr/actuals/{week_number}")
async def delete_arr_weekly_actual(
    week_number: int,
    platform: str = Query('web', description="Platform: 'web' or 'app'"),
    admin: dict = Depends(require_super_admin)
) -> Dict[str, str]:
    """Delete ARR weekly actual for a specific week and platform. Super admin only."""
    try:
        if platform not in ('web', 'app'):
            raise HTTPException(status_code=400, detail="Platform must be 'web' or 'app'")
        
        db = DBConnection()
        client = await db.client
        
        await client.from_('arr_weekly_actuals').delete().eq('week_number', week_number).eq('platform', platform).execute()
        
        return {"message": f"Week {week_number} ({platform}) actual data deleted"}
        
    except Exception as e:
        logger.error(f"Failed to delete ARR weekly actual: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to delete ARR weekly actual")


class ToggleOverrideRequest(BaseModel):
    field: str  # One of: views, signups, new_paid, subscribers, mrr, arr
    override: bool  # True to lock, False to unlock


@router.patch("/arr/actuals/{week_number}/override")
async def toggle_field_override(
    week_number: int,
    request: ToggleOverrideRequest,
    platform: str = Query('web', description="Platform: 'web' or 'app'"),
    admin: dict = Depends(require_super_admin)
) -> Dict[str, Any]:
    """Toggle the override status for a specific field in a week and platform.
    
    When override is True, the field value is 'locked' and won't be overwritten by Stripe data.
    When override is False, the field is 'unlocked' and will use Stripe data instead.
    Super admin only.
    """
    try:
        valid_fields = ['views', 'signups', 'new_paid', 'churn', 'subscribers', 'mrr', 'arr']
        if request.field not in valid_fields:
            raise HTTPException(
                status_code=400, 
                detail=f"Invalid field. Must be one of: {', '.join(valid_fields)}"
            )
        
        if platform not in ('web', 'app'):
            raise HTTPException(status_code=400, detail="Platform must be 'web' or 'app'")
        
        db = DBConnection()
        client = await db.client
        
        # Get existing record
        existing_result = await client.from_('arr_weekly_actuals').select('overrides').eq('week_number', week_number).eq('platform', platform).execute()
        
        if not existing_result.data or len(existing_result.data) == 0:
            raise HTTPException(status_code=404, detail=f"Week {week_number} ({platform}) not found")
        
        # Update overrides
        overrides = existing_result.data[0].get('overrides') or {}
        overrides[request.field] = request.override
        
        await client.from_('arr_weekly_actuals').update({
            'overrides': overrides
        }).eq('week_number', week_number).eq('platform', platform).execute()
        
        return {
            "week_number": week_number,
            "platform": platform,
            "field": request.field,
            "override": request.override,
            "message": f"Field '{request.field}' ({platform}) is now {'locked (manual)' if request.override else 'unlocked (sync from Stripe)'}"
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to toggle field override: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to toggle field override")


# ============================================================================
# ARR SIMULATOR CONFIG ENDPOINTS
# ============================================================================

class SimulatorConfigData(BaseModel):
    starting_subs: Optional[int] = 639
    starting_mrr: Optional[float] = 21646
    weekly_visitors: Optional[int] = 40000
    landing_conversion: Optional[float] = 25
    signup_to_paid: Optional[float] = 1
    arpu: Optional[float] = 34
    monthly_churn: Optional[float] = 25
    visitor_growth: Optional[float] = 5
    target_arr: Optional[float] = 10000000


@router.get("/arr/config")
async def get_arr_simulator_config(
    admin: dict = Depends(require_super_admin)
) -> SimulatorConfigData:
    """Get ARR simulator configuration. Super admin only."""
    try:
        db = DBConnection()
        client = await db.client
        
        result = await client.from_('arr_simulator_config').select('*').limit(1).execute()
        
        if result.data and len(result.data) > 0:
            row = result.data[0]
            return SimulatorConfigData(
                starting_subs=row.get('starting_subs', 639) or 639,
                starting_mrr=float(row.get('starting_mrr', 21646) or 21646),
                weekly_visitors=row.get('weekly_visitors', 40000) or 40000,
                landing_conversion=float(row.get('landing_conversion', 25) or 25),
                signup_to_paid=float(row.get('signup_to_paid', 1) or 1),
                arpu=float(row.get('arpu', 34) or 34),
                monthly_churn=float(row.get('monthly_churn', 25) or 25),
                visitor_growth=float(row.get('visitor_growth', 5) or 5),
                target_arr=float(row.get('target_arr', 10000000) or 10000000),
            )
        
        # Return defaults if no config exists
        return SimulatorConfigData()
        
    except Exception as e:
        logger.error(f"Failed to get ARR simulator config: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to get ARR simulator config")


@router.put("/arr/config")
async def update_arr_simulator_config(
    data: SimulatorConfigData,
    admin: dict = Depends(require_super_admin)
) -> SimulatorConfigData:
    """Update ARR simulator configuration. Super admin only."""
    try:
        db = DBConnection()
        client = await db.client
        
        # Get existing config ID
        existing = await client.from_('arr_simulator_config').select('id').limit(1).execute()
        
        update_data = {
            'starting_subs': data.starting_subs,
            'starting_mrr': data.starting_mrr,
            'weekly_visitors': data.weekly_visitors,
            'landing_conversion': data.landing_conversion,
            'signup_to_paid': data.signup_to_paid,
            'arpu': data.arpu,
            'monthly_churn': data.monthly_churn,
            'visitor_growth': data.visitor_growth,
            'target_arr': data.target_arr,
        }
        
        if existing.data and len(existing.data) > 0:
            # Update existing row
            await client.from_('arr_simulator_config').update(update_data).eq('id', existing.data[0]['id']).execute()
        else:
            # Insert new row
            await client.from_('arr_simulator_config').insert(update_data).execute()
        
        return data
        
    except Exception as e:
        logger.error(f"Failed to update ARR simulator config: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to update ARR simulator config")


# ============================================================================
# MONTHLY ACTUALS (Direct monthly editing with override support)
# ============================================================================

class MonthlyActualData(BaseModel):
    month_index: int  # 0=Dec 2024, 1=Jan 2025, etc.
    month_name: str  # 'Dec 2024', 'Jan 2025', etc.
    platform: str = 'web'  # 'web' (auto-sync) or 'app' (manual/RevenueCat)
    views: Optional[int] = 0
    signups: Optional[int] = 0
    new_paid: Optional[int] = 0
    churn: Optional[int] = 0
    subscribers: Optional[int] = 0
    mrr: Optional[float] = 0
    arr: Optional[float] = 0
    overrides: Optional[FieldOverrides] = None  # Tracks which fields are locked


class MonthlyActualsResponse(BaseModel):
    # Key is "{month_index}_{platform}" e.g. "0_web", "0_app"
    actuals: Dict[str, MonthlyActualData]


@router.get("/arr/monthly-actuals")
async def get_arr_monthly_actuals(
    admin: dict = Depends(require_super_admin)
) -> MonthlyActualsResponse:
    """Get all ARR monthly actuals for the simulator. Super admin only."""
    try:
        db = DBConnection()
        client = await db.client
        
        result = await client.from_('arr_monthly_actuals').select('*').order('month_index').execute()
        
        actuals = {}
        for row in result.data or []:
            # Parse overrides from JSONB
            overrides_data = row.get('overrides') or {}
            overrides = FieldOverrides(
                views=overrides_data.get('views', False),
                signups=overrides_data.get('signups', False),
                new_paid=overrides_data.get('new_paid', False),
                churn=overrides_data.get('churn', False),
                subscribers=overrides_data.get('subscribers', False),
                mrr=overrides_data.get('mrr', False),
                arr=overrides_data.get('arr', False),
            )
            
            # Use composite key: "{month_index}_{platform}"
            platform = row.get('platform', 'web')
            key = f"{row['month_index']}_{platform}"
            
            actuals[key] = MonthlyActualData(
                month_index=row['month_index'],
                month_name=row.get('month_name', ''),
                platform=platform,
                views=row.get('views', 0) or 0,
                signups=row.get('signups', 0) or 0,
                new_paid=row.get('new_paid', 0) or 0,
                churn=row.get('churn', 0) or 0,
                subscribers=row.get('subscribers', 0) or 0,
                mrr=float(row.get('mrr', 0) or 0),
                arr=float(row.get('arr', 0) or 0),
                overrides=overrides,
            )
        
        return MonthlyActualsResponse(actuals=actuals)
        
    except Exception as e:
        logger.error(f"Failed to get ARR monthly actuals: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to get ARR monthly actuals")


@router.put("/arr/monthly-actuals/{month_index}")
async def update_arr_monthly_actual(
    month_index: int,
    data: MonthlyActualData,
    platform: str = Query('web', description="Platform: 'web' or 'app'"),
    admin: dict = Depends(require_super_admin)
) -> MonthlyActualData:
    """Update or create ARR monthly actual data for a specific month and platform. Super admin only.
    
    When a value is explicitly provided (non-zero), it will be marked as overridden
    and will NOT be replaced by auto-calculated data on subsequent fetches.
    """
    try:
        if platform not in ('web', 'app'):
            raise HTTPException(status_code=400, detail="Platform must be 'web' or 'app'")
        
        db = DBConnection()
        client = await db.client
        
        # Get existing overrides (if any) to merge with new ones
        existing_result = await client.from_('arr_monthly_actuals').select('overrides').eq('month_index', month_index).eq('platform', platform).execute()
        existing_overrides = {}
        if existing_result.data and len(existing_result.data) > 0:
            existing_overrides = existing_result.data[0].get('overrides') or {}
        
        # Merge overrides: if data.overrides is provided, use it; otherwise keep existing
        new_overrides = existing_overrides.copy()
        if data.overrides:
            # Update overrides from the request
            if data.overrides.views is not None:
                new_overrides['views'] = data.overrides.views
            if data.overrides.signups is not None:
                new_overrides['signups'] = data.overrides.signups
            if data.overrides.new_paid is not None:
                new_overrides['new_paid'] = data.overrides.new_paid
            if data.overrides.churn is not None:
                new_overrides['churn'] = data.overrides.churn
            if data.overrides.subscribers is not None:
                new_overrides['subscribers'] = data.overrides.subscribers
            if data.overrides.mrr is not None:
                new_overrides['mrr'] = data.overrides.mrr
            if data.overrides.arr is not None:
                new_overrides['arr'] = data.overrides.arr
        
        # Upsert the data including overrides
        upsert_data = {
            'month_index': month_index,
            'month_name': data.month_name,
            'platform': platform,
            'views': data.views or 0,
            'signups': data.signups or 0,
            'new_paid': data.new_paid or 0,
            'churn': data.churn or 0,
            'subscribers': data.subscribers or 0,
            'mrr': data.mrr or 0,
            'arr': data.arr or 0,
            'overrides': new_overrides,
        }
        
        await client.from_('arr_monthly_actuals').upsert(
            upsert_data, 
            on_conflict='month_index,platform'
        ).execute()
        
        return MonthlyActualData(
            month_index=month_index,
            month_name=data.month_name,
            platform=platform,
            views=data.views or 0,
            signups=data.signups or 0,
            new_paid=data.new_paid or 0,
            churn=data.churn or 0,
            subscribers=data.subscribers or 0,
            mrr=data.mrr or 0,
            arr=data.arr or 0,
            overrides=FieldOverrides(**new_overrides) if new_overrides else None,
        )
        
    except Exception as e:
        logger.error(f"Failed to update ARR monthly actual: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to update ARR monthly actual")


@router.delete("/arr/monthly-actuals/{month_index}")
async def delete_arr_monthly_actual(
    month_index: int,
    platform: str = Query('web', description="Platform: 'web' or 'app'"),
    admin: dict = Depends(require_super_admin)
) -> Dict[str, str]:
    """Delete ARR monthly actual for a specific month and platform. Super admin only."""
    try:
        if platform not in ('web', 'app'):
            raise HTTPException(status_code=400, detail="Platform must be 'web' or 'app'")
        
        db = DBConnection()
        client = await db.client
        
        await client.from_('arr_monthly_actuals').delete().eq('month_index', month_index).eq('platform', platform).execute()
        
        return {"message": f"Month {month_index} ({platform}) actual data deleted"}
        
    except Exception as e:
        logger.error(f"Failed to delete ARR monthly actual: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to delete ARR monthly actual")


@router.patch("/arr/monthly-actuals/{month_index}/override")
async def toggle_monthly_field_override(
    month_index: int,
    request: ToggleOverrideRequest,
    platform: str = Query('web', description="Platform: 'web' or 'app'"),
    admin: dict = Depends(require_super_admin)
) -> Dict[str, Any]:
    """Toggle the override status for a specific field in a month and platform.
    
    When override is True, the field value is 'locked' and won't be overwritten by calculated data.
    When override is False, the field is 'unlocked' and will use calculated data instead.
    Super admin only.
    """
    try:
        valid_fields = ['views', 'signups', 'new_paid', 'churn', 'subscribers', 'mrr', 'arr']
        if request.field not in valid_fields:
            raise HTTPException(
                status_code=400, 
                detail=f"Invalid field. Must be one of: {', '.join(valid_fields)}"
            )
        
        if platform not in ('web', 'app'):
            raise HTTPException(status_code=400, detail="Platform must be 'web' or 'app'")
        
        db = DBConnection()
        client = await db.client
        
        # Get existing record
        existing_result = await client.from_('arr_monthly_actuals').select('overrides').eq('month_index', month_index).eq('platform', platform).execute()
        
        if not existing_result.data or len(existing_result.data) == 0:
            raise HTTPException(status_code=404, detail=f"Month {month_index} ({platform}) not found")
        
        # Update overrides
        overrides = existing_result.data[0].get('overrides') or {}
        overrides[request.field] = request.override
        
        await client.from_('arr_monthly_actuals').update({
            'overrides': overrides
        }).eq('month_index', month_index).eq('platform', platform).execute()
        
        return {
            "month_index": month_index,
            "platform": platform,
            "field": request.field,
            "override": request.override,
            "message": f"Field '{request.field}' ({platform}) is now {'locked (manual)' if request.override else 'unlocked (auto-calculated)'}"
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to toggle monthly field override: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to toggle monthly field override")


# ============================================================================
# EXECUTIVE OVERVIEW ENDPOINTS
# ============================================================================

class RevenueSummary(BaseModel):
    """Revenue metrics from Stripe and database."""
    mrr: float  # Monthly Recurring Revenue
    arr: float  # Annual Recurring Revenue (MRR * 12)
    total_paid_subscribers: int
    subscribers_by_tier: Dict[str, int]  # tier_name -> count
    arpu: float  # Average Revenue Per User
    mrr_change_percent: Optional[float] = None  # vs last month
    new_paid_this_month: int
    churned_this_month: int


class TierProfitability(BaseModel):
    """Profitability metrics for a single tier."""
    tier: str
    display_name: str
    provider: str  # 'stripe' or 'revenuecat'
    payment_count: int  # Number of payments in the period
    unique_users: int  # Unique paying users
    usage_users: int  # Users with LLM usage (from credit_ledger)
    total_revenue: float  # Actual revenue from payments
    total_cost: float  # Sum of LLM usage costs (what we charge users)
    total_actual_cost: float  # Actual LLM costs (before markup)
    gross_profit: float  # revenue - actual_cost
    gross_margin_percent: float  # (gross_profit / revenue) * 100
    avg_cost_per_user: float
    avg_revenue_per_user: float
    avg_profit_per_user: float


class ProfitabilitySummary(BaseModel):
    """Overall profitability summary across all tiers and platforms."""
    # Overall metrics
    total_revenue: float
    total_cost: float  # What we charge users (with markup)
    total_actual_cost: float  # What we pay LLM providers
    gross_profit: float
    gross_margin_percent: float

    # Breakdown by tier
    by_tier: List[TierProfitability]

    # Breakdown by platform
    web_revenue: float
    web_cost: float
    web_profit: float
    app_revenue: float
    app_cost: float
    app_profit: float

    # Per-user averages (industry standard)
    avg_revenue_per_paid_user: float  # ARPU: revenue / paying users
    avg_cost_per_active_user: float   # Cost to serve: costs / active users

    # User counts
    unique_paying_users: int   # Users who made a payment in this period
    unique_active_users: int   # Users who had usage in this period (including free)
    paying_user_emails: List[str] = []  # Emails of paying users (clickable)

    total_active_subscriptions: int = 0
    stripe_active_subscriptions: int = 0
    revenuecat_active_subscriptions: int = 0

    # Meta
    period_start: str
    period_end: str
    total_payments: int  # Total payment transactions


class EngagementSummary(BaseModel):
    """User engagement metrics."""
    dau: int  # Daily Active Users (unique accounts with activity today)
    wau: int  # Weekly Active Users (last 7 days)
    mau: int  # Monthly Active Users (last 30 days)
    dau_mau_ratio: float  # Stickiness ratio
    avg_threads_per_active_user: float
    total_threads_today: int
    total_threads_week: int
    retention_d1: Optional[float] = None  # Day 1 retention
    retention_d7: Optional[float] = None  # Day 7 retention
    retention_d30: Optional[float] = None  # Day 30 retention


class TaskPerformance(BaseModel):
    """Agent run/task performance metrics."""
    total_runs: int
    completed_runs: int
    failed_runs: int
    stopped_runs: int  # User cancelled
    running_runs: int
    pending_runs: int  # Not started yet
    success_rate: float  # percentage: completed / (completed + failed + stopped)
    avg_duration_seconds: Optional[float] = None  # Excludes stuck tasks (> 1hr)
    avg_duration_with_stuck_seconds: Optional[float] = None  # Includes all tasks
    stuck_task_count: int = 0  # Tasks with duration > 1hr (likely stuck)
    runs_by_status: Dict[str, int]


class ToolUsage(BaseModel):
    """Individual tool usage stats."""
    tool_name: str
    usage_count: int
    unique_threads: int
    percentage_of_threads: float


class ToolAdoptionSummary(BaseModel):
    """Tool adoption metrics."""
    total_tool_calls: int
    total_threads_with_tools: int
    top_tools: List[ToolUsage]
    tool_adoption_rate: float  # % of threads using any tool


@router.get("/revenue-summary")
async def get_revenue_summary(
    admin: dict = Depends(require_super_admin)
) -> RevenueSummary:
    """
    Get revenue summary including MRR, subscriber counts, and tier breakdown.
    Combines Stripe API data with database records.
    Super admin only due to sensitive financial data.
    """
    try:
        stripe.api_key = config.STRIPE_SECRET_KEY
        db = DBConnection()
        client = await db.client
        
        now = datetime.now(BERLIN_TZ)
        month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        last_month_start = (month_start - timedelta(days=1)).replace(day=1)
        
        # Get all active paid subscriptions from Stripe
        subscribers_by_tier: Dict[str, int] = {}
        total_mrr = 0.0
        total_paid_subscribers = 0
        
        has_more = True
        starting_after = None
        
        while has_more:
            params = {
                'status': 'active',
                'limit': 100,
                'expand': ['data.items.data.price']
            }
            if starting_after:
                params['starting_after'] = starting_after
            
            result = await stripe.Subscription.list_async(**params)
            
            for sub in result.data:
                metadata = sub.get('metadata', {}) or {}
                tier = metadata.get('tier', 'unknown')
                
                # Skip free tier
                if tier == 'free':
                    continue
                
                # Calculate MRR from subscription items
                sub_mrr = 0.0
                items = sub.get('items', {}).get('data', [])
                for item in items:
                    price = item.get('price', {})
                    unit_amount = price.get('unit_amount', 0) or 0
                    interval = price.get('recurring', {}).get('interval', 'month')
                    interval_count = price.get('recurring', {}).get('interval_count', 1)
                    
                    if unit_amount > 0:
                        # Convert to monthly
                        if interval == 'year':
                            sub_mrr += (unit_amount / 100) / 12
                        elif interval == 'month':
                            sub_mrr += (unit_amount / 100) / interval_count
                        else:
                            sub_mrr += unit_amount / 100
                
                if sub_mrr > 0:
                    total_mrr += sub_mrr
                    total_paid_subscribers += 1
                    
                    # Map tier to display name
                    display_tier = {
                        'tier_2_20': 'Plus',
                        'tier_6_50': 'Pro',
                        'tier_12_100': 'Business',
                        'tier_25_200': 'Ultra',
                        'tier_50_400': 'Enterprise',
                        'tier_125_800': 'Scale',
                        'tier_200_1000': 'Max',
                    }.get(tier, tier)
                    
                    subscribers_by_tier[display_tier] = subscribers_by_tier.get(display_tier, 0) + 1
            
            has_more = result.has_more
            starting_after = result.data[-1].id if has_more and result.data else None
        
        # Get new paid this month from Stripe
        month_start_ts = int(month_start.timestamp())
        new_paid_query = f"status:'active' AND -metadata['tier']:'free' AND created>={month_start_ts}"
        new_paid_result = await stripe.Subscription.search_async(query=new_paid_query, limit=100)
        new_paid_this_month = len(new_paid_result.data)
        
        # Count additional pages if any
        while new_paid_result.has_more:
            new_paid_result = await stripe.Subscription.search_async(
                query=new_paid_query, 
                limit=100,
                page=new_paid_result.next_page
            )
            new_paid_this_month += len(new_paid_result.data)
        
        # Get churned this month from database cache
        churn_result = await client.from_('arr_daily_churn').select(
            'deleted_count, downgrade_count'
        ).gte('churn_date', month_start.strftime('%Y-%m-%d')).execute()
        
        churned_this_month = sum(
            (row.get('deleted_count', 0) or 0) + (row.get('downgrade_count', 0) or 0)
            for row in churn_result.data or []
        )
        
        # Calculate ARPU
        arpu = total_mrr / total_paid_subscribers if total_paid_subscribers > 0 else 0.0
        
        return RevenueSummary(
            mrr=round(total_mrr, 2),
            arr=round(total_mrr * 12, 2),
            total_paid_subscribers=total_paid_subscribers,
            subscribers_by_tier=subscribers_by_tier,
            arpu=round(arpu, 2),
            mrr_change_percent=None,  # TODO: Calculate from historical data
            new_paid_this_month=new_paid_this_month,
            churned_this_month=churned_this_month,
        )
        
    except stripe.error.StripeError as e:
        logger.error(f"Stripe error getting revenue summary: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to get revenue data from Stripe")
    except Exception as e:
        logger.error(f"Failed to get revenue summary: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to get revenue summary")


@router.get("/engagement-summary")
async def get_engagement_summary(
    date: Optional[str] = Query(None, description="Single date (deprecated, use date_from/date_to)"),
    date_from: Optional[str] = Query(None, description="Start date YYYY-MM-DD"),
    date_to: Optional[str] = Query(None, description="End date YYYY-MM-DD"),
    admin: dict = Depends(require_admin)
) -> EngagementSummary:
    """
    Get user engagement metrics including DAU, WAU, MAU, and retention for a date range.
    When a range is provided:
    - DAU: unique active users across the entire range
    - WAU: unique users in 7 days ending at date_to
    - MAU: unique users in 30 days ending at date_to
    - total_threads_today: threads created in the range
    - total_threads_week: threads in 7 days ending at date_to
    """
    try:
        db = DBConnection()
        client = await db.client

        # Parse date range with backwards compatibility
        start_date, end_date = parse_date_range(date, date_from, date_to)

        # Use UTC for all queries to align with profitability/usage metrics
        UTC = ZoneInfo('UTC')
        range_start = datetime(start_date.year, start_date.month, start_date.day, 0, 0, 0, tzinfo=UTC)
        range_end = datetime(end_date.year, end_date.month, end_date.day, 23, 59, 59, microsecond=999999, tzinfo=UTC)
        week_start = datetime(end_date.year, end_date.month, end_date.day, 0, 0, 0, tzinfo=UTC) - timedelta(days=6)
        month_start = datetime(end_date.year, end_date.month, end_date.day, 0, 0, 0, tzinfo=UTC) - timedelta(days=29)

        # Use RPC for efficient COUNT(DISTINCT) queries
        # Pass the range start/end for DAU calculation
        metrics_result = await client.rpc('get_engagement_metrics', {
            'p_today_start': range_start.isoformat(),
            'p_today_end': range_end.isoformat(),
            'p_week_start': week_start.isoformat(),
            'p_month_start': month_start.isoformat(),
        }).execute()

        if metrics_result.data and len(metrics_result.data) > 0:
            metrics = metrics_result.data[0]
            dau = metrics.get('dau', 0) or 0
            wau = metrics.get('wau', 0) or 0
            mau = metrics.get('mau', 0) or 0
            total_threads_today = metrics.get('threads_today', 0) or 0
            total_threads_week = metrics.get('threads_week', 0) or 0
        else:
            dau = wau = mau = total_threads_today = total_threads_week = 0

        # DAU/MAU ratio (stickiness)
        dau_mau_ratio = (dau / mau * 100) if mau > 0 else 0.0

        # Avg threads per active user (in the range)
        avg_threads_per_active_user = total_threads_today / dau if dau > 0 else 0.0

        return EngagementSummary(
            dau=dau,
            wau=wau,
            mau=mau,
            dau_mau_ratio=round(dau_mau_ratio, 1),
            avg_threads_per_active_user=round(avg_threads_per_active_user, 2),
            total_threads_today=total_threads_today,
            total_threads_week=total_threads_week,
            retention_d1=None,
            retention_d7=None,
            retention_d30=None,
        )

    except Exception as e:
        logger.error(f"Failed to get engagement summary: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to get engagement summary")


@router.get("/task-performance")
async def get_task_performance(
    date: Optional[str] = Query(None, description="Single date (deprecated, use date_from/date_to)"),
    date_from: Optional[str] = Query(None, description="Start date YYYY-MM-DD"),
    date_to: Optional[str] = Query(None, description="End date YYYY-MM-DD"),
    admin: dict = Depends(require_admin)
) -> TaskPerformance:
    """
    Get task/agent run performance metrics for a date range.

    Returns both avg_duration_seconds (excluding stuck tasks >1hr) and
    avg_duration_with_stuck_seconds (including all) for frontend toggle.
    """
    try:
        db = DBConnection()
        client = await db.client

        # Parse date range with backwards compatibility
        start_date, end_date = parse_date_range(date, date_from, date_to)

        # Use UTC for all queries to align with profitability/usage metrics
        UTC = ZoneInfo('UTC')
        range_start = datetime(start_date.year, start_date.month, start_date.day, 0, 0, 0, tzinfo=UTC)
        range_end = datetime(end_date.year, end_date.month, end_date.day, 23, 59, 59, microsecond=999999, tzinfo=UTC)

        # Use RPC for aggregation - don't fetch rows in Python
        result = await client.rpc('get_task_performance', {
            'p_start': range_start.isoformat(),
            'p_end': range_end.isoformat(),
        }).execute()
        
        if result.data and len(result.data) > 0:
            data = result.data[0]
            total_runs = data.get('total_runs', 0) or 0
            completed_runs = data.get('completed_runs', 0) or 0
            failed_runs = data.get('failed_runs', 0) or 0
            stopped_runs = data.get('stopped_runs', 0) or 0
            running_runs = data.get('running_runs', 0) or 0
            pending_runs = data.get('pending_runs', 0) or 0
            avg_duration = data.get('avg_duration_seconds')
            avg_duration_with_stuck = data.get('avg_duration_with_stuck_seconds')
            stuck_task_count = data.get('stuck_task_count', 0) or 0
            runs_by_status = data.get('runs_by_status', {}) or {}
        else:
            total_runs = completed_runs = failed_runs = stopped_runs = running_runs = pending_runs = 0
            avg_duration = None
            avg_duration_with_stuck = None
            stuck_task_count = 0
            runs_by_status = {}
        
        # Success rate: completed / (completed + failed + stopped)
        finished_runs = completed_runs + failed_runs + stopped_runs
        success_rate = (completed_runs / finished_runs * 100) if finished_runs > 0 else 0.0
        
        return TaskPerformance(
            total_runs=total_runs,
            completed_runs=completed_runs,
            failed_runs=failed_runs,
            stopped_runs=stopped_runs,
            running_runs=running_runs,
            pending_runs=pending_runs,
            success_rate=round(success_rate, 1),
            avg_duration_seconds=round(avg_duration, 1) if avg_duration else None,
            avg_duration_with_stuck_seconds=round(avg_duration_with_stuck, 1) if avg_duration_with_stuck else None,
            stuck_task_count=stuck_task_count,
            runs_by_status=runs_by_status,
        )
        
    except Exception as e:
        logger.error(f"Failed to get task performance: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to get task performance")


@router.get("/tool-adoption")
async def get_tool_adoption(
    date: Optional[str] = Query(None, description="Date in YYYY-MM-DD format, defaults to today"),
    admin: dict = Depends(require_admin)
) -> ToolAdoptionSummary:
    """
    Get tool adoption metrics by parsing tool calls from messages.
    """
    try:
        db = DBConnection()
        client = await db.client
        
        # Parse target date
        if date:
            target_date = datetime.strptime(date, "%Y-%m-%d").replace(tzinfo=BERLIN_TZ)
        else:
            target_date = datetime.now(BERLIN_TZ)
        
        today_start = target_date.replace(hour=0, minute=0, second=0, microsecond=0)
        today_end = today_start + timedelta(days=1)
        
        # Get messages with tool calls (type='tool' or content contains tool_calls)
        # We look for assistant messages that have tool_calls in their content
        messages_result = await client.from_('messages').select(
            'thread_id, content, type'
        ).gte('created_at', today_start.isoformat()).lt('created_at', today_end.isoformat()).in_('type', ['tool', 'assistant']).limit(5000).execute()
        
        messages = messages_result.data or []
        
        # Parse tool usage
        tool_counts: Dict[str, int] = {}
        tool_threads: Dict[str, set] = {}
        threads_with_tools: set = set()
        total_tool_calls = 0
        
        for msg in messages:
            thread_id = msg.get('thread_id')
            content = msg.get('content', {})
            msg_type = msg.get('type')
            
            # Handle tool type messages
            if msg_type == 'tool':
                tool_name = content.get('name') or content.get('tool_name') or 'unknown'
                tool_counts[tool_name] = tool_counts.get(tool_name, 0) + 1
                if tool_name not in tool_threads:
                    tool_threads[tool_name] = set()
                tool_threads[tool_name].add(thread_id)
                threads_with_tools.add(thread_id)
                total_tool_calls += 1
            
            # Handle assistant messages with tool_calls
            elif msg_type == 'assistant' and isinstance(content, dict):
                tool_calls = content.get('tool_calls', [])
                if isinstance(tool_calls, list):
                    for tool_call in tool_calls:
                        if isinstance(tool_call, dict):
                            func = tool_call.get('function', {})
                            tool_name = func.get('name') if isinstance(func, dict) else None
                            if tool_name:
                                tool_counts[tool_name] = tool_counts.get(tool_name, 0) + 1
                                if tool_name not in tool_threads:
                                    tool_threads[tool_name] = set()
                                tool_threads[tool_name].add(thread_id)
                                threads_with_tools.add(thread_id)
                                total_tool_calls += 1
        
        # Get total threads for today to calculate adoption rate
        threads_result = await client.from_('threads').select(
            '*', count='exact'
        ).gte('created_at', today_start.isoformat()).lt('created_at', today_end.isoformat()).execute()
        total_threads = threads_result.count or 0
        
        # Build top tools list
        top_tools: List[ToolUsage] = []
        for tool_name, count in sorted(tool_counts.items(), key=lambda x: x[1], reverse=True)[:10]:
            unique_threads = len(tool_threads.get(tool_name, set()))
            percentage = (unique_threads / total_threads * 100) if total_threads > 0 else 0.0
            top_tools.append(ToolUsage(
                tool_name=tool_name,
                usage_count=count,
                unique_threads=unique_threads,
                percentage_of_threads=round(percentage, 1),
            ))
        
        # Tool adoption rate (% of threads using any tool)
        tool_adoption_rate = (len(threads_with_tools) / total_threads * 100) if total_threads > 0 else 0.0

        return ToolAdoptionSummary(
            total_tool_calls=total_tool_calls,
            total_threads_with_tools=len(threads_with_tools),
            top_tools=top_tools,
            tool_adoption_rate=round(tool_adoption_rate, 1),
        )

    except Exception as e:
        logger.error(f"Failed to get tool adoption: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to get tool adoption")


# ============================================================================
# PROFITABILITY ENDPOINT
# ============================================================================

# Display names for tiers
TIER_DISPLAY_NAMES: Dict[str, str] = {
    'none': 'No Plan',
    'free': 'Basic',
    'tier_2_20': 'Plus',
    'tier_6_50': 'Pro',
    'tier_25_200': 'Ultra',
    'tier_2_20_yearly': 'Plus (Yearly)',
    'tier_6_50_yearly': 'Pro (Yearly)',
    'tier_25_200_yearly': 'Ultra (Yearly)',
    'tier_12_100': 'Legacy Pro',
    'tier_50_400': 'Legacy Business',
    'tier_125_800': 'Legacy Enterprise',
    'tier_200_1000': 'Legacy Enterprise Plus',
    'tier_150_1200': 'Legacy Enterprise Max',
}

# Token price multiplier (markup applied to LLM costs)
from core.billing.shared.config import TOKEN_PRICE_MULTIPLIER


def _infer_tier_from_amount(amount_cents: int) -> str:
    """Infer tier from payment amount in cents."""
    amount_dollars = amount_cents / 100
    # Map common amounts to tiers (with some tolerance for cents)
    amount_to_tier = {
        20: 'tier_2_20',
        50: 'tier_6_50',
        200: 'tier_25_200',
        # Yearly plans (full year payment)
        204: 'tier_2_20_yearly',
        504: 'tier_6_50_yearly',
        2040: 'tier_25_200_yearly',
        # Monthly equivalent for yearly commitment
        17: 'tier_2_20_yearly',
        42: 'tier_6_50_yearly',
        170: 'tier_25_200_yearly',
        # Legacy tiers
        100: 'tier_12_100',
        400: 'tier_50_400',
        800: 'tier_125_800',
        1000: 'tier_200_1000',
        1200: 'tier_150_1200',
    }
    # Find closest match
    closest = min(amount_to_tier.keys(), key=lambda x: abs(x - amount_dollars))
    if abs(closest - amount_dollars) < 5:  # Within $5 tolerance
        return amount_to_tier[closest]
    return 'unknown'


# Semaphore to limit concurrent Stripe API calls (avoid rate limiting)
_stripe_semaphore = asyncio.Semaphore(10)


async def _fetch_stripe_revenue_for_day(day_start_ts: int, day_end_ts: int) -> Dict[str, Any]:
    """
    Fetch Stripe charges for a single day.
    Helper function for parallel fetching.
    """
    async with _stripe_semaphore:
        day_results: Dict[str, Any] = {
            'total_revenue': 0.0,
            'payment_count': 0,
            'by_tier': {},
            'user_revenue': {},
            'user_tiers': {},
            'user_emails': {},  # customer_id -> email
        }

        try:
            # Fetch charges for this day - single API call with limit
            # Most days won't have more than 100 charges
            # expand customer to get email, invoice.subscription to get tier metadata
            charges = await stripe.Charge.list_async(
                created={'gte': day_start_ts, 'lt': day_end_ts},
                limit=100,
                expand=['data.customer', 'data.invoice.subscription'],
            )

            # Process all charges from the response
            all_charges = list(charges.data)

            # If there's more data, fetch additional pages (rare for single day)
            while charges.has_more and len(all_charges) < 500:
                charges = await stripe.Charge.list_async(
                    created={'gte': day_start_ts, 'lt': day_end_ts},
                    limit=100,
                    starting_after=all_charges[-1].id,
                    expand=['data.customer', 'data.invoice.subscription'],
                )
                all_charges.extend(charges.data)

            # Helper to get tier from subscription via price_id
            def _get_tier_from_subscription(subscription) -> tuple[str, bool]:
                """Returns (tier_name, is_yearly) from subscription price_id."""
                from core.billing.shared.config import get_tier_by_price_id, get_price_type
                if not subscription:
                    return ('unknown', False)
                try:
                    # Use dict-style access for Stripe objects (subscription['items'] not subscription.items)
                    items = subscription['items'] if 'items' in subscription else None
                    if items:
                        items_data = items.get('data', []) if hasattr(items, 'get') else items['data']
                        for item in items_data:
                            price = item.get('price') if hasattr(item, 'get') else item['price']
                            if price:
                                price_id = price.get('id') if hasattr(price, 'get') else price['id']
                                if price_id:
                                    tier_obj = get_tier_by_price_id(price_id)
                                    if tier_obj:
                                        price_type = get_price_type(price_id)
                                        is_yearly = price_type in ('yearly', 'yearly_commitment')
                                        return (tier_obj.name, is_yearly)
                except Exception as e:
                    logger.debug(f"Error getting tier from subscription: {e}")
                return ('unknown', False)

            for charge in all_charges:
                if not charge.paid or charge.refunded or charge.amount <= 0:
                    continue

                amount = charge.amount / 100
                customer = charge.customer
                customer_id = 'unknown'
                customer_email = None

                if customer:
                    if hasattr(customer, 'id'):
                        # Expanded customer object
                        customer_id = customer.id
                        customer_email = getattr(customer, 'email', None)
                    else:
                        # Just the customer ID string
                        customer_id = customer

                tier = 'unknown'
                is_yearly = False
                metadata = getattr(charge, 'metadata', None) or {}

                if metadata.get('type') == 'credit_purchase':
                    tier = 'credit_purchase'
                else:
                    tier = metadata.get('tier', 'unknown')

                    # Try to get tier from subscription via invoice (if expanded)
                    if tier == 'unknown':
                        invoice = getattr(charge, 'invoice', None)
                        if invoice and hasattr(invoice, 'subscription'):
                            subscription = invoice.subscription
                            tier, is_yearly = _get_tier_from_subscription(subscription)

                    # If still unknown, try via checkout session lookup
                    if tier == 'unknown':
                        payment_intent_id = getattr(charge, 'payment_intent', None)
                        if payment_intent_id:
                            try:
                                sessions = await stripe.checkout.Session.list_async(
                                    payment_intent=payment_intent_id, limit=1
                                )
                                if sessions.data:
                                    session = sessions.data[0]
                                    sub_id = getattr(session, 'subscription', None)
                                    if sub_id:
                                        subscription = await stripe.Subscription.retrieve_async(sub_id)
                                        tier, is_yearly = _get_tier_from_subscription(subscription)
                            except Exception as e:
                                logger.debug(f"Error looking up checkout session: {e}")

                    # If still unknown and we have an invoice ID, fetch it directly
                    if tier == 'unknown':
                        invoice = getattr(charge, 'invoice', None)
                        if invoice and isinstance(invoice, str):
                            try:
                                invoice_obj = await stripe.Invoice.retrieve_async(invoice, expand=['subscription'])
                                if invoice_obj.subscription:
                                    tier, is_yearly = _get_tier_from_subscription(invoice_obj.subscription)
                            except Exception as e:
                                logger.debug(f"Error fetching invoice: {e}")

                    # Append _yearly if determined
                    if tier != 'unknown' and is_yearly and not tier.endswith('_yearly'):
                        tier = tier + '_yearly'

                    # Fallback to amount inference
                    if tier == 'unknown':
                        tier = _infer_tier_from_amount(charge.amount)

                if tier == 'free':
                    continue

                day_results['total_revenue'] += amount
                day_results['payment_count'] += 1

                if tier not in day_results['by_tier']:
                    day_results['by_tier'][tier] = {'revenue': 0.0, 'count': 0, 'users': set()}
                day_results['by_tier'][tier]['revenue'] += amount
                day_results['by_tier'][tier]['count'] += 1
                day_results['by_tier'][tier]['users'].add(customer_id)

                day_results['user_revenue'][customer_id] = day_results['user_revenue'].get(customer_id, 0) + amount
                day_results['user_tiers'][customer_id] = tier
                if customer_email:
                    day_results['user_emails'][customer_id] = customer_email

        except stripe.StripeError as e:
            logger.error(f"Stripe API error fetching revenue for day (ts {day_start_ts}-{day_end_ts}): {e}")
            # Re-raise so asyncio.gather can track it as a failure
            raise

        return day_results


async def _fetch_stripe_revenue(start_ts: int, end_ts: int) -> Dict[str, Any]:
    """
    Fetch actual revenue from Stripe Charges for a date range.
    Uses Charges (not Invoices) because they represent actual money collected after coupons/discounts.
    Returns revenue by tier with customer mapping.

    Optimized: Fetches daily chunks in parallel for faster performance on large date ranges.
    """
    stripe.api_key = config.STRIPE_SECRET_KEY

    results: Dict[str, Any] = {
        'total_revenue': 0.0,
        'payment_count': 0,
        'by_tier': {},
        'user_revenue': {},
        'user_tiers': {},
        'user_emails': {},  # customer_id -> email
    }

    # Split into daily chunks for parallel fetching
    day_seconds = 86400  # 24 * 60 * 60
    daily_tasks = []
    day_timestamps = []  # Track timestamps for logging
    current_ts = start_ts

    while current_ts < end_ts:
        day_end = min(current_ts + day_seconds, end_ts)
        daily_tasks.append(_fetch_stripe_revenue_for_day(current_ts, day_end))
        day_timestamps.append((current_ts, day_end))
        current_ts = day_end

    logger.info(f"Stripe revenue: fetching {len(daily_tasks)} days in parallel (ts range: {start_ts} to {end_ts})")

    # Fetch all days in parallel
    if daily_tasks:
        day_results_list = await asyncio.gather(*daily_tasks, return_exceptions=True)

        # Retry failed days (up to 2 retries each)
        failed_indices = []
        for idx, day_results in enumerate(day_results_list):
            if isinstance(day_results, Exception):
                failed_indices.append(idx)

        if failed_indices:
            logger.warning(f"Stripe revenue: {len(failed_indices)} days failed, retrying...")
            for retry in range(2):  # Up to 2 retries
                if not failed_indices:
                    break
                retry_tasks = [_fetch_stripe_revenue_for_day(*day_timestamps[idx]) for idx in failed_indices]
                retry_results = await asyncio.gather(*retry_tasks, return_exceptions=True)

                still_failed = []
                for i, (idx, result) in enumerate(zip(failed_indices, retry_results)):
                    if isinstance(result, Exception):
                        still_failed.append(idx)
                    else:
                        day_results_list[idx] = result
                        logger.info(f"Stripe revenue: day {idx} succeeded on retry {retry + 1}")

                failed_indices = still_failed
                if failed_indices:
                    await asyncio.sleep(1)  # Brief pause before next retry

        # Merge results from all days
        successful_days = 0
        failed_days = 0
        for idx, day_results in enumerate(day_results_list):
            if isinstance(day_results, Exception):
                failed_days += 1
                ts_start, ts_end = day_timestamps[idx] if idx < len(day_timestamps) else (0, 0)
                logger.error(f"Error fetching day {idx} revenue (ts {ts_start}-{ts_end}): {day_results}")
                continue

            successful_days += 1
            results['total_revenue'] += day_results['total_revenue']
            results['payment_count'] += day_results['payment_count']

            # Merge by_tier
            for tier, data in day_results['by_tier'].items():
                if tier not in results['by_tier']:
                    results['by_tier'][tier] = {'revenue': 0.0, 'count': 0, 'users': set()}
                results['by_tier'][tier]['revenue'] += data['revenue']
                results['by_tier'][tier]['count'] += data['count']
                results['by_tier'][tier]['users'].update(data['users'])

            # Merge user_revenue
            for customer_id, revenue in day_results['user_revenue'].items():
                results['user_revenue'][customer_id] = results['user_revenue'].get(customer_id, 0) + revenue

            # Merge user_tiers (last tier wins for a user across days)
            results['user_tiers'].update(day_results['user_tiers'])

            # Merge user_emails
            results['user_emails'].update(day_results.get('user_emails', {}))

        logger.info(f"Stripe revenue fetch complete: {successful_days} days succeeded, {failed_days} days failed, total=${results['total_revenue']:.2f}")

    return results


async def _fetch_revenuecat_active_subscriptions() -> int:
    """
    Fetch active subscription count from RevenueCat API.
    Returns the number of active subscriptions.
    """
    if not config.REVENUECAT_API_KEY or not config.REVENUECAT_PROJECT_ID:
        logger.warning("RevenueCat API key or project ID not configured, returning 0")
        return 0

    url = f"https://api.revenuecat.com/v2/projects/{config.REVENUECAT_PROJECT_ID}/metrics/overview"

    try:
        async with httpx.AsyncClient() as client:
            response = await client.get(
                url,
                headers={
                    "Authorization": f"Bearer {config.REVENUECAT_API_KEY}",
                    "Content-Type": "application/json"
                },
                timeout=10.0
            )
            response.raise_for_status()
            data = response.json()

            # Find active_subscriptions metric
            for metric in data.get('metrics', []):
                if metric.get('id') == 'active_subscriptions':
                    count = metric.get('value', 0)
                    logger.info(f"RevenueCat active subscriptions: {count}")
                    return int(count)

            logger.warning("active_subscriptions metric not found in RevenueCat response")
            return 0

    except Exception as e:
        logger.error(f"Failed to fetch RevenueCat active subscriptions: {e}")
        return 0


async def _fetch_revenuecat_revenue(client, range_start: datetime, range_end: datetime) -> Dict[str, Any]:
    """
    Fetch RevenueCat revenue from webhook_events using RPC.
    Returns revenue by tier with user emails.
    """
    results: Dict[str, Any] = {
        'total_revenue': 0.0,
        'payment_count': 0,
        'by_tier': {},  # tier -> {'revenue': float, 'count': int, 'users': set}
        'user_emails': [],  # List of paying user emails
    }

    try:
        # Use RPC for efficient aggregation with email lookup
        rpc_result = await client.rpc('get_revenuecat_revenue_by_tier', {
            'start_date': range_start.isoformat(),
            'end_date': range_end.isoformat()
        }).execute()

        for row in (rpc_result.data or []):
            tier = row.get('tier', 'unknown')
            revenue = float(row.get('total_revenue', 0))
            count = row.get('payment_count', 0)
            users = row.get('unique_users', 0)
            emails = row.get('user_emails') or []

            results['total_revenue'] += revenue
            results['payment_count'] += count
            results['by_tier'][tier] = {
                'revenue': revenue,
                'count': count,
                'users': set(range(users)),  # Placeholder set with correct size for len()
            }
            results['user_emails'].extend(emails)

    except Exception as e:
        logger.error(f"Error fetching RevenueCat revenue: {e}", exc_info=True)

    return results


@router.get("/profitability")
async def get_profitability(
    date_from: Optional[str] = Query(None, description="Start date YYYY-MM-DD"),
    date_to: Optional[str] = Query(None, description="End date YYYY-MM-DD"),
    admin: dict = Depends(require_super_admin)
) -> ProfitabilitySummary:
    """
    Get profitability metrics broken down by tier and platform.

    Fetches ACTUAL revenue from:
    - Stripe: Paid invoices and credit purchases
    - RevenueCat: Payment events from webhook_events table

    Calculates:
    - Revenue: Actual payments received in the date range
    - Cost: Sum of LLM usage costs from credit_ledger (with markup)
    - Actual Cost: LLM costs before markup (what we pay providers)
    - Profit: Revenue - Actual Cost

    Super admin only due to sensitive financial data.
    """
    try:
        db = DBConnection()
        client = await db.client

        # Parse date range
        start_date, end_date = parse_date_range(None, date_from, date_to)
        range_start = start_date.replace(hour=0, minute=0, second=0, microsecond=0)
        range_end = end_date.replace(hour=23, minute=59, second=59, microsecond=999999)

        # Use UTC for Stripe queries to match Stripe dashboard analytics
        UTC = ZoneInfo('UTC')
        range_start_utc = datetime(start_date.year, start_date.month, start_date.day, 0, 0, 0, tzinfo=UTC)
        range_end_utc = datetime(end_date.year, end_date.month, end_date.day, 23, 59, 59, tzinfo=UTC)
        start_ts = int(range_start_utc.timestamp())
        end_ts = int(range_end_utc.timestamp())

        # 1. Fetch actual revenue from Stripe and RevenueCat (both use UTC)
        stripe_revenue, revenuecat_revenue = await asyncio.gather(
            _fetch_stripe_revenue(start_ts, end_ts),
            _fetch_revenuecat_revenue(client, range_start_utc, range_end_utc)
        )

        logger.info(f"Stripe revenue: ${stripe_revenue['total_revenue']:.2f} ({stripe_revenue['payment_count']} payments)")
        logger.info(f"RevenueCat revenue: ${revenuecat_revenue['total_revenue']:.2f} ({revenuecat_revenue['payment_count']} payments)")

        # 2. Get usage costs by tier using RPC (efficient single query instead of fetching 278k+ accounts)
        usage_costs_result = await client.rpc('get_usage_costs_by_tier', {
            'start_date': range_start_utc.isoformat(),
            'end_date': range_end_utc.isoformat()
        }).execute()

        usage_costs_by_tier: Dict[str, Dict] = {}
        for row in (usage_costs_result.data or []):
            tier = row.get('tier', 'unknown')
            provider = row.get('provider', 'stripe')
            user_count = row.get('user_count', 0)
            total_cost = float(row.get('total_cost', 0))

            if tier not in usage_costs_by_tier:
                usage_costs_by_tier[tier] = {
                    'total_cost': 0.0,
                    'user_count': 0,
                    'provider': provider,
                }
            usage_costs_by_tier[tier]['total_cost'] += total_cost
            usage_costs_by_tier[tier]['user_count'] += user_count

        logger.info(f"Usage costs fetched for {len(usage_costs_by_tier)} tiers via RPC")

        # 3. Build tier metrics combining revenue and costs
        # Combine Stripe and RevenueCat tier data
        all_tiers = set(stripe_revenue['by_tier'].keys()) | set(revenuecat_revenue['by_tier'].keys()) | set(usage_costs_by_tier.keys())

        tier_metrics: Dict[str, Dict] = {}
        for tier in all_tiers:
            tier_metrics[tier] = {
                'stripe_revenue': stripe_revenue['by_tier'].get(tier, {}).get('revenue', 0),
                'stripe_count': stripe_revenue['by_tier'].get(tier, {}).get('count', 0),
                'stripe_users': stripe_revenue['by_tier'].get(tier, {}).get('users', set()),
                'revenuecat_revenue': revenuecat_revenue['by_tier'].get(tier, {}).get('revenue', 0),
                'revenuecat_count': revenuecat_revenue['by_tier'].get(tier, {}).get('count', 0),
                'revenuecat_users': revenuecat_revenue['by_tier'].get(tier, {}).get('users', set()),
                'total_cost': usage_costs_by_tier.get(tier, {}).get('total_cost', 0.0),
                'cost_only_users': usage_costs_by_tier.get(tier, {}).get('user_count', 0),
            }

        logger.info(f"Tier metrics built for {len(tier_metrics)} tiers")

        # 5. Build profitability response
        by_tier: List[TierProfitability] = []
        total_revenue = 0.0
        total_cost = 0.0
        total_actual_cost = 0.0
        total_payments = 0
        all_paying_users: set = set()

        web_revenue = 0.0
        web_cost = 0.0
        app_revenue = 0.0
        app_cost = 0.0
        free_tier_cost = 0.0  # Track free tier cost separately

        for tier, metrics in tier_metrics.items():
            # Calculate totals for this tier
            stripe_rev = metrics['stripe_revenue']
            rc_rev = metrics['revenuecat_revenue']
            tier_revenue = stripe_rev + rc_rev
            cost_with_markup = metrics['total_cost']

            stripe_count = metrics['stripe_count']
            rc_count = metrics['revenuecat_count']
            payment_count = stripe_count + rc_count

            stripe_users = metrics['stripe_users']
            rc_users = metrics['revenuecat_users']
            unique_users = len(stripe_users | rc_users)

            display_name = TIER_DISPLAY_NAMES.get(tier, tier)
            if tier == 'credit_purchase':
                display_name = 'Credit Purchases'

            # Calculate actual cost (remove markup)
            actual_cost = float(cost_with_markup / float(TOKEN_PRICE_MULTIPLIER))

            # Calculate profit
            gross_profit = tier_revenue - actual_cost
            gross_margin = (gross_profit / tier_revenue * 100) if tier_revenue > 0 else 0.0

            # Per-user averages
            avg_cost = cost_with_markup / unique_users if unique_users > 0 else 0.0
            avg_revenue = tier_revenue / unique_users if unique_users > 0 else 0.0
            avg_profit = gross_profit / unique_users if unique_users > 0 else 0.0

            # Determine primary provider for this tier entry
            provider = 'stripe' if stripe_rev >= rc_rev else 'revenuecat'

            # Get usage users count from RPC data
            usage_users_count = metrics.get('cost_only_users', 0)

            # Add separate entries for each provider if both have data
            if stripe_rev > 0:
                by_tier.append(TierProfitability(
                    tier=tier,
                    display_name=display_name,
                    provider='stripe',
                    payment_count=stripe_count,
                    unique_users=len(stripe_users),
                    usage_users=usage_users_count,
                    total_revenue=round(stripe_rev, 2),
                    total_cost=round(cost_with_markup * (stripe_rev / tier_revenue) if tier_revenue > 0 else 0, 2),
                    total_actual_cost=round(actual_cost * (stripe_rev / tier_revenue) if tier_revenue > 0 else 0, 2),
                    gross_profit=round(stripe_rev - (actual_cost * (stripe_rev / tier_revenue) if tier_revenue > 0 else 0), 2),
                    gross_margin_percent=round(gross_margin, 1),
                    avg_cost_per_user=round(avg_cost, 2),
                    avg_revenue_per_user=round(stripe_rev / len(stripe_users) if stripe_users else 0, 2),
                    avg_profit_per_user=round(avg_profit, 2),
                ))
                web_revenue += stripe_rev

            if rc_rev > 0:
                by_tier.append(TierProfitability(
                    tier=tier,
                    display_name=display_name,
                    provider='revenuecat',
                    payment_count=rc_count,
                    unique_users=len(rc_users),
                    usage_users=usage_users_count,
                    total_revenue=round(rc_rev, 2),
                    total_cost=round(cost_with_markup * (rc_rev / tier_revenue) if tier_revenue > 0 else 0, 2),
                    total_actual_cost=round(actual_cost * (rc_rev / tier_revenue) if tier_revenue > 0 else 0, 2),
                    gross_profit=round(rc_rev - (actual_cost * (rc_rev / tier_revenue) if tier_revenue > 0 else 0), 2),
                    gross_margin_percent=round(gross_margin, 1),
                    avg_cost_per_user=round(avg_cost, 2),
                    avg_revenue_per_user=round(rc_rev / len(rc_users) if rc_users else 0, 2),
                    avg_profit_per_user=round(avg_profit, 2),
                ))
                app_revenue += rc_rev

            # Handle cost-only tiers (free tier, etc.) - no revenue but have costs
            if tier_revenue == 0 and actual_cost > 0:
                num_users = metrics.get('cost_only_users', 0) or 1
                by_tier.append(TierProfitability(
                    tier=tier,
                    display_name=display_name,
                    provider='stripe',  # Default to stripe for free tier
                    payment_count=0,
                    unique_users=num_users,
                    usage_users=num_users,
                    total_revenue=0,
                    total_cost=round(cost_with_markup, 2),
                    total_actual_cost=round(actual_cost, 2),
                    gross_profit=round(-actual_cost, 2),  # Negative profit (loss)
                    gross_margin_percent=0,  # No margin on free tier
                    avg_cost_per_user=round(actual_cost / num_users, 2),
                    avg_revenue_per_user=0,
                    avg_profit_per_user=round(-actual_cost / num_users, 2),
                ))
                # Track free tier cost separately
                free_tier_cost += actual_cost

            # Aggregate totals
            total_revenue += tier_revenue
            total_cost += cost_with_markup
            total_actual_cost += actual_cost
            total_payments += payment_count
            all_paying_users.update(stripe_users)
            all_paying_users.update(rc_users)

        # Calculate web/app costs proportionally for paid tiers, then add free tier cost to web
        if total_revenue > 0:
            paid_cost = total_actual_cost - free_tier_cost  # Cost attributable to paid tiers
            web_cost = paid_cost * (web_revenue / total_revenue) + free_tier_cost  # Add free tier to web
            app_cost = paid_cost * (app_revenue / total_revenue)
        else:
            # All costs are from free tier
            web_cost = free_tier_cost
            app_cost = 0.0

        # Sort by revenue descending (free tier will be at bottom)
        by_tier.sort(key=lambda x: x.total_revenue, reverse=True)

        # Calculate totals
        total_gross_profit = total_revenue - total_actual_cost
        total_margin = (total_gross_profit / total_revenue * 100) if total_revenue > 0 else 0.0

        # User counts
        unique_paying_users = len(all_paying_users)
        unique_active_users = sum(t.get('user_count', 0) for t in usage_costs_by_tier.values())  # Users who had usage

        # Per-paying-user metrics (consistent denominator for Revenue/Cost/Profit per user)
        avg_revenue_per_paid_user = total_revenue / unique_paying_users if unique_paying_users > 0 else 0.0
        avg_cost_per_active_user = total_actual_cost / unique_paying_users if unique_paying_users > 0 else 0.0

        # Collect emails from Stripe customers
        stripe_user_emails = stripe_revenue.get('user_emails', {})
        paying_user_emails = [
            email for customer_id, email in stripe_user_emails.items()
            if email and customer_id in all_paying_users
        ]
        # Sort by email for consistency
        paying_user_emails.sort()

        active_subs_result, revenuecat_active_subs = await asyncio.gather(
            client.rpc('get_active_subscription_counts').execute(),
            _fetch_revenuecat_active_subscriptions()
        )
        active_subs_data = active_subs_result.data[0] if active_subs_result.data else {}
        stripe_active_subs = active_subs_data.get('stripe_paid', 0) or 0
        total_active_subs = stripe_active_subs + revenuecat_active_subs

        return ProfitabilitySummary(
            total_revenue=round(total_revenue, 2),
            total_cost=round(total_cost, 2),
            total_actual_cost=round(total_actual_cost, 2),
            gross_profit=round(total_gross_profit, 2),
            gross_margin_percent=round(total_margin, 1),
            by_tier=by_tier,
            web_revenue=round(web_revenue, 2),
            web_cost=round(web_cost, 2),
            web_profit=round(web_revenue - web_cost, 2),
            app_revenue=round(app_revenue, 2),
            app_cost=round(app_cost, 2),
            app_profit=round(app_revenue - app_cost, 2),
            avg_revenue_per_paid_user=round(avg_revenue_per_paid_user, 2),
            avg_cost_per_active_user=round(avg_cost_per_active_user, 2),
            unique_paying_users=unique_paying_users,
            unique_active_users=unique_active_users,
            paying_user_emails=paying_user_emails,
            period_start=range_start.strftime('%Y-%m-%d'),
            period_end=range_end.strftime('%Y-%m-%d'),
            total_payments=total_payments,
            total_active_subscriptions=total_active_subs,
            stripe_active_subscriptions=stripe_active_subs,
            revenuecat_active_subscriptions=revenuecat_active_subs,
        )

    except Exception as e:
        logger.error(f"Failed to get profitability: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to get profitability data")


# ============================================================================
# CONVERSATION ANALYTICS ENDPOINTS
# ============================================================================

class ConversationInsight(BaseModel):
    """Aggregated insights from conversation analytics."""
    sentiment_distribution: Dict[str, int]  # {"positive": 45, "neutral": 30, "negative": 25}
    avg_frustration: float
    feature_request_count: int
    total_analyzed: int
    intent_distribution: Dict[str, int]  # {"task": 100, "question": 50, ...}


class ConversationAnalyticsItem(BaseModel):
    """Single conversation analytics record."""
    id: str
    thread_id: str
    account_id: str
    user_email: Optional[str] = None
    sentiment_label: Optional[str] = None
    frustration_score: Optional[float] = None
    frustration_signals: List[str] = []
    intent_type: Optional[str] = None
    is_feature_request: bool = False
    feature_request_text: Optional[str] = None
    use_case_category: Optional[str] = None
    first_user_message: Optional[str] = None
    user_message_count: Optional[int] = None
    analyzed_at: datetime


@router.get("/conversations/insights")
async def get_conversation_insights(
    date_from: Optional[str] = Query(None, description="Start date YYYY-MM-DD"),
    date_to: Optional[str] = Query(None, description="End date YYYY-MM-DD"),
    admin: dict = Depends(require_super_admin)
) -> ConversationInsight:
    """
    Get aggregated insights from analyzed conversations.

    Returns:
    - Sentiment distribution (positive/neutral/negative/mixed counts)
    - Average frustration and churn risk scores
    - Top topics by frequency
    - Feature request count
    """
    try:
        db = DBConnection()
        client = await db.client

        rpc_params = {}
        if date_from:
            rpc_params['p_date_from'] = f"{date_from}T00:00:00Z"
        if date_to:
            rpc_params['p_date_to'] = f"{date_to}T23:59:59Z"

        result = await client.rpc('get_conversation_insights', rpc_params).execute()
        data = result.data

        if not data:
            return ConversationInsight(
                sentiment_distribution={"positive": 0, "neutral": 0, "negative": 0, "mixed": 0},
                avg_frustration=0.0,
                feature_request_count=0,
                total_analyzed=0,
                intent_distribution={"task": 0, "question": 0, "complaint": 0, "feature_request": 0}
            )

        return ConversationInsight(
            sentiment_distribution=data.get('sentiment_distribution', {"positive": 0, "neutral": 0, "negative": 0, "mixed": 0}),
            avg_frustration=float(data.get('avg_frustration', 0)),
            feature_request_count=data.get('feature_request_count', 0),
            total_analyzed=data.get('total_analyzed', 0),
            intent_distribution=data.get('intent_distribution', {"task": 0, "question": 0, "complaint": 0, "feature_request": 0})
        )

    except Exception as e:
        logger.error(f"Failed to get conversation insights: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to get conversation insights")


@router.get("/conversations/frustrated")
async def get_frustrated_conversations(
    threshold: float = Query(0.5, ge=0, le=1, description="Frustration score threshold"),
    page: int = Query(1, ge=1, description="Page number"),
    page_size: int = Query(20, ge=1, le=100, description="Items per page"),
    date_from: Optional[str] = Query(None, description="Start date YYYY-MM-DD"),
    date_to: Optional[str] = Query(None, description="End date YYYY-MM-DD"),
    admin: dict = Depends(require_super_admin)
) -> PaginatedResponse[ConversationAnalyticsItem]:
    """
    Get conversations with high frustration scores.

    Args:
        threshold: Minimum frustration score (0-1)
        page: Page number
        page_size: Items per page
        date_from: Optional start date filter
        date_to: Optional end date filter
    """
    try:
        db = DBConnection()
        client = await db.client

        # Build base query with date filters
        count_query = client.from_('conversation_analytics')\
            .select('id', count='exact')\
            .gte('frustration_score', threshold)

        if date_from:
            count_query = count_query.gte('analyzed_at', f"{date_from}T00:00:00")
        if date_to:
            count_query = count_query.lte('analyzed_at', f"{date_to}T23:59:59")

        count_result = await count_query.limit(1).execute()
        total_items = count_result.count or 0

        # Get paginated data with date filters
        offset = (page - 1) * page_size
        data_query = client.from_('conversation_analytics')\
            .select('*')\
            .gte('frustration_score', threshold)

        if date_from:
            data_query = data_query.gte('analyzed_at', f"{date_from}T00:00:00")
        if date_to:
            data_query = data_query.lte('analyzed_at', f"{date_to}T23:59:59")

        result = await data_query\
            .order('frustration_score', desc=True)\
            .range(offset, offset + page_size - 1)\
            .execute()

        records = result.data or []

        # Fetch user emails via billing_customers first (fast batch query)
        account_ids = list(set(r.get('account_id') for r in records if r.get('account_id')))
        email_map = {}
        if account_ids:
            try:
                # First try billing_customers (fast path for users with billing)
                billing_result = await client.schema('basejump').from_('billing_customers')\
                    .select('account_id, email')\
                    .in_('account_id', account_ids)\
                    .execute()

                email_map = {e['account_id']: e['email'] for e in (billing_result.data or []) if e.get('email')}

                # For accounts without billing email, get from auth.users via RPC
                missing_account_ids = [aid for aid in account_ids if aid not in email_map]
                if missing_account_ids:
                    accounts_result = await client.schema('basejump').from_('accounts')\
                        .select('id, primary_owner_user_id')\
                        .in_('id', missing_account_ids)\
                        .execute()

                    for acc in (accounts_result.data or []):
                        if acc.get('primary_owner_user_id'):
                            try:
                                email_rpc = await client.rpc('get_user_email', {'user_id': acc['primary_owner_user_id']}).execute()
                                if email_rpc.data:
                                    email_map[acc['id']] = email_rpc.data
                            except Exception:
                                pass
            except Exception as e:
                logger.warning(f"Failed to fetch user emails: {e}")

        # Build response items
        items = []
        for r in records:
            frustration_signals = r.get('frustration_signals', [])
            if isinstance(frustration_signals, str):
                import json as json_lib
                try:
                    frustration_signals = json_lib.loads(frustration_signals)
                except Exception:
                    frustration_signals = []

            items.append(ConversationAnalyticsItem(
                id=r['id'],
                thread_id=r['thread_id'],
                account_id=r['account_id'],
                user_email=email_map.get(r['account_id']),
                sentiment_label=r.get('sentiment_label'),
                frustration_score=r.get('frustration_score'),
                frustration_signals=frustration_signals,
                intent_type=r.get('intent_type'),
                is_feature_request=r.get('is_feature_request', False),
                feature_request_text=r.get('feature_request_text'),
                user_message_count=r.get('user_message_count'),
                analyzed_at=r['analyzed_at']
            ))

        pagination_params = PaginationParams(page=page, page_size=page_size)
        return await PaginationService.paginate_with_total_count(items, total_items, pagination_params)

    except Exception as e:
        logger.error(f"Failed to get frustrated conversations: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to get frustrated conversations")


class RFMEngagementResponse(BaseModel):
    """RFM engagement scoring response."""
    rfm_score: str  # "5-4-3" format
    recency_score: int
    frequency_score: int
    monetary_score: int
    churn_risk: float
    segment: str
    days_since_last_activity: int
    runs_in_period: int
    total_conversations: int


@router.get("/conversations/engagement/{account_id}")
async def get_account_engagement(
    account_id: str,
    days: int = Query(30, ge=7, le=90, description="Period in days for analysis"),
    admin: dict = Depends(require_super_admin)
) -> RFMEngagementResponse:
    """
    Get RFM-based engagement score for an account.

    RFM (Recency, Frequency, Monetary) is a proven customer segmentation model.
    Each dimension is scored 1-5 (5 = best).

    Segments:
    - champion: High R, high F (active power users)
    - loyal: High overall RFM
    - potential: Medium RFM (room to grow)
    - new_user: High R, low F (just started)
    - at_risk: Low R, high F (was active, now gone)
    - cant_lose: Low R, low F, high M (valuable but leaving)
    - hibernating: Low R, low F (inactive)
    - needs_attention: Medium-low RFM
    - about_to_sleep: Low RFM
    """
    try:
        from core.analytics.conversation_analyzer import calculate_rfm_engagement

        result = await calculate_rfm_engagement(account_id, days)
        return RFMEngagementResponse(**result)

    except Exception as e:
        logger.error(f"Failed to get engagement for account {account_id}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to get account engagement")


class AccountEngagementItem(BaseModel):
    """Account with RFM engagement data."""
    account_id: str
    user_email: Optional[str] = None
    rfm_score: str
    recency_score: int
    frequency_score: int
    monetary_score: int
    churn_risk: float
    segment: str
    days_since_last_activity: int
    runs_in_period: int


class RFMEngagementSummary(BaseModel):
    """Summary of RFM engagement across all accounts."""
    total_accounts: int
    segments: Dict[str, int]
    at_risk_accounts: List[AccountEngagementItem]
    avg_churn_risk: float


@router.get("/conversations/engagement-summary")
async def get_rfm_engagement_summary(
    days: int = Query(30, ge=7, le=90, description="Period in days"),
    limit: int = Query(20, ge=1, le=100, description="Max at-risk accounts to return"),
    admin: dict = Depends(require_super_admin)
) -> RFMEngagementSummary:
    """
    Get engagement summary across all active accounts.

    Returns:
    - Segment distribution (how many accounts in each segment)
    - Top at-risk accounts (sorted by churn risk)
    - Average churn risk across all accounts
    """
    try:
        from core.services.db import execute

        # All RFM calculation in SQL - returns only segment counts (no Python loops)
        segment_sql = """
        WITH account_stats AS (
            SELECT
                t.account_id,
                MAX(ar.started_at) as last_activity,
                COUNT(*) FILTER (WHERE ar.started_at > NOW() - MAKE_INTERVAL(days => :days)) as recent_runs,
                COALESCE(ca.tier, 'none') as tier
            FROM agent_runs ar
            JOIN threads t ON ar.thread_id = t.thread_id
            LEFT JOIN credit_accounts ca ON ca.account_id = t.account_id
            GROUP BY t.account_id, ca.tier
        ),
        percentiles AS (
            SELECT
                COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY recent_runs), 2) as p50,
                COALESCE(percentile_cont(0.75) WITHIN GROUP (ORDER BY recent_runs), 4) as p75,
                COALESCE(percentile_cont(0.9) WITHIN GROUP (ORDER BY recent_runs), 9) as p90
            FROM account_stats
        ),
        scored AS (
            SELECT
                s.account_id,
                -- Recency score
                CASE
                    WHEN EXTRACT(DAY FROM NOW() - s.last_activity) <= 1 THEN 5
                    WHEN EXTRACT(DAY FROM NOW() - s.last_activity) <= 3 THEN 4
                    WHEN EXTRACT(DAY FROM NOW() - s.last_activity) <= 7 THEN 3
                    WHEN EXTRACT(DAY FROM NOW() - s.last_activity) <= 14 THEN 2
                    ELSE 1
                END as recency_score,
                -- Frequency score (dynamic percentile-based)
                CASE
                    WHEN s.recent_runs >= p.p90 THEN 5
                    WHEN s.recent_runs >= p.p75 THEN 4
                    WHEN s.recent_runs > p.p50 THEN 3
                    WHEN s.recent_runs >= p.p50 THEN 2
                    ELSE 1
                END as frequency_score,
                -- Monetary score (tier-based)
                CASE s.tier
                    WHEN 'tier_25_200' THEN 5
                    WHEN 'tier_50_400' THEN 5
                    WHEN 'tier_125_800' THEN 5
                    WHEN 'tier_150_1200' THEN 5
                    WHEN 'tier_200_1000' THEN 5
                    WHEN 'tier_6_50' THEN 4
                    WHEN 'tier_12_100' THEN 4
                    WHEN 'tier_2_20' THEN 3
                    WHEN 'free' THEN 2
                    ELSE 1
                END as monetary_score
            FROM account_stats s
            CROSS JOIN percentiles p
        ),
        segmented AS (
            SELECT
                account_id,
                recency_score,
                frequency_score,
                monetary_score,
                ROUND((1 - ((recency_score + frequency_score + monetary_score) / 3.0 - 1) / 4)::numeric, 2) as churn_risk,
                CASE
                    WHEN recency_score >= 4 AND frequency_score >= 4 THEN 'champion'
                    WHEN recency_score >= 4 AND frequency_score >= 2 THEN 'loyal'
                    WHEN recency_score >= 3 AND frequency_score >= 3 THEN 'potential'
                    WHEN recency_score <= 2 AND frequency_score >= 3 THEN 'at_risk'
                    WHEN recency_score <= 2 AND frequency_score <= 2 THEN 'hibernating'
                    ELSE 'other'
                END as segment
            FROM scored
        )
        SELECT segment, COUNT(*) as count, SUM(churn_risk) as total_churn
        FROM segmented
        GROUP BY segment
        """
        segment_rows = await execute(segment_sql, {"days": days})

        segment_counts: Dict[str, int] = {}
        total_accounts = 0
        total_churn = 0.0
        for row in segment_rows:
            segment_counts[row['segment']] = row['count']
            total_accounts += row['count']
            total_churn += float(row['total_churn'] or 0)

        avg_churn = total_churn / total_accounts if total_accounts > 0 else 0.0

        # Separate query for at-risk accounts (limited, no full table scan)
        at_risk_sql = """
        WITH account_stats AS (
            SELECT
                t.account_id,
                MAX(ar.started_at) as last_activity,
                COUNT(*) FILTER (WHERE ar.started_at > NOW() - MAKE_INTERVAL(days => :days)) as recent_runs,
                COALESCE(ca.tier, 'none') as tier
            FROM agent_runs ar
            JOIN threads t ON ar.thread_id = t.thread_id
            LEFT JOIN credit_accounts ca ON ca.account_id = t.account_id
            GROUP BY t.account_id, ca.tier
        ),
        percentiles AS (
            SELECT
                COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY recent_runs), 2) as p50,
                COALESCE(percentile_cont(0.75) WITHIN GROUP (ORDER BY recent_runs), 4) as p75,
                COALESCE(percentile_cont(0.9) WITHIN GROUP (ORDER BY recent_runs), 9) as p90
            FROM account_stats
        ),
        scored AS (
            SELECT
                s.account_id,
                s.recent_runs,
                EXTRACT(DAY FROM NOW() - s.last_activity)::int as days_since_last,
                CASE
                    WHEN EXTRACT(DAY FROM NOW() - s.last_activity) <= 1 THEN 5
                    WHEN EXTRACT(DAY FROM NOW() - s.last_activity) <= 3 THEN 4
                    WHEN EXTRACT(DAY FROM NOW() - s.last_activity) <= 7 THEN 3
                    WHEN EXTRACT(DAY FROM NOW() - s.last_activity) <= 14 THEN 2
                    ELSE 1
                END as recency_score,
                CASE
                    WHEN s.recent_runs >= p.p90 THEN 5
                    WHEN s.recent_runs >= p.p75 THEN 4
                    WHEN s.recent_runs > p.p50 THEN 3
                    WHEN s.recent_runs >= p.p50 THEN 2
                    ELSE 1
                END as frequency_score,
                CASE s.tier
                    WHEN 'tier_25_200' THEN 5
                    WHEN 'tier_50_400' THEN 5
                    WHEN 'tier_125_800' THEN 5
                    WHEN 'tier_150_1200' THEN 5
                    WHEN 'tier_200_1000' THEN 5
                    WHEN 'tier_6_50' THEN 4
                    WHEN 'tier_12_100' THEN 4
                    WHEN 'tier_2_20' THEN 3
                    WHEN 'free' THEN 2
                    ELSE 1
                END as monetary_score
            FROM account_stats s
            CROSS JOIN percentiles p
        )
        SELECT
            account_id,
            days_since_last,
            recent_runs,
            recency_score,
            frequency_score,
            monetary_score,
            ROUND((1 - ((recency_score + frequency_score + monetary_score) / 3.0 - 1) / 4)::numeric, 2) as churn_risk,
            CASE
                WHEN recency_score >= 4 AND frequency_score >= 4 THEN 'champion'
                WHEN recency_score >= 4 AND frequency_score >= 2 THEN 'loyal'
                WHEN recency_score >= 3 AND frequency_score >= 3 THEN 'potential'
                WHEN recency_score <= 2 AND frequency_score >= 3 THEN 'at_risk'
                WHEN recency_score <= 2 AND frequency_score <= 2 THEN 'hibernating'
                ELSE 'other'
            END as segment
        FROM scored
        WHERE (1 - ((recency_score + frequency_score + monetary_score) / 3.0 - 1) / 4) >= 0.5
        ORDER BY (1 - ((recency_score + frequency_score + monetary_score) / 3.0 - 1) / 4) DESC
        LIMIT :limit
        """
        at_risk_rows = await execute(at_risk_sql, {"days": days, "limit": limit})

        # Fetch emails for at-risk accounts
        email_map = {}
        if at_risk_rows:
            try:
                db = DBConnection()
                client = await db.client
                account_ids = [str(row['account_id']) for row in at_risk_rows]

                # First try billing_customers (fast path for users with billing)
                billing_result = await client.schema('basejump').from_('billing_customers')\
                    .select('account_id, email')\
                    .in_('account_id', account_ids)\
                    .execute()

                email_map = {e['account_id']: e['email'] for e in (billing_result.data or [])}

                # For accounts without billing email, get from auth.users via RPC
                missing_account_ids = [aid for aid in account_ids if aid not in email_map]
                if missing_account_ids:
                    # Get primary_owner_user_id for missing accounts
                    accounts_result = await client.schema('basejump').from_('accounts')\
                        .select('id, primary_owner_user_id')\
                        .in_('id', missing_account_ids)\
                        .execute()

                    for acc in (accounts_result.data or []):
                        if acc.get('primary_owner_user_id'):
                            try:
                                email_result = await client.rpc('get_user_email', {'user_id': acc['primary_owner_user_id']}).execute()
                                if email_result.data:
                                    email_map[acc['id']] = email_result.data
                            except Exception:
                                pass  # Skip if RPC fails for this user
            except Exception as e:
                logger.warning(f"Failed to fetch emails for at-risk accounts: {e}")

        at_risk_accounts = [
            AccountEngagementItem(
                account_id=str(row['account_id']),
                user_email=email_map.get(str(row['account_id'])),
                rfm_score=f"{row['recency_score']}-{row['frequency_score']}-{row['monetary_score']}",
                recency_score=row['recency_score'],
                frequency_score=row['frequency_score'],
                monetary_score=row['monetary_score'],
                churn_risk=float(row['churn_risk']),
                segment=row['segment'],
                days_since_last_activity=row['days_since_last'] or 0,
                runs_in_period=row['recent_runs']
            )
            for row in at_risk_rows
        ]

        return RFMEngagementSummary(
            total_accounts=total_accounts,
            segments=segment_counts,
            at_risk_accounts=at_risk_accounts,
            avg_churn_risk=round(avg_churn, 2)
        )

    except Exception as e:
        logger.error(f"Failed to get RFM engagement summary: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to get engagement summary")


@router.get("/conversations/accounts-by-segment")
async def get_accounts_by_segment(
    segment: str = Query(..., description="Segment name (champion, loyal, potential, at_risk, hibernating)"),
    days: int = Query(30, ge=1, le=90, description="Days to look back for activity"),
    page: int = Query(1, ge=1, description="Page number"),
    page_size: int = Query(50, ge=1, le=200, description="Items per page"),
    admin: dict = Depends(require_super_admin)
) -> Dict[str, Any]:
    """
    Get accounts in a specific RFM segment with their emails.
    All RFM calculation done in SQL for scalability.
    """
    try:
        from core.services.db import execute

        offset = (page - 1) * page_size

        # All RFM calculation in SQL - no Python loops
        sql = """
        WITH account_stats AS (
            SELECT
                t.account_id,
                MAX(ar.started_at) as last_activity,
                COUNT(*) as total_runs,
                COUNT(*) FILTER (WHERE ar.started_at > NOW() - MAKE_INTERVAL(days => :days)) as recent_runs,
                COALESCE(ca.tier, 'none') as tier
            FROM agent_runs ar
            JOIN threads t ON ar.thread_id = t.thread_id
            LEFT JOIN credit_accounts ca ON ca.account_id = t.account_id
            GROUP BY t.account_id, ca.tier
        ),
        percentiles AS (
            SELECT
                COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY recent_runs), 2) as p50,
                COALESCE(percentile_cont(0.75) WITHIN GROUP (ORDER BY recent_runs), 4) as p75,
                COALESCE(percentile_cont(0.9) WITHIN GROUP (ORDER BY recent_runs), 9) as p90
            FROM account_stats
        ),
        scored AS (
            SELECT
                s.account_id,
                s.last_activity,
                s.total_runs,
                s.recent_runs,
                s.tier,
                EXTRACT(DAY FROM NOW() - s.last_activity)::int as days_since_last,
                -- Recency score
                CASE
                    WHEN EXTRACT(DAY FROM NOW() - s.last_activity) <= 1 THEN 5
                    WHEN EXTRACT(DAY FROM NOW() - s.last_activity) <= 3 THEN 4
                    WHEN EXTRACT(DAY FROM NOW() - s.last_activity) <= 7 THEN 3
                    WHEN EXTRACT(DAY FROM NOW() - s.last_activity) <= 14 THEN 2
                    ELSE 1
                END as recency_score,
                -- Frequency score (percentile-based)
                CASE
                    WHEN s.recent_runs >= p.p90 THEN 5
                    WHEN s.recent_runs >= p.p75 THEN 4
                    WHEN s.recent_runs > p.p50 THEN 3
                    WHEN s.recent_runs >= p.p50 THEN 2
                    ELSE 1
                END as frequency_score,
                -- Monetary score (tier-based)
                CASE s.tier
                    WHEN 'tier_25_200' THEN 5
                    WHEN 'tier_50_400' THEN 5
                    WHEN 'tier_125_800' THEN 5
                    WHEN 'tier_150_1200' THEN 5
                    WHEN 'tier_200_1000' THEN 5
                    WHEN 'tier_6_50' THEN 4
                    WHEN 'tier_12_100' THEN 4
                    WHEN 'tier_2_20' THEN 3
                    WHEN 'free' THEN 2
                    ELSE 1
                END as monetary_score
            FROM account_stats s
            CROSS JOIN percentiles p
        ),
        segmented AS (
            SELECT
                *,
                CASE
                    WHEN recency_score >= 4 AND frequency_score >= 4 THEN 'champion'
                    WHEN recency_score >= 4 AND frequency_score >= 2 THEN 'loyal'
                    WHEN recency_score >= 3 AND frequency_score >= 3 THEN 'potential'
                    WHEN recency_score <= 2 AND frequency_score >= 3 THEN 'at_risk'
                    WHEN recency_score <= 2 AND frequency_score <= 2 THEN 'hibernating'
                    ELSE 'other'
                END as segment
            FROM scored
        )
        SELECT
            account_id,
            recency_score || '-' || frequency_score || '-' || monetary_score as rfm_score,
            days_since_last as days_since_last_activity,
            recent_runs as runs_in_period,
            total_runs,
            COUNT(*) OVER() as total_count
        FROM segmented
        WHERE segment = :segment
        ORDER BY days_since_last ASC, runs_in_period DESC
        LIMIT :page_size OFFSET :offset
        """
        rows = await execute(sql, {"days": days, "segment": segment, "page_size": page_size, "offset": offset})

        if not rows:
            return {"accounts": [], "total": 0, "page": page, "page_size": page_size, "segment": segment}

        # Get total count from window function
        total = int(rows[0].get('total_count', 0))

        # Build account list
        accounts = []
        for row in rows:
            accounts.append({
                'account_id': str(row['account_id']),
                'rfm_score': row['rfm_score'],
                'days_since_last_activity': row['days_since_last_activity'],
                'runs_in_period': row['runs_in_period'],
                'total_runs': row['total_runs']
            })

        # Fetch emails for this page only
        if accounts:
            db = DBConnection()
            client = await db.client
            account_ids = [a['account_id'] for a in accounts]

            email_map = {}
            try:
                # First try billing_customers (fast path for users with billing)
                billing_result = await client.schema('basejump').from_('billing_customers')\
                    .select('account_id, email')\
                    .in_('account_id', account_ids)\
                    .execute()

                email_map = {e['account_id']: e['email'] for e in (billing_result.data or [])}

                # For accounts without billing email, get from auth.users via RPC
                missing_account_ids = [aid for aid in account_ids if aid not in email_map]
                if missing_account_ids:
                    # Get primary_owner_user_id for missing accounts
                    accounts_result = await client.schema('basejump').from_('accounts')\
                        .select('id, primary_owner_user_id')\
                        .in_('id', missing_account_ids)\
                        .execute()

                    for acc in (accounts_result.data or []):
                        if acc.get('primary_owner_user_id'):
                            try:
                                email_result = await client.rpc('get_user_email', {'user_id': acc['primary_owner_user_id']}).execute()
                                if email_result.data:
                                    email_map[acc['id']] = email_result.data
                            except Exception:
                                pass  # Skip if RPC fails for this user
            except Exception as e:
                logger.warning(f"Failed to fetch emails for segment accounts: {e}")

            # Attach emails
            for acct in accounts:
                acct['email'] = email_map.get(acct['account_id'])

        return {
            "accounts": accounts,
            "total": total,
            "page": page,
            "page_size": page_size,
            "segment": segment
        }

    except Exception as e:
        logger.error(f"Failed to get accounts by segment: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to get accounts by segment")


@router.get("/conversations/feature-requests")
async def get_feature_requests(
    page: int = Query(1, ge=1, description="Page number"),
    page_size: int = Query(20, ge=1, le=100, description="Items per page"),
    date_from: Optional[str] = Query(None, description="Start date YYYY-MM-DD"),
    date_to: Optional[str] = Query(None, description="End date YYYY-MM-DD"),
    admin: dict = Depends(require_super_admin)
) -> PaginatedResponse[ConversationAnalyticsItem]:
    """
    Get conversations where feature requests were detected.
    """
    try:
        db = DBConnection()
        client = await db.client

        # Build base query with date filters
        count_query = client.from_('conversation_analytics')\
            .select('id', count='exact')\
            .eq('is_feature_request', True)

        if date_from:
            count_query = count_query.gte('analyzed_at', f"{date_from}T00:00:00")
        if date_to:
            count_query = count_query.lte('analyzed_at', f"{date_to}T23:59:59")

        count_result = await count_query.limit(1).execute()
        total_items = count_result.count or 0

        # Get paginated data with date filters
        offset = (page - 1) * page_size
        data_query = client.from_('conversation_analytics')\
            .select('*')\
            .eq('is_feature_request', True)

        if date_from:
            data_query = data_query.gte('analyzed_at', f"{date_from}T00:00:00")
        if date_to:
            data_query = data_query.lte('analyzed_at', f"{date_to}T23:59:59")

        result = await data_query\
            .order('analyzed_at', desc=True)\
            .range(offset, offset + page_size - 1)\
            .execute()

        records = result.data or []

        # Fetch user emails and first messages
        items = await _build_conversation_items(client, records)

        pagination_params = PaginationParams(page=page, page_size=page_size)
        return await PaginationService.paginate_with_total_count(items, total_items, pagination_params)

    except Exception as e:
        logger.error(f"Failed to get feature requests: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to get feature requests")


@router.get("/conversations/by-sentiment")
async def get_conversations_by_sentiment(
    sentiment: str = Query(..., description="Sentiment label: positive, negative, neutral, mixed"),
    page: int = Query(1, ge=1, description="Page number"),
    page_size: int = Query(20, ge=1, le=100, description="Items per page"),
    date_from: Optional[str] = Query(None, description="Start date YYYY-MM-DD"),
    date_to: Optional[str] = Query(None, description="End date YYYY-MM-DD"),
    admin: dict = Depends(require_super_admin)
) -> PaginatedResponse[ConversationAnalyticsItem]:
    """
    Get conversations filtered by sentiment label.
    """
    try:
        db = DBConnection()
        client = await db.client

        # Build base query for count
        count_query = client.from_('conversation_analytics')\
            .select('id', count='exact')\
            .eq('sentiment_label', sentiment)

        if date_from:
            count_query = count_query.gte('analyzed_at', f"{date_from}T00:00:00Z")
        if date_to:
            count_query = count_query.lte('analyzed_at', f"{date_to}T23:59:59Z")

        count_result = await count_query.limit(1).execute()
        total_items = count_result.count or 0

        # Get paginated data
        offset = (page - 1) * page_size
        data_query = client.from_('conversation_analytics')\
            .select('*')\
            .eq('sentiment_label', sentiment)

        if date_from:
            data_query = data_query.gte('analyzed_at', f"{date_from}T00:00:00Z")
        if date_to:
            data_query = data_query.lte('analyzed_at', f"{date_to}T23:59:59Z")

        result = await data_query\
            .order('analyzed_at', desc=True)\
            .range(offset, offset + page_size - 1)\
            .execute()

        records = result.data or []

        # Fetch user emails and first messages
        items = await _build_conversation_items(client, records)

        pagination_params = PaginationParams(page=page, page_size=page_size)
        return await PaginationService.paginate_with_total_count(items, total_items, pagination_params)

    except Exception as e:
        logger.error(f"Failed to get conversations by sentiment: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to get conversations by sentiment")


@router.get("/conversations/by-intent")
async def get_conversations_by_intent(
    intent: str = Query(..., description="Intent type: question, task, complaint, feature_request, chat"),
    page: int = Query(1, ge=1, description="Page number"),
    page_size: int = Query(20, ge=1, le=100, description="Items per page"),
    date_from: Optional[str] = Query(None, description="Start date YYYY-MM-DD"),
    date_to: Optional[str] = Query(None, description="End date YYYY-MM-DD"),
    admin: dict = Depends(require_super_admin)
) -> PaginatedResponse[ConversationAnalyticsItem]:
    """
    Get conversations filtered by intent type.
    """
    try:
        db = DBConnection()
        client = await db.client

        # Build base query for count
        count_query = client.from_('conversation_analytics')\
            .select('id', count='exact')\
            .eq('intent_type', intent)

        if date_from:
            count_query = count_query.gte('analyzed_at', f"{date_from}T00:00:00Z")
        if date_to:
            count_query = count_query.lte('analyzed_at', f"{date_to}T23:59:59Z")

        count_result = await count_query.limit(1).execute()
        total_items = count_result.count or 0

        # Get paginated data
        offset = (page - 1) * page_size
        data_query = client.from_('conversation_analytics')\
            .select('*')\
            .eq('intent_type', intent)

        if date_from:
            data_query = data_query.gte('analyzed_at', f"{date_from}T00:00:00Z")
        if date_to:
            data_query = data_query.lte('analyzed_at', f"{date_to}T23:59:59Z")

        result = await data_query\
            .order('analyzed_at', desc=True)\
            .range(offset, offset + page_size - 1)\
            .execute()

        records = result.data or []

        # Fetch user emails and first messages
        items = await _build_conversation_items(client, records)

        pagination_params = PaginationParams(page=page, page_size=page_size)
        return await PaginationService.paginate_with_total_count(items, total_items, pagination_params)

    except Exception as e:
        logger.error(f"Failed to get conversations by intent: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to get conversations by intent")


@router.get("/conversations/by-category")
async def get_conversations_by_category(
    category: str = Query(..., description="Use case category"),
    page: int = Query(1, ge=1, description="Page number"),
    page_size: int = Query(20, ge=1, le=100, description="Items per page"),
    date_from: Optional[str] = Query(None, description="Start date YYYY-MM-DD"),
    date_to: Optional[str] = Query(None, description="End date YYYY-MM-DD"),
    admin: dict = Depends(require_super_admin)
) -> PaginatedResponse[ConversationAnalyticsItem]:
    """
    Get conversations filtered by use case category.
    """
    try:
        db = DBConnection()
        client = await db.client

        # Build base query for count
        count_query = client.from_('conversation_analytics')\
            .select('id', count='exact')\
            .eq('use_case_category', category)

        if date_from:
            count_query = count_query.gte('analyzed_at', f"{date_from}T00:00:00Z")
        if date_to:
            count_query = count_query.lte('analyzed_at', f"{date_to}T23:59:59Z")

        count_result = await count_query.limit(1).execute()
        total_items = count_result.count or 0

        # Get paginated data
        offset = (page - 1) * page_size
        data_query = client.from_('conversation_analytics')\
            .select('*')\
            .eq('use_case_category', category)

        if date_from:
            data_query = data_query.gte('analyzed_at', f"{date_from}T00:00:00Z")
        if date_to:
            data_query = data_query.lte('analyzed_at', f"{date_to}T23:59:59Z")

        result = await data_query\
            .order('analyzed_at', desc=True)\
            .range(offset, offset + page_size - 1)\
            .execute()

        records = result.data or []

        # Fetch user emails and messages
        items = await _build_conversation_items(client, records)

        pagination_params = PaginationParams(page=page, page_size=page_size)
        return await PaginationService.paginate_with_total_count(items, total_items, pagination_params)

    except Exception as e:
        logger.error(f"Failed to get conversations by category: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to get conversations by category")


async def _build_conversation_items(client, records: List[Dict[str, Any]]) -> List[ConversationAnalyticsItem]:
    """
    Build ConversationAnalyticsItem list with user emails and first messages.
    """
    if not records:
        return []

    # Fetch user emails for the account_ids
    account_ids = list(set(r.get('account_id') for r in records if r.get('account_id')))
    email_map = {}
    if account_ids:
        try:
            # First try billing_customers (fast path for users with billing)
            billing_result = await client.schema('basejump').from_('billing_customers')\
                .select('account_id, email')\
                .in_('account_id', account_ids)\
                .execute()

            email_map = {e['account_id']: e['email'] for e in (billing_result.data or [])}

            # For accounts without billing email, get from auth.users via RPC
            missing_account_ids = [aid for aid in account_ids if aid not in email_map]
            if missing_account_ids:
                # Get primary_owner_user_id for missing accounts
                accounts_result = await client.schema('basejump').from_('accounts')\
                    .select('id, primary_owner_user_id')\
                    .in_('id', missing_account_ids)\
                    .execute()

                for acc in (accounts_result.data or []):
                    if acc.get('primary_owner_user_id'):
                        try:
                            email_rpc = await client.rpc('get_user_email', {'user_id': acc['primary_owner_user_id']}).execute()
                            if email_rpc.data:
                                email_map[acc['id']] = email_rpc.data
                        except Exception:
                            pass  # Skip if RPC fails for this user
        except Exception as e:
            logger.warning(f"Failed to fetch user emails: {e}")

    # Fetch the ACTUAL user messages that were analyzed (using agent_run time range)
    messages_map = {}  # key: (thread_id, agent_run_id) -> list of user messages

    for r in records[:50]:  # Limit to avoid too many queries
        thread_id = r.get('thread_id')
        agent_run_id = r.get('agent_run_id')
        if not thread_id:
            continue

        try:
            # Get time range from agent_run if available
            started_at = None
            completed_at = None
            if agent_run_id:
                run_result = await client.from_('agent_runs')\
                    .select('started_at, completed_at')\
                    .eq('id', agent_run_id)\
                    .single()\
                    .execute()
                if run_result.data:
                    from datetime import datetime, timedelta
                    raw_started = run_result.data.get('started_at')
                    if raw_started:
                        started_dt = datetime.fromisoformat(raw_started.replace('Z', '+00:00'))
                        started_at = (started_dt - timedelta(seconds=30)).isoformat()
                    completed_at = run_result.data.get('completed_at')

            # Build query for user messages
            query = client.from_('messages')\
                .select('content')\
                .eq('thread_id', thread_id)\
                .eq('type', 'user')

            if started_at:
                query = query.gte('created_at', started_at)
            if completed_at:
                query = query.lte('created_at', completed_at)

            msg_result = await query.order('created_at', desc=False).execute()

            if msg_result.data:
                user_messages = []
                for msg in msg_result.data:
                    content = msg.get('content', '')
                    # Handle content that might be a dict
                    if isinstance(content, dict):
                        content = content.get('content', '') or content.get('text', '') or str(content)
                    # Handle content that might be a list
                    elif isinstance(content, list):
                        text_parts = []
                        for block in content:
                            if isinstance(block, dict) and block.get('type') == 'text':
                                text_parts.append(block.get('text', ''))
                            elif isinstance(block, dict) and block.get('content'):
                                text_parts.append(block.get('content', ''))
                            elif isinstance(block, str):
                                text_parts.append(block)
                        content = ' '.join(text_parts)
                    if not isinstance(content, str):
                        content = str(content) if content else ''
                    if content.strip():
                        user_messages.append(content.strip())

                # Join all user messages with separator
                all_messages = ' → '.join(user_messages)
                if len(all_messages) > 500:
                    all_messages = all_messages[:500] + '...'
                messages_map[(thread_id, agent_run_id)] = all_messages
        except Exception as e:
            logger.warning(f"Failed to fetch messages for thread {thread_id}: {e}")

    # Build response items
    items = []
    for r in records:
        frustration_signals = r.get('frustration_signals', [])
        if isinstance(frustration_signals, str):
            import json as json_lib
            try:
                frustration_signals = json_lib.loads(frustration_signals)
            except Exception:
                frustration_signals = []

        items.append(ConversationAnalyticsItem(
            id=r['id'],
            thread_id=r['thread_id'],
            account_id=r['account_id'],
            user_email=email_map.get(r['account_id']),
            sentiment_label=r.get('sentiment_label'),
            frustration_score=r.get('frustration_score'),
            frustration_signals=frustration_signals,
            intent_type=r.get('intent_type'),
            is_feature_request=r.get('is_feature_request', False),
            feature_request_text=r.get('feature_request_text'),
            use_case_category=r.get('use_case_category'),
            first_user_message=messages_map.get((r['thread_id'], r.get('agent_run_id'))),
            user_message_count=r.get('user_message_count'),
            analyzed_at=r['analyzed_at']
        ))

    return items


@router.get("/conversations/topics")
async def get_topic_distribution(
    date_from: Optional[str] = Query(None, description="Start date YYYY-MM-DD"),
    date_to: Optional[str] = Query(None, description="End date YYYY-MM-DD"),
    admin: dict = Depends(require_super_admin)
) -> Dict[str, Any]:
    """
    Get topic distribution counts.

    Returns:
        {"file_operations": 120, "web_browsing": 85, ...}
    """
    try:
        db = DBConnection()
        client = await db.client

        # Build base query
        query = client.from_('conversation_analytics')\
            .select('primary_topic')

        # Apply date filters
        if date_from:
            query = query.gte('analyzed_at', f"{date_from}T00:00:00Z")
        if date_to:
            query = query.lte('analyzed_at', f"{date_to}T23:59:59Z")

        result = await query.execute()
        records = result.data or []

        # Calculate distribution
        topic_counts: Dict[str, int] = {}
        for r in records:
            topic = r.get('primary_topic')
            if topic:
                topic_counts[topic] = topic_counts.get(topic, 0) + 1

        return {
            "distribution": topic_counts,
            "total": len(records),
            "date_from": date_from,
            "date_to": date_to
        }

    except Exception as e:
        logger.error(f"Failed to get topic distribution: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to get topic distribution")


@router.get("/conversations/queue-status")
async def get_analytics_queue_status(
    admin: dict = Depends(require_super_admin)
) -> Dict[str, Any]:
    """
    Get the current status of the conversation analytics queue.

    Useful for monitoring the background worker.
    """
    try:
        db = DBConnection()
        client = await db.client

        # Get counts by status
        pending_result = await client.from_('conversation_analytics_queue')\
            .select('id', count='exact')\
            .eq('status', 'pending')\
            .limit(1)\
            .execute()

        processing_result = await client.from_('conversation_analytics_queue')\
            .select('id', count='exact')\
            .eq('status', 'processing')\
            .limit(1)\
            .execute()

        failed_result = await client.from_('conversation_analytics_queue')\
            .select('id', count='exact')\
            .eq('status', 'failed')\
            .limit(1)\
            .execute()

        completed_result = await client.from_('conversation_analytics_queue')\
            .select('id', count='exact')\
            .eq('status', 'completed')\
            .limit(1)\
            .execute()

        # Get total analyzed
        analyzed_result = await client.from_('conversation_analytics')\
            .select('id', count='exact')\
            .limit(1)\
            .execute()

        return {
            "queue": {
                "pending": pending_result.count or 0,
                "processing": processing_result.count or 0,
                "failed": failed_result.count or 0,
                "completed": completed_result.count or 0
            },
            "total_analyzed": analyzed_result.count or 0
        }

    except Exception as e:
        logger.error(f"Failed to get queue status: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to get queue status")


@router.get("/conversations/use-cases")
async def get_use_case_patterns(
    date_from: Optional[str] = Query(None, description="Start date YYYY-MM-DD"),
    date_to: Optional[str] = Query(None, description="End date YYYY-MM-DD"),
    admin: dict = Depends(require_super_admin)
) -> Dict[str, Any]:
    """
    Get patterns of what users are doing.

    Returns:
    - Top use cases (e.g., "create sales presentation", "scrape competitor data")
    - Top topics
    """
    try:
        db = DBConnection()
        client = await db.client

        rpc_params = {'p_limit': 20}
        if date_from:
            rpc_params['p_date_from'] = f"{date_from}T00:00:00Z"
        if date_to:
            rpc_params['p_date_to'] = f"{date_to}T23:59:59Z"

        result = await client.rpc('get_use_case_patterns', rpc_params).execute()
        data = result.data

        if not data:
            return {
                "top_use_cases": [],
                "top_topics": [],
                "total": 0,
                "date_from": date_from,
                "date_to": date_to
            }

        return {
            "top_use_cases": data.get('top_use_cases', []),
            "top_topics": data.get('top_topics', []),
            "total": data.get('total', 0),
            "date_from": date_from,
            "date_to": date_to
        }

    except Exception as e:
        logger.error(f"Failed to get use case patterns: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to get use case patterns")


@router.get("/conversations/use-cases/clustered")
async def get_clustered_use_cases_endpoint(
    date_from: Optional[str] = Query(None, description="Start date YYYY-MM-DD"),
    date_to: Optional[str] = Query(None, description="End date YYYY-MM-DD"),
    distance_threshold: float = Query(0.3, ge=0.1, le=0.8, description="Cosine distance threshold (lower = tighter clusters)"),
    min_cluster_size: int = Query(1, ge=1, le=10, description="Minimum items to form a cluster"),
    admin: dict = Depends(require_super_admin)
) -> Dict[str, Any]:
    """
    Get use cases grouped by semantic similarity using embedding-based clustering.

    Groups similar use cases like "create sales ppt", "make presentation", "build slides"
    into a single cluster labeled by the most common use case text.

    Args:
        date_from: Start date filter
        date_to: End date filter
        distance_threshold: Lower values create tighter clusters (0.2-0.4 recommended)
        min_cluster_size: Minimum items to form a cluster

    Returns:
        {
            "clusters": [...],
            "total_clusters": 12,
            "total_use_cases": 156,
            "date_from": "2024-01-01",
            "date_to": "2024-01-31"
        }
    """
    try:
        from core.analytics.use_case_clustering import get_clustered_use_cases

        clusters = await get_clustered_use_cases(
            date_from=date_from,
            date_to=date_to,
            distance_threshold=distance_threshold,
            min_cluster_size=min_cluster_size
        )

        return {
            "clusters": clusters,
            "total_clusters": len(clusters),
            "total_use_cases": sum(c['count'] for c in clusters),
            "date_from": date_from,
            "date_to": date_to
        }

    except ImportError as e:
        logger.error(f"Clustering dependency missing: {e}")
        raise HTTPException(
            status_code=500,
            detail="Clustering requires scikit-learn. Install with: pip install scikit-learn"
        )
    except Exception as e:
        logger.error(f"Failed to get clustered use cases: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to get clustered use cases")
