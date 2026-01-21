import os
import json
import asyncio
import time
from datetime import datetime, timezone
from typing import Optional, Dict, Any

import structlog

from core.utils.logger import logger
from core.services import redis
from core.services.langfuse import langfuse
from core.utils.tool_output_streaming import (
    set_tool_output_streaming_context,
    clear_tool_output_streaming_context,
)

from core.agents.runner.config import AgentConfig
from core.agents.runner.services import (
    REDIS_STREAM_TTL_SECONDS,
    STOP_CHECK_INTERVAL,
    stream_status_message,
    check_terminating_tool_call,
    update_agent_run_status,
    send_completion_notification,
)

USE_FAST_PIPELINE = True
USE_STATELESS_PIPELINE = os.getenv("USE_STATELESS_PIPELINE", "false").lower() == "true"

async def execute_agent_run(
    agent_run_id: str,
    thread_id: str,
    project_id: str,
    model_name: str,
    agent_config: dict,
    account_id: str,
    cancellation_event: asyncio.Event,
    is_new_thread: bool = False,
    user_message: Optional[str] = None
) -> None:
    if USE_STATELESS_PIPELINE:
        await execute_agent_run_stateless(
            agent_run_id=agent_run_id,
            thread_id=thread_id,
            project_id=project_id,
            model_name=model_name,
            agent_config=agent_config,
            account_id=account_id,
            cancellation_event=cancellation_event,
            is_new_thread=is_new_thread,
            user_message=user_message
        )
    elif USE_FAST_PIPELINE:
        await execute_agent_run_fast(
            agent_run_id=agent_run_id,
            thread_id=thread_id,
            project_id=project_id,
            model_name=model_name,
            agent_config=agent_config,
            account_id=account_id,
            cancellation_event=cancellation_event,
            is_new_thread=is_new_thread,
            user_message=user_message
        )
    else:
        await execute_agent_run_legacy(
            agent_run_id=agent_run_id,
            thread_id=thread_id,
            project_id=project_id,
            model_name=model_name,
            agent_config=agent_config,
            account_id=account_id,
            cancellation_event=cancellation_event,
            is_new_thread=is_new_thread
        )


async def execute_agent_run_stateless(
    agent_run_id: str,
    thread_id: str,
    project_id: str,
    model_name: str,
    agent_config: dict,
    account_id: str,
    cancellation_event: asyncio.Event,
    is_new_thread: bool = False,
    user_message: Optional[str] = None
) -> None:
    execution_start = time.time()

    structlog.contextvars.clear_contextvars()
    structlog.contextvars.bind_contextvars(agent_run_id=agent_run_id, thread_id=thread_id)

    logger.info(f"🚀 [STATELESS] Executing agent run: {agent_run_id}")

    stop_checker = None
    final_status = "failed"
    stream_key = f"agent_run:{agent_run_id}:stream"

    try:
        from datetime import datetime, timezone
        start_time = datetime.now(timezone.utc)

        await stream_status_message("initializing", "Starting stateless pipeline...", stream_key=stream_key)
        await redis.verify_stream_writable(stream_key)

        try:
            await redis.expire(stream_key, REDIS_STREAM_TTL_SECONDS)
        except Exception:
            pass

        from core.ai_models import model_manager
        effective_model = model_manager.resolve_model_id(model_name)

        stop_state = {'received': False, 'reason': None}

        async def check_stop():
            while not stop_state['received']:
                try:
                    if cancellation_event.is_set():
                        stop_state['received'] = True
                        stop_state['reason'] = 'cancellation_event'
                        logger.info(f"🛑 Stop detected via cancellation_event for {agent_run_id}")
                        break

                    if await redis.check_stop_signal(agent_run_id):
                        stop_state['received'] = True
                        stop_state['reason'] = 'stop_signal'
                        cancellation_event.set()
                        logger.info(f"🛑 Stop detected via Redis for {agent_run_id}")
                        break

                    await asyncio.sleep(STOP_CHECK_INTERVAL)
                except asyncio.CancelledError:
                    break
                except Exception:
                    await asyncio.sleep(5.0)

        stop_checker = asyncio.create_task(check_stop())

        set_tool_output_streaming_context(agent_run_id=agent_run_id, stream_key=stream_key)

        from core.agents.pipeline.context import PipelineContext
        from core.agents.pipeline.stateless import StatelessCoordinator

        ctx = PipelineContext(
            agent_run_id=agent_run_id,
            thread_id=thread_id,
            project_id=project_id,
            account_id=account_id,
            model_name=effective_model,
            agent_config=agent_config,
            is_new_thread=is_new_thread,
            cancellation_event=cancellation_event,
            stream_key=stream_key,
            user_message=user_message
        )

        coordinator = StatelessCoordinator()

        first_response = False
        complete_tool_called = False
        total_responses = 0
        stream_ttl_set = False
        error_message = None

        async for response in coordinator.execute(ctx):
            if cancellation_event.is_set() or stop_state['received']:
                logger.warning(f"🛑 Agent run stopped: {stop_state.get('reason', 'cancellation_event')}")
                final_status = "stopped"
                error_message = f"Stopped by {stop_state.get('reason', 'cancellation_event')}"
                break

            if not first_response:
                first_response_time_ms = (time.time() - execution_start) * 1000
                logger.info(f"⏱️ [STATELESS] FIRST RESPONSE: {first_response_time_ms:.1f}ms")
                first_response = True

                try:
                    timing_msg = {
                        "type": "timing",
                        "first_response_ms": round(first_response_time_ms, 1),
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                        "pipeline": "stateless"
                    }
                    await redis.stream_add(stream_key, {"data": json.dumps(timing_msg)}, maxlen=200, approximate=True)
                except Exception:
                    pass

            from core.services.db import serialize_row
            if isinstance(response, dict):
                response = serialize_row(response)
                if response.get('type') == 'assistant':
                    metadata = response.get('metadata', '')
                    if isinstance(metadata, str) and 'complete' in metadata:
                        logger.debug(f"[STREAM] Sending assistant complete: message_id={response.get('message_id')}")

            try:
                await redis.stream_add(stream_key, {"data": json.dumps(response)}, maxlen=200, approximate=True)

                if not stream_ttl_set:
                    try:
                        await asyncio.wait_for(redis.expire(stream_key, REDIS_STREAM_TTL_SECONDS), timeout=2.0)
                        stream_ttl_set = True
                    except:
                        pass
            except Exception as e:
                logger.warning(f"Failed to write to stream: {e}")

            total_responses += 1

            terminating = check_terminating_tool_call(response)
            if terminating == 'complete':
                complete_tool_called = True

            if response.get('type') == 'status':
                status = response.get('status')
                if status in ['completed', 'failed', 'stopped', 'error']:
                    final_status = status if status != 'error' else 'failed'
                    if status in ['failed', 'error']:
                        error_message = response.get('message') or response.get('error')
                        logger.error(f"[STATELESS] Agent run error: {error_message}")
                    break

            if response.get('type') == 'error':
                final_status = 'failed'
                error_message = response.get('error')
                logger.error(f"[STATELESS] Agent run error: {error_message}")
                break

        if final_status == "failed" and not error_message:
            final_status = "completed"
            duration = (datetime.now(timezone.utc) - start_time).total_seconds()
            logger.info(f"[STATELESS] Agent run completed (duration: {duration:.2f}s, responses: {total_responses})")

            completion_msg = {"type": "status", "status": "completed", "message": "Completed successfully"}
            try:
                await redis.stream_add(stream_key, {'data': json.dumps(completion_msg)}, maxlen=200, approximate=True)
            except:
                pass

            await send_completion_notification(thread_id, agent_config, complete_tool_called)

        if stop_state['reason']:
            final_status = "stopped"

        await update_agent_run_status(agent_run_id, final_status, error=error_message, account_id=account_id)

        logger.info(f"✅ [STATELESS] Agent run completed: {agent_run_id} | status={final_status}")

    except Exception as e:
        logger.error(f"[STATELESS] Error in agent run {agent_run_id}: {e}", exc_info=True)
        await update_agent_run_status(agent_run_id, "failed", error=str(e), account_id=account_id)

    finally:
        from core.utils.lifecycle_tracker import log_cleanup_error
        cleanup_errors = []

        try:
            clear_tool_output_streaming_context()
        except Exception as e:
            log_cleanup_error(agent_run_id, "streaming_context", e)
            cleanup_errors.append(f"streaming_context: {e}")

        if stop_checker and not stop_checker.done():
            try:
                stop_checker.cancel()
                await stop_checker
            except asyncio.CancelledError:
                pass
            except Exception as e:
                log_cleanup_error(agent_run_id, "stop_checker", e)
                cleanup_errors.append(f"stop_checker: {e}")

        try:
            await redis.expire(stream_key, REDIS_STREAM_TTL_SECONDS)
        except Exception as e:
            log_cleanup_error(agent_run_id, "redis_expire", e)
            cleanup_errors.append(f"redis_expire: {e}")

        if cleanup_errors:
            logger.error(
                f"[LIFECYCLE] CLEANUP_ERRORS agent_run={agent_run_id} "
                f"count={len(cleanup_errors)} errors={cleanup_errors}"
            )


async def execute_agent_run_fast(
    agent_run_id: str,
    thread_id: str,
    project_id: str,
    model_name: str,
    agent_config: dict,
    account_id: str,
    cancellation_event: asyncio.Event,
    is_new_thread: bool = False,
    user_message: Optional[str] = None
) -> None:
    execution_start = time.time()
    
    structlog.contextvars.clear_contextvars()
    structlog.contextvars.bind_contextvars(agent_run_id=agent_run_id, thread_id=thread_id)
    
    logger.info(f"🚀 [FAST] Executing agent run: {agent_run_id}")
    
    stop_checker = None
    final_status = "failed"
    stream_key = f"agent_run:{agent_run_id}:stream"
    
    try:
        start_time = datetime.now(timezone.utc)
        
        await stream_status_message("initializing", "Starting fast pipeline...", stream_key=stream_key)
        await redis.verify_stream_writable(stream_key)
        
        try:
            await redis.expire(stream_key, REDIS_STREAM_TTL_SECONDS)
        except Exception:
            pass
        
        from core.ai_models import model_manager
        effective_model = model_manager.resolve_model_id(model_name)
        
        stop_state = {'received': False, 'reason': None}
        
        async def check_stop():
            while not stop_state['received']:
                try:
                    if cancellation_event.is_set():
                        stop_state['received'] = True
                        stop_state['reason'] = 'cancellation_event'
                        logger.info(f"🛑 Stop detected via cancellation_event for {agent_run_id}")
                        break
                    
                    if await redis.check_stop_signal(agent_run_id):
                        stop_state['received'] = True
                        stop_state['reason'] = 'stop_signal'
                        cancellation_event.set()
                        logger.info(f"🛑 Stop detected via Redis for {agent_run_id}")
                        break
                    
                    await asyncio.sleep(STOP_CHECK_INTERVAL)
                except asyncio.CancelledError:
                    break
                except Exception:
                    await asyncio.sleep(5.0)
        
        stop_checker = asyncio.create_task(check_stop())
        
        set_tool_output_streaming_context(agent_run_id=agent_run_id, stream_key=stream_key)
        
        from core.agents.pipeline.context import PipelineContext
        from core.agents.pipeline.coordinator import PipelineCoordinator
        
        ctx = PipelineContext(
            agent_run_id=agent_run_id,
            thread_id=thread_id,
            project_id=project_id,
            account_id=account_id,
            model_name=effective_model,
            agent_config=agent_config,
            is_new_thread=is_new_thread,
            cancellation_event=cancellation_event,
            stream_key=stream_key,
            user_message=user_message
        )
        
        coordinator = PipelineCoordinator()
        
        first_response = False
        complete_tool_called = False
        total_responses = 0
        stream_ttl_set = False
        error_message = None
        
        async for response in coordinator.execute(ctx):
            if cancellation_event.is_set() or stop_state['received']:
                logger.warning(f"🛑 Agent run stopped: {stop_state.get('reason', 'cancellation_event')}")
                final_status = "stopped"
                error_message = f"Stopped by {stop_state.get('reason', 'cancellation_event')}"
                break
            
            if not first_response:
                first_response_time_ms = (time.time() - execution_start) * 1000
                logger.info(f"⏱️ [FAST] FIRST RESPONSE: {first_response_time_ms:.1f}ms")
                first_response = True
                
                try:
                    timing_msg = {
                        "type": "timing",
                        "first_response_ms": round(first_response_time_ms, 1),
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                        "pipeline": "fast"
                    }
                    await redis.stream_add(stream_key, {"data": json.dumps(timing_msg)}, maxlen=200, approximate=True)
                except Exception:
                    pass
            
            from core.services.db import serialize_row
            if isinstance(response, dict):
                response = serialize_row(response)
            
            try:
                await redis.stream_add(stream_key, {"data": json.dumps(response)}, maxlen=200, approximate=True)
                
                if not stream_ttl_set:
                    try:
                        await asyncio.wait_for(redis.expire(stream_key, REDIS_STREAM_TTL_SECONDS), timeout=2.0)
                        stream_ttl_set = True
                    except:
                        pass
            except Exception as e:
                logger.warning(f"Failed to write to stream: {e}")
            
            total_responses += 1
            
            terminating = check_terminating_tool_call(response)
            if terminating == 'complete':
                complete_tool_called = True
            
            if response.get('type') == 'status':
                status = response.get('status')
                if status in ['completed', 'failed', 'stopped', 'error']:
                    final_status = status if status != 'error' else 'failed'
                    if status in ['failed', 'error']:
                        error_message = response.get('message') or response.get('error')
                        logger.error(f"[FAST] Agent run error: {error_message}")
                    break
            
            if response.get('type') == 'error':
                final_status = 'failed'
                error_message = response.get('error')
                logger.error(f"[FAST] Agent run error: {error_message}")
                break
        
        if final_status == "failed" and not error_message:
            final_status = "completed"
            duration = (datetime.now(timezone.utc) - start_time).total_seconds()
            logger.info(f"[FAST] Agent run completed (duration: {duration:.2f}s, responses: {total_responses})")
            
            completion_msg = {"type": "status", "status": "completed", "message": "Completed successfully"}
            try:
                await redis.stream_add(stream_key, {'data': json.dumps(completion_msg)}, maxlen=200, approximate=True)
            except:
                pass
            
            await send_completion_notification(thread_id, agent_config, complete_tool_called)
        
        if stop_state['reason']:
            final_status = "stopped"
        
        await update_agent_run_status(agent_run_id, final_status, error=error_message, account_id=account_id)
        
        logger.info(f"✅ [FAST] Agent run completed: {agent_run_id} | status={final_status}")
        
    except Exception as e:
        logger.error(f"[FAST] Error in agent run {agent_run_id}: {e}", exc_info=True)
        await update_agent_run_status(agent_run_id, "failed", error=str(e), account_id=account_id)
        
    finally:
        from core.utils.lifecycle_tracker import log_cleanup_error
        cleanup_errors = []
        
        try:
            clear_tool_output_streaming_context()
        except Exception as e:
            log_cleanup_error(agent_run_id, "streaming_context", e)
            cleanup_errors.append(f"streaming_context: {e}")
        
        if stop_checker and not stop_checker.done():
            try:
                stop_checker.cancel()
                await stop_checker
            except asyncio.CancelledError:
                pass
            except Exception as e:
                log_cleanup_error(agent_run_id, "stop_checker", e)
                cleanup_errors.append(f"stop_checker: {e}")
        
        try:
            from core.agents.pipeline.task_registry import task_registry
            await task_registry.cancel_all(agent_run_id, reason="executor_cleanup")
        except Exception as e:
            log_cleanup_error(agent_run_id, "task_registry", e)
            cleanup_errors.append(f"task_registry: {e}")
        
        try:
            await redis.expire(stream_key, REDIS_STREAM_TTL_SECONDS)
        except Exception as e:
            log_cleanup_error(agent_run_id, "redis_expire", e)
            cleanup_errors.append(f"redis_expire: {e}")
        
        if cleanup_errors:
            logger.error(
                f"[LIFECYCLE] CLEANUP_ERRORS agent_run={agent_run_id} "
                f"count={len(cleanup_errors)} errors={cleanup_errors}"
            )


async def execute_agent_run_legacy(
    agent_run_id: str,
    thread_id: str,
    project_id: str,
    model_name: str,
    agent_config: dict,
    account_id: str,
    cancellation_event: asyncio.Event,
    is_new_thread: bool = False,
    user_message: Optional[str] = None
) -> None:
    execution_start = time.time()

    structlog.contextvars.clear_contextvars()
    structlog.contextvars.bind_contextvars(agent_run_id=agent_run_id, thread_id=thread_id)

    logger.info(f"🚀 Executing agent run: {agent_run_id}")

    stop_checker = None
    final_status = "failed"
    stream_key = f"agent_run:{agent_run_id}:stream"
    trace = None

    try:
        start_time = datetime.now(timezone.utc)

        await stream_status_message("initializing", "Starting execution...", stream_key=stream_key)
        await redis.verify_stream_writable(stream_key)

        try:
            await redis.expire(stream_key, REDIS_STREAM_TTL_SECONDS)
        except Exception:
            pass

        from core.ai_models import model_manager
        effective_model = model_manager.resolve_model_id(model_name)

        trace = langfuse.trace(
            name="agent_run",
            id=agent_run_id,
            session_id=thread_id,
            metadata={"project_id": project_id}
        )

        stop_state = {'received': False, 'reason': None}

        async def check_stop():
            while not stop_state['received']:
                try:
                    if cancellation_event.is_set():
                        stop_state['received'] = True
                        stop_state['reason'] = 'cancellation_event'
                        logger.info(f"🛑 Stop detected via cancellation_event for {agent_run_id}")
                        break

                    if await redis.check_stop_signal(agent_run_id):
                        stop_state['received'] = True
                        stop_state['reason'] = 'stop_signal'
                        cancellation_event.set()
                        logger.info(f"🛑 Stop detected via Redis for {agent_run_id}")
                        break

                    await asyncio.sleep(STOP_CHECK_INTERVAL)
                except asyncio.CancelledError:
                    break
                except Exception:
                    await asyncio.sleep(5.0)

        stop_checker = asyncio.create_task(check_stop())

        set_tool_output_streaming_context(agent_run_id=agent_run_id, stream_key=stream_key)

        from core.agents.runner.agent_runner import AgentRunner
        
        runner_config = AgentConfig(
            thread_id=thread_id,
            project_id=project_id,
            model_name=effective_model,
            agent_config=agent_config,
            trace=trace,
            account_id=account_id,
            is_new_thread=is_new_thread
        )

        runner = AgentRunner(runner_config)

        first_response = False
        complete_tool_called = False
        total_responses = 0
        stream_ttl_set = False
        error_message = None

        async for response in runner.run(cancellation_event=cancellation_event):
            if cancellation_event.is_set() or stop_state['received']:
                logger.warning(f"🛑 Agent run stopped: {stop_state.get('reason', 'cancellation_event')}")
                final_status = "stopped"
                error_message = f"Stopped by {stop_state.get('reason', 'cancellation_event')}"
                break

            if not first_response:
                first_response_time_ms = (time.time() - execution_start) * 1000
                logger.info(f"⏱️ FIRST RESPONSE: {first_response_time_ms:.1f}ms")
                first_response = True

                try:
                    timing_msg = {
                        "type": "timing",
                        "first_response_ms": round(first_response_time_ms, 1),
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                    }
                    await redis.stream_add(stream_key, {"data": json.dumps(timing_msg)}, maxlen=200, approximate=True)
                except Exception:
                    pass

            from core.services.db import serialize_row
            if isinstance(response, dict):
                response = serialize_row(response)

            try:
                await redis.stream_add(stream_key, {"data": json.dumps(response)}, maxlen=200, approximate=True)

                if not stream_ttl_set:
                    try:
                        await asyncio.wait_for(redis.expire(stream_key, REDIS_STREAM_TTL_SECONDS), timeout=2.0)
                        stream_ttl_set = True
                    except:
                        pass
            except Exception as e:
                logger.warning(f"Failed to write to stream: {e}")

            total_responses += 1

            terminating = check_terminating_tool_call(response)
            if terminating == 'complete':
                complete_tool_called = True

            if response.get('type') == 'status':
                status = response.get('status')
                if status in ['completed', 'failed', 'stopped', 'error']:
                    final_status = status if status != 'error' else 'failed'
                    if status in ['failed', 'error']:
                        error_message = response.get('message')
                    break

        if final_status == "failed" and not error_message:
            final_status = "completed"
            duration = (datetime.now(timezone.utc) - start_time).total_seconds()
            logger.info(f"Agent run completed (duration: {duration:.2f}s, responses: {total_responses})")

            completion_msg = {"type": "status", "status": "completed", "message": "Completed successfully"}
            try:
                await redis.stream_add(stream_key, {'data': json.dumps(completion_msg)}, maxlen=200, approximate=True)
            except:
                pass

            await send_completion_notification(thread_id, agent_config, complete_tool_called)

        if stop_state['reason']:
            final_status = "stopped"

        await update_agent_run_status(agent_run_id, final_status, error=error_message, account_id=account_id)

        logger.info(f"✅ Agent run completed: {agent_run_id} | status={final_status}")

    except Exception as e:
        logger.error(f"Error in agent run {agent_run_id}: {e}", exc_info=True)
        await update_agent_run_status(agent_run_id, "failed", error=str(e), account_id=account_id)

    finally:
        from core.utils.lifecycle_tracker import log_cleanup_error
        cleanup_errors = []

        try:
            clear_tool_output_streaming_context()
        except Exception as e:
            log_cleanup_error(agent_run_id, "streaming_context", e)
            cleanup_errors.append(f"streaming_context: {e}")

        if stop_checker and not stop_checker.done():
            try:
                stop_checker.cancel()
                await stop_checker
            except asyncio.CancelledError:
                pass
            except Exception as e:
                log_cleanup_error(agent_run_id, "stop_checker", e)
                cleanup_errors.append(f"stop_checker: {e}")

        try:
            await redis.expire(stream_key, REDIS_STREAM_TTL_SECONDS)
        except Exception as e:
            log_cleanup_error(agent_run_id, "redis_expire", e)
            cleanup_errors.append(f"redis_expire: {e}")

        if cleanup_errors:
            logger.error(
                f"[LIFECYCLE] CLEANUP_ERRORS agent_run={agent_run_id} "
                f"count={len(cleanup_errors)} errors={cleanup_errors}"
            )
