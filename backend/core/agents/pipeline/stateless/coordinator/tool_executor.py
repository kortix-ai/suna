import json
import time
import uuid
import asyncio
from typing import Dict, Any, Optional, AsyncGenerator, List, Tuple
from datetime import datetime, timezone

from core.utils.logger import logger
from core.agents.pipeline.stateless.state import ToolResult
from .message_builder import _transform_mcp_tool_call

TERMINATING_TOOLS = {"ask", "complete"}

class ToolExecutor:
    def __init__(self, state, tool_registry, message_builder, trace=None):
        self._state = state
        self._tool_registry = tool_registry
        self._message_builder = message_builder
        self._trace = trace

    async def execute_tools(
        self, 
        stream_start: str, 
        assistant_message_id: Optional[str] = None,
        start_index: int = 0,
        strategy: str = "parallel"
    ) -> AsyncGenerator[Dict[str, Any], None]:
        pending = self._state.take_pending_tools()
        thread_run_id = self._message_builder._get_thread_run_id()
        
        logger.debug(f"[ToolExecutor] Executing {len(pending)} tools starting at index {start_index}, strategy={strategy}, assistant_message_id={assistant_message_id}")

        available_functions = self._tool_registry.get_available_functions()
        
        if strategy == "parallel" and len(pending) > 1:
            async for msg in self._execute_tools_in_parallel(pending, stream_start, assistant_message_id, start_index, thread_run_id, available_functions):
                yield msg
        else:
            # Sequential execution
            for i, tc in enumerate(pending):
                # Check for stop signal before starting each tool
                if not self._state.is_active:
                    logger.warning(f"🛑 [ToolExecutor] Stop detected during sequential tool execution - stopping before tool {i}")
                    break
                
                tool_index = start_index + i
                tc_id = tc.get("id", "")
                func = tc.get("function", {})
                name = func.get("name", "unknown")  
                args = func.get("arguments", "{}")
                
                display_name, _ = _transform_mcp_tool_call(name, args)
                
                logger.debug(f"[ToolExecutor] Tool {tool_index}: {name} (id={tc_id})")

                is_terminating = name in TERMINATING_TOOLS
                
                # Persist and yield tool_started status
                self._state.add_status_message(
                    {
                        "tool_index": tool_index,
                        "status_type": "tool_started",
                        "tool_call_id": tc_id,
                        "function_name": display_name
                    },
                    {"thread_run_id": thread_run_id}
                )
                yield self._message_builder.build_tool_started(tc_id, display_name, tool_index, stream_start, args)

                start = time.time()
                output, success, error = await self._execute_single_tool(name, args, available_functions)
                exec_time = (time.time() - start) * 1000
                
                logger.debug(f"[ToolExecutor] Tool {name} completed in {exec_time:.1f}ms, success={success}")
                
                # CRITICAL: If initialize_tools was called, refresh available_functions
                # so subsequent tools can use newly registered functions
                if name == "initialize_tools" and success:
                    logger.info(f"[ToolExecutor] initialize_tools completed - refreshing available functions")
                    self._tool_registry.invalidate_function_cache()
                    available_functions = self._tool_registry.get_available_functions()
                    logger.debug(f"[ToolExecutor] Now have {len(available_functions)} available functions")

                # Check for stop after tool execution completes
                if not self._state.is_active:
                    logger.warning(f"🛑 [ToolExecutor] Stop detected after tool {name} execution - will not process remaining tools")
                    # Still record this tool's result since it completed
                    self._state.record_tool_result(
                        ToolResult(
                            tool_call_id=tc_id,
                            tool_name=name,
                            success=success,
                            output=output,
                            error=error,
                            execution_time_ms=exec_time,
                        ),
                        assistant_message_id
                    )

                    tool_result_msg = self._message_builder.build_tool_result(
                        tc_id, display_name, output, success, error, tool_index, stream_start, assistant_message_id
                    )
                    tool_result_message_id = tool_result_msg.get("message_id")
                    yield tool_result_msg

                    status_type = "tool_completed" if success else "tool_failed"
                    status_content = {
                        "tool_index": tool_index,
                        "status_type": status_type,
                        "tool_call_id": tc_id,
                        "function_name": display_name
                    }
                    status_metadata = {"thread_run_id": thread_run_id}
                    if tool_result_message_id:
                        status_metadata["linked_tool_result_message_id"] = tool_result_message_id
                    
                    self._state.add_status_message(status_content, status_metadata)
                    yield self._message_builder.build_tool_completed(
                        tc_id, display_name, success, tool_index, stream_start, tool_result_message_id, is_terminating
                    )
                    break

                self._state.record_tool_result(
                    ToolResult(
                        tool_call_id=tc_id,
                        tool_name=name,
                        success=success,
                        output=output,
                        error=error,
                        execution_time_ms=exec_time,
                    ),
                    assistant_message_id
                )

                tool_result_msg = self._message_builder.build_tool_result(
                    tc_id, display_name, output, success, error, tool_index, stream_start, assistant_message_id
                )
                tool_result_message_id = tool_result_msg.get("message_id")
                logger.debug(f"[ToolExecutor] Yielding tool result: {tc_id}, message_id={tool_result_message_id}")
                yield tool_result_msg

                status_type = "tool_completed" if success else "tool_failed"
                status_content = {
                    "tool_index": tool_index,
                    "status_type": status_type,
                    "tool_call_id": tc_id,
                    "function_name": display_name
                }
                status_metadata = {"thread_run_id": thread_run_id}
                if tool_result_message_id:
                    status_metadata["linked_tool_result_message_id"] = tool_result_message_id
                
                self._state.add_status_message(status_content, status_metadata)
                yield self._message_builder.build_tool_completed(
                    tc_id, display_name, success, tool_index, stream_start, tool_result_message_id, is_terminating
                )

                if success and output:
                    async for msg in self._handle_deferred_image_context(output, stream_start):
                        yield msg

                if is_terminating and success:
                    async for msg in self._handle_terminating_tool(tc_id, name):
                        yield msg

    async def _execute_tools_in_parallel(
        self,
        pending: List[Dict[str, Any]],
        stream_start: str,
        assistant_message_id: Optional[str],
        start_index: int,
        thread_run_id: str,
        available_functions: Dict[str, Any]
    ) -> AsyncGenerator[Dict[str, Any], None]:
        """Execute multiple tools in parallel using asyncio.gather."""
        
        tool_names = [tc.get("function", {}).get("name", "unknown") for tc in pending]
        logger.info(f"🔄 [ToolExecutor] Executing {len(pending)} tools in parallel: {tool_names}")
        
        # CRITICAL: If initialize_tools is in the batch, execute it FIRST
        # This ensures newly registered tools are available for other tools in the batch
        init_tools_indices = [i for i, tc in enumerate(pending) if tc.get("function", {}).get("name") == "initialize_tools"]
        if init_tools_indices:
            logger.info(f"⚡ [ToolExecutor] Found initialize_tools in batch - executing it first before parallel execution")
            
            # Execute initialize_tools first (sequentially)
            for init_idx in init_tools_indices:
                tc = pending[init_idx]
                tool_index = start_index + init_idx
                async for msg in self._execute_single_tool_sequential(tc, tool_index, stream_start, assistant_message_id, thread_run_id):
                    yield msg
            
            # Refresh available_functions after initialize_tools
            self._tool_registry.invalidate_function_cache()
            available_functions = self._tool_registry.get_available_functions()
            logger.info(f"⚡ [ToolExecutor] Refreshed available functions after initialize_tools: {len(available_functions)} functions")
            
            # Remove initialize_tools from pending and track original indices
            remaining_pending = [(i, tc) for i, tc in enumerate(pending) if i not in init_tools_indices]
            if not remaining_pending:
                return  # All tools were initialize_tools, already executed
            
            # Execute remaining tools in parallel with their ORIGINAL indices
            original_indices = [i for i, _ in remaining_pending]
            pending = [tc for _, tc in remaining_pending]
            
            # Rebuild tool_names for logging
            tool_names = [tc.get("function", {}).get("name", "unknown") for tc in pending]
        else:
            original_indices = None  # Use sequential indices when no initialize_tools
        
        if self._trace:
            self._trace.event(
                name="executing_tools_in_parallel",
                level="DEFAULT",
                status_message=f"Executing {len(pending)} tools in parallel: {tool_names}"
            )
        
        # Create execution tasks
        execution_tasks = []
        for i, tc in enumerate(pending):
            # Use original index if we removed initialize_tools, otherwise sequential
            if original_indices is not None:
                tool_index = start_index + original_indices[i]
            else:
                tool_index = start_index + i
            tc_id = tc.get("id", "")
            func = tc.get("function", {})
            name = func.get("name", "unknown")
            args = func.get("arguments", "{}")
            
            task = self._execute_single_tool(name, args, available_functions)
            execution_tasks.append((tool_index, tc, task))
        
        # Execute all tools concurrently
        try:
            results = await asyncio.gather(*[task for _, _, task in execution_tasks], return_exceptions=True)
        except Exception as e:
            logger.error(f"❌ [ToolExecutor] Critical error in parallel execution: {e}", exc_info=True)
            if self._trace:
                self._trace.event(
                    name="error_in_parallel_tool_execution",
                    level="ERROR",
                    status_message=f"Error in parallel tool execution: {str(e)}"
                )
            # Fall back to sequential on critical error
            for i, tc in enumerate(pending):
                if original_indices is not None:
                    tool_index = start_index + original_indices[i]
                else:
                    tool_index = start_index + i
                async for msg in self._execute_single_tool_sequential(tc, tool_index, stream_start, assistant_message_id, thread_run_id):
                    yield msg
            return
        
        # Process results and yield messages in order
        for (tool_index, tc, _), result in zip(execution_tasks, results):
            # Check for stop signal before processing each tool result
            if not self._state.is_active:
                logger.warning(f"🛑 [ToolExecutor] Stop detected during parallel tool execution - stopping at tool {tool_index}")
                break
            
            tc_id = tc.get("id", "")
            func = tc.get("function", {})
            name = func.get("name", "unknown")
            args = func.get("arguments", "{}")
            display_name, _ = _transform_mcp_tool_call(name, args)
            is_terminating = name in TERMINATING_TOOLS
            
            # Handle exceptions
            if isinstance(result, Exception):
                logger.error(f"❌ [ToolExecutor] Exception in parallel execution for {name}: {result}")
                if self._trace:
                    self._trace.event(
                        name="error_executing_tool_parallel",
                        level="ERROR",
                        status_message=f"Error executing tool {name}: {str(result)}"
                    )
                output, success, error = None, False, str(result)
            else:
                output, success, error = result
            
            # Yield tool_started (retroactively)
            self._state.add_status_message(
                {
                    "tool_index": tool_index,
                    "status_type": "tool_started",
                    "tool_call_id": tc_id,
                    "function_name": display_name
                },
                {"thread_run_id": thread_run_id}
            )
            yield self._message_builder.build_tool_started(tc_id, display_name, tool_index, stream_start, args)
            
            # Record result
            exec_time = 0  # Parallel execution doesn't track individual times
            self._state.record_tool_result(
                ToolResult(
                    tool_call_id=tc_id,
                    tool_name=name,
                    success=success,
                    output=output,
                    error=error,
                    execution_time_ms=exec_time,
                ),
                assistant_message_id
            )
            
            # Yield tool_result
            tool_result_msg = self._message_builder.build_tool_result(
                tc_id, display_name, output, success, error, tool_index, stream_start, assistant_message_id
            )
            tool_result_message_id = tool_result_msg.get("message_id")
            yield tool_result_msg
            
            # Yield tool_completed
            status_type = "tool_completed" if success else "tool_failed"
            status_content = {
                "tool_index": tool_index,
                "status_type": status_type,
                "tool_call_id": tc_id,
                "function_name": display_name
            }
            status_metadata = {"thread_run_id": thread_run_id}
            if tool_result_message_id:
                status_metadata["linked_tool_result_message_id"] = tool_result_message_id
            
            self._state.add_status_message(status_content, status_metadata)
            yield self._message_builder.build_tool_completed(
                tc_id, display_name, success, tool_index, stream_start, tool_result_message_id, is_terminating
            )
            
            # Handle deferred image context
            if success and output:
                async for msg in self._handle_deferred_image_context(output, stream_start):
                    yield msg
            
            # Handle terminating tools
            if is_terminating and success:
                async for msg in self._handle_terminating_tool(tc_id, name):
                    yield msg
        
        if self._trace:
            self._trace.event(
                name="parallel_execution_completed",
                level="DEFAULT",
                status_message=f"Parallel execution completed for {len(pending)} tools"
            )

    async def _execute_single_tool_sequential(
        self,
        tc: Dict[str, Any],
        tool_index: int,
        stream_start: str,
        assistant_message_id: Optional[str],
        thread_run_id: str
    ) -> AsyncGenerator[Dict[str, Any], None]:
        """Execute a single tool sequentially (used as fallback)."""
        available_functions = self._tool_registry.get_available_functions()
        tc_id = tc.get("id", "")
        func = tc.get("function", {})
        name = func.get("name", "unknown")
        args = func.get("arguments", "{}")
        
        display_name, _ = _transform_mcp_tool_call(name, args)
        is_terminating = name in TERMINATING_TOOLS
        
        # Yield tool_started
        self._state.add_status_message(
            {
                "tool_index": tool_index,
                "status_type": "tool_started",
                "tool_call_id": tc_id,
                "function_name": display_name
            },
            {"thread_run_id": thread_run_id}
        )
        yield self._message_builder.build_tool_started(tc_id, display_name, tool_index, stream_start, args)
        
        # Execute tool
        start = time.time()
        output, success, error = await self._execute_single_tool(name, args, available_functions)
        exec_time = (time.time() - start) * 1000
        
        # Record result
        self._state.record_tool_result(
            ToolResult(
                tool_call_id=tc_id,
                tool_name=name,
                success=success,
                output=output,
                error=error,
                execution_time_ms=exec_time,
            ),
            assistant_message_id
        )
        
        # Yield tool_result
        tool_result_msg = self._message_builder.build_tool_result(
            tc_id, display_name, output, success, error, tool_index, stream_start, assistant_message_id
        )
        tool_result_message_id = tool_result_msg.get("message_id")
        yield tool_result_msg
        
        # Yield tool_completed
        status_type = "tool_completed" if success else "tool_failed"
        status_content = {
            "tool_index": tool_index,
            "status_type": status_type,
            "tool_call_id": tc_id,
            "function_name": display_name
        }
        status_metadata = {"thread_run_id": thread_run_id}
        if tool_result_message_id:
            status_metadata["linked_tool_result_message_id"] = tool_result_message_id
        
        self._state.add_status_message(status_content, status_metadata)
        yield self._message_builder.build_tool_completed(
            tc_id, display_name, success, tool_index, stream_start, tool_result_message_id, is_terminating
        )
        
        if success and output:
            async for msg in self._handle_deferred_image_context(output, stream_start):
                yield msg
        
        if is_terminating and success:
            async for msg in self._handle_terminating_tool(tc_id, name):
                yield msg

    async def execute_single_tool_streaming(
        self,
        tc: Dict[str, Any],
        tool_index: int,
        stream_start: str,
        deferred_tool_results: List[Dict[str, Any]],
        pre_assigned_assistant_message_id: Optional[str] = None
    ) -> AsyncGenerator[Dict[str, Any], None]:
        """Execute a single tool immediately during streaming (execute-on-stream).
        
        IMPORTANT: Tool results are NOT persisted here. They are added to deferred_tool_results
        and will be persisted AFTER the assistant message is created (to maintain correct ordering).
        
        Args:
            pre_assigned_assistant_message_id: Pre-generated ID for the assistant message.
                Used in streaming tool_result messages so frontend can link them correctly.
        """
        # IMPORTANT: Invalidate cache and get fresh functions each time
        # This ensures tools registered by initialize_tools are immediately available
        self._tool_registry.invalidate_function_cache()
        available_functions = self._tool_registry.get_available_functions()
        thread_run_id = self._message_builder._get_thread_run_id()
        
        tc_id = tc.get("id", "")
        func = tc.get("function", {})
        name = func.get("name", "unknown")
        args = func.get("arguments", "{}")
        
        display_name, _ = _transform_mcp_tool_call(name, args)
        
        logger.info(f"🚀 [ExecuteOnStream] Executing tool {tool_index}: {name} (id={tc_id})")
        
        is_terminating = name in TERMINATING_TOOLS
        
        # Yield tool_started status (status messages are fine to persist immediately)
        self._state.add_status_message(
            {
                "tool_index": tool_index,
                "status_type": "tool_started",
                "tool_call_id": tc_id,
                "function_name": display_name
            },
            {"thread_run_id": thread_run_id}
        )
        yield self._message_builder.build_tool_started(tc_id, display_name, tool_index, stream_start, args)
        
        start = time.time()
        output, success, error = await self._execute_single_tool(name, args, available_functions)
        exec_time = (time.time() - start) * 1000
        
        logger.info(f"✅ [ExecuteOnStream] Tool {name} completed in {exec_time:.1f}ms, success={success}")
        
        # DEFER tool result persistence - add to list, will be persisted after assistant message
        tool_result = ToolResult(
            tool_call_id=tc_id,
            tool_name=name,
            success=success,
            output=output,
            error=error,
            execution_time_ms=exec_time,
        )
        deferred_tool_results.append({"result": tool_result, "tool_index": tool_index})
        
        # Yield streaming messages with pre_assigned_assistant_message_id for frontend linkage
        tool_result_msg = self._message_builder.build_tool_result(
            tc_id, display_name, output, success, error, tool_index, stream_start, pre_assigned_assistant_message_id
        )
        tool_result_message_id = tool_result_msg.get("message_id")
        logger.debug(f"[ExecuteOnStream] Yielding tool result (deferred persistence): {tc_id}, linked to assistant={pre_assigned_assistant_message_id}")
        yield tool_result_msg
        
        status_type = "tool_completed" if success else "tool_failed"
        status_content = {
            "tool_index": tool_index,
            "status_type": status_type,
            "tool_call_id": tc_id,
            "function_name": display_name
        }
        status_metadata = {"thread_run_id": thread_run_id}
        if tool_result_message_id:
            status_metadata["linked_tool_result_message_id"] = tool_result_message_id
        
        self._state.add_status_message(status_content, status_metadata)
        yield self._message_builder.build_tool_completed(
            tc_id, display_name, success, tool_index, stream_start, tool_result_message_id, is_terminating
        )
        
        if success and output:
            async for msg in self._handle_deferred_image_context(output, stream_start):
                yield msg
        
        if is_terminating and success:
            async for msg in self._handle_terminating_tool(tc_id, name):
                yield msg

    async def _execute_single_tool(
        self, 
        name: str, 
        args: str, 
        available_functions: Dict
    ) -> tuple[Any, bool, Optional[str]]:
        try:
            parsed = json.loads(args) if isinstance(args, str) else args
            tool_fn = available_functions.get(name)

            if tool_fn:
                result = await tool_fn(**parsed)
                if hasattr(result, 'success') and hasattr(result, 'output'):
                    success = result.success
                    output = result.output
                    error = None if success else str(result.output)
                else:
                    success = True
                    output = result
                    error = None
            else:
                output, success, error = None, False, f"Tool '{name}' not found"

        except Exception as e:
            output, success, error = None, False, str(e)
            logger.warning(f"[ToolExecutor] Tool {name} failed: {e}")

        return output, success, error

    async def _handle_deferred_image_context(
        self, 
        output: Any, 
        stream_start: str
    ) -> AsyncGenerator[Dict[str, Any], None]:
        try:
            parsed_output = output
            if isinstance(output, str):
                try:
                    parsed_output = json.loads(output)
                except (json.JSONDecodeError, ValueError):
                    return
            
            if not isinstance(parsed_output, dict) or '_image_context_data' not in parsed_output:
                return
            
            logger.info("[DeferredImageContext] Found _image_context_data, saving to state")
            
            image_context_data = parsed_output.get('_image_context_data')
            if not image_context_data:
                return
            
            message_content = image_context_data.get('message_content')
            metadata = image_context_data.get('metadata', {})
            
            if not message_content:
                logger.warning("_image_context_data missing message_content, skipping")
                return
            
            self._state.add_message(message_content, {
                "type": "image_context",
                **metadata
            })
            logger.info(f"[DeferredImageContext] Added image_context to state messages")
            
            try:
                from core.agentpress.thread_manager.services.state.thread_state import ThreadState
                thread_id = image_context_data.get('thread_id') or self._message_builder._get_thread_id()
                await ThreadState.set_has_images(thread_id)
                logger.info(f"[DeferredImageContext] Set has_images flag on thread {thread_id}")
            except Exception as flag_error:
                logger.warning(f"[DeferredImageContext] Failed to set has_images flag: {flag_error}")
            
            message_id = str(uuid.uuid4())
            seq = self._message_builder._increment_sequence()
            
            image_msg = {
                "sequence": seq,
                "message_id": message_id,
                "thread_id": self._message_builder._get_thread_id(),
                "type": "image_context",
                "is_llm_message": True,
                "content": json.dumps(message_content),
                "metadata": json.dumps(metadata),
                "created_at": stream_start,
                "updated_at": stream_start,
                "agent_id": None,
                "agent_version_id": None,
                "created_by_user_id": None
            }
            
            logger.info(f"[DeferredImageContext] Yielding image_context message for persistence")
            yield image_msg
            
        except Exception as e:
            logger.error(f"[DeferredImageContext] Error processing image context: {e}", exc_info=True)

    async def _handle_terminating_tool(self, tc_id: str, name: str) -> AsyncGenerator[Dict[str, Any], None]:
        self._state.complete()
        yield self._message_builder.build_finish_message("agent_terminated", tools_executed=True)
        yield self._message_builder.build_llm_response_end()
        yield self._message_builder.build_termination_message()
        yield self._message_builder.build_terminating_tool_status(tc_id, name)
