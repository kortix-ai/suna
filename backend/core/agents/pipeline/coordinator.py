"""
Pipeline Coordinator - Orchestrates parallel execution of all prep work.

This is the heart of the fast pipeline. It:
1. Starts all prep tasks simultaneously
2. Tracks tasks for cleanup
3. Validates results
4. Executes LLM call
5. Handles auto-continue loop
"""

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
from core.agents.pipeline.limits import LimitEnforcer
from core.agents.pipeline import prep_tasks


class PipelineCoordinator:
    """
    Coordinates the parallel execution pipeline for agent runs.
    
    Key principles:
    - All prep work runs in parallel
    - Fail fast on any critical error
    - Track all tasks for cleanup
    - No memory/CPU leaks
    """
    
    # Timeouts
    PREP_TIMEOUT = 30.0  # Max time for all prep work
    LLM_TIMEOUT = 300.0  # Max time for LLM call
    
    def __init__(self):
        self._thread_manager = None
        self._tool_registry = None
        self._response_processor = None
    
    async def execute(
        self,
        ctx: PipelineContext,
        max_auto_continues: int = 25
    ) -> AsyncGenerator[Dict[str, Any], None]:
        """
        Execute the full pipeline with auto-continue support.
        
        Yields response chunks as they arrive.
        """
        execution_start = time.time()
        auto_state = AutoContinueState()
        
        try:
            # Phase 1: Parallel prep (first call only does full prep)
            prep_result = await self._parallel_prep(ctx)
            
            prep_time_ms = (time.time() - execution_start) * 1000
            logger.info(f"⚡ [PIPELINE] Prep complete: {prep_time_ms:.1f}ms")
            
            # Check if we can proceed
            if not prep_result.can_proceed:
                yield prep_result.get_error_response()
                return
            
            # Phase 2: Auto-continue loop
            while auto_state.active and auto_state.count < max_auto_continues:
                auto_state.active = False
                
                # Check cancellation
                if ctx.cancellation_event and ctx.cancellation_event.is_set():
                    logger.info(f"🛑 Pipeline cancelled for {ctx.agent_run_id}")
                    yield {"type": "status", "status": "stopped", "message": "Cancelled"}
                    break
                
                # For subsequent calls, do lightweight prep
                if auto_state.count > 0:
                    prep_result = await self._lightweight_prep(ctx, prep_result)
                    if not prep_result.can_proceed:
                        yield prep_result.get_error_response()
                        break
                
                # Execute LLM call
                async for chunk in self._execute_llm_call(ctx, prep_result, auto_state):
                    yield chunk
                    
                    # Check for auto-continue trigger
                    if self._should_auto_continue(chunk, auto_state, max_auto_continues):
                        auto_state.active = True
                
                auto_state.count += 1
            
            total_time_ms = (time.time() - execution_start) * 1000
            logger.info(f"✅ [PIPELINE] Complete: {total_time_ms:.1f}ms, {auto_state.count} iterations")
            
        except asyncio.CancelledError:
            logger.info(f"Pipeline cancelled: {ctx.agent_run_id}")
            yield {"type": "status", "status": "stopped", "message": "Cancelled"}
        except Exception as e:
            logger.error(f"Pipeline error: {e}", exc_info=True)
            yield {"type": "error", "error": str(e)[:200], "error_code": "PIPELINE_ERROR"}
        finally:
            await self._cleanup(ctx)
    
    async def _parallel_prep(self, ctx: PipelineContext) -> PrepResult:
        """
        Execute all prep tasks in parallel.
        
        This is the key optimization - all tasks start simultaneously.
        """
        start = time.time()
        result = PrepResult()
        
        try:
            # Initialize thread manager and tool registry
            await self._init_managers(ctx)
            
            # Create all prep tasks
            tasks = {}
            
            # Billing check (most expensive, ~2.5s on miss)
            tasks['billing'] = asyncio.create_task(
                prep_tasks.prep_billing(ctx.account_id)
            )
            await task_registry.register(ctx.agent_run_id, tasks['billing'], 'billing', critical=True)
            
            # Limits check
            tasks['limits'] = asyncio.create_task(
                prep_tasks.prep_limits(ctx.account_id, ctx.skip_limits_check)
            )
            await task_registry.register(ctx.agent_run_id, tasks['limits'], 'limits', critical=True)
            
            # Messages fetch
            tasks['messages'] = asyncio.create_task(
                prep_tasks.prep_messages(ctx.thread_id)
            )
            await task_registry.register(ctx.agent_run_id, tasks['messages'], 'messages', critical=True)
            
            # System prompt build
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
            
            # Tool schemas
            tasks['tools'] = asyncio.create_task(
                prep_tasks.prep_tools(self._tool_registry)
            )
            await task_registry.register(ctx.agent_run_id, tasks['tools'], 'tools', critical=False)
            
            # MCP init
            tasks['mcp'] = asyncio.create_task(
                prep_tasks.prep_mcp(ctx.agent_config, ctx.account_id, self._thread_manager)
            )
            await task_registry.register(ctx.agent_run_id, tasks['mcp'], 'mcp', critical=False)
            
            # LLM connection prewarm (fire and forget)
            asyncio.create_task(prep_tasks.prep_llm_connection(ctx.model_name))
            
            # Project metadata cache
            asyncio.create_task(prep_tasks.prep_project_metadata(ctx.project_id))
            
            # Wait for all tasks with timeout
            try:
                results = await asyncio.wait_for(
                    asyncio.gather(*tasks.values(), return_exceptions=True),
                    timeout=self.PREP_TIMEOUT
                )
            except asyncio.TimeoutError:
                logger.error(f"Prep timeout after {self.PREP_TIMEOUT}s")
                result.errors.append(f"Preparation timed out after {self.PREP_TIMEOUT}s")
                return result
            
            # Map results back to named fields
            task_names = list(tasks.keys())
            for i, (name, task_result) in enumerate(zip(task_names, results)):
                if isinstance(task_result, Exception):
                    logger.error(f"Prep task {name} failed: {task_result}")
                    result.errors.append(f"{name}: {str(task_result)[:100]}")
                else:
                    setattr(result, name, task_result)
            
            result.total_prep_time_ms = (time.time() - start) * 1000
            
            # Log timing breakdown
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
        """
        Lightweight prep for auto-continue iterations.
        
        Reuses cached data, only refreshes messages.
        """
        start = time.time()
        result = PrepResult()
        
        try:
            # Quick billing check (should hit cache)
            billing_task = asyncio.create_task(
                prep_tasks.prep_billing(ctx.account_id)
            )
            
            # Refresh messages
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
            
            # Reuse previous results
            result.limits = prev_result.limits
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
        """Initialize thread manager and tool registry."""
        from core.agentpress.thread_manager import ThreadManager
        from core.agentpress.tool_registry import ToolRegistry
        from core.jit.config import JITConfig
        
        # Create JIT config
        jit_config = JITConfig.from_run_context(
            agent_config=ctx.agent_config,
            disabled_tools=self._get_disabled_tools(ctx.agent_config)
        )
        
        # Create thread manager
        trace = langfuse.trace(
            name="pipeline_run",
            id=ctx.agent_run_id,
            session_id=ctx.thread_id,
            metadata={"project_id": ctx.project_id}
        )
        
        self._thread_manager = ThreadManager(
            trace=trace,
            agent_config=ctx.agent_config,
            project_id=ctx.project_id,
            thread_id=ctx.thread_id,
            account_id=ctx.account_id,
            jit_config=jit_config
        )
        
        self._tool_registry = self._thread_manager.tool_registry
        
        # Register tools
        from core.agents.runner.tool_manager import ToolManager
        tool_manager = ToolManager(
            self._thread_manager,
            ctx.project_id,
            ctx.thread_id,
            ctx.agent_config
        )
        tool_manager.register_core_tools()
    
    def _get_disabled_tools(self, agent_config: Optional[Dict[str, Any]]) -> List[str]:
        """Get list of disabled tools from config."""
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
        """Execute the LLM call and stream response."""
        from core.agentpress.response_processor import ProcessorConfig
        
        # Build processor config
        processor_config = ProcessorConfig(
            xml_tool_calling=config.AGENT_XML_TOOL_CALLING,
            native_tool_calling=config.AGENT_NATIVE_TOOL_CALLING,
            execute_tools=True,
            execute_on_stream=config.AGENT_EXECUTE_ON_STREAM,
            tool_execution_strategy=config.AGENT_TOOL_EXECUTION_STRATEGY
        )
        
        # Prepare messages with system prompt
        messages = prep.messages.messages if prep.messages else []
        system_prompt = prep.prompt.system_prompt if prep.prompt else {"role": "system", "content": "You are a helpful assistant."}
        memory_context = prep.prompt.memory_context if prep.prompt else None
        
        # Add memory context if present
        if memory_context and messages:
            messages = [memory_context] + messages
        
        prepared_messages = [system_prompt] + messages
        
        # Get tool schemas
        tool_schemas = prep.tools.schemas if prep.tools else None
        
        # Execute via orchestrator
        from core.agentpress.thread_manager.services.execution.orchestrator import ExecutionOrchestrator
        
        orchestrator = ExecutionOrchestrator()
        
        response = await orchestrator.execute_pipeline(
            thread_id=ctx.thread_id,
            system_prompt=system_prompt,
            llm_model=ctx.model_name,
            registry_model_id=ctx.model_name,
            llm_temperature=0,
            llm_max_tokens=None,
            tool_choice="auto",
            config=processor_config,
            stream=True,
            generation=None,
            auto_continue_state=auto_state.to_dict(),
            memory_context=memory_context,
            latest_user_message_content=None,
            cancellation_event=ctx.cancellation_event,
            prefetch_messages_task=None,
            prefetch_llm_end_task=None,
            tool_registry=self._tool_registry,
            get_llm_messages_func=self._thread_manager.get_llm_messages,
            thread_has_images_func=self._thread_manager.thread_has_images,
            response_processor=self._thread_manager.response_processor,
            db=self._thread_manager.db
        )
        
        # Stream response
        if hasattr(response, '__aiter__'):
            async for chunk in response:
                yield chunk
        elif isinstance(response, dict):
            yield response
    
    def _should_auto_continue(
        self,
        chunk: Dict[str, Any],
        auto_state: AutoContinueState,
        max_continues: int
    ) -> bool:
        """Check if we should auto-continue based on response chunk."""
        if auto_state.count >= max_continues:
            return False
        
        if chunk.get('type') == 'status':
            content = chunk.get('content', {})
            if isinstance(content, str):
                try:
                    content = json.loads(content)
                except:
                    content = {}
            
            finish_reason = content.get('finish_reason') if isinstance(content, dict) else None
            
            # Continue on tool_calls or length
            if finish_reason in ('tool_calls', 'length'):
                return True
            
            # Stop on explicit stop reasons
            if finish_reason in ('stop', 'agent_terminated'):
                return False
        
        return False
    
    def _log_prep_timing(self, result: PrepResult) -> None:
        """Log detailed timing breakdown."""
        parts = []
        
        if result.billing:
            parts.append(f"billing=OK")
        if result.limits:
            parts.append(f"limits=OK")
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
        """Clean up all resources."""
        try:
            # Cancel all tracked tasks
            await task_registry.cancel_all(ctx.agent_run_id, reason="pipeline_cleanup")
            
            # Clean up thread manager
            if self._thread_manager:
                await self._thread_manager.cleanup()
                self._thread_manager = None
            
            self._tool_registry = None
            self._response_processor = None
            
        except Exception as e:
            logger.warning(f"Cleanup error: {e}")
