"""
Simplified agent execution - direct execution without worker dispatch.

This module provides a simplified agent execution function that runs
directly in the API process as an async background task.
"""

import asyncio
import json
import time
from datetime import datetime, timezone
from typing import Optional, Dict, Any, Tuple

from core.services import redis
from core.services.supabase import DBConnection
from core.services.langfuse import langfuse
from core.utils.logger import logger, structlog
from core.worker.tool_output_streaming_context import (
    set_tool_output_streaming_context,
    clear_tool_output_streaming_context,
)

# TTL for Redis stream keys
REDIS_STREAM_TTL_SECONDS = 600  # 10 minutes

db = DBConnection()


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


async def stream_status_message(
    status: str,
    message: str,
    metadata: Optional[Dict[str, Any]] = None,
    stream_key: Optional[str] = None
) -> None:
    """Write a status message to Redis stream."""
    if not stream_key:
        from core.worker.tool_output_streaming_context import get_tool_output_streaming_context
        ctx = get_tool_output_streaming_context()
        if ctx:
            stream_key = ctx.stream_key
        else:
            return
    
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


async def ensure_project_metadata_cached(project_id: str) -> None:
    """
    Ensure project metadata (sandbox info) is cached. Non-blocking if already cached.
    """
    from core.cache.runtime_cache import get_cached_project_metadata, set_cached_project_metadata
    from core.threads import repo as threads_repo
    
    # Check cache first (fast path)
    cached_project = await get_cached_project_metadata(project_id)
    if cached_project is not None:  # Note: empty dict {} is valid cached value
        return
    
    try:
        # Single optimized query - fetch project with sandbox resource in one go
        project_data = await threads_repo.get_project_with_sandbox(project_id)
        
        if not project_data:
            # Project not found - cache empty dict to prevent repeated lookups
            logger.warning(f"Project {project_id} not found, caching empty metadata")
            await set_cached_project_metadata(project_id, {})
            return
        
        sandbox_info = {}
        
        # Extract sandbox info from joined resource data
        if project_data.get('resource_external_id'):
            resource_config = project_data.get('resource_config') or {}
            sandbox_info = {
                'id': project_data['resource_external_id'],
                **resource_config
            }
        
        await set_cached_project_metadata(project_id, sandbox_info)
        logger.debug(f"✅ Cached project metadata for {project_id} (has_sandbox={bool(sandbox_info)})")
        
    except Exception as e:
        # Non-fatal - log and cache empty to prevent repeated failures
        logger.warning(f"Failed to fetch project metadata for {project_id}: {e}")
        await set_cached_project_metadata(project_id, {})


async def process_agent_responses(
    agent_gen,
    agent_run_id: str,
    stream_key: str,
    trace,
    execution_start: float,
    stop_signal_checker_state: Dict[str, Any]
) -> Tuple[str, Optional[str], bool, int]:
    """Process agent responses and stream them to Redis."""
    final_status = "running"
    error_message = None
    first_response_logged = False
    complete_tool_called = False
    total_responses = 0
    stream_ttl_set = False
    
    async for response in agent_gen:
        if not first_response_logged:
            first_token_time = (time.time() - execution_start) * 1000
            logger.info(f"⏱️ FIRST RESPONSE from agent: {first_token_time:.1f}ms")
            first_response_logged = True
        
        if stop_signal_checker_state.get('stop_signal_received'):
            stop_reason = stop_signal_checker_state.get('stop_reason', 'external_stop_signal')
            logger.warning(f"🛑 Agent run {agent_run_id} stopped. Reason: {stop_reason}")
            final_status = "stopped"
            error_message = f"Stopped by {stop_reason}"
            trace.span(name="agent_run_stopped").end(status_message=f"stopped: {stop_reason}", level="WARNING")
            break

        from core.services.db import serialize_row
        if isinstance(response, dict):
            response = serialize_row(response)
        response_json = json.dumps(response)
        
        try:
            await redis.stream_add(stream_key, {"data": response_json}, maxlen=200, approximate=True)
            
            # Publish notification for instant delivery
            try:
                await redis.publish(f"{stream_key}:notify", response.get('type', 'message'))
            except Exception:
                pass
            
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
                    logger.debug(f"Agent run stopped: {response.get('message', 'Normal stop')}")
                break
    
    return final_status, error_message, complete_tool_called, total_responses


async def handle_normal_completion(
    agent_run_id: str,
    start_time: datetime,
    total_responses: int,
    stream_key: str,
    trace
) -> None:
    """Handle normal completion of an agent run."""
    duration = (datetime.now(timezone.utc) - start_time).total_seconds()
    logger.info(f"Agent run {agent_run_id} completed (duration: {duration:.2f}s, responses: {total_responses})")
    
    completion_message = {"type": "status", "status": "completed", "message": "Completed successfully"}
    trace.span(name="agent_run_completed").end(status_message="completed")
    
    try:
        await asyncio.wait_for(
            redis.stream_add(stream_key, {'data': json.dumps(completion_message)}, maxlen=200, approximate=True),
            timeout=5.0
        )
        try:
            await redis.publish(f"{stream_key}:notify", "status")
        except Exception:
            pass
    except Exception as e:
        logger.warning(f"Failed to write completion message for {agent_run_id}: {e}")


async def update_agent_run_status(
    agent_run_id: str,
    status: str,
    error: Optional[str] = None,
    account_id: Optional[str] = None,
) -> bool:
    """Update agent run status in database using direct SQL."""
    from core.agents import repo as agents_repo
    
    try:
        success = await agents_repo.update_agent_run_status(
            agent_run_id=agent_run_id,
            status=status,
            error=error
        )

        if success:
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


async def send_completion_notification(thread_id: str, agent_config: Optional[Dict[str, Any]], complete_tool_called: bool):
    """Send completion notification if complete tool was called."""
    if not complete_tool_called:
        return
    
    try:
        from core.notifications.notification_service import notification_service
        from core.threads import repo as threads_repo
        
        async def get_thread_data():
            try:
                thread_info = await threads_repo.get_project_and_thread_info(thread_id)
                if thread_info:
                    task_name = thread_info.get('project_name') or 'Task'
                    account_id = thread_info.get('account_id')
                    return {'task_name': task_name, 'account_id': account_id}
            except Exception as e:
                logger.warning(f"Failed to get thread data for {thread_id}: {e}")
            return {'task_name': 'Task', 'account_id': None}
        
        notification_data = await get_thread_data()
        user_id = notification_data.get('account_id')
        if user_id:
            await notification_service.send_task_completion_notification(
                account_id=user_id,
                task_name=notification_data['task_name'],
                thread_id=thread_id,
                agent_name=agent_config.get('name') if agent_config else None,
                result_summary="Task completed successfully"
            )
    except Exception as e:
        logger.warning(f"Failed to send completion notification: {e}")


async def execute_agent_run_direct(
    agent_run_id: str,
    thread_id: str,
    project_id: str,
    model_name: str,
    agent_config: dict,
    account_id: str,
    cancellation_event: asyncio.Event
) -> None:
    """
    Execute agent run directly - SIMPLIFIED, no worker overhead.
    
    This function runs in the API process as an async background task.
    No distributed locking, no instance tracking, no worker coordination.
    """
    execution_start = time.time()
    
    structlog.contextvars.clear_contextvars()
    structlog.contextvars.bind_contextvars(
        agent_run_id=agent_run_id,
        thread_id=thread_id,
    )
    
    logger.info(f"🚀 Executing agent run directly: {agent_run_id}")
    
    stop_checker = None
    final_status = "failed"
    stream_key = f"agent_run:{agent_run_id}:stream"
    trace = None
    
    try:
        start_time = datetime.now(timezone.utc)
        
        await stream_status_message("initializing", "Starting execution...", stream_key=stream_key)
        await redis.verify_stream_writable(stream_key)
        
        from core.ai_models import model_manager
        effective_model = model_manager.resolve_model_id(model_name)
        
        trace = langfuse.trace(
            name="agent_run",
            id=agent_run_id,
            session_id=thread_id,
            metadata={"project_id": project_id}
        )
        
        stop_signal_checker_state = {'stop_signal_received': False, 'total_responses': 0, 'stop_reason': None}
        
        async def check_for_stop_signal():
            while not stop_signal_checker_state.get('stop_signal_received'):
                try:
                    if await redis.check_stop_signal(agent_run_id):
                        stop_signal_checker_state['stop_signal_received'] = True
                        stop_signal_checker_state['stop_reason'] = 'stop_signal_key'
                        cancellation_event.set()
                        break
                    await asyncio.sleep(0.5)
                except asyncio.CancelledError:
                    break
                except Exception:
                    await asyncio.sleep(1)
        
        stop_checker = asyncio.create_task(check_for_stop_signal())
        
        set_tool_output_streaming_context(
            agent_run_id=agent_run_id,
            stream_key=stream_key
        )
        
        # Lazy import to avoid circular dependency
        from core.run import run_agent
        
        agent_gen = run_agent(
            thread_id=thread_id,
            project_id=project_id,
            model_name=effective_model,
            agent_config=agent_config,
            trace=trace,
            cancellation_event=cancellation_event,
            account_id=account_id
        )
        
        final_status, error_message, complete_tool_called, total_responses = await process_agent_responses(
            agent_gen, agent_run_id, stream_key, trace, execution_start, stop_signal_checker_state
        )
        
        if final_status == "running":
            final_status = "completed"
            await handle_normal_completion(agent_run_id, start_time, total_responses, stream_key, trace)
            await send_completion_notification(thread_id, agent_config, complete_tool_called)
        
        stop_reason = stop_signal_checker_state.get('stop_reason')
        if stop_reason:
            final_status = "stopped"
        
        await update_agent_run_status(agent_run_id, final_status, error=error_message, account_id=account_id)
        
        if final_status == "stopped":
            try:
                await asyncio.wait_for(redis.set_stop_signal(agent_run_id), timeout=3.0)
                logger.warning(f"🛑 Set stop signal for {agent_run_id} (reason: {stop_reason or 'unknown'})")
            except Exception as e:
                logger.warning(f"Failed to set stop signal for {agent_run_id}: {e}")
        
        logger.info(f"✅ Agent run completed: {agent_run_id} | status={final_status}")
        
    except Exception as e:
        logger.error(f"Error in agent run {agent_run_id}: {e}", exc_info=True)
        await update_agent_run_status(agent_run_id, "failed", error=str(e), account_id=account_id)
        
    finally:
        clear_tool_output_streaming_context()
        
        if stop_checker and not stop_checker.done():
            stop_checker.cancel()
            try:
                await stop_checker
            except:
                pass
        
        # Cleanup Redis stream key (keep for a bit for SSE clients to catch up)
        try:
            await redis.expire(stream_key, REDIS_STREAM_TTL_SECONDS)
        except:
            pass
        
        # Queue memory extraction on success (only if memory is enabled)
        if final_status == "completed" and account_id:
            from core.utils.config import config
            if config.ENABLE_MEMORY:
                try:
                    from core.threads import repo as threads_repo
                    message_ids = await threads_repo.get_thread_messages_ids(thread_id)
                    if message_ids:
                        # Note: Memory extraction would need to be handled differently without worker dispatch
                        # For now, we'll skip it or handle it inline
                        logger.debug(f"Memory extraction skipped - would need alternative implementation")
                except Exception as e:
                    logger.warning(f"Failed to queue memory extraction: {e}")

