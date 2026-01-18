import asyncio
import json
from typing import Optional, Dict, Any, TypeVar

from core.utils.logger import logger
from core.services import redis
from core.utils.tool_output_streaming import get_tool_output_streaming_context

T = TypeVar('T')


async def with_timeout(coro, timeout_seconds: float, operation_name: str, default=None):
    try:
        return await asyncio.wait_for(coro, timeout=timeout_seconds)
    except asyncio.TimeoutError:
        logger.warning(f"⚠️ [TIMEOUT] {operation_name} timed out after {timeout_seconds}s - continuing with default")
        return default
    except Exception as e:
        logger.warning(f"⚠️ [ERROR] {operation_name} failed: {e} - continuing with default")
        return default


async def stream_status_message(
    status: str,
    message: str,
    metadata: Optional[Dict[str, Any]] = None,
    stream_key: Optional[str] = None
) -> None:
    if not stream_key:
        ctx = get_tool_output_streaming_context()
        if ctx:
            stream_key = ctx.stream_key
        else:
            return

    try:
        status_msg = {"type": "status", "status": status, "message": message}
        if metadata:
            status_msg["metadata"] = metadata

        await asyncio.wait_for(
            redis.stream_add(stream_key, {"data": json.dumps(status_msg)}, maxlen=200, approximate=True),
            timeout=2.0
        )
    except (asyncio.TimeoutError, Exception) as e:
        logger.debug(f"Failed to write status message (non-critical): {e}")


def check_terminating_tool_call(response: Dict[str, Any]) -> Optional[str]:
    if response.get('type') != 'status':
        return None

    metadata = response.get('metadata', {})
    if isinstance(metadata, str):
        try:
            metadata = json.loads(metadata)
        except (json.JSONDecodeError, TypeError):
            metadata = {}

    if not metadata.get('agent_should_terminate'):
        return None

    content = response.get('content', {})
    if isinstance(content, str):
        try:
            content = json.loads(content)
        except (json.JSONDecodeError, TypeError):
            content = {}

    if isinstance(content, dict):
        function_name = content.get('function_name')
        if function_name in ['ask', 'complete']:
            return function_name

    return None
