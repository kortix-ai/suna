"""
Unified Account State Endpoint

This endpoint combines all billing-related data into a single, cached response:
- Credit balance (daily, monthly, extra)
- Subscription info (tier, status, billing period)
- Available models
- Limits (projects, threads, concurrent runs)
- Scheduled changes
- Commitment info

All data is cached in Redis for 5 minutes, invalidated on:
- Credit transactions
- Subscription changes
- Tier changes
"""
from fastapi import APIRouter, HTTPException, Depends
from typing import Dict, Optional
from decimal import Decimal
from datetime import datetime, timezone, timedelta
from core.services.supabase import DBConnection
from core.utils.auth_utils import verify_and_get_user_id_from_jwt
from core.utils.config import config, EnvMode
from core.utils.logger import logger
from core.utils.cache import Cache
from core.ai_models import model_manager
from core.credits import credit_service
from ..shared.config import (
    CREDITS_PER_DOLLAR,
    get_tier_by_name,
    is_model_allowed,
    get_tier_limits,
    get_price_type,
    TIERS
)
from ..subscriptions import subscription_service

router = APIRouter(tags=["billing-account-state"])

# Import from shared module to avoid circular imports
from ..shared.cache_utils import ACCOUNT_STATE_CACHE_TTL, invalidate_account_state_cache


async def _build_account_state(account_id: str, client) -> Dict:
    """Build the complete account state response."""
    
    # Get credit account data - use select('*') to get all available columns
    credit_account_result = await client.from_('credit_accounts').select('*').eq('account_id', account_id).execute()
    
    # Fallback to user_id if account_id not found
    if not credit_account_result.data:
        credit_account_result = await client.from_('credit_accounts').select('*').eq('user_id', account_id).execute()
    
    credit_account = credit_account_result.data[0] if credit_account_result.data else {}
    
    # Extract tier info
    tier_name = credit_account.get('tier', 'none')
    tier_info = get_tier_by_name(tier_name)
    if not tier_info:
        tier_info = TIERS['none']
    
    # Trial status
    trial_status = credit_account.get('trial_status')
    trial_ends_at = credit_account.get('trial_ends_at')
    is_trial = trial_status == 'active'
    
    # Balance calculations (stored in dollars, convert to credits)
    balance_dollars = float(credit_account.get('balance', 0) or 0)
    daily_dollars = float(credit_account.get('daily_credits_balance', 0) or 0)
    monthly_dollars = float(credit_account.get('expiring_credits', 0) or 0)
    extra_dollars = float(credit_account.get('non_expiring_credits', 0) or 0)
    last_daily_refresh = credit_account.get('last_daily_refresh')
    
    # Convert to credits
    daily_credits = daily_dollars * CREDITS_PER_DOLLAR
    monthly_credits = monthly_dollars * CREDITS_PER_DOLLAR
    extra_credits = extra_dollars * CREDITS_PER_DOLLAR
    # Total = sum of all credit types (daily + monthly + extra)
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
    
    # Get subscription info
    subscription_data = None
    billing_period = credit_account.get('plan_type')
    provider = credit_account.get('provider', 'stripe')
    
    stripe_subscription_id = credit_account.get('stripe_subscription_id')
    if stripe_subscription_id and provider == 'stripe':
        try:
            import stripe
            stripe.api_key = config.STRIPE_SECRET_KEY
            subscription_data = stripe.Subscription.retrieve(stripe_subscription_id)
            
            # Get billing period from subscription if not in credit_account
            if not billing_period and subscription_data:
                items_data = subscription_data.get('items', {}).get('data', [])
                if items_data:
                    price_id = items_data[0].get('price', {}).get('id')
                    if price_id:
                        billing_period = get_price_type(price_id)
        except Exception as e:
            logger.warning(f"[ACCOUNT_STATE] Failed to retrieve Stripe subscription: {e}")
    
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
    
    # Get scheduled changes
    try:
        scheduled_changes = await subscription_service.get_scheduled_changes(account_id)
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
            'provider': model['provider'],
            'allowed': allowed,
            'context_window': model.get('context_window', 128000),
            'capabilities': model.get('capabilities', []),
            'priority': model.get('priority', 0),
            'recommended': model.get('recommended', False)
        })
    
    # Get tier limits with detailed usage info
    from core.utils.limits_checker import (
        check_thread_limit,
        check_agent_run_limit,
        check_agent_count_limit,
        check_project_count_limit,
        check_trigger_limit,
        check_custom_mcp_limit
    )
    
    # Fetch all detailed limits in parallel
    import asyncio
    thread_limit, concurrent_runs_limit, agent_count_limit, project_count_limit, trigger_limit, custom_mcp_limit = await asyncio.gather(
        check_thread_limit(client, account_id),
        check_agent_run_limit(client, account_id),
        check_agent_count_limit(client, account_id),
        check_project_count_limit(client, account_id),
        check_trigger_limit(client, account_id),
        check_custom_mcp_limit(client, account_id)
    )
    
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
                    'provider': model['provider'],
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
    
    try:
        # Check cache first (unless skip_cache is True)
        cache_key = f"account_state:{account_id}"
        if not skip_cache:
            cached_data = await Cache.get(cache_key)
            if cached_data:
                cached_data['_cache'] = {
                    'cached': True,
                    'ttl_seconds': ACCOUNT_STATE_CACHE_TTL
                }
                return cached_data
        
        # Ensure daily credits are refreshed if needed
        await credit_service.check_and_refresh_daily_credits(account_id)
        
        # Build fresh data
        db = DBConnection()
        client = await db.client
        
        account_state = await _build_account_state(account_id, client)
        
        # Cache the result
        await Cache.set(cache_key, account_state, ttl=ACCOUNT_STATE_CACHE_TTL)
        
        account_state['_cache'] = {
            'cached': False,
            'ttl_seconds': ACCOUNT_STATE_CACHE_TTL
        }
        
        return account_state
        
    except Exception as e:
        logger.error(f"[ACCOUNT_STATE] Error getting account state for {account_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))

