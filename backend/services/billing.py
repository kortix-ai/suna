"""
Stripe Billing API implementation for Suna on top of Basejump. ONLY HAS SUPPOT FOR USER ACCOUNTS – no team accounts. As we are using the user_id as account_id as is the case with personal accounts. In personal accounts, the account_id equals the user_id. In team accounts, the account_id is unique.

stripe listen --forward-to localhost:8000/api/billing/webhook
"""

from fastapi import APIRouter, HTTPException, Depends, Request
from typing import Optional, Dict, Tuple
import stripe
from datetime import datetime, timezone
from utils.logger import logger
from utils.config import config, EnvMode
from services.supabase import DBConnection
from utils.auth_utils import get_current_user_id_from_jwt
from pydantic import BaseModel
from utils.constants import MODEL_ACCESS_TIERS, MODEL_NAME_ALIASES
from litellm import cost_per_token
import time

# Initialize Stripe
stripe.api_key = config.STRIPE_SECRET_KEY

# Token price multiplier
TOKEN_PRICE_MULTIPLIER = 1.5

# Initialize router
router = APIRouter(prefix="/billing", tags=["billing"])

# Hardcoded pricing for specific models (prices per million tokens)
HARDCODED_MODEL_PRICES = {
    "openrouter/deepseek/deepseek-chat": {
        "input_cost_per_million_tokens": 0.38,
        "output_cost_per_million_tokens": 0.89
    },
    "deepseek/deepseek-chat": {
        "input_cost_per_million_tokens": 0.38,
        "output_cost_per_million_tokens": 0.89
    },
    "qwen/qwen3-235b-a22b": {
        "input_cost_per_million_tokens": 0.13,
        "output_cost_per_million_tokens": 0.60
    },
    "openrouter/qwen/qwen3-235b-a22b": {
        "input_cost_per_million_tokens": 0.13,
        "output_cost_per_million_tokens": 0.60
    },
    "google/gemini-2.5-flash-preview-05-20": {
        "input_cost_per_million_tokens": 0.15,
        "output_cost_per_million_tokens": 0.60
    },
    "openrouter/google/gemini-2.5-flash-preview-05-20": {
        "input_cost_per_million_tokens": 0.15,
        "output_cost_per_million_tokens": 0.60
    },
    "anthropic/claude-sonnet-4": {
        "input_cost_per_million_tokens": 3.00,
        "output_cost_per_million_tokens": 15.00,
    },
    "google/gemini-2.5-pro": {
        "input_cost_per_million_tokens": 1.25,
        "output_cost_per_million_tokens": 10.00,
    },
    "openrouter/google/gemini-2.5-pro": {
        "input_cost_per_million_tokens": 1.25,
        "output_cost_per_million_tokens": 10.00,
    },
}

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
}

# Pydantic models for request/response validation
class CreateCheckoutSessionRequest(BaseModel):
    price_id: str
    success_url: str
    cancel_url: str
    tolt_referral: Optional[str] = None

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

# Helper functions
async def get_stripe_customer_id(client, user_id: str) -> Optional[str]:
    """Get the Stripe customer ID for a user."""
    result = await client.schema('basejump').from_('billing_customers') \
        .select('id') \
        .eq('account_id', user_id) \
        .execute()
    
    if result.data and len(result.data) > 0:
        return result.data[0]['id']
    return None

async def create_stripe_customer(client, user_id: str, email: str) -> str:
    """Create a new Stripe customer for a user."""
    # Create customer in Stripe
    customer = stripe.Customer.create(
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
        # Get customer ID
        db = DBConnection()
        client = await db.client
        customer_id = await get_stripe_customer_id(client, user_id)
        
        if not customer_id:
            return None
            
        # Get all active subscriptions for the customer
        subscriptions = stripe.Subscription.list(
            customer=customer_id,
            status='active'
        )
        # print("Found subscriptions:", subscriptions)
        
        # Check if we have any subscriptions
        if not subscriptions or not subscriptions.get('data'):
            return None
            
        # Filter subscriptions to only include our product's subscriptions
        our_subscriptions = []
        for sub in subscriptions['data']:
            # Get the first subscription item
            if sub.get('items') and sub['items'].get('data') and len(sub['items']['data']) > 0:
                item = sub['items']['data'][0]
                if item.get('price') and item['price'].get('id') in [
                    config.STRIPE_FREE_TIER_ID,
                    config.STRIPE_TIER_2_20_ID,
                    config.STRIPE_TIER_6_50_ID,
                    config.STRIPE_TIER_12_100_ID,
                    config.STRIPE_TIER_25_200_ID,
                    config.STRIPE_TIER_50_400_ID,
                    config.STRIPE_TIER_125_800_ID,
                    config.STRIPE_TIER_200_1000_ID,
                    # Yearly tiers
                    config.STRIPE_TIER_2_20_YEARLY_ID,
                    config.STRIPE_TIER_6_50_YEARLY_ID,
                    config.STRIPE_TIER_12_100_YEARLY_ID,
                    config.STRIPE_TIER_25_200_YEARLY_ID,
                    config.STRIPE_TIER_50_400_YEARLY_ID,
                    config.STRIPE_TIER_125_800_YEARLY_ID,
                    config.STRIPE_TIER_200_1000_YEARLY_ID
                ]:
                    our_subscriptions.append(sub)
        
        if not our_subscriptions:
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
                        stripe.Subscription.modify(
                            sub['id'],
                            cancel_at_period_end=True
                        )
                        logger.info(f"Cancelled subscription {sub['id']} for user {user_id}")
                    except Exception as e:
                        logger.error(f"Error cancelling subscription {sub['id']}: {str(e)}")
            
            return most_recent
            
        return our_subscriptions[0]
        
    except Exception as e:
        logger.error(f"Error getting subscription from Stripe: {str(e)}")
        return None

async def calculate_monthly_usage(client, user_id: str) -> float:
    """Calculate total agent run minutes for the current month for a user."""
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
            .select('thread_id') \
            .eq('account_id', user_id) \
            .gte('created_at', start_of_month.isoformat()) \
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
    return MODEL_ACCESS_TIERS.get(tier_name, MODEL_ACCESS_TIERS['free'])  # Default to free tier if unknown


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
    
    # Check if within limits
    if current_usage >= tier_info['cost']:
        return False, f"Monthly limit of {tier_info['cost']} dollars reached. Please upgrade your plan or wait until next month.", subscription
    
    return True, "OK", subscription

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
            price = stripe.Price.retrieve(request.price_id, expand=['product'])
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
                
                # Get current and new price details
                current_price = stripe.Price.retrieve(current_price_id)
                new_price = price # Already retrieved
                is_upgrade = new_price['unit_amount'] > current_price['unit_amount']

                if is_upgrade:
                    # --- Handle Upgrade --- Immediate modification
                    updated_subscription = stripe.Subscription.modify(
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
                    if updated_subscription.get('latest_invoice'):
                       latest_invoice = stripe.Invoice.retrieve(updated_subscription['latest_invoice']) 
                    
                    return {
                        "subscription_id": updated_subscription['id'],
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
                    # --- Handle Downgrade --- Use Subscription Schedule
                    try:
                        current_period_end_ts = subscription_item['current_period_end']
                        
                        # Retrieve the subscription again to get the schedule ID if it exists
                        # This ensures we have the latest state before creating/modifying schedule
                        sub_with_schedule = stripe.Subscription.retrieve(subscription_id)
                        schedule_id = sub_with_schedule.get('schedule')

                        # Get the current phase configuration from the schedule or subscription
                        if schedule_id:
                            schedule = stripe.SubscriptionSchedule.retrieve(schedule_id)
                            # Find the current phase in the schedule
                            # This logic assumes simple schedules; might need refinement for complex ones
                            current_phase = None
                            for phase in reversed(schedule['phases']):
                                if phase['start_date'] <= datetime.now(timezone.utc).timestamp():
                                    current_phase = phase
                                    break
                            if not current_phase: # Fallback if logic fails
                                current_phase = schedule['phases'][-1]
                        else:
                             # If no schedule, the current subscription state defines the current phase
                            current_phase = {
                                'items': existing_subscription['items']['data'], # Use original items data
                                'start_date': existing_subscription['current_period_start'], # Use sub start if no schedule
                                # Add other relevant fields if needed for create/modify
                            }

                        # Prepare the current phase data for the update/create
                        # Ensure items is formatted correctly for the API
                        current_phase_items_for_api = []
                        for item in current_phase.get('items', []):
                            price_data = item.get('price')
                            quantity = item.get('quantity')
                            price_id = None
                            
                            # Safely extract price ID whether it's an object or just the ID string
                            if isinstance(price_data, dict):
                                price_id = price_data.get('id')
                            elif isinstance(price_data, str):
                                price_id = price_data
                            
                            if price_id and quantity is not None:
                                current_phase_items_for_api.append({'price': price_id, 'quantity': quantity})
                            else:
                                logger.warning(f"Skipping item in current phase due to missing price ID or quantity: {item}")
                                
                        if not current_phase_items_for_api:
                             raise ValueError("Could not determine valid items for the current phase.")

                        current_phase_update_data = {
                            'items': current_phase_items_for_api,
                            'start_date': current_phase['start_date'], # Preserve original start date
                            'end_date': current_period_end_ts, # End this phase at period end
                            'proration_behavior': 'none'
                            # Include other necessary fields from current_phase if modifying?
                            # e.g., 'billing_cycle_anchor', 'collection_method'? Usually inherited.
                        }
                        
                        # Define the new (downgrade) phase
                        new_downgrade_phase_data = {
                            'items': [{'price': request.price_id, 'quantity': 1}],
                            'start_date': current_period_end_ts, # Start immediately after current phase ends
                            'proration_behavior': 'none'
                            # iterations defaults to 1, meaning it runs for one billing cycle
                            # then schedule ends based on end_behavior
                        }
                        
                        # Update or Create Schedule
                        if schedule_id:
                             # Update existing schedule, replacing all future phases
                            # print(f"Updating existing schedule {schedule_id}")
                            logger.info(f"Updating existing schedule {schedule_id} for subscription {subscription_id}")
                            logger.debug(f"Current phase data: {current_phase_update_data}")
                            logger.debug(f"New phase data: {new_downgrade_phase_data}")
                            updated_schedule = stripe.SubscriptionSchedule.modify(
                                schedule_id,
                                phases=[current_phase_update_data, new_downgrade_phase_data],
                                end_behavior='release' 
                            )
                            logger.info(f"Successfully updated schedule {updated_schedule['id']}")
                        else:
                             # Create a new schedule using the defined phases
                            print(f"Creating new schedule for subscription {subscription_id}")
                            logger.info(f"Creating new schedule for subscription {subscription_id}")
                            # Deep debug logging - write subscription details to help diagnose issues
                            logger.debug(f"Subscription details: {subscription_id}, current_period_end_ts: {current_period_end_ts}")
                            logger.debug(f"Current price: {current_price_id}, New price: {request.price_id}")
                            
                            try:
                                updated_schedule = stripe.SubscriptionSchedule.create(
                                    from_subscription=subscription_id,
                                    phases=[
                                        {
                                            'start_date': current_phase['start_date'],
                                            'end_date': current_period_end_ts,
                                            'proration_behavior': 'none',
                                            'items': [
                                                {
                                                    'price': current_price_id,
                                                    'quantity': 1
                                                }
                                            ]
                                        },
                                        {
                                            'start_date': current_period_end_ts,
                                            'proration_behavior': 'none',
                                            'items': [
                                                {
                                                    'price': request.price_id,
                                                    'quantity': 1
                                                }
                                            ]
                                        }
                                    ],
                                    end_behavior='release'
                                )
                                # Don't try to link the schedule - that's handled by from_subscription
                                logger.info(f"Created new schedule {updated_schedule['id']} from subscription {subscription_id}")
                                # print(f"Created new schedule {updated_schedule['id']} from subscription {subscription_id}")
                                
                                # Verify the schedule was created correctly
                                fetched_schedule = stripe.SubscriptionSchedule.retrieve(updated_schedule['id'])
                                logger.info(f"Schedule verification - Status: {fetched_schedule.get('status')}, Phase Count: {len(fetched_schedule.get('phases', []))}")
                                logger.debug(f"Schedule details: {fetched_schedule}")
                            except Exception as schedule_error:
                                logger.exception(f"Failed to create schedule: {str(schedule_error)}")
                                raise schedule_error  # Re-raise to be caught by the outer try-except
                        
                        return {
                            "subscription_id": subscription_id,
                            "schedule_id": updated_schedule['id'],
                            "status": "scheduled",
                            "message": "Subscription downgrade scheduled",
                            "details": {
                                "is_upgrade": False,
                                "effective_date": "end_of_period",
                                "current_price": round(current_price['unit_amount'] / 100, 2) if current_price.get('unit_amount') else 0,
                                "new_price": round(new_price['unit_amount'] / 100, 2) if new_price.get('unit_amount') else 0,
                                "effective_at": datetime.fromtimestamp(current_period_end_ts, tz=timezone.utc).isoformat()
                            }
                        }
                    except Exception as e:
                         logger.exception(f"Error handling subscription schedule for sub {subscription_id}: {str(e)}")
                         raise HTTPException(status_code=500, detail=f"Error handling subscription schedule: {str(e)}")
            except Exception as e:
                logger.exception(f"Error updating subscription {existing_subscription.get('id') if existing_subscription else 'N/A'}: {str(e)}")
                raise HTTPException(status_code=500, detail=f"Error updating subscription: {str(e)}")
        else:
            
            session = stripe.checkout.Session.create(
                customer=customer_id,
                payment_method_types=['card'],
                    line_items=[{'price': request.price_id, 'quantity': 1}],
                mode='subscription',
                success_url=request.success_url,
                cancel_url=request.cancel_url,
                metadata={
                        'user_id': current_user_id,
                        'product_id': product_id,
                        'tolt_referral': request.tolt_referral
                },
                allow_promotion_codes=True
            )
            
            # Update customer status to potentially active (will be confirmed by webhook)
            # This ensures customer is marked as active once payment is completed
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
            configurations = stripe.billing_portal.Configuration.list(limit=100)
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
                    
                    active_config = stripe.billing_portal.Configuration.update(
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
                    active_config = stripe.billing_portal.Configuration.create(
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
        session = stripe.billing_portal.Session.create(**portal_params)
        
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
            has_schedule=False # Default
        )

        # Check for an attached schedule (indicates pending downgrade)
        schedule_id = subscription.get('schedule')
        if schedule_id:
            try:
                schedule = stripe.SubscriptionSchedule.retrieve(schedule_id)
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
        except ValueError as e:
            raise HTTPException(status_code=400, detail="Invalid payload")
        except stripe.error.SignatureVerificationError as e:
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
            
            if event.type == 'customer.subscription.created' or event.type == 'customer.subscription.updated':
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
                    has_active = len(stripe.Subscription.list(
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
                has_active = len(stripe.Subscription.list(
                    customer=customer_id,
                    status='active',
                    limit=1
                ).get('data', [])) > 0
                
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
                    
                    # Special handling for Google models accessed via OpenRouter
                    if model.startswith('openrouter/google/'):
                        google_model_name = model.replace('openrouter/', '')
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
                            "output_cost_per_million_tokens": output_cost_per_token * TOKEN_PRICE_MULTIPLIER,
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