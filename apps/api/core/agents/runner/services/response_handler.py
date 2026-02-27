import json
import asyncio
from typing import Optional, Dict, Any, Tuple

from core.utils.logger import logger
from core.agentpress.error_processor import ErrorProcessor


class ResponseHandler:
    def __init__(self, thread_id: str):
        self.thread_id = thread_id

    def process_chunk(self, chunk: Dict[str, Any]) -> Tuple[bool, bool, Optional[str]]:
        if isinstance(chunk, dict) and chunk.get('type') == 'status' and chunk.get('status') == 'error':
            return True, True, None

        if isinstance(chunk, dict) and chunk.get('type') == 'status':
            try:
                content = chunk.get('content', {})
                if isinstance(content, str):
                    content = json.loads(content)

                if content.get('status_type') == 'error':
                    return True, True, None

                metadata = chunk.get('metadata', {})
                if isinstance(metadata, str):
                    metadata = json.loads(metadata)

                if metadata.get('agent_should_terminate'):
                    tool_call = content.get('function_name')
                    return True, False, tool_call
            except Exception:
                pass

        if chunk.get('type') == 'assistant' and 'content' in chunk:
            try:
                content = chunk.get('content', '{}')
                if isinstance(content, str):
                    content = json.loads(content)

                text = content.get('content', '')
                if isinstance(text, str):
                    if '</ask>' in text:
                        return True, False, 'ask'
                    elif '</complete>' in text:
                        return True, False, 'complete'
            except Exception:
                pass

        return False, False, None

    async def process_response_stream(
        self,
        response,
        generation,
        cancellation_event: Optional[asyncio.Event],
        stream_status_message_fn
    ):
        from core.agents.runner.services.utils import stream_status_message
        
        last_tool_call = None
        agent_should_terminate = False
        error_detected = False
        first_chunk_received = False

        try:
            if hasattr(response, '__aiter__') and not isinstance(response, dict):
                async for chunk in response:
                    if cancellation_event and cancellation_event.is_set():
                        break

                    if not first_chunk_received:
                        first_chunk_received = True
                        if isinstance(chunk, dict) and chunk.get('type') == 'llm_ttft':
                            ttft = chunk.get('ttft_seconds', 0)
                            await stream_status_message("llm_streaming", f"First token received (TTFT: {ttft:.2f}s)")
                        else:
                            await stream_status_message("llm_streaming", "LLM stream started")

                    should_terminate, error, tool_call = self.process_chunk(chunk)

                    if error:
                        error_detected = True
                        yield chunk
                        if should_terminate:
                            break
                        continue

                    if should_terminate:
                        agent_should_terminate = True
                        if tool_call:
                            last_tool_call = tool_call

                    yield chunk
            else:
                if isinstance(response, dict) and response.get('type') == 'status' and response.get('status') == 'error':
                    error_detected = True
                    yield response

            if error_detected:
                if generation:
                    generation.end(status_message="error_detected", level="ERROR")
                return

            if agent_should_terminate or last_tool_call in ['ask', 'complete']:
                if generation:
                    generation.end(status_message="agent_stopped")
                yield {"type": "status", "status": "stopped", "message": f"Agent completed (tool={last_tool_call})"}

        except Exception as e:
            processed_error = ErrorProcessor.process_system_error(e, context={"thread_id": self.thread_id})
            if generation:
                generation.end(status_message=processed_error.message, level="ERROR")
            yield processed_error.to_stream_dict()
