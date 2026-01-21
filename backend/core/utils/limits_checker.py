from typing import Dict, Any, Optional
from datetime import datetime, timezone, timedelta
from core.utils.logger import logger
from core.utils.config import config
from core.utils.cache import Cache
from core.utils import limits_repo


def _get_free_tier_defaults() -> Dict[str, Any]:
    try:
        from core.billing.shared.config import TIERS
        free_tier = TIERS.get('free')
        if free_tier:
            return {
                'name': 'free',
                'concurrent_runs': free_tier.concurrent_runs,
                'thread_limit': free_tier.thread_limit,
                'project_limit': free_tier.project_limit,
                'custom_workers_limit': free_tier.custom_workers_limit,
                'scheduled_triggers_limit': free_tier.scheduled_triggers_limit,
                'app_triggers_limit': free_tier.app_triggers_limit,
            }
    except Exception:
        pass

    return {
        'name': 'free',
        'concurrent_runs': 1,
        'thread_limit': 10,
        'project_limit': 20,
        'custom_workers_limit': 0,
        'scheduled_triggers_limit': 0,
        'app_triggers_limit': 0,
    }


async def _get_tier_info_if_needed(account_id: str, tier_info: Optional[Dict] = None) -> Dict:
    if tier_info is not None:
        return tier_info
    
    try:
        from core.agents.pipeline.slot_manager import get_tier_limits
        limits = await get_tier_limits(account_id)
        defaults = _get_free_tier_defaults()
        return {
            'name': limits.get('name', 'free'),
            'concurrent_runs': limits.get('concurrent_runs', defaults['concurrent_runs']),
            'thread_limit': limits.get('thread_limit', defaults['thread_limit']),
            'project_limit': limits.get('project_limit', defaults['project_limit']),
            'custom_workers_limit': limits.get('custom_workers_limit', defaults['custom_workers_limit']),
            'scheduled_triggers_limit': limits.get('scheduled_triggers_limit', defaults['scheduled_triggers_limit']),
            'app_triggers_limit': limits.get('app_triggers_limit', defaults['app_triggers_limit']),
        }
    except Exception as e:
        logger.warning(f"Could not get tier for {account_id}: {e}, using defaults")
        return _get_free_tier_defaults()


async def check_agent_run_limit(account_id: str, tier_info: Optional[Dict] = None, client=None) -> Dict[str, Any]:
    try:
        from core.agents.pipeline.slot_manager import get_count, get_tier_limits
        
        tier = await get_tier_limits(account_id)
        concurrent_runs_limit = tier.get('concurrent_runs', 1)
        tier_name = tier.get('name', 'free')
        
        running_count = await get_count(account_id)
        
        return {
            'can_start': running_count < concurrent_runs_limit,
            'running_count': running_count,
            'running_thread_ids': [],
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
    try:
        if config.ENV_MODE.value == "local":
            return {
                'can_create': True,
                'current_count': 0,
                'limit': 999999,
                'tier_name': 'local'
            }
        
        tier = await _get_tier_info_if_needed(account_id, tier_info)
        tier_name = tier.get('name', 'free')
        agent_limit = tier.get('custom_workers_limit', 1)
        
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
    try:
        from core.agents.pipeline.slot_manager import check_project_limit as sm_check_project_limit
        
        result = await sm_check_project_limit(account_id)
        tier = await _get_tier_info_if_needed(account_id, tier_info)
        
        return {
            'can_create': result.allowed,
            'current_count': result.current_count,
            'limit': result.limit,
            'tier_name': tier.get('name', 'free')
        }
        
    except Exception as e:
        logger.error(f"Error checking project count limit for {account_id}: {e}")
        return {
            'can_create': True,
            'current_count': 0,
            'limit': 2,
            'tier_name': 'free'
        }


async def check_trigger_limit(
    account_id: str, 
    agent_id: str = None, 
    trigger_type: str = None, 
    tier_info: Optional[Dict] = None,
    client=None
) -> Dict[str, Any]:
    try:
        tier = await _get_tier_info_if_needed(account_id, tier_info)
        tier_name = tier.get('name', 'free')
        scheduled_limit = tier.get('scheduled_triggers_limit', 1)
        app_limit = tier.get('app_triggers_limit', 2)
        
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
    try:
        tier = await _get_tier_info_if_needed(account_id, tier_info)
        tier_name = tier.get('name', 'free')
        worker_limit = tier.get('custom_workers_limit', 0)
        
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
    try:
        from core.agents.pipeline.slot_manager import check_thread_limit as sm_check_thread_limit
        
        result = await sm_check_thread_limit(account_id)
        tier = await _get_tier_info_if_needed(account_id, tier_info)
        
        return {
            'can_create': result.allowed,
            'current_count': result.current_count,
            'limit': result.limit,
            'tier_name': tier.get('name', 'free')
        }
        
    except Exception as e:
        logger.error(f"Error checking thread limit for {account_id}: {e}")
        return {
            'can_create': True,
            'current_count': 0,
            'limit': 2,
            'tier_name': 'free'
        }


async def get_all_limits_fast(account_id: str, tier_info: Dict) -> Dict[str, Any]:
    import time
    t_start = time.time()
    
    tier_name = tier_info.get('name', 'free')
    
    thread_limit = tier_info.get('thread_limit', 2)
    project_limit = tier_info.get('project_limit', 2)
    agent_limit = tier_info.get('custom_workers_limit', 0)
    concurrent_limit = tier_info.get('concurrent_runs', 1)
    custom_mcp_limit = tier_info.get('custom_workers_limit', 0)
    scheduled_trigger_limit = tier_info.get('scheduled_triggers_limit', 0)
    app_trigger_limit = tier_info.get('app_triggers_limit', 0)
    
    counts = await limits_repo.get_all_limits_counts(account_id)
    
    trigger_counts = await limits_repo.count_all_triggers_for_account(account_id)
    
    logger.info(f"[LIMITS] {account_id[:8]}... threads={counts['thread_count']}/{thread_limit} projects={counts['project_count']}/{project_limit} can_create_thread={counts['thread_count'] < thread_limit}")
    
    try:
        from core.agents.pipeline.slot_manager import warm_all_caches
        await warm_all_caches(
            account_id,
            thread_count=counts['thread_count'],
            project_count=counts['project_count']
        )
    except Exception:
        pass
    
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
