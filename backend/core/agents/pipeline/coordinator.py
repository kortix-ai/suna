import asyncio
import time
import json
from typing import Dict, Any, List, Optional, AsyncGenerator
from datetime import datetime, timezone

from core.utils.logger import logger
from core.utils.config import config
from core.services import redis
from core.services.langfuse import langfuse

from core.agents.pipeline.context import (
    PipelineContext,
    PrepResult,
    AutoContinueState,
)
from core.agents.pipeline.task_registry import task_registry
from core.agents.pipeline import prep_tasks
from core.agents.pipeline.ux_streaming import (
    stream_prep_stage,
    stream_degradation,
    stream_thinking,
)


class PipelineCoordinator:
    PREP_TIMEOUT = 30.0
    LLM_TIMEOUT = 300.0
    
    def __init__(self):
        self._thread_manager = None
        self._tool_registry = None
        self._response_processor = None
        self._trace = None
        self._effective_model_name = None
    
    async def execute(
        self,
        ctx: PipelineContext,
        max_auto_continues: int = 25
    ) -> AsyncGenerator[Dict[str, Any], None]:
        execution_start = time.time()
        auto_state = AutoContinueState()
        
        try:
            prep_start = time.time()
            prep_result = await self._parallel_prep(ctx)
            
            prep_time_ms = (time.time() - prep_start) * 1000
            logger.info(f"⚡ [PIPELINE] Prep complete: {prep_time_ms:.1f}ms")
            
            if not prep_result.can_proceed:
                error_resp = prep_result.get_error_response()
                logger.warning(f"[PIPELINE] Cannot proceed: {error_resp.get('error')}")
                yield error_resp
                return
            
            while auto_state.active and auto_state.count < max_auto_continues:
                auto_state.active = False
                iteration_start = time.time()
                
                if ctx.cancellation_event and ctx.cancellation_event.is_set():
                    logger.info(f"🛑 Pipeline cancelled for {ctx.agent_run_id}")
                    yield {"type": "status", "status": "stopped", "message": "Cancelled"}
                    break
                
                if auto_state.count > 0:
                    lightweight_start = time.time()
                    prep_result = await self._lightweight_prep(ctx, prep_result)
                    logger.debug(f"⚡ [PIPELINE] Lightweight prep #{auto_state.count + 1}: {(time.time() - lightweight_start) * 1000:.1f}ms")
                    if not prep_result.can_proceed:
                        yield prep_result.get_error_response()
                        break
                
                llm_start = time.time()
                chunk_count = 0
                async for chunk in self._execute_llm_call(ctx, prep_result, auto_state):
                    chunk_count += 1
                    yield chunk
                    
                    should_continue, should_terminate = self._check_auto_continue(chunk, auto_state, max_auto_continues)
                    if should_terminate:
                        auto_state.active = False
                    elif should_continue:
                        auto_state.active = True
                
                iteration_time_ms = (time.time() - iteration_start) * 1000
                logger.debug(f"📊 [PIPELINE] Iteration #{auto_state.count + 1}: {iteration_time_ms:.1f}ms, {chunk_count} chunks")
                
                auto_state.count += 1
            
            total_time_ms = (time.time() - execution_start) * 1000
            logger.info(f"✅ [PIPELINE] Complete: {total_time_ms:.1f}ms total, {auto_state.count} iterations")
            
        except asyncio.CancelledError:
            logger.info(f"Pipeline cancelled: {ctx.agent_run_id}")
            yield {"type": "status", "status": "stopped", "message": "Cancelled"}
        except Exception as e:
            logger.error(f"Pipeline error: {e}", exc_info=True)
            yield {"type": "error", "error": str(e)[:200], "error_code": "PIPELINE_ERROR"}
        finally:
            await self._cleanup(ctx)
    
    async def _determine_effective_model(self, ctx: PipelineContext) -> None:
        from core.ai_models import model_manager
        from core.ai_models.registry import BedrockConfig
        from core.agentpress.thread_manager.services.state.thread_state import ThreadState
        
        self._effective_model_name = ctx.model_name
        
        if model_manager.supports_vision(ctx.model_name):
            logger.debug(f"Model {ctx.model_name} supports vision, no switch needed")
            return
        
        has_images = await ThreadState.check_has_images(ctx.thread_id)
        
        if has_images:
            new_model = BedrockConfig.get_haiku_arn()
            logger.info(f"🖼️ Thread has images - switching from {ctx.model_name} to Bedrock image model: {new_model}")
            self._effective_model_name = new_model
    
    async def _parallel_prep(self, ctx: PipelineContext) -> PrepResult:
        start = time.time()
        result = PrepResult()
        
        try:
            await stream_prep_stage(ctx.stream_key, "initializing", "Setting up managers", 10)
            await self._init_managers(ctx)
            await self._determine_effective_model(ctx)
            await stream_prep_stage(ctx.stream_key, "preparing", "Loading context", 30)
            
            tasks = {}
            
            tasks['billing'] = asyncio.create_task(
                prep_tasks.prep_billing(ctx.account_id, wait_for_cache_ms=3000)
            )
            await task_registry.register(ctx.agent_run_id, tasks['billing'], 'billing', critical=True)
            
            tasks['messages'] = asyncio.create_task(
                prep_tasks.prep_messages(ctx.thread_id)
            )
            await task_registry.register(ctx.agent_run_id, tasks['messages'], 'messages', critical=True)
            
            tasks['prompt'] = asyncio.create_task(
                prep_tasks.prep_prompt(
                    model_name=ctx.model_name,
                    agent_config=ctx.agent_config,
                    thread_id=ctx.thread_id,
                    account_id=ctx.account_id,
                    tool_registry=self._tool_registry,
                    mcp_loader=getattr(self._thread_manager, 'mcp_loader', None),
                    client=await self._thread_manager.db.client if self._thread_manager else None
                )
            )
            await task_registry.register(ctx.agent_run_id, tasks['prompt'], 'prompt', critical=True)
            
            tasks['tools'] = asyncio.create_task(
                prep_tasks.prep_tools(self._tool_registry)
            )
            await task_registry.register(ctx.agent_run_id, tasks['tools'], 'tools', critical=False)
            
            tasks['mcp'] = asyncio.create_task(
                prep_tasks.prep_mcp(ctx.agent_config, ctx.account_id, self._thread_manager)
            )
            await task_registry.register(ctx.agent_run_id, tasks['mcp'], 'mcp', critical=False)
            
            asyncio.create_task(prep_tasks.prep_llm_connection(ctx.model_name))
            asyncio.create_task(prep_tasks.prep_project_metadata(ctx.project_id))
            
            await stream_prep_stage(ctx.stream_key, "loading", "Fetching data", 60)
            
            try:
                results = await asyncio.wait_for(
                    asyncio.gather(*tasks.values(), return_exceptions=True),
                    timeout=self.PREP_TIMEOUT
                )
            except asyncio.TimeoutError:
                logger.error(f"Prep timeout after {self.PREP_TIMEOUT}s")
                result.errors.append(f"Preparation timed out after {self.PREP_TIMEOUT}s")
                await stream_degradation(
                    ctx.stream_key,
                    "prep",
                    "Preparation took longer than expected",
                    "warning",
                    "Response may be slower"
                )
                return result
            
            await stream_prep_stage(ctx.stream_key, "ready", "Preparation complete", 100)
            
            task_names = list(tasks.keys())
            for i, (name, task_result) in enumerate(zip(task_names, results)):
                if isinstance(task_result, Exception):
                    logger.error(f"Prep task {name} failed: {task_result}")
                    result.errors.append(f"{name}: {str(task_result)[:100]}")
                    if name == 'mcp':
                        await stream_degradation(
                            ctx.stream_key,
                            "mcp",
                            "Integration connection failed",
                            "warning",
                            "Some integrations may not be available"
                        )
                else:
                    setattr(result, name, task_result)
            
            result.total_prep_time_ms = (time.time() - start) * 1000
            self._log_prep_timing(result)
            
            return result
            
        except Exception as e:
            logger.error(f"Parallel prep failed: {e}", exc_info=True)
            result.errors.append(str(e)[:200])
            return result
    
    async def _lightweight_prep(
        self,
        ctx: PipelineContext,
        prev_result: PrepResult
    ) -> PrepResult:
        start = time.time()
        result = PrepResult()
        
        try:
            billing_task = asyncio.create_task(
                prep_tasks.prep_billing(ctx.account_id, wait_for_cache_ms=0)
            )
            
            messages_task = asyncio.create_task(
                prep_tasks.prep_messages(ctx.thread_id)
            )
            
            billing_result, messages_result = await asyncio.gather(
                billing_task, messages_task, return_exceptions=True
            )
            
            if isinstance(billing_result, Exception):
                result.errors.append(f"billing: {str(billing_result)[:100]}")
            else:
                result.billing = billing_result
            
            if isinstance(messages_result, Exception):
                result.errors.append(f"messages: {str(messages_result)[:100]}")
            else:
                result.messages = messages_result
            
            result.prompt = prev_result.prompt
            result.tools = prev_result.tools
            result.mcp = prev_result.mcp
            
            result.total_prep_time_ms = (time.time() - start) * 1000
            logger.debug(f"⚡ [PIPELINE] Lightweight prep: {result.total_prep_time_ms:.1f}ms")
            
            return result
            
        except Exception as e:
            logger.error(f"Lightweight prep failed: {e}")
            result.errors.append(str(e)[:200])
            return result
    
    async def _init_managers(self, ctx: PipelineContext) -> None:
        from core.agentpress.thread_manager import ThreadManager
        from core.agentpress.tool_registry import ToolRegistry
        from core.jit.config import JITConfig
        
        jit_config = JITConfig.from_run_context(
            agent_config=ctx.agent_config,
            disabled_tools=self._get_disabled_tools(ctx.agent_config)
        )
        
        self._trace = langfuse.trace(
            name="pipeline_run",
            id=ctx.agent_run_id,
            session_id=ctx.thread_id,
            metadata={"project_id": ctx.project_id}
        )
        
        self._thread_manager = ThreadManager(
            trace=self._trace,
            agent_config=ctx.agent_config,
            project_id=ctx.project_id,
            thread_id=ctx.thread_id,
            account_id=ctx.account_id,
            jit_config=jit_config
        )
        
        self._tool_registry = self._thread_manager.tool_registry
        
        from core.agents.runner.tool_manager import ToolManager
        tool_manager = ToolManager(
            self._thread_manager,
            ctx.project_id,
            ctx.thread_id,
            ctx.agent_config
        )
        tool_manager.register_core_tools()
    
    def _get_disabled_tools(self, agent_config: Optional[Dict[str, Any]]) -> List[str]:
        if not agent_config or 'agentpress_tools' not in agent_config:
            return []
        
        raw_tools = agent_config.get('agentpress_tools', {})
        if not isinstance(raw_tools, dict):
            return []
        
        disabled = []
        all_tools = [
            'sb_shell_tool', 'sb_files_tool', 'sb_expose_tool',
            'web_search_tool', 'image_search_tool', 'sb_vision_tool',
            'sb_presentation_tool', 'sb_image_edit_tool',
            'sb_kb_tool', 'sb_design_tool', 'sb_upload_file_tool',
            'browser_tool', 'people_search_tool', 'company_search_tool',
            'apify_tool', 'reality_defender_tool', 'vapi_voice_tool',
            'paper_search_tool', 'agent_config_tool', 'mcp_search_tool',
            'credential_profile_tool', 'trigger_tool', 'agent_creation_tool'
        ]
        
        for tool_name in all_tools:
            tool_config = raw_tools.get(tool_name, True)
            if isinstance(tool_config, bool) and not tool_config:
                disabled.append(tool_name)
            elif isinstance(tool_config, dict) and not tool_config.get('enabled', True):
                disabled.append(tool_name)
        
        return disabled
    
    async def _execute_llm_call(
        self,
        ctx: PipelineContext,
        prep: PrepResult,
        auto_state: AutoContinueState
    ) -> AsyncGenerator[Dict[str, Any], None]:
        from core.agentpress.response_processor import ProcessorConfig
        from core.agentpress.thread_manager.services.execution.llm_executor import LLMExecutor
        
        await stream_thinking(ctx.stream_key)
        
        processor_config = ProcessorConfig(
            xml_tool_calling=config.AGENT_XML_TOOL_CALLING,
            native_tool_calling=config.AGENT_NATIVE_TOOL_CALLING,
            execute_tools=True,
            execute_on_stream=config.AGENT_EXECUTE_ON_STREAM,
            tool_execution_strategy=config.AGENT_TOOL_EXECUTION_STRATEGY
        )
        
        messages = prep.messages.messages if prep.messages else []
        system_prompt = prep.prompt.system_prompt if prep.prompt else {"role": "system", "content": "You are a helpful assistant."}
        memory_context = prep.prompt.memory_context if prep.prompt else None
        tool_schemas = prep.tools.schemas if prep.tools else None
        
        messages_with_context = messages
        if memory_context and messages:
            messages_with_context = [memory_context] + messages
        
        # Fast pre-check - only do full validation if needed
        from core.agentpress.context_manager import ContextManager
        context_manager = ContextManager()
        if context_manager.needs_tool_ordering_repair(messages_with_context):
            logger.warning("[PipelineCoordinator] Tool ordering issue detected, repairing...")
            messages_with_context = context_manager.repair_tool_call_pairing(messages_with_context)
            is_ordered, out_of_order_ids, _ = context_manager.validate_tool_call_ordering(messages_with_context)
            if not is_ordered:
                messages_with_context = context_manager.remove_out_of_order_tool_pairs(messages_with_context, out_of_order_ids)
                messages_with_context = context_manager.repair_tool_call_pairing(messages_with_context)
        
        from core.agentpress.prompt_caching import add_cache_control
        cached_system = add_cache_control(system_prompt)
        prepared_messages = [cached_system] + messages_with_context
        
        # Use effective model (may have been switched for image support)
        effective_model = self._effective_model_name or ctx.model_name
        
        import litellm
        actual_tokens = await asyncio.to_thread(
            litellm.token_counter,
            model=effective_model,
            messages=prepared_messages
        )
        
        logger.info(f"📤 PRE-SEND: {len(prepared_messages)} messages, {actual_tokens} tokens (fast path)")
        
        llm_executor = LLMExecutor()
        llm_response = await llm_executor.execute(
            prepared_messages=prepared_messages,
            llm_model=effective_model,
            llm_temperature=0,
            llm_max_tokens=None,
            openapi_tool_schemas=tool_schemas,
            tool_choice="auto",
            native_tool_calling=processor_config.native_tool_calling,
            xml_tool_calling=processor_config.xml_tool_calling,
            stream=True
        )
        
        if isinstance(llm_response, dict) and llm_response.get("status") == "error":
            yield llm_response
            return
        
        if hasattr(llm_response, '__aiter__'):
            response_processor = self._thread_manager.response_processor
            async for chunk in response_processor.process_streaming_response(
                llm_response, ctx.thread_id, prepared_messages,
                effective_model, processor_config, True,
                auto_state.count, auto_state.to_dict().get('continuous_state', {}),
                None, actual_tokens, ctx.cancellation_event
            ):
                yield chunk
        elif isinstance(llm_response, dict):
            yield llm_response
    
    def _check_auto_continue(
        self,
        chunk: Dict[str, Any],
        auto_state: AutoContinueState,
        max_continues: int
    ) -> tuple[bool, bool]:
        """
        Check if the pipeline should auto-continue or terminate.
        
        Returns:
            tuple[bool, bool]: (should_continue, should_terminate)
            - should_continue: True if we should continue to next iteration
            - should_terminate: True if we should forcefully stop (terminating tool called)
        """
        if auto_state.count >= max_continues:
            return False, False
        
        if chunk.get('type') == 'status':
            metadata = chunk.get('metadata', {})
            if isinstance(metadata, str):
                try:
                    metadata = json.loads(metadata)
                except:
                    metadata = {}
            
            if metadata.get('agent_should_terminate'):
                logger.debug("🛑 [PIPELINE] Auto-continue disabled: agent_should_terminate flag set")
                return False, True
            
            content = chunk.get('content', {})
            if isinstance(content, str):
                try:
                    content = json.loads(content)
                except:
                    content = {}
            
            finish_reason = content.get('finish_reason') if isinstance(content, dict) else None
            
            function_name = content.get('function_name') if isinstance(content, dict) else None
            if function_name in ('ask', 'complete'):
                logger.debug(f"🛑 [PIPELINE] Auto-continue disabled: terminating tool '{function_name}' was called")
                return False, True
            
            if finish_reason in ('tool_calls', 'length'):
                return True, False
            
            if finish_reason in ('stop', 'agent_terminated'):
                return False, False
        
        return False, False
    
    def _log_prep_timing(self, result: PrepResult) -> None:
        parts = []

        if result.billing:
            parts.append(f"billing=OK")
        if result.messages:
            parts.append(f"msgs={result.messages.count}({result.messages.fetch_time_ms:.0f}ms)")
        if result.prompt:
            parts.append(f"prompt={result.prompt.build_time_ms:.0f}ms")
        if result.tools:
            parts.append(f"tools={result.tools.count}({result.tools.fetch_time_ms:.0f}ms)")
        if result.mcp:
            parts.append(f"mcp={result.mcp.tool_count}({result.mcp.init_time_ms:.0f}ms)")
        
        logger.info(f"📊 [PREP] {result.total_prep_time_ms:.0f}ms total | {' | '.join(parts)}")
    
    async def _cleanup(self, ctx: PipelineContext) -> None:
        try:
            await task_registry.cancel_all(ctx.agent_run_id, reason="pipeline_cleanup")
            
            if self._thread_manager:
                await self._thread_manager.cleanup()
                self._thread_manager = None
            
            self._tool_registry = None
            self._response_processor = None
            
        except Exception as e:
            logger.warning(f"Cleanup error: {e}")
