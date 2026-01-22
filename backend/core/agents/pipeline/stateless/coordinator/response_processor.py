import uuid
import json
import asyncio
from typing import Dict, Any, Optional, AsyncGenerator, Set, List
from datetime import datetime, timezone
from core.utils.logger import logger
from core.agentpress.native_tool_parser import is_tool_call_complete
from core.agentpress.xml_tool_parser import extract_xml_chunks, parse_xml_tool_calls_with_ids, strip_xml_tool_calls

class ResponseProcessor:
    def __init__(self, state, message_builder, tool_executor, config=None):
        self._state = state
        self._message_builder = message_builder
        self._tool_executor = tool_executor
        self._config = config

    async def process_response(self, response) -> AsyncGenerator[Dict[str, Any], None]:
        tool_calls = []
        tool_call_buffer = {}
        tool_call_sent_lengths = {}
        stream_start = datetime.now(timezone.utc).isoformat()
        llm_response_id = str(uuid.uuid4())
        auto_continue_count = self._state.step - 1
        thread_run_id = self._message_builder._get_thread_run_id()
        final_llm_response = None
        finish_processed = False 
        cleanup_done = False
        
        # Execute-on-stream tracking
        executed_tool_indices: Set[int] = set()
        pending_tool_executions: List[Dict[str, Any]] = []
        streaming_tool_index = 0
        # Store tool results from execute-on-stream to persist AFTER assistant message
        deferred_tool_results: List[Dict[str, Any]] = []
        # Pre-assign assistant_message_id so tool results can reference it during streaming
        pre_assigned_assistant_message_id = str(uuid.uuid4())

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

        try:
            async for chunk in response:
                # Check for stop/cancel on each chunk (checks flags AND cancellation_event)
                if not self._state.is_active:
                    logger.info(f"🛑 [ResponseProcessor] Stop detected during streaming, breaking out (active={self._state.is_active})")
                    break
                
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

                if delta and hasattr(delta, 'content') and delta.content:
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
                    
                    # EXECUTE-ON-STREAM: Check for complete tool calls and execute immediately
                    # Tool results are DEFERRED - stored in memory and persisted AFTER assistant message
                    if self._config and self._config.execute_on_stream:
                        for idx in sorted(tool_call_buffer.keys()):
                            if idx in executed_tool_indices:
                                continue
                            
                            tc = tool_call_buffer[idx]
                            if is_tool_call_complete(tc):
                                executed_tool_indices.add(idx)
                                logger.info(f"🚀 [ExecuteOnStream] Tool call {idx} complete, executing immediately: {tc.get('function', {}).get('name')}")
                                
                                # Execute tool but DEFER persistence - results stored in deferred_tool_results
                                # Pass pre_assigned_assistant_message_id so streaming messages have correct linkage
                                async for result_msg in self._tool_executor.execute_single_tool_streaming(
                                    tc, streaming_tool_index, stream_start, deferred_tool_results, pre_assigned_assistant_message_id
                                ):
                                    yield result_msg
                                
                                streaming_tool_index += 1
                    
                    # Check for completed async tool executions
                    for execution in pending_tool_executions:
                        if execution["task"].done() and not execution.get("processed", False):
                            execution["processed"] = True
                            try:
                                async for result_msg in execution["result_generator"]:
                                    yield result_msg
                            except Exception as e:
                                logger.error(f"[ExecuteOnStream] Error processing tool result: {e}")

                if finish_reason and not finish_processed:
                    finish_processed = True
                    # Don't set cleanup_done here - wait until _handle_finish_reason completes successfully
                    async for msg in self._handle_finish_reason(
                        finish_reason, tool_calls, tool_call_buffer, stream_start, llm_response_id, 
                        final_llm_response, executed_tool_indices, deferred_tool_results, streaming_tool_index,
                        pre_assigned_assistant_message_id
                    ):
                        yield msg
                    
                    # Only mark cleanup as done AFTER finish_reason handler completes successfully
                    cleanup_done = True
                    
                    tool_calls = []
                    tool_call_buffer = {}
                    tool_call_sent_lengths = {}

            if finish_processed:
                response_data = self._extract_usage_data(final_llm_response, llm_response_id)
                self._state.add_llm_response_end(llm_response_id, thread_run_id, response_data)
                yield self._message_builder.build_llm_response_end()
            
            # Only create assistant message here if finish_reason was NOT handled
            if not finish_processed and self._state._accumulated_content and not self._state._terminated:
                cleanup_done = True
                accumulated_content = self._state._accumulated_content
                assistant_message_id = self._state.finalize_assistant_message(
                    None, 
                    self._message_builder._get_thread_run_id()
                )
                yield self._message_builder.build_assistant_complete(
                    assistant_message_id, accumulated_content, None, stream_start
                )
                # Persist any deferred tool results
                if deferred_tool_results:
                    for result_data in deferred_tool_results:
                        self._state.record_tool_result(result_data["result"], assistant_message_id)

        finally:
            # CRITICAL: On stop/cancel, flush any pending state to DB
            # This ensures partial progress is saved even when interrupted
            if not cleanup_done and (self._state._accumulated_content or tool_call_buffer or deferred_tool_results):
                logger.warning(f"🛑 [ResponseProcessor] Cleanup on stop: content={len(self._state._accumulated_content or '')}, tool_calls={len(tool_call_buffer)}, deferred_results={len(deferred_tool_results)}")
                
                # IMPORTANT: Only include tool_calls that have EXECUTED (have deferred results)
                # Tool_calls without results would cause "out of order" validation failures
                executed_tool_call_ids = {r["result"].tool_call_id for r in deferred_tool_results} if deferred_tool_results else set()
                
                # Filter tool_calls to only those that were executed
                executed_tool_calls = None
                if tool_call_buffer and executed_tool_call_ids:
                    executed_tool_calls = [
                        tool_call_buffer[idx] 
                        for idx in sorted(tool_call_buffer.keys()) 
                        if tool_call_buffer[idx].get("id") in executed_tool_call_ids
                    ]
                    if not executed_tool_calls:
                        executed_tool_calls = None
                
                logger.info(f"🛑 [ResponseProcessor] Saving {len(executed_tool_calls or [])} executed tool_calls (filtered from {len(tool_call_buffer)} total)")
                
                # Create assistant message with content + only executed tool_calls
                # Use pre_assigned_assistant_message_id for consistency with streamed tool results
                if self._state._accumulated_content or executed_tool_calls:
                    assistant_message_id = self._state.finalize_assistant_message(
                        executed_tool_calls,
                        self._message_builder._get_thread_run_id(),
                        pre_assigned_message_id=pre_assigned_assistant_message_id
                    )
                    logger.info(f"🛑 [ResponseProcessor] Created partial assistant message: {assistant_message_id}")
                    
                    # Persist the deferred tool results
                    if deferred_tool_results:
                        logger.info(f"🛑 [ResponseProcessor] Adding {len(deferred_tool_results)} deferred tool results to pending writes")
                        for result_data in deferred_tool_results:
                            self._state.record_tool_result(result_data["result"], assistant_message_id)
                    
                    # CRITICAL: Actually flush pending writes to DB!
                    # Without this, the messages are only in memory and will be lost
                    try:
                        logger.info(f"🛑 [ResponseProcessor] Flushing {self._state.pending_write_count} pending writes to DB on stop")
                        await self._state.flush()
                        logger.info(f"🛑 [ResponseProcessor] Successfully flushed partial state to DB")
                    except Exception as e:
                        logger.error(f"🛑 [ResponseProcessor] CRITICAL: Failed to flush partial state on stop: {e}")

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
        final_llm_response = None,
        executed_tool_indices: Optional[Set[int]] = None,
        deferred_tool_results: Optional[List[Dict[str, Any]]] = None,
        streaming_tool_index: int = 0,
        pre_assigned_assistant_message_id: Optional[str] = None
    ) -> AsyncGenerator[Dict[str, Any], None]:
        if finish_reason == "tool_calls":
            async for msg in self._handle_tool_calls_finish(
                tool_calls, tool_call_buffer, stream_start, llm_response_id, 
                final_llm_response, executed_tool_indices or set(), 
                deferred_tool_results or [], streaming_tool_index,
                pre_assigned_assistant_message_id
            ):
                yield msg
        elif finish_reason in ("stop", "end_turn"):
            async for msg in self._handle_stop_finish(tool_calls, stream_start, llm_response_id, final_llm_response):
                yield msg

    async def _handle_tool_calls_finish(
        self, 
        tool_calls: list, 
        tool_call_buffer: Dict, 
        stream_start: str,
        llm_response_id: str,
        final_llm_response = None,
        executed_tool_indices: Set[int] = None,
        deferred_tool_results: List[Dict[str, Any]] = None,
        streaming_tool_index: int = 0,
        pre_assigned_assistant_message_id: Optional[str] = None
    ) -> AsyncGenerator[Dict[str, Any], None]:
        thread_run_id = self._message_builder._get_thread_run_id()
        executed_indices = executed_tool_indices or set()
        deferred_results = deferred_tool_results or []
        
        # Collect all tool calls from buffer, but only queue those not yet executed
        all_tool_calls = []
        remaining_tool_calls = []
        
        for idx in sorted(tool_call_buffer.keys()):
            tc = tool_call_buffer[idx]
            all_tool_calls.append(tc)
            if idx not in executed_indices:
                remaining_tool_calls.append(tc)
                self._state.queue_tool_call(tc)
        
        # Create assistant message FIRST (before any tool results)
        # Use pre-assigned ID if provided (for streaming tool results linkage)
        accumulated_content = self._state._accumulated_content or ""
        assistant_message_id = self._state.finalize_assistant_message(
            all_tool_calls, 
            thread_run_id,
            pre_assigned_message_id=pre_assigned_assistant_message_id
        )
        
        # NOW persist deferred tool results (they were executed during streaming but not persisted)
        if deferred_results:
            logger.info(f"[ExecuteOnStream] Persisting {len(deferred_results)} deferred tool results after assistant message")
            for result_data in deferred_results:
                self._state.record_tool_result(result_data["result"], assistant_message_id)
        
        # Check for XML tool calls if enabled
        xml_tool_calls = []
        if self._config and self._config.xml_tool_calling and accumulated_content:
            xml_chunks = extract_xml_chunks(accumulated_content)
            for chunk in xml_chunks:
                parsed = parse_xml_tool_calls_with_ids(chunk, assistant_message_id, len(all_tool_calls))
                xml_tool_calls.extend(parsed)
                # Convert XML format to native format for execution
                for xml_tc in parsed:
                    native_tc = {
                        "id": xml_tc.get("id", ""),
                        "type": "function",
                        "function": {
                            "name": xml_tc.get("function_name", ""),
                            "arguments": json.dumps(xml_tc.get("arguments", {}))
                        }
                    }
                    all_tool_calls.append(native_tc)
                    if xml_tc.get("id") not in [tc.get("id") for tc in remaining_tool_calls]:
                        remaining_tool_calls.append(native_tc)
                        self._state.queue_tool_call(native_tc)
            
            if xml_tool_calls:
                logger.info(f"[ResponseProcessor] Found {len(xml_tool_calls)} XML tool calls")
                # Strip XML from content
                accumulated_content = strip_xml_tool_calls(accumulated_content)
                self._state._accumulated_content = accumulated_content
        
        # Execute remaining tools (those not executed during streaming)
        # Track which tools complete in case stop happens mid-execution
        executed_during_remaining: Set[str] = set()
        strategy = self._config.tool_execution_strategy if self._config else "parallel"
        if remaining_tool_calls:
            logger.info(f"[ExecuteOnStream] Executing {len(remaining_tool_calls)} remaining tools (already executed: {len(executed_indices)})")
            async for r in self._tool_executor.execute_tools(stream_start, assistant_message_id, start_index=streaming_tool_index, strategy=strategy):
                # Check for stop signal on each result
                if not self._state.is_active:
                    logger.warning(f"🛑 [ResponseProcessor] Stop detected during remaining tool execution")
                    break
                
                # Track which tools completed (extract tool_call_id from result messages)
                # Tool result messages have type="tool" and tool_call_id in content or metadata
                if r.get('type') == 'tool':
                    # Try to extract tool_call_id from various message formats
                    tool_call_id = None
                    
                    # Check content first (build_tool_result puts it there)
                    content = r.get('content', {})
                    if isinstance(content, dict):
                        tool_call_id = content.get('tool_call_id')
                    
                    # Fallback to metadata
                    if not tool_call_id:
                        metadata = r.get('metadata', {})
                        if isinstance(metadata, str):
                            try:
                                metadata = json.loads(metadata)
                            except:
                                pass
                        if isinstance(metadata, dict):
                            tool_call_id = metadata.get('tool_call_id')
                    
                    # Also check top-level (some message formats)
                    if not tool_call_id:
                        tool_call_id = r.get('tool_call_id')
                    
                    if tool_call_id:
                        executed_during_remaining.add(tool_call_id)
                        logger.debug(f"[ResponseProcessor] Tracked completed tool: {tool_call_id}")
                    else:
                        logger.warning(f"[ResponseProcessor] Could not extract tool_call_id from result message: {r.get('type')}")
                
                yield r
            
            # If stopped mid-execution, filter assistant message to only keep executed tool_calls
            if not self._state.is_active:
                # Collect all executed tool_call IDs (from execute-on-stream + remaining execution)
                executed_tool_call_ids = {r["result"].tool_call_id for r in deferred_results} if deferred_results else set()
                executed_tool_call_ids.update(executed_during_remaining)
                
                # Fallback: also check _tool_results in state (in case message tracking missed some)
                state_tool_results = set(self._state._tool_results.keys())
                executed_tool_call_ids.update(state_tool_results)
                
                if executed_tool_call_ids:
                    logger.warning(f"🛑 [ResponseProcessor] Stop detected - filtering assistant message to keep {len(executed_tool_call_ids)} executed tool_calls: {executed_tool_call_ids}")
                    self._state.update_assistant_message_filter_tool_calls(
                        assistant_message_id,
                        executed_tool_call_ids
                    )
                    
                    # Force flush to persist partial state immediately
                    logger.info(f"🛑 [ResponseProcessor] Force flushing pending writes after stop")
                    try:
                        await self._state.flush()
                    except Exception as e:
                        logger.error(f"🛑 [ResponseProcessor] Failed to flush on stop: {e}")
                else:
                    logger.warning(f"🛑 [ResponseProcessor] Stop detected but no executed tool_calls to keep")
        else:
            logger.info(f"[ExecuteOnStream] All {len(executed_indices)} tools already executed during streaming")

        complete_msg = self._message_builder.build_assistant_complete(
            assistant_message_id, accumulated_content, all_tool_calls, stream_start
        )
        complete_msg["updated_at"] = datetime.now(timezone.utc).isoformat()
        logger.debug(
            f"[ResponseProcessor] Yielding assistant_complete after tools: "
            f"message_id={complete_msg.get('message_id')}, has_tool_calls={bool(all_tool_calls)}"
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
        assistant_message_id = self._state.finalize_assistant_message(
            tool_calls if tool_calls else None, 
            thread_run_id
        )
        complete_msg = self._message_builder.build_assistant_complete(
            assistant_message_id, accumulated_content, tool_calls if tool_calls else None, stream_start
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
        