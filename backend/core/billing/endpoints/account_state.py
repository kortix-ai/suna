from fastapi import APIRouter, HTTPException, Depends
from typing import Dict, Optional
from datetime import datetime, timezone, timedelta
import asyncio
import httpx
from core.utils.auth_utils import verify_and_get_user_id_from_jwt
from core.utils.config import config, EnvMode
from core.utils.logger import logger
from core.utils.cache import Cache
from core.ai_models import model_manager
from core.services.credits import credit_service
from ..shared.config import (
    CREDITS_PER_DOLLAR,
    get_tier_by_name,
    is_model_allowed,
    get_price_type,
    TIERS
)
from ..subscriptions import subscription_service
from ..external.stripe import StripeAPIWrapper
from ..repo import get_credit_account

router = APIRouter(tags=["billing-account-state"])

from ..shared.cache_utils import ACCOUNT_STATE_CACHE_TTL, invalidate_account_state_cache

# Stripe subscription cache TTL (10 minutes - Stripe data rarely changes)
# Increased from 5 min to reduce Stripe API calls in production
STRIPE_SUBSCRIPTION_CACHE_TTL = 600

# Timeout for Stripe API calls when building account state
STRIPE_FETCH_TIMEOUT = 8.0  # 8 seconds max


async def _get_cached_stripe_subscription(subscription_id: str, timeout: float = STRIPE_FETCH_TIMEOUT) -> Optional[Dict]:
    """
    Get Stripe subscription from cache to avoid slow API calls.
    
    PERFORMANCE OPTIMIZATIONS (Jan 2026):
    - Extended cache TTL (10 min) to reduce Stripe API calls
    - Timeout protection to prevent slow requests from blocking
    - Graceful fallback on timeout/error (returns None, caller handles)
    """
    if not subscription_id:
        return None
    
    cache_key = f"stripe_sub:{subscription_id}"
    try:
        cached = await Cache.get(cache_key)
        if cached:
            logger.debug(f"⚡ Stripe subscription cache hit: {subscription_id[:8]}...")
            return cached
    except Exception:
        pass
    
    # Cache miss - fetch from Stripe with timeout protection
    try:
        subscription_data = await asyncio.wait_for(
            StripeAPIWrapper.retrieve_subscription(subscription_id),
            timeout=timeout
        )
        if subscription_data:
            # Convert Stripe object to dict for caching
            if hasattr(subscription_data, 'to_dict'):
                subscription_dict = subscription_data.to_dict()
            elif hasattr(subscription_data, '__dict__'):
                subscription_dict = dict(subscription_data)
            else:
                subscription_dict = subscription_data
            
            try:
                await Cache.set(cache_key, subscription_dict, ttl=STRIPE_SUBSCRIPTION_CACHE_TTL)
            except Exception:
                pass
            return subscription_dict
        return subscription_data
    except asyncio.TimeoutError:
        logger.warning(f"[ACCOUNT_STATE] Stripe subscription fetch timed out after {timeout}s: {subscription_id[:8]}...")
        return None
    except Exception as e:
        logger.warning(f"[ACCOUNT_STATE] Failed to retrieve Stripe subscription: {e}")
        return None


async def _build_account_state(account_id: str) -> Dict:
    """
    Build complete account state.
    
    PERFORMANCE OPTIMIZATIONS:
    - Fetches tier info ONCE and passes to all limit checkers
    - Caches Stripe subscription data (5 min TTL)
    - Runs all limit checks in parallel
    """
    import time
    t_start = time.time()
    
    # Fetch credit account and tier info in parallel
    credit_account_task = get_credit_account(account_id)
    tier_info_task = subscription_service.get_user_subscription_tier(account_id, skip_cache=False)
    
    credit_account, subscription_tier_info = await asyncio.gather(
        credit_account_task,
        tier_info_task
    )
    credit_account = credit_account or {}
    
    tier_name = subscription_tier_info.get('name', 'none')
    tier_info = get_tier_by_name(tier_name)
    if not tier_info:
        tier_info = TIERS['none']
    
    logger.debug(f"[ACCOUNT_STATE] Fetched credit account + tier in {(time.time() - t_start) * 1000:.1f}ms")
    
    # Trial status
    trial_status = credit_account.get('trial_status')
    trial_ends_at = credit_account.get('trial_ends_at')
    is_trial = trial_status == 'active'
    
    # Balance calculations (stored in dollars, convert to credits)
    daily_dollars = float(credit_account.get('daily_credits_balance', 0) or 0)
    monthly_dollars = float(credit_account.get('expiring_credits', 0) or 0)
    extra_dollars = float(credit_account.get('non_expiring_credits', 0) or 0)
    last_daily_refresh = credit_account.get('last_daily_refresh')
    
    # Convert to credits
    daily_credits = daily_dollars * CREDITS_PER_DOLLAR
    monthly_credits = monthly_dollars * CREDITS_PER_DOLLAR
    extra_credits = extra_dollars * CREDITS_PER_DOLLAR
    total_credits = daily_credits + monthly_credits + extra_credits
    
    # Daily credits refresh info
    daily_credits_info = None
    has_daily_credits = tier_info.daily_credit_config and tier_info.daily_credit_config.get('enabled')
    
    if has_daily_credits:
        refresh_interval_hours = tier_info.daily_credit_config.get('refresh_interval_hours', 24)
        daily_amount = float(tier_info.daily_credit_config.get('amount', 0)) * CREDITS_PER_DOLLAR
        
        next_refresh_at = None
        seconds_until_refresh = None
        
        if last_daily_refresh:
            try:
                last_refresh_dt = datetime.fromisoformat(last_daily_refresh.replace('Z', '+00:00'))
                next_refresh_dt = last_refresh_dt + timedelta(hours=refresh_interval_hours)
                next_refresh_at = next_refresh_dt.isoformat()
                time_diff = next_refresh_dt - datetime.now(timezone.utc)
                seconds_until_refresh = max(0, int(time_diff.total_seconds()))
            except Exception:
                pass
        
        daily_credits_info = {
            'enabled': True,
            'daily_amount': daily_amount,
            'refresh_interval_hours': refresh_interval_hours,
            'last_refresh': last_daily_refresh,
            'next_refresh_at': next_refresh_at,
            'seconds_until_refresh': seconds_until_refresh
        }
    
    # Get subscription info - use cached Stripe data
    subscription_data = None
    billing_period = credit_account.get('plan_type')
    provider = credit_account.get('provider', 'stripe')
    
    stripe_subscription_id = credit_account.get('stripe_subscription_id')
    if stripe_subscription_id and provider == 'stripe':
        # Use cached Stripe subscription (avoids 200-800ms API call)
        subscription_data = await _get_cached_stripe_subscription(stripe_subscription_id)
        
        # Get billing period from subscription if not in credit_account
        if not billing_period and subscription_data:
            items_data = subscription_data.get('items', {}).get('data', [])
            if items_data:
                price_id = items_data[0].get('price', {}).get('id')
                if price_id:
                    billing_period = get_price_type(price_id)
    
    # RevenueCat billing period
    if provider == 'revenuecat' and credit_account.get('revenuecat_product_id'):
        product_id_lower = credit_account.get('revenuecat_product_id', '').lower()
        if 'commitment' in product_id_lower:
            billing_period = 'yearly_commitment'
        elif 'yearly' in product_id_lower or 'annual' in product_id_lower:
            billing_period = 'yearly'
        elif 'monthly' in product_id_lower:
            billing_period = 'monthly'
    
    # Determine subscription status
    if subscription_data:
        sub_status = subscription_data.get('status', 'active')
        if sub_status == 'trialing' or is_trial:
            status = 'trialing'
        else:
            status = sub_status
    elif tier_name not in ['none', 'free']:
        status = 'active'
    elif tier_name == 'free':
        status = 'active'
    else:
        status = 'no_subscription'
    
    # Display name with trial indicator
    if is_trial and tier_name == 'tier_2_20':
        display_name = f"{tier_info.display_name} (Trial)"
    else:
        display_name = tier_info.display_name
    
    # Cancellation status
    is_cancelled = False
    cancellation_effective_date = None
    
    # Check Stripe cancellation
    if subscription_data:
        cancel_at_period_end = subscription_data.get('cancel_at_period_end', False)
        canceled_at = subscription_data.get('canceled_at')
        current_period_end = subscription_data.get('current_period_end')
        
        if cancel_at_period_end or canceled_at:
            is_cancelled = True
            if current_period_end:
                try:
                    cancellation_effective_date = datetime.fromtimestamp(
                        current_period_end, timezone.utc
                    ).isoformat()
                except Exception:
                    pass
    
    # Check RevenueCat cancellation
    if provider == 'revenuecat':
        revenuecat_cancelled_at = credit_account.get('revenuecat_cancelled_at')
        revenuecat_cancel_at_period_end = credit_account.get('revenuecat_cancel_at_period_end')
        
        if revenuecat_cancelled_at or revenuecat_cancel_at_period_end:
            is_cancelled = True
            if revenuecat_cancel_at_period_end:
                cancellation_effective_date = revenuecat_cancel_at_period_end
    
    # Get scheduled changes (pass subscription_data to avoid duplicate Stripe API calls)
    try:
        scheduled_changes = await subscription_service.get_scheduled_changes(account_id, subscription_data)
    except Exception as e:
        logger.warning(f"[ACCOUNT_STATE] Failed to get scheduled changes: {e}")
        scheduled_changes = {'has_scheduled_change': False, 'scheduled_change': None}
    
    # Get commitment status
    try:
        commitment_info = await subscription_service.get_commitment_status(account_id)
    except Exception as e:
        logger.warning(f"[ACCOUNT_STATE] Failed to get commitment status: {e}")
        commitment_info = {
            'has_commitment': False,
            'can_cancel': True,
            'commitment_type': None,
            'months_remaining': None,
            'commitment_end_date': None
        }
    
    # Get available models
    all_models = model_manager.list_available_models(include_disabled=True)
    models = []
    for model in all_models:
        allowed = is_model_allowed(tier_name, model['id'])
        models.append({
            'id': model['id'],
            'name': model['name'],
            'allowed': allowed,
            'context_window': model.get('context_window', 128000),
            'capabilities': model.get('capabilities', []),
            'priority': model.get('priority', 0),
            'recommended': model.get('recommended', False)
        })
    
    # Get tier limits with detailed usage info
    from core.utils.limits_checker import get_all_limits_fast
    
    all_limits = await get_all_limits_fast(account_id, tier_info=subscription_tier_info)
    
    # Extract individual limits from combined result
    thread_limit = all_limits['threads']
    concurrent_runs_limit = all_limits['concurrent_runs']
    agent_count_limit = all_limits['agents']
    project_count_limit = all_limits['projects']
    trigger_limit = all_limits['triggers']
    custom_mcp_limit = all_limits['custom_mcps']
    
    logger.debug(f"[ACCOUNT_STATE] Built complete state in {(time.time() - t_start) * 1000:.1f}ms")
    
    # Build response
    return {
        # Credits section
        'credits': {
            'total': total_credits,
            'daily': daily_credits,
            'monthly': monthly_credits,
            'extra': extra_credits,
            'can_run': total_credits >= 1,  # 1 credit = $0.01
            'daily_refresh': daily_credits_info
        },
        
        # Subscription section
        'subscription': {
            'tier_key': tier_name,
            'tier_display_name': display_name,
            'status': status,
            'billing_period': billing_period,
            'provider': provider,
            'subscription_id': subscription_data.get('id') if subscription_data else None,
            'current_period_end': subscription_data.get('current_period_end') if subscription_data else None,
            'cancel_at_period_end': subscription_data.get('cancel_at_period_end', False) if subscription_data else False,
            'is_trial': is_trial,
            'trial_status': trial_status,
            'trial_ends_at': trial_ends_at,
            'is_cancelled': is_cancelled,
            'cancellation_effective_date': cancellation_effective_date,
            'has_scheduled_change': scheduled_changes.get('has_scheduled_change', False),
            'scheduled_change': scheduled_changes.get('scheduled_change'),
            'commitment': commitment_info,
            'can_purchase_credits': tier_info.can_purchase_credits
        },
        
        # Models section
        'models': models,
        
        # Limits section - detailed usage info
        'limits': {
            'projects': {
                'current': project_count_limit.get('current_count', 0),
                'max': project_count_limit.get('limit', 0),
                'can_create': project_count_limit.get('can_create', False),
                'tier_name': project_count_limit.get('tier_name', tier_name)
            },
            'threads': {
                'current': thread_limit.get('current_count', 0),
                'max': thread_limit.get('limit', 0),
                'can_create': thread_limit.get('can_create', False),
                'tier_name': thread_limit.get('tier_name', tier_name)
            },
            'concurrent_runs': {
                'running_count': concurrent_runs_limit.get('running_count', 0),
                'limit': concurrent_runs_limit.get('limit', 0),
                'can_start': concurrent_runs_limit.get('can_start', False),
                'tier_name': concurrent_runs_limit.get('tier_name', tier_name)
            },
            'ai_worker_count': {
                'current_count': agent_count_limit.get('current_count', 0),
                'limit': agent_count_limit.get('limit', 0),
                'can_create': agent_count_limit.get('can_create', False),
                'tier_name': agent_count_limit.get('tier_name', tier_name)
            },
            'custom_mcp_count': {
                'current_count': custom_mcp_limit.get('current_count', 0),
                'limit': custom_mcp_limit.get('limit', 0),
                'can_create': custom_mcp_limit.get('can_create', False),
                'tier_name': custom_mcp_limit.get('tier_name', tier_name)
            },
            'trigger_count': {
                'scheduled': {
                    'current_count': trigger_limit.get('scheduled', {}).get('current_count', 0),
                    'limit': trigger_limit.get('scheduled', {}).get('limit', 0),
                    'can_create': trigger_limit.get('scheduled', {}).get('can_create', False)
                },
                'app': {
                    'current_count': trigger_limit.get('app', {}).get('current_count', 0),
                    'limit': trigger_limit.get('app', {}).get('limit', 0),
                    'can_create': trigger_limit.get('app', {}).get('can_create', False)
                },
                'tier_name': trigger_limit.get('tier_name', tier_name)
            }
        },
        
        # Tier config (for UI display)
        'tier': {
            'name': tier_name,
            'display_name': tier_info.display_name,
            'monthly_credits': float(tier_info.monthly_credits) * CREDITS_PER_DOLLAR,
            'can_purchase_credits': tier_info.can_purchase_credits
        }
    }


@router.get("/account-state")
async def get_account_state(
    account_id: str = Depends(verify_and_get_user_id_from_jwt),
    skip_cache: bool = False
) -> Dict:
    """
    Get unified account state including credits, subscription, models, and limits.
    
    This is the single source of truth for all billing-related frontend data.
    Data is cached for 5 minutes to optimize latency.
    """
    # Local development mode - return mock data
    if config.ENV_MODE == EnvMode.LOCAL:
        all_models = model_manager.list_available_models(include_disabled=True)
        return {
            'credits': {
                'total': 999999,
                'daily': 200,
                'monthly': 999799,
                'extra': 0,
                'can_run': True,
                'daily_refresh': None
            },
            'subscription': {
                'tier_key': 'tier_25_200',
                'tier_display_name': 'Local Development',
                'status': 'active',
                'billing_period': 'monthly',
                'provider': 'local',
                'subscription_id': None,
                'current_period_end': None,
                'cancel_at_period_end': False,
                'is_trial': False,
                'trial_status': None,
                'trial_ends_at': None,
                'is_cancelled': False,
                'cancellation_effective_date': None,
                'has_scheduled_change': False,
                'scheduled_change': None,
                'commitment': {
                    'has_commitment': False,
                    'can_cancel': True,
                    'commitment_type': None,
                    'months_remaining': None,
                    'commitment_end_date': None
                },
                'can_purchase_credits': True
            },
            'models': [
                {
                    'id': model['id'],
                    'name': model['name'],
                    'allowed': True,
                    'context_window': model.get('context_window', 128000),
                    'capabilities': model.get('capabilities', []),
                    'priority': model.get('priority', 0),
                    'recommended': model.get('recommended', False)
                }
                for model in all_models
            ],
            'limits': {
                'projects': {
                    'current': 0,
                    'max': 99999,
                    'can_create': True,
                    'tier_name': 'tier_25_200'
                },
                'threads': {
                    'current': 0,
                    'max': 99999,
                    'can_create': True,
                    'tier_name': 'tier_25_200'
                },
                'concurrent_runs': {
                    'running_count': 0,
                    'limit': 99999,
                    'can_start': True,
                    'tier_name': 'tier_25_200'
                },
                'ai_worker_count': {
                    'current_count': 0,
                    'limit': 99999,
                    'can_create': True,
                    'tier_name': 'tier_25_200'
                },
                'custom_mcp_count': {
                    'current_count': 0,
                    'limit': 99999,
                    'can_create': True,
                    'tier_name': 'tier_25_200'
                },
                'trigger_count': {
                    'scheduled': {
                        'current_count': 0,
                        'limit': 99999,
                        'can_create': True
                    },
                    'app': {
                        'current_count': 0,
                        'limit': 99999,
                        'can_create': True
                    },
                    'tier_name': 'tier_25_200'
                }
            },
            'tier': {
                'name': 'tier_25_200',
                'display_name': 'Local Development',
                'monthly_credits': 40000,
                'can_purchase_credits': True
            },
            '_cache': {
                'cached': False,
                'local_mode': True
            }
        }
    
    # Retry configuration for connection timeouts
    max_retries = 3
    retry_delay = 0.5  # seconds
    
    cache_key = f"account_state:{account_id}"
    
    # Try cache first with timeout protection
    if not skip_cache:
        try:
            cached_data = await Cache.get(cache_key)
            if cached_data:
                cached_data['_cache'] = {
                    'cached': True,
                    'ttl_seconds': ACCOUNT_STATE_CACHE_TTL
                }
                return cached_data
        except Exception as cache_err:
            # Cache miss or timeout - continue to fetch fresh data
            logger.debug(f"[ACCOUNT_STATE] Cache read failed for {account_id}: {cache_err}")
    
    last_error = None
    
    for attempt in range(max_retries):
        try:
            # Ensure daily credits are refreshed if needed (non-blocking on failure)
            try:
                await credit_service.check_and_refresh_daily_credits(account_id)
            except (httpx.ConnectTimeout, httpx.PoolTimeout, TimeoutError) as credit_err:
                logger.warning(f"[ACCOUNT_STATE] Daily credit refresh timed out for {account_id}: {credit_err}")
                # Continue - this is not critical for reading account state
            
            # Build fresh data (no client needed - uses repo)
            account_state = await _build_account_state(account_id)
            
            # Cache the result (non-blocking on failure)
            try:
                await Cache.set(cache_key, account_state, ttl=ACCOUNT_STATE_CACHE_TTL)
            except Exception as cache_write_err:
                logger.debug(f"[ACCOUNT_STATE] Cache write failed for {account_id}: {cache_write_err}")
            
            account_state['_cache'] = {
                'cached': False,
                'ttl_seconds': ACCOUNT_STATE_CACHE_TTL
            }
            
            return account_state
            
        except (httpx.ConnectTimeout, httpx.PoolTimeout, httpx.ConnectError) as e:
            last_error = e
            if attempt < max_retries - 1:
                delay = retry_delay * (2 ** attempt)  # Exponential backoff
                logger.warning(
                    f"[ACCOUNT_STATE] Connection timeout for {account_id} (attempt {attempt + 1}/{max_retries}), "
                    f"retrying in {delay}s..."
                )
                await asyncio.sleep(delay)
            else:
                logger.error(f"[ACCOUNT_STATE] Failed after {max_retries} attempts for {account_id}: {e}")
                raise HTTPException(
                    status_code=503, 
                    detail="Service temporarily unavailable. Please try again."
                )
        except Exception as e:
            logger.error(f"[ACCOUNT_STATE] Error getting account state for {account_id}: {e}")
            raise HTTPException(status_code=500, detail=str(e))
    
    # Should not reach here, but just in case
    logger.error(f"[ACCOUNT_STATE] Unexpected exit from retry loop for {account_id}: {last_error}")
    raise HTTPException(status_code=503, detail="Service temporarily unavailable. Please try again.")
