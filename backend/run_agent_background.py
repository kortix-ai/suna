import dotenv
dotenv.load_dotenv(".env")

import sentry
import asyncio
import json
import traceback
from datetime import datetime, timezone
from typing import Optional, Dict, Any, Tuple
from core.services import redis_worker as redis
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

redis_config = _get_redis_config()
redis_host = redis_config["host"]
redis_port = redis_config["port"]
redis_password = redis_config["password"]
redis_username = redis_config["username"]

if redis_config["url"]:
    auth_info = f" (user={redis_username})" if redis_username else ""
    logger.info(f"🔧 Configuring Dramatiq broker with Redis at {redis_host}:{redis_port}{auth_info}")
    redis_broker = RedisBroker(url=redis_config["url"], middleware=[dramatiq.middleware.AsyncIO()])
else:
    logger.info(f"🔧 Configuring Dramatiq broker with Redis at {redis_host}:{redis_port}")
    redis_broker = RedisBroker(host=redis_host, port=redis_port, middleware=[dramatiq.middleware.AsyncIO()])

dramatiq.set_broker(redis_broker)

warm_up_tools_cache()
logger.info("✅ Worker process ready, tool cache warmed")

_initialized = False
db = DBConnection()
instance_id = ""
# Response list TTL: 1 hour after run completes
# Users can reconnect to stream within 1 hour; after that, data is gone but
# the run results are persisted in the database anyway
REDIS_RESPONSE_LIST_TTL = 3600  # 1 hour (was 24h - too long, fills Redis)


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
    global db, instance_id, _initialized

    if _initialized:
        return
    
    if not instance_id:
        instance_id = str(uuid.uuid4())[:8]
    
    logger.info(f"Initializing worker async resources with Redis at {redis_host}:{redis_port}")
    await retry(lambda: redis.initialize_async())
    await db.initialize()
    
    from core.utils.tool_discovery import warm_up_tools_cache
    warm_up_tools_cache()
    
    try:
        from core.runtime_cache import warm_up_suna_config_cache
        await warm_up_suna_config_cache()
    except Exception as e:
        logger.warning(f"Failed to pre-cache Suna configs (non-fatal): {e}")

    _initialized = True
    logger.info(f"✅ Worker async resources initialized successfully (instance: {instance_id})")

@dramatiq.actor
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
        'response_list': f"agent_run:{agent_run_id}:responses",
        'response_channel': f"agent_run:{agent_run_id}:new_response",
        'instance_control_channel': f"agent_run:{agent_run_id}:control:{instance_id}",
        'global_control_channel': f"agent_run:{agent_run_id}:control",
        'instance_active': f"active_run:{instance_id}:{agent_run_id}"
    }


async def create_stop_signal_checker(pubsub, agent_run_id: str, instance_id: str, instance_active_key: str, cancellation_event: asyncio.Event):
    stop_signal_received = False
    total_responses = 0
    
    async def check_for_stop_signal():
        nonlocal stop_signal_received, total_responses
        if not pubsub:
            return
        try:
            while not stop_signal_received:
                message = await pubsub.get_message(ignore_subscribe_messages=True, timeout=0.5)
                if message and message.get("type") == "message":
                    data = message.get("data")
                    if isinstance(data, bytes):
                        data = data.decode('utf-8')
                    if data == "STOP":
                        logger.debug(f"Received STOP signal for agent run {agent_run_id} (Instance: {instance_id})")
                        stop_signal_received = True
                        cancellation_event.set()
                        break
                
                if total_responses % 50 == 0:
                    try:
                        await redis.expire(instance_active_key, redis.REDIS_KEY_TTL)
                    except Exception as ttl_err:
                        logger.warning(f"Failed to refresh TTL for {instance_active_key}: {ttl_err}")
                await asyncio.sleep(0.1)
        except asyncio.CancelledError:
            logger.debug(f"Stop signal checker cancelled for {agent_run_id} (Instance: {instance_id})")
        except Exception as e:
            # NOTE: Do NOT set stop_signal_received = True on errors - that was a bug!
            # Errors in the stop signal checker should not terminate the agent run
            logger.error(f"Error in stop signal checker for {agent_run_id}: {e}", exc_info=True)
            # Continue running - the agent should complete its work, not be stopped due to a pubsub error
    
    return check_for_stop_signal, stop_signal_received


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
    pending_redis_operations = []
    
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
        pending_redis_operations.append(
            asyncio.create_task(redis.rpush(redis_keys['response_list'], response_json))
        )
        pending_redis_operations.append(
            asyncio.create_task(redis.publish(redis_keys['response_channel'], "new"))
        )
        total_responses += 1
        stop_signal_checker_state['total_responses'] = total_responses
        
        # Safety: Set TTL on response list every 50 responses (in case worker crashes before cleanup)
        # This ensures data doesn't live forever if cleanup never runs
        if total_responses % 50 == 0:
            try:
                await redis.expire(redis_keys['response_list'], 3600)
            except Exception:
                pass  # Best effort, don't fail the run

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
    
    stop_signal_checker_state['pending_redis_operations'] = pending_redis_operations
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
    completion_message = {"type": "status", "status": "completed", "message": "Agent run completed successfully"}
    trace.span(name="agent_run_completed").end(status_message="agent_run_completed")
    await redis.rpush(redis_keys['response_list'], json.dumps(completion_message))
    await redis.publish(redis_keys['response_channel'], "new")
    return completion_message


async def publish_final_control_signal(final_status: str, global_control_channel: str, stop_reason: Optional[str] = None):
    control_signal = "END_STREAM" if final_status == "completed" else "ERROR" if final_status == "failed" else "STOP"
    try:
        await redis.publish(global_control_channel, control_signal)
        if control_signal == "STOP":
            logger.warning(f"🛑 Published final control signal '{control_signal}' to {global_control_channel} (status: {final_status}, reason: {stop_reason or 'unknown'})")
        else:
            logger.debug(f"Published final control signal '{control_signal}' to {global_control_channel} (status: {final_status})")
    except Exception as e:
        logger.warning(f"Failed to publish final control signal {control_signal}: {str(e)}")


async def cleanup_pubsub(pubsub, agent_run_id: str):
    if not pubsub:
        return
    
    pubsub_cleaned = False
    try:
        await pubsub.unsubscribe()
        await pubsub.close()
        pubsub_cleaned = True
        logger.debug(f"Closed pubsub connection for {agent_run_id}")
    except asyncio.CancelledError:
        if not pubsub_cleaned:
            try:
                await pubsub.unsubscribe()
                await pubsub.close()
                logger.debug(f"Closed pubsub connection after cancellation for {agent_run_id}")
            except Exception:
                pass
    except Exception as e:
        logger.warning(f"Error closing pubsub for {agent_run_id}: {str(e)}")

@dramatiq.actor
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
        logger.critical(f"Failed to initialize Redis connection: {e}")
        raise e
    timings['initialize'] = (time.time() - t) * 1000

    client = await db.client
    lock_acquired = await acquire_run_lock(agent_run_id, instance_id, client)
    if not lock_acquired:
        return

    sentry.sentry.set_tag("thread_id", thread_id)
    
    timings['lock_acquisition'] = (time.time() - worker_start) * 1000 - timings['initialize']
    logger.info(f"⏱️ [TIMING] Worker init: {timings['initialize']:.1f}ms | Lock: {timings['lock_acquisition']:.1f}ms")
    logger.info(f"Starting background agent run: {agent_run_id} for thread: {thread_id} (Instance: {instance_id})")
    
    from core.ai_models import model_manager
    effective_model = model_manager.resolve_model_id(model_name)
    logger.info(f"🚀 Using model: {effective_model}")
    
    start_time = datetime.now(timezone.utc)
    pubsub = None
    stop_checker = None
    pending_redis_operations = []
    cancellation_event = asyncio.Event()

    redis_keys = create_redis_keys(agent_run_id, instance_id)
    trace = langfuse.trace(
        name="agent_run",
        id=agent_run_id,
        session_id=thread_id,
        metadata={"project_id": project_id, "instance_id": instance_id}
    )

    try:
        pubsub = await redis.create_pubsub()
        try:
            await retry(lambda: pubsub.subscribe(
                redis_keys['instance_control_channel'],
                redis_keys['global_control_channel']
            ))
        except Exception as e:
            logger.error(f"Redis failed to subscribe to control channels: {e}", exc_info=True)
            raise e

        logger.info(f"Subscribed to control channels: {redis_keys['instance_control_channel']}, {redis_keys['global_control_channel']}")
        
        stop_signal_checker_state = {'stop_signal_received': False, 'total_responses': 0, 'stop_reason': None}
        check_stop_signal_fn, _ = await create_stop_signal_checker(
            pubsub, agent_run_id, instance_id, redis_keys['instance_active'], cancellation_event
        )
        
        async def check_for_stop_signal_wrapper():
            while not stop_signal_checker_state.get('stop_signal_received'):
                try:
                    message = await pubsub.get_message(ignore_subscribe_messages=True, timeout=0.5)
                    if message and message.get("type") == "message":
                        data = message.get("data")
                        channel = message.get("channel")
                        if isinstance(data, bytes):
                            data = data.decode('utf-8')
                        if isinstance(channel, bytes):
                            channel = channel.decode('utf-8')
                        if data == "STOP":
                            # Determine the source of the stop signal
                            if "control:" in channel and instance_id in channel:
                                stop_reason = "instance_control_channel"
                            else:
                                stop_reason = "global_control_channel"
                            logger.warning(f"🛑 Received STOP signal for agent run {agent_run_id} via {stop_reason} (Instance: {instance_id}, Channel: {channel})")
                            stop_signal_checker_state['stop_signal_received'] = True
                            stop_signal_checker_state['stop_reason'] = stop_reason
                            cancellation_event.set()
                            break
                    
                    if stop_signal_checker_state.get('total_responses', 0) % 50 == 0:
                        try:
                            await redis.expire(redis_keys['instance_active'], redis.REDIS_KEY_TTL)
                        except Exception as ttl_err:
                            logger.warning(f"Failed to refresh TTL for {redis_keys['instance_active']}: {ttl_err}")
                    await asyncio.sleep(0.1)
                except asyncio.CancelledError:
                    logger.debug(f"Stop signal checker wrapper cancelled for {agent_run_id}")
                    break
                except Exception as e:
                    # Do NOT stop the run due to pubsub errors - just log and continue
                    logger.error(f"Error in stop signal checker wrapper for {agent_run_id}: {e}", exc_info=True)
                    await asyncio.sleep(1)  # Back off on errors
        
        stop_checker = asyncio.create_task(check_for_stop_signal_wrapper())
        await redis.set(redis_keys['instance_active'], "running", ex=redis.REDIS_KEY_TTL)

        agent_config = await load_agent_config(agent_id, account_id)

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

        pending_redis_operations = stop_signal_checker_state.get('pending_redis_operations', [])

        if final_status == "running":
            final_status = "completed"
            await handle_normal_completion(agent_run_id, start_time, total_responses, redis_keys, trace)
            await send_completion_notification(client, thread_id, agent_config, complete_tool_called)
            if not complete_tool_called:
                logger.info(f"Agent run {agent_run_id} completed without explicit complete tool call - skipping notification")

        all_responses_json = await redis.lrange(redis_keys['response_list'], 0, -1)
        all_responses = [json.loads(r) for r in all_responses_json]

        await update_agent_run_status(client, agent_run_id, final_status, error=error_message, account_id=account_id)

        if final_status == "failed" and error_message:
            await send_failure_notification(client, thread_id, error_message)

        stop_reason = stop_signal_checker_state.get('stop_reason')
        await publish_final_control_signal(final_status, redis_keys['global_control_channel'], stop_reason=stop_reason)

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
            await redis.rpush(redis_keys['response_list'], json.dumps(error_response))
            await redis.publish(redis_keys['response_channel'], "new")
        except Exception as redis_err:
            logger.error(f"Failed to push error response to Redis for {agent_run_id}: {redis_err}")

        await update_agent_run_status(client, agent_run_id, "failed", error=f"{error_message}\n{traceback_str}", account_id=account_id)

        try:
            await redis.publish(redis_keys['global_control_channel'], "ERROR")
            logger.debug(f"Published ERROR signal to {redis_keys['global_control_channel']}")
        except Exception as e:
            logger.warning(f"Failed to publish ERROR signal: {str(e)}")

    finally:
        if stop_checker and not stop_checker.done():
            stop_checker.cancel()
            try:
                await stop_checker
            except asyncio.CancelledError:
                pass
            except Exception as e:
                logger.warning(f"Error during stop_checker cancellation: {e}")

        await cleanup_pubsub(pubsub, agent_run_id)
        await _cleanup_redis_response_list(agent_run_id)
        await _cleanup_redis_instance_key(agent_run_id, instance_id)
        await _cleanup_redis_run_lock(agent_run_id)

        try:
            await asyncio.wait_for(asyncio.gather(*pending_redis_operations), timeout=30.0)
        except asyncio.TimeoutError:
            logger.warning(f"Timeout waiting for pending Redis operations for {agent_run_id}")

        logger.debug(f"Agent run background task fully completed for: {agent_run_id} (Instance: {instance_id}) with final status: {final_status}")

async def _cleanup_redis_instance_key(agent_run_id: str, instance_id: str):
    if not instance_id:
        logger.warning("Instance ID not set, cannot clean up instance key.")
        return
    key = f"active_run:{instance_id}:{agent_run_id}"
    try:
        await redis.delete(key)
    except Exception as e:
        logger.warning(f"Failed to clean up Redis key {key}: {str(e)}")


async def _cleanup_redis_run_lock(agent_run_id: str):
    run_lock_key = f"agent_run_lock:{agent_run_id}"
    try:
        await redis.delete(run_lock_key)
    except Exception as e:
        logger.warning(f"Failed to clean up Redis run lock key {run_lock_key}: {str(e)}")


async def _cleanup_redis_response_list(agent_run_id: str):
    response_list_key = f"agent_run:{agent_run_id}:responses"
    try:
        await redis.expire(response_list_key, REDIS_RESPONSE_LIST_TTL)
    except Exception as e:
        logger.warning(f"Failed to set TTL on response list {response_list_key}: {str(e)}")

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
