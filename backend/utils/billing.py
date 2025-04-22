from datetime import datetime, timezone
from typing import Dict, Optional, Tuple

# Define subscription tiers and their monthly limits (in minutes)
SUBSCRIPTION_TIERS = {
    'price_1RGJ9GG6l1KZGqIroxSqgphC': {'name': 'free', 'minutes': 10},
    'price_1RGJ9LG6l1KZGqIrd9pwzeNW': {'name': 'base', 'minutes': 300},  # 100 hours = 6000 minutes
    'price_1RGJ9JG6l1KZGqIrVUU4ZRv6': {'name': 'extra', 'minutes': 2400}  # 100 hours = 6000 minutes
}

async def get_account_subscription(client, account_id: str) -> Optional[Dict]:
    """Get the current subscription for an account."""
    result = await client.schema('basejump').from_('billing_subscriptions') \
        .select('*') \
        .eq('account_id', account_id) \
        .eq('status', 'active') \
        .order('created', desc=True) \
        .limit(1) \
        .execute()
    
    if result.data and len(result.data) > 0:
        return result.data[0]
    return None

async def calculate_monthly_usage(client, account_id: str) -> float:
    """Calculate total agent run minutes for the current month for an account."""
    # Get start of current month in UTC
    now = datetime.now(timezone.utc)
    start_of_month = datetime(now.year, now.month, 1, tzinfo=timezone.utc)
    
    # First get all threads for this account
    threads_result = await client.table('threads') \
        .select('thread_id') \
        .eq('account_id', account_id) \
        .execute()
    
    if not threads_result.data:
        return 0.0
    
    thread_ids = [t['thread_id'] for t in threads_result.data]
    
    # Then get all agent runs for these threads in current month
    runs_result = await client.table('agent_runs') \
        .select('started_at, completed_at') \
        .in_('thread_id', thread_ids) \
        .gte('started_at', start_of_month.isoformat()) \
        .execute()
    
    if not runs_result.data:
        return 0.0
    
    # Calculate total minutes
    total_seconds = 0
    now_ts = now.timestamp()
    
    for run in runs_result.data:
        start_time = datetime.fromisoformat(run['started_at'].replace('Z', '+00:00')).timestamp()
        if run['completed_at']:
            end_time = datetime.fromisoformat(run['completed_at'].replace('Z', '+00:00')).timestamp()
        else:
            # For running jobs, use current time
            end_time = now_ts
        
        total_seconds += (end_time - start_time)
    
    return total_seconds / 60  # Convert to minutes

async def check_billing_status(client, account_id: str) -> Tuple[bool, str, Optional[Dict]]:
    """
    Check if an account can run agents based on their subscription and usage.
    
    Returns:
        Tuple[bool, str, Optional[Dict]]: (can_run, message, subscription_info)
    """
    # Get current subscription
    subscription = await get_account_subscription(client, account_id)
    
    # If no subscription, they can use free tier
    if not subscription:
        subscription = {
            'price_id': 'price_1RGJ9GG6l1KZGqIroxSqgphC',  # Free tier
            'plan_name': 'Free'
        }
    
    # Get tier info
    tier_info = SUBSCRIPTION_TIERS.get(subscription['price_id'])
    if not tier_info:
        return False, "Invalid subscription tier", subscription
    
    # Calculate current month's usage
    current_usage = await calculate_monthly_usage(client, account_id)
    
    # Check if within limits
    if current_usage >= tier_info['minutes']:
        return False, f"Monthly limit of {tier_info['minutes']} minutes reached. Please upgrade your plan or wait until next month.", subscription
    
    return True, "OK", subscription

# Helper function to get account ID from thread
async def get_account_id_from_thread(client, thread_id: str) -> Optional[str]:
    """Get the account ID associated with a thread."""
    result = await client.table('threads') \
        .select('account_id') \
        .eq('thread_id', thread_id) \
        .limit(1) \
        .execute()
    
    if result.data and len(result.data) > 0:
        return result.data[0]['account_id']
    return None
