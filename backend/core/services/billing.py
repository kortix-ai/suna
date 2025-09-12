"""
Stripe Billing API implementation for Suna on top of Basejump. ONLY HAS SUPPOT FOR USER ACCOUNTS – no team accounts. As we are using the user_id as account_id as is the case with personal accounts. In personal accounts, the account_id equals the user_id. In team accounts, the account_id is unique.

stripe listen --forward-to localhost:8000/api/billing/webhook
"""

from fastapi import APIRouter, HTTPException, Depends, Request
from typing import Optional, Dict, Tuple
import stripe
from datetime import datetime, timezone, timedelta
from dateutil import parser as dateutil_parser

from supabase import Client as SupabaseClient
from core.utils.cache import Cache
from core.utils.logger import logger
from core.utils.config import config, EnvMode
from core.services.supabase import DBConnection
from core.utils.auth_utils import verify_and_get_user_id_from_jwt
from pydantic import BaseModel
from core.ai_models import model_manager
from litellm.cost_calculator import cost_per_token
import time
import json

# Initialize Stripe
stripe.api_key = config.STRIPE_SECRET_KEY

# Token price multiplier
TOKEN_PRICE_MULTIPLIER = 1.5

# Minimum credits required to allow a new request when over subscription limit
CREDIT_MIN_START_DOLLARS = 0.20

# Credit packages with Stripe price IDs
CREDIT_PACKAGES = {
    'credits_10': {'amount': 10, 'price': 10, 'stripe_price_id': config.STRIPE_CREDITS_10_PRICE_ID},
    'credits_25': {'amount': 25, 'price': 25, 'stripe_price_id': config.STRIPE_CREDITS_25_PRICE_ID},
    # Uncomment these when you create the additional price IDs in Stripe:
    'credits_50': {'amount': 50, 'price': 50, 'stripe_price_id': config.STRIPE_CREDITS_50_PRICE_ID},
    'credits_100': {'amount': 100, 'price': 100, 'stripe_price_id': config.STRIPE_CREDITS_100_PRICE_ID},
    'credits_250': {'amount': 250, 'price': 250, 'stripe_price_id': config.STRIPE_CREDITS_250_PRICE_ID},
    'credits_500': {'amount': 500, 'price': 500, 'stripe_price_id': config.STRIPE_CREDITS_500_PRICE_ID}
}

router = APIRouter(prefix="/billing", tags=["billing"])

def get_plan_info(price_id: str) -> dict:
    PLAN_TIERS = {
        config.STRIPE_TIER_2_20_ID: {'tier': 1, 'type': 'monthly', 'name': '2h/$20'},
        config.STRIPE_TIER_6_50_ID: {'tier': 2, 'type': 'monthly', 'name': '6h/$50'},
        config.STRIPE_TIER_12_100_ID: {'tier': 3, 'type': 'monthly', 'name': '12h/$100'},
        config.STRIPE_TIER_25_200_ID: {'tier': 4, 'type': 'monthly', 'name': '25h/$200'},
        config.STRIPE_TIER_50_400_ID: {'tier': 5, 'type': 'monthly', 'name': '50h/$400'},
        config.STRIPE_TIER_125_800_ID: {'tier': 6, 'type': 'monthly', 'name': '125h/$800'},
        config.STRIPE_TIER_200_1000_ID: {'tier': 7, 'type': 'monthly', 'name': '200h/$1000'},
        
        # Yearly plans
        config.STRIPE_TIER_2_20_YEARLY_ID: {'tier': 1, 'type': 'yearly', 'name': '2h/$204/year'},
        config.STRIPE_TIER_6_50_YEARLY_ID: {'tier': 2, 'type': 'yearly', 'name': '6h/$510/year'},
        config.STRIPE_TIER_12_100_YEARLY_ID: {'tier': 3, 'type': 'yearly', 'name': '12h/$1020/year'},
        config.STRIPE_TIER_25_200_YEARLY_ID: {'tier': 4, 'type': 'yearly', 'name': '25h/$2040/year'},
        config.STRIPE_TIER_50_400_YEARLY_ID: {'tier': 5, 'type': 'yearly', 'name': '50h/$4080/year'},
        config.STRIPE_TIER_125_800_YEARLY_ID: {'tier': 6, 'type': 'yearly', 'name': '125h/$8160/year'},
        config.STRIPE_TIER_200_1000_YEARLY_ID: {'tier': 7, 'type': 'yearly', 'name': '200h/$10200/year'},
        
        # Yearly commitment plans
        config.STRIPE_TIER_2_17_YEARLY_COMMITMENT_ID: {'tier': 1, 'type': 'yearly_commitment', 'name': '2h/$17/month'},
        config.STRIPE_TIER_6_42_YEARLY_COMMITMENT_ID: {'tier': 2, 'type': 'yearly_commitment', 'name': '6h/$42.50/month'},
        config.STRIPE_TIER_25_170_YEARLY_COMMITMENT_ID: {'tier': 4, 'type': 'yearly_commitment', 'name': '25h/$170/month'},
    }
    
    return PLAN_TIERS.get(price_id, {'tier': 0, 'type': 'unknown', 'name': 'Unknown'})

def is_plan_change_allowed(current_price_id: str, new_price_id: str) -> tuple[bool, str]:
    """
    Validate if a plan change is allowed based on business rules.
    
    Returns:
        Tuple of (is_allowed, reason_if_not_allowed)
    """
    current_plan = get_plan_info(current_price_id)
    new_plan = get_plan_info(new_price_id)
    
    # Allow if same plan
    if current_price_id == new_price_id:
        return True, ""
    
    # Restriction 1: Don't allow downgrade from monthly to lower monthly
    if current_plan['type'] == 'monthly' and new_plan['type'] == 'monthly' and new_plan['tier'] < current_plan['tier']:
        return False, "Downgrading to a lower monthly plan is not allowed. You can only upgrade to a higher tier or switch to yearly billing."
    
    # Restriction 2: Don't allow downgrade from yearly commitment to monthly
    if current_plan['type'] == 'yearly_commitment' and new_plan['type'] == 'monthly':
        return False, "Downgrading from yearly commitment to monthly is not allowed. You can only upgrade within yearly commitment plans."
    
    # Restriction 2b: Don't allow downgrade within yearly commitment plans
    if current_plan['type'] == 'yearly_commitment' and new_plan['type'] == 'yearly_commitment' and new_plan['tier'] < current_plan['tier']:
        return False, "Downgrading to a lower yearly commitment plan is not allowed. You can only upgrade to higher commitment tiers."
    
    # Restriction 3: Only allow upgrade from monthly to yearly commitment on same level or above
    if current_plan['type'] == 'monthly' and new_plan['type'] == 'yearly_commitment' and new_plan['tier'] < current_plan['tier']:
        return False, "You can only upgrade to yearly commitment plans at the same tier level or higher."
    
    # Allow all other changes (upgrades, yearly to yearly, yearly commitment upgrades, etc.)
    return True, ""

# Simplified yearly commitment logic - no subscription schedules needed

def get_model_pricing(model: str) -> tuple[float, float] | None:
    """
    Get pricing for a model. Returns (input_cost_per_million, output_cost_per_million) or None.
    
    Args:
        model: The model name to get pricing for (can be display name or model ID)
        
    Returns:
        Tuple of (input_cost_per_million_tokens, output_cost_per_million_tokens) or None if not found
    """
    # First try to resolve the model ID to handle aliases
    resolved_model = model_manager.resolve_model_id(model)
    logger.debug(f"Resolving model '{model}' -> '{resolved_model}'")
    
    # Try the resolved model first, then fallback to original
    for model_to_try in [resolved_model, model]:
        model_obj = model_manager.get_model(model_to_try)
        if model_obj and model_obj.pricing:
            logger.debug(f"Found pricing for model {model_to_try}: input=${model_obj.pricing.input_cost_per_million_tokens}/M, output=${model_obj.pricing.output_cost_per_million_tokens}/M")
            return model_obj.pricing.input_cost_per_million_tokens, model_obj.pricing.output_cost_per_million_tokens
        else:
            logger.debug(f"No pricing for model_to_try='{model_to_try}' (model_obj: {model_obj is not None}, has_pricing: {model_obj.pricing is not None if model_obj else False})")
    
    # Silently return None for unknown models to avoid log spam
    logger.debug(f"No pricing found for model '{model}' (resolved: '{resolved_model}')")
    return None


SUBSCRIPTION_TIERS = {
    config.STRIPE_FREE_TIER_ID: {'name': 'free', 'minutes': 60, 'cost': 5},
    config.STRIPE_TIER_2_20_ID: {'name': 'tier_2_20', 'minutes': 120, 'cost': 20 + 5},  # 2 hours
    config.STRIPE_TIER_6_50_ID: {'name': 'tier_6_50', 'minutes': 360, 'cost': 50 + 5},  # 6 hours
    config.STRIPE_TIER_12_100_ID: {'name': 'tier_12_100', 'minutes': 720, 'cost': 100 + 5},  # 12 hours
    config.STRIPE_TIER_25_200_ID: {'name': 'tier_25_200', 'minutes': 1500, 'cost': 200 + 5},  # 25 hours
    config.STRIPE_TIER_50_400_ID: {'name': 'tier_50_400', 'minutes': 3000, 'cost': 400 + 5},  # 50 hours
    config.STRIPE_TIER_125_800_ID: {'name': 'tier_125_800', 'minutes': 7500, 'cost': 800 + 5},  # 125 hours
    config.STRIPE_TIER_200_1000_ID: {'name': 'tier_200_1000', 'minutes': 12000, 'cost': 1000 + 5},  # 200 hours
    # Yearly tiers (same usage limits, different billing period)
    config.STRIPE_TIER_2_20_YEARLY_ID: {'name': 'tier_2_20', 'minutes': 120, 'cost': 20 + 5},  # 2 hours/month, $204/year
    config.STRIPE_TIER_6_50_YEARLY_ID: {'name': 'tier_6_50', 'minutes': 360, 'cost': 50 + 5},  # 6 hours/month, $510/year
    config.STRIPE_TIER_12_100_YEARLY_ID: {'name': 'tier_12_100', 'minutes': 720, 'cost': 100 + 5},  # 12 hours/month, $1020/year
    config.STRIPE_TIER_25_200_YEARLY_ID: {'name': 'tier_25_200', 'minutes': 1500, 'cost': 200 + 5},  # 25 hours/month, $2040/year
    config.STRIPE_TIER_50_400_YEARLY_ID: {'name': 'tier_50_400', 'minutes': 3000, 'cost': 400 + 5},  # 50 hours/month, $4080/year
    config.STRIPE_TIER_125_800_YEARLY_ID: {'name': 'tier_125_800', 'minutes': 7500, 'cost': 800 + 5},  # 125 hours/month, $8160/year
    config.STRIPE_TIER_200_1000_YEARLY_ID: {'name': 'tier_200_1000', 'minutes': 12000, 'cost': 1000 + 5},  # 200 hours/month, $10200/year
    # Yearly commitment tiers (15% discount, monthly payments with 12-month commitment via schedules)
    config.STRIPE_TIER_2_17_YEARLY_COMMITMENT_ID: {'name': 'tier_2_17_yearly_commitment', 'minutes': 120, 'cost': 20 + 5},  # 2 hours/month, $17/month (12-month commitment)
    config.STRIPE_TIER_6_42_YEARLY_COMMITMENT_ID: {'name': 'tier_6_42_yearly_commitment', 'minutes': 360, 'cost': 50 + 5},  # 6 hours/month, $42.50/month (12-month commitment)
    config.STRIPE_TIER_25_170_YEARLY_COMMITMENT_ID: {'name': 'tier_25_170_yearly_commitment', 'minutes': 1500, 'cost': 200 + 5},  # 25 hours/month, $170/month (12-month commitment)
}

# Pydantic models for request/response validation
class CreateCheckoutSessionRequest(BaseModel):
    price_id: str
    success_url: str
    cancel_url: str
    tolt_referral: Optional[str] = None
    commitment_type: Optional[str] = "monthly"  # "monthly", "yearly", or "yearly_commitment"

class CreatePortalSessionRequest(BaseModel):
    return_url: str

class SubscriptionStatus(BaseModel):
    status: str # e.g., 'active', 'trialing', 'past_due', 'scheduled_downgrade', 'no_subscription'
    plan_name: Optional[str] = None
    price_id: Optional[str] = None # Added price ID
    current_period_end: Optional[datetime] = None
    cancel_at_period_end: bool = False
    trial_end: Optional[datetime] = None
    minutes_limit: Optional[int] = None
    cost_limit: Optional[float] = None
    current_usage: Optional[float] = None
    # Fields for scheduled changes
    has_schedule: bool = False
    scheduled_plan_name: Optional[str] = None
    scheduled_price_id: Optional[str] = None # Added scheduled price ID
    scheduled_change_date: Optional[datetime] = None
    # Subscription data for frontend components
    subscription_id: Optional[str] = None
    subscription: Optional[Dict] = None
    # Credit information
    credit_balance: Optional[float] = None
    can_purchase_credits: bool = False

class PurchaseCreditsRequest(BaseModel):
    amount_dollars: float  # Amount of credits to purchase in dollars
    success_url: str
    cancel_url: str

class CreditBalance(BaseModel):
    balance_dollars: float
    total_purchased: float
    total_used: float
    last_updated: Optional[datetime] = None
    can_purchase_credits: bool = False  # True only for highest tier users

class CreditPurchase(BaseModel):
    id: str
    amount_dollars: float
    status: str
    created_at: datetime
    completed_at: Optional[datetime] = None
    stripe_payment_intent_id: Optional[str] = None

class CreditUsage(BaseModel):
    id: str
    amount_dollars: float
    description: Optional[str] = None
    created_at: datetime
    thread_id: Optional[str] = None
    message_id: Optional[str] = None

# Helper functions
async def get_stripe_customer_id(client: SupabaseClient, user_id: str) -> Optional[str]:
    """Get the Stripe customer ID for a user."""

    result = await Cache.get(f"stripe_customer_id:{user_id}")
    if result:
        return result

    result = await client.schema('basejump').from_('billing_customers') \
        .select('id') \
        .eq('account_id', user_id) \
        .execute()

    if result.data and len(result.data) > 0:
        customer_id = result.data[0]['id']
        await Cache.set(f"stripe_customer_id:{user_id}", customer_id, ttl=24 * 60)
        return customer_id

    customer_result = await stripe.Customer.search_async(
        query=f"metadata['user_id']:'{user_id}' OR metadata['basejump_account_id']:'{user_id}'"
    )

    if customer_result.data and len(customer_result.data) > 0:
        customer = customer_result.data[0]
        # If the customer does not have 'user_id' in metadata, add it now
        if not customer.get('metadata', {}).get('user_id'):
            try:
                await stripe.Customer.modify_async(
                    customer['id'],
                    metadata={**customer.get('metadata', {}), 'user_id': user_id}
                )
                logger.debug(f"Added missing user_id metadata to Stripe customer {customer['id']}")
            except Exception as e:
                logger.error(f"Failed to add user_id metadata to Stripe customer {customer['id']}: {str(e)}")

        has_active = len((await stripe.Subscription.list_async(
            customer=customer['id'],
            status='active',
            limit=1
        )).get('data', [])) > 0

        # Create or update record in billing_customers table
        await client.schema('basejump').from_('billing_customers').upsert({
            'id': customer['id'],
            'account_id': user_id,
            'email': customer.get('email'),
            'provider': 'stripe',
            'active': has_active
        }).execute()
        logger.debug(f"Updated billing_customers record for customer {customer['id']} and user {user_id}")

        return customer['id']

    return None

async def create_stripe_customer(client, user_id: str, email: str) -> str:
    """Create a new Stripe customer for a user."""
    # Create customer in Stripe
    customer = await stripe.Customer.create_async(
        email=email,
        metadata={"user_id": user_id}
    )
    
    # Store customer ID in Supabase
    await client.schema('basejump').from_('billing_customers').insert({
        'id': customer.id,
        'account_id': user_id,
        'email': email,
        'provider': 'stripe'
    }).execute()
    
    return customer.id

async def get_user_subscription(user_id: str) -> Optional[Dict]:
    """Get the current subscription for a user from Stripe."""
    try:
        result = await Cache.get(f"user_subscription:{user_id}")
        if result:
            return result

        # Get customer ID
        db = DBConnection()
        client = await db.client
        customer_id = await get_stripe_customer_id(client, user_id)
        
        if not customer_id:
            await Cache.set(f"user_subscription:{user_id}", None, ttl=1 * 60)
            return None
            
        # Get all active subscriptions for the customer
        subscriptions = await stripe.Subscription.list_async(
            customer=customer_id,
            status='active'
        )
        # print("Found subscriptions:", subscriptions)
        
        # Check if we have any subscriptions
        if not subscriptions or not subscriptions.get('data'):
            await Cache.set(f"user_subscription:{user_id}", None, ttl=1 * 60)
            return None
            
        # Filter subscriptions to only include our product's subscriptions
        our_subscriptions = []
        for sub in subscriptions['data']:
            # Check if subscription items contain any of our price IDs
            for item in sub.get('items', {}).get('data', []):
                price_id = item.get('price', {}).get('id')
                if price_id in [
                    config.STRIPE_FREE_TIER_ID,
                    config.STRIPE_TIER_2_20_ID, config.STRIPE_TIER_6_50_ID, config.STRIPE_TIER_12_100_ID,
                    config.STRIPE_TIER_25_200_ID, config.STRIPE_TIER_50_400_ID, config.STRIPE_TIER_125_800_ID,
                    config.STRIPE_TIER_200_1000_ID,
                    # Yearly tiers
                    config.STRIPE_TIER_2_20_YEARLY_ID, config.STRIPE_TIER_6_50_YEARLY_ID,
                    config.STRIPE_TIER_12_100_YEARLY_ID, config.STRIPE_TIER_25_200_YEARLY_ID,
                    config.STRIPE_TIER_50_400_YEARLY_ID, config.STRIPE_TIER_125_800_YEARLY_ID,
                    config.STRIPE_TIER_200_1000_YEARLY_ID,
                    # Yearly commitment tiers (monthly payments with 12-month commitment)
                    config.STRIPE_TIER_2_17_YEARLY_COMMITMENT_ID,
                    config.STRIPE_TIER_6_42_YEARLY_COMMITMENT_ID,
                    config.STRIPE_TIER_25_170_YEARLY_COMMITMENT_ID
                ]:
                    our_subscriptions.append(sub)
        
        if not our_subscriptions:
            await Cache.set(f"user_subscription:{user_id}", None, ttl=1 * 60)
            return None
            
        # If there are multiple active subscriptions, we need to handle this
        if len(our_subscriptions) > 1:
            logger.warning(f"User {user_id} has multiple active subscriptions: {[sub['id'] for sub in our_subscriptions]}")
            
            # Get the most recent subscription
            most_recent = max(our_subscriptions, key=lambda x: x['created'])
            
            # Cancel all other subscriptions
            for sub in our_subscriptions:
                if sub['id'] != most_recent['id']:
                    try:
                        await stripe.Subscription.modify_async(
                            sub['id'],
                            cancel_at_period_end=True
                        )
                        logger.debug(f"Cancelled subscription {sub['id']} for user {user_id}")
                    except Exception as e:
                        logger.error(f"Error cancelling subscription {sub['id']}: {str(e)}")
            
            return most_recent

        result = our_subscriptions[0]
        await Cache.set(f"user_subscription:{user_id}", result, ttl=1 * 60)
        return result
        
    except Exception as e:
        logger.error(f"Error getting subscription from Stripe: {str(e)}")
        return None

async def calculate_monthly_usage(client, user_id: str) -> float:
    """Calculate total agent run minutes for the current month for a user."""
    result = await Cache.get(f"monthly_usage:{user_id}")
    if result:
        return result

    start_time = time.time()
    
    # Use get_usage_logs to fetch all usage data (it already handles the date filtering and batching)
    total_cost = 0.0
    page = 0
    items_per_page = 1000
    
    while True:
        # Get usage logs for this page
        usage_result = await get_usage_logs(client, user_id, page, items_per_page)
        
        if not usage_result['logs']:
            break
        
        # Sum up the estimated costs from this page
        for log_entry in usage_result['logs']:
            total_cost += log_entry['estimated_cost']
        
        # If there are no more pages, break
        if not usage_result['has_more']:
            break
            
        page += 1
    
    end_time = time.time()
    execution_time = end_time - start_time
    logger.debug(f"Calculate monthly usage took {execution_time:.3f} seconds, total cost: {total_cost}")
    
    await Cache.set(f"monthly_usage:{user_id}", total_cost, ttl=5)
    return total_cost


async def get_usage_logs(client, user_id: str, page: int = 0, items_per_page: int = 1000) -> Dict:
    """Get detailed usage logs for a user with pagination, including credit usage info."""
    logger.debug(f"[USAGE_LOGS] Starting get_usage_logs for user_id={user_id}, page={page}, items_per_page={items_per_page}")
    
    try:
        # Get start of current month in UTC
        now = datetime.now(timezone.utc)
        start_of_month = datetime(now.year, now.month, 1, tzinfo=timezone.utc)
        
        # Use fixed cutoff date: June 26, 2025 midnight UTC
        # Ignore all token counts before this date
        cutoff_date = datetime(2025, 6, 30, 9, 0, 0, tzinfo=timezone.utc)
        
        start_of_month = max(start_of_month, cutoff_date)
        logger.debug(f"[USAGE_LOGS] user_id={user_id} - Using start_of_month: {start_of_month.isoformat()}")
        
        # First get all threads for this user in batches
        batch_size = 1000
        offset = 0
        all_threads = []
        
        logger.debug(f"[USAGE_LOGS] user_id={user_id} - Fetching threads in batches")
        while True:
            try:
                threads_batch = await client.table('threads') \
                    .select('thread_id, agent_runs(thread_id)') \
                    .eq('account_id', user_id) \
                    .gte('agent_runs.created_at', start_of_month.isoformat()) \
                    .range(offset, offset + batch_size - 1) \
                    .execute()
                
                if not threads_batch.data:
                    break
                    
                all_threads.extend(threads_batch.data)
                logger.debug(f"[USAGE_LOGS] user_id={user_id} - Fetched {len(threads_batch.data)} threads in batch (offset={offset})")
                
                # If we got less than batch_size, we've reached the end
                if len(threads_batch.data) < batch_size:
                    break
                    
                offset += batch_size
            except Exception as thread_error:
                logger.error(f"[USAGE_LOGS] user_id={user_id} - Error fetching threads batch at offset {offset}: {str(thread_error)}")
                raise
        
        logger.debug(f"[USAGE_LOGS] user_id={user_id} - Found {len(all_threads)} total threads")
        
        if not all_threads:
            logger.debug(f"[USAGE_LOGS] user_id={user_id} - No threads found, returning empty result")
            return {"logs": [], "has_more": False}
        
        thread_ids = [t['thread_id'] for t in all_threads]
        logger.debug(f"[USAGE_LOGS] user_id={user_id} - Thread IDs: {thread_ids[:5]}..." if len(thread_ids) > 5 else f"[USAGE_LOGS] user_id={user_id} - Thread IDs: {thread_ids}")
        
        # Fetch usage messages with pagination, including thread project info
        # Use a more efficient approach to avoid URI length limits with many threads
        start_time = time.time()
        logger.debug(f"[USAGE_LOGS] user_id={user_id} - Starting messages query")
        
        try:
            # Instead of using .in_() with all thread IDs (which can cause URI too large errors),
            # we'll use a join-based approach by querying messages directly for the user's account
            # and filtering by date and type, then joining with threads for project info
            messages_result = await client.table('messages') \
                .select(
                    'message_id, thread_id, created_at, content, threads!inner(project_id, account_id)'
                ) \
                .eq('threads.account_id', user_id) \
                .eq('type', 'assistant_response_end') \
                .gte('created_at', start_of_month.isoformat()) \
                .order('created_at', desc=True) \
                .range(page * items_per_page, (page + 1) * items_per_page - 1) \
                .execute()
        except Exception as query_error:
            logger.error(f"[USAGE_LOGS] user_id={user_id} - Database query failed: {str(query_error)}")
            logger.error(f"[USAGE_LOGS] user_id={user_id} - Query details: page={page}, items_per_page={items_per_page}, thread_count={len(thread_ids)}")
            
            # Fallback: If the join approach fails, try batching the thread IDs
            logger.debug(f"[USAGE_LOGS] user_id={user_id} - Attempting fallback with batched thread ID queries")
            try:
                all_messages = []
                batch_size = 100  # Process threads in smaller batches to avoid URI limits
                
                for i in range(0, len(thread_ids), batch_size):
                    batch_thread_ids = thread_ids[i:i + batch_size]
                    logger.debug(f"[USAGE_LOGS] user_id={user_id} - Processing thread batch {i//batch_size + 1}/{(len(thread_ids) + batch_size - 1)//batch_size}")
                    
                    batch_result = await client.table('messages') \
                        .select(
                            'message_id, thread_id, created_at, content, threads!inner(project_id)'
                        ) \
                        .in_('thread_id', batch_thread_ids) \
                        .eq('type', 'assistant_response_end') \
                        .gte('created_at', start_of_month.isoformat()) \
                        .order('created_at', desc=True) \
                        .execute()
                    
                    if batch_result.data:
                        all_messages.extend(batch_result.data)
                
                # Sort all messages by created_at descending and apply pagination
                all_messages.sort(key=lambda x: x['created_at'], reverse=True)
                
                # Apply pagination to the combined results
                start_idx = page * items_per_page
                end_idx = start_idx + items_per_page
                paginated_messages = all_messages[start_idx:end_idx]
                
                # Create a mock result object similar to what Supabase returns
                class MockResult:
                    def __init__(self, data):
                        self.data = data
                
                messages_result = MockResult(paginated_messages)
                logger.debug(f"[USAGE_LOGS] user_id={user_id} - Fallback successful, found {len(all_messages)} total messages, returning {len(paginated_messages)} for page {page}")
                
            except Exception as fallback_error:
                logger.error(f"[USAGE_LOGS] user_id={user_id} - Fallback query also failed: {str(fallback_error)}")
                raise query_error  # Raise the original error
        
        end_time = time.time()
        execution_time = end_time - start_time
        logger.debug(f"[USAGE_LOGS] user_id={user_id} - Database query for usage logs took {execution_time:.3f} seconds")

        if not messages_result.data:
            logger.debug(f"[USAGE_LOGS] user_id={user_id} - No messages found, returning empty result")
            return {"logs": [], "has_more": False}
        
        logger.debug(f"[USAGE_LOGS] user_id={user_id} - Found {len(messages_result.data)} messages to process")

        # Get the user's subscription tier info for credit checking
        logger.debug(f"[USAGE_LOGS] user_id={user_id} - Getting subscription info")
        try:
            subscription = await get_user_subscription(user_id)
            price_id = config.STRIPE_FREE_TIER_ID  # Default to free
            if subscription and subscription.get('items'):
                items = subscription['items'].get('data', [])
                if items:
                    price_id = items[0]['price']['id']
            
            tier_info = SUBSCRIPTION_TIERS.get(price_id, SUBSCRIPTION_TIERS[config.STRIPE_FREE_TIER_ID])
            subscription_limit = tier_info['cost']
            logger.debug(f"[USAGE_LOGS] user_id={user_id} - Subscription limit: {subscription_limit}, price_id: {price_id}")
        except Exception as sub_error:
            logger.error(f"[USAGE_LOGS] user_id={user_id} - Error getting subscription info: {str(sub_error)}")
            # Use free tier as fallback
            tier_info = SUBSCRIPTION_TIERS[config.STRIPE_FREE_TIER_ID]
            subscription_limit = tier_info['cost']
        
        # Get credit usage records for this month to match with messages
        logger.debug(f"[USAGE_LOGS] user_id={user_id} - Fetching credit usage records")
        try:
            credit_usage_result = await client.table('credit_usage') \
                .select('message_id, amount_dollars, created_at') \
                .eq('account_id', user_id) \
                .gte('created_at', start_of_month.isoformat()) \
                .execute()
            
            logger.debug(f"[USAGE_LOGS] user_id={user_id} - Found {len(credit_usage_result.data) if credit_usage_result.data else 0} credit usage records")
        except Exception as credit_error:
            logger.error(f"[USAGE_LOGS] user_id={user_id} - Error fetching credit usage: {str(credit_error)}")
            credit_usage_result = None
        
        # Create a map of message_id to credit usage
        credit_usage_map = {}
        if credit_usage_result and credit_usage_result.data:
            for usage in credit_usage_result.data:
                if usage.get('message_id'):
                    try:
                        credit_usage_map[usage['message_id']] = {
                            'amount': float(usage['amount_dollars']),
                            'created_at': usage['created_at']
                        }
                    except Exception as parse_error:
                        logger.warning(f"[USAGE_LOGS] user_id={user_id} - Error parsing credit usage record: {str(parse_error)}")
                        continue
    
        # Track cumulative usage to determine when credits started being used
        cumulative_cost = 0.0
        
        # Process messages into usage log entries
        processed_logs = []
        logger.debug(f"[USAGE_LOGS] user_id={user_id} - Starting to process {len(messages_result.data)} messages")
        
        for i, message in enumerate(messages_result.data):
            try:
                message_id = message.get('message_id', f'unknown_{i}')
                logger.debug(f"[USAGE_LOGS] user_id={user_id} - Processing message {i+1}/{len(messages_result.data)}: {message_id}")
                
                # Safely extract usage data with defaults
                content = message.get('content', {})
                usage = content.get('usage', {})
                
                # Ensure usage has required fields with safe defaults
                prompt_tokens = usage.get('prompt_tokens', 0)
                completion_tokens = usage.get('completion_tokens', 0)
                model = content.get('model', 'unknown')
                
                # Validate token values
                if not isinstance(prompt_tokens, (int, float)) or prompt_tokens is None:
                    logger.warning(f"[USAGE_LOGS] user_id={user_id} - Invalid prompt_tokens for message {message_id}: {prompt_tokens}")
                    prompt_tokens = 0
                if not isinstance(completion_tokens, (int, float)) or completion_tokens is None:
                    logger.warning(f"[USAGE_LOGS] user_id={user_id} - Invalid completion_tokens for message {message_id}: {completion_tokens}")
                    completion_tokens = 0
                
                # Safely calculate total tokens
                total_tokens = int(prompt_tokens or 0) + int(completion_tokens or 0)
                
                # Calculate estimated cost using the same logic as calculate_monthly_usage
                try:
                    estimated_cost = calculate_token_cost(
                        prompt_tokens,
                        completion_tokens,
                        model
                    )
                except Exception as cost_error:
                    logger.warning(f"[USAGE_LOGS] user_id={user_id} - Error calculating cost for message {message_id}: {str(cost_error)}")
                    estimated_cost = 0.0
                
                cumulative_cost += estimated_cost
                
                # Safely extract project_id from threads relationship
                project_id = 'unknown'
                try:
                    if message.get('threads') and isinstance(message['threads'], list) and len(message['threads']) > 0:
                        project_id = message['threads'][0].get('project_id', 'unknown')
                except Exception as project_error:
                    logger.warning(f"[USAGE_LOGS] user_id={user_id} - Error extracting project_id for message {message_id}: {str(project_error)}")
                
                # Check if credits were used for this message
                credit_used = credit_usage_map.get(message_id, {})
                
                # Safely handle datetime serialization for created_at
                created_at = message.get('created_at')
                if created_at and isinstance(created_at, datetime):
                    created_at = created_at.isoformat()
                elif created_at and not isinstance(created_at, str):
                    try:
                        created_at = str(created_at)
                    except Exception:
                        logger.warning(f"[USAGE_LOGS] user_id={user_id} - Could not convert created_at to string for message {message_id}")
                        created_at = None
                
                log_entry = {
                    'message_id': str(message_id) if message_id else 'unknown',
                    'thread_id': str(message.get('thread_id', 'unknown')),
                    'created_at': created_at,
                    'content': {
                        'usage': {
                            'prompt_tokens': int(prompt_tokens),
                            'completion_tokens': int(completion_tokens)
                        },
                        'model': str(model)
                    },
                    'total_tokens': int(total_tokens),
                    'estimated_cost': float(estimated_cost),
                    'project_id': str(project_id),
                    # Add credit usage info
                    'credit_used': float(credit_used.get('amount', 0)) if credit_used else 0.0,
                    'payment_method': 'credits' if credit_used else 'subscription',
                    'was_over_limit': bool(cumulative_cost > subscription_limit if not credit_used else True)
                }
                
                # Test JSON serialization of this entry before adding it
                try:
                    json.dumps(log_entry, default=str)
                except Exception as json_error:
                    logger.error(f"[USAGE_LOGS] user_id={user_id} - JSON serialization failed for message {message_id}: {str(json_error)}")
                    logger.error(f"[USAGE_LOGS] user_id={user_id} - Problematic log_entry: {log_entry}")
                    continue
                
                processed_logs.append(log_entry)
                
            except Exception as e:
                logger.error(f"[USAGE_LOGS] user_id={user_id} - Error processing usage log entry for message {message.get('message_id', 'unknown')}: {str(e)}")
                continue
        
        logger.debug(f"[USAGE_LOGS] user_id={user_id} - Successfully processed {len(processed_logs)} messages")
        
        # Check if there are more results
        has_more = len(processed_logs) == items_per_page
        
        result = {
            "logs": processed_logs,
            "has_more": bool(has_more),
            "subscription_limit": float(subscription_limit),
            "cumulative_cost": float(cumulative_cost)
        }
        
        # Validate final JSON serialization
        try:
            json.dumps(result, default=str)
            logger.debug(f"[USAGE_LOGS] user_id={user_id} - Final result JSON validation passed")
        except Exception as final_json_error:
            logger.error(f"[USAGE_LOGS] user_id={user_id} - Final result JSON serialization failed: {str(final_json_error)}")
            logger.error(f"[USAGE_LOGS] user_id={user_id} - Problematic result keys: {list(result.keys())}")
            # Return safe fallback
            return {
                "logs": [],
                "has_more": False,
                "subscription_limit": float(subscription_limit),
                "cumulative_cost": 0.0,
                "error": "Failed to serialize usage data"
            }
        
        logger.debug(f"[USAGE_LOGS] user_id={user_id} - Returning {len(processed_logs)} logs, has_more={has_more}")
        return result
        
    except Exception as outer_error:
        logger.error(f"[USAGE_LOGS] user_id={user_id} - Outer exception in get_usage_logs: {str(outer_error)}")
        raise


def calculate_token_cost(prompt_tokens: int, completion_tokens: int, model: str) -> float:
    """Calculate the cost for tokens using the same logic as the monthly usage calculation."""
    try:
        # Ensure tokens are valid integers
        prompt_tokens = int(prompt_tokens) if prompt_tokens is not None else 0
        completion_tokens = int(completion_tokens) if completion_tokens is not None else 0
        
        logger.debug(f"Calculating token cost for model '{model}' with {prompt_tokens} input tokens and {completion_tokens} output tokens")
        
        # Try to resolve the model name using new model manager first
        from core.ai_models import model_manager
        try:
            resolved_model = model_manager.resolve_model_id(model)
            logger.debug(f"Model '{model}' resolved to '{resolved_model}'")
        except Exception as resolve_error:
            logger.warning(f"Could not resolve model ID '{model}': {str(resolve_error)}, returning 0 cost")
            return 0.0

        # Check if we have hardcoded pricing for this model (try both original and resolved)
        hardcoded_pricing = get_model_pricing(model) or get_model_pricing(resolved_model)
        if hardcoded_pricing:
            input_cost_per_million, output_cost_per_million = hardcoded_pricing
            input_cost = (prompt_tokens / 1_000_000) * input_cost_per_million
            output_cost = (completion_tokens / 1_000_000) * output_cost_per_million
            message_cost = input_cost + output_cost
        else:
            # Use litellm pricing as fallback - try multiple variations
            try:
                models_to_try = [model]
                
                # Add resolved model if different
                if resolved_model != model:
                    models_to_try.append(resolved_model)
                
                # Try without provider prefix if it has one
                if '/' in model:
                    models_to_try.append(model.split('/', 1)[1])
                if '/' in resolved_model and resolved_model != model:
                    models_to_try.append(resolved_model.split('/', 1)[1])
                    
                # Special handling for Google models accessed via OpenRouter
                if model.startswith('openrouter/google/'):
                    google_model_name = model.replace('openrouter/', '')
                    models_to_try.append(google_model_name)
                if resolved_model.startswith('openrouter/google/'):
                    google_model_name = resolved_model.replace('openrouter/', '')
                    models_to_try.append(google_model_name)
                
                # Try each model name variation until we find one that works
                message_cost = None
                for model_name in models_to_try:
                    try:
                        prompt_token_cost, completion_token_cost = cost_per_token(model_name, prompt_tokens, completion_tokens)
                        if prompt_token_cost is not None and completion_token_cost is not None:
                            message_cost = prompt_token_cost + completion_token_cost
                            break
                    except Exception as e:
                        logger.debug(f"Failed to get pricing for model variation {model_name}: {str(e)}")
                        continue
                
                if message_cost is None:
                    logger.debug(f"Could not get pricing for model {model} (resolved: {resolved_model}), returning 0 cost")
                    return 0.0
                    
            except Exception as e:
                logger.debug(f"Could not get pricing for model {model} (resolved: {resolved_model}): {str(e)}, returning 0 cost")
                return 0.0
        
        # Apply the TOKEN_PRICE_MULTIPLIER
        return message_cost * TOKEN_PRICE_MULTIPLIER
    except Exception as e:
        logger.error(f"Error calculating token cost for model {model}: {str(e)}")
        return 0.0

async def get_allowed_models_for_user(client, user_id: str):
    """
    Get the list of models allowed for a user based on their subscription tier.
    
    Returns:
        List of model names allowed for the user's subscription tier.
    """

    result = await Cache.get(f"allowed_models_for_user:{user_id}")
    if result:
        return result

    # First check if user has an active trial
    credit_result = await client.from_('credit_accounts').select('tier, trial_status').eq('account_id', user_id).execute()
    
    tier_name = 'none'  # Default to no access
    
    if credit_result.data and len(credit_result.data) > 0:
        credit_account = credit_result.data[0]
        trial_status = credit_account.get('trial_status')
        
        # If user has an active trial, they get paid tier access
        if trial_status == 'active':
            tier_name = 'tier_2_20'  # Trial gives access to Starter tier features
        else:
            tier_name = credit_account.get('tier', 'none')
    
    # If not on trial, check subscription
    if tier_name == 'none':
        subscription = await get_user_subscription(user_id)
        
        if subscription:
            price_id = None
            if subscription.get('items') and subscription['items'].get('data') and len(subscription['items']['data']) > 0:
                price_id = subscription['items']['data'][0]['price']['id']
            else:
                price_id = subscription.get('price_id', config.STRIPE_FREE_TIER_ID)
            
            # Get tier info for this price_id
            tier_info = SUBSCRIPTION_TIERS.get(price_id)
            if tier_info:
                tier_name = tier_info['name']
    
    if tier_name in ['none', 'free']:
        result = []
    else:
        result = model_manager.get_models_for_tier('paid')  
        result = [model.id for model in result]  # Convert to list of IDs
    
    await Cache.set(f"allowed_models_for_user:{user_id}", result, ttl=1 * 60)
    return result


async def can_use_model(client, user_id: str, model_name: str):
    if config.ENV_MODE == EnvMode.LOCAL:
        logger.debug("Running in local development mode - billing checks are disabled")
        return True, "Local development mode - billing disabled", {
            "price_id": "local_dev",
            "plan_name": "Local Development",
            "minutes_limit": "no limit"
        }

    allowed_models = await get_allowed_models_for_user(client, user_id)
    from core.ai_models import model_manager
    resolved_model = model_manager.resolve_model_id(model_name)
    if resolved_model in allowed_models:
        return True, "Model access allowed", allowed_models
    
    return False, f"Your current subscription plan does not include access to {model_name}. Please upgrade your subscription or choose from your available models: {', '.join(allowed_models)}", allowed_models

async def get_subscription_tier(client, user_id: str) -> str:
    try:
        subscription = await get_user_subscription(user_id)
        
        if not subscription:
            return 'free'
        
        price_id = None
        if subscription.get('items') and subscription['items'].get('data') and len(subscription['items']['data']) > 0:
            price_id = subscription['items']['data'][0]['price']['id']
        else:
            price_id = subscription.get('price_id', config.STRIPE_FREE_TIER_ID)
        
        tier_info = SUBSCRIPTION_TIERS.get(price_id)
        if tier_info:
            return tier_info['name']
        
        logger.warning(f"Unknown price_id {price_id} for user {user_id}, defaulting to free tier")
        return 'free'
        
    except Exception as e:
        logger.error(f"Error getting subscription tier for user {user_id}: {str(e)}")
        return 'free'

async def check_billing_status(client, user_id: str) -> Tuple[bool, str, Optional[Dict]]:
    """
    Check if a user can run agents based on their subscription and usage.
    Now also checks credit balance if subscription limit is exceeded.
    
    Returns:
        Tuple[bool, str, Optional[Dict]]: (can_run, message, subscription_info)
    """
    if config.ENV_MODE == EnvMode.LOCAL:
        logger.debug("Running in local development mode - billing checks are disabled")
        return True, "Local development mode - billing disabled", {
            "price_id": "local_dev",
            "plan_name": "Local Development",
            "minutes_limit": "no limit"
        }

    # First check if user has an active trial
    credit_result = await client.from_('credit_accounts').select('tier, trial_status, balance').eq('account_id', user_id).execute()
    
    if credit_result.data and len(credit_result.data) > 0:
        credit_account = credit_result.data[0]
        trial_status = credit_account.get('trial_status')
        
        # If user has an active trial, they can use the platform
        if trial_status == 'active':
            return True, "Active trial", {
                'price_id': config.STRIPE_TIER_2_20_ID,
                'plan_name': 'trial',
                'tier': 'tier_2_20'
            }
        
        # If user has no tier or trial, they cannot use the platform
        tier = credit_account.get('tier', 'none')
        if tier == 'none':
            return False, "No active subscription or trial. Please start a trial or subscribe to use the platform.", None
    
    # Get current subscription
    subscription = await get_user_subscription(user_id)
    
    # If no subscription and no trial, deny access
    if not subscription:
        return False, "No active subscription or trial. Please start a trial or subscribe to use the platform.", None
    
    # Extract price ID from subscription items
    price_id = None
    if subscription.get('items') and subscription['items'].get('data') and len(subscription['items']['data']) > 0:
        price_id = subscription['items']['data'][0]['price']['id']
    else:
        price_id = subscription.get('price_id', config.STRIPE_FREE_TIER_ID)
    
    # Get tier info - default to free tier if not found
    tier_info = SUBSCRIPTION_TIERS.get(price_id)
    if not tier_info:
        logger.warning(f"Unknown subscription tier: {price_id}, defaulting to free tier")
        tier_info = SUBSCRIPTION_TIERS[config.STRIPE_FREE_TIER_ID]
    
    # Calculate current month's usage
    current_usage = await calculate_monthly_usage(client, user_id)
    
    # Check if subscription limit is exceeded
    if current_usage >= tier_info['cost']:
        # Check if user has credits available
        credit_balance = await get_user_credit_balance(client, user_id)
        
        if credit_balance.balance_dollars >= CREDIT_MIN_START_DOLLARS:
            # User has enough credits cushion; they can continue
            return True, f"Subscription limit reached, using credits. Balance: ${credit_balance.balance_dollars:.2f}", subscription
        else:
            # Not enough credits to safely start a new request
            if credit_balance.can_purchase_credits:
                return False, (
                    f"Monthly limit of ${tier_info['cost']} reached. You need at least ${CREDIT_MIN_START_DOLLARS:.2f} in credits to continue. "
                    f"Current balance: ${credit_balance.balance_dollars:.2f}."
                ), subscription
            else:
                return False, (
                    f"Monthly limit of ${tier_info['cost']} reached and credits are unavailable. Please upgrade your plan or wait until next month."
                ), subscription
    
    return True, "OK", subscription

async def check_subscription_commitment(subscription_id: str) -> dict:
    """
    Check if a subscription has an active yearly commitment that prevents cancellation.
    Simple logic: commitment lasts 1 year from subscription creation date.
    """
    try:
        subscription = await stripe.Subscription.retrieve_async(subscription_id)
        
        # Get the price ID from subscription items
        price_id = None
        if subscription.get('items') and subscription['items'].get('data') and len(subscription['items']['data']) > 0:
            price_id = subscription['items']['data'][0]['price']['id']
        
        # Check if subscription has commitment metadata OR uses a yearly commitment price ID
        commitment_type = subscription.metadata.get('commitment_type')
        
        # Yearly commitment price IDs
        yearly_commitment_price_ids = [
            config.STRIPE_TIER_2_17_YEARLY_COMMITMENT_ID,
            config.STRIPE_TIER_6_42_YEARLY_COMMITMENT_ID,
            config.STRIPE_TIER_25_170_YEARLY_COMMITMENT_ID
        ]
        
        is_yearly_commitment = (
            commitment_type == 'yearly_commitment' or 
            price_id in yearly_commitment_price_ids
        )
        
        if is_yearly_commitment:
            # Calculate commitment period: 1 year from subscription creation
            subscription_start = subscription.created
            current_time = int(time.time())
            start_date = datetime.fromtimestamp(subscription_start, tz=timezone.utc)
            commitment_end_date = start_date.replace(year=start_date.year + 1)
            commitment_end_timestamp = int(commitment_end_date.timestamp())
            
            if current_time < commitment_end_timestamp:
                # Still in commitment period
                current_date = datetime.fromtimestamp(current_time, tz=timezone.utc)
                months_remaining = (commitment_end_date.year - current_date.year) * 12 + (commitment_end_date.month - current_date.month)
                if current_date.day > commitment_end_date.day:
                    months_remaining -= 1
                months_remaining = max(0, months_remaining)
                
                logger.debug(f"Subscription {subscription_id} has active yearly commitment: {months_remaining} months remaining")
                
                return {
                    'has_commitment': True,
                    'commitment_type': 'yearly_commitment',
                    'months_remaining': months_remaining,
                    'can_cancel': False,
                    'commitment_end_date': commitment_end_date.isoformat(),
                    'subscription_start_date': start_date.isoformat(),
                    'price_id': price_id
                }
            else:
                # Commitment period has ended
                logger.debug(f"Subscription {subscription_id} yearly commitment period has ended")
                return {
                    'has_commitment': False,
                    'commitment_type': 'yearly_commitment',
                    'commitment_completed': True,
                    'can_cancel': True,
                    'subscription_start_date': start_date.isoformat(),
                    'price_id': price_id
                }
        
        # No commitment
        return {
            'has_commitment': False,
            'can_cancel': True,
            'price_id': price_id
        }
        
    except Exception as e:
        logger.error(f"Error checking subscription commitment: {str(e)}", exc_info=True)
        return {
            'has_commitment': False,
            'can_cancel': True
        }

async def is_user_on_highest_tier(user_id: str) -> bool:
    """Check if user is on the highest subscription tier (200h/$1000)."""
    try:
        subscription = await get_user_subscription(user_id)
        if not subscription:
            logger.debug(f"User {user_id} has no subscription")
            return False
        
        # Extract price ID from subscription
        price_id = None
        if subscription.get('items') and subscription['items'].get('data') and len(subscription['items']['data']) > 0:
            price_id = subscription['items']['data'][0]['price']['id']
        
        logger.debug(f"User {user_id} subscription price_id: {price_id}")
        
        # Check if it's one of the highest tier price IDs (200h/$1000 only)
        highest_tier_price_ids = [
            config.STRIPE_TIER_200_1000_ID,  # Monthly highest tier
            config.STRIPE_TIER_200_1000_YEARLY_ID,  # Yearly highest tier
            config.STRIPE_TIER_25_200_ID_STAGING,
            config.STRIPE_TIER_25_200_YEARLY_ID_STAGING,
            config.STRIPE_TIER_2_20_ID_STAGING,
            config.STRIPE_TIER_2_20_YEARLY_ID_STAGING,
        ]
        
        is_highest = price_id in highest_tier_price_ids
        logger.debug(f"User {user_id} is_highest_tier: {is_highest}, price_id: {price_id}, checked against: {highest_tier_price_ids}")
        
        return is_highest
        
    except Exception as e:
        logger.error(f"Error checking if user is on highest tier: {str(e)}")
        return False

async def get_user_credit_balance(client: SupabaseClient, user_id: str) -> CreditBalance:
    """Get the credit balance for a user."""
    try:
        # Get balance from database - use execute() instead of single() to handle no records
        result = await client.table('credit_balance') \
            .select('*') \
            .eq('user_id', user_id) \
            .execute()
        
        if result.data and len(result.data) > 0:
            data = result.data[0]
            is_highest_tier = await is_user_on_highest_tier(user_id)
            
            # Safely handle last_updated datetime conversion
            last_updated = None
            if data.get('last_updated'):
                try:
                    # If it's already a datetime object, use it
                    if isinstance(data['last_updated'], datetime):
                        last_updated = data['last_updated']
                    else:
                        # Try to parse it as a string
                        last_updated = dateutil_parser.parse(data['last_updated'])
                except Exception as dt_error:
                    logger.warning(f"Error parsing last_updated datetime for user {user_id}: {dt_error}")
                    last_updated = None
            
            return CreditBalance(
                balance_dollars=float(data.get('balance_dollars', 0)),
                total_purchased=float(data.get('total_purchased', 0)),
                total_used=float(data.get('total_used', 0)),
                last_updated=last_updated,
                can_purchase_credits=is_highest_tier
            )
        else:
            # No balance record exists yet - this is normal for users who haven't purchased credits
            is_highest_tier = await is_user_on_highest_tier(user_id)
            return CreditBalance(
                balance_dollars=0.0,
                total_purchased=0.0,
                total_used=0.0,
                can_purchase_credits=is_highest_tier
            )
    except Exception as e:
        logger.error(f"Error getting credit balance for user {user_id}: {str(e)}")
        return CreditBalance(
            balance_dollars=0.0,
            total_purchased=0.0,
            total_used=0.0,
            can_purchase_credits=False
        )

async def add_credits_to_balance(client: SupabaseClient, user_id: str, amount: float, purchase_id: str = None) -> float:
    """Add credits to a user's balance."""
    try:
        # Use the database function to add credits
        result = await client.rpc('add_credits', {
            'p_user_id': user_id,
            'p_amount': amount,
            'p_purchase_id': purchase_id
        }).execute()
        
        if result.data is not None:
            return float(result.data)
        return 0.0
    except Exception as e:
        logger.error(f"Error adding credits for user {user_id}: {str(e)}")
        raise

async def use_credits_from_balance(
    client: SupabaseClient, 
    user_id: str, 
    amount: float, 
    description: str = None,
    thread_id: str = None,
    message_id: str = None
) -> bool:
    """Deduct credits from a user's balance."""
    try:
        # Use the database function to use credits
        result = await client.rpc('use_credits', {
            'p_user_id': user_id,
            'p_amount': amount,
            'p_description': description,
            'p_thread_id': thread_id,
            'p_message_id': message_id
        }).execute()
        
        if result.data is not None:
            return bool(result.data)
        return False
    except Exception as e:
        logger.error(f"Error using credits for user {user_id}: {str(e)}")
        return False

async def handle_usage_with_credits(
    client: SupabaseClient,
    user_id: str,
    token_cost: float,
    thread_id: str = None,
    message_id: str = None,
    model: str = None
) -> Tuple[bool, str]:
    """
    Handle token usage that may require credits if subscription limit is exceeded.
    This should be called after each agent response to track and deduct from credits if needed.
    
    Returns:
        Tuple[bool, str]: (success, message)
    """
    try:
        # Get current subscription tier and limits
        subscription = await get_user_subscription(user_id)
        
        # Get tier info
        price_id = config.STRIPE_FREE_TIER_ID  # Default to free
        if subscription and subscription.get('items'):
            items = subscription['items'].get('data', [])
            if items:
                price_id = items[0]['price']['id']
        
        tier_info = SUBSCRIPTION_TIERS.get(price_id, SUBSCRIPTION_TIERS[config.STRIPE_FREE_TIER_ID])
        
        # Get current month's usage
        current_usage = await calculate_monthly_usage(client, user_id)
        
        # Check if this usage would exceed the subscription limit
        new_total_usage = current_usage + token_cost
        
        if new_total_usage > tier_info['cost']:
            # Calculate overage amount
            overage_amount = token_cost  # The entire cost if already over limit
            if current_usage < tier_info['cost']:
                # If this is the transaction that pushes over the limit
                overage_amount = new_total_usage - tier_info['cost']
            
            # Try to use credits for the overage
            credit_balance = await get_user_credit_balance(client, user_id)
            
            if credit_balance.balance_dollars >= overage_amount:
                # Deduct from credits
                success = await use_credits_from_balance(
                    client,
                    user_id,
                    overage_amount,
                    description=f"Token overage for model {model or 'unknown'}",
                    thread_id=thread_id,
                    message_id=message_id
                )
                
                if success:
                    logger.debug(f"Used ${overage_amount:.4f} credits for user {user_id} overage")
                    return True, f"Used ${overage_amount:.4f} from credits (Balance: ${credit_balance.balance_dollars - overage_amount:.2f})"
                else:
                    return False, "Failed to deduct credits"
            else:
                # Insufficient credits
                if credit_balance.can_purchase_credits:
                    return False, f"Insufficient credits. Balance: ${credit_balance.balance_dollars:.2f}, Required: ${overage_amount:.4f}. Purchase more credits to continue."
                else:
                    return False, f"Monthly limit exceeded and no credits available. Upgrade to the highest tier to purchase credits."
        
        # Within subscription limits, no credits needed
        return True, "Within subscription limits"
        
    except Exception as e:
        logger.error(f"Error handling usage with credits: {str(e)}")
        return False, f"Error processing usage: {str(e)}"

# API endpoints
@router.post("/create-checkout-session")
async def create_checkout_session(
    request: CreateCheckoutSessionRequest,
    current_user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """Create a Stripe Checkout session or modify an existing subscription."""
    try:
        # Get Supabase client
        db = DBConnection()
        client = await db.client
        
        # Get user email from auth.users
        user_result = await client.auth.admin.get_user_by_id(current_user_id)
        if not user_result: raise HTTPException(status_code=404, detail="User not found")
        email = user_result.user.email
        
        # Get or create Stripe customer
        customer_id = await get_stripe_customer_id(client, current_user_id)
        if not customer_id: customer_id = await create_stripe_customer(client, current_user_id, email)
        
        # Get the target price and product ID
        try:
            price = await stripe.Price.retrieve_async(request.price_id, expand=['product'])
            product_id = price['product']['id']
        except stripe.error.InvalidRequestError:
            raise HTTPException(status_code=400, detail=f"Invalid price ID: {request.price_id}")
            
        # Verify the price belongs to our product
        if product_id != config.STRIPE_PRODUCT_ID:
            raise HTTPException(status_code=400, detail="Price ID does not belong to the correct product.")
            
        # Check for existing subscription for our product
        existing_subscription = await get_user_subscription(current_user_id)
        # print("Existing subscription for product:", existing_subscription)
        
        if existing_subscription:
            # --- Handle Subscription Change (Upgrade or Downgrade) ---
            try:
                subscription_id = existing_subscription['id']
                subscription_item = existing_subscription['items']['data'][0]
                current_price_id = subscription_item['price']['id']
                
                # Skip if already on this plan
                if current_price_id == request.price_id:
                    return {
                        "subscription_id": subscription_id,
                        "status": "no_change",
                        "message": "Already subscribed to this plan.",
                        "details": {
                            "is_upgrade": None,
                            "effective_date": None,
                            "current_price": round(price['unit_amount'] / 100, 2) if price.get('unit_amount') else 0,
                            "new_price": round(price['unit_amount'] / 100, 2) if price.get('unit_amount') else 0,
                        }
                    }
                
                # Validate plan change restrictions
                is_allowed, restriction_reason = is_plan_change_allowed(current_price_id, request.price_id)
                if not is_allowed:
                    raise HTTPException(
                        status_code=400, 
                        detail=f"Plan change not allowed: {restriction_reason}"
                    )
                
                # Check current subscription's commitment status
                commitment_info = await check_subscription_commitment(subscription_id)
                
                # Get current and new price details
                current_price = await stripe.Price.retrieve_async(current_price_id)
                new_price = price # Already retrieved
                
                # Determine if this is an upgrade
                # Consider yearly plans as upgrades regardless of unit price (due to discounts)
                current_interval = current_price.get('recurring', {}).get('interval', 'month')
                new_interval = new_price.get('recurring', {}).get('interval', 'month')
                
                is_upgrade = (
                    new_price['unit_amount'] > current_price['unit_amount'] or  # Traditional price upgrade
                    (current_interval == 'month' and new_interval == 'year')    # Monthly to yearly upgrade
                )
                
                logger.debug(f"Price comparison: current={current_price['unit_amount']}, new={new_price['unit_amount']}, "
                           f"intervals: {current_interval}->{new_interval}, is_upgrade={is_upgrade}")

                # For commitment subscriptions, handle differently
                if commitment_info.get('has_commitment'):
                    if is_upgrade:
                        # Allow upgrades for commitment subscriptions immediately
                        logger.debug(f"Upgrading commitment subscription {subscription_id}")
                        
                        # Regular subscription modification for upgrades
                        updated_subscription = await stripe.Subscription.modify_async(
                            subscription_id,
                            items=[{
                                'id': subscription_item['id'],
                                'price': request.price_id,
                            }],
                            proration_behavior='always_invoice',  # Prorate and charge immediately
                            billing_cycle_anchor='now',          # Reset billing cycle
                            metadata={
                                **existing_subscription.get('metadata', {}),
                                'commitment_type': request.commitment_type or 'monthly'
                            }
                        )
                        
                        # Update active status in database
                        await client.schema('basejump').from_('billing_customers').update(
                            {'active': True}
                        ).eq('id', customer_id).execute()
                        logger.debug(f"Updated customer {customer_id} active status to TRUE after subscription upgrade")
                        
                        # Force immediate payment for upgrades
                        latest_invoice = None
                        if updated_subscription.latest_invoice:
                            latest_invoice_id = updated_subscription.latest_invoice
                            latest_invoice = await stripe.Invoice.retrieve_async(latest_invoice_id)
                            
                            try:
                                logger.debug(f"Latest invoice {latest_invoice_id} status: {latest_invoice.status}")
                                
                                # If invoice is in draft status, finalize it to trigger immediate payment
                                if latest_invoice.status == 'draft':
                                    finalized_invoice = stripe.Invoice.finalize_invoice(latest_invoice_id)
                                    logger.debug(f"Finalized invoice {latest_invoice_id} for immediate payment")
                                    latest_invoice = finalized_invoice
                                    
                                    # Pay the invoice immediately if it's still open
                                    if finalized_invoice.status == 'open':
                                        paid_invoice = stripe.Invoice.pay(latest_invoice_id)
                                        logger.debug(f"Paid invoice {latest_invoice_id} immediately, status: {paid_invoice.status}")
                                        latest_invoice = paid_invoice
                                elif latest_invoice.status == 'open':
                                    # Invoice is already finalized but not paid, pay it
                                    paid_invoice = stripe.Invoice.pay(latest_invoice_id)
                                    logger.debug(f"Paid existing open invoice {latest_invoice_id}, status: {paid_invoice.status}")
                                    latest_invoice = paid_invoice
                                else:
                                    logger.debug(f"Invoice {latest_invoice_id} is in status {latest_invoice.status}, no action needed")
                                    
                            except Exception as invoice_error:
                                logger.error(f"Error processing invoice for immediate payment: {str(invoice_error)}")
                                # Don't fail the entire operation if invoice processing fails
                        
                        return {
                            "subscription_id": updated_subscription.id,
                            "status": "updated",
                            "message": f"Subscription upgraded successfully",
                            "details": {
                                "is_upgrade": True,
                                "effective_date": "immediate",
                                "current_price": round(current_price['unit_amount'] / 100, 2) if current_price.get('unit_amount') else 0,
                                "new_price": round(new_price['unit_amount'] / 100, 2) if new_price.get('unit_amount') else 0,
                                "invoice": {
                                    "id": latest_invoice['id'] if latest_invoice else None,
                                    "status": latest_invoice['status'] if latest_invoice else None,
                                    "amount_due": round(latest_invoice['amount_due'] / 100, 2) if latest_invoice else 0,
                                    "amount_paid": round(latest_invoice['amount_paid'] / 100, 2) if latest_invoice else 0
                                } if latest_invoice else None
                            }
                        }
                    else:
                        # Downgrade for commitment subscription - must wait until commitment ends
                        if not commitment_info.get('can_cancel'):
                            return {
                                "subscription_id": subscription_id,
                                "status": "commitment_blocks_downgrade",
                                "message": f"Cannot downgrade during commitment period. {commitment_info.get('months_remaining', 0)} months remaining.",
                                "details": {
                                    "is_upgrade": False,
                                    "effective_date": commitment_info.get('commitment_end_date'),
                                    "current_price": round(current_price['unit_amount'] / 100, 2) if current_price.get('unit_amount') else 0,
                                    "new_price": round(new_price['unit_amount'] / 100, 2) if new_price.get('unit_amount') else 0,
                                    "commitment_end_date": commitment_info.get('commitment_end_date'),
                                    "months_remaining": commitment_info.get('months_remaining', 0)
                                }
                            }
                        # If commitment allows cancellation, proceed with normal downgrade logic
                else:
                    # Regular subscription without commitment - use existing logic
                    pass

                if is_upgrade:
                    # --- Handle Upgrade --- Immediate modification
                    updated_subscription = await stripe.Subscription.modify_async(
                        subscription_id,
                        items=[{
                            'id': subscription_item['id'],
                            'price': request.price_id,
                        }],
                        proration_behavior='always_invoice', # Prorate and charge immediately
                        billing_cycle_anchor='now' # Reset billing cycle
                    )
                    
                    # Update active status in database to true (customer has active subscription)
                    await client.schema('basejump').from_('billing_customers').update(
                        {'active': True}
                    ).eq('id', customer_id).execute()
                    logger.debug(f"Updated customer {customer_id} active status to TRUE after subscription upgrade")
                    
                    latest_invoice = None
                    if updated_subscription.latest_invoice:
                        latest_invoice_id = updated_subscription.latest_invoice
                        latest_invoice = await stripe.Invoice.retrieve_async(latest_invoice_id)
                        
                        # Force immediate payment for upgrades
                        try:
                            logger.debug(f"Latest invoice {latest_invoice_id} status: {latest_invoice.status}")
                            
                            # If invoice is in draft status, finalize it to trigger immediate payment
                            if latest_invoice.status == 'draft':
                                finalized_invoice = stripe.Invoice.finalize_invoice(latest_invoice_id)
                                logger.debug(f"Finalized invoice {latest_invoice_id} for immediate payment")
                                latest_invoice = finalized_invoice  # Update reference
                                
                                # Pay the invoice immediately if it's still open
                                if finalized_invoice.status == 'open':
                                    paid_invoice = stripe.Invoice.pay(latest_invoice_id)
                                    logger.debug(f"Paid invoice {latest_invoice_id} immediately, status: {paid_invoice.status}")
                                    latest_invoice = paid_invoice  # Update reference
                            elif latest_invoice.status == 'open':
                                # Invoice is already finalized but not paid, pay it
                                paid_invoice = stripe.Invoice.pay(latest_invoice_id)
                                logger.debug(f"Paid existing open invoice {latest_invoice_id}, status: {paid_invoice.status}")
                                latest_invoice = paid_invoice  # Update reference
                            else:
                                logger.debug(f"Invoice {latest_invoice_id} is in status {latest_invoice.status}, no action needed")
                                
                        except Exception as invoice_error:
                            logger.error(f"Error processing invoice for immediate payment: {str(invoice_error)}")
                            # Don't fail the entire operation if invoice processing fails
                    
                    return {
                        "subscription_id": updated_subscription.id,
                        "status": "updated",
                        "message": "Subscription upgraded successfully",
                        "details": {
                            "is_upgrade": True,
                            "effective_date": "immediate",
                            "current_price": round(current_price['unit_amount'] / 100, 2) if current_price.get('unit_amount') else 0,
                            "new_price": round(new_price['unit_amount'] / 100, 2) if new_price.get('unit_amount') else 0,
                            "invoice": {
                                "id": latest_invoice['id'] if latest_invoice else None,
                                "status": latest_invoice['status'] if latest_invoice else None,
                                "amount_due": round(latest_invoice['amount_due'] / 100, 2) if latest_invoice else 0,
                                "amount_paid": round(latest_invoice['amount_paid'] / 100, 2) if latest_invoice else 0
                            } if latest_invoice else None
                        }
                    }
                else:
                    # --- Handle Downgrade --- Simple downgrade at period end
                    updated_subscription = await stripe.Subscription.modify_async(
                        subscription_id,
                        items=[{
                            'id': subscription_item['id'],
                            'price': request.price_id,
                        }],
                        proration_behavior='none',  # No proration for downgrades
                        billing_cycle_anchor='unchanged'  # Keep current billing cycle
                    )
                    
                    # Update active status in database
                    await client.schema('basejump').from_('billing_customers').update(
                        {'active': True}
                    ).eq('id', customer_id).execute()
                    logger.debug(f"Updated customer {customer_id} active status to TRUE after subscription downgrade")
                    
                    return {
                        "subscription_id": updated_subscription.id,
                        "status": "updated",
                        "message": "Subscription downgraded successfully",
                        "details": {
                            "is_upgrade": False,
                            "effective_date": "immediate",
                            "current_price": round(current_price['unit_amount'] / 100, 2) if current_price.get('unit_amount') else 0,
                            "new_price": round(new_price['unit_amount'] / 100, 2) if new_price.get('unit_amount') else 0,
                        }
                    }
            except Exception as e:
                logger.exception(f"Error updating subscription {existing_subscription.get('id') if existing_subscription else 'N/A'}: {str(e)}")
                raise HTTPException(status_code=500, detail=f"Error updating subscription: {str(e)}")
        else:
            # Create regular subscription with commitment metadata if specified
            session = await stripe.checkout.Session.create_async(
                customer=customer_id,
                payment_method_types=['card'],
                line_items=[{'price': request.price_id, 'quantity': 1}],
                mode='subscription',
                subscription_data={
                    'metadata': {
                        'commitment_type': request.commitment_type or 'monthly',
                        'user_id': current_user_id
                    }
                },
                success_url=request.success_url,
                cancel_url=request.cancel_url,
                metadata={
                    'user_id': current_user_id,
                    'product_id': product_id,
                    'tolt_referral': request.tolt_referral,
                    'commitment_type': request.commitment_type or 'monthly'
                },
                allow_promotion_codes=True
            )
            
            # Update customer status to potentially active (will be confirmed by webhook)
            await client.schema('basejump').from_('billing_customers').update(
                {'active': True}
            ).eq('id', customer_id).execute()
            logger.debug(f"Updated customer {customer_id} active status to TRUE after creating checkout session")
            
            return {"session_id": session['id'], "url": session['url'], "status": "new"}
        
    except Exception as e:
        logger.exception(f"Error creating checkout session: {str(e)}")
        # Check if it's a Stripe error with more details
        if hasattr(e, 'json_body') and e.json_body and 'error' in e.json_body:
            error_detail = e.json_body['error'].get('message', str(e))
        else:
            error_detail = str(e)
        raise HTTPException(status_code=500, detail=f"Error creating checkout session: {error_detail}")

@router.post("/create-portal-session")
async def create_portal_session(
    request: CreatePortalSessionRequest,
    current_user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """Create a Stripe Customer Portal session for subscription management."""
    try:
        # Get Supabase client
        db = DBConnection()
        client = await db.client
        
        # Get customer ID
        customer_id = await get_stripe_customer_id(client, current_user_id)
        if not customer_id:
            raise HTTPException(status_code=404, detail="No billing customer found")
        
        # Ensure the portal configuration has subscription_update enabled
        try:
            # First, check if we have a configuration that already enables subscription update
            configurations = await stripe.billing_portal.Configuration.list_async(limit=100)
            active_config = None
            
            # Look for a configuration with subscription_update enabled
            for config in configurations.get('data', []):
                features = config.get('features', {})
                subscription_update = features.get('subscription_update', {})
                if subscription_update.get('enabled', False):
                    active_config = config
                    logger.debug(f"Found existing portal configuration with subscription_update enabled: {config['id']}")
                    break
            
            # If no config with subscription_update found, create one or update the active one
            if not active_config:
                # Find the active configuration or create a new one
                if configurations.get('data', []):
                    default_config = configurations['data'][0]
                    logger.debug(f"Updating default portal configuration: {default_config['id']} to enable subscription_update")
                    
                    active_config = await stripe.billing_portal.Configuration.update_async(
                        default_config['id'],
                        features={
                            'subscription_update': {
                                'enabled': True,
                                'proration_behavior': 'create_prorations',
                                'default_allowed_updates': ['price']
                            },
                            # Preserve other features that may already be enabled
                            'customer_update': default_config.get('features', {}).get('customer_update', {'enabled': True, 'allowed_updates': ['email', 'address']}),
                            'invoice_history': {'enabled': True},
                            'payment_method_update': {'enabled': True}
                        }
                    )
                else:
                    # Create a new configuration with subscription_update enabled
                    logger.debug("Creating new portal configuration with subscription_update enabled")
                    active_config = await stripe.billing_portal.Configuration.create_async(
                        business_profile={
                            'headline': 'Subscription Management',
                            'privacy_policy_url': config.FRONTEND_URL + '/privacy',
                            'terms_of_service_url': config.FRONTEND_URL + '/terms'
                        },
                        features={
                            'subscription_update': {
                                'enabled': True,
                                'proration_behavior': 'create_prorations',
                                'default_allowed_updates': ['price']
                            },
                            'customer_update': {
                                'enabled': True,
                                'allowed_updates': ['email', 'address']
                            },
                            'invoice_history': {'enabled': True},
                            'payment_method_update': {'enabled': True}
                        }
                    )
            
            # Log the active configuration for debugging
            logger.debug(f"Using portal configuration: {active_config['id']} with subscription_update: {active_config.get('features', {}).get('subscription_update', {}).get('enabled', False)}")
        
        except Exception as config_error:
            logger.warning(f"Error configuring portal: {config_error}. Continuing with default configuration.")
        
        # Create portal session using the proper configuration if available
        portal_params = {
            "customer": customer_id,
            "return_url": request.return_url
        }
        
        # Add configuration_id if we found or created one with subscription_update enabled
        if active_config:
            portal_params["configuration"] = active_config['id']
        
        # Create the session
        session = await stripe.billing_portal.Session.create_async(**portal_params)
        
        return {"url": session.url}
        
    except Exception as e:
        logger.error(f"Error creating portal session: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/subscription")
async def get_subscription(
    current_user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """Get the current subscription status for the current user, including scheduled changes and credit balance."""
    try:
        logger.debug(f"Getting subscription status for user {current_user_id}")
        
        # Initialize default values with safe fallbacks
        subscription = None
        current_usage = 0.0
        credit_balance_info = None
        
        # Get subscription from Stripe with error handling
        try:
            subscription = await get_user_subscription(current_user_id)
            logger.debug(f"Retrieved subscription data for user {current_user_id}: {subscription is not None}")
        except Exception as sub_error:
            logger.error(f"Error retrieving subscription for user {current_user_id}: {str(sub_error)}")
            # Continue with None subscription - will default to free tier
        
        # Calculate current usage with error handling
        try:
            db = DBConnection()
            client = await db.client
            current_usage = await calculate_monthly_usage(client, current_user_id)
            logger.debug(f"Retrieved usage for user {current_user_id}: {current_usage}")
        except Exception as usage_error:
            logger.error(f"Error calculating usage for user {current_user_id}: {str(usage_error)}")
            current_usage = 0.0  # Default to 0 if calculation fails
        
        # Get credit balance with error handling
        try:
            if 'client' not in locals():
                db = DBConnection()
                client = await db.client
            credit_balance_info = await get_user_credit_balance(client, current_user_id)
            logger.debug(f"Retrieved credit balance for user {current_user_id}: {credit_balance_info.balance_dollars if credit_balance_info else 'None'}")
        except Exception as balance_error:
            logger.error(f"Error getting credit balance for user {current_user_id}: {str(balance_error)}")
            # Create safe fallback credit balance
            credit_balance_info = CreditBalance(
                balance_dollars=0.0,
                total_purchased=0.0,
                total_used=0.0,
                can_purchase_credits=False
            )

        # Return free tier if no subscription
        if not subscription:
            logger.debug(f"No subscription found for user {current_user_id}, returning free tier")
            free_tier_id = config.STRIPE_FREE_TIER_ID
            free_tier_info = SUBSCRIPTION_TIERS.get(free_tier_id)
            return SubscriptionStatus(
                status="no_subscription",
                plan_name=free_tier_info.get('name', 'free') if free_tier_info else 'free',
                price_id=free_tier_id,
                minutes_limit=free_tier_info.get('minutes') if free_tier_info else 0,
                cost_limit=free_tier_info.get('cost') if free_tier_info else 0,
                current_usage=current_usage,
                credit_balance=credit_balance_info.balance_dollars if credit_balance_info else 0.0,
                can_purchase_credits=credit_balance_info.can_purchase_credits if credit_balance_info else False
            )
        
        # Safely extract current plan details with validation
        try:
            if not subscription.get('items') or not subscription['items'].get('data'):
                raise ValueError("Subscription has no items data")
                
            current_item = subscription['items']['data'][0]
            if not current_item.get('price') or not current_item['price'].get('id'):
                raise ValueError("Subscription item has no price data")
                
            current_price_id = current_item['price']['id']
            current_tier_info = SUBSCRIPTION_TIERS.get(current_price_id)
            
            if not current_tier_info:
                logger.warning(f"User {current_user_id} subscribed to unknown price {current_price_id}. Using defaults.")
                current_tier_info = {'name': 'unknown', 'minutes': 0, 'cost': 0}
            
            # Safely get timestamps with validation
            current_period_end = None
            trial_end = None
            
            try:
                if current_item.get('current_period_end'):
                    current_period_end = datetime.fromtimestamp(current_item['current_period_end'], tz=timezone.utc)
            except (ValueError, TypeError, OSError) as ts_error:
                logger.error(f"Error parsing current_period_end timestamp for user {current_user_id}: {ts_error}")
                current_period_end = None
                
            try:
                if subscription.get('trial_end'):
                    trial_end = datetime.fromtimestamp(subscription['trial_end'], tz=timezone.utc)
            except (ValueError, TypeError, OSError) as ts_error:
                logger.error(f"Error parsing trial_end timestamp for user {current_user_id}: {ts_error}")
                trial_end = None
            
            # Safely construct subscription object for response
            subscription_data = {
                'id': subscription.get('id', ''),
                'status': subscription.get('status', 'unknown'),
                'cancel_at_period_end': bool(subscription.get('cancel_at_period_end', False)),
                'cancel_at': subscription.get('cancel_at'),
                'current_period_end': current_item.get('current_period_end')
            }
            
            # Get plan name safely
            plan_name = 'unknown'
            if subscription.get('plan') and subscription['plan'].get('nickname'):
                plan_name = subscription['plan']['nickname']
            elif current_tier_info.get('name'):
                plan_name = current_tier_info['name']
            
            status_response = SubscriptionStatus(
                status=subscription.get('status', 'unknown'),
                plan_name=plan_name,
                price_id=current_price_id,
                current_period_end=current_period_end,
                cancel_at_period_end=bool(subscription.get('cancel_at_period_end', False)),
                trial_end=trial_end,
                minutes_limit=current_tier_info.get('minutes', 0),
                cost_limit=current_tier_info.get('cost', 0),
                current_usage=current_usage,
                has_schedule=False,
                subscription_id=subscription.get('id'),
                subscription=subscription_data,
                credit_balance=credit_balance_info.balance_dollars if credit_balance_info else 0.0,
                can_purchase_credits=credit_balance_info.can_purchase_credits if credit_balance_info else False
            )

            # Check for an attached schedule (indicates pending downgrade) with error handling
            schedule_id = subscription.get('schedule')
            if schedule_id:
                try:
                    logger.debug(f"Processing subscription schedule {schedule_id} for user {current_user_id}")
                    schedule = await stripe.SubscriptionSchedule.retrieve_async(schedule_id)
                    
                    # Find the *next* phase after the current one
                    next_phase = None
                    current_phase_end = current_item.get('current_period_end')
                    
                    if current_phase_end and schedule.get('phases'):
                        for phase in schedule.get('phases', []):
                            if phase.get('start_date') == current_phase_end:
                                next_phase = phase
                                break

                    if next_phase and next_phase.get('items'):
                        try:
                            scheduled_item = next_phase['items'][0]
                            scheduled_price_id = scheduled_item.get('price', '')
                            scheduled_tier_info = SUBSCRIPTION_TIERS.get(scheduled_price_id, {})
                            
                            scheduled_change_date = None
                            if next_phase.get('start_date'):
                                try:
                                    scheduled_change_date = datetime.fromtimestamp(next_phase['start_date'], tz=timezone.utc)
                                except (ValueError, TypeError, OSError) as ts_error:
                                    logger.error(f"Error parsing scheduled change date for user {current_user_id}: {ts_error}")
                            
                            status_response.has_schedule = True
                            status_response.status = 'scheduled_downgrade'
                            status_response.scheduled_plan_name = scheduled_tier_info.get('name', 'unknown')
                            status_response.scheduled_price_id = scheduled_price_id
                            status_response.scheduled_change_date = scheduled_change_date
                            
                        except Exception as schedule_parse_error:
                            logger.error(f"Error parsing schedule details for user {current_user_id}: {schedule_parse_error}")
                            
                except Exception as schedule_error:
                    logger.error(f"Error retrieving schedule {schedule_id} for user {current_user_id}: {schedule_error}")

            logger.debug(f"Successfully constructed subscription response for user {current_user_id}")
            
            # Validate JSON serialization before returning
            try:
                # Test serialization using FastAPI's JSON encoder
                test_dict = status_response.model_dump()
                json.dumps(test_dict, default=str)  # Use default=str to handle datetime objects
                logger.debug(f"JSON serialization validation passed for user {current_user_id}")
            except Exception as json_error:
                logger.error(f"JSON serialization failed for user {current_user_id}: {json_error}")
                logger.error(f"Response data: {status_response.model_dump()}")
                # Fall back to safe response
                free_tier_id = config.STRIPE_FREE_TIER_ID
                free_tier_info = SUBSCRIPTION_TIERS.get(free_tier_id)
                return SubscriptionStatus(
                    status="error",
                    plan_name=free_tier_info.get('name', 'free') if free_tier_info else 'free',
                    price_id=free_tier_id,
                    minutes_limit=free_tier_info.get('minutes') if free_tier_info else 0,
                    cost_limit=free_tier_info.get('cost') if free_tier_info else 0,
                    current_usage=current_usage,
                    credit_balance=credit_balance_info.balance_dollars if credit_balance_info else 0.0,
                    can_purchase_credits=credit_balance_info.can_purchase_credits if credit_balance_info else False
                )
            
            return status_response
            
        except Exception as parsing_error:
            logger.error(f"Error parsing subscription data for user {current_user_id}: {str(parsing_error)}")
            # Fall back to free tier if subscription data is malformed
            free_tier_id = config.STRIPE_FREE_TIER_ID
            free_tier_info = SUBSCRIPTION_TIERS.get(free_tier_id)
            return SubscriptionStatus(
                status="no_subscription",
                plan_name=free_tier_info.get('name', 'free') if free_tier_info else 'free',
                price_id=free_tier_id,
                minutes_limit=free_tier_info.get('minutes') if free_tier_info else 0,
                cost_limit=free_tier_info.get('cost') if free_tier_info else 0,
                current_usage=current_usage,
                credit_balance=credit_balance_info.balance_dollars if credit_balance_info else 0.0,
                can_purchase_credits=credit_balance_info.can_purchase_credits if credit_balance_info else False
            )
        
    except Exception as e:
        logger.exception(f"Error getting subscription status for user {current_user_id}: {str(e)}")
        # Return a safe fallback response instead of raising an error
        try:
            free_tier_id = config.STRIPE_FREE_TIER_ID
            free_tier_info = SUBSCRIPTION_TIERS.get(free_tier_id)
            return SubscriptionStatus(
                status="error",
                plan_name=free_tier_info.get('name', 'free') if free_tier_info else 'free',
                price_id=free_tier_id,
                minutes_limit=free_tier_info.get('minutes') if free_tier_info else 0,
                cost_limit=free_tier_info.get('cost') if free_tier_info else 0,
                current_usage=0.0,
                credit_balance=0.0,
                can_purchase_credits=False
            )
        except Exception as fallback_error:
            logger.exception(f"Error creating fallback response for user {current_user_id}: {str(fallback_error)}")
            raise HTTPException(status_code=500, detail="Error retrieving subscription status.")

@router.get("/check-status")
async def check_status(
    current_user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """Check if the user can run agents based on their subscription, usage, and credit balance."""
    try:
        # Get Supabase client
        db = DBConnection()
        client = await db.client
        
        can_run, message, subscription = await check_billing_status(client, current_user_id)
        
        # Get credit balance for additional info
        credit_balance = await get_user_credit_balance(client, current_user_id)
        
        return {
            "can_run": can_run,
            "message": message,
            "subscription": subscription,
            "credit_balance": credit_balance.balance_dollars,
            "can_purchase_credits": credit_balance.can_purchase_credits
        }
        
    except Exception as e:
        logger.error(f"Error checking billing status: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/webhook")
async def stripe_webhook(request: Request):
    """Handle Stripe webhook events."""
    try:
        # Get the webhook secret from config
        webhook_secret = config.STRIPE_WEBHOOK_SECRET
        
        # Get the webhook payload
        payload = await request.body()
        sig_header = request.headers.get('stripe-signature')
        
        # Verify webhook signature
        try:
            event = stripe.Webhook.construct_event(
                payload, sig_header, webhook_secret
            )
            logger.debug(f"Received Stripe webhook: {event.type} - Event ID: {event.id}")
        except ValueError as e:
            logger.error(f"Invalid webhook payload: {str(e)}")
            raise HTTPException(status_code=400, detail="Invalid payload")
        except stripe.error.SignatureVerificationError as e:
            logger.error(f"Invalid webhook signature: {str(e)}")
            raise HTTPException(status_code=400, detail="Invalid signature")
        
        # Get database connection
        db = DBConnection()
        client = await db.client
        
        # Handle credit purchase completion
        if event.type == 'checkout.session.completed':
            session = event.data.object
            
            # Check if this is a credit purchase
            if session.get('metadata', {}).get('type') == 'credit_purchase':
                user_id = session['metadata']['user_id']
                credit_amount = float(session['metadata']['credit_amount'])
                payment_intent_id = session.get('payment_intent')
                
                logger.debug(f"Processing credit purchase for user {user_id}: ${credit_amount}")
                
                try:
                    # Update the purchase record status
                    purchase_update = await client.table('credit_purchases') \
                        .update({
                            'status': 'completed',
                            'completed_at': datetime.now(timezone.utc).isoformat(),
                            'stripe_payment_intent_id': payment_intent_id
                        }) \
                        .eq('stripe_payment_intent_id', payment_intent_id) \
                        .execute()
                    
                    if not purchase_update.data:
                        # If no record found by payment_intent_id, try by session_id in metadata (PostgREST JSON operator requires filter)
                        purchase_update = await client.table('credit_purchases') \
                            .update({
                                'status': 'completed',
                                'completed_at': datetime.now(timezone.utc).isoformat(),
                                'stripe_payment_intent_id': payment_intent_id
                            }) \
                            .filter('metadata->>session_id', 'eq', session['id']) \
                            .execute()
                    
                    # Add credits to user's balance
                    purchase_id = purchase_update.data[0]['id'] if purchase_update.data else None
                    new_balance = await add_credits_to_balance(client, user_id, credit_amount, purchase_id)
                    
                    logger.debug(f"Successfully added ${credit_amount} credits to user {user_id}. New balance: ${new_balance}")
                    
                    # Clear cache for this user
                    await Cache.delete(f"monthly_usage:{user_id}")
                    await Cache.delete(f"user_subscription:{user_id}")
                    
                except Exception as e:
                    logger.error(f"Error processing credit purchase: {str(e)}")
                    # Don't fail the webhook, but log the error
                
                return {"status": "success", "message": "Credit purchase processed"}
        
        # Handle payment failed for credit purchases
        if event.type == 'payment_intent.payment_failed':
            payment_intent = event.data.object
            
            # Check if this is related to a credit purchase
            if payment_intent.get('metadata', {}).get('type') == 'credit_purchase':
                user_id = payment_intent['metadata']['user_id']
                
                # Update purchase record to failed
                await client.table('credit_purchases') \
                    .update({'status': 'failed'}) \
                    .eq('stripe_payment_intent_id', payment_intent['id']) \
                    .execute()
                
                logger.debug(f"Credit purchase failed for user {user_id}")
        
        # Handle the existing subscription events
        if event.type in ['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted']:
            # Extract the subscription and customer information
            subscription = event.data.object
            customer_id = subscription.get('customer')
            
            if not customer_id:
                logger.warning(f"No customer ID found in subscription event: {event.type}")
                return {"status": "error", "message": "No customer ID found"}
            
            if event.type == 'customer.subscription.created':
                # Update customer active status for new subscriptions
                if subscription.get('status') in ['active', 'trialing']:
                    await client.schema('basejump').from_('billing_customers').update(
                        {'active': True}
                    ).eq('id', customer_id).execute()
                    logger.debug(f"Webhook: Updated customer {customer_id} active status to TRUE based on {event.type}")
                    
            elif event.type == 'customer.subscription.updated':
                # Check if subscription is active
                if subscription.get('status') in ['active', 'trialing']:
                    # Update customer's active status to true
                    await client.schema('basejump').from_('billing_customers').update(
                        {'active': True}
                    ).eq('id', customer_id).execute()
                    logger.debug(f"Webhook: Updated customer {customer_id} active status to TRUE based on {event.type}")
                else:
                    # Subscription is not active (e.g., past_due, canceled, etc.)
                    # Check if customer has any other active subscriptions before updating status
                    has_active = len(await stripe.Subscription.list_async(
                        customer=customer_id,
                        status='active',
                        limit=1
                    ).get('data', [])) > 0
                    
                    if not has_active:
                        await client.schema('basejump').from_('billing_customers').update(
                            {'active': False}
                        ).eq('id', customer_id).execute()
                        logger.debug(f"Webhook: Updated customer {customer_id} active status to FALSE based on {event.type}")
            
            elif event.type == 'customer.subscription.deleted':
                # Check if customer has any other active subscriptions
                has_active = len((await stripe.Subscription.list_async(
                    customer=customer_id,
                    status='active',
                    limit=1
                )).get('data', [])) > 0
                
                if not has_active:
                    # If no active subscriptions left, set active to false
                    await client.schema('basejump').from_('billing_customers').update(
                        {'active': False}
                    ).eq('id', customer_id).execute()
                    logger.debug(f"Webhook: Updated customer {customer_id} active status to FALSE after subscription deletion")
            
            logger.debug(f"Processed {event.type} event for customer {customer_id}")
        
        return {"status": "success"}
        
    except Exception as e:
        logger.error(f"Error processing webhook: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/available-models")
async def get_available_models(
    current_user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """Get the list of models available to the user based on their subscription tier."""
    try:
        # Import the new model manager
        from core.ai_models import model_manager
        
        # Get Supabase client
        db = DBConnection()
        client = await db.client
        
        # Check if we're in local development mode
        if config.ENV_MODE == EnvMode.LOCAL:
            logger.debug("Running in local development mode - billing checks are disabled")
            
            # In local mode, return all enabled models
            all_models = model_manager.list_available_models(include_disabled=False)
            model_info = []
            
            for model_data in all_models:
                # Create clean model info for frontend
                model_info.append({
                    "id": model_data["id"],
                    "display_name": model_data["name"],
                    "short_name": model_data.get("aliases", [model_data["name"]])[0] if model_data.get("aliases") else model_data["name"],
                    "requires_subscription": False,  # Always false in local dev mode
                    "input_cost_per_million_tokens": model_data["pricing"]["input_per_million"] if model_data["pricing"] else None,
                    "output_cost_per_million_tokens": model_data["pricing"]["output_per_million"] if model_data["pricing"] else None,
                    "context_window": model_data["context_window"],
                    "capabilities": model_data["capabilities"],
                    "recommended": model_data["recommended"],
                    "priority": model_data["priority"]
                })
            
            return {
                "models": model_info,
                "subscription_tier": "Local Development",
                "total_models": len(model_info)
            }
        
        
        # For non-local mode, use new model manager system
        # Get subscription info for context
        subscription = await get_user_subscription(current_user_id)
        
        # Determine tier name from subscription
        tier_name = 'free'
        if subscription:
            price_id = None
            if subscription.get('items') and subscription['items'].get('data') and len(subscription['items']['data']) > 0:
                price_id = subscription['items']['data'][0]['price']['id']
            else:
                price_id = subscription.get('price_id', config.STRIPE_FREE_TIER_ID)
            
            # Get tier info for this price_id
            tier_info = SUBSCRIPTION_TIERS.get(price_id)
            if tier_info:
                tier_name = tier_info['name']
        
        # Get ALL enabled models for preview UI (don't filter by tier here)
        all_models = model_manager.list_available_models(tier=None, include_disabled=False)
        logger.debug(f"Found {len(all_models)} total models available")
        
        # Get allowed models for this specific user (for access checking)
        allowed_models = await get_allowed_models_for_user(client, current_user_id)
        logger.debug(f"User {current_user_id} allowed models: {allowed_models}")
        logger.debug(f"User tier: {tier_name}")
        
        # Create clean model info for frontend
        model_info = []
        for model_data in all_models:
            model_id = model_data["id"]
            
            # Check if model is available with current subscription
            is_available = model_id in allowed_models
            
            # Get pricing with multiplier applied
            pricing_info = {}
            if model_data["pricing"]:
                pricing_info = {
                    "input_cost_per_million_tokens": model_data["pricing"]["input_per_million"] * TOKEN_PRICE_MULTIPLIER,
                    "output_cost_per_million_tokens": model_data["pricing"]["output_per_million"] * TOKEN_PRICE_MULTIPLIER,
                    "max_tokens": model_data["max_output_tokens"]
                }
            else:
                pricing_info = {
                    "input_cost_per_million_tokens": None,
                    "output_cost_per_million_tokens": None,
                    "max_tokens": None
                }

            model_info.append({
                "id": model_id,
                "display_name": model_data["name"],
                "short_name": model_data.get("aliases", [model_data["name"]])[0] if model_data.get("aliases") else model_data["name"],
                "requires_subscription": not model_data.get("tier_availability", []) or "free" not in model_data["tier_availability"],
                "is_available": is_available,
                "context_window": model_data["context_window"],
                "capabilities": model_data["capabilities"],
                "recommended": model_data["recommended"],
                "priority": model_data["priority"],
                **pricing_info
            })
        
        logger.debug(f"Returning {len(model_info)} models to user {current_user_id} (tier: {tier_name})")
        if model_info:
            model_names = [m["display_name"] for m in model_info]
            logger.debug(f"Model names: {model_names}")
        
        return {
            "models": model_info,
            "subscription_tier": tier_name,
            "total_models": len(model_info)
        }
        
    except Exception as e:
        logger.error(f"Error getting available models: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Error getting available models: {str(e)}")


@router.get("/usage-logs")
async def get_usage_logs_endpoint(
    page: int = 0,
    items_per_page: int = 1000,
    current_user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """Get detailed usage logs for a user with pagination."""
    logger.debug(f"[USAGE_LOGS_ENDPOINT] Starting get_usage_logs_endpoint for user_id={current_user_id}, page={page}, items_per_page={items_per_page}")
    
    try:
        # Get Supabase client
        db = DBConnection()
        client = await db.client
        
        # Check if we're in local development mode
        if config.ENV_MODE == EnvMode.LOCAL:
            logger.debug(f"[USAGE_LOGS_ENDPOINT] user_id={current_user_id} - Running in local development mode - usage logs are not available")
            return {
                "logs": [], 
                "has_more": False,
                "message": "Usage logs are not available in local development mode"
            }
        
        # Validate pagination parameters
        if page < 0:
            logger.error(f"[USAGE_LOGS_ENDPOINT] user_id={current_user_id} - Invalid page parameter: {page}")
            raise HTTPException(status_code=400, detail="Page must be non-negative")
        if items_per_page < 1 or items_per_page > 1000:
            logger.error(f"[USAGE_LOGS_ENDPOINT] user_id={current_user_id} - Invalid items_per_page parameter: {items_per_page}")
            raise HTTPException(status_code=400, detail="Items per page must be between 1 and 1000")
        
        # Get usage logs
        logger.debug(f"[USAGE_LOGS_ENDPOINT] user_id={current_user_id} - Calling get_usage_logs")
        result = await get_usage_logs(client, current_user_id, page, items_per_page)
        
        # Check if result contains an error
        if isinstance(result, dict) and result.get('error'):
            logger.error(f"[USAGE_LOGS_ENDPOINT] user_id={current_user_id} - Usage logs returned error: {result['error']}")
            raise HTTPException(status_code=400, detail=f"Failed to retrieve usage logs: {result['error']}")
        
        logger.debug(f"[USAGE_LOGS_ENDPOINT] user_id={current_user_id} - Successfully returned {len(result.get('logs', []))} usage logs")
        return result
        
    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"[USAGE_LOGS_ENDPOINT] user_id={current_user_id} - Error getting usage logs: {str(e)}")
        
        # Check if this is a JSON serialization error
        if "JSON could not be generated" in str(e) or "JSON" in str(e):
            logger.error(f"[USAGE_LOGS_ENDPOINT] user_id={current_user_id} - Detected JSON serialization error")
            raise HTTPException(status_code=400, detail=f"Data serialization error: {str(e)}")
        else:
            raise HTTPException(status_code=500, detail=f"Error getting usage logs: {str(e)}")

@router.get("/subscription-commitment/{subscription_id}")
async def get_subscription_commitment(
    subscription_id: str,
    current_user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """Get commitment status for a subscription."""
    try:
        # Verify the subscription belongs to the current user
        db = DBConnection()
        client = await db.client
        
        # Get user's subscription to verify ownership
        user_subscription = await get_user_subscription(current_user_id)
        if not user_subscription or user_subscription.get('id') != subscription_id:
            raise HTTPException(status_code=404, detail="Subscription not found or access denied")
        
        commitment_info = await check_subscription_commitment(subscription_id)
        return commitment_info
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting subscription commitment: {str(e)}")
        raise HTTPException(status_code=500, detail="Error retrieving commitment information")

@router.get("/subscription-details")
async def get_subscription_details(
    current_user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """Get detailed subscription information including commitment status."""
    try:
        subscription = await get_user_subscription(current_user_id)
        if not subscription:
            return {
                "subscription": None,
                "commitment": {"has_commitment": False, "can_cancel": True}
            }
        
        # Get commitment information
        commitment_info = await check_subscription_commitment(subscription['id'])
        
        # Enhanced subscription details
        subscription_details = {
            "id": subscription.get('id'),
            "status": subscription.get('status'),
            "current_period_end": subscription.get('current_period_end'),
            "current_period_start": subscription.get('current_period_start'),
            "cancel_at_period_end": subscription.get('cancel_at_period_end'),
            "items": subscription.get('items', {}).get('data', []),
            "metadata": subscription.get('metadata', {})
        }
        
        return {
            "subscription": subscription_details,
            "commitment": commitment_info
        }
        
    except Exception as e:
        logger.error(f"Error getting subscription details: {str(e)}")
        raise HTTPException(status_code=500, detail="Error retrieving subscription details")

@router.post("/cancel-subscription")
async def cancel_subscription(
    current_user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """Cancel subscription with yearly commitment handling."""
    try:
        # Get user's current subscription
        subscription = await get_user_subscription(current_user_id)
        if not subscription:
            raise HTTPException(status_code=404, detail="No active subscription found")
        
        subscription_id = subscription['id']
        
        # Check commitment status
        commitment_info = await check_subscription_commitment(subscription_id)
        
        # If subscription has yearly commitment and still in commitment period
        if commitment_info.get('has_commitment') and not commitment_info.get('can_cancel'):
            # Schedule cancellation at the end of the commitment period (1 year anniversary)
            commitment_end_date = datetime.fromisoformat(commitment_info.get('commitment_end_date').replace('Z', '+00:00'))
            cancel_at_timestamp = int(commitment_end_date.timestamp())
            
            # Update subscription to cancel at the commitment end date
            updated_subscription = await stripe.Subscription.modify_async(
                subscription_id,
                cancel_at=cancel_at_timestamp,
                metadata={
                    **subscription.get('metadata', {}),
                    'cancelled_by_user': 'true',
                    'cancellation_date': str(int(datetime.now(timezone.utc).timestamp())),
                    'scheduled_cancel_at_commitment_end': 'true'
                }
            )
            
            logger.debug(f"Subscription {subscription_id} scheduled for cancellation at commitment end: {commitment_end_date}")
            
            return {
                "success": True,
                "status": "scheduled_for_commitment_end",
                "message": f"Subscription will be cancelled at the end of your yearly commitment period. {commitment_info.get('months_remaining', 0)} months remaining.",
                "details": {
                    "subscription_id": subscription_id,
                    "cancellation_effective_date": commitment_end_date.isoformat(),
                    "months_remaining": commitment_info.get('months_remaining', 0),
                    "access_until": commitment_end_date.strftime("%B %d, %Y"),
                    "commitment_end_date": commitment_info.get('commitment_end_date')
                }
            }
        
        # For non-commitment subscriptions or commitment period has ended, cancel at period end
        updated_subscription = await stripe.Subscription.modify_async(
            subscription_id,
            cancel_at_period_end=True,
            metadata={
                **subscription.get('metadata', {}),
                'cancelled_by_user': 'true',
                'cancellation_date': str(int(datetime.now(timezone.utc).timestamp()))
            }
        )

        logger.debug(f"Subscription {subscription_id} marked for cancellation at period end")
        
        # Calculate when the subscription will actually end
        current_period_end = updated_subscription.current_period_end or subscription.get('current_period_end')
        
        # If still no period end, fetch fresh subscription data from Stripe
        if not current_period_end:
            logger.warning(f"No current_period_end found in cached data for subscription {subscription_id}, fetching fresh data from Stripe")
            try:
                fresh_subscription = await stripe.Subscription.retrieve_async(subscription_id)
                current_period_end = fresh_subscription.current_period_end
            except Exception as fetch_error:
                logger.error(f"Failed to fetch fresh subscription data: {fetch_error}")
        
        if not current_period_end:
            logger.error(f"No current_period_end found in subscription {subscription_id} even after fresh fetch")
            raise HTTPException(status_code=500, detail="Unable to determine subscription period end")
        
        period_end_date = datetime.fromtimestamp(current_period_end, timezone.utc)
        
        return {
            "success": True,
            "status": "cancelled_at_period_end",
            "message": "Subscription will be cancelled at the end of your current billing period.",
            "details": {
                "subscription_id": subscription_id,
                "cancellation_effective_date": period_end_date.isoformat(),
                "current_period_end": current_period_end,
                "access_until": period_end_date.strftime("%B %d, %Y")
            }
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error cancelling subscription: {str(e)}")
        raise HTTPException(status_code=500, detail="Error processing cancellation request")

@router.post("/reactivate-subscription")
async def reactivate_subscription(
    current_user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """Reactivate a subscription that was marked for cancellation."""
    try:
        # Get user's current subscription
        subscription = await get_user_subscription(current_user_id)
        if not subscription:
            raise HTTPException(status_code=404, detail="No subscription found")
        
        subscription_id = subscription['id']
        
        # Check if subscription is marked for cancellation (either cancel_at_period_end or cancel_at)
        is_cancelled = subscription.get('cancel_at_period_end') or subscription.get('cancel_at')
        if not is_cancelled:
            return {
                "success": False,
                "status": "not_cancelled",
                "message": "Subscription is not marked for cancellation."
            }
        
        # Prepare the modification parameters
        modify_params = {
            'cancel_at_period_end': False,
            'metadata': {
                **subscription.get('metadata', {}),
                'reactivated_by_user': 'true',
                'reactivation_date': str(int(datetime.now(timezone.utc).timestamp()))
            }
        }
        
        # If subscription has cancel_at set (yearly commitment), clear it
        if subscription.get('cancel_at'):
            modify_params['cancel_at'] = None
        
        # Reactivate the subscription
        updated_subscription = await stripe.Subscription.modify_async(
            subscription_id,
            **modify_params
        )
        
        logger.debug(f"Subscription {subscription_id} reactivated by user")
        
        # Get the current period end safely
        current_period_end = updated_subscription.current_period_end or subscription.get('current_period_end')
        
        # If still no period end, fetch fresh subscription data from Stripe
        if not current_period_end:
            logger.warning(f"No current_period_end found in cached data for subscription {subscription_id}, fetching fresh data from Stripe")
            try:
                fresh_subscription = await stripe.Subscription.retrieve_async(subscription_id)
                current_period_end = fresh_subscription.current_period_end
            except Exception as fetch_error:
                logger.error(f"Failed to fetch fresh subscription data: {fetch_error}")
        
        if not current_period_end:
            logger.error(f"No current_period_end found in subscription {subscription_id} even after fresh fetch")
            raise HTTPException(status_code=500, detail="Unable to determine subscription period end")
        
        return {
            "success": True,
            "status": "reactivated",
            "message": "Subscription has been reactivated and will continue billing normally.",
            "details": {
                "subscription_id": subscription_id,
                "next_billing_date": datetime.fromtimestamp(
                    current_period_end, 
                    timezone.utc
                ).strftime("%B %d, %Y")
            }
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error reactivating subscription: {str(e)}")
        raise HTTPException(status_code=500, detail="Error processing reactivation request")

@router.post("/purchase-credits")
async def purchase_credits(
    request: PurchaseCreditsRequest,
    current_user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """
    Create a Stripe checkout session for purchasing credits.
    Only available for users on the highest subscription tier.
    """
    try:
        # Check if user is on the highest tier
        is_highest_tier = await is_user_on_highest_tier(current_user_id)
        if not is_highest_tier:
            raise HTTPException(
                status_code=403,
                detail="Credit purchases are only available for users on the highest subscription tier ($1000/month)."
            )
        
        # Validate amount
        if request.amount_dollars < 10:
            raise HTTPException(status_code=400, detail="Minimum credit purchase is $10")
        
        if request.amount_dollars > 5000:
            raise HTTPException(status_code=400, detail="Maximum credit purchase is $5000")
        
        # Get Supabase client
        db = DBConnection()
        client = await db.client
        
        # Get user email
        user_result = await client.auth.admin.get_user_by_id(current_user_id)
        if not user_result:
            raise HTTPException(status_code=404, detail="User not found")
        email = user_result.user.email
        
        # Get or create Stripe customer
        customer_id = await get_stripe_customer_id(client, current_user_id)
        if not customer_id:
            customer_id = await create_stripe_customer(client, current_user_id, email)
        
        # Check if we have a pre-configured price ID for this amount
        matching_package = None
        for package_key, package_info in CREDIT_PACKAGES.items():
            if package_info['amount'] == request.amount_dollars and package_info.get('stripe_price_id'):
                matching_package = package_info
                break
        
        # Create a checkout session
        if matching_package and matching_package['stripe_price_id']:
            # Use pre-configured price ID
            session = await stripe.checkout.Session.create_async(
                customer=customer_id,
                payment_method_types=['card'],
                line_items=[{
                    'price': matching_package['stripe_price_id'],
                    'quantity': 1,
                }],
                mode='payment',
                success_url=request.success_url,
                cancel_url=request.cancel_url,
                metadata={
                    'user_id': current_user_id,
                    'credit_amount': str(request.amount_dollars),
                    'type': 'credit_purchase'
                }
            )
        else:
            session = await stripe.checkout.Session.create_async(
                customer=customer_id,
                payment_method_types=['card'],
                line_items=[{
                    'price_data': {
                        'currency': 'usd',
                        'product_data': {
                            'name': f'Suna AI Credits',
                            'description': f'${request.amount_dollars:.2f} in usage credits for Suna AI',
                        },
                        'unit_amount': int(request.amount_dollars * 100),
                    },
                    'quantity': 1,
                }],
                mode='payment',
                success_url=request.success_url,
                cancel_url=request.cancel_url,
                metadata={
                    'user_id': current_user_id,
                    'credit_amount': str(request.amount_dollars),
                    'type': 'credit_purchase'
                }
            )
        
        # Record the pending purchase in database
        purchase_record = await client.table('credit_purchases').insert({
            'user_id': current_user_id,
            'amount_dollars': request.amount_dollars,
            'status': 'pending',
            'stripe_payment_intent_id': session.payment_intent,
            'description': f'Credit purchase via Stripe Checkout',
            'metadata': {
                'session_id': session.id,
                'checkout_url': session.url,
                'success_url': request.success_url,
                'cancel_url': request.cancel_url
            }
        }).execute()
        
        return {
            "session_id": session.id,
            "url": session.url,
            "purchase_id": purchase_record.data[0]['id'] if purchase_record.data else None
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error creating credit purchase session: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Error creating checkout session: {str(e)}")

@router.get("/credit-balance")
async def get_credit_balance_endpoint(
    current_user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """Get the current credit balance for the user."""
    try:
        db = DBConnection()
        client = await db.client
        
        balance = await get_user_credit_balance(client, current_user_id)
        
        return balance
        
    except Exception as e:
        logger.error(f"Error getting credit balance: {str(e)}")
        raise HTTPException(status_code=500, detail="Error retrieving credit balance")

@router.get("/credit-history")
async def get_credit_history(
    page: int = 0,
    items_per_page: int = 50,
    current_user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """Get credit purchase and usage history for the user."""
    try:
        db = DBConnection()
        client = await db.client
        
        # Get purchases
        purchases_result = await client.table('credit_purchases') \
            .select('*') \
            .eq('user_id', current_user_id) \
            .eq('status', 'completed') \
            .order('created_at', desc=True) \
            .range(page * items_per_page, (page + 1) * items_per_page - 1) \
            .execute()
        
        # Get usage
        usage_result = await client.table('credit_usage') \
            .select('*') \
            .eq('user_id', current_user_id) \
            .order('created_at', desc=True) \
            .range(page * items_per_page, (page + 1) * items_per_page - 1) \
            .execute()
        
        # Format response
        purchases = [
            CreditPurchase(
                id=p['id'],
                amount_dollars=float(p['amount_dollars']),
                status=p['status'],
                created_at=p['created_at'],
                completed_at=p.get('completed_at'),
                stripe_payment_intent_id=p.get('stripe_payment_intent_id')
            )
            for p in (purchases_result.data or [])
        ]
        
        usage = [
            CreditUsage(
                id=u['id'],
                amount_dollars=float(u['amount_dollars']),
                description=u.get('description'),
                created_at=u['created_at'],
                thread_id=u.get('thread_id'),
                message_id=u.get('message_id')
            )
            for u in (usage_result.data or [])
        ]
        
        return {
            "purchases": purchases,
            "usage": usage,
            "page": page,
            "has_more": len(purchases) == items_per_page or len(usage) == items_per_page
        }
        
    except Exception as e:
        logger.error(f"Error getting credit history: {str(e)}")
        raise HTTPException(status_code=500, detail="Error retrieving credit history")

@router.get("/can-purchase-credits")
async def can_purchase_credits(
    current_user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """Check if the current user can purchase credits (must be on highest tier)."""
    try:
        is_highest_tier = await is_user_on_highest_tier(current_user_id)
        
        return {
            "can_purchase": is_highest_tier,
            "reason": "Credit purchases are available" if is_highest_tier else "Must be on the highest subscription tier ($1000/month) to purchase credits"
        }
        
    except Exception as e:
        logger.error(f"Error checking credit purchase eligibility: {str(e)}")
        raise HTTPException(status_code=500, detail="Error checking eligibility")
