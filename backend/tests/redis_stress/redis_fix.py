"""
Redis Split Pool + Hub Fix Implementation

PROBLEM 1 (starvation):
- Single pool shared between XREAD BLOCK and GET/SET
- When XREAD clients >= pool size, GET/SET starve

PROBLEM 2 (scaling):
- 1 SSE client = 1 XREAD BLOCK = 1 held connection
- 200 clients = 200 blocked connections (doesn't scale)

FIX 1 (split pools):
- GENERAL_POOL: GET/SET/XADD - fast, non-blocking ops
- STREAM_POOL: XREAD/XREADGROUP - blocking ops

FIX 2 (hub/fanout):
- 1 Redis reader per stream key (not per client)
- Fan-out to N clients via bounded queues
- Cleanup when clients disconnect

================================================================================
INTEGRATION GUARDRAILS (must follow to avoid breaking the fix)
================================================================================

GUARDRAIL #1: Never use XREAD on general client
    - Use client.xread_blocking() or client.hub.subscribe() ONLY
    - Internal _general_client and _stream_client are private for a reason

GUARDRAIL #2: Singleton pattern - don't create clients per request
    - Use get_fixed_client() to get singleton
    - Initialize once at startup

GUARDRAIL #3: Hub keys must be per-stream, not per-client
    - Key format: "agent_run:<run_id>:stream"
    - All clients watching same run share 1 pump

GUARDRAIL #4: Always use context manager or try/finally for hub
    - async with hub.subscription(stream_key) as queue:  # PREFERRED
    - Or: try/finally with explicit unsubscribe()

GUARDRAIL #5: Streams have default MAXLEN
    - xadd() uses DEFAULT_STREAM_MAXLEN=10000 by default
    - Pass maxlen=0 to disable (not recommended)

================================================================================
USAGE EXAMPLES
================================================================================

# 1. Initialize singleton at startup
client = await get_fixed_client()

# 2. Non-blocking ops (use these for GET/SET/XADD)
await client.get("key")
await client.set("key", "value")
await client.xadd("stream", {"data": "..."})

# 3. SSE streaming with hub (RECOMMENDED)
async with client.hub.subscription(f"agent_run:{run_id}:stream") as queue:
    async for msg in client.hub.iter_queue(queue):
        if msg:
            yield format_sse(msg)
        else:
            yield ": keepalive\\n\\n"

# 4. Direct blocking read (only if hub doesn't fit your use case)
result = await client.xread_blocking({"stream": "0"}, block=500)
"""

import os
import asyncio
import time
import logging
from typing import Optional, Dict, List, Any, Set
from dataclasses import dataclass
from collections import defaultdict

from redis.asyncio import Redis
from redis.asyncio.connection import BlockingConnectionPool
from redis.exceptions import ConnectionError as RedisConnectionError

logger = logging.getLogger(__name__)


# Configuration
@dataclass
class PoolConfig:
    host: str = "localhost"
    port: int = 6379
    password: Optional[str] = None
    db: int = 0

    # GENERAL_POOL: for GET/SET/XADD - non-blocking, fast ops
    general_max_connections: int = 200
    general_pool_timeout: float = 0.5  # Fail fast if can't get connection

    # STREAM_POOL: for XREAD/XREADGROUP - blocking ops that hold connections
    stream_max_connections: int = 500
    stream_pool_timeout: float = 0.5

    # Socket settings
    socket_timeout: float = 10.0
    socket_connect_timeout: float = 5.0
    health_check_interval: int = 30

    @classmethod
    def from_env(cls) -> "PoolConfig":
        return cls(
            host=os.getenv("REDIS_HOST", "localhost"),
            port=int(os.getenv("REDIS_PORT", "6379")),
            password=os.getenv("REDIS_PASSWORD") or None,
            db=int(os.getenv("REDIS_DB", "0")),
            general_max_connections=int(os.getenv("REDIS_GENERAL_MAX_CONN", "200")),
            stream_max_connections=int(os.getenv("REDIS_STREAM_MAX_CONN", "500")),
        )


# =============================================================================
# FIX 2: STREAM HUB - 1 Redis reader per stream, fan-out to N clients
# =============================================================================

class _HubSubscription:
    """
    Async context manager for hub subscriptions.

    GUARDRAIL #4: Ensures unsubscribe() is ALWAYS called.
    """

    def __init__(self, hub: "StreamHub", stream_key: str, last_id: str):
        self._hub = hub
        self._stream_key = stream_key
        self._last_id = last_id
        self._queue: Optional[asyncio.Queue] = None

    async def __aenter__(self) -> asyncio.Queue:
        self._queue = await self._hub.subscribe(self._stream_key, self._last_id)
        return self._queue

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        if self._queue:
            await self._hub.unsubscribe(self._stream_key, self._queue)
        return False  # Don't suppress exceptions


class StreamHub:
    """
    Multiplexes stream reads: 1 Redis XREAD per stream key, fan-out to N clients.

    BEFORE (broken):
        100 SSE clients watching same run = 100 XREAD BLOCK = 100 held connections

    AFTER (fixed):
        100 SSE clients watching same run = 1 XREAD BLOCK + 100 bounded queues

    Usage:
        hub = StreamHub(redis_stream_client)

        # In SSE handler:
        queue = await hub.subscribe(stream_key, last_id="0")
        try:
            async for msg_id, fields in hub.iter_queue(queue):
                yield format_sse(fields)
        finally:
            await hub.unsubscribe(stream_key, queue)
    """

    def __init__(self, redis_client: Redis, queue_maxsize: int = 256):
        self._redis = redis_client
        self._queue_maxsize = queue_maxsize

        # stream_key -> pump task
        self._pumps: Dict[str, asyncio.Task] = {}

        # stream_key -> set of subscriber queues
        self._subs: Dict[str, Set[asyncio.Queue]] = defaultdict(set)

        # Lock for thread-safe subscribe/unsubscribe
        self._lock = asyncio.Lock()

        # Metrics
        self.streams_active = 0
        self.subscribers_total = 0
        self.messages_delivered = 0
        self.messages_dropped = 0

    async def subscribe(self, stream_key: str, last_id: str = "0") -> asyncio.Queue:
        """
        Subscribe to a stream. Returns a bounded queue for receiving messages.

        Args:
            stream_key: Redis stream key (e.g., "agent_run:123:stream")
            last_id: Start reading from this ID ("0" = beginning, "$" = new only)

        Returns:
            asyncio.Queue that receives (msg_id, fields) tuples
        """
        queue = asyncio.Queue(maxsize=self._queue_maxsize)

        async with self._lock:
            self._subs[stream_key].add(queue)
            self.subscribers_total += 1

            # Start pump if first subscriber for this stream
            if stream_key not in self._pumps:
                self._pumps[stream_key] = asyncio.create_task(
                    self._pump(stream_key, last_id)
                )
                self.streams_active += 1
                logger.debug(f"Hub: Started pump for {stream_key}")

        return queue

    async def unsubscribe(self, stream_key: str, queue: asyncio.Queue):
        """
        Unsubscribe from a stream. MUST be called in finally block.

        Cleans up:
        - Removes queue from subscribers
        - Cancels pump if last subscriber leaves
        """
        async with self._lock:
            subs = self._subs.get(stream_key)
            if not subs:
                return

            subs.discard(queue)

            # If no more subscribers, cancel the pump
            if not subs:
                task = self._pumps.pop(stream_key, None)
                if task:
                    task.cancel()
                    try:
                        await task
                    except asyncio.CancelledError:
                        pass
                    self.streams_active -= 1
                    logger.debug(f"Hub: Stopped pump for {stream_key} (no subscribers)")

                # Clean up empty set
                self._subs.pop(stream_key, None)

    async def _pump(self, stream_key: str, last_id: str):
        """
        Single reader for a stream. Fans out to all subscribers.

        - Uses STREAM_POOL (blocking ops isolated)
        - Bounded queues prevent memory blowup
        - Drops messages for slow clients (better than blocking)
        """
        try:
            while True:
                try:
                    result = await self._redis.xread(
                        {stream_key: last_id},
                        block=500,  # 500ms block, then check for cancellation
                        count=100
                    )

                    if not result:
                        continue

                    for stream_name, entries in result:
                        for msg_id, fields in entries:
                            last_id = msg_id

                            # Fan-out to all subscribers
                            async with self._lock:
                                subs = list(self._subs.get(stream_key, []))

                            for queue in subs:
                                if queue.full():
                                    # Drop for slow clients - don't block
                                    self.messages_dropped += 1
                                    continue
                                try:
                                    queue.put_nowait((msg_id, fields))
                                    self.messages_delivered += 1
                                except asyncio.QueueFull:
                                    self.messages_dropped += 1

                except RedisConnectionError as e:
                    logger.warning(f"Hub pump connection error for {stream_key}: {e}")
                    await asyncio.sleep(0.5)
                except Exception as e:
                    logger.warning(f"Hub pump error for {stream_key}: {e}")
                    await asyncio.sleep(0.1)

        except asyncio.CancelledError:
            logger.debug(f"Hub pump cancelled for {stream_key}")
            raise

    async def iter_queue(self, queue: asyncio.Queue, timeout: float = 1.0):
        """
        Async iterator for queue messages.

        Usage:
            async for msg_id, fields in hub.iter_queue(queue):
                yield format_sse(fields)
        """
        while True:
            try:
                msg = await asyncio.wait_for(queue.get(), timeout=timeout)
                yield msg
            except asyncio.TimeoutError:
                # Yield None for keepalive handling
                yield None

    def subscription(self, stream_key: str, last_id: str = "0"):
        """
        Context manager for safe subscribe/unsubscribe.

        GUARDRAIL #4: Ensures unsubscribe() is ALWAYS called, even on disconnect.

        Usage:
            async with hub.subscription(stream_key) as queue:
                async for msg in hub.iter_queue(queue):
                    yield format_sse(msg)
            # unsubscribe() called automatically on exit/error/disconnect
        """
        return _HubSubscription(self, stream_key, last_id)

    def get_stats(self) -> Dict[str, Any]:
        """Get hub statistics."""
        return {
            "streams_active": self.streams_active,
            "subscribers_total": self.subscribers_total,
            "pumps": len(self._pumps),
            "messages_delivered": self.messages_delivered,
            "messages_dropped": self.messages_dropped,
            "drop_rate": self.messages_dropped / max(1, self.messages_delivered + self.messages_dropped),
        }


# =============================================================================
# FIX 1: SPLIT POOLS - Isolate blocking from non-blocking ops
# =============================================================================

class RedisFixedClient:
    """
    Redis client with SPLIT POOLS to prevent connection starvation.

    Usage:
        client = RedisFixedClient()
        await client.initialize()

        # Non-blocking ops use general pool
        await client.get("key")
        await client.set("key", "value")
        await client.xadd("stream", {"data": "..."})

        # Blocking ops use stream pool
        await client.xread_blocking({"stream": "0"}, block=500)
    """

    def __init__(self, config: PoolConfig = None):
        self.config = config or PoolConfig.from_env()

        self._general_pool: Optional[BlockingConnectionPool] = None
        self._stream_pool: Optional[BlockingConnectionPool] = None
        self._general_client: Optional[Redis] = None
        self._stream_client: Optional[Redis] = None

        # Hub for fan-out (1 reader per stream)
        self._hub: Optional[StreamHub] = None

        self._initialized = False
        self._init_lock: Optional[asyncio.Lock] = None

        # Metrics
        self._general_ops = 0
        self._general_timeouts = 0
        self._stream_ops = 0
        self._stream_timeouts = 0

    async def initialize(self):
        """Initialize both pools."""
        if self._init_lock is None:
            self._init_lock = asyncio.Lock()

        async with self._init_lock:
            if self._initialized:
                return

            # GENERAL POOL - for non-blocking ops
            self._general_pool = BlockingConnectionPool(
                host=self.config.host,
                port=self.config.port,
                password=self.config.password,
                db=self.config.db,
                max_connections=self.config.general_max_connections,
                timeout=self.config.general_pool_timeout,
                socket_timeout=self.config.socket_timeout,
                socket_connect_timeout=self.config.socket_connect_timeout,
                socket_keepalive=True,
                health_check_interval=self.config.health_check_interval,
                decode_responses=True,
            )
            self._general_client = Redis(connection_pool=self._general_pool)

            # STREAM POOL - for blocking ops (XREAD/XREADGROUP)
            self._stream_pool = BlockingConnectionPool(
                host=self.config.host,
                port=self.config.port,
                password=self.config.password,
                db=self.config.db,
                max_connections=self.config.stream_max_connections,
                timeout=self.config.stream_pool_timeout,
                socket_timeout=self.config.socket_timeout,
                socket_connect_timeout=self.config.socket_connect_timeout,
                socket_keepalive=True,
                health_check_interval=self.config.health_check_interval,
                decode_responses=True,
            )
            self._stream_client = Redis(connection_pool=self._stream_pool)

            # Verify connections
            await self._general_client.ping()
            await self._stream_client.ping()

            # Initialize hub for fan-out pattern
            self._hub = StreamHub(self._stream_client)

            self._initialized = True

    async def close(self):
        """Close both pools."""
        if self._general_client:
            await self._general_client.aclose()
        if self._stream_client:
            await self._stream_client.aclose()
        if self._general_pool:
            await self._general_pool.aclose()
        if self._stream_pool:
            await self._stream_pool.aclose()
        self._initialized = False

    def get_pool_info(self) -> Dict[str, Any]:
        """Get stats for both pools."""
        def pool_stats(pool, name):
            if not pool:
                return {"status": "not_initialized"}
            return {
                "name": name,
                "max_connections": getattr(pool, 'max_connections', 'unknown'),
                "in_use": len(getattr(pool, '_in_use_connections', [])),
                "available": len(getattr(pool, '_available_connections', [])),
            }

        return {
            "general_pool": pool_stats(self._general_pool, "general"),
            "stream_pool": pool_stats(self._stream_pool, "stream"),
            "metrics": {
                "general_ops": self._general_ops,
                "general_timeouts": self._general_timeouts,
                "stream_ops": self._stream_ops,
                "stream_timeouts": self._stream_timeouts,
            },
            "hub": self._hub.get_stats() if self._hub else None,
        }

    @property
    def hub(self) -> StreamHub:
        """Get the StreamHub for fan-out pattern."""
        if not self._hub:
            raise RuntimeError("Client not initialized. Call initialize() first.")
        return self._hub

    # ========== GENERAL POOL OPERATIONS ==========

    async def get(self, key: str, timeout: float = 5.0) -> Optional[str]:
        """GET using general pool."""
        self._general_ops += 1
        try:
            return await asyncio.wait_for(
                self._general_client.get(key),
                timeout=timeout
            )
        except asyncio.TimeoutError:
            self._general_timeouts += 1
            return None
        except Exception:
            return None

    async def set(self, key: str, value: str, ex: int = None, timeout: float = 5.0) -> bool:
        """SET using general pool."""
        self._general_ops += 1
        try:
            result = await asyncio.wait_for(
                self._general_client.set(key, value, ex=ex),
                timeout=timeout
            )
            return bool(result)
        except asyncio.TimeoutError:
            self._general_timeouts += 1
            return False
        except Exception:
            return False

    # GUARDRAIL #5: Default maxlen prevents unbounded stream growth
    DEFAULT_STREAM_MAXLEN = 10000

    async def xadd(self, stream: str, fields: Dict, maxlen: int = None,
                   approximate: bool = True, timeout: float = 5.0) -> Optional[str]:
        """
        XADD using general pool (non-blocking write).

        GUARDRAIL #5: Uses DEFAULT_STREAM_MAXLEN by default to prevent
        unbounded Redis memory growth. Pass maxlen=0 to disable.
        """
        self._general_ops += 1
        try:
            kwargs = {}
            # Default to maxlen to prevent unbounded growth
            effective_maxlen = maxlen if maxlen is not None else self.DEFAULT_STREAM_MAXLEN
            if effective_maxlen > 0:
                kwargs['maxlen'] = effective_maxlen
                kwargs['approximate'] = approximate
            return await asyncio.wait_for(
                self._general_client.xadd(stream, fields, **kwargs),
                timeout=timeout
            )
        except asyncio.TimeoutError:
            self._general_timeouts += 1
            return None
        except Exception:
            return None

    async def delete(self, key: str, timeout: float = 5.0) -> int:
        """DELETE using general pool."""
        self._general_ops += 1
        try:
            return await asyncio.wait_for(
                self._general_client.delete(key),
                timeout=timeout
            )
        except asyncio.TimeoutError:
            self._general_timeouts += 1
            return 0
        except Exception:
            return 0

    async def keys(self, pattern: str, timeout: float = 10.0) -> List[str]:
        """KEYS using general pool."""
        self._general_ops += 1
        try:
            return await asyncio.wait_for(
                self._general_client.keys(pattern),
                timeout=timeout
            )
        except Exception:
            return []

    # ========== STREAM POOL OPERATIONS (BLOCKING) ==========

    async def xread_blocking(self, streams: Dict[str, str], block: int = 500,
                             count: int = 100, timeout: float = None) -> List:
        """
        XREAD BLOCK using STREAM pool.

        This is the key fix - blocking reads use separate pool.
        """
        self._stream_ops += 1

        # Timeout = block time + buffer
        if timeout is None:
            timeout = (block / 1000) + 2.0

        try:
            result = await asyncio.wait_for(
                self._stream_client.xread(streams, block=block, count=count),
                timeout=timeout
            )
            return result or []
        except asyncio.TimeoutError:
            self._stream_timeouts += 1
            return []
        except Exception:
            return []

    async def xreadgroup_blocking(self, group: str, consumer: str,
                                  streams: Dict[str, str], block: int = 500,
                                  count: int = 100, timeout: float = None) -> List:
        """XREADGROUP BLOCK using STREAM pool."""
        self._stream_ops += 1

        if timeout is None:
            timeout = (block / 1000) + 2.0

        try:
            result = await asyncio.wait_for(
                self._stream_client.xreadgroup(
                    groupname=group, consumername=consumer,
                    streams=streams, block=block, count=count
                ),
                timeout=timeout
            )
            return result or []
        except asyncio.TimeoutError:
            self._stream_timeouts += 1
            return []
        except Exception:
            return []


# Singleton instance
_fixed_client: Optional[RedisFixedClient] = None


async def get_fixed_client(config: PoolConfig = None) -> RedisFixedClient:
    """Get or create the fixed client singleton."""
    global _fixed_client
    if _fixed_client is None:
        _fixed_client = RedisFixedClient(config)
        await _fixed_client.initialize()
    return _fixed_client
