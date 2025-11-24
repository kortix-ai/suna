from typing import Dict, Any
from datetime import datetime, timezone, timedelta
from core.utils.logger import logger
from core.utils.config import config
from core.utils.cache import Cache


async def check_agent_run_limit(client, account_id: str) -> Dict[str, Any]:
    try:
        twenty_four_hours_ago = datetime.now(timezone.utc) - timedelta(hours=24)
        twenty_four_hours_ago_iso = twenty_four_hours_ago.isoformat()
        
        logger.debug(f"Checking agent run limit for account {account_id} since {twenty_four_hours_ago_iso}")
        
        try:
            from core.billing import subscription_service
            tier_info = await subscription_service.get_user_subscription_tier(account_id, skip_cache=True)
            tier_name = tier_info['name']
            concurrent_runs_limit = tier_info.get('concurrent_runs', 1)
            logger.debug(f"Account {account_id} tier: {tier_name}, concurrent runs limit: {concurrent_runs_limit} (fresh from DB)")
        except Exception as billing_error:
            logger.warning(f"Could not get subscription tier for {account_id}: {str(billing_error)}, using global default")
            concurrent_runs_limit = config.MAX_PARALLEL_AGENT_RUNS
        
        threads_result = await client.table('threads').select('thread_id').eq('account_id', account_id).execute()
        
        if not threads_result.data:
            logger.debug(f"No threads found for account {account_id}")
            return {
                'can_start': True,
                'running_count': 0,
                'running_thread_ids': [],
                'limit': concurrent_runs_limit
            }
        
        thread_ids = [thread['thread_id'] for thread in threads_result.data]
        logger.debug(f"Found {len(thread_ids)} threads for account {account_id}")
        
        from core.utils.query_utils import batch_query_in
        
        running_runs = await batch_query_in(
            client=client,
            table_name='agent_runs',
            select_fields='id, thread_id, started_at',
            in_field='thread_id',
            in_values=thread_ids,
            additional_filters={
                'status': 'running',
                'started_at_gte': twenty_four_hours_ago_iso
            }
        )
        
        running_count = len(running_runs)
        running_thread_ids = [run['thread_id'] for run in running_runs]
        
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


async def check_agent_count_limit(client, account_id: str) -> Dict[str, Any]:
    try:
        if config.ENV_MODE.value == "local":
            return {
                'can_create': True,
                'current_count': 0,
                'limit': 999999,
                'tier_name': 'local'
            }
        
        agents_result = await client.table('agents').select('agent_id, metadata').eq('account_id', account_id).execute()
        
        non_suna_agents = []
        for agent in agents_result.data or []:
            metadata = agent.get('metadata', {}) or {}
            is_suna_default = metadata.get('is_suna_default', False)
            if not is_suna_default:
                non_suna_agents.append(agent)
                
        current_count = len(non_suna_agents)
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


async def check_project_count_limit(client, account_id: str) -> Dict[str, Any]:
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

        projects_result = await client.table('projects').select('project_id').eq('account_id', account_id).execute()
        current_count = len(projects_result.data or [])
        logger.debug(f"Account {account_id} has {current_count} projects (real-time count)")
        
        try:
            credit_result = await client.table('credit_accounts').select('tier').eq('account_id', account_id).single().execute()
            tier_name = credit_result.data.get('tier', 'free') if credit_result.data else 'free'
            logger.debug(f"Account {account_id} credit tier: {tier_name}")
        except Exception as credit_error:
            try:
                logger.debug(f"Trying user_id fallback for account {account_id}")
                credit_result = await client.table('credit_accounts').select('tier').eq('user_id', account_id).single().execute()
                tier_name = credit_result.data.get('tier', 'free') if credit_result.data else 'free'
                logger.debug(f"Account {account_id} credit tier (via fallback): {tier_name}")
            except:
                logger.debug(f"No credit account for {account_id}, defaulting to free tier")
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


async def check_trigger_limit(client, account_id: str, agent_id: str = None, trigger_type: str = None) -> Dict[str, Any]:
    try:
        if agent_id is None or trigger_type is None:
            logger.debug(f"Checking aggregate trigger limits for account {account_id}")
            
            agents_result = await client.table('agents').select('agent_id').eq('account_id', account_id).execute()
            
            if not agents_result.data:
                logger.debug(f"No agents found for account {account_id}")
                return {
                    'scheduled': {'current_count': 0, 'limit': 1},
                    'app': {'current_count': 0, 'limit': 2},
                    'tier_name': 'free'
                }
            
            agent_ids = [agent['agent_id'] for agent in agents_result.data]
            
            from core.utils.query_utils import batch_query_in
            
            triggers = await batch_query_in(
                client=client,
                table_name='agent_triggers',
                select_fields='trigger_id, trigger_type',
                in_field='agent_id',
                in_values=agent_ids,
                additional_filters={}
            )
            
            scheduled_count = 0
            app_count = 0
            
            for trigger in triggers:
                ttype = trigger.get('trigger_type', '')
                if ttype == 'schedule':
                    scheduled_count += 1
                elif ttype in ['webhook', 'app', 'event']:
                    app_count += 1
            
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
                    'limit': scheduled_limit
                },
                'app': {
                    'current_count': app_count,
                    'limit': app_limit
                },
                'tier_name': tier_name
            }
        
        logger.debug(f"Checking trigger limit for account {account_id}, agent {agent_id}, type {trigger_type}")
        
        agent_result = await client.table('agents').select('agent_id').eq('agent_id', agent_id).eq('account_id', account_id).execute()
        
        if not agent_result.data:
            logger.warning(f"Agent {agent_id} not found or access denied for account {account_id}")
            return {
                'can_create': False,
                'current_count': 0,
                'limit': 0,
                'tier_name': 'free',
                'error': 'Agent not found or access denied'
            }
        
        triggers_result = await client.table('agent_triggers').select('trigger_id, trigger_type').eq('agent_id', agent_id).execute()
        
        scheduled_count = 0
        app_count = 0
        
        if triggers_result.data:
            for trigger in triggers_result.data:
                ttype = trigger.get('trigger_type', '')
                if ttype == 'schedule':
                    scheduled_count += 1
                elif ttype in ['webhook', 'app', 'event']:
                    app_count += 1
        
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


async def check_custom_worker_limit(client, account_id: str) -> Dict[str, Any]:
    try:
        logger.debug(f"Checking custom worker limit for account {account_id}")
        
        agents_result = await client.table('agents').select('agent_id, current_version_id').eq('account_id', account_id).execute()
        
        total_custom_mcps = 0
        
        if agents_result.data:
            version_ids = [agent['current_version_id'] for agent in agents_result.data if agent.get('current_version_id')]
            
            if version_ids:
                from core.utils.query_utils import batch_query_in
                
                versions = await batch_query_in(
                    client=client,
                    table_name='agent_versions',
                    select_fields='version_id, config',
                    in_field='version_id',
                    in_values=version_ids,
                    additional_filters={}
                )
                
                for version in versions:
                    config = version.get('config', {})
                    tools = config.get('tools', {})
                    custom_mcps = tools.get('custom_mcp', [])
                    total_custom_mcps += len(custom_mcps)
        
        logger.debug(f"Account {account_id} has {total_custom_mcps} custom workers (MCPs)")
        
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


async def check_thread_limit(client, account_id: str) -> Dict[str, Any]:
    try:
        logger.debug(f"Checking thread limit for account {account_id}")
        
        threads_result = await client.table('threads').select('thread_id', count='exact').eq('account_id', account_id).execute()
        
        current_count = threads_result.count if hasattr(threads_result, 'count') else (len(threads_result.data) if threads_result.data else 0)
        
        logger.debug(f"Account {account_id} has {current_count} threads")
        
        try:
            from core.billing import subscription_service
            tier_info = await subscription_service.get_user_subscription_tier(account_id, skip_cache=True)
            tier_name = tier_info['name']
            thread_limit = tier_info.get('thread_limit', 10)
            logger.debug(f"Account {account_id} tier: {tier_name}, thread limit: {thread_limit} (fresh from DB)")
        except Exception as billing_error:
            logger.warning(f"Could not get subscription tier for {account_id}: {str(billing_error)}, defaulting to free")
            tier_name = 'free'
            thread_limit = 10
        
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

