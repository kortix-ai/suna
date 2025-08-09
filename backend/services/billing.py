"""
Stripe Billing API implementation for Suna on top of Basejump. ONLY HAS SUPPOT FOR USER ACCOUNTS – no team accounts. As we are using the user_id as account_id as is the case with personal accounts. In personal accounts, the account_id equals the user_id. In team accounts, the account_id is unique.

stripe listen --forward-to localhost:8000/api/billing/webhook
"""

from fastapi import APIRouter, HTTPException, Depends, Request
from typing import Optional, Dict, Tuple
import stripe
from datetime import datetime, timezone, timedelta

from supabase import Client as SupabaseClient
from utils.cache import Cache
from utils.logger import logger
from utils.config import config, EnvMode
from services.supabase import DBConnection
from utils.auth_utils import get_current_user_id_from_jwt
from pydantic import BaseModel
from utils.constants import MODEL_ACCESS_TIERS, MODEL_NAME_ALIASES, HARDCODED_MODEL_PRICES
from litellm.cost_calculator import cost_per_token
import time

# Initialize Stripe
stripe.api_key = config.STRIPE_SECRET_KEY

# Token price multiplier
TOKEN_PRICE_MULTIPLIER = 1.5

# Initialize router
router = APIRouter(prefix="/billing", tags=["billing"])

# Plan validation functions
def get_plan_info(price_id: str) -> dict:
    """Get plan information including tier level and type."""
    # Production plans mapping
    PLAN_TIERS = {
        # Monthly plans
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
        model: The model name to get pricing for
        
    Returns:
        Tuple of (input_cost_per_million_tokens, output_cost_per_million_tokens) or None if not found
    """
    if model in HARDCODED_MODEL_PRICES:
        pricing = HARDCODED_MODEL_PRICES[model]
        return pricing["input_cost_per_million_tokens"], pricing["output_cost_per_million_tokens"]
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
                logger.info(f"Added missing user_id metadata to Stripe customer {customer['id']}")
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
        logger.info(f"Updated billing_customers record for customer {customer['id']} and user {user_id}")

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
                        logger.info(f"Cancelled subscription {sub['id']} for user {user_id}")
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
    logger.info(f"Calculate monthly usage took {execution_time:.3f} seconds, total cost: {total_cost}")
    
    await Cache.set(f"monthly_usage:{user_id}", total_cost, ttl=2 * 60)
    return total_cost


async def get_usage_logs(client, user_id: str, page: int = 0, items_per_page: int = 1000) -> Dict:
    """Get detailed usage logs for a user with pagination."""
    # Get start of current month in UTC
    now = datetime.now(timezone.utc)
    start_of_month = datetime(now.year, now.month, 1, tzinfo=timezone.utc)
    
    # Use fixed cutoff date: June 26, 2025 midnight UTC
    # Ignore all token counts before this date
    cutoff_date = datetime(2025, 6, 30, 9, 0, 0, tzinfo=timezone.utc)
    
    start_of_month = max(start_of_month, cutoff_date)
    
    # First get all threads for this user in batches
    batch_size = 1000
    offset = 0
    all_threads = []
    
    while True:
        threads_batch = await client.table('threads') \
            .select('thread_id, agent_runs(thread_id)') \
            .eq('account_id', user_id) \
            .gte('agent_runs.created_at', start_of_month.isoformat()) \
            .range(offset, offset + batch_size - 1) \
            .execute()
        
        if not threads_batch.data:
            break
            
        all_threads.extend(threads_batch.data)
        
        # If we got less than batch_size, we've reached the end
        if len(threads_batch.data) < batch_size:
            break
            
        offset += batch_size
    
    if not all_threads:
        return {"logs": [], "has_more": False}
    
    thread_ids = [t['thread_id'] for t in all_threads]
    
    # Fetch usage messages with pagination, including thread project info
    start_time = time.time()
    messages_result = await client.table('messages') \
        .select(
            'message_id, thread_id, created_at, content, threads!inner(project_id)'
        ) \
        .in_('thread_id', thread_ids) \
        .eq('type', 'assistant_response_end') \
        .gte('created_at', start_of_month.isoformat()) \
        .order('created_at', desc=True) \
        .range(page * items_per_page, (page + 1) * items_per_page - 1) \
        .execute()
    
    end_time = time.time()
    execution_time = end_time - start_time
    logger.info(f"Database query for usage logs took {execution_time:.3f} seconds")

    if not messages_result.data:
        return {"logs": [], "has_more": False}

    # Process messages into usage log entries
    processed_logs = []
    
    for message in messages_result.data:
        try:
            # Safely extract usage data with defaults
            content = message.get('content', {})
            usage = content.get('usage', {})
            
            # Ensure usage has required fields with safe defaults
            prompt_tokens = usage.get('prompt_tokens', 0)
            completion_tokens = usage.get('completion_tokens', 0)
            model = content.get('model', 'unknown')
            
            # Safely calculate total tokens
            total_tokens = (prompt_tokens or 0) + (completion_tokens or 0)
            
            # Calculate estimated cost using the same logic as calculate_monthly_usage
            estimated_cost = calculate_token_cost(
                prompt_tokens,
                completion_tokens,
                model
            )
            
            # Safely extract project_id from threads relationship
            project_id = 'unknown'
            if message.get('threads') and isinstance(message['threads'], list) and len(message['threads']) > 0:
                project_id = message['threads'][0].get('project_id', 'unknown')
            
            processed_logs.append({
                'message_id': message.get('message_id', 'unknown'),
                'thread_id': message.get('thread_id', 'unknown'),
                'created_at': message.get('created_at', None),
                'content': {
                    'usage': {
                        'prompt_tokens': prompt_tokens,
                        'completion_tokens': completion_tokens
                    },
                    'model': model
                },
                'total_tokens': total_tokens,
                'estimated_cost': estimated_cost,
                'project_id': project_id
            })
        except Exception as e:
            logger.warning(f"Error processing usage log entry for message {message.get('message_id', 'unknown')}: {str(e)}")
            continue
    
    # Check if there are more results
    has_more = len(processed_logs) == items_per_page
    
    return {
        "logs": processed_logs,
        "has_more": has_more
    }


def calculate_token_cost(prompt_tokens: int, completion_tokens: int, model: str) -> float:
    """Calculate the cost for tokens using the same logic as the monthly usage calculation."""
    try:
        # Ensure tokens are valid integers
        prompt_tokens = int(prompt_tokens) if prompt_tokens is not None else 0
        completion_tokens = int(completion_tokens) if completion_tokens is not None else 0
        
        # Try to resolve the model name using MODEL_NAME_ALIASES first
        resolved_model = MODEL_NAME_ALIASES.get(model, model)

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
                    logger.warning(f"Could not get pricing for model {model} (resolved: {resolved_model}), returning 0 cost")
                    return 0.0
                    
            except Exception as e:
                logger.warning(f"Could not get pricing for model {model} (resolved: {resolved_model}): {str(e)}, returning 0 cost")
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

    subscription = await get_user_subscription(user_id)
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
    
    # Return allowed models for this tier
    result = MODEL_ACCESS_TIERS.get(tier_name, MODEL_ACCESS_TIERS['free'])  # Default to free tier if unknown
    await Cache.set(f"allowed_models_for_user:{user_id}", result, ttl=1 * 60)
    return result


async def can_use_model(client, user_id: str, model_name: str):
    if config.ENV_MODE == EnvMode.LOCAL:
        logger.info("Running in local development mode - billing checks are disabled")
        return True, "Local development mode - billing disabled", {
            "price_id": "local_dev",
            "plan_name": "Local Development",
            "minutes_limit": "no limit"
        }

    allowed_models = await get_allowed_models_for_user(client, user_id)
    resolved_model = MODEL_NAME_ALIASES.get(model_name, model_name)
    if resolved_model in allowed_models:
        return True, "Model access allowed", allowed_models
    
    return False, f"Your current subscription plan does not include access to {model_name}. Please upgrade your subscription or choose from your available models: {', '.join(allowed_models)}", allowed_models

async def check_billing_status(client, user_id: str) -> Tuple[bool, str, Optional[Dict]]:
    """
    Check if a user can run agents based on their subscription and usage.
    
    Returns:
        Tuple[bool, str, Optional[Dict]]: (can_run, message, subscription_info)
    """
    if config.ENV_MODE == EnvMode.LOCAL:
        logger.info("Running in local development mode - billing checks are disabled")
        return True, "Local development mode - billing disabled", {
            "price_id": "local_dev",
            "plan_name": "Local Development",
            "minutes_limit": "no limit"
        }

    # Get current subscription
    subscription = await get_user_subscription(user_id)
    # print("Current subscription:", subscription)
    
    # If no subscription, they can use free tier
    if not subscription:
        subscription = {
            'price_id': config.STRIPE_FREE_TIER_ID,  # Free tier
            'plan_name': 'free'
        }
    
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
    
    # TODO: also do user's AAL check
    # Check if within limits
    if current_usage >= tier_info['cost']:
        return False, f"Monthly limit of {tier_info['cost']} dollars reached. Please upgrade your plan or wait until next month.", subscription
    
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
                
                logger.info(f"Subscription {subscription_id} has active yearly commitment: {months_remaining} months remaining")
                
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
                logger.info(f"Subscription {subscription_id} yearly commitment period has ended")
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

# API endpoints
@router.post("/create-checkout-session")
async def create_checkout_session(
    request: CreateCheckoutSessionRequest,
    current_user_id: str = Depends(get_current_user_id_from_jwt)
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
                
                logger.info(f"Price comparison: current={current_price['unit_amount']}, new={new_price['unit_amount']}, "
                           f"intervals: {current_interval}->{new_interval}, is_upgrade={is_upgrade}")

                # For commitment subscriptions, handle differently
                if commitment_info.get('has_commitment'):
                    if is_upgrade:
                        # Allow upgrades for commitment subscriptions immediately
                        logger.info(f"Upgrading commitment subscription {subscription_id}")
                        
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
                        logger.info(f"Updated customer {customer_id} active status to TRUE after subscription upgrade")
                        
                        # Force immediate payment for upgrades
                        latest_invoice = None
                        if updated_subscription.latest_invoice:
                            latest_invoice_id = updated_subscription.latest_invoice
                            latest_invoice = await stripe.Invoice.retrieve_async(latest_invoice_id)
                            
                            try:
                                logger.info(f"Latest invoice {latest_invoice_id} status: {latest_invoice.status}")
                                
                                # If invoice is in draft status, finalize it to trigger immediate payment
                                if latest_invoice.status == 'draft':
                                    finalized_invoice = stripe.Invoice.finalize_invoice(latest_invoice_id)
                                    logger.info(f"Finalized invoice {latest_invoice_id} for immediate payment")
                                    latest_invoice = finalized_invoice
                                    
                                    # Pay the invoice immediately if it's still open
                                    if finalized_invoice.status == 'open':
                                        paid_invoice = stripe.Invoice.pay(latest_invoice_id)
                                        logger.info(f"Paid invoice {latest_invoice_id} immediately, status: {paid_invoice.status}")
                                        latest_invoice = paid_invoice
                                elif latest_invoice.status == 'open':
                                    # Invoice is already finalized but not paid, pay it
                                    paid_invoice = stripe.Invoice.pay(latest_invoice_id)
                                    logger.info(f"Paid existing open invoice {latest_invoice_id}, status: {paid_invoice.status}")
                                    latest_invoice = paid_invoice
                                else:
                                    logger.info(f"Invoice {latest_invoice_id} is in status {latest_invoice.status}, no action needed")
                                    
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
                    logger.info(f"Updated customer {customer_id} active status to TRUE after subscription upgrade")
                    
                    latest_invoice = None
                    if updated_subscription.latest_invoice:
                        latest_invoice_id = updated_subscription.latest_invoice
                        latest_invoice = await stripe.Invoice.retrieve_async(latest_invoice_id)
                        
                        # Force immediate payment for upgrades
                        try:
                            logger.info(f"Latest invoice {latest_invoice_id} status: {latest_invoice.status}")
                            
                            # If invoice is in draft status, finalize it to trigger immediate payment
                            if latest_invoice.status == 'draft':
                                finalized_invoice = stripe.Invoice.finalize_invoice(latest_invoice_id)
                                logger.info(f"Finalized invoice {latest_invoice_id} for immediate payment")
                                latest_invoice = finalized_invoice  # Update reference
                                
                                # Pay the invoice immediately if it's still open
                                if finalized_invoice.status == 'open':
                                    paid_invoice = stripe.Invoice.pay(latest_invoice_id)
                                    logger.info(f"Paid invoice {latest_invoice_id} immediately, status: {paid_invoice.status}")
                                    latest_invoice = paid_invoice  # Update reference
                            elif latest_invoice.status == 'open':
                                # Invoice is already finalized but not paid, pay it
                                paid_invoice = stripe.Invoice.pay(latest_invoice_id)
                                logger.info(f"Paid existing open invoice {latest_invoice_id}, status: {paid_invoice.status}")
                                latest_invoice = paid_invoice  # Update reference
                            else:
                                logger.info(f"Invoice {latest_invoice_id} is in status {latest_invoice.status}, no action needed")
                                
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
                    logger.info(f"Updated customer {customer_id} active status to TRUE after subscription downgrade")
                    
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
            logger.info(f"Updated customer {customer_id} active status to TRUE after creating checkout session")
            
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
    current_user_id: str = Depends(get_current_user_id_from_jwt)
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
                    logger.info(f"Found existing portal configuration with subscription_update enabled: {config['id']}")
                    break
            
            # If no config with subscription_update found, create one or update the active one
            if not active_config:
                # Find the active configuration or create a new one
                if configurations.get('data', []):
                    default_config = configurations['data'][0]
                    logger.info(f"Updating default portal configuration: {default_config['id']} to enable subscription_update")
                    
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
                    logger.info("Creating new portal configuration with subscription_update enabled")
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
            logger.info(f"Using portal configuration: {active_config['id']} with subscription_update: {active_config.get('features', {}).get('subscription_update', {}).get('enabled', False)}")
        
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
    current_user_id: str = Depends(get_current_user_id_from_jwt)
):
    """Get the current subscription status for the current user, including scheduled changes."""
    try:
        # Get subscription from Stripe (this helper already handles filtering/cleanup)
        subscription = await get_user_subscription(current_user_id)
        # print("Subscription data for status:", subscription)
        
        # Calculate current usage
        db = DBConnection()
        client = await db.client
        current_usage = await calculate_monthly_usage(client, current_user_id)

        if not subscription:
            # Default to free tier status if no active subscription for our product
            free_tier_id = config.STRIPE_FREE_TIER_ID
            free_tier_info = SUBSCRIPTION_TIERS.get(free_tier_id)
            return SubscriptionStatus(
                status="no_subscription",
                plan_name=free_tier_info.get('name', 'free') if free_tier_info else 'free',
                price_id=free_tier_id,
                minutes_limit=free_tier_info.get('minutes') if free_tier_info else 0,
                cost_limit=free_tier_info.get('cost') if free_tier_info else 0,
                current_usage=current_usage
            )
        
        # Extract current plan details
        current_item = subscription['items']['data'][0]
        current_price_id = current_item['price']['id']
        current_tier_info = SUBSCRIPTION_TIERS.get(current_price_id)
        if not current_tier_info:
            # Fallback if somehow subscribed to an unknown price within our product
            logger.warning(f"User {current_user_id} subscribed to unknown price {current_price_id}. Defaulting info.")
            current_tier_info = {'name': 'unknown', 'minutes': 0}
        
        status_response = SubscriptionStatus(
            status=subscription['status'], # 'active', 'trialing', etc.
            plan_name=subscription['plan'].get('nickname') or current_tier_info['name'],
            price_id=current_price_id,
            current_period_end=datetime.fromtimestamp(current_item['current_period_end'], tz=timezone.utc),
            cancel_at_period_end=subscription['cancel_at_period_end'],
            trial_end=datetime.fromtimestamp(subscription['trial_end'], tz=timezone.utc) if subscription.get('trial_end') else None,
            minutes_limit=current_tier_info['minutes'],
            cost_limit=current_tier_info['cost'],
            current_usage=current_usage,
            has_schedule=False, # Default
            subscription_id=subscription['id'],
            subscription={
                'id': subscription['id'],
                'status': subscription['status'],
                'cancel_at_period_end': subscription['cancel_at_period_end'],
                'cancel_at': subscription.get('cancel_at'),
                'current_period_end': current_item['current_period_end']
            }
        )

        # Check for an attached schedule (indicates pending downgrade)
        schedule_id = subscription.get('schedule')
        if schedule_id:
            try:
                schedule = await stripe.SubscriptionSchedule.retrieve_async(schedule_id)
                # Find the *next* phase after the current one
                next_phase = None
                current_phase_end = current_item['current_period_end']
                
                for phase in schedule.get('phases', []):
                    # Check if this phase starts exactly when the current one ends
                    if phase.get('start_date') == current_phase_end:
                        next_phase = phase
                        break # Found the immediate next phase

                if next_phase:
                    scheduled_item = next_phase['items'][0] # Assuming single item
                    scheduled_price_id = scheduled_item['price'] # Price ID might be string here
                    scheduled_tier_info = SUBSCRIPTION_TIERS.get(scheduled_price_id)
                    
                    status_response.has_schedule = True
                    status_response.status = 'scheduled_downgrade' # Override status
                    status_response.scheduled_plan_name = scheduled_tier_info.get('name', 'unknown') if scheduled_tier_info else 'unknown'
                    status_response.scheduled_price_id = scheduled_price_id
                    status_response.scheduled_change_date = datetime.fromtimestamp(next_phase['start_date'], tz=timezone.utc)
                    
            except Exception as schedule_error:
                logger.error(f"Error retrieving or parsing schedule {schedule_id} for sub {subscription['id']}: {schedule_error}")
                # Proceed without schedule info if retrieval fails

        return status_response
        
    except Exception as e:
        logger.exception(f"Error getting subscription status for user {current_user_id}: {str(e)}") # Use logger.exception
        raise HTTPException(status_code=500, detail="Error retrieving subscription status.")

@router.get("/check-status")
async def check_status(
    current_user_id: str = Depends(get_current_user_id_from_jwt)
):
    """Check if the user can run agents based on their subscription and usage."""
    try:
        # Get Supabase client
        db = DBConnection()
        client = await db.client
        
        can_run, message, subscription = await check_billing_status(client, current_user_id)
        
        return {
            "can_run": can_run,
            "message": message,
            "subscription": subscription
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
            logger.info(f"Received Stripe webhook: {event.type} - Event ID: {event.id}")
        except ValueError as e:
            logger.error(f"Invalid webhook payload: {str(e)}")
            raise HTTPException(status_code=400, detail="Invalid payload")
        except stripe.error.SignatureVerificationError as e:
            logger.error(f"Invalid webhook signature: {str(e)}")
            raise HTTPException(status_code=400, detail="Invalid signature")
        
        # Handle the event
        if event.type in ['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted']:
            # Extract the subscription and customer information
            subscription = event.data.object
            customer_id = subscription.get('customer')
            
            if not customer_id:
                logger.warning(f"No customer ID found in subscription event: {event.type}")
                return {"status": "error", "message": "No customer ID found"}
            
            # Get database connection
            db = DBConnection()
            client = await db.client
            
            if event.type == 'customer.subscription.created':
                # Update customer active status for new subscriptions
                if subscription.get('status') in ['active', 'trialing']:
                    await client.schema('basejump').from_('billing_customers').update(
                        {'active': True}
                    ).eq('id', customer_id).execute()
                    logger.info(f"Webhook: Updated customer {customer_id} active status to TRUE based on {event.type}")
                    
            elif event.type == 'customer.subscription.updated':
                # Check if subscription is active
                if subscription.get('status') in ['active', 'trialing']:
                    # Update customer's active status to true
                    await client.schema('basejump').from_('billing_customers').update(
                        {'active': True}
                    ).eq('id', customer_id).execute()
                    logger.info(f"Webhook: Updated customer {customer_id} active status to TRUE based on {event.type}")
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
                        logger.info(f"Webhook: Updated customer {customer_id} active status to FALSE based on {event.type}")
            
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
                    logger.info(f"Webhook: Updated customer {customer_id} active status to FALSE after subscription deletion")
            
            logger.info(f"Processed {event.type} event for customer {customer_id}")
        
        return {"status": "success"}
        
    except Exception as e:
        logger.error(f"Error processing webhook: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/available-models")
async def get_available_models(
    current_user_id: str = Depends(get_current_user_id_from_jwt)
):
    """Get the list of models available to the user based on their subscription tier."""
    try:
        # Get Supabase client
        db = DBConnection()
        client = await db.client
        
        # Check if we're in local development mode
        if config.ENV_MODE == EnvMode.LOCAL:
            logger.info("Running in local development mode - billing checks are disabled")
            
            # In local mode, return all models from MODEL_NAME_ALIASES
            model_info = []
            for short_name, full_name in MODEL_NAME_ALIASES.items():
                # Skip entries where the key is a full name to avoid duplicates
                # if short_name == full_name or '/' in short_name:
                #     continue
                
                model_info.append({
                    "id": full_name,
                    "display_name": short_name,
                    "short_name": short_name,
                    "requires_subscription": False  # Always false in local dev mode
                })
            
            return {
                "models": model_info,
                "subscription_tier": "Local Development",
                "total_models": len(model_info)
            }
        
        
        # For non-local mode, get list of allowed models for this user
        allowed_models = await get_allowed_models_for_user(client, current_user_id)
        free_tier_models = MODEL_ACCESS_TIERS.get('free', [])
        
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
        
        # Get all unique full model names from MODEL_NAME_ALIASES
        all_models = set()
        model_aliases = {}
        
        for short_name, full_name in MODEL_NAME_ALIASES.items():
            # Add all unique full model names
            all_models.add(full_name)
            
            # Only include short names that don't match their full names for aliases
            if short_name != full_name and not short_name.startswith("openai/") and not short_name.startswith("anthropic/") and not short_name.startswith("openrouter/") and not short_name.startswith("xai/"):
                if full_name not in model_aliases:
                    model_aliases[full_name] = short_name
        
        # Create model info with display names for ALL models
        model_info = []
        for model in all_models:
            display_name = model_aliases.get(model, model.split('/')[-1] if '/' in model else model)
            
            # Check if model requires subscription (not in free tier)
            requires_sub = model not in free_tier_models
            
            # Check if model is available with current subscription
            is_available = model in allowed_models
            
            # Get pricing information - check hardcoded prices first, then litellm
            pricing_info = {}
            
            # Check if we have hardcoded pricing for this model
            hardcoded_pricing = get_model_pricing(model)
            if hardcoded_pricing:
                input_cost_per_million, output_cost_per_million = hardcoded_pricing
                pricing_info = {
                    "input_cost_per_million_tokens": input_cost_per_million * TOKEN_PRICE_MULTIPLIER,
                    "output_cost_per_million_tokens": output_cost_per_million * TOKEN_PRICE_MULTIPLIER,
                    "max_tokens": None
                }
            else:
                try:
                    # Try to get pricing using cost_per_token function
                    models_to_try = []
                    
                    # Add the original model name
                    models_to_try.append(model)
                    
                    # Try to resolve the model name using MODEL_NAME_ALIASES
                    if model in MODEL_NAME_ALIASES:
                        resolved_model = MODEL_NAME_ALIASES[model]
                        models_to_try.append(resolved_model)
                        # Also try without provider prefix if it has one
                        if '/' in resolved_model:
                            models_to_try.append(resolved_model.split('/', 1)[1])
                    
                    # If model is a value in aliases, try to find a matching key
                    for alias_key, alias_value in MODEL_NAME_ALIASES.items():
                        if alias_value == model:
                            models_to_try.append(alias_key)
                            break
                    
                    # Also try without provider prefix for the original model
                    if '/' in model:
                        models_to_try.append(model.split('/', 1)[1])
                    
                    # Special handling for Google models accessed via Google API
                    if model.startswith('gemini/'):
                        google_model_name = model.replace('gemini/', '')
                        models_to_try.append(google_model_name)
                    
                    # Special handling for Google models accessed via Google API
                    if model.startswith('gemini/'):
                        google_model_name = model.replace('gemini/', '')
                        models_to_try.append(google_model_name)
                    
                    # Try each model name variation until we find one that works
                    input_cost_per_token = None
                    output_cost_per_token = None
                    
                    for model_name in models_to_try:
                        try:
                            # Use cost_per_token with sample token counts to get the per-token costs
                            input_cost, output_cost = cost_per_token(model_name, 1000000, 1000000)
                            if input_cost is not None and output_cost is not None:
                                input_cost_per_token = input_cost
                                output_cost_per_token = output_cost
                                break
                        except Exception:
                            continue
                    
                    if input_cost_per_token is not None and output_cost_per_token is not None:
                        pricing_info = {
                            "input_cost_per_million_tokens": input_cost_per_token * TOKEN_PRICE_MULTIPLIER,
                            "output_cost_per_million_tokens": output_cost_per_million * TOKEN_PRICE_MULTIPLIER,
                            "max_tokens": None  # cost_per_token doesn't provide max_tokens info
                        }
                    else:
                        pricing_info = {
                            "input_cost_per_million_tokens": None,
                            "output_cost_per_million_tokens": None,
                            "max_tokens": None
                        }
                except Exception as e:
                    logger.warning(f"Could not get pricing for model {model}: {str(e)}")
                    pricing_info = {
                        "input_cost_per_million_tokens": None,
                        "output_cost_per_million_tokens": None,
                        "max_tokens": None
                    }

            model_info.append({
                "id": model,
                "display_name": display_name,
                "short_name": model_aliases.get(model),
                "requires_subscription": requires_sub,
                "is_available": is_available,
                **pricing_info
            })
        
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
    current_user_id: str = Depends(get_current_user_id_from_jwt)
):
    """Get detailed usage logs for a user with pagination."""
    try:
        # Get Supabase client
        db = DBConnection()
        client = await db.client
        
        # Check if we're in local development mode
        if config.ENV_MODE == EnvMode.LOCAL:
            logger.info("Running in local development mode - usage logs are not available")
            return {
                "logs": [], 
                "has_more": False,
                "message": "Usage logs are not available in local development mode"
            }
        
        # Validate pagination parameters
        if page < 0:
            raise HTTPException(status_code=400, detail="Page must be non-negative")
        if items_per_page < 1 or items_per_page > 1000:
            raise HTTPException(status_code=400, detail="Items per page must be between 1 and 1000")
        
        # Get usage logs
        result = await get_usage_logs(client, current_user_id, page, items_per_page)
        
        return result
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting usage logs: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Error getting usage logs: {str(e)}")

@router.get("/subscription-commitment/{subscription_id}")
async def get_subscription_commitment(
    subscription_id: str,
    current_user_id: str = Depends(get_current_user_id_from_jwt)
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
    current_user_id: str = Depends(get_current_user_id_from_jwt)
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
    current_user_id: str = Depends(get_current_user_id_from_jwt)
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
            
            logger.info(f"Subscription {subscription_id} scheduled for cancellation at commitment end: {commitment_end_date}")
            
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

        logger.info(f"Subscription {subscription_id} marked for cancellation at period end")
        
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
    current_user_id: str = Depends(get_current_user_id_from_jwt)
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
        
        logger.info(f"Subscription {subscription_id} reactivated by user")
        
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
