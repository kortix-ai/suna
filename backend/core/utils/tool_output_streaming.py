"""
Tool output streaming context management.

Provides context for streaming tool outputs back to the frontend in real-time.
"""

import json
import asyncio
from contextvars import ContextVar
from typing import Optional, Dict, Any
from dataclasses import dataclass

from core.utils.logger import logger


@dataclass
class ToolOutputStreamingContext:
    agent_run_id: str
    stream_key: str
    tool_call_id: Optional[str] = None


_tool_output_streaming_context: ContextVar[Optional[ToolOutputStreamingContext]] = ContextVar(
    'tool_output_streaming_context', 
    default=None
)


def set_tool_output_streaming_context(
    agent_run_id: str,
    stream_key: str,
    tool_call_id: Optional[str] = None
) -> None:
    ctx = ToolOutputStreamingContext(
        agent_run_id=agent_run_id,
        stream_key=stream_key,
        tool_call_id=tool_call_id
    )
    _tool_output_streaming_context.set(ctx)


def get_tool_output_streaming_context() -> Optional[ToolOutputStreamingContext]:
    return _tool_output_streaming_context.get()


def clear_tool_output_streaming_context() -> None:
    _tool_output_streaming_context.set(None)


def set_current_tool_call_id(tool_call_id: str) -> None:
    ctx = get_tool_output_streaming_context()
    if ctx:
        ctx.tool_call_id = tool_call_id


def get_current_tool_call_id() -> Optional[str]:
    ctx = get_tool_output_streaming_context()
    return ctx.tool_call_id if ctx else None


async def stream_tool_output(
    tool_call_id: str,
    output_chunk: str,
    is_final: bool = False,
    tool_name: str = "execute_command"
) -> None:
    ctx = get_tool_output_streaming_context()
    if not ctx:
        logger.debug(f"[STREAM] No tool output streaming context available, skipping output stream")
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
        
        logger.debug(f"[TOOL OUTPUT] Writing to stream {ctx.stream_key}: tool_call_id={tool_call_id}, chunk_len={len(output_chunk)}, is_final={is_final}")
        
        await redis.stream_add(
            ctx.stream_key,
            {"data": message_json},
            maxlen=200,
            approximate=True
        )
        
    except Exception as e:
        logger.warning(f"Failed to stream tool output: {e}")

