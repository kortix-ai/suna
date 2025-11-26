import dotenv
dotenv.load_dotenv(".env")

import sentry
import asyncio
import json
import traceback
from datetime import datetime, timezone
from typing import Optional
from core.services import redis_worker as redis
from core.run import run_agent
from core.utils.logger import logger, structlog
from core.utils.tool_discovery import warm_up_tools_cache
import dramatiq
import uuid
from core.agentpress.thread_manager import ThreadManager
from core.services.supabase import DBConnection
from dramatiq.brokers.redis import RedisBroker
from core.services.langfuse import langfuse
from core.utils.retry import retry
import os

import sentry_sdk
from typing import Dict, Any

# Get Redis configuration from centralized service
# Note: Using redis_worker for operations, but get_redis_config is shared
from core.services.redis import get_redis_config as _get_redis_config
redis_config = _get_redis_config()
redis_host = redis_config["host"]
redis_port = redis_config["port"]
redis_password = redis_config["password"]
redis_username = redis_config["username"]

# Configure Dramatiq broker using centralized Redis config
# Use URL format if username/password are provided (required for Redis Cloud)
if redis_config["url"]:
    auth_info = f" (user={redis_username})" if redis_username else ""
    logger.info(f"🔧 Configuring Dramatiq broker with Redis at {redis_host}:{redis_port}{auth_info}")
    redis_broker = RedisBroker(url=redis_config["url"], middleware=[dramatiq.middleware.AsyncIO()])
else:
    logger.info(f"🔧 Configuring Dramatiq broker with Redis at {redis_host}:{redis_port}")
    redis_broker = RedisBroker(host=redis_host, port=redis_port, middleware=[dramatiq.middleware.AsyncIO()])

dramatiq.set_broker(redis_broker)

# 🔥 WARMUP AT WORKER STARTUP (not on first request)
warm_up_tools_cache()
logger.info("✅ Worker process ready, tool cache warmed")

_initialized = False
db = DBConnection()
instance_id = ""

async def initialize():
    """Initialize async resources (Redis, DB) on first request.
    
    Note: Tool cache warmup already happened at module import time.
    """
    global db, instance_id, _initialized

    if _initialized:
        return  # Already initialized
    
    if not instance_id:
        instance_id = str(uuid.uuid4())[:8]
    
    logger.info(f"Initializing worker async resources with Redis at {redis_host}:{redis_port}")
    await retry(lambda: redis.initialize_async())
    await db.initialize()
    
    # Pre-load tool classes to avoid first-request delay
    from core.utils.tool_discovery import warm_up_tools_cache
    warm_up_tools_cache()
    
    # Pre-cache default Suna agent configs (eliminates 1+ second delay on first request)
    try:
        from core.runtime_cache import warm_up_suna_config_cache
        await warm_up_suna_config_cache()
    except Exception as e:
        logger.warning(f"Failed to pre-cache Suna configs (non-fatal): {e}")

    _initialized = True
    logger.info(f"✅ Worker async resources initialized successfully (instance: {instance_id})")

@dramatiq.actor
async def check_health(key: str):
    """Run the agent in the background using Redis for state."""
    structlog.contextvars.clear_contextvars()
    await redis.set(key, "healthy", ex=redis.REDIS_KEY_TTL)

@dramatiq.actor
async def run_agent_background(
    agent_run_id: str,
    thread_id: str,
    instance_id: str,
    project_id: str,
    model_name: str = "openai/gpt-5-mini",
    agent_id: Optional[str] = None,  # Changed from agent_config to agent_id
    account_id: Optional[str] = None,  # Account ID for authorization
    request_id: Optional[str] = None
):
    """Run the agent in the background using Redis for state."""
    import time
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

    # Idempotency check: prevent duplicate runs
    run_lock_key = f"agent_run_lock:{agent_run_id}"
    
    # Try to acquire a lock for this agent run
    lock_acquired = await redis.set(run_lock_key, instance_id, nx=True, ex=redis.REDIS_KEY_TTL)
    
    if not lock_acquired:
        # Lock exists - check if it's stale (previous worker crashed)
        existing_instance = await redis.get(run_lock_key)
        existing_instance_str = existing_instance.decode() if isinstance(existing_instance, bytes) else existing_instance if existing_instance else None
        
        if existing_instance_str:
            # Check if the instance that holds the lock is still alive
            instance_active_key = f"active_run:{existing_instance_str}:{agent_run_id}"
            instance_still_alive = await redis.get(instance_active_key)
            
            # Also check database status to see if run is actually running
            client = await db.client
            db_run_status = None
            try:
                run_result = await client.table('agent_runs').select('status').eq('id', agent_run_id).maybe_single().execute()
                if run_result.data:
                    db_run_status = run_result.data.get('status')
            except Exception as db_err:
                logger.warning(f"Failed to check database status for {agent_run_id}: {db_err}")
            
            # If instance is still alive OR run is still running in DB, skip
            if instance_still_alive or db_run_status == 'running':
                logger.info(f"Agent run {agent_run_id} is already being processed by instance {existing_instance_str}. Skipping duplicate execution.")
                return
            else:
                # Stale lock detected - the instance is dead and run is not running
                logger.warning(f"Stale lock detected for {agent_run_id} (instance {existing_instance_str} is dead, DB status: {db_run_status}). Attempting to acquire lock.")
                # Try to delete the stale lock and acquire it
                await redis.delete(run_lock_key)
                lock_acquired = await redis.set(run_lock_key, instance_id, nx=True, ex=redis.REDIS_KEY_TTL)
                if not lock_acquired:
                    # Race condition - another worker got it first
                    logger.info(f"Another worker acquired lock for {agent_run_id} while cleaning up stale lock. Skipping.")
                    return
        else:
            # Lock exists but no value, try to acquire again
            lock_acquired = await redis.set(run_lock_key, instance_id, nx=True, ex=redis.REDIS_KEY_TTL)
            if not lock_acquired:
                logger.info(f"Agent run {agent_run_id} is already being processed by another instance. Skipping duplicate execution.")
                return

    sentry.sentry.set_tag("thread_id", thread_id)
    
    timings['lock_acquisition'] = (time.time() - worker_start) * 1000 - timings['initialize']
    logger.info(f"⏱️ [TIMING] Worker init: {timings['initialize']:.1f}ms | Lock: {timings['lock_acquisition']:.1f}ms")

    logger.info(f"Starting background agent run: {agent_run_id} for thread: {thread_id} (Instance: {instance_id})")
    
    from core.ai_models import model_manager

    effective_model = model_manager.resolve_model_id(model_name)
    
    logger.info(f"🚀 Using model: {effective_model}")
    
    client = await db.client
    start_time = datetime.now(timezone.utc)
    total_responses = 0
    pubsub = None
    stop_checker = None
    stop_signal_received = False
    
    # Create cancellation event to signal LLM to stop
    cancellation_event = asyncio.Event()

    # Define Redis keys and channels
    response_list_key = f"agent_run:{agent_run_id}:responses"
    response_channel = f"agent_run:{agent_run_id}:new_response"
    instance_control_channel = f"agent_run:{agent_run_id}:control:{instance_id}"
    global_control_channel = f"agent_run:{agent_run_id}:control"
    instance_active_key = f"active_run:{instance_id}:{agent_run_id}"

    async def check_for_stop_signal():
        nonlocal stop_signal_received
        if not pubsub: return
        try:
            while not stop_signal_received:
                message = await pubsub.get_message(ignore_subscribe_messages=True, timeout=0.5)
                if message and message.get("type") == "message":
                    data = message.get("data")
                    if isinstance(data, bytes): data = data.decode('utf-8')
                    if data == "STOP":
                        logger.debug(f"Received STOP signal for agent run {agent_run_id} (Instance: {instance_id})")
                        stop_signal_received = True
                        # Set cancellation event to stop LLM execution immediately
                        cancellation_event.set()
                        break
                # Periodically refresh the active run key TTL
                if total_responses % 50 == 0: # Refresh every 50 responses or so
                    try: await redis.expire(instance_active_key, redis.REDIS_KEY_TTL)
                    except Exception as ttl_err: logger.warning(f"Failed to refresh TTL for {instance_active_key}: {ttl_err}")
                await asyncio.sleep(0.1) # Short sleep to prevent tight loop
        except asyncio.CancelledError:
            logger.debug(f"Stop signal checker cancelled for {agent_run_id} (Instance: {instance_id})")
        except Exception as e:
            logger.error(f"Error in stop signal checker for {agent_run_id}: {e}", exc_info=True)
            stop_signal_received = True # Stop the run if the checker fails

    trace = langfuse.trace(name="agent_run", id=agent_run_id, session_id=thread_id, metadata={"project_id": project_id, "instance_id": instance_id})

    try:
        # Setup Pub/Sub listener for control signals
        pubsub = await redis.create_pubsub()
        try:
            await retry(lambda: pubsub.subscribe(instance_control_channel, global_control_channel))
        except Exception as e:
            logger.error(f"Redis failed to subscribe to control channels: {e}", exc_info=True)
            raise e

        logger.info(f"Subscribed to control channels: {instance_control_channel}, {global_control_channel}")
        stop_checker = asyncio.create_task(check_for_stop_signal())

        # Ensure active run key exists and has TTL
        await redis.set(instance_active_key, "running", ex=redis.REDIS_KEY_TTL)

        # Fetch agent_config from agent_id if provided (with caching)
        agent_config = None
        if agent_id:
            t = time.time()
            try:
                # First check if this is a Suna agent (static config in memory)
                from core.runtime_cache import (
                    get_static_suna_config, 
                    get_cached_user_mcps,
                    get_cached_agent_config
                )
                
                static_config = get_static_suna_config()
                
                # Check if this agent is Suna (we can detect by checking if static config exists
                # and trying to get user MCPs for this agent)
                cached_mcps = await get_cached_user_mcps(agent_id)
                
                if static_config and cached_mcps is not None:
                    # This is a Suna agent - use static config + cached MCPs
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
                    # Try custom agent cache
                    cached_config = await get_cached_agent_config(agent_id)
                    
                    if cached_config:
                        agent_config = cached_config
                        logger.info(f"⏱️ [TIMING] ⚡ Custom agent config from cache: {(time.time() - t) * 1000:.1f}ms")
                    elif account_id:
                        # Cache miss - load from DB with proper account_id
                        from core.agent_loader import get_agent_loader
                        loader = await get_agent_loader()
                        
                        agent_data = await loader.load_agent(agent_id, account_id, load_config=True)
                        agent_config = agent_data.to_dict()
                        logger.info(f"⏱️ [TIMING] Agent config from DB (cached for next time): {(time.time() - t) * 1000:.1f}ms")
                    else:
                        # No account_id and cache miss - try loading without access check for public agents
                        from core.agent_loader import get_agent_loader
                        loader = await get_agent_loader()
                        
                        # Use a special system load that bypasses access check for public agents
                        agent_data = await loader.load_agent(agent_id, agent_id, load_config=True)
                        agent_config = agent_data.to_dict()
                        logger.info(f"⏱️ [TIMING] Agent config from DB (public agent): {(time.time() - t) * 1000:.1f}ms")
            except Exception as e:
                logger.warning(f"Failed to fetch agent config for agent_id {agent_id}: {e}. Using default config.")

        # Initialize agent generator with cancellation event
        t = time.time()
        agent_gen = run_agent(
            thread_id=thread_id, project_id=project_id,
            model_name=effective_model,
            agent_config=agent_config,
            trace=trace,
            cancellation_event=cancellation_event,
            account_id=account_id,  # Skip thread query in setup() - already have account_id
        )
        
        # Log total time from worker start to first iteration ready
        total_to_ready = (time.time() - worker_start) * 1000
        logger.info(f"⏱️ [TIMING] 🏁 Worker ready for first LLM call: {total_to_ready:.1f}ms from job start")

        final_status = "running"
        error_message = None
        first_response_logged = False

        # Push each response immediately for lowest latency streaming
        # Semaphore in redis_worker limits concurrent operations to prevent connection exhaustion
        pending_redis_operations = []

        async for response in agent_gen:
            # Log time to first response
            if not first_response_logged:
                first_token_time = (time.time() - worker_start) * 1000
                logger.info(f"⏱️ [TIMING] 🎯 FIRST RESPONSE from agent: {first_token_time:.1f}ms from job start")
                first_response_logged = True
            if stop_signal_received:
                logger.debug(f"Agent run {agent_run_id} stopped by signal.")
                final_status = "stopped"
                trace.span(name="agent_run_stopped").end(status_message="agent_run_stopped", level="WARNING")
                break

            # Push response immediately to Redis for real-time streaming
            # Semaphore in redis_worker ensures we don't exhaust connections
            response_json = json.dumps(response)
            pending_redis_operations.append(
                asyncio.create_task(redis.rpush(response_list_key, response_json))
            )
            # Publish notification immediately so stream endpoint picks it up right away
            pending_redis_operations.append(
                asyncio.create_task(redis.publish(response_channel, "new"))
            )
            total_responses += 1

            # Check for agent-signaled completion or error
            if response.get('type') == 'status':
                 status_val = response.get('status')
                 # logger.debug(f"Agent status: {status_val}")
                 
                 if status_val in ['completed', 'failed', 'stopped', 'error']:
                     logger.info(f"Agent run {agent_run_id} finished with status: {status_val}")
                     final_status = status_val if status_val != 'error' else 'failed'
                     if status_val in ['failed', 'stopped', 'error']:
                         error_message = response.get('message', f"Run ended with status: {status_val}")
                         logger.error(f"Agent run failed: {error_message}")
                     break

        # All responses already pushed immediately above - no batch to flush

        # If loop finished without explicit completion/error/stop signal, mark as completed
        if final_status == "running":
             final_status = "completed"
             duration = (datetime.now(timezone.utc) - start_time).total_seconds()
             logger.info(f"Agent run {agent_run_id} completed normally (duration: {duration:.2f}s, responses: {total_responses})")
             completion_message = {"type": "status", "status": "completed", "message": "Agent run completed successfully"}
             trace.span(name="agent_run_completed").end(status_message="agent_run_completed")
             await redis.rpush(response_list_key, json.dumps(completion_message))
             await redis.publish(response_channel, "new")
             
             try:
                 from core.notifications.notification_service import notification_service
                 thread_info = await client.table('threads').select('account_id').eq('thread_id', thread_id).maybe_single().execute()
                 if thread_info and thread_info.data:
                     account_id = thread_info.data.get('account_id')
                     if account_id:
                         await notification_service.send_task_completion_notification(
                             user_id=account_id,
                             task_name=agent_config.get('name', 'Task') if agent_config else 'Task',
                             thread_id=thread_id,
                             agent_name=agent_config.get('name') if agent_config else None,
                             result_summary="Task completed successfully"
                         )
             except Exception as notif_error:
                 logger.warning(f"Failed to send completion notification: {notif_error}")

        # Fetch final responses from Redis for DB update
        all_responses_json = await redis.lrange(response_list_key, 0, -1)
        all_responses = [json.loads(r) for r in all_responses_json]

        # Update DB status (pass account_id to invalidate running runs cache)
        await update_agent_run_status(client, agent_run_id, final_status, error=error_message, account_id=account_id)

        # Send failure notification if agent signaled failure
        if final_status == "failed" and error_message:
            try:
                from core.notifications.notification_service import notification_service
                thread_info = await client.table('threads').select('account_id').eq('thread_id', thread_id).maybe_single().execute()
                if thread_info and thread_info.data:
                    user_id = thread_info.data.get('account_id')
                    if user_id:
                        await notification_service.send_task_failed_notification(
                            user_id=user_id,
                            task_name=agent_config.get('name', 'Task') if agent_config else 'Task',
                            task_url=f"/thread/{thread_id}",
                            failure_reason=error_message,
                            first_name='User'
                        )
            except Exception as notif_error:
                logger.warning(f"Failed to send failure notification: {notif_error}")

        # Publish final control signal (END_STREAM or ERROR)
        control_signal = "END_STREAM" if final_status == "completed" else "ERROR" if final_status == "failed" else "STOP"
        try:
            await redis.publish(global_control_channel, control_signal)
            # No need to publish to instance channel as the run is ending on this instance
            logger.debug(f"Published final control signal '{control_signal}' to {global_control_channel}")
        except Exception as e:
            logger.warning(f"Failed to publish final control signal {control_signal}: {str(e)}")

    except Exception as e:
        error_message = str(e)
        traceback_str = traceback.format_exc()
        duration = (datetime.now(timezone.utc) - start_time).total_seconds()
        logger.error(f"Error in agent run {agent_run_id} after {duration:.2f}s: {error_message}\n{traceback_str} (Instance: {instance_id})")
        final_status = "failed"
        trace.span(name="agent_run_failed").end(status_message=error_message, level="ERROR")
        
        try:
            from core.notifications.notification_service import notification_service
            thread_info = await client.table('threads').select('account_id').eq('thread_id', thread_id).maybe_single().execute()
            if thread_info and thread_info.data:
                user_id = thread_info.data.get('account_id')
                if user_id:
                    await notification_service.send_task_failed_notification(
                        user_id=user_id,
                        task_name=agent_config.get('name', 'Task') if agent_config else 'Task',
                        task_url=f"/thread/{thread_id}",
                        failure_reason=error_message,
                        first_name='User'
                    )
        except Exception as notif_error:
            logger.warning(f"Failed to send failure notification: {notif_error}")

        error_response = {"type": "status", "status": "error", "message": error_message}
        try:
            await redis.rpush(response_list_key, json.dumps(error_response))
            await redis.publish(response_channel, "new")
        except Exception as redis_err:
             logger.error(f"Failed to push error response to Redis for {agent_run_id}: {redis_err}")

        # Update DB status (pass account_id to invalidate running runs cache)
        await update_agent_run_status(client, agent_run_id, "failed", error=f"{error_message}\n{traceback_str}", account_id=account_id)

        try:
            await redis.publish(global_control_channel, "ERROR")
            logger.debug(f"Published ERROR signal to {global_control_channel}")
        except Exception as e:
            logger.warning(f"Failed to publish ERROR signal: {str(e)}")

    finally:
        # Cleanup stop checker task
        if stop_checker and not stop_checker.done():
            stop_checker.cancel()
            try: await stop_checker
            except asyncio.CancelledError: pass
            except Exception as e: logger.warning(f"Error during stop_checker cancellation: {e}")

        # Close pubsub connection - ensure it always happens
        if pubsub:
            pubsub_cleaned = False
            try:
                await pubsub.unsubscribe()
                await pubsub.close()
                pubsub_cleaned = True
                logger.debug(f"Closed pubsub connection for {agent_run_id}")
            except asyncio.CancelledError:
                # Still cleanup on cancellation
                if not pubsub_cleaned:
                    try:
                        await pubsub.unsubscribe()
                        await pubsub.close()
                        logger.debug(f"Closed pubsub connection after cancellation for {agent_run_id}")
                    except Exception:
                        pass  # Ignore errors during cancellation cleanup
            except Exception as e:
                logger.warning(f"Error closing pubsub for {agent_run_id}: {str(e)}")

        # Set TTL on the response list in Redis
        await _cleanup_redis_response_list(agent_run_id)

        # Remove the instance-specific active run key
        await _cleanup_redis_instance_key(agent_run_id, instance_id)

        # Clean up the run lock
        await _cleanup_redis_run_lock(agent_run_id)

        # Wait for all pending redis operations to complete, with timeout
        try:
            await asyncio.wait_for(asyncio.gather(*pending_redis_operations), timeout=30.0)
        except asyncio.TimeoutError:
            logger.warning(f"Timeout waiting for pending Redis operations for {agent_run_id}")

        logger.debug(f"Agent run background task fully completed for: {agent_run_id} (Instance: {instance_id}) with final status: {final_status}")

async def _cleanup_redis_instance_key(agent_run_id: str, instance_id: str):
    """Clean up the instance-specific Redis key for an agent run."""
    if not instance_id:
        logger.warning("Instance ID not set, cannot clean up instance key.")
        return
    key = f"active_run:{instance_id}:{agent_run_id}"
    # logger.debug(f"Cleaning up Redis instance key: {key}")
    try:
        await redis.delete(key)
        # logger.debug(f"Successfully cleaned up Redis key: {key}")
    except Exception as e:
        logger.warning(f"Failed to clean up Redis key {key}: {str(e)}")

async def _cleanup_redis_run_lock(agent_run_id: str):
    """Clean up the run lock Redis key for an agent run."""
    run_lock_key = f"agent_run_lock:{agent_run_id}"
    # logger.debug(f"Cleaning up Redis run lock key: {run_lock_key}")
    try:
        await redis.delete(run_lock_key)
        # logger.debug(f"Successfully cleaned up Redis run lock key: {run_lock_key}")
    except Exception as e:
        logger.warning(f"Failed to clean up Redis run lock key {run_lock_key}: {str(e)}")

# TTL for Redis response lists (24 hours)
REDIS_RESPONSE_LIST_TTL = 3600 * 24

async def _cleanup_redis_response_list(agent_run_id: str):
    """Set TTL on the Redis response list."""
    response_list_key = f"agent_run:{agent_run_id}:responses"
    try:
        await redis.expire(response_list_key, REDIS_RESPONSE_LIST_TTL)
        # logger.debug(f"Set TTL ({REDIS_RESPONSE_LIST_TTL}s) on response list: {response_list_key}")
    except Exception as e:
        logger.warning(f"Failed to set TTL on response list {response_list_key}: {str(e)}")

async def update_agent_run_status(
    client,
    agent_run_id: str,
    status: str,
    error: Optional[str] = None,
    account_id: Optional[str] = None,
) -> bool:
    """
    Centralized function to update agent run status.
    Returns True if update was successful.
    
    If account_id is provided, invalidates the running runs cache for that account.
    """
    try:
        update_data = {
            "status": status,
            "completed_at": datetime.now(timezone.utc).isoformat()
        }

        if error:
            update_data["error"] = error

        # Retry up to 3 times
        for retry in range(3):
            try:
                update_result = await client.table('agent_runs').update(update_data).eq("id", agent_run_id).execute()

                if hasattr(update_result, 'data') and update_result.data:
                    # logger.debug(f"Successfully updated agent run {agent_run_id} status to '{status}' (retry {retry})")

                    # Verify the update
                    verify_result = await client.table('agent_runs').select('status', 'completed_at').eq("id", agent_run_id).execute()
                    if verify_result.data:
                        actual_status = verify_result.data[0].get('status')
                        completed_at = verify_result.data[0].get('completed_at')
                        # logger.debug(f"Verified agent run update: status={actual_status}, completed_at={completed_at}")
                    
                    # Invalidate running runs cache so next check gets fresh data
                    if account_id:
                        try:
                            from core.runtime_cache import invalidate_running_runs_cache
                            await invalidate_running_runs_cache(account_id)
                        except Exception as cache_error:
                            logger.warning(f"Failed to invalidate running runs cache: {cache_error}")
                    
                    return True
                else:
                    logger.warning(f"Database update returned no data for agent run {agent_run_id} on retry {retry}: {update_result}")
                    if retry == 2:  # Last retry
                        logger.error(f"Failed to update agent run status after all retries: {agent_run_id}")
                        return False
            except Exception as db_error:
                logger.error(f"Database error on retry {retry} updating status for {agent_run_id}: {str(db_error)}")
                if retry < 2:  # Not the last retry yet
                    await asyncio.sleep(0.5 * (2 ** retry))  # Exponential backoff
                else:
                    logger.error(f"Failed to update agent run status after all retries: {agent_run_id}", exc_info=True)
                    return False
    except Exception as e:
        logger.error(f"Unexpected error updating agent run status for {agent_run_id}: {str(e)}", exc_info=True)
        return False

    return False
