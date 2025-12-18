import json
import asyncio
from contextvars import ContextVar
from typing import Optional, Dict, Any
from dataclasses import dataclass

from core.utils.logger import logger


@dataclass
class StreamingContext:
    agent_run_id: str
    pubsub_channel: str
    stream_key: str
    tool_call_id: Optional[str] = None


_streaming_context: ContextVar[Optional[StreamingContext]] = ContextVar(
    'streaming_context', 
    default=None
)


def set_streaming_context(
    agent_run_id: str,
    pubsub_channel: str,
    stream_key: str,
    tool_call_id: Optional[str] = None
) -> None:
    ctx = StreamingContext(
        agent_run_id=agent_run_id,
        pubsub_channel=pubsub_channel,
        stream_key=stream_key,
        tool_call_id=tool_call_id
    )
    _streaming_context.set(ctx)


def get_streaming_context() -> Optional[StreamingContext]:
    return _streaming_context.get()


def clear_streaming_context() -> None:
    _streaming_context.set(None)


def set_current_tool_call_id(tool_call_id: str) -> None:
    ctx = get_streaming_context()
    if ctx:
        ctx.tool_call_id = tool_call_id


def get_current_tool_call_id() -> Optional[str]:
    ctx = get_streaming_context()
    return ctx.tool_call_id if ctx else None


async def stream_tool_output(
    tool_call_id: str,
    output_chunk: str,
    is_final: bool = False,
    tool_name: str = "execute_command"
) -> None:
    ctx = get_streaming_context()
    if not ctx:
        logger.debug(f"[STREAM] No streaming context available, skipping output stream")
        return
    
    try:
        from core.services import redis
        
        message = {
            "type": "tool_output_stream",
            "tool_call_id": tool_call_id,
            "tool_name": tool_name,
            "output": output_chunk,
            "is_final": is_final,
            "agent_run_id": ctx.agent_run_id
        }
        
        message_json = json.dumps(message)
        
        logger.debug(f"[STREAM] Publishing to {ctx.pubsub_channel}: tool_call_id={tool_call_id}, chunk_len={len(output_chunk)}, is_final={is_final}")
        
        await redis.publish(ctx.pubsub_channel, message_json)
        await redis.xadd(
            ctx.stream_key,
            {'data': message_json},
            maxlen=10000,
            approximate=True
        )
        
    except Exception as e:
        logger.warning(f"Failed to stream tool output: {e}")

