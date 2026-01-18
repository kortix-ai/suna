import uuid
import json
from typing import Dict, Any, Optional, AsyncGenerator
from datetime import datetime, timezone
from core.utils.logger import logger

class ResponseProcessor:
    def __init__(self, state, message_builder, tool_executor):
        self._state = state
        self._message_builder = message_builder
        self._tool_executor = tool_executor

    async def process_response(self, response) -> AsyncGenerator[Dict[str, Any], None]:
        tool_calls = []
        tool_call_buffer = {}
        tool_call_sent_lengths = {}
        stream_start = datetime.now(timezone.utc).isoformat()
        llm_response_id = str(uuid.uuid4())
        auto_continue_count = self._state.step - 1
        thread_run_id = self._message_builder._get_thread_run_id()

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

            if finish_reason:
                async for msg in self._handle_finish_reason(
                    finish_reason, tool_calls, tool_call_buffer, stream_start, llm_response_id
                ):
                    yield msg
                
                tool_calls = []
                tool_call_buffer = {}
                tool_call_sent_lengths = {}

        if self._state._accumulated_content and not self._state._terminated:
            accumulated_content = self._state._accumulated_content
            assistant_message_id = self._state.finalize_assistant_message(
                tool_calls if tool_calls else None, 
                self._message_builder._get_thread_run_id()
            )
            yield self._message_builder.build_assistant_complete(
                assistant_message_id, accumulated_content, tool_calls if tool_calls else None, stream_start
            )

    def _extract_content(self, content) -> str:
        if isinstance(content, list):
            return ''.join(str(item) for item in content)
        return content

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
        llm_response_id: str
    ) -> AsyncGenerator[Dict[str, Any], None]:
        if finish_reason == "tool_calls":
            async for msg in self._handle_tool_calls_finish(tool_calls, tool_call_buffer, stream_start, llm_response_id):
                yield msg
        elif finish_reason in ("stop", "end_turn"):
            async for msg in self._handle_stop_finish(tool_calls, stream_start, llm_response_id):
                yield msg

    async def _handle_tool_calls_finish(
        self, 
        tool_calls: list, 
        tool_call_buffer: Dict, 
        stream_start: str,
        llm_response_id: str
    ) -> AsyncGenerator[Dict[str, Any], None]:
        thread_run_id = self._message_builder._get_thread_run_id()
        
        for idx in sorted(tool_call_buffer.keys()):
            tc = tool_call_buffer[idx]
            tool_calls.append(tc)
            self._state.queue_tool_call(tc)

        accumulated_content = self._state._accumulated_content or ""
        assistant_message_id = self._state.finalize_assistant_message(
            tool_calls, 
            thread_run_id
        )
        
        async for r in self._tool_executor.execute_tools(stream_start, assistant_message_id):
            yield r

        complete_msg = self._message_builder.build_assistant_complete(
            assistant_message_id, accumulated_content, tool_calls, stream_start
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
        
        self._state.add_llm_response_end(llm_response_id, thread_run_id)
        yield self._message_builder.build_llm_response_end()

    async def _handle_stop_finish(
        self, 
        tool_calls: list, 
        stream_start: str,
        llm_response_id: str
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
        
        self._state.add_llm_response_end(llm_response_id, thread_run_id)
        yield self._message_builder.build_llm_response_end()
