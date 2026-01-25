import asyncio
import uuid
import json
from typing import Dict, Any, Optional, AsyncGenerator, List, Set
from datetime import datetime, timezone
from core.utils.logger import logger
from core.utils.config import config
from core.agentpress.native_tool_parser import is_tool_call_complete, convert_to_exec_tool_call
from .tool_executor import PendingToolExecution

TERMINATING_TOOLS = {"ask", "complete"}

def _parse_metadata(msg: Dict[str, Any]) -> Dict[str, Any]:
    metadata = msg.get("metadata", {})
    if isinstance(metadata, str):
        try:
            return json.loads(metadata)
        except (json.JSONDecodeError, TypeError):
            return {}
    return metadata if isinstance(metadata, dict) else {}


class ResponseProcessor:
    def __init__(self, state, message_builder, tool_executor):
        self._state = state
        self._message_builder = message_builder
        self._tool_executor = tool_executor

    async def process_response(self, response) -> AsyncGenerator[Dict[str, Any], None]:
        tool_calls = []
        tool_call_buffer: Dict[int, Dict[str, Any]] = {}
        tool_call_sent_lengths: Dict[int, int] = {}
        executed_tool_indices: Set[int] = set()
        pending_executions: List[PendingToolExecution] = []
        agent_should_terminate = False
        tool_index_counter = 0
        
        stream_start = datetime.now(timezone.utc).isoformat()
        llm_response_id = str(uuid.uuid4())
        auto_continue_count = self._state.step - 1
        thread_run_id = self._message_builder._get_thread_run_id()
        final_llm_response = None
        finish_processed = False
        
        assistant_message_id: Optional[str] = None
        
        execute_on_stream = config.AGENT_EXECUTE_ON_STREAM
        logger.debug(f"[ResponseProcessor] execute_on_stream={execute_on_stream}")

        if auto_continue_count == 0:
            self._state.add_status_message(
                {"status_type": "thread_run_start"},
                {"thread_run_id": thread_run_id}
            )
        yield self._message_builder.build_thread_run_start(stream_start)
        
        self._state.add_llm_response_start(
            llm_response_id, auto_continue_count, self._state.model_name, thread_run_id
        )
        yield self._message_builder.build_llm_response_start(
            llm_response_id, auto_continue_count, self._state.model_name, stream_start
        )

        async for chunk in response:
            if isinstance(chunk, dict):
                if chunk.get("__llm_ttft_seconds__"):
                    yield self._message_builder.build_llm_ttft(
                        chunk["__llm_ttft_seconds__"],
                        self._state.model_name,
                        self._state.thread_id
                    )
                    continue

                chunk_type = chunk.get("type")
                if chunk_type == "content":
                    self._state.append_content(chunk.get("content", ""))
                    yield chunk
                elif chunk_type == "tool_call":
                    tc = chunk.get("tool_call", {})
                    tool_calls.append(tc)
                    self._state.queue_tool_call(tc)
                    yield chunk
                else:
                    yield chunk
                continue

            if hasattr(chunk, 'usage') and chunk.usage and final_llm_response is None:
                final_llm_response = chunk
                logger.debug(f"📊 [ResponseProcessor] Captured usage: prompt={getattr(chunk.usage, 'prompt_tokens', 0)}, completion={getattr(chunk.usage, 'completion_tokens', 0)}")
            
            if not hasattr(chunk, 'choices') or not chunk.choices:
                continue

            choice = chunk.choices[0]
            delta = getattr(choice, 'delta', None)
            finish_reason = getattr(choice, 'finish_reason', None)

            # Handle reasoning/thinking content (extended thinking, MiniMax reasoning, etc.)
            if delta and hasattr(delta, 'reasoning_content') and delta.reasoning_content:
                reasoning = delta.reasoning_content
                self._state.append_reasoning(reasoning)
                yield self._message_builder.build_reasoning_chunk(reasoning, stream_start)

            if delta and hasattr(delta, 'content') and delta.content:
                # Check if content is a list of content blocks (Anthropic extended thinking format)
                if isinstance(delta.content, list):
                    for block in delta.content:
                        block_type = getattr(block, 'type', None) if hasattr(block, 'type') else block.get('type') if isinstance(block, dict) else None
                        block_text = getattr(block, 'text', None) if hasattr(block, 'text') else block.get('text') if isinstance(block, dict) else None

                        if block_type == 'thinking' and block_text:
                            self._state.append_reasoning(block_text)
                            yield self._message_builder.build_reasoning_chunk(block_text, stream_start)
                        elif block_type == 'text' and block_text:
                            self._state.append_content(block_text)
                            yield self._message_builder.build_content_chunk(block_text, stream_start)
                        elif block_text:
                            # Default to content if type is unknown
                            self._state.append_content(block_text)
                            yield self._message_builder.build_content_chunk(block_text, stream_start)
                else:
                    content = self._extract_content(delta.content)
                    self._state.append_content(content)
                    yield self._message_builder.build_content_chunk(content, stream_start)

            if delta and hasattr(delta, 'tool_calls') and delta.tool_calls:
                self._process_tool_call_deltas(delta.tool_calls, tool_call_buffer)
                tc_chunk = self._message_builder.build_tool_call_chunk(
                    tool_call_buffer, stream_start, tool_call_sent_lengths
                )
                if tc_chunk:
                    yield tc_chunk
                
                # Execute on stream: check for complete tool calls and start execution
                if execute_on_stream:
                    for idx in sorted(tool_call_buffer.keys()):
                        if idx in executed_tool_indices:
                            continue
                        
                        if is_tool_call_complete(tool_call_buffer[idx]):
                            executed_tool_indices.add(idx)
                            
                            tc_buf = tool_call_buffer[idx]
                            tool_call_data = {
                                "id": tc_buf.get("id"),
                                "function": {
                                    "name": tc_buf.get("function", {}).get("name"),
                                    "arguments": tc_buf.get("function", {}).get("arguments", "{}")
                                }
                            }
                            
                            # Reserve assistant message ID if needed (for linking tool results)
                            # Don't finalize yet - we'll do that at the end with all tool calls
                            if assistant_message_id is None:
                                assistant_message_id = self._state.reserve_assistant_message_id()
                                logger.debug(f"[ResponseProcessor] Reserved assistant message ID: {assistant_message_id}")
                            
                            started_msg = self._tool_executor.yield_tool_started(
                                tool_call_data, tool_index_counter, stream_start
                            )
                            yield started_msg
                            
                            execution = self._tool_executor.start_tool_execution(
                                tool_call_data,
                                tool_index_counter,
                                assistant_message_id
                            )
                            pending_executions.append(execution)
                            tool_index_counter += 1
                            
                            logger.debug(f"[ResponseProcessor] Started async execution for {tc_buf.get('function', {}).get('name')}")
            
            if execute_on_stream and pending_executions:
                async for msg in self._process_completed_executions(
                    pending_executions, stream_start, defer_message=True
                ):
                    yield msg
                    if msg.get("type") == "status" and _parse_metadata(msg).get("agent_should_terminate"):
                        agent_should_terminate = True

            if finish_reason and not finish_processed:
                finish_processed = True

                has_tool_calls = pending_executions or any(
                    is_tool_call_complete(tool_call_buffer.get(idx, {})) 
                    for idx in tool_call_buffer.keys()
                )
                
                if execute_on_stream and has_tool_calls:
                    async for msg in self._wait_and_process_remaining_executions(
                        pending_executions, stream_start, tool_call_buffer, tool_calls, 
                        executed_tool_indices, tool_index_counter, assistant_message_id, thread_run_id
                    ):
                        yield msg
                        if msg.get("type") == "status" and _parse_metadata(msg).get("agent_should_terminate"):
                            agent_should_terminate = True
                    
                    if assistant_message_id:
                        complete_tool_calls = self._build_complete_tool_calls(tool_call_buffer)

                        accumulated_content = self._state._accumulated_content or ""
                        accumulated_reasoning = self._state._accumulated_reasoning or ""

                        finalized_id = self._state.finalize_assistant_message(
                            tool_calls=complete_tool_calls,
                            thread_run_id=thread_run_id,
                            message_id=assistant_message_id
                        )

                        committed_count = self._state.commit_deferred_tool_results()
                        logger.debug(f"[ResponseProcessor] Finalized assistant message with {len(complete_tool_calls)} tool calls: {finalized_id}, committed {committed_count} tool results")

                        self._state.trigger_flush()

                        complete_msg = self._message_builder.build_assistant_complete(
                            finalized_id, accumulated_content, complete_tool_calls, stream_start,
                            reasoning_content=accumulated_reasoning if accumulated_reasoning else None
                        )
                        complete_msg["updated_at"] = datetime.now(timezone.utc).isoformat()
                        yield complete_msg
                    
                    self._state.add_status_message(
                        {"status_type": "finish", "finish_reason": finish_reason, "tools_executed": True},
                        {"thread_run_id": thread_run_id, "agent_should_terminate": agent_should_terminate}
                    )
                    yield self._message_builder.build_finish_message(finish_reason, tools_executed=True)
                else:
                    async for msg in self._handle_finish_reason(
                        finish_reason, tool_calls, tool_call_buffer, stream_start, llm_response_id, None
                    ):
                        yield msg
                
                tool_calls = []
                tool_call_buffer = {}
                tool_call_sent_lengths = {}

        if finish_processed:
            response_data = self._extract_usage_data(final_llm_response, llm_response_id)
            self._state.add_llm_response_end(llm_response_id, thread_run_id, response_data)
            yield self._message_builder.build_llm_response_end()
        
        if self._state._accumulated_content and not self._state._terminated and assistant_message_id is None:
            accumulated_content = self._state._accumulated_content
            accumulated_reasoning = self._state._accumulated_reasoning or ""
            assistant_message_id = self._state.finalize_assistant_message(
                tool_calls if tool_calls else None,
                self._message_builder._get_thread_run_id()
            )
            yield self._message_builder.build_assistant_complete(
                assistant_message_id, accumulated_content, tool_calls if tool_calls else None, stream_start,
                reasoning_content=accumulated_reasoning if accumulated_reasoning else None
            )
    
    async def _process_completed_executions(
        self,
        pending_executions: List[PendingToolExecution],
        stream_start: str,
        defer_message: bool = False
    ) -> AsyncGenerator[Dict[str, Any], None]:
        completed_indices = []
        
        for i, execution in enumerate(pending_executions):
            if execution.task.done() and not execution.saved:
                completed_indices.append(i)
                async for msg in self._tool_executor.process_completed_execution(
                    execution, stream_start, defer_message=defer_message
                ):
                    yield msg
        
        for i in reversed(completed_indices):
            pending_executions.pop(i)
    
    async def _wait_and_process_remaining_executions(
        self,
        pending_executions: List[PendingToolExecution],
        stream_start: str,
        tool_call_buffer: Dict[int, Dict[str, Any]],
        tool_calls: list,
        executed_indices: Set[int],
        tool_index_counter: int,
        assistant_message_id: Optional[str],
        thread_run_id: str
    ) -> AsyncGenerator[Dict[str, Any], None]:
        for idx in sorted(tool_call_buffer.keys()):
            if idx in executed_indices:
                continue
            
            if is_tool_call_complete(tool_call_buffer[idx]):
                executed_indices.add(idx)
                tc_buf = tool_call_buffer[idx]
                tool_call_data = {
                    "id": tc_buf.get("id"),
                    "function": {
                        "name": tc_buf.get("function", {}).get("name"),
                        "arguments": tc_buf.get("function", {}).get("arguments", "{}")
                    }
                }
                
                if assistant_message_id is None:
                    assistant_message_id = self._state.reserve_assistant_message_id()
                    logger.debug(f"[ResponseProcessor] Reserved assistant message ID in remaining: {assistant_message_id}")
                
                started_msg = self._tool_executor.yield_tool_started(
                    tool_call_data, tool_index_counter, stream_start
                )
                yield started_msg
                
                execution = self._tool_executor.start_tool_execution(
                    tool_call_data,
                    tool_index_counter,
                    assistant_message_id
                )
                pending_executions.append(execution)
                tool_index_counter += 1
        
        if pending_executions:
            logger.debug(f"[ResponseProcessor] Waiting for {len(pending_executions)} remaining tool executions")
            
            pending_tasks = [e.task for e in pending_executions if not e.task.done()]
            if pending_tasks:
                done, _ = await asyncio.wait(pending_tasks, return_when=asyncio.ALL_COMPLETED)
                
                for task in done:
                    if task.exception():
                        exc = task.exception()
                        logger.error(f"[ResponseProcessor] Tool execution task failed: {exc}", exc_info=exc)
            
            for execution in pending_executions:
                if not execution.saved:
                    async for msg in self._tool_executor.process_completed_execution(
                        execution, stream_start, defer_message=True
                    ):
                        yield msg
    
    def _build_complete_tool_calls(self, tool_call_buffer: Dict[int, Dict[str, Any]]) -> List[Dict[str, Any]]:
        complete_tool_calls = []
        for idx in sorted(tool_call_buffer.keys()):
            tc_buf = tool_call_buffer[idx]
            if tc_buf.get('id') and tc_buf.get('function', {}).get('name'):
                complete_tool_calls.append({
                    "id": tc_buf['id'],
                    "type": "function",
                    "function": {
                        "name": tc_buf['function']['name'],
                        "arguments": tc_buf['function'].get('arguments', '{}')
                    }
                })
        return complete_tool_calls

    def _extract_content(self, content) -> str:
        if isinstance(content, list):
            return ''.join(str(item) for item in content)
        return content
    
    def _extract_usage_data(self, final_llm_response, llm_response_id: str) -> Dict[str, Any]:
        response_data = {"llm_response_id": llm_response_id}
        
        if final_llm_response and hasattr(final_llm_response, 'usage') and final_llm_response.usage:
            usage = final_llm_response.usage
            response_data["usage"] = {
                "prompt_tokens": getattr(usage, 'prompt_tokens', 0),
                "completion_tokens": getattr(usage, 'completion_tokens', 0),
                "total_tokens": getattr(usage, 'total_tokens', 0),
            }
            
            if hasattr(usage, 'cache_read_input_tokens'):
                response_data["usage"]["cache_read_input_tokens"] = getattr(usage, 'cache_read_input_tokens', 0)
            if hasattr(usage, 'cache_creation_input_tokens'):
                response_data["usage"]["cache_creation_input_tokens"] = getattr(usage, 'cache_creation_input_tokens', 0)
            if hasattr(usage, 'prompt_tokens_details'):
                details = usage.prompt_tokens_details
                response_data["usage"]["prompt_tokens_details"] = {
                    "cached_tokens": getattr(details, 'cached_tokens', 0),
                }
            
            if hasattr(final_llm_response, 'model'):
                response_data["model"] = final_llm_response.model
            
            logger.info(f"💰 [ResponseProcessor] Usage data for billing: {response_data['usage']}")
        else:
            logger.warning(f"⚠️ [ResponseProcessor] No usage data available from LLM response")
        
        return response_data

    def _process_tool_call_deltas(self, tool_calls, tool_call_buffer):
        for tc_delta in tool_calls:
            tc_index = tc_delta.index if hasattr(tc_delta, 'index') else 0

            if tc_index not in tool_call_buffer:
                tool_call_buffer[tc_index] = {
                    "id": "",
                    "type": "function",
                    "function": {"name": "", "arguments": ""}
                }

            buf = tool_call_buffer[tc_index]

            if hasattr(tc_delta, 'id') and tc_delta.id:
                buf["id"] = tc_delta.id

            if hasattr(tc_delta, 'function') and tc_delta.function:
                fn = tc_delta.function
                if hasattr(fn, 'name') and fn.name:
                    buf["function"]["name"] = fn.name
                if hasattr(fn, 'arguments') and fn.arguments:
                    buf["function"]["arguments"] += fn.arguments

    async def _handle_finish_reason(
        self,
        finish_reason: str,
        tool_calls: list,
        tool_call_buffer: Dict,
        stream_start: str,
        llm_response_id: str,
        final_llm_response = None
    ) -> AsyncGenerator[Dict[str, Any], None]:
        if finish_reason == "tool_calls":
            async for msg in self._handle_tool_calls_finish(tool_calls, tool_call_buffer, stream_start, llm_response_id, final_llm_response):
                yield msg
        elif finish_reason in ("stop", "end_turn"):
            async for msg in self._handle_stop_finish(tool_calls, stream_start, llm_response_id, final_llm_response):
                yield msg
        elif finish_reason == "length":
            # Handle max tokens reached - save content and emit finish message for auto-continue
            async for msg in self._handle_length_finish(tool_calls, stream_start, llm_response_id, final_llm_response):
                yield msg

    async def _handle_tool_calls_finish(
        self, 
        tool_calls: list, 
        tool_call_buffer: Dict, 
        stream_start: str,
        llm_response_id: str,
        final_llm_response = None
    ) -> AsyncGenerator[Dict[str, Any], None]:
        thread_run_id = self._message_builder._get_thread_run_id()
        
        for idx in sorted(tool_call_buffer.keys()):
            tc = tool_call_buffer[idx]
            tool_calls.append(tc)
            self._state.queue_tool_call(tc)

        accumulated_content = self._state._accumulated_content or ""
        accumulated_reasoning = self._state._accumulated_reasoning or ""
        assistant_message_id = self._state.finalize_assistant_message(
            tool_calls,
            thread_run_id
        )

        async for r in self._tool_executor.execute_tools(stream_start, assistant_message_id):
            yield r

        self._state.trigger_flush()

        complete_msg = self._message_builder.build_assistant_complete(
            assistant_message_id, accumulated_content, tool_calls, stream_start,
            reasoning_content=accumulated_reasoning if accumulated_reasoning else None
        )
        complete_msg["updated_at"] = datetime.now(timezone.utc).isoformat()
        logger.debug(
            f"[ResponseProcessor] Yielding assistant_complete after tools: "
            f"message_id={complete_msg.get('message_id')}, has_tool_calls={bool(tool_calls)}"
        )
        yield complete_msg

        self._state.add_status_message(
            {"status_type": "finish", "finish_reason": "tool_calls", "tools_executed": True},
            {"thread_run_id": thread_run_id}
        )
        yield self._message_builder.build_finish_message("tool_calls", tools_executed=True)

    async def _handle_stop_finish(
        self,
        tool_calls: list,
        stream_start: str,
        llm_response_id: str,
        final_llm_response = None
    ) -> AsyncGenerator[Dict[str, Any], None]:
        thread_run_id = self._message_builder._get_thread_run_id()

        accumulated_content = self._state._accumulated_content or ""
        accumulated_reasoning = self._state._accumulated_reasoning or ""
        assistant_message_id = self._state.finalize_assistant_message(
            tool_calls if tool_calls else None,
            thread_run_id
        )

        self._state.trigger_flush()

        complete_msg = self._message_builder.build_assistant_complete(
            assistant_message_id, accumulated_content, tool_calls if tool_calls else None, stream_start,
            reasoning_content=accumulated_reasoning if accumulated_reasoning else None
        )
        logger.debug(
            f"[ResponseProcessor] Yielding assistant_complete (stop): "
            f"message_id={complete_msg.get('message_id')}, content_len={len(accumulated_content)}"
        )
        yield complete_msg

        self._state.add_status_message(
            {"status_type": "finish", "finish_reason": "stop"},
            {"thread_run_id": thread_run_id}
        )
        yield self._message_builder.build_finish_message("stop")

    async def _handle_length_finish(
        self,
        tool_calls: list,
        stream_start: str,
        llm_response_id: str,
        final_llm_response = None
    ) -> AsyncGenerator[Dict[str, Any], None]:
        """Handle finish_reason='length' (max tokens reached). Saves content and emits status for auto-continue."""
        thread_run_id = self._message_builder._get_thread_run_id()

        accumulated_content = self._state._accumulated_content or ""
        accumulated_reasoning = self._state._accumulated_reasoning or ""

        logger.info(f"[ResponseProcessor] Max tokens reached, saving {len(accumulated_content)} chars of content")

        assistant_message_id = self._state.finalize_assistant_message(
            tool_calls if tool_calls else None,
            thread_run_id
        )

        self._state.trigger_flush()

        complete_msg = self._message_builder.build_assistant_complete(
            assistant_message_id, accumulated_content, tool_calls if tool_calls else None, stream_start,
            reasoning_content=accumulated_reasoning if accumulated_reasoning else None
        )
        logger.debug(
            f"[ResponseProcessor] Yielding assistant_complete (length): "
            f"message_id={complete_msg.get('message_id')}, content_len={len(accumulated_content)}"
        )
        yield complete_msg

        self._state.add_status_message(
            {"status_type": "finish", "finish_reason": "length"},
            {"thread_run_id": thread_run_id}
        )
        yield self._message_builder.build_finish_message("length")
        