"""
Redis Streams-based worker for ALL background tasks.

This completely replaces Dramatiq, providing:
- Near-zero latency message pickup (XREADGROUP blocks until message)
- Horizontal scaling via Consumer Groups (like Kafka)
- Long-running task support (hours)
- Crash recovery via pending message reclaim (XAUTOCLAIM)
- Multiple task types with priority support

Architecture:
- Multiple worker processes join the same consumer group
- Each message is delivered to exactly ONE worker
- Messages are acknowledged after completion (even if hours later)
- If a worker crashes, pending messages are reclaimed by others
"""

import asyncio
import json
import os
import time
import uuid
from datetime import datetime, timezone
from enum import Enum
from typing import Optional, Dict, Any, Callable, Awaitable, List
from dataclasses import dataclass, field, asdict

from core.utils.logger import logger
from core.services.redis import get_client as get_redis_client, REDIS_KEY_TTL


# Stream names for different task types
class StreamName(str, Enum):
    """Stream names for different task types."""
    AGENT_RUNS = "suna:agent-runs:v1"
    THREAD_INIT = "suna:thread-init:v1"
    MEMORY = "suna:memory:v1"
    CATEGORIZATION = "suna:categorization:v1"


# Consumer group name (same for all streams)
CONSUMER_GROUP = "suna-workers"

# Reclaim settings
PENDING_RECLAIM_INTERVAL = 60  # Check for dead messages every 60s
PENDING_MIN_IDLE_MS = 30000  # Reclaim messages idle for 30+ seconds
MAX_PENDING_RECLAIM = 10  # Max messages to reclaim per cycle


@dataclass
class TaskMessage:
    """Base class for all task messages."""
    task_type: str
    enqueued_at: float = field(default_factory=time.time)
    
    def to_dict(self) -> Dict[str, str]:
        """Convert to Redis stream fields (all strings)."""
        result = {}
        for key, value in asdict(self).items():
            if value is None:
                result[key] = ""
            elif isinstance(value, (list, dict)):
                result[key] = json.dumps(value)
            else:
                result[key] = str(value)
        return result
    
    @classmethod
    def from_dict(cls, data: Dict[str, str]) -> "TaskMessage":
        """Parse from Redis stream fields."""
        raise NotImplementedError("Subclasses must implement from_dict")


@dataclass
class AgentRunTask(TaskMessage):
    """Task for running an agent."""
    task_type: str = "agent_run"
    agent_run_id: str = ""
    thread_id: str = ""
    instance_id: str = ""
    project_id: str = ""
    model_name: str = ""
    agent_id: Optional[str] = None
    account_id: Optional[str] = None
    request_id: Optional[str] = None
    
    @classmethod
    def from_dict(cls, data: Dict[str, str]) -> "AgentRunTask":
        return cls(
            agent_run_id=data.get("agent_run_id", ""),
            thread_id=data.get("thread_id", ""),
            instance_id=data.get("instance_id", ""),
            project_id=data.get("project_id", ""),
            model_name=data.get("model_name", ""),
            agent_id=data.get("agent_id") or None,
            account_id=data.get("account_id") or None,
            request_id=data.get("request_id") or None,
            enqueued_at=float(data.get("enqueued_at", 0)),
        )


@dataclass
class ThreadInitTask(TaskMessage):
    """Task for initializing a thread."""
    task_type: str = "thread_init"
    thread_id: str = ""
    project_id: str = ""
    account_id: str = ""
    prompt: str = ""
    agent_id: Optional[str] = None
    model_name: Optional[str] = None
    
    @classmethod
    def from_dict(cls, data: Dict[str, str]) -> "ThreadInitTask":
        return cls(
            thread_id=data.get("thread_id", ""),
            project_id=data.get("project_id", ""),
            account_id=data.get("account_id", ""),
            prompt=data.get("prompt", ""),
            agent_id=data.get("agent_id") or None,
            model_name=data.get("model_name") or None,
            enqueued_at=float(data.get("enqueued_at", 0)),
        )


@dataclass
class MemoryExtractionTask(TaskMessage):
    """Task for extracting memories from a conversation."""
    task_type: str = "memory_extraction"
    thread_id: str = ""
    account_id: str = ""
    message_ids: List[str] = field(default_factory=list)
    
    def to_dict(self) -> Dict[str, str]:
        result = super().to_dict()
        result["message_ids"] = json.dumps(self.message_ids)
        return result
    
    @classmethod
    def from_dict(cls, data: Dict[str, str]) -> "MemoryExtractionTask":
        message_ids = json.loads(data.get("message_ids", "[]"))
        return cls(
            thread_id=data.get("thread_id", ""),
            account_id=data.get("account_id", ""),
            message_ids=message_ids,
            enqueued_at=float(data.get("enqueued_at", 0)),
        )


@dataclass
class MemoryEmbeddingTask(TaskMessage):
    """Task for embedding and storing memories."""
    task_type: str = "memory_embedding"
    account_id: str = ""
    thread_id: str = ""
    extracted_memories: List[Dict[str, Any]] = field(default_factory=list)
    
    def to_dict(self) -> Dict[str, str]:
        result = super().to_dict()
        result["extracted_memories"] = json.dumps(self.extracted_memories)
        return result
    
    @classmethod
    def from_dict(cls, data: Dict[str, str]) -> "MemoryEmbeddingTask":
        memories = json.loads(data.get("extracted_memories", "[]"))
        return cls(
            account_id=data.get("account_id", ""),
            thread_id=data.get("thread_id", ""),
            extracted_memories=memories,
            enqueued_at=float(data.get("enqueued_at", 0)),
        )


@dataclass
class MemoryConsolidationTask(TaskMessage):
    """Task for consolidating memories."""
    task_type: str = "memory_consolidation"
    account_id: str = ""
    
    @classmethod
    def from_dict(cls, data: Dict[str, str]) -> "MemoryConsolidationTask":
        return cls(
            account_id=data.get("account_id", ""),
            enqueued_at=float(data.get("enqueued_at", 0)),
        )


@dataclass
class CategorizationTask(TaskMessage):
    """Task for categorizing a project."""
    task_type: str = "categorization"
    project_id: str = ""
    
    @classmethod
    def from_dict(cls, data: Dict[str, str]) -> "CategorizationTask":
        return cls(
            project_id=data.get("project_id", ""),
            enqueued_at=float(data.get("enqueued_at", 0)),
        )


@dataclass
class StaleProjectsTask(TaskMessage):
    """Task for processing stale projects."""
    task_type: str = "stale_projects"
    
    @classmethod
    def from_dict(cls, data: Dict[str, str]) -> "StaleProjectsTask":
        return cls(
            enqueued_at=float(data.get("enqueued_at", 0)),
        )


# Task type to class mapping
TASK_CLASSES = {
    "agent_run": AgentRunTask,
    "thread_init": ThreadInitTask,
    "memory_extraction": MemoryExtractionTask,
    "memory_embedding": MemoryEmbeddingTask,
    "memory_consolidation": MemoryConsolidationTask,
    "categorization": CategorizationTask,
    "stale_projects": StaleProjectsTask,
}


def parse_task_message(data: Dict[str, str]) -> TaskMessage:
    """Parse a task message from Redis stream fields."""
    task_type = data.get("task_type", "")
    task_class = TASK_CLASSES.get(task_type)
    if not task_class:
        raise ValueError(f"Unknown task type: {task_type}")
    return task_class.from_dict(data)


# ============================================================================
# DISPATCH FUNCTIONS
# ============================================================================

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


# ============================================================================
# CONSUMER GROUP MANAGEMENT
# ============================================================================

async def ensure_consumer_groups(redis) -> None:
    """Create consumer groups for all streams if they don't exist."""
    for stream in StreamName:
        try:
            await redis.xgroup_create(
                stream.value,
                CONSUMER_GROUP,
                id="$",
                mkstream=True
            )
            logger.info(f"✅ Created consumer group '{CONSUMER_GROUP}' on stream '{stream.value}'")
        except Exception as e:
            if "BUSYGROUP" not in str(e):
                logger.warning(f"Failed to create consumer group for {stream.value}: {e}")


async def reclaim_pending_messages(redis, consumer_name: str, stream: str) -> int:
    """Reclaim messages from dead consumers."""
    try:
        result = await redis.xautoclaim(
            stream,
            CONSUMER_GROUP,
            consumer_name,
            min_idle_time=PENDING_MIN_IDLE_MS,
            start_id="0-0",
            count=MAX_PENDING_RECLAIM,
        )
        
        if result and len(result) > 1 and result[1]:
            reclaimed_count = len(result[1])
            if reclaimed_count > 0:
                logger.warning(
                    f"🔄 Reclaimed {reclaimed_count} pending messages from {stream}"
                )
            return reclaimed_count
        return 0
        
    except Exception as e:
        logger.debug(f"Reclaim check for {stream}: {e}")
        return 0


# ============================================================================
# STREAM WORKER
# ============================================================================

class StreamWorker:
    """
    Redis Streams-based worker for processing all background tasks.
    
    Features:
    - Consumes from multiple streams (agent runs, thread init, memory, categorization)
    - Blocks until message arrives (no polling delay)
    - Horizontal scaling via consumer groups
    - Automatic dead message reclaim
    """
    
    def __init__(
        self,
        handlers: Dict[str, Callable[[TaskMessage], Awaitable[None]]],
        consumer_name: Optional[str] = None,
        concurrency: int = 8,
        streams: Optional[List[StreamName]] = None,
    ):
        """
        Initialize the stream worker.
        
        Args:
            handlers: Dict mapping task_type to async handler function
            consumer_name: Unique name for this consumer
            concurrency: Number of concurrent tasks
            streams: List of streams to consume (default: all)
        """
        self.handlers = handlers
        self.consumer_name = consumer_name or f"worker-{uuid.uuid4().hex[:8]}"
        self.concurrency = concurrency
        self.streams = streams or list(StreamName)
        self._running = False
        self._tasks: list[asyncio.Task] = []
        self._reclaim_task: Optional[asyncio.Task] = None
        self._redis = None
        self._semaphore: Optional[asyncio.Semaphore] = None
    
    async def start(self):
        """Start the worker."""
        stream_names = [s.value for s in self.streams]
        logger.info(
            f"🚀 Starting StreamWorker | consumer={self.consumer_name} | "
            f"concurrency={self.concurrency} | streams={stream_names}"
        )
        
        self._redis = await get_redis_client()
        await ensure_consumer_groups(self._redis)
        
        self._running = True
        self._semaphore = asyncio.Semaphore(self.concurrency)
        
        # Start reclaim task
        self._reclaim_task = asyncio.create_task(self._reclaim_loop())
        
        # Start consumer loop
        await self._consume_loop()
    
    async def stop(self):
        """Stop the worker gracefully."""
        logger.info(f"🛑 Stopping StreamWorker | consumer={self.consumer_name}")
        self._running = False
        
        if self._reclaim_task:
            self._reclaim_task.cancel()
            try:
                await self._reclaim_task
            except asyncio.CancelledError:
                pass
        
        if self._tasks:
            logger.info(f"Waiting for {len(self._tasks)} in-flight tasks...")
            await asyncio.gather(*self._tasks, return_exceptions=True)
        
        logger.info(f"✅ StreamWorker stopped")
    
    async def _reclaim_loop(self):
        """Periodically reclaim dead messages from all streams."""
        while self._running:
            try:
                await asyncio.sleep(PENDING_RECLAIM_INTERVAL)
                for stream in self.streams:
                    await reclaim_pending_messages(self._redis, self.consumer_name, stream.value)
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Error in reclaim loop: {e}")
    
    async def _consume_loop(self):
        """Main consumer loop - reads from all streams."""
        logger.info(f"📡 Consumer loop started")
        
        # Build streams dict for XREADGROUP
        streams_dict = {s.value: ">" for s in self.streams}
        
        while self._running:
            try:
                # XREADGROUP from all streams at once
                result = await self._redis.xreadgroup(
                    groupname=CONSUMER_GROUP,
                    consumername=self.consumer_name,
                    streams=streams_dict,
                    block=5000,
                    count=self.concurrency,
                )
                
                if not result:
                    continue
                
                for stream_name, messages in result:
                    for entry_id, fields in messages:
                        await self._semaphore.acquire()
                        
                        task = asyncio.create_task(
                            self._process_message(stream_name, entry_id, fields)
                        )
                        self._tasks.append(task)
                        task.add_done_callback(lambda t: self._task_done(t))
                
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Error in consumer loop: {e}", exc_info=True)
                await asyncio.sleep(1)
    
    def _task_done(self, task: asyncio.Task):
        """Callback when a task completes."""
        self._semaphore.release()
        if task in self._tasks:
            self._tasks.remove(task)
    
    async def _process_message(self, stream_name: str, entry_id: str, fields: Dict[str, str]):
        """Process a single message."""
        task_message = None
        try:
            task_message = parse_task_message(fields)
            
            # Log latency
            pickup_latency_ms = (time.time() - task_message.enqueued_at) * 1000
            logger.info(
                f"📥 [STREAM] Processing {task_message.task_type} | "
                f"stream={stream_name} | latency={pickup_latency_ms:.1f}ms"
            )
            
            # Get handler for this task type
            handler = self.handlers.get(task_message.task_type)
            if not handler:
                logger.error(f"No handler for task type: {task_message.task_type}")
                await self._redis.xack(stream_name, CONSUMER_GROUP, entry_id)
                return
            
            # Execute handler
            await handler(task_message)
            
            # Acknowledge
            await self._redis.xack(stream_name, CONSUMER_GROUP, entry_id)
            logger.debug(f"✅ Acknowledged {task_message.task_type} | entry_id={entry_id}")
            
        except Exception as e:
            task_type = task_message.task_type if task_message else "unknown"
            logger.error(
                f"❌ Failed {task_type} | entry_id={entry_id} | error={e}",
                exc_info=True
            )
            # Don't acknowledge - will be reclaimed


# ============================================================================
# MONITORING
# ============================================================================

async def get_stream_info() -> Dict[str, Any]:
    """Get information about all streams (for monitoring)."""
    redis = await get_redis_client()
    
    result = {
        "consumer_group": CONSUMER_GROUP,
        "streams": {},
    }
    
    for stream in StreamName:
        try:
            info = await redis.xinfo_stream(stream.value)
            
            pending_count = 0
            consumers = []
            try:
                groups = await redis.xinfo_groups(stream.value)
                for group in groups:
                    if group.get("name") == CONSUMER_GROUP:
                        pending_count = group.get("pending", 0)
                        try:
                            consumer_info = await redis.xinfo_consumers(stream.value, CONSUMER_GROUP)
                            consumers = [
                                {
                                    "name": c.get("name"),
                                    "pending": c.get("pending"),
                                    "idle_ms": c.get("idle"),
                                }
                                for c in consumer_info
                            ]
                        except:
                            pass
            except:
                pass
            
            result["streams"][stream.value] = {
                "length": info.get("length", 0),
                "pending_count": pending_count,
                "consumers": consumers,
            }
        except Exception as e:
            result["streams"][stream.value] = {"error": str(e)}
    
    return result
