"""
Limits checker module - checks various account limits.

PERFORMANCE OPTIMIZATION:
- All functions accept optional `tier_info` parameter to avoid N+1 queries
- When called from account_state, tier_info is fetched ONCE and passed to all checkers
- When called standalone, tier_info is fetched (with caching) if not provided
"""
from typing import Dict, Any, Optional
from datetime import datetime, timezone, timedelta
from core.utils.logger import logger
from core.utils.config import config
from core.utils.cache import Cache
from core.utils import limits_repo


async def _get_tier_info_if_needed(account_id: str, tier_info: Optional[Dict] = None) -> Dict:
    """
    Get tier info from cache/DB only if not already provided.
    This avoids N+1 queries when called from account_state.
    """
    if tier_info is not None:
        return tier_info
    
    try:
        from core.cache.runtime_cache import get_cached_tier_info, set_cached_tier_info
        cached_tier = await get_cached_tier_info(account_id)
        if cached_tier:
            logger.debug(f"⚡ Tier from cache: {cached_tier.get('name')}")
            return cached_tier
        
        from core.billing import subscription_service
        fresh_tier = await subscription_service.get_user_subscription_tier(account_id, skip_cache=False)
        await set_cached_tier_info(account_id, fresh_tier)
        return fresh_tier
    except Exception as e:
        logger.warning(f"Could not get tier for {account_id}: {e}, using defaults")
        return {
            'name': 'free',
            'concurrent_runs': config.MAX_PARALLEL_AGENT_RUNS,
            'thread_limit': 10,
            'project_limit': 3,
            'custom_workers_limit': 0,
            'scheduled_triggers_limit': 1,
            'app_triggers_limit': 2,
        }


async def check_agent_run_limit(account_id: str, tier_info: Optional[Dict] = None, client=None) -> Dict[str, Any]:
    """
    Check concurrent agent run limits.
    
    Args:
        account_id: User's account ID
        tier_info: Optional pre-fetched tier info (avoids DB query if provided)
        client: Deprecated, unused
    """
    try:
        import time
        import asyncio
        t_start = time.time()
        
        from core.cache.runtime_cache import get_cached_running_runs, set_cached_running_runs
        
        # Get tier info (use provided or fetch)
        tier = await _get_tier_info_if_needed(account_id, tier_info)
        concurrent_runs_limit = tier.get('concurrent_runs', 1)
        tier_name = tier.get('name', 'free')
        
        # Check cache for running runs
        cached_runs = await get_cached_running_runs(account_id)
        if cached_runs:
            running_count = cached_runs['running_count']
            running_thread_ids = cached_runs['running_thread_ids']
            logger.debug(f"⚡ Running runs from cache: {running_count} in {(time.time() - t_start) * 1000:.1f}ms")
            
            return {
                'can_start': running_count < concurrent_runs_limit,
                'running_count': running_count,
                'running_thread_ids': running_thread_ids,
                'limit': concurrent_runs_limit,
                'tier_name': tier_name
            }
        
        # Fetch from DB
        result = await limits_repo.count_running_agent_runs(account_id)
        running_count = result["running_count"]
        running_thread_ids = result["running_thread_ids"]
        
        # Cache result
        await set_cached_running_runs(account_id, running_count, running_thread_ids)
        
        logger.debug(f"Account {account_id} has {running_count}/{concurrent_runs_limit} running runs ({(time.time() - t_start) * 1000:.1f}ms)")
        
        return {
            'can_start': running_count < concurrent_runs_limit,
            'running_count': running_count,
            'running_thread_ids': running_thread_ids,
            'limit': concurrent_runs_limit,
            'tier_name': tier_name
        }

    except Exception as e:
        logger.error(f"Error checking agent run limit for {account_id}: {e}")
        return {
            'can_start': True,
            'running_count': 0,
            'running_thread_ids': [],
            'limit': 1,
            'tier_name': 'free'
        }


async def check_agent_count_limit(account_id: str, tier_info: Optional[Dict] = None, client=None) -> Dict[str, Any]:
    """
    Check custom agent/worker count limits.
    
    Args:
        account_id: User's account ID
        tier_info: Optional pre-fetched tier info (avoids DB query if provided)
        client: Deprecated, unused
    """
    try:
        if config.ENV_MODE.value == "local":
            return {
                'can_create': True,
                'current_count': 0,
                'limit': 999999,
                'tier_name': 'local'
            }
        
        # Get tier info (use provided or fetch)
        tier = await _get_tier_info_if_needed(account_id, tier_info)
        tier_name = tier.get('name', 'free')
        agent_limit = tier.get('custom_workers_limit', 1)
        
        # Get current count
        current_count = await limits_repo.count_user_agents(account_id)
        can_create = current_count < agent_limit
        
        logger.debug(f"Account {account_id} has {current_count}/{agent_limit} agents (tier: {tier_name})")
        
        return {
            'can_create': can_create,
            'current_count': current_count,
            'limit': agent_limit,
            'tier_name': tier_name
        }
        
    except Exception as e:
        logger.error(f"Error checking agent count limit for {account_id}: {e}")
        return {
            'can_create': True,
            'current_count': 0,
            'limit': 1,
            'tier_name': 'free'
        }


async def check_project_count_limit(account_id: str, tier_info: Optional[Dict] = None, client=None) -> Dict[str, Any]:
    """
    Check project count limits.
    
    Args:
        account_id: User's account ID
        tier_info: Optional pre-fetched tier info (avoids DB query if provided)
        client: Deprecated, unused
    """
    try:
        if config.ENV_MODE.value == "local":
            return {
                'can_create': True,
                'current_count': 0,
                'limit': 999999,
                'tier_name': 'local'
            }
        
        # Check local cache first
        cache_key = f"project_count_limit:{account_id}"
        try:
            cached = await Cache.get(cache_key)
            if cached:
                logger.debug(f"Cache hit for project count limit: {account_id}")
                return cached
        except Exception:
            pass
        
        # Get tier info (use provided or fetch)
        tier = await _get_tier_info_if_needed(account_id, tier_info)
        tier_name = tier.get('name', 'free')
        project_limit = tier.get('project_limit', 3)
        
        # Get current count
        current_count = await limits_repo.count_user_projects(account_id)
        can_create = current_count < project_limit
        
        result = {
            'can_create': can_create,
            'current_count': current_count,
            'limit': project_limit,
            'tier_name': tier_name
        }
        
        # Cache result
        try:
            await Cache.set(cache_key, result, ttl=60)
        except Exception:
            pass
        
        logger.debug(f"Account {account_id} has {current_count}/{project_limit} projects (tier: {tier_name})")
        return result
        
    except Exception as e:
        logger.error(f"Error checking project count limit for {account_id}: {e}")
        return {
            'can_create': True,
            'current_count': 0,
            'limit': 3,
            'tier_name': 'free'
        }


async def check_trigger_limit(
    account_id: str, 
    agent_id: str = None, 
    trigger_type: str = None, 
    tier_info: Optional[Dict] = None,
    client=None
) -> Dict[str, Any]:
    """
    Check trigger limits (scheduled and app triggers).
    
    Args:
        account_id: User's account ID
        agent_id: Optional agent ID for agent-specific check
        trigger_type: Optional trigger type ('scheduled' or 'app')
        tier_info: Optional pre-fetched tier info (avoids DB query if provided)
        client: Deprecated, unused
    """
    try:
        # Get tier info (use provided or fetch)
        tier = await _get_tier_info_if_needed(account_id, tier_info)
        tier_name = tier.get('name', 'free')
        scheduled_limit = tier.get('scheduled_triggers_limit', 1)
        app_limit = tier.get('app_triggers_limit', 2)
        
        # Aggregate check (no specific agent/type)
        if agent_id is None or trigger_type is None:
            trigger_counts = await limits_repo.count_all_triggers_for_account(account_id)
            scheduled_count = trigger_counts.get("scheduled", 0)
            app_count = trigger_counts.get("app", 0)
            
            return {
                'scheduled': {
                    'current_count': scheduled_count,
                    'limit': scheduled_limit,
                    'can_create': scheduled_count < scheduled_limit
                },
                'app': {
                    'current_count': app_count,
                    'limit': app_limit,
                    'can_create': app_count < app_limit
                },
                'tier_name': tier_name
            }
        
        # Agent-specific check
        agent_exists = await limits_repo.check_agent_exists(agent_id, account_id)
        if not agent_exists:
            return {
                'can_create': False,
                'current_count': 0,
                'limit': 0,
                'tier_name': tier_name,
                'error': 'Worker not found or access denied'
            }
        
        trigger_counts = await limits_repo.count_agent_triggers(agent_id)
        scheduled_count = trigger_counts["scheduled"]
        app_count = trigger_counts["app"]
        
        if trigger_type == 'scheduled':
            can_create = scheduled_count < scheduled_limit
            current_count = scheduled_count
            limit = scheduled_limit
        else:
            can_create = app_count < app_limit
            current_count = app_count
            limit = app_limit
        
        return {
            'can_create': can_create,
            'current_count': current_count,
            'limit': limit,
            'tier_name': tier_name
        }
        
    except Exception as e:
        logger.error(f"Error checking trigger limit for {account_id}: {e}")
        return {
            'scheduled': {'current_count': 0, 'limit': 1, 'can_create': True},
            'app': {'current_count': 0, 'limit': 2, 'can_create': True},
            'tier_name': 'free'
        }


async def check_custom_mcp_limit(account_id: str, tier_info: Optional[Dict] = None, client=None) -> Dict[str, Any]:
    """
    Check custom MCP/worker limits.
    
    Args:
        account_id: User's account ID
        tier_info: Optional pre-fetched tier info (avoids DB query if provided)
        client: Deprecated, unused
    """
    try:
        # Get tier info (use provided or fetch)
        tier = await _get_tier_info_if_needed(account_id, tier_info)
        tier_name = tier.get('name', 'free')
        worker_limit = tier.get('custom_workers_limit', 0)
        
        # Get current count
        total_custom_mcps = await limits_repo.count_custom_mcps_for_account(account_id)
        can_create = total_custom_mcps < worker_limit
        
        logger.debug(f"Account {account_id} has {total_custom_mcps}/{worker_limit} custom MCPs (tier: {tier_name})")
        
        return {
            'can_create': can_create,
            'current_count': total_custom_mcps,
            'limit': worker_limit,
            'tier_name': tier_name
        }
        
    except Exception as e:
        logger.error(f"Error checking custom MCP limit for {account_id}: {e}")
        return {
            'can_create': True,
            'current_count': 0,
            'limit': 0,
            'tier_name': 'free'
        }


async def check_thread_limit(account_id: str, tier_info: Optional[Dict] = None, client=None) -> Dict[str, Any]:
    """
    Check thread count limits.
    
    Args:
        account_id: User's account ID
        tier_info: Optional pre-fetched tier info (avoids DB query if provided)
        client: Deprecated, unused
    """
    try:
        import time
        t_start = time.time()
        
        from core.cache.runtime_cache import get_cached_thread_count, set_cached_thread_count
        
        # Get tier info (use provided or fetch)
        tier = await _get_tier_info_if_needed(account_id, tier_info)
        tier_name = tier.get('name', 'free')
        thread_limit = tier.get('thread_limit', 10)
        
        # Check cache for thread count
        cached_count = await get_cached_thread_count(account_id)
        if cached_count is not None:
            logger.debug(f"⚡ Thread count from cache: {cached_count} in {(time.time() - t_start) * 1000:.1f}ms")
            return {
                'can_create': cached_count < thread_limit,
                'current_count': cached_count,
                'limit': thread_limit,
                'tier_name': tier_name
            }
        
        # Fetch from DB
        current_count = await limits_repo.count_user_threads(account_id)
        
        # Cache result
        await set_cached_thread_count(account_id, current_count)
        
        logger.debug(f"Account {account_id} has {current_count}/{thread_limit} threads ({(time.time() - t_start) * 1000:.1f}ms)")
        
        return {
            'can_create': current_count < thread_limit,
            'current_count': current_count,
            'limit': thread_limit,
            'tier_name': tier_name
        }
        
    except Exception as e:
        logger.error(f"Error checking thread limit for {account_id}: {e}")
        return {
            'can_create': True,
            'current_count': 0,
            'limit': 10,
            'tier_name': 'free'
        }


async def get_all_limits_fast(account_id: str, tier_info: Dict) -> Dict[str, Any]:
    """
    Get ALL limits in a single DB query + tier lookup.
    
    This reduces 6+ separate DB round-trips to just 1, significantly improving
    latency for the account-state endpoint (used heavily by mobile app).
    
    Args:
        account_id: User's account ID
        tier_info: Pre-fetched tier info (required - caller should fetch once)
        
    Returns:
        Dict with all limit info: threads, projects, agents, running_runs, custom_mcps, triggers
    """
    import time
    t_start = time.time()
    
    tier_name = tier_info.get('name', 'free')
    
    # Get tier limits
    thread_limit = tier_info.get('thread_limit', 10)
    project_limit = tier_info.get('project_limit', 3)
    agent_limit = tier_info.get('custom_workers_limit', 1)
    concurrent_limit = tier_info.get('concurrent_runs', 1)
    custom_mcp_limit = tier_info.get('custom_workers_limit', 0)
    scheduled_trigger_limit = tier_info.get('scheduled_triggers_limit', 1)
    app_trigger_limit = tier_info.get('app_triggers_limit', 2)
    
    # Single query for all counts
    counts = await limits_repo.get_all_limits_counts(account_id)
    
    # Get trigger counts separately (already optimized with GROUP BY)
    trigger_counts = await limits_repo.count_all_triggers_for_account(account_id)
    
    logger.debug(f"⚡ All limits fetched in {(time.time() - t_start) * 1000:.1f}ms (single query)")
    
    return {
        'threads': {
            'current_count': counts['thread_count'],
            'limit': thread_limit,
            'can_create': counts['thread_count'] < thread_limit,
            'tier_name': tier_name
        },
        'projects': {
            'current_count': counts['project_count'],
            'limit': project_limit,
            'can_create': counts['project_count'] < project_limit,
            'tier_name': tier_name
        },
        'agents': {
            'current_count': counts['agent_count'],
            'limit': agent_limit,
            'can_create': counts['agent_count'] < agent_limit,
            'tier_name': tier_name
        },
        'concurrent_runs': {
            'running_count': counts['running_runs_count'],
            'limit': concurrent_limit,
            'can_start': counts['running_runs_count'] < concurrent_limit,
            'tier_name': tier_name
        },
        'custom_mcps': {
            'current_count': counts['custom_mcp_count'],
            'limit': custom_mcp_limit,
            'can_create': counts['custom_mcp_count'] < custom_mcp_limit,
            'tier_name': tier_name
        },
        'triggers': {
            'scheduled': {
                'current_count': trigger_counts.get('scheduled', 0),
                'limit': scheduled_trigger_limit,
                'can_create': trigger_counts.get('scheduled', 0) < scheduled_trigger_limit
            },
            'app': {
                'current_count': trigger_counts.get('app', 0),
                'limit': app_trigger_limit,
                'can_create': trigger_counts.get('app', 0) < app_trigger_limit
            },
            'tier_name': tier_name
        }
    }
