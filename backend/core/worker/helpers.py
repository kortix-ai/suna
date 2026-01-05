"""
Helper functions for agent run processing.

This module contains all the logic for running agents, used by
the Redis Streams-based worker.
"""

import asyncio
import json
import time
import traceback
import uuid
from datetime import datetime, timezone
from typing import Optional, Dict, Any, Tuple

from core.services import redis
from core.services.supabase import DBConnection
from core.services.langfuse import langfuse
from core.utils.logger import logger, structlog
from core.utils.retry import retry
from core.utils.tool_discovery import warm_up_tools_cache

# Global state
_initialized = False
_db = DBConnection()
_instance_id = ""
_STATIC_CORE_PROMPT = None

# TTL for Redis stream keys
REDIS_STREAM_TTL_SECONDS = 600  # 10 minutes


async def initialize() -> str:
    """Initialize worker resources (Redis, DB, caches). Returns instance ID."""
    global _initialized, _instance_id, _STATIC_CORE_PROMPT, _db

    if _initialized:
        return _instance_id
    
    if not _instance_id:
        _instance_id = str(uuid.uuid4())[:8]
    
    logger.info("Initializing worker resources...")
    
    await retry(lambda: redis.initialize_async())
    await redis.verify_connection()
    await _db.initialize()
    
    warm_up_tools_cache()
    
    try:
        from core.cache.runtime_cache import warm_up_suna_config_cache
        await warm_up_suna_config_cache()
    except Exception as e:
        logger.warning(f"Failed to pre-cache Suna configs (non-fatal): {e}")
    
    if not _STATIC_CORE_PROMPT:
        try:
            from core.prompts.core_prompt import get_core_system_prompt
            _STATIC_CORE_PROMPT = get_core_system_prompt()
            logger.info(f"✅ Cached static core prompt ({len(_STATIC_CORE_PROMPT):,} chars)")
        except Exception as e:
            logger.warning(f"Failed to cache core prompt (non-fatal): {e}")

    _initialized = True
    logger.info(f"✅ Worker resources initialized (instance: {_instance_id})")
    return _instance_id


def check_terminating_tool_call(response: Dict[str, Any]) -> Optional[str]:
    """Check if response contains a terminating tool call (ask/complete)."""
    if response.get('type') != 'status':
        return None
    
    metadata = response.get('metadata', {})
    if isinstance(metadata, str):
        try:
            metadata = json.loads(metadata)
        except (json.JSONDecodeError, TypeError):
            metadata = {}
    
    if not metadata.get('agent_should_terminate'):
        return None
    
    content = response.get('content', {})
    if isinstance(content, str):
        try:
            content = json.loads(content)
        except (json.JSONDecodeError, TypeError):
            content = {}
    
    if isinstance(content, dict):
        function_name = content.get('function_name')
        if function_name in ['ask', 'complete']:
            return function_name
    
    return None


async def acquire_run_lock(agent_run_id: str, instance_id: str, client) -> bool:
    """Acquire a distributed lock for an agent run. Returns True if acquired."""
    run_lock_key = f"agent_run_lock:{agent_run_id}"
    lock_acquired = await redis.set(run_lock_key, instance_id, nx=True, ex=redis.REDIS_KEY_TTL)
    
    if not lock_acquired:
        existing_instance = await redis.get(run_lock_key)
        existing_instance_str = existing_instance.decode() if isinstance(existing_instance, bytes) else existing_instance if existing_instance else None
        
        if existing_instance_str:
            instance_active_key = f"active_run:{existing_instance_str}:{agent_run_id}"
            instance_still_alive = await redis.get(instance_active_key)
            
            db_run_status = None
            try:
                run_result = await client.table('agent_runs').select('status').eq('id', agent_run_id).maybe_single().execute()
                if run_result.data:
                    db_run_status = run_result.data.get('status')
            except Exception as db_err:
                logger.warning(f"Failed to check database status for {agent_run_id}: {db_err}")
            
            if instance_still_alive or db_run_status == 'running':
                logger.info(f"Agent run {agent_run_id} already being processed by instance {existing_instance_str}")
                return False
            else:
                logger.warning(f"Stale lock for {agent_run_id} (instance {existing_instance_str} dead). Attempting to acquire.")
                await redis.delete(run_lock_key)
                lock_acquired = await redis.set(run_lock_key, instance_id, nx=True, ex=redis.REDIS_KEY_TTL)
                if not lock_acquired:
                    logger.info(f"Another worker acquired lock for {agent_run_id}")
                    return False
        else:
            lock_acquired = await redis.set(run_lock_key, instance_id, nx=True, ex=redis.REDIS_KEY_TTL)
            if not lock_acquired:
                logger.info(f"Agent run {agent_run_id} already being processed")
                return False
    
    return True


async def load_agent_config(
    agent_id: Optional[str], 
    account_id: Optional[str], 
    user_id: Optional[str] = None,
    client = None,
    is_new_thread: bool = False
) -> Optional[Dict[str, Any]]:
    """Load agent configuration from cache or database.
    
    Args:
        agent_id: Agent ID to load, or None for default agent
        account_id: Account ID for the agent
        user_id: User ID (defaults to account_id if not provided)
        client: Database client (required for default agent loading)
        is_new_thread: Whether this is a new thread (triggers Suna install check)
    """
    t = time.time()
    logger.info(f"⏱️ [AGENT CONFIG] Starting load_agent_config for agent_id={agent_id}")
    user_id = user_id or account_id
    
    try:
        # Handle default agent loading (agent_id is None)
        if not agent_id:
            if not client:
                logger.warning("Cannot load default agent: client not provided")
                return None
                
            logger.debug(f"[AGENT LOAD] Loading default agent")
            
            if is_new_thread:
                from core.utils.ensure_suna import ensure_suna_installed
                await ensure_suna_installed(account_id)
            
            from core.agents.agent_loader import get_agent_loader
            loader = await get_agent_loader()
            
            default_agent = await client.table('agents').select('agent_id').eq('account_id', account_id).eq('metadata->>is_suna_default', 'true').maybe_single().execute()
            
            if default_agent and default_agent.data:
                agent_data = await loader.load_agent(default_agent.data['agent_id'], user_id, load_config=True)
                logger.debug(f"Using default agent: {agent_data.name} ({agent_data.agent_id}) version {agent_data.version_name}")
                return agent_data.to_dict()
            else:
                logger.warning(f"[AGENT LOAD] No default agent found for account {account_id}, searching for shared Suna")
                agent_data = await _find_shared_suna_agent(client)
                
                if not agent_data:
                    any_agent = await client.table('agents').select('agent_id').eq('account_id', account_id).limit(1).maybe_single().execute()
                    
                    if any_agent and any_agent.data:
                        agent_data = await loader.load_agent(any_agent.data['agent_id'], user_id, load_config=True)
                        logger.info(f"[AGENT LOAD] Using fallback agent: {agent_data.name} ({agent_data.agent_id})")
                        return agent_data.to_dict()
                    else:
                        logger.error(f"[AGENT LOAD] No agents found for account {account_id}")
                        from fastapi import HTTPException
                        raise HTTPException(status_code=404, detail="No agents available. Please create an agent first.")
                return agent_data.to_dict()
        
        # Handle specific agent loading
        from core.cache.runtime_cache import (
            get_static_suna_config, 
            get_cached_user_mcps,
            get_cached_agent_config
        )
        
        static_config = get_static_suna_config()
        cached_mcps = await get_cached_user_mcps(agent_id)
        
        if static_config and cached_mcps is not None:
            agent_config = {
                'agent_id': agent_id,
                'system_prompt': static_config['system_prompt'],
                'model': static_config['model'],
                'agentpress_tools': static_config['agentpress_tools'],
                'centrally_managed': static_config['centrally_managed'],
                'is_suna_default': static_config['is_suna_default'],
                'restrictions': static_config['restrictions'],
                'configured_mcps': cached_mcps.get('configured_mcps', []),
                'custom_mcps': cached_mcps.get('custom_mcps', []),
                'triggers': cached_mcps.get('triggers', []),
            }
            logger.info(f"⏱️ [AGENT CONFIG] memory + Redis MCPs: {(time.time() - t) * 1000:.1f}ms (CACHE HIT)")
        else:
            t_cache = time.time()
            cached_config = await get_cached_agent_config(agent_id)
            
            if cached_config:
                agent_config = cached_config
                logger.info(f"⏱️ [AGENT CONFIG] get_cached_agent_config: {(time.time() - t_cache) * 1000:.1f}ms (CACHE HIT)")
            elif account_id:
                logger.info(f"⏱️ [AGENT CONFIG] Cache miss, loading from DB...")
                t_db = time.time()
                from core.agents.agent_loader import get_agent_loader
                loader = await get_agent_loader()
                agent_data = await loader.load_agent(agent_id, account_id, load_config=True)
                agent_config = agent_data.to_dict()
                logger.info(f"⏱️ [AGENT CONFIG] DB load: {(time.time() - t_db) * 1000:.1f}ms (CACHE MISS)")
            else:
                t_db = time.time()
                from core.agents.agent_loader import get_agent_loader
                loader = await get_agent_loader()
                agent_data = await loader.load_agent(agent_id, agent_id, load_config=True)
                agent_config = agent_data.to_dict()
                logger.info(f"⏱️ [AGENT CONFIG] DB load (no account): {(time.time() - t_db) * 1000:.1f}ms")
        
        if agent_config:
            logger.debug(f"Using agent {agent_config.get('agent_id')} for this agent run")
        
        return agent_config
    except Exception as e:
        logger.warning(f"Failed to fetch agent config for {agent_id}: {e}")
        return None


async def _find_shared_suna_agent(client):
    """Find shared Suna agent (helper for default agent loading)."""
    from core.agents.agent_loader import get_agent_loader
    from core.utils.config import config
    
    admin_user_id = config.SYSTEM_ADMIN_USER_ID
    
    if admin_user_id:
        admin_suna = await client.table('agents').select('agent_id').eq('account_id', admin_user_id).eq('metadata->>is_suna_default', 'true').maybe_single().execute()
        
        if admin_suna and admin_suna.data:
            loader = await get_agent_loader()
            agent_data = await loader.load_agent(admin_suna.data['agent_id'], admin_user_id, load_config=True)
            logger.info(f"✅ Using system Suna agent from admin user: {agent_data.name} ({agent_data.agent_id})")
            return agent_data
        else:
            logger.warning(f"⚠️ SYSTEM_ADMIN_USER_ID configured but no Suna agent found for user {admin_user_id}")
    
    any_suna = await client.table('agents').select('agent_id, account_id').eq('metadata->>is_suna_default', 'true').limit(1).maybe_single().execute()
    
    if any_suna and any_suna.data:
        loader = await get_agent_loader()
        agent_data = await loader.load_agent(any_suna.data['agent_id'], any_suna.data['account_id'], load_config=True)
        logger.info(f"Using shared Suna agent: {agent_data.name} ({agent_data.agent_id})")
        return agent_data
    
    logger.error("❌ No Suna agent found! Set SYSTEM_ADMIN_USER_ID in .env")
    return None


def create_redis_keys(agent_run_id: str, instance_id: str) -> Dict[str, str]:
    """Create Redis key names for an agent run."""
    return {
        'response_stream': f"agent_run:{agent_run_id}:stream",
        'instance_active': f"active_run:{instance_id}:{agent_run_id}"
    }


async def stream_status_message(
    status: str,
    message: str,
    metadata: Optional[Dict[str, Any]] = None,
    stream_key: Optional[str] = None
) -> None:
    """Write a status message to Redis stream.
    
    Args:
        status: Status type (e.g., "initializing", "ready")
        message: Status message text
        metadata: Optional metadata dict
        stream_key: Optional explicit stream key. If not provided, uses streaming context.
    """
    # Try to get stream key from context if not provided
    if not stream_key:
        from core.worker.tool_output_streaming_context import get_tool_output_streaming_context
        ctx = get_tool_output_streaming_context()
        if ctx:
            stream_key = ctx.stream_key
        else:
            return  # No streaming context available
    
    try:
        status_msg = {"type": "status", "status": status, "message": message}
        if metadata:
            status_msg["metadata"] = metadata
        
        await asyncio.wait_for(
            redis.stream_add(stream_key, {"data": json.dumps(status_msg)}, maxlen=200, approximate=True),
            timeout=2.0
        )
    except (asyncio.TimeoutError, Exception) as e:
        logger.debug(f"Failed to write status message (non-critical): {e}")


async def process_agent_responses(
    agent_gen,
    agent_run_id: str,
    redis_keys: Dict[str, str],
    trace,
    worker_start: float,
    stop_signal_checker_state: Dict[str, Any]
) -> Tuple[str, Optional[str], bool, int]:
    """Process agent responses and stream them to Redis."""
    final_status = "running"
    error_message = None
    first_response_logged = False
    complete_tool_called = False
    total_responses = 0
    stream_key = redis_keys['response_stream']
    stream_ttl_set = False
    
    async for response in agent_gen:
        if not first_response_logged:
            first_token_time = (time.time() - worker_start) * 1000
            logger.info(f"⏱️ FIRST RESPONSE from agent: {first_token_time:.1f}ms")
            first_response_logged = True
        
        if stop_signal_checker_state.get('stop_signal_received'):
            stop_reason = stop_signal_checker_state.get('stop_reason', 'external_stop_signal')
            logger.warning(f"🛑 Agent run {agent_run_id} stopped. Reason: {stop_reason}")
            final_status = "stopped"
            error_message = f"Stopped by {stop_reason}"
            trace.span(name="agent_run_stopped").end(status_message=f"stopped: {stop_reason}", level="WARNING")
            break

        response_json = json.dumps(response)
        
        try:
            await redis.stream_add(stream_key, {"data": response_json}, maxlen=200, approximate=True)
            
            # Publish notification for instant delivery (new)
            try:
                await redis.publish(f"{stream_key}:notify", response.get('type', 'message'))
            except Exception:
                pass  # Non-critical - stream still has the data
            
            if not stream_ttl_set:
                try:
                    await asyncio.wait_for(redis.expire(stream_key, REDIS_STREAM_TTL_SECONDS), timeout=2.0)
                    stream_ttl_set = True
                except:
                    pass
        except Exception as e:
            logger.warning(f"Failed to write to stream for {agent_run_id}: {e}")
        
        total_responses += 1
        stop_signal_checker_state['total_responses'] = total_responses

        if total_responses % 50 == 0:
            try:
                await asyncio.wait_for(redis.expire(stream_key, REDIS_STREAM_TTL_SECONDS), timeout=2.0)
            except:
                pass

        terminating_tool = check_terminating_tool_call(response)
        if terminating_tool == 'complete':
            complete_tool_called = True
            logger.info(f"Complete tool called in agent run {agent_run_id}")
        elif terminating_tool == 'ask':
            logger.debug(f"Ask tool called in agent run {agent_run_id}")

        if response.get('type') == 'status':
            status_val = response.get('status')
            
            if status_val in ['completed', 'failed', 'stopped', 'error']:
                logger.info(f"Agent run {agent_run_id} finished: {status_val}")
                final_status = status_val if status_val != 'error' else 'failed'
                if status_val in ['failed', 'error']:
                    error_message = response.get('message', f"Run ended: {status_val}")
                    logger.error(f"Agent run failed: {error_message}")
                elif status_val == 'stopped':
                    # 'stopped' is a normal state (agent awaiting user input, or task complete)
                    logger.debug(f"Agent run stopped: {response.get('message', 'Normal stop')}")
                break
    
    return final_status, error_message, complete_tool_called, total_responses


async def handle_normal_completion(
    agent_run_id: str,
    start_time: datetime,
    total_responses: int,
    redis_keys: Dict[str, str],
    trace
) -> Dict[str, str]:
    """Handle normal completion of an agent run."""
    duration = (datetime.now(timezone.utc) - start_time).total_seconds()
    logger.info(f"Agent run {agent_run_id} completed (duration: {duration:.2f}s, responses: {total_responses})")
    
    completion_message = {"type": "status", "status": "completed", "message": "Completed successfully"}
    trace.span(name="agent_run_completed").end(status_message="completed")
    
    try:
        await asyncio.wait_for(
            redis.stream_add(redis_keys['response_stream'], {'data': json.dumps(completion_message)}, maxlen=200, approximate=True),
            timeout=5.0
        )
        # Notify completion (new)
        try:
            await redis.publish(f"{redis_keys['response_stream']}:notify", "status")
        except Exception:
            pass
    except Exception as e:
        logger.warning(f"Failed to write completion message for {agent_run_id}: {e}")
    
    return completion_message


async def get_thread_data(client, thread_id: str) -> dict:
    """Get thread data for notifications."""
    try:
        thread_info = await client.table('threads').select('project_id').eq('thread_id', thread_id).maybe_single().execute()
        if thread_info and thread_info.data:
            project_id = thread_info.data.get('project_id')
            if project_id:
                project_info = await client.table('projects').select('name').eq('project_id', project_id).maybe_single().execute()
                task_name = project_info.data.get('name', 'Task') if project_info and project_info.data else 'Task'
                return {'task_name': task_name, 'task_url': f"/projects/{project_id}/thread/{thread_id}"}
    except Exception as e:
        logger.warning(f"Failed to get thread data for {thread_id}: {e}")
    
    return {'task_name': 'Task', 'task_url': f"/thread/{thread_id}"}


async def send_completion_notification(client, thread_id: str, agent_config: Optional[Dict[str, Any]], complete_tool_called: bool):
    """Send completion notification if complete tool was called."""
    if not complete_tool_called:
        return
    
    try:
        from core.notifications.notification_service import notification_service
        thread_info = await client.table('threads').select('account_id').eq('thread_id', thread_id).maybe_single().execute()
        if thread_info and thread_info.data:
            user_id = thread_info.data.get('account_id')
            if user_id:
                notification_data = await get_thread_data(client, thread_id)
                await notification_service.send_task_completion_notification(
                    account_id=user_id,
                    task_name=notification_data['task_name'],
                    thread_id=thread_id,
                    agent_name=agent_config.get('name') if agent_config else None,
                    result_summary="Task completed successfully"
                )
    except Exception as e:
        logger.warning(f"Failed to send completion notification: {e}")


async def send_failure_notification(client, thread_id: str, error_message: str):
    """Send failure notification."""
    try:
        from core.notifications.notification_service import notification_service
        thread_info = await client.table('threads').select('account_id').eq('thread_id', thread_id).maybe_single().execute()
        if thread_info and thread_info.data:
            user_id = thread_info.data.get('account_id')
            if user_id:
                notification_data = await get_thread_data(client, thread_id)
                await notification_service.send_task_failed_notification(
                    account_id=user_id,
                    task_name=notification_data['task_name'],
                    task_url=notification_data['task_url'],
                    failure_reason=error_message,
                    first_name='User',
                    thread_id=thread_id
                )
    except Exception as e:
        logger.warning(f"Failed to send failure notification: {e}")


async def publish_final_control_signal(agent_run_id: str, final_status: str, stop_reason: Optional[str] = None):
    """Publish final control signal for stopped runs."""
    if final_status == "stopped":
        try:
            await asyncio.wait_for(redis.set_stop_signal(agent_run_id), timeout=3.0)
            logger.warning(f"🛑 Set stop signal for {agent_run_id} (reason: {stop_reason or 'unknown'})")
        except Exception as e:
            logger.warning(f"Failed to set stop signal for {agent_run_id}: {e}")


async def cleanup_redis_keys(agent_run_id: str, instance_id: Optional[str] = None):
    """Clean up all Redis keys for an agent run."""
    logger.debug(f"Cleaning up Redis keys for agent run: {agent_run_id}")
    
    keys_to_delete = [
        f"agent_run:{agent_run_id}:stream",
        f"agent_run_lock:{agent_run_id}",
    ]
    
    if instance_id:
        keys_to_delete.append(f"active_run:{instance_id}:{agent_run_id}")
    
    for key in keys_to_delete:
        try:
            await redis.delete(key)
        except Exception as e:
            logger.warning(f"Failed to delete Redis key {key}: {e}")
    
    try:
        instance_keys = await redis.scan_keys(f"active_run:*:{agent_run_id}")
        for key in instance_keys:
            key_str = key.decode('utf-8') if isinstance(key, bytes) else key
            if key_str not in keys_to_delete:
                try:
                    await redis.delete(key_str)
                except:
                    pass
    except Exception as e:
        logger.warning(f"Failed to clean up instance keys for {agent_run_id}: {e}")


async def update_agent_run_status(
    client,
    agent_run_id: str,
    status: str,
    error: Optional[str] = None,
    account_id: Optional[str] = None,
    thread_id: Optional[str] = None,
) -> bool:
    """Update agent run status in database using standard execute_with_reconnect pattern."""
    from core.services.supabase import DBConnection, execute_with_reconnect
    
    update_data = {
        "status": status,
        "completed_at": datetime.now(timezone.utc).isoformat()
    }
    if error:
        update_data["error"] = error

    db = DBConnection()
    
    try:
        update_result = await execute_with_reconnect(
            db,
            lambda c: c.table('agent_runs').update(update_data).eq("id", agent_run_id).execute()
        )

        if hasattr(update_result, 'data') and update_result.data:
            if account_id:
                try:
                    from core.cache.runtime_cache import invalidate_running_runs_cache
                    await invalidate_running_runs_cache(account_id)
                except:
                    pass
                
                try:
                    from core.billing.shared.cache_utils import invalidate_account_state_cache
                    await invalidate_account_state_cache(account_id)
                except:
                    pass
            
            logger.info(f"✅ Updated agent run {agent_run_id} status to '{status}'")
            return True
        else:
            logger.error(f"Failed to update agent run status (no data returned): {agent_run_id}")
            return False
            
    except Exception as e:
        logger.error(f"Failed to update agent run status for {agent_run_id}: {e}")
        return False


async def ensure_project_metadata_cached(project_id: str, client) -> None:
    """
    Ensure project metadata (sandbox info) is cached. Non-blocking if already cached.
    
    REFACTORED: Removed lazy migration from hot path.
    - Was causing 10-64 second hangs due to multiple DB queries
    - Migration now runs in background job (see dispatch_sandbox_migration)
    - This function now just does a simple single-query fetch
    """
    from core.cache.runtime_cache import get_cached_project_metadata, set_cached_project_metadata
    
    # Check cache first (fast path)
    cached_project = await get_cached_project_metadata(project_id)
    if cached_project is not None:  # Note: empty dict {} is valid cached value
        return
    
    try:
        # Single optimized query - fetch project with sandbox resource in one go
        # This replaces 4-5 separate queries that were causing hangs
        project = await client.table('projects')\
            .select('project_id, sandbox_resource_id, resources!sandbox_resource_id(id, external_id, config)')\
            .eq('project_id', project_id)\
            .maybe_single()\
            .execute()
        
        if not project.data:
            # Project not found - cache empty dict to prevent repeated lookups
            logger.warning(f"Project {project_id} not found, caching empty metadata")
            await set_cached_project_metadata(project_id, {})
            return
        
        project_data = project.data
        sandbox_info = {}
        
        # Extract sandbox info from joined resource data
        resource_data = project_data.get('resources')
        if resource_data:
            sandbox_info = {
                'id': resource_data.get('external_id'),
                **(resource_data.get('config') or {})
            }
        
        await set_cached_project_metadata(project_id, sandbox_info)
        logger.debug(f"✅ Cached project metadata for {project_id} (has_sandbox={bool(sandbox_info)})")
        
    except Exception as e:
        # Non-fatal - log and cache empty to prevent repeated failures
        logger.warning(f"Failed to fetch project metadata for {project_id}: {e}")
        await set_cached_project_metadata(project_id, {})


async def dispatch_sandbox_migration(project_id: str, client) -> None:
    """
    Background job to migrate sandbox data from legacy JSONB to resources table.
    This is called asynchronously and does NOT block the agent run.
    """
    try:
        from core.resources import ResourceService
        resource_service = ResourceService(client)
        
        result = await resource_service.migrate_project_sandbox_if_needed(project_id)
        if result:
            logger.info(f"🔄 Background migration completed for project {project_id}")
            # Invalidate cache so next request gets fresh data
            from core.cache.runtime_cache import invalidate_project_metadata
            await invalidate_project_metadata(project_id)
    except Exception as e:
        logger.warning(f"Background sandbox migration failed for {project_id}: {e}")

