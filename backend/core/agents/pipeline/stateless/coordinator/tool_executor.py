import asyncio
import json
import time
import uuid
from typing import Dict, Any, Optional, AsyncGenerator, List, Tuple
from datetime import datetime, timezone
from dataclasses import dataclass, field

from core.utils.logger import logger
from core.agents.pipeline.stateless.state import ToolResult
from .message_builder import _transform_mcp_tool_call

TERMINATING_TOOLS = {"ask", "complete"}

@dataclass
class PendingToolExecution:
    task: asyncio.Task
    tool_call: Dict[str, Any]
    tool_index: int
    tool_call_id: str
    function_name: str
    display_name: str
    arguments: str
    start_time: float = field(default_factory=time.time)
    saved: bool = False
    assistant_message_id: Optional[str] = None

class ToolExecutor:
    def __init__(self, state, tool_registry, message_builder):
        self._state = state
        self._tool_registry = tool_registry
        self._message_builder = message_builder
    def _get_available_functions(self) -> Dict:
        return self._tool_registry.get_available_functions()
    
    def start_tool_execution(
        self,
        tool_call: Dict[str, Any],
        tool_index: int,
        assistant_message_id: Optional[str] = None
    ) -> PendingToolExecution:
        tc_id = tool_call.get("id", str(uuid.uuid4()))
        func = tool_call.get("function", {})
        name = func.get("name", "unknown")
        args = func.get("arguments", "{}")
        display_name, _ = _transform_mcp_tool_call(name, args)
        
        available_functions = self._get_available_functions()
        
        task = asyncio.create_task(
            self._execute_single_tool(name, args, available_functions)
        )
        
        return PendingToolExecution(
            task=task,
            tool_call=tool_call,
            tool_index=tool_index,
            tool_call_id=tc_id,
            function_name=name,
            display_name=display_name,
            arguments=args,
            assistant_message_id=assistant_message_id
        )
    
    async def process_completed_execution(
        self,
        execution: PendingToolExecution,
        stream_start: str,
        defer_message: bool = False
    ) -> AsyncGenerator[Dict[str, Any], None]:
        """Process a completed tool execution.
        
        Args:
            execution: The completed PendingToolExecution
            stream_start: ISO timestamp of stream start
            defer_message: If True, defer adding the tool result message to state.
                          Used for execute_on_stream to ensure proper ordering.
        """
        if execution.saved:
            return
        
        try:
            output, success, error = execution.task.result()
        except Exception as e:
            output, success, error = None, False, str(e)
            logger.error(f"[ToolExecutor] Task exception for {execution.function_name}: {e}")
        
        exec_time = (time.time() - execution.start_time) * 1000
        execution.saved = True
        
        logger.debug(f"[ToolExecutor] Tool {execution.function_name} completed in {exec_time:.1f}ms, success={success}")
        
        self._state.record_tool_result(
            ToolResult(
                tool_call_id=execution.tool_call_id,
                tool_name=execution.function_name,
                success=success,
                output=output,
                error=error,
                execution_time_ms=exec_time,
            ),
            execution.assistant_message_id,
            defer_message=defer_message
        )
        
        tool_result_msg = self._message_builder.build_tool_result(
            execution.tool_call_id,
            execution.display_name,
            output,
            success,
            error,
            execution.tool_index,
            stream_start,
            execution.assistant_message_id
        )
        tool_result_message_id = tool_result_msg.get("message_id")
        logger.debug(f"[ToolExecutor] Yielding tool result: {execution.tool_call_id}, message_id={tool_result_message_id}")
        yield tool_result_msg
        
        thread_run_id = self._message_builder._get_thread_run_id()
        status_type = "tool_completed" if success else "tool_failed"
        status_content = {
            "tool_index": execution.tool_index,
            "status_type": status_type,
            "tool_call_id": execution.tool_call_id,
            "function_name": execution.display_name
        }
        status_metadata = {"thread_run_id": thread_run_id}
        if tool_result_message_id:
            status_metadata["linked_tool_result_message_id"] = tool_result_message_id
        
        self._state.add_status_message(status_content, status_metadata)
        
        is_terminating = execution.function_name in TERMINATING_TOOLS
        yield self._message_builder.build_tool_completed(
            execution.tool_call_id,
            execution.display_name,
            success,
            execution.tool_index,
            stream_start,
            tool_result_message_id,
            is_terminating
        )
        
        if success and output:
            async for msg in self._handle_deferred_image_context(output, stream_start):
                yield msg
        
        if is_terminating and success:
            async for msg in self._handle_terminating_tool(execution.tool_call_id, execution.function_name):
                yield msg

    def yield_tool_started(
        self,
        tool_call: Dict[str, Any],
        tool_index: int,
        stream_start: str
    ) -> Dict[str, Any]:
        tc_id = tool_call.get("id", "")
        func = tool_call.get("function", {})
        name = func.get("name", "unknown")
        args = func.get("arguments", "{}")
        display_name, _ = _transform_mcp_tool_call(name, args)
        thread_run_id = self._message_builder._get_thread_run_id()
        
        self._state.add_status_message(
            {
                "tool_index": tool_index,
                "status_type": "tool_started",
                "tool_call_id": tc_id,
                "function_name": display_name
            },
            {"thread_run_id": thread_run_id}
        )
        
        return self._message_builder.build_tool_started(tc_id, display_name, tool_index, stream_start, args)

    async def execute_tools(
        self, 
        stream_start: str, 
        assistant_message_id: Optional[str] = None
    ) -> AsyncGenerator[Dict[str, Any], None]:
        pending = self._state.take_pending_tools()
        available_functions = self._get_available_functions()
        thread_run_id = self._message_builder._get_thread_run_id()
        
        logger.debug(f"[ToolExecutor] Executing {len(pending)} tools sequentially, assistant_message_id={assistant_message_id}")

        for tool_index, tc in enumerate(pending):
            tc_id = tc.get("id", "")
            func = tc.get("function", {})
            name = func.get("name", "unknown")
            args = func.get("arguments", "{}")
            
            display_name, _ = _transform_mcp_tool_call(name, args)
            
            logger.debug(f"[ToolExecutor] Tool {tool_index}: {name} (id={tc_id})")

            is_terminating = name in TERMINATING_TOOLS
            
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

    async def _execute_single_tool(
        self, 
        name: str, 
        args: str, 
        available_functions: Dict
    ) -> tuple[Any, bool, Optional[str]]:
        try:
            parsed = json.loads(args) if isinstance(args, str) else args
            tool_fn = available_functions.get(name)
            
            if name == "create_slide":
                debug_args = {k: (v[:100] + '...' if isinstance(v, str) and len(v) > 100 else v) for k, v in parsed.items()} if isinstance(parsed, dict) else parsed
                logger.info(f"[ToolExecutor] Executing {name} with parsed args: {debug_args}")
                logger.info(f"[ToolExecutor] DEBUG: tool_fn={tool_fn}, module={getattr(tool_fn, '__module__', 'unknown')}, qualname={getattr(tool_fn, '__qualname__', 'unknown')}")

            if tool_fn:
                if name == "create_slide":
                    logger.info(f"[ToolExecutor] About to call create_slide...")
                result = await tool_fn(**parsed)
                if name == "create_slide":
                    logger.info(f"[ToolExecutor] create_slide returned: success={getattr(result, 'success', 'N/A')}, output={str(getattr(result, 'output', 'N/A'))[:200]}")
                if hasattr(result, 'success') and hasattr(result, 'output'):
                    success = result.success
                    output = result.output
                    error = None if success else str(result.output)
                    if not success:
                        logger.error(f"[ToolExecutor] Tool {name} returned success=False, output: {str(output)[:500]}")
                else:
                    success = True
                    output = result
                    error = None
            else:
                output, success, error = None, False, f"Tool '{name}' not found"

        except Exception as e:
            output, success, error = None, False, str(e)
            logger.warning(f"[ToolExecutor] Tool {name} failed with exception: {e}")

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
