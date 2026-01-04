"""
Task dispatch functions for Redis Streams.

All functions to dispatch background tasks to Redis Streams.
"""

from typing import Optional, List, Dict, Any

from core.utils.logger import logger
from core.services.redis import get_client as get_redis_client
from .tasks import (
    StreamName,
    TaskMessage,
    AgentRunTask,
    ThreadInitTask,
    MemoryExtractionTask,
    MemoryEmbeddingTask,
    MemoryConsolidationTask,
    CategorizationTask,
    StaleProjectsTask,
)


async def dispatch_agent_run(
    agent_run_id: str,
    thread_id: str,
    instance_id: str,
    project_id: str,
    model_name: str,
    agent_id: Optional[str] = None,
    account_id: Optional[str] = None,
    request_id: Optional[str] = None,
) -> str:
    """Dispatch an agent run task."""
    task = AgentRunTask(
        agent_run_id=agent_run_id,
        thread_id=thread_id,
        instance_id=instance_id,
        project_id=project_id,
        model_name=model_name,
        agent_id=agent_id,
        account_id=account_id,
        request_id=request_id,
    )
    return await _dispatch_task(StreamName.AGENT_RUNS, task)


async def dispatch_thread_init(
    thread_id: str,
    project_id: str,
    account_id: str,
    prompt: str,
    agent_id: Optional[str] = None,
    model_name: Optional[str] = None,
) -> str:
    """Dispatch a thread initialization task."""
    task = ThreadInitTask(
        thread_id=thread_id,
        project_id=project_id,
        account_id=account_id,
        prompt=prompt,
        agent_id=agent_id,
        model_name=model_name,
    )
    return await _dispatch_task(StreamName.THREAD_INIT, task)


async def dispatch_memory_extraction(
    thread_id: str,
    account_id: str,
    message_ids: List[str],
) -> str:
    """Dispatch a memory extraction task."""
    task = MemoryExtractionTask(
        thread_id=thread_id,
        account_id=account_id,
        message_ids=message_ids,
    )
    return await _dispatch_task(StreamName.MEMORY, task)


async def dispatch_memory_embedding(
    account_id: str,
    thread_id: str,
    extracted_memories: List[Dict[str, Any]],
) -> str:
    """Dispatch a memory embedding task."""
    task = MemoryEmbeddingTask(
        account_id=account_id,
        thread_id=thread_id,
        extracted_memories=extracted_memories,
    )
    return await _dispatch_task(StreamName.MEMORY, task)


async def dispatch_memory_consolidation(account_id: str) -> str:
    """Dispatch a memory consolidation task."""
    task = MemoryConsolidationTask(account_id=account_id)
    return await _dispatch_task(StreamName.MEMORY, task)


async def dispatch_categorization(project_id: str) -> str:
    """Dispatch a project categorization task."""
    task = CategorizationTask(project_id=project_id)
    return await _dispatch_task(StreamName.CATEGORIZATION, task)


async def dispatch_stale_projects() -> str:
    """Dispatch a stale projects processing task."""
    task = StaleProjectsTask()
    return await _dispatch_task(StreamName.CATEGORIZATION, task)


async def _dispatch_task(stream: StreamName, task: TaskMessage) -> str:
    """Internal: dispatch a task to a stream."""
    redis = await get_redis_client()
    
    entry_id = await redis.xadd(
        stream.value,
        task.to_dict(),
        maxlen=50000,
    )
    
    logger.info(
        f"📤 [STREAM] Dispatched {task.task_type} | "
        f"stream={stream.value} | entry_id={entry_id}"
    )
    
    return entry_id

