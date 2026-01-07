"""
Redis Streams consumer for background tasks.

Handles message consumption, consumer groups, and dead message reclaim.
"""

import asyncio
import time
import uuid
from typing import Optional, Dict, Any, Callable, Awaitable, List

from core.utils.logger import logger
from core.services.redis import get_client as get_redis_client
from .tasks import StreamName, parse_task_message, TaskMessage


# Consumer group name (same for all streams)
CONSUMER_GROUP = "suna-workers"

# Reclaim settings
PENDING_RECLAIM_INTERVAL = 60  # Check for dead messages every 60s
PENDING_MIN_IDLE_MS = 30000  # Reclaim messages idle for 30+ seconds
MAX_PENDING_RECLAIM = 10  # Max messages to reclaim per cycle

# Stale consumer cleanup settings
STALE_CONSUMER_IDLE_MS = 300000  # 5 minutes - consumers idle longer are considered dead
STALE_CONSUMER_CLEANUP_INTERVAL = 300  # Run cleanup every 5 minutes


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


async def cleanup_stale_consumers(redis, stream: str, my_consumer_name: str) -> int:
    """
    Remove stale consumers from a stream's consumer group.
    
    Stale consumers are those that have been idle for longer than STALE_CONSUMER_IDLE_MS.
    This handles cases where containers crash or are killed without graceful shutdown.
    
    Args:
        redis: Redis client
        stream: Stream name
        my_consumer_name: Current consumer's name (to avoid deleting self)
    
    Returns:
        Number of stale consumers removed
    """
    try:
        consumers = await redis.xinfo_consumers(stream, CONSUMER_GROUP)
        removed = 0
        
        for consumer in consumers:
            name = consumer.get("name", "")
            idle_ms = consumer.get("idle", 0)
            pending = consumer.get("pending", 0)
            
            # Skip self
            if name == my_consumer_name:
                continue
            
            # Remove if idle too long (dead consumer from crashed container)
            if idle_ms > STALE_CONSUMER_IDLE_MS:
                try:
                    deleted = await redis.xgroup_delconsumer(stream, CONSUMER_GROUP, name)
                    removed += 1
                    logger.info(
                        f"🧹 Removed stale consumer '{name}' from {stream} "
                        f"(idle: {idle_ms/1000:.0f}s, had {deleted} pending messages)"
                    )
                except Exception as e:
                    logger.warning(f"Failed to remove stale consumer '{name}': {e}")
        
        return removed
    except Exception as e:
        logger.debug(f"Stale consumer cleanup for {stream}: {e}")
        return 0


async def reclaim_pending_messages(redis, consumer_name: str, stream: str, handlers: Optional[Dict[str, Callable]] = None) -> int:
    """Reclaim messages from dead consumers and optionally process them."""
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
            reclaimed_messages = result[1]
            reclaimed_count = len(reclaimed_messages)
            if reclaimed_count > 0:
                logger.warning(
                    f"🔄 Reclaimed {reclaimed_count} pending messages from {stream}"
                )
                
                # Process reclaimed messages if handlers provided
                if handlers:
                    for entry_id, fields in reclaimed_messages:
                        try:
                            task_message = parse_task_message(fields)
                            handler = handlers.get(task_message.task_type)
                            if handler:
                                logger.info(f"🔄 Processing reclaimed message: {task_message.task_type} | entry_id={entry_id}")
                                await handler(task_message)
                                await redis.xack(stream, CONSUMER_GROUP, entry_id)
                                logger.info(f"✅ Processed reclaimed message: {entry_id}")
                            else:
                                # No handler - acknowledge to prevent infinite reclaim
                                logger.warning(f"⚠️ No handler for reclaimed {task_message.task_type}, acknowledging to clear")
                                await redis.xack(stream, CONSUMER_GROUP, entry_id)
                        except Exception as e:
                            # Message failed to process - log and acknowledge to prevent infinite reclaim
                            # This acts as a simple dead letter mechanism
                            logger.error(f"❌ Reclaimed message {entry_id} failed, moving to DLQ: {e}")
                            await redis.xack(stream, CONSUMER_GROUP, entry_id)
                            # Store failed message in DLQ stream for investigation
                            try:
                                await redis.xadd(
                                    f"{stream}:dlq",
                                    {
                                        "original_entry_id": str(entry_id),
                                        "error": str(e)[:500],  # Truncate error
                                        "stream": stream,
                                        "timestamp": str(time.time())
                                    }
                                )
                            except Exception as dlq_err:
                                logger.debug(f"Failed to write to DLQ: {dlq_err}")
                                
            return reclaimed_count
        return 0
        
    except Exception as e:
        logger.debug(f"Reclaim check for {stream}: {e}")
        return 0


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
        
        try:
            self._redis = await get_redis_client()
        except Exception as e:
            logger.error(f"Failed to connect to Redis: {e}", exc_info=True)
            raise
        
        try:
            await ensure_consumer_groups(self._redis)
        except Exception as e:
            logger.error(f"Failed to ensure consumer groups: {e}", exc_info=True)
            raise
        
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
        
        # Clean up this consumer from all streams
        await self._delete_consumer()
        
        logger.info(f"✅ StreamWorker stopped")
    
    async def _delete_consumer(self):
        """Remove this consumer from all consumer groups on shutdown."""
        if not hasattr(self, '_redis') or not self._redis:
            return
        
        for stream in self.streams:
            try:
                # XGROUP DELCONSUMER removes the consumer from the group
                # Any pending messages will be returned to the group for other consumers
                deleted = await self._redis.xgroup_delconsumer(
                    stream.value, CONSUMER_GROUP, self.consumer_name
                )
                if deleted > 0:
                    logger.info(f"🧹 Deleted consumer {self.consumer_name} from {stream.value} (had {deleted} pending)")
                else:
                    logger.debug(f"Removed consumer {self.consumer_name} from {stream.value}")
            except Exception as e:
                logger.warning(f"Failed to delete consumer from {stream.value}: {e}")
    
    async def _reclaim_loop(self):
        """Periodically reclaim dead messages and clean up stale consumers."""
        # Track time for stale consumer cleanup (less frequent than reclaim)
        last_stale_cleanup = time.time()
        
        while self._running:
            try:
                await asyncio.sleep(PENDING_RECLAIM_INTERVAL)
                
                for stream in self.streams:
                    # Pass handlers so reclaimed messages actually get processed
                    await reclaim_pending_messages(
                        self._redis, 
                        self.consumer_name, 
                        stream.value,
                        handlers=self.handlers
                    )
                
                # Run stale consumer cleanup periodically (every 5 minutes)
                now = time.time()
                if now - last_stale_cleanup >= STALE_CONSUMER_CLEANUP_INTERVAL:
                    last_stale_cleanup = now
                    for stream in self.streams:
                        await cleanup_stale_consumers(
                            self._redis,
                            stream.value,
                            self.consumer_name
                        )
                    
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Error in reclaim loop: {e}")
    
    async def _consume_loop(self):
        """Main consumer loop - reads from all streams."""
        logger.info("Consumer loop started")
        
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
            lag = 0  # Messages waiting to be delivered (queue backlog)
            consumers = []
            try:
                groups = await redis.xinfo_groups(stream.value)
                for group in groups:
                    if group.get("name") == CONSUMER_GROUP:
                        pending_count = group.get("pending", 0)
                        # 'lag' is available in Redis 7+ and represents undelivered messages
                        lag = group.get("lag", 0) or 0
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
                "pending_count": pending_count,  # Tasks being processed
                "lag": lag,  # Tasks waiting in queue (for scaling)
                "consumers": consumers,
            }
        except Exception as e:
            result["streams"][stream.value] = {"error": str(e)}
    
    return result

