import json
import time
import uuid
from typing import Dict, Any, Optional, AsyncGenerator, List
from datetime import datetime, timezone

from core.utils.logger import logger
from core.agents.pipeline.stateless.state import ToolResult
from .message_builder import _transform_mcp_tool_call

TERMINATING_TOOLS = {"ask", "complete"}

class ToolExecutor:
    def __init__(self, state, tool_registry, message_builder):
        self._state = state
        self._tool_registry = tool_registry
        self._message_builder = message_builder

    async def execute_tools(
        self, 
        stream_start: str, 
        assistant_message_id: Optional[str] = None
    ) -> AsyncGenerator[Dict[str, Any], None]:
        pending = self._state.take_pending_tools()
        available_functions = self._tool_registry.get_available_functions()
        thread_run_id = self._message_builder._get_thread_run_id()
        
        logger.debug(f"[ToolExecutor] Executing {len(pending)} tools, assistant_message_id={assistant_message_id}")

        for tool_index, tc in enumerate(pending):
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
