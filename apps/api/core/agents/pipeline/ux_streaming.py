import asyncio
import json
from datetime import datetime, timezone
from typing import Optional, Dict, Any, List

from core.utils.logger import logger
from core.services import redis


async def _stream_event(stream_key: str, event: Dict[str, Any], timeout: float = 2.0) -> bool:
    if not stream_key:
        return False
    try:
        await asyncio.wait_for(
            redis.stream_add(stream_key, {"data": json.dumps(event)}, maxlen=200, approximate=True),
            timeout=timeout
        )
        return True
    except (asyncio.TimeoutError, Exception) as e:
        logger.debug(f"Failed to stream event {event.get('type')}: {e}")
        return False


async def stream_ack(
    stream_key: str,
    agent_run_id: str,
    message: str = "Working on your request..."
) -> bool:
    event = {
        "type": "ack",
        "message": message,
        "agent_run_id": agent_run_id,
        "timestamp": datetime.now(timezone.utc).isoformat()
    }
    return await _stream_event(stream_key, event)


async def stream_estimate(
    stream_key: str,
    estimated_seconds: float,
    confidence: str = "medium",
    breakdown: Optional[Dict[str, float]] = None
) -> bool:
    event = {
        "type": "estimate",
        "estimated_seconds": round(estimated_seconds, 1),
        "confidence": confidence,
        "message": f"This should take about {int(estimated_seconds)} seconds",
        "timestamp": datetime.now(timezone.utc).isoformat()
    }
    if breakdown:
        event["breakdown"] = breakdown
    return await _stream_event(stream_key, event)


async def stream_prep_stage(
    stream_key: str,
    stage: str,
    detail: Optional[str] = None,
    progress: Optional[int] = None
) -> bool:
    event = {
        "type": "prep_stage",
        "stage": stage,
        "timestamp": datetime.now(timezone.utc).isoformat()
    }
    if detail:
        event["detail"] = detail
    if progress is not None:
        event["progress"] = progress
    return await _stream_event(stream_key, event)


async def stream_degradation(
    stream_key: str,
    component: str,
    message: str,
    severity: str = "warning",
    user_impact: Optional[str] = None
) -> bool:
    event = {
        "type": "degradation",
        "component": component,
        "message": message,
        "severity": severity,
        "timestamp": datetime.now(timezone.utc).isoformat()
    }
    if user_impact:
        event["user_impact"] = user_impact
    return await _stream_event(stream_key, event)


async def stream_thinking(
    stream_key: str,
    message: str = "AI is processing your request..."
) -> bool:
    event = {
        "type": "thinking",
        "message": message,
        "timestamp": datetime.now(timezone.utc).isoformat()
    }
    return await _stream_event(stream_key, event)


async def stream_user_error(
    stream_key: str,
    error: str,
    error_code: str,
    recoverable: bool = False,
    actions: Optional[List[Dict[str, Any]]] = None
) -> bool:
    event = {
        "type": "error",
        "error": error,
        "error_code": error_code,
        "recoverable": recoverable,
        "actions": actions or [],
        "timestamp": datetime.now(timezone.utc).isoformat()
    }
    return await _stream_event(stream_key, event)


async def stream_context_usage(
    stream_key: str,
    current_tokens: int,
    message_count: int = 0,
    compressed: bool = False
) -> bool:
    event = {
        "type": "context_usage",
        "current_tokens": current_tokens,
        "message_count": message_count,
        "compressed": compressed,
        "timestamp": datetime.now(timezone.utc).isoformat()
    }
    return await _stream_event(stream_key, event)


async def stream_summarizing(
    stream_key: str,
    status: str,
    tokens_before: Optional[int] = None,
    tokens_after: Optional[int] = None,
    messages_before: Optional[int] = None,
    messages_after: Optional[int] = None,
) -> bool:
    event = {
        "type": "summarizing context",
        "status": status,
        "timestamp": datetime.now(timezone.utc).isoformat()
    }
    if tokens_before is not None:
        event["tokens_before"] = tokens_before
    if tokens_after is not None:
        event["tokens_after"] = tokens_after
    if messages_before is not None:
        event["messages_before"] = messages_before
    if messages_after is not None:
        event["messages_after"] = messages_after
    return await _stream_event(stream_key, event)
