from typing import Dict, Any, Optional
from datetime import datetime, timezone, timedelta
from core.utils.logger import logger
from core.utils.config import config
from core.utils.cache import Cache
from core.utils import limits_repo


async def check_agent_run_limit(account_id: str, client=None) -> Dict[str, Any]:
    try:
        import time
        import asyncio
        t_start = time.time()
        
        twenty_four_hours_ago = datetime.now(timezone.utc) - timedelta(hours=24)
        twenty_four_hours_ago_iso = twenty_four_hours_ago.isoformat()
        
        logger.debug(f"Checking agent run limit for account {account_id} since {twenty_four_hours_ago_iso}")

        from core.cache.runtime_cache import get_cached_running_runs, set_cached_running_runs
        cached_runs = await get_cached_running_runs(account_id)
        
        if cached_runs:
            try:
                from core.billing import subscription_service
                tier_info = await subscription_service.get_user_subscription_tier(account_id, skip_cache=False)
                concurrent_runs_limit = tier_info.get('concurrent_runs', 1)
            except Exception:
                concurrent_runs_limit = config.MAX_PARALLEL_AGENT_RUNS
            
            running_count = cached_runs['running_count']
            running_thread_ids = cached_runs['running_thread_ids']
            
            query_time = (time.time() - t_start) * 1000
            logger.debug(f"⚡ Running runs from cache: {running_count} runs in {query_time:.1f}ms")
            
            return {
                'can_start': running_count < concurrent_runs_limit,
                'running_count': running_count,
                'running_thread_ids': running_thread_ids,
                'limit': concurrent_runs_limit
            }
        
        async def get_tier_info():
            try:
                from core.cache.runtime_cache import get_cached_tier_info, set_cached_tier_info
                cached_tier = await get_cached_tier_info(account_id)
                if cached_tier:
                    concurrent_runs_limit = cached_tier.get('concurrent_runs', 1)
                    logger.debug(f"⚡ Tier from cache: {cached_tier.get('name')}, limit: {concurrent_runs_limit}")
                    return concurrent_runs_limit
                
                from core.billing import subscription_service
                tier_info = await subscription_service.get_user_subscription_tier(account_id, skip_cache=False)
                tier_name = tier_info['name']
                concurrent_runs_limit = tier_info.get('concurrent_runs', 1)
                
                await set_cached_tier_info(account_id, tier_info)
                
                logger.debug(f"Account {account_id} tier: {tier_name}, concurrent runs limit: {concurrent_runs_limit}")
                return concurrent_runs_limit
            except Exception as billing_error:
                logger.warning(f"Could not get subscription tier for {account_id}: {str(billing_error)}, using global default")
                return config.MAX_PARALLEL_AGENT_RUNS
        
        async def get_running_runs():
            result = await limits_repo.count_running_agent_runs(account_id)
            return result["running_count"], result["running_thread_ids"]
        
        try:
            concurrent_runs_limit, (running_count, running_thread_ids) = await asyncio.gather(
                get_tier_info(),
                get_running_runs()
            )
            
            await set_cached_running_runs(account_id, running_count, running_thread_ids)
            
            query_time = (time.time() - t_start) * 1000
            logger.debug(f"⚡ Optimized query: Found {running_count} running runs in {query_time:.1f}ms (parallel tier + join query)")
        except Exception as join_error:
            logger.warning(f"Join query failed, falling back to batch method: {str(join_error)}")
            
            try:
                from core.billing import subscription_service
                tier_info = await subscription_service.get_user_subscription_tier(account_id, skip_cache=False)
                concurrent_runs_limit = tier_info.get('concurrent_runs', 1)
            except Exception:
                concurrent_runs_limit = config.MAX_PARALLEL_AGENT_RUNS
            
            thread_count = await limits_repo.count_user_threads(account_id)
            
            if thread_count == 0:
                logger.debug(f"No threads found for account {account_id}")
                return {
                    'can_start': True,
                    'running_count': 0,
                    'running_thread_ids': [],
                    'limit': concurrent_runs_limit
                }
            
            result = await limits_repo.count_running_agent_runs(account_id)
            running_count = result["running_count"]
            running_thread_ids = result["running_thread_ids"]
        
        logger.debug(f"Account {account_id} has {running_count}/{concurrent_runs_limit} running agent runs")
        
        result = {
            'can_start': running_count < concurrent_runs_limit,
            'running_count': running_count,
            'running_thread_ids': running_thread_ids,
            'limit': concurrent_runs_limit
        }
        return result

    except Exception as e:
        logger.error(f"Error checking agent run limit for account {account_id}: {str(e)}")
        return {
            'can_start': True,
            'running_count': 0,
            'running_thread_ids': [],
            'limit': 1
        }


async def check_agent_count_limit(account_id: str, client=None) -> Dict[str, Any]:
    try:
        if config.ENV_MODE.value == "local":
            return {
                'can_create': True,
                'current_count': 0,
                'limit': 999999,
                'tier_name': 'local'
            }
        
        current_count = await limits_repo.count_user_agents(account_id)
        logger.debug(f"Account {account_id} has {current_count} custom agents (excluding Suna defaults)")
        
        try:
            from core.billing import subscription_service
            tier_info = await subscription_service.get_user_subscription_tier(account_id, skip_cache=True)
            tier_name = tier_info['name']
            agent_limit = tier_info.get('custom_workers_limit', 1)
            logger.debug(f"Account {account_id} subscription tier: {tier_name}, agent/worker limit: {agent_limit} (fresh from DB)")
        except Exception as billing_error:
            logger.warning(f"Could not get subscription tier for {account_id}: {str(billing_error)}, defaulting to free")
            tier_name = 'free'
            agent_limit = 1
        
        can_create = current_count < agent_limit
        
        result = {
            'can_create': can_create,
            'current_count': current_count,
            'limit': agent_limit,
            'tier_name': tier_name
        }
        
        logger.debug(f"Account {account_id} has {current_count}/{agent_limit} agents (tier: {tier_name}) - can_create: {can_create}")
        
        return result
        
    except Exception as e:
        logger.error(f"Error checking agent count limit for account {account_id}: {str(e)}", exc_info=True)
        return {
            'can_create': True,
            'current_count': 0,
            'limit': 1,
            'tier_name': 'free'
        }


async def check_project_count_limit(account_id: str, client=None) -> Dict[str, Any]:
    try:
        if config.ENV_MODE.value == "local":
            return {
                'can_create': True,
                'current_count': 0,
                'limit': 999999,
                'tier_name': 'local'
            }
        
        try:
            result = await Cache.get(f"project_count_limit:{account_id}")
            if result:
                logger.debug(f"Cache hit for project count limit: {account_id}")
                return result
        except Exception as cache_error:
            logger.warning(f"Cache read failed for project count limit {account_id}: {str(cache_error)}")

        current_count = await limits_repo.count_user_projects(account_id)
        logger.debug(f"Account {account_id} has {current_count} projects (real-time count)")
        
        try:
            from core.billing import subscription_service
            tier_info = await subscription_service.get_user_subscription_tier(account_id)
            tier_name = tier_info['name']
            logger.debug(f"Account {account_id} tier: {tier_name}")
        except Exception as billing_error:
            logger.warning(f"Failed to get subscription tier for {account_id}: {billing_error}")
            tier_name = 'free'
        
        from core.billing.shared.config import get_project_limit
        project_limit = get_project_limit(tier_name)
        can_create = current_count < project_limit
        
        result = {
            'can_create': can_create,
            'current_count': current_count,
            'limit': project_limit,
            'tier_name': tier_name
        }
        
        logger.debug(f"Account {account_id} has {current_count}/{project_limit} projects (tier: {tier_name}) - can_create: {can_create}")
        
        try:
            await Cache.set(f"project_count_limit:{account_id}", result, ttl=60)
        except Exception as cache_error:
            logger.warning(f"Cache write failed for project count limit {account_id}: {str(cache_error)}")
        
        return result
        
    except Exception as e:
        logger.error(f"Error checking project count limit for account {account_id}: {str(e)}", exc_info=True)
        from core.billing.shared.config import get_project_limit
        return {
            'can_create': True,
            'current_count': 0,
            'limit': get_project_limit('free'),
            'tier_name': 'free'
        }


async def check_trigger_limit(account_id: str, agent_id: str = None, trigger_type: str = None, client=None) -> Dict[str, Any]:
    try:
        if agent_id is None or trigger_type is None:
            logger.debug(f"Checking aggregate trigger limits for account {account_id}")
            
            trigger_counts = await limits_repo.count_all_triggers_for_account(account_id)
            scheduled_count = trigger_counts.get("scheduled", 0)
            app_count = trigger_counts.get("app", 0)
            
            try:
                from core.billing import subscription_service
                tier_info = await subscription_service.get_user_subscription_tier(account_id)
                tier_name = tier_info['name']
                scheduled_limit = tier_info.get('scheduled_triggers_limit', 1)
                app_limit = tier_info.get('app_triggers_limit', 2)
                logger.debug(f"Account {account_id} tier: {tier_name}, scheduled limit: {scheduled_limit}, app limit: {app_limit}")
            except Exception as billing_error:
                logger.warning(f"Could not get subscription tier for {account_id}: {str(billing_error)}, defaulting to free")
                tier_name = 'free'
                scheduled_limit = 1
                app_limit = 2
            
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
        
        logger.debug(f"Checking trigger limit for account {account_id}, agent {agent_id}, type {trigger_type}")
        
        agent_exists = await limits_repo.check_agent_exists(agent_id, account_id)
        
        if not agent_exists:
            logger.warning(f"Agent {agent_id} not found or access denied for account {account_id}")
            return {
                'can_create': False,
                'current_count': 0,
                'limit': 0,
                'tier_name': 'free',
                'error': 'Worker not found or access denied'
            }
        
        trigger_counts = await limits_repo.count_agent_triggers(agent_id)
        scheduled_count = trigger_counts["scheduled"]
        app_count = trigger_counts["app"]
        
        try:
            from core.billing import subscription_service
            tier_info = await subscription_service.get_user_subscription_tier(account_id, skip_cache=True)
            tier_name = tier_info['name']
            scheduled_limit = tier_info.get('scheduled_triggers_limit', 1)
            app_limit = tier_info.get('app_triggers_limit', 2)
            logger.debug(f"Account {account_id} tier: {tier_name}, scheduled limit: {scheduled_limit}, app limit: {app_limit} (fresh from DB)")
        except Exception as billing_error:
            logger.warning(f"Could not get subscription tier for {account_id}: {str(billing_error)}, defaulting to free")
            tier_name = 'free'
            scheduled_limit = 1
            app_limit = 2
        
        if trigger_type == 'scheduled':
            can_create = scheduled_count < scheduled_limit
            current_count = scheduled_count
            limit = scheduled_limit
        else:
            can_create = app_count < app_limit
            current_count = app_count
            limit = app_limit
        
        result = {
            'can_create': can_create,
            'current_count': current_count,
            'limit': limit,
            'tier_name': tier_name
        }
        
        logger.debug(f"Agent {agent_id} has {current_count}/{limit} {trigger_type} triggers (tier: {tier_name}) - can_create: {can_create}")
        
        return result
        
    except Exception as e:
        logger.error(f"Error checking trigger limit for account {account_id}: {str(e)}", exc_info=True)
        return {
            'can_create': True,
            'current_count': 0,
            'limit': 1,
            'tier_name': 'free'
        }


async def check_custom_mcp_limit(account_id: str, client=None) -> Dict[str, Any]:
    try:
        logger.debug(f"Checking custom worker limit for account {account_id}")
        
        total_custom_mcps = await limits_repo.count_custom_mcps_for_account(account_id)
        
        logger.debug(f"Account {account_id} has {total_custom_mcps} custom MCPs")
        
        try:
            from core.billing import subscription_service
            tier_info = await subscription_service.get_user_subscription_tier(account_id, skip_cache=True)
            tier_name = tier_info['name']
            worker_limit = tier_info.get('custom_workers_limit', 0)
            logger.debug(f"Account {account_id} tier: {tier_name}, custom workers limit: {worker_limit} (fresh from DB)")
        except Exception as billing_error:
            logger.warning(f"Could not get subscription tier for {account_id}: {str(billing_error)}, defaulting to free")
            tier_name = 'free'
            worker_limit = 0
        
        can_create = total_custom_mcps < worker_limit
        
        result = {
            'can_create': can_create,
            'current_count': total_custom_mcps,
            'limit': worker_limit,
            'tier_name': tier_name
        }
        
        logger.debug(f"Account {account_id} has {total_custom_mcps}/{worker_limit} custom workers (tier: {tier_name}) - can_create: {can_create}")
        
        return result
        
    except Exception as e:
        logger.error(f"Error checking custom worker limit for account {account_id}: {str(e)}", exc_info=True)
        return {
            'can_create': True,
            'current_count': 0,
            'limit': 0,
            'tier_name': 'free'
        }


async def check_thread_limit(account_id: str, client=None) -> Dict[str, Any]:
    try:
        import asyncio
        import time
        t_start = time.time()
        
        logger.debug(f"Checking thread limit for account {account_id}")
        
        from core.cache.runtime_cache import get_cached_thread_count, set_cached_thread_count
        cached_count = await get_cached_thread_count(account_id)
        
        if cached_count is not None:
            try:
                from core.billing import subscription_service
                tier_info = await subscription_service.get_user_subscription_tier(account_id, skip_cache=False)
                tier_name = tier_info['name']
                thread_limit = tier_info.get('thread_limit', 10)
            except Exception:
                tier_name = 'free'
                thread_limit = 10
            
            logger.debug(f"⚡ Thread count from cache: {cached_count} threads in {(time.time() - t_start) * 1000:.1f}ms")
            
            return {
                'can_create': cached_count < thread_limit,
                'current_count': cached_count,
                'limit': thread_limit,
                'tier_name': tier_name
            }
        
        async def get_thread_count():
            return await limits_repo.count_user_threads(account_id)
        
        async def get_tier_limit():
            try:
                from core.billing import subscription_service
                tier_info = await subscription_service.get_user_subscription_tier(account_id, skip_cache=False)
                return tier_info['name'], tier_info.get('thread_limit', 10)
            except Exception as billing_error:
                logger.warning(f"Could not get subscription tier for {account_id}: {str(billing_error)}, defaulting to free")
                return 'free', 10
        
        current_count, (tier_name, thread_limit) = await asyncio.gather(
            get_thread_count(),
            get_tier_limit()
        )
        
        await set_cached_thread_count(account_id, current_count)
        
        logger.debug(f"Account {account_id} has {current_count} threads")
        logger.debug(f"Account {account_id} tier: {tier_name}, thread limit: {thread_limit} (parallel query: {(time.time() - t_start) * 1000:.1f}ms)")
        
        can_create = current_count < thread_limit
        
        result = {
            'can_create': can_create,
            'current_count': current_count,
            'limit': thread_limit,
            'tier_name': tier_name
        }
        
        logger.debug(f"Account {account_id} has {current_count}/{thread_limit} threads (tier: {tier_name}) - can_create: {can_create}")
        
        return result
        
    except Exception as e:
        logger.error(f"Error checking thread limit for account {account_id}: {str(e)}", exc_info=True)
        return {
            'can_create': True,
            'current_count': 0,
            'limit': 10,
            'tier_name': 'free'
        }
