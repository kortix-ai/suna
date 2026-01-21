import asyncio
import time
import uuid
from typing import Dict, Any, AsyncGenerator

from core.utils.logger import logger
from core.agents.pipeline.context import PipelineContext
from core.agents.pipeline.stateless.state import RunState
from core.agents.pipeline.stateless.flusher import write_buffer
from core.agents.pipeline.stateless.ownership import ownership, idempotency
from core.agents.pipeline.stateless.lifecycle import lifecycle
from core.agents.pipeline.stateless.metrics import metrics
from core.agents.pipeline.ux_streaming import stream_prep_stage, stream_thinking

from .base import BaseCoordinator
from .message_builder import MessageBuilder
from .tool_executor import ToolExecutor
from .response_processor import ResponseProcessor
from .background_tasks import BackgroundTaskManager
from .execution import ExecutionEngine
from .auto_continue import AutoContinueChecker
from .initialization import ManagerInitializer


class StatelessCoordinator(BaseCoordinator):
    INIT_TIMEOUT = 10.0

    async def execute(self, ctx: PipelineContext, max_steps: int = 25) -> AsyncGenerator[Dict[str, Any], None]:
        start = time.time()
        self._thread_run_id = str(uuid.uuid4())

        if lifecycle.is_shutting_down:
            yield {"type": "error", "error": "Server shutting down", "error_code": "SHUTDOWN"}
            return

        try:
            await stream_prep_stage(ctx.stream_key, "initializing", "Setting up", 10)

            if not await ownership.claim(ctx.agent_run_id):
                yield {"type": "error", "error": "Run already claimed", "error_code": "ALREADY_CLAIMED"}
                return

            self._state = await RunState.create(ctx)
            await self._init_managers(ctx)
            await self._determine_effective_model(ctx)
            await self._load_prompt_and_tools(ctx)
            
            if ctx.user_message:
                user_msg = {
                    "role": "user",
                    "content": ctx.user_message,
                    "message_id": str(uuid.uuid4())
                }
                self._state._messages.append(user_msg)
                logger.info(f"[Coordinator] Added user message to state: {len(ctx.user_message)} chars")

            write_buffer.register(self._state)
            
            message_builder = MessageBuilder(
                increment_sequence=self._increment_sequence,
                get_thread_id=lambda: self._state.thread_id,
                get_thread_run_id=lambda: self._thread_run_id,
                get_agent_id=lambda: getattr(self._state, 'agent_id', None)
            )
            
            tool_executor = ToolExecutor(self._state, self._tool_registry, message_builder)
            response_processor = ResponseProcessor(self._state, message_builder, tool_executor)
            execution_engine = ExecutionEngine(self._state, response_processor)
            
            self._background_tasks = BackgroundTaskManager(self._state, ownership)
            self._background_tasks.start()

            metrics.record_run_started()
            await stream_prep_stage(ctx.stream_key, "ready", "Ready", 100)

            logger.info(f"[Coordinator] Started: {self._state.to_dict()}")

            async for chunk in self._execution_loop(ctx, execution_engine, max_steps):
                yield chunk

            duration = time.time() - start
            await self._finalize_execution(duration)

            status = "completed" if self._state.termination_reason == "completed" else "stopped"
            final_status_msg = {
                "type": "status",
                "status": status,
                "message": self._state.termination_reason or "completed"
            }
            
            logger.debug(f"[Coordinator] Yielding final status: {status}")
            yield final_status_msg

            if status == "completed":
                metrics.record_run_completed(duration)
            else:
                metrics.record_run_failed(duration)

            logger.info(f"[Coordinator] Done: {duration:.1f}s, {self._state.step} steps")

        except asyncio.CancelledError:
            if self._state:
                self._state.cancel()
            yield {"type": "status", "status": "stopped", "message": "Cancelled"}

        except Exception as e:
            logger.error(f"[Coordinator] Error: {e}", exc_info=True)
            if self._state:
                self._state._terminate(f"error: {str(e)[:100]}")
            metrics.record_run_failed(time.time() - start)
            yield {"type": "error", "error": str(e)[:200], "error_code": "PIPELINE_ERROR"}

        finally:
            await self._cleanup(ctx)

    async def _execution_loop(
        self, 
        ctx: PipelineContext, 
        execution_engine: ExecutionEngine, 
        max_steps: int
    ) -> AsyncGenerator[Dict[str, Any], None]:
        should_continue_loop = True
        auto_continue_count = 0

        while self._state.should_continue() and should_continue_loop:
            self._thread_run_id = str(uuid.uuid4())
            self._reset_sequence()
            
            step_start = time.time()
            step = self._state.next_step()

            if ctx.cancellation_event and ctx.cancellation_event.is_set():
                self._state.cancel()
                yield {"type": "status", "status": "stopped", "message": "Cancelled"}
                break

            if not await idempotency.check(ctx.agent_run_id, step, "llm"):
                continue

            await stream_thinking(ctx.stream_key)

            should_auto_continue = False
            force_terminate = False

            async for chunk in execution_engine.execute_step():
                yield chunk
                cont, term = AutoContinueChecker.check(chunk, auto_continue_count, max_steps)
                if term:
                    force_terminate = True
                if cont:
                    should_auto_continue = True

            await idempotency.mark_step(ctx.agent_run_id, step)
            metrics.record_step(time.time() - step_start)

            if force_terminate:
                self._state.complete()
                should_continue_loop = False
                break

            if not self._state.is_active:
                break

            if not should_auto_continue:
                self._state.complete()
                should_continue_loop = False
                break

            auto_continue_count += 1
            logger.debug(f"[Coordinator] Auto-continue #{auto_continue_count}")

            if auto_continue_count >= max_steps:
                self._state._terminate("max_auto_continues")
                break

    async def _init_managers(self, ctx: PipelineContext) -> None:
        self._thread_manager, self._tool_registry = await ManagerInitializer.init_managers(ctx)

    async def _determine_effective_model(self, ctx: PipelineContext) -> None:
        from core.ai_models import model_manager
        from core.ai_models.registry import BedrockConfig
        from core.agentpress.thread_manager.services.state.thread_state import ThreadState
        
        if model_manager.supports_vision(self._state.model_name):
            logger.debug(f"Model {self._state.model_name} supports vision, no switch needed")
            return
        
        has_images = await ThreadState.check_has_images(ctx.thread_id)
        
        if has_images:
            new_model = BedrockConfig.get_haiku_arn()
            logger.info(f"🖼️ Thread has images - switching from {self._state.model_name} to image model: {new_model}")
            self._state.model_name = new_model

    async def _load_prompt_and_tools(self, ctx: PipelineContext) -> None:
        await ManagerInitializer.load_prompt_and_tools(
            ctx, self._state, self._tool_registry, self._thread_manager
        )

    async def _finalize_execution(self, duration: float) -> None:
        if not self._state._terminated:
            self._state.complete()

        self._state.add_status_message(
            {"status_type": "thread_run_end"},
            {"thread_run_id": self._thread_run_id}
        )

        try:
            await self._state.flush()
            logger.debug("[Coordinator] Pre-status flush completed")
        except Exception as e:
            logger.warning(f"[Coordinator] Pre-status flush error: {e}")

        await asyncio.sleep(0.2)

    async def _cleanup(self, ctx: PipelineContext) -> None:
        cleanup_errors = []
        
        try:
            if hasattr(self, '_background_tasks'):
                errors = await self._background_tasks.stop()
                cleanup_errors.extend(errors)

            if self._state:
                try:
                    await self._state.cleanup()
                except Exception as e:
                    logger.warning(f"[Coordinator] State cleanup error: {e}")
                    cleanup_errors.append(f"state: {e}")
                write_buffer.unregister(self._state.run_id)

            status = "completed" if self._state and self._state.termination_reason == "completed" else "failed"
            try:
                await ownership.release(ctx.agent_run_id, status)
            except Exception as e:
                cleanup_errors.append(f"ownership: {e}")

            if self._thread_manager:
                try:
                    await self._thread_manager.cleanup()
                except Exception as e:
                    logger.warning(f"[Coordinator] ThreadManager cleanup error: {e}")
                    cleanup_errors.append(f"thread_manager: {e}")
                self._thread_manager = None

            self._tool_registry = None
            self._state = None
            
            if cleanup_errors:
                logger.warning(f"[Coordinator] Cleanup completed with errors: {cleanup_errors}")

        except Exception as e:
            logger.error(f"[Coordinator] Critical cleanup error: {e}", exc_info=True)