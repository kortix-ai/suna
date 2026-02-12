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


def _extract_commitment_from_credit_account(credit_account: Dict) -> Dict:
    commitment_type = credit_account.get('commitment_type')
    commitment_end_date = credit_account.get('commitment_end_date')
    
    if not commitment_type or not commitment_end_date:
        return {
            'has_commitment': False,
            'can_cancel': True,
            'commitment_type': None,
            'months_remaining': None,
            'commitment_end_date': None
        }
    
    try:
        end_date = datetime.fromisoformat(str(commitment_end_date).replace('Z', '+00:00'))
        now = datetime.now(timezone.utc)
        
        if now >= end_date:
            return {
                'has_commitment': False,
                'can_cancel': True,
                'commitment_type': None,
                'months_remaining': None,
                'commitment_end_date': None
            }
        
        months_remaining = max(0, (end_date.year - now.year) * 12 + (end_date.month - now.month))
        
        return {
            'has_commitment': True,
            'can_cancel': False,
            'commitment_type': commitment_type,
            'months_remaining': months_remaining,
            'commitment_end_date': commitment_end_date if isinstance(commitment_end_date, str) else commitment_end_date.isoformat()
        }
    except Exception:
        return {
            'has_commitment': False,
            'can_cancel': True,
            'commitment_type': None,
            'months_remaining': None,
            'commitment_end_date': None
        }


def _extract_scheduled_changes_from_credit_account(credit_account: Dict) -> Dict:
    """Extract scheduled changes directly from credit_account to avoid redundant DB query."""
    try:
        current_tier_name = credit_account.get('tier', 'none')
        provider = credit_account.get('provider', 'stripe')

        # Check RevenueCat pending changes
        if provider == 'revenuecat':
            pending_product = credit_account.get('revenuecat_pending_change_product')
            pending_date = credit_account.get('revenuecat_pending_change_date')
            if pending_product and pending_date:
                from core.billing.external.revenuecat.utils import ProductMapper
                target_tier_name, target_tier_info = ProductMapper.get_tier_info(pending_product)
                if target_tier_info and current_tier_name != target_tier_name:
                    current_tier = get_tier_by_name(current_tier_name)
                    return {
                        'has_scheduled_change': True,
                        'scheduled_change': {
                            'type': 'downgrade' if target_tier_info.monthly_credits < (current_tier.monthly_credits if current_tier else 0) else 'change',
                            'current_tier': {
                                'name': current_tier.name if current_tier else 'none',
                                'display_name': current_tier.display_name if current_tier else 'Unknown',
                                'monthly_credits': float(current_tier.monthly_credits) if current_tier else 0
                            },
                            'target_tier': {
                                'name': target_tier_name,
                                'display_name': target_tier_info.display_name,
                                'monthly_credits': float(target_tier_info.monthly_credits)
                            },
                            'effective_date': pending_date if isinstance(pending_date, str) else pending_date.isoformat()
                        }
                    }

        # Check Stripe scheduled changes (stored in DB)
        scheduled_tier = credit_account.get('scheduled_tier_change')
        scheduled_date = credit_account.get('scheduled_tier_change_date')

        if scheduled_tier and scheduled_date and scheduled_tier != current_tier_name:
            current_tier = get_tier_by_name(current_tier_name)
            target_tier = get_tier_by_name(scheduled_tier)
            return {
                'has_scheduled_change': True,
                'scheduled_change': {
                    'type': 'downgrade',
                    'current_tier': {
                        'name': current_tier.name if current_tier else 'none',
                        'display_name': current_tier.display_name if current_tier else 'Unknown',
                        'monthly_credits': float(current_tier.monthly_credits) if current_tier else 0
                    },
                    'target_tier': {
                        'name': target_tier.name if target_tier else scheduled_tier,
                        'display_name': target_tier.display_name if target_tier else scheduled_tier,
                        'monthly_credits': float(target_tier.monthly_credits) if target_tier else 0
                    },
                    'effective_date': scheduled_date if isinstance(scheduled_date, str) else scheduled_date.isoformat()
                }
            }

        return {'has_scheduled_change': False, 'scheduled_change': None}
    except Exception:
        return {'has_scheduled_change': False, 'scheduled_change': None}


async def _refresh_daily_credits_background(account_id: str) -> None:
    """Fire-and-forget daily credit refresh. Don't let this block account-state."""
    try:
        await credit_service.check_and_refresh_daily_credits(account_id)
    except Exception as e:
        logger.debug(f"[ACCOUNT_STATE] Background daily credit refresh failed for {account_id}: {e}")


async def _build_minimal_account_state(account_id: str) -> Dict:
    """
    Build minimal account state with only essential data for dashboard.

    This is ~10x faster than full account state because it:
    - Only fetches credit_account (single DB query)
    - No limits queries
    - No models iteration
    - No scheduled changes processing
    """
    import time
    t_start = time.time()

    # Single DB query - get credit account
    credit_account = await get_credit_account(account_id)
    credit_account = credit_account or {}

    tier_name = credit_account.get('tier', 'none')
    tier_info = get_tier_by_name(tier_name)
    if not tier_info:
        tier_info = TIERS['none']

    # Trial status
    trial_status = credit_account.get('trial_status')
    is_trial = trial_status == 'active'

    # Balance calculations
    daily_dollars = float(credit_account.get('daily_credits_balance', 0) or 0)
    monthly_dollars = float(credit_account.get('expiring_credits', 0) or 0)
    extra_dollars = float(credit_account.get('non_expiring_credits', 0) or 0)
    last_daily_refresh = credit_account.get('last_daily_refresh')

    total_balance_dollars = float(credit_account.get('balance', 0) or 0)

    # Populate credit_balance cache
    try:
        await Cache.set(f"credit_balance:{account_id}", {
            'total': total_balance_dollars,
            'account_id': account_id
        }, ttl=300)
    except Exception:
        pass

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

    # Subscription status
    provider = credit_account.get('provider', 'stripe')
    stripe_status = credit_account.get('stripe_subscription_status')

    if is_trial:
        status = 'trialing'
    elif stripe_status and provider == 'stripe':
        status = stripe_status
    elif tier_name not in ['none', 'free']:
        status = 'active'
    elif tier_name == 'free':
        status = 'active'
    else:
        status = 'no_subscription'

    if is_trial and tier_name == 'tier_2_20':
        display_name = f"{tier_info.display_name} (Trial)"
    else:
        display_name = tier_info.display_name

    logger.info(f"[ACCOUNT_STATE_MINIMAL] Built in {(time.time() - t_start) * 1000:.1f}ms for {account_id[:8]}...")

    return {
        'credits': {
            'total': total_credits,
            'daily': daily_credits,
            'monthly': monthly_credits,
            'extra': extra_credits,
            'can_run': total_credits >= 1,
            'daily_refresh': daily_credits_info
        },
        'subscription': {
            'tier_key': tier_name,
            'tier_display_name': display_name,
            'status': status,
            'is_trial': is_trial,
            'trial_status': trial_status
        },
        'tier': {
            'name': tier_name,
            'display_name': tier_info.display_name
        }
    }


async def _get_cached_stripe_subscription(subscription_id: str, timeout: float = STRIPE_FETCH_TIMEOUT) -> Optional[Dict]:
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


async def _build_account_state(account_id: str, skip_cache: bool = False) -> Dict:
    import time
    t_start = time.time()
    
    credit_account_task = get_credit_account(account_id)
    tier_info_task = subscription_service.get_user_subscription_tier(account_id, skip_cache=skip_cache)
    
    credit_account, subscription_tier_info = await asyncio.gather(
        credit_account_task,
        tier_info_task
    )
    credit_account = credit_account or {}
    
    tier_name = subscription_tier_info.get('name', 'none')
    tier_info = get_tier_by_name(tier_name)
    if not tier_info:
        tier_info = TIERS['none']
    
    logger.info(f"[ACCOUNT_STATE] {account_id[:8]}... tier={tier_name} thread_limit={subscription_tier_info.get('thread_limit')} project_limit={subscription_tier_info.get('project_limit')} skip_cache={skip_cache}")
    logger.info(f"[ACCOUNT_STATE] Fetched credit account + tier in {(time.time() - t_start) * 1000:.1f}ms")
    
    # Trial status
    trial_status = credit_account.get('trial_status')
    trial_ends_at = credit_account.get('trial_ends_at')
    is_trial = trial_status == 'active'
    
    # Balance calculations (stored in dollars, convert to credits)
    daily_dollars = float(credit_account.get('daily_credits_balance', 0) or 0)
    monthly_dollars = float(credit_account.get('expiring_credits', 0) or 0)
    extra_dollars = float(credit_account.get('non_expiring_credits', 0) or 0)
    last_daily_refresh = credit_account.get('last_daily_refresh')
    
    # Get the total balance from credit_account (this is the authoritative source)
    total_balance_dollars = float(credit_account.get('balance', 0) or 0)
    
    # Populate the credit_balance cache so billing checks don't need to hit DB
    # This is the key optimization - dashboard visit warms the billing cache
    try:
        balance_data = {
            'total': total_balance_dollars,
            'account_id': account_id
        }
        await Cache.set(f"credit_balance:{account_id}", balance_data, ttl=300)
        logger.debug(f"⚡ [ACCOUNT_STATE] Populated credit_balance cache for {account_id}")
    except Exception as e:
        logger.debug(f"[ACCOUNT_STATE] Failed to populate credit_balance cache: {e}")
    
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
    
    subscription_data = None
    billing_period = credit_account.get('plan_type')
    provider = credit_account.get('provider', 'stripe')

    stripe_subscription_id = credit_account.get('stripe_subscription_id')
    from core.utils.limits_checker import get_all_limits_fast

    t_limits = time.time()
    all_limits = await get_all_limits_fast(account_id, tier_info=subscription_tier_info)
    logger.info(f"[ACCOUNT_STATE] get_all_limits_fast took {(time.time() - t_limits) * 1000:.1f}ms")
    
    if provider == 'revenuecat' and credit_account.get('revenuecat_product_id'):
        product_id_lower = credit_account.get('revenuecat_product_id', '').lower()
        if 'commitment' in product_id_lower:
            billing_period = 'yearly_commitment'
        elif 'yearly' in product_id_lower or 'annual' in product_id_lower:
            billing_period = 'yearly'
        elif 'monthly' in product_id_lower:
            billing_period = 'monthly'
    
    stripe_status = credit_account.get('stripe_subscription_status')
    if is_trial:
        status = 'trialing'
    elif stripe_status and provider == 'stripe':
        status = stripe_status
    elif tier_name not in ['none', 'free']:
        status = 'active'
    elif tier_name == 'free':
        status = 'active'
    else:
        status = 'no_subscription'

    if is_trial and tier_name == 'tier_2_20':
        display_name = f"{tier_info.display_name} (Trial)"
    else:
        display_name = tier_info.display_name

    is_cancelled = False
    cancellation_effective_date = None

    if provider == 'stripe' and stripe_status == 'canceled':
        is_cancelled = True

    if provider == 'revenuecat':
        revenuecat_cancelled_at = credit_account.get('revenuecat_cancelled_at')
        revenuecat_cancel_at_period_end = credit_account.get('revenuecat_cancel_at_period_end')
        
        if revenuecat_cancelled_at or revenuecat_cancel_at_period_end:
            is_cancelled = True
            if revenuecat_cancel_at_period_end:
                cancellation_effective_date = revenuecat_cancel_at_period_end
    
    # Extract scheduled changes from already-fetched credit_account (no extra DB call)
    scheduled_changes = _extract_scheduled_changes_from_credit_account(credit_account)

    commitment_info = _extract_commitment_from_credit_account(credit_account)

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
    
    # all_limits already fetched above in parallel with Stripe
    
    thread_limit = all_limits['threads']
    concurrent_runs_limit = all_limits['concurrent_runs']
    agent_count_limit = all_limits['agents']
    project_count_limit = all_limits['projects']
    trigger_limit = all_limits['triggers']
    custom_mcp_limit = all_limits['custom_mcps']
    
    # Note: get_all_limits_fast already warms the slot_manager caches
    
    logger.info(f"[ACCOUNT_STATE] Built complete state in {(time.time() - t_start) * 1000:.1f}ms")
    
    return {
        'credits': {
            'total': total_credits,
            'daily': daily_credits,
            'monthly': monthly_credits,
            'extra': extra_credits,
            'can_run': total_credits >= 1,
            'daily_refresh': daily_credits_info
        },
        'subscription': {
            'tier_key': tier_name,
            'tier_display_name': display_name,
            'status': status,
            'billing_period': billing_period,
            'provider': provider,
            'subscription_id': stripe_subscription_id,
            'current_period_end': None,  # TODO: Add stripe_current_period_end column to DB
            'cancel_at_period_end': is_cancelled,
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
        
        'models': models,
        
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
        

        'tier': {
            'name': tier_name,
            'display_name': tier_info.display_name,
            'monthly_credits': float(tier_info.monthly_credits) * CREDITS_PER_DOLLAR,
            'can_purchase_credits': tier_info.can_purchase_credits
        }
    }


MINIMAL_ACCOUNT_STATE_CACHE_TTL = 60  # 1 minute cache for minimal state


@router.get("/account-state/minimal")
async def get_minimal_account_state(
    account_id: str = Depends(verify_and_get_user_id_from_jwt),
    skip_cache: bool = False
) -> Dict:
    """
    Get minimal account state - fast endpoint for dashboard.

    Only returns essential data:
    - credits (total, can_run, daily_refresh)
    - subscription (tier_key, tier_display_name, status)
    - tier (name, display_name)

    Use /account-state for full data including limits, models, scheduled changes.
    """
    if config.ENV_MODE == EnvMode.LOCAL:
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
                'is_trial': False,
                'trial_status': None
            },
            'tier': {
                'name': 'tier_25_200',
                'display_name': 'Local Development'
            },
            '_cache': {'cached': False, 'ttl_seconds': MINIMAL_ACCOUNT_STATE_CACHE_TTL}
        }

    cache_key = f"account_state_minimal:{account_id}"

    if not skip_cache:
        try:
            cached_data = await Cache.get(cache_key)
            if cached_data:
                cached_data['_cache'] = {'cached': True, 'ttl_seconds': MINIMAL_ACCOUNT_STATE_CACHE_TTL}
                return cached_data
        except Exception:
            pass

    try:
        # Fire-and-forget daily credits refresh
        asyncio.create_task(_refresh_daily_credits_background(account_id))

        account_state = await _build_minimal_account_state(account_id)

        try:
            await Cache.set(cache_key, account_state, ttl=MINIMAL_ACCOUNT_STATE_CACHE_TTL)
        except Exception:
            pass

        account_state['_cache'] = {'cached': False, 'ttl_seconds': MINIMAL_ACCOUNT_STATE_CACHE_TTL}
        return account_state

    except Exception as e:
        logger.error(f"[ACCOUNT_STATE_MINIMAL] Error for {account_id}: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")


@router.get("/account-state")
async def get_account_state(
    account_id: str = Depends(verify_and_get_user_id_from_jwt),
    skip_cache: bool = False
) -> Dict:
    """
    Get full account state including credits, subscription, models, and limits.

    This is the complete data for settings/billing pages.
    For dashboard, use /account-state/minimal for faster response.
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
            # Fire-and-forget: refresh daily credits in background
            # Don't block account-state on this - it has a 5s lock timeout
            asyncio.create_task(_refresh_daily_credits_background(account_id))

            # Build fresh data (no client needed - uses repo)
            account_state = await _build_account_state(account_id, skip_cache=skip_cache)
            
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
            raise HTTPException(status_code=500, detail="Internal server error")
    
    # Should not reach here, but just in case
    logger.error(f"[ACCOUNT_STATE] Unexpected exit from retry loop for {account_id}: {last_error}")
    raise HTTPException(status_code=503, detail="Service temporarily unavailable. Please try again.")
