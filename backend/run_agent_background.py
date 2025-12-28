import dotenv
dotenv.load_dotenv(".env")

import sentry
import asyncio
import json
import traceback
from datetime import datetime, timezone
from typing import Optional, Dict, Any, Tuple
from core.services import redis
from core.run import run_agent
from core.utils.logger import logger, structlog
from core.utils.tool_discovery import warm_up_tools_cache
import dramatiq
import uuid
from core.services.supabase import DBConnection
from dramatiq.brokers.redis import RedisBroker
from core.services.langfuse import langfuse
from core.utils.retry import retry
import time

from core.services.redis import get_redis_config as _get_redis_config
import os

redis_config = _get_redis_config()
redis_host = redis_config["host"]
redis_port = redis_config["port"]
redis_password = redis_config["password"]
redis_username = redis_config["username"]

# Get queue prefix from environment (for preview deployments)
QUEUE_PREFIX = os.getenv("DRAMATIQ_QUEUE_PREFIX", "")

def get_queue_name(base_name: str) -> str:
    """Get queue name with optional prefix for preview deployments."""
    if QUEUE_PREFIX:
        return f"{QUEUE_PREFIX}{base_name}"
    return base_name

if redis_config["url"]:
    auth_info = f" (user={redis_username})" if redis_username else ""
    queue_info = f" (queue prefix: '{QUEUE_PREFIX}')" if QUEUE_PREFIX else ""
    logger.info(f"🔧 Configuring Dramatiq broker with Redis at {redis_host}:{redis_port}{auth_info}{queue_info}")
    redis_broker = RedisBroker(url=redis_config["url"], middleware=[dramatiq.middleware.AsyncIO()])
else:
    queue_info = f" (queue prefix: '{QUEUE_PREFIX}')" if QUEUE_PREFIX else ""
    logger.info(f"🔧 Configuring Dramatiq broker with Redis at {redis_host}:{redis_port}{queue_info}")
    redis_broker = RedisBroker(host=redis_host, port=redis_port, middleware=[dramatiq.middleware.AsyncIO()])

dramatiq.set_broker(redis_broker)

from core.memory import background_jobs as memory_jobs
from core.categorization import background_jobs as categorization_jobs

warm_up_tools_cache()
logger.info("✅ Worker process ready, tool cache warmed")

_initialized = False
db = DBConnection()
instance_id = ""

# TTL for Redis stream keys - ensures cleanup even if process crashes
REDIS_STREAM_TTL_SECONDS = 600  # 10 minutes

_STATIC_CORE_PROMPT = None


def check_terminating_tool_call(response: Dict[str, Any]) -> Optional[str]:
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


async def initialize():
    global db, instance_id, _initialized, _STATIC_CORE_PROMPT

    if _initialized:
        return
    
    if not instance_id:
        instance_id = str(uuid.uuid4())[:8]
    
    logger.info(f"Initializing worker async resources with Redis at {redis_host}:{redis_port}")
    await retry(lambda: redis.initialize_async())
    
    await redis.verify_connection()
    
    await db.initialize()
    
    from core.utils.tool_discovery import warm_up_tools_cache
    warm_up_tools_cache()
    
    try:
        from core.runtime_cache import warm_up_suna_config_cache
        await warm_up_suna_config_cache()
    except Exception as e:
        logger.warning(f"Failed to pre-cache Suna configs (non-fatal): {e}")
    
    if not _STATIC_CORE_PROMPT:
        try:
            from core.prompts.core_prompt import get_core_system_prompt
            _STATIC_CORE_PROMPT = get_core_system_prompt()
            logger.info(f"✅ Cached static core prompt at worker boot ({len(_STATIC_CORE_PROMPT):,} chars)")
        except Exception as e:
            logger.warning(f"Failed to cache core prompt (non-fatal): {e}")

    _initialized = True
    logger.info(f"✅ Worker async resources initialized successfully (instance: {instance_id})")

@dramatiq.actor(queue_name=get_queue_name("default"))
async def check_health(key: str):
    structlog.contextvars.clear_contextvars()
    await redis.set(key, "healthy", ex=redis.REDIS_KEY_TTL)


async def acquire_run_lock(agent_run_id: str, instance_id: str, client) -> bool:
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
                logger.info(f"Agent run {agent_run_id} is already being processed by instance {existing_instance_str}. Skipping duplicate execution.")
                return False
            else:
                logger.warning(f"Stale lock detected for {agent_run_id} (instance {existing_instance_str} is dead, DB status: {db_run_status}). Attempting to acquire lock.")
                await redis.delete(run_lock_key)
                lock_acquired = await redis.set(run_lock_key, instance_id, nx=True, ex=redis.REDIS_KEY_TTL)
                if not lock_acquired:
                    logger.info(f"Another worker acquired lock for {agent_run_id} while cleaning up stale lock. Skipping.")
                    return False
        else:
            lock_acquired = await redis.set(run_lock_key, instance_id, nx=True, ex=redis.REDIS_KEY_TTL)
            if not lock_acquired:
                logger.info(f"Agent run {agent_run_id} is already being processed by another instance. Skipping duplicate execution.")
                return False
    
    return True


async def load_agent_config(agent_id: Optional[str], account_id: Optional[str]) -> Optional[Dict[str, Any]]:
    if not agent_id:
        return None
    
    t = time.time()
    try:
        from core.runtime_cache import (
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
            logger.info(f"⏱️ [TIMING] ⚡ Suna config from memory + Redis MCPs: {(time.time() - t) * 1000:.1f}ms")
        else:
            cached_config = await get_cached_agent_config(agent_id)
            
            if cached_config:
                agent_config = cached_config
                logger.info(f"⏱️ [TIMING] ⚡ Custom agent config from cache: {(time.time() - t) * 1000:.1f}ms")
            elif account_id:
                from core.agent_loader import get_agent_loader
                loader = await get_agent_loader()
                
                agent_data = await loader.load_agent(agent_id, account_id, load_config=True)
                agent_config = agent_data.to_dict()
                logger.info(f"⏱️ [TIMING] Agent config from DB (cached for next time): {(time.time() - t) * 1000:.1f}ms")
            else:
                from core.agent_loader import get_agent_loader
                loader = await get_agent_loader()
                
                agent_data = await loader.load_agent(agent_id, agent_id, load_config=True)
                agent_config = agent_data.to_dict()
                logger.info(f"⏱️ [TIMING] Agent config from DB (public agent): {(time.time() - t) * 1000:.1f}ms")
        
        return agent_config
    except Exception as e:
        logger.warning(f"Failed to fetch agent config for agent_id {agent_id}: {e}. Using default config.")
        return None


async def get_thread_data(client, thread_id: str) -> dict:
    try:
        thread_info = await client.table('threads').select('project_id').eq('thread_id', thread_id).maybe_single().execute()
        if thread_info and thread_info.data:
            project_id = thread_info.data.get('project_id')
            if project_id:
                project_info = await client.table('projects').select('name').eq('project_id', project_id).maybe_single().execute()
                task_name = 'Task'
                if project_info and project_info.data:
                    task_name = project_info.data.get('name', 'Task')
                
                return {
                    'task_name': task_name,
                    'task_url': f"/projects/{project_id}/thread/{thread_id}"
                }
    except Exception as e:
        logger.warning(f"Failed to get notification data for thread {thread_id}: {e}")
    
    return {
        'task_name': 'Task',
        'task_url': f"/thread/{thread_id}"
    }


async def send_completion_notification(client, thread_id: str, agent_config: Optional[Dict[str, Any]], complete_tool_called: bool):
    if not complete_tool_called:
        return
    
    try:
        from core.notifications.notification_service import notification_service
        thread_info = await client.table('threads').select('account_id').eq('thread_id', thread_id).maybe_single().execute()
        if thread_info and thread_info.data:
            user_id = thread_info.data.get('account_id')
            if user_id:
                notification_data = await get_thread_data(client, thread_id)
                result = await notification_service.send_task_completion_notification(
                    account_id=user_id,
                    task_name=notification_data['task_name'],
                    thread_id=thread_id,
                    agent_name=agent_config.get('name') if agent_config else None,
                    result_summary="Task completed successfully"
                )
                logger.info(f"Task completion notification sent (complete tool called): {result}")
    except Exception as notif_error:
        logger.warning(f"Failed to send completion notification: {notif_error}")


async def send_failure_notification(client, thread_id: str, error_message: str):
    try:
        from core.notifications.notification_service import notification_service
        thread_info = await client.table('threads').select('account_id').eq('thread_id', thread_id).maybe_single().execute()
        if thread_info and thread_info.data:
            user_id = thread_info.data.get('account_id')
            if user_id:
                notification_data = await get_thread_data(client, thread_id)
                result = await notification_service.send_task_failed_notification(
                    account_id=user_id,
                    task_name=notification_data['task_name'],
                    task_url=notification_data['task_url'],
                    failure_reason=error_message,
                    first_name='User',
                    thread_id=thread_id
                )
                logger.info(f"Task failed notification result: {result}")
    except Exception as notif_error:
        logger.warning(f"Failed to send failure notification: {notif_error}")


def create_redis_keys(agent_run_id: str, instance_id: str) -> Dict[str, str]:
    return {
        'response_stream': f"agent_run:{agent_run_id}:stream",
        'instance_active': f"active_run:{instance_id}:{agent_run_id}"
    }




MAX_PENDING_REDIS_OPS = 500

async def process_agent_responses(
    agent_gen,
    agent_run_id: str,
    redis_keys: Dict[str, str],
    trace,
    worker_start: float,
    stop_signal_checker_state: Dict[str, Any]
) -> Tuple[str, Optional[str], bool, int]:
    final_status = "running"
    error_message = None
    first_response_logged = False
    complete_tool_called = False
    total_responses = 0
    redis_streaming_enabled = True
    
    stream_key = redis_keys['response_stream']
    stream_ttl_set = False  # Track if we've set initial TTL on the stream
    
    async for response in agent_gen:
        if not first_response_logged:
            first_token_time = (time.time() - worker_start) * 1000
            logger.info(f"⏱️ [TIMING] 🎯 FIRST RESPONSE from agent: {first_token_time:.1f}ms from job start")
            first_response_logged = True
        
        if stop_signal_checker_state.get('stop_signal_received'):
            stop_reason = stop_signal_checker_state.get('stop_reason', 'external_stop_signal')
            logger.warning(f"🛑 Agent run {agent_run_id} stopped by signal. Reason: {stop_reason}. Total responses processed: {total_responses}")
            final_status = "stopped"
            error_message = f"Stopped by {stop_reason}"
            trace.span(name="agent_run_stopped").end(status_message=f"agent_run_stopped: {stop_reason}", level="WARNING")
            break

        response_json = json.dumps(response)
        
        # Write to stream directly - no fire-and-forget, no pubsub
        if redis_streaming_enabled:
            try:
                await redis.stream_add(
                    stream_key,
                    {"data": response_json},
                    maxlen=200,
                    approximate=True
                )
                
                # Set initial TTL on stream after first entry is added (safety net if cleanup fails)
                if not stream_ttl_set:
                    try:
                        await asyncio.wait_for(redis.expire(stream_key, REDIS_STREAM_TTL_SECONDS), timeout=2.0)
                        stream_ttl_set = True
                        logger.debug(f"Set initial TTL ({REDIS_STREAM_TTL_SECONDS}s) on stream {stream_key}")
                    except (asyncio.TimeoutError, Exception) as e:
                        logger.debug(f"Failed to set initial TTL on stream (non-critical): {e}")
            except Exception as e:
                logger.warning(f"Failed to write to stream for {agent_run_id}: {e}")
                # Don't disable streaming on single failure - redis-py will retry
        
        total_responses += 1
        stop_signal_checker_state['total_responses'] = total_responses

        # Refresh stream TTL periodically
        if total_responses % 50 == 0:
            try:
                await asyncio.wait_for(redis.expire(stream_key, REDIS_STREAM_TTL_SECONDS), timeout=2.0)
            except (asyncio.TimeoutError, Exception):
                pass

        terminating_tool = check_terminating_tool_call(response)
        if terminating_tool == 'complete':
            complete_tool_called = True
            logger.info(f"Complete tool was called in agent run {agent_run_id}")
        elif terminating_tool == 'ask':
            logger.debug(f"Ask tool was called in agent run {agent_run_id} (terminating but no notification)")

        if response.get('type') == 'status':
            status_val = response.get('status')
            
            if status_val in ['completed', 'failed', 'stopped', 'error']:
                logger.info(f"Agent run {agent_run_id} finished with status: {status_val}")
                final_status = status_val if status_val != 'error' else 'failed'
                if status_val in ['failed', 'stopped', 'error']:
                    error_message = response.get('message', f"Run ended with status: {status_val}")
                    logger.error(f"Agent run failed: {error_message}")
                break
    
    # All stream writes are synchronous now, so no pending operations to await
    return final_status, error_message, complete_tool_called, total_responses


async def handle_normal_completion(
    agent_run_id: str,
    start_time: datetime,
    total_responses: int,
    redis_keys: Dict[str, str],
    trace
) -> Dict[str, str]:
    duration = (datetime.now(timezone.utc) - start_time).total_seconds()
    logger.info(f"Agent run {agent_run_id} completed normally (duration: {duration:.2f}s, responses: {total_responses})")
    completion_message = {"type": "status", "status": "completed", "message": "Worker run completed successfully"}
    trace.span(name="agent_run_completed").end(status_message="agent_run_completed")
    completion_json = json.dumps(completion_message)
    try:
        await asyncio.wait_for(
            redis.stream_add(
                redis_keys['response_stream'],
                {'data': completion_json},
                maxlen=200,
                approximate=True
            ),
            timeout=5.0
        )
    except asyncio.TimeoutError:
        logger.warning(f"Timeout writing completion message to Redis stream for {agent_run_id}")
    except Exception as e:
        logger.warning(f"Failed to write completion message to stream for {agent_run_id}: {e}")
    return completion_message


async def publish_final_control_signal(agent_run_id: str, final_status: str, stop_reason: Optional[str] = None):
    """Set final control signal via stop signal key (no longer using pubsub)."""
    # For completed/failed, we don't need a control signal - the status in the stream is enough
    # Only set stop signal if explicitly stopped
    if final_status == "stopped":
        try:
            await asyncio.wait_for(
                redis.set_stop_signal(agent_run_id),
                timeout=3.0
            )
            logger.warning(f"🛑 Set stop signal for agent run {agent_run_id} (reason: {stop_reason or 'unknown'})")
        except asyncio.TimeoutError:
            logger.warning(f"Timeout setting stop signal for {agent_run_id}")
        except Exception as e:
            logger.warning(f"Failed to set stop signal for {agent_run_id}: {str(e)}")



from core import thread_init_service
from core.tool_output_streaming_context import set_tool_output_streaming_context, clear_tool_output_streaming_context

@dramatiq.actor(queue_name=get_queue_name("default"))
async def run_agent_background(
    agent_run_id: str,
    thread_id: str,
    instance_id: str,
    project_id: str,
    model_name: str = "openai/gpt-5-mini",
    agent_id: Optional[str] = None,
    account_id: Optional[str] = None,
    request_id: Optional[str] = None
):
    worker_start = time.time()
    timings = {}
    
    structlog.contextvars.clear_contextvars()
    structlog.contextvars.bind_contextvars(
        agent_run_id=agent_run_id,
        thread_id=thread_id,
        request_id=request_id,
    )
    
    logger.info(f"⏱️ [TIMING] Worker received job at {worker_start}")

    t = time.time()
    try:
        await initialize()
    except Exception as e:
        logger.critical(f"Failed to initialize worker resources (Redis/DB): {e}")
        raise e
    timings['initialize'] = (time.time() - t) * 1000

    client = None
    try:
        client = await db.client
        lock_acquired = await acquire_run_lock(agent_run_id, instance_id, client)
        if not lock_acquired:
            # No cleanup needed - we didn't acquire the lock, another instance has it
            return

        sentry.sentry.set_tag("thread_id", thread_id)
        
        timings['lock_acquisition'] = (time.time() - worker_start) * 1000 - timings['initialize']
        logger.info(f"⏱️ [TIMING] Worker init: {timings['initialize']:.1f}ms | Lock: {timings['lock_acquisition']:.1f}ms")
        logger.info(f"Starting background agent run: {agent_run_id} for thread: {thread_id} (Instance: {instance_id})")
        
        from core.ai_models import model_manager
        effective_model = model_manager.resolve_model_id(model_name)
        logger.info(f"🚀 Using model: {effective_model}")
        
        start_time = datetime.now(timezone.utc)
        stop_checker = None
        cancellation_event = asyncio.Event()

        redis_keys = create_redis_keys(agent_run_id, instance_id)
        
        await redis.verify_stream_writable(redis_keys['response_stream'])
        logger.info(f"✅ Verified Redis stream {redis_keys['response_stream']} is writable")
        
        trace = langfuse.trace(
            name="agent_run",
            id=agent_run_id,
            session_id=thread_id,
            metadata={"project_id": project_id, "instance_id": instance_id}
        )
        
    except Exception as e:
        logger.error(f"Critical error during worker setup for {agent_run_id}: {e}", exc_info=True)
        try:
            if not client:
                client = await db.client
            await update_agent_run_status(client, agent_run_id, "failed", error=f"Worker setup failed: {str(e)}", account_id=account_id)
        except Exception as inner_e:
            logger.error(f"Failed to update status after setup error: {inner_e}")
        # Clean up any Redis keys that might have been created (e.g., lock key)
        try:
            await cleanup_redis_keys_for_agent_run(agent_run_id, instance_id)
        except Exception as cleanup_err:
            logger.warning(f"Failed to clean up Redis keys after setup error: {cleanup_err}")
        return
    stop_signal_checker_state = {'stop_signal_received': False, 'total_responses': 0, 'stop_reason': None}
    
    async def check_for_stop_signal():
        """Simple polling-based stop signal checker using Redis key."""
        while not stop_signal_checker_state.get('stop_signal_received'):
            try:
                # Check stop signal key
                if await redis.check_stop_signal(agent_run_id):
                    logger.warning(f"🛑 Received STOP signal for agent run {agent_run_id}")
                    stop_signal_checker_state['stop_signal_received'] = True
                    stop_signal_checker_state['stop_reason'] = 'stop_signal_key'
                    cancellation_event.set()
                    break
                
                # Refresh instance_active TTL periodically
                if stop_signal_checker_state.get('total_responses', 0) % 50 == 0:
                    try:
                        await asyncio.wait_for(
                            redis.expire(redis_keys['instance_active'], redis.REDIS_KEY_TTL),
                            timeout=3.0
                        )
                    except (asyncio.TimeoutError, Exception):
                        pass
                
                await asyncio.sleep(0.5)  # Poll every 500ms
            except asyncio.CancelledError:
                logger.debug(f"Stop signal checker cancelled for {agent_run_id}")
                break
            except Exception as e:
                logger.error(f"Error in stop signal checker for {agent_run_id}: {e}", exc_info=True)
                await asyncio.sleep(1)
    
    stop_checker = asyncio.create_task(check_for_stop_signal())
    try:
        try:
            await asyncio.wait_for(
                redis.set(redis_keys['instance_active'], "running", ex=redis.REDIS_KEY_TTL),
                timeout=5.0
            )
        except asyncio.TimeoutError:
            logger.warning(f"Redis timeout setting instance_active key for {agent_run_id} - continuing without")
        except Exception as e:
            logger.warning(f"Redis error setting instance_active key for {agent_run_id}: {e} - continuing without")

        agent_config = await load_agent_config(agent_id, account_id)

        # Set tool output streaming context for tools to publish real-time output
        set_tool_output_streaming_context(
            agent_run_id=agent_run_id,
            stream_key=redis_keys['response_stream']
        )

        agent_gen = run_agent(
            thread_id=thread_id,
            project_id=project_id,
            model_name=effective_model,
            agent_config=agent_config,
            trace=trace,
            cancellation_event=cancellation_event,
            account_id=account_id,
        )
        
        total_to_ready = (time.time() - worker_start) * 1000
        logger.info(f"⏱️ [TIMING] 🏁 Worker ready for first LLM call: {total_to_ready:.1f}ms from job start")

        final_status, error_message, complete_tool_called, total_responses = await process_agent_responses(
            agent_gen, agent_run_id, redis_keys, trace, worker_start, stop_signal_checker_state
        )

        if final_status == "running":
            final_status = "completed"
            await handle_normal_completion(agent_run_id, start_time, total_responses, redis_keys, trace)
            await send_completion_notification(client, thread_id, agent_config, complete_tool_called)
            if not complete_tool_called:
                logger.info(f"Agent run {agent_run_id} completed without explicit complete tool call - skipping notification")

        await update_agent_run_status(client, agent_run_id, final_status, error=error_message, account_id=account_id)

        if final_status == "failed" and error_message:
            await send_failure_notification(client, thread_id, error_message)

        stop_reason = stop_signal_checker_state.get('stop_reason')
        await publish_final_control_signal(agent_run_id, final_status, stop_reason=stop_reason)

    except Exception as e:
        error_message = str(e)
        traceback_str = traceback.format_exc()
        duration = (datetime.now(timezone.utc) - start_time).total_seconds()
        logger.error(f"Error in agent run {agent_run_id} after {duration:.2f}s: {error_message}\n{traceback_str} (Instance: {instance_id})")
        final_status = "failed"
        trace.span(name="agent_run_failed").end(status_message=error_message, level="ERROR")
        
        await send_failure_notification(client, thread_id, error_message)

        error_response = {"type": "status", "status": "error", "message": error_message}
        try:
            error_json = json.dumps(error_response)
            await asyncio.wait_for(
                redis.stream_add(
                    redis_keys['response_stream'],
                    {'data': error_json},
                    maxlen=200,
                    approximate=True
                ),
                timeout=5.0
            )
        except asyncio.TimeoutError:
            logger.warning(f"Timeout writing error response to Redis stream for {agent_run_id}")
        except Exception as redis_err:
            logger.error(f"Failed to write error response to Redis stream for {agent_run_id}: {redis_err}")

        await update_agent_run_status(client, agent_run_id, "failed", error=f"{error_message}\n{traceback_str}", account_id=account_id)

    finally:
        # Clear tool output streaming context
        clear_tool_output_streaming_context()
        
        if stop_checker and not stop_checker.done():
            stop_checker.cancel()
            try:
                await stop_checker
            except asyncio.CancelledError:
                pass
            except Exception as e:
                logger.warning(f"Error during stop_checker cancellation: {e}")
        
        # Comprehensive cleanup of all Redis keys for this agent run
        await cleanup_redis_keys_for_agent_run(agent_run_id, instance_id)

        if final_status == "completed" and account_id:
            try:
                from core.memory.background_jobs import extract_memories_from_conversation
                messages_result = await client.table('messages').select('message_id').eq('thread_id', thread_id).order('created_at', desc=False).execute()
                if messages_result.data:
                    message_ids = [m['message_id'] for m in messages_result.data]
                    extract_memories_from_conversation.send(
                        thread_id=thread_id,
                        account_id=account_id,
                        message_ids=message_ids
                    )
                    logger.debug(f"Queued memory extraction for thread {thread_id}")
            except Exception as mem_error:
                logger.warning(f"Failed to queue memory extraction: {mem_error}")

        # MEMORY CLEANUP: Explicitly release memory after agent run completes
        try:
            import gc
            # Force garbage collection to free memory from completed agent run
            collected = gc.collect()
            if collected > 0:
                logger.debug(f"Garbage collected {collected} objects after agent run {agent_run_id}")
        except Exception as gc_error:
            logger.debug(f"Garbage collection error (non-critical): {gc_error}")

        # All stream writes are synchronous now, no pending operations to await

        logger.debug(f"Agent run background task fully completed for: {agent_run_id} (Instance: {instance_id}) with final status: {final_status}")

async def cleanup_redis_keys_for_agent_run(agent_run_id: str, instance_id: Optional[str] = None):
    """
    Comprehensive cleanup of all Redis keys associated with an agent run.
    
    This function cleans up:
    - Response stream (deleted immediately)
    - Run lock key
    - Instance active key (if instance_id provided)
    - Any other instance active keys for this agent run
    
    Args:
        agent_run_id: The ID of the agent run to clean up
        instance_id: Optional instance ID for instance-specific cleanup
    """
    logger.debug(f"Cleaning up Redis keys for agent run: {agent_run_id}")
    
    # List of keys to delete
    keys_to_delete = []
    
    # Response stream - delete immediately
    stream_key = f"agent_run:{agent_run_id}:stream"
    keys_to_delete.append(stream_key)
    
    # Run lock key
    run_lock_key = f"agent_run_lock:{agent_run_id}"
    keys_to_delete.append(run_lock_key)
    
    # Instance-specific active key (if instance_id provided)
    if instance_id:
        instance_active_key = f"active_run:{instance_id}:{agent_run_id}"
        keys_to_delete.append(instance_active_key)
    
    # Delete all keys
    for key in keys_to_delete:
        try:
            deleted = await redis.delete(key)
            if deleted:
                logger.debug(f"Deleted Redis key: {key}")
        except Exception as e:
            logger.warning(f"Failed to delete Redis key {key}: {str(e)}")
    
    # Also find and clean up any other instance active keys for this agent run
    # (in case there are stale keys from other instances)
    try:
        # Use scan_keys instead of keys() to avoid blocking Redis
        instance_keys = await redis.scan_keys(f"active_run:*:{agent_run_id}")
        for key in instance_keys:
            # Decode bytes if needed
            key_str = key.decode('utf-8') if isinstance(key, bytes) else key
            if key_str not in keys_to_delete:
                try:
                    await redis.delete(key_str)
                    logger.debug(f"Deleted stale instance active key: {key_str}")
                except Exception as e:
                    logger.warning(f"Failed to delete stale instance active key {key_str}: {str(e)}")
    except Exception as e:
        logger.warning(f"Failed to find and clean up instance active keys for {agent_run_id}: {str(e)}")
    
    logger.debug(f"Completed Redis cleanup for agent run: {agent_run_id}")


async def update_agent_run_status(
    client,
    agent_run_id: str,
    status: str,
    error: Optional[str] = None,
    account_id: Optional[str] = None,
) -> bool:
    try:
        update_data = {
            "status": status,
            "completed_at": datetime.now(timezone.utc).isoformat()
        }

        if error:
            update_data["error"] = error

        for retry in range(3):
            try:
                update_result = await client.table('agent_runs').update(update_data).eq("id", agent_run_id).execute()

                if hasattr(update_result, 'data') and update_result.data:
                    verify_result = await client.table('agent_runs').select('status', 'completed_at').eq("id", agent_run_id).execute()
                    if verify_result.data:
                        actual_status = verify_result.data[0].get('status')
                        completed_at = verify_result.data[0].get('completed_at')
                    
                    if account_id:
                        try:
                            from core.runtime_cache import invalidate_running_runs_cache
                            await invalidate_running_runs_cache(account_id)
                        except Exception as cache_error:
                            logger.warning(f"Failed to invalidate running runs cache: {cache_error}")
                        
                        # Invalidate account-state cache to refresh concurrent runs limit
                        try:
                            from core.billing.shared.cache_utils import invalidate_account_state_cache
                            await invalidate_account_state_cache(account_id)
                        except Exception as cache_error:
                            logger.warning(f"Failed to invalidate account-state cache: {cache_error}")
                    
                    return True
                else:
                    logger.warning(f"Database update returned no data for agent run {agent_run_id} on retry {retry}: {update_result}")
                    if retry == 2:
                        logger.error(f"Failed to update agent run status after all retries: {agent_run_id}")
                        return False
            except Exception as db_error:
                logger.error(f"Database error on retry {retry} updating status for {agent_run_id}: {str(db_error)}")
                if retry < 2:
                    await asyncio.sleep(0.5 * (2 ** retry))
                else:
                    logger.error(f"Failed to update agent run status after all retries: {agent_run_id}", exc_info=True)
                    return False
    except Exception as e:
        logger.error(f"Unexpected error updating agent run status for {agent_run_id}: {str(e)}", exc_info=True)
        return False

    return False
