import redis.asyncio as redis_lib
from redis.asyncio import Redis, ConnectionPool
from redis.exceptions import BusyLoadingError, ConnectionError as RedisConnectionError
from redis.backoff import ExponentialBackoff
from redis.retry import Retry
import os
import asyncio
import time
from typing import Optional, Dict, List, Any
from dotenv import load_dotenv
from core.utils.logger import logger

REDIS_KEY_TTL = 3600 * 2

# Default timeouts (in seconds) - can be overridden via environment variables
DEFAULT_OP_TIMEOUT = float(os.getenv("REDIS_OP_TIMEOUT", "5.0"))  # Basic operations
DEFAULT_STREAM_TIMEOUT = float(os.getenv("REDIS_STREAM_TIMEOUT", "10.0"))  # Stream operations
SOCKET_TIMEOUT = float(os.getenv("REDIS_SOCKET_TIMEOUT", "10.0"))  # Reduced from 30s
SOCKET_CONNECT_TIMEOUT = float(os.getenv("REDIS_SOCKET_CONNECT_TIMEOUT", "5.0"))  # Reduced from 15s
HEALTH_CHECK_INTERVAL = int(os.getenv("REDIS_HEALTH_CHECK_INTERVAL", "15"))  # More frequent

# Split pool configuration - prevents XREAD BLOCK from starving GET/SET
GENERAL_POOL_SIZE = int(os.getenv("REDIS_GENERAL_POOL_SIZE", "200"))
STREAM_POOL_SIZE = int(os.getenv("REDIS_STREAM_POOL_SIZE", "50"))


# =============================================================================
# StreamHub: 1 Redis reader per stream key, fan-out to N clients
# Solves: 100 SSE clients = 100 XREAD -> 100 SSE clients = 1 XREAD + 100 queues
# =============================================================================

from collections import defaultdict
from typing import Set
import builtins
_builtin_set = builtins.set  # Save reference before module-level 'set' function shadows it

class _HubSubscription:
    """Context manager for safe subscribe/unsubscribe."""
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
        return False


class StreamHub:
    """
    Multiplexes stream reads: 1 XREAD per stream key, fan-out to N clients.

    Usage in SSE endpoint:
        async with redis.hub.subscription(stream_key) as queue:
            async for msg in redis.hub.iter_queue(queue):
                yield format_sse(msg)
    """

    def __init__(self, redis_client: Redis, queue_maxsize: int = 256):
        self._redis = redis_client
        self._queue_maxsize = queue_maxsize
        self._pumps: Dict[str, asyncio.Task] = {}
        self._subs: Dict[str, Set[asyncio.Queue]] = defaultdict(_builtin_set)
        self._lock = asyncio.Lock()
        # Metrics
        self.streams_active = 0
        self.subscribers_total = 0
        self.messages_delivered = 0
        self.messages_dropped = 0

    async def subscribe(self, stream_key: str, last_id: str = "0") -> asyncio.Queue:
        """Subscribe to stream. Returns bounded queue for messages."""
        queue = asyncio.Queue(maxsize=self._queue_maxsize)
        async with self._lock:
            self._subs[stream_key].add(queue)
            self.subscribers_total += 1
            if stream_key not in self._pumps:
                self._pumps[stream_key] = asyncio.create_task(self._pump(stream_key, last_id))
                self.streams_active += 1
                logger.debug(f"Hub: Started pump for {stream_key}")
        return queue

    async def unsubscribe(self, stream_key: str, queue: asyncio.Queue):
        """Unsubscribe from stream. MUST be called (use context manager)."""
        async with self._lock:
            subs = self._subs.get(stream_key)
            if not subs:
                return
            subs.discard(queue)
            if not subs:
                task = self._pumps.pop(stream_key, None)
                if task:
                    task.cancel()
                    try:
                        await task
                    except asyncio.CancelledError:
                        pass
                    self.streams_active -= 1
                    logger.debug(f"Hub: Stopped pump for {stream_key}")
                self._subs.pop(stream_key, None)

    async def _pump(self, stream_key: str, last_id: str):
        """Single reader per stream, fans out to all subscribers."""
        try:
            while True:
                try:
                    result = await self._redis.xread({stream_key: last_id}, block=500, count=100)
                    if not result:
                        continue
                    for stream_name, entries in result:
                        for msg_id, fields in entries:
                            last_id = msg_id
                            async with self._lock:
                                subs = list(self._subs.get(stream_key, []))
                            for queue in subs:
                                try:
                                    queue.put_nowait((msg_id, fields))
                                    self.messages_delivered += 1
                                except asyncio.QueueFull:
                                    self.messages_dropped += 1
                except (ConnectionError, RedisConnectionError, OSError) as e:
                    logger.warning(f"Hub pump connection error for {stream_key}: {e}")
                    await asyncio.sleep(0.5)
                except Exception as e:
                    logger.warning(f"Hub pump error for {stream_key}: {e}")
                    await asyncio.sleep(0.1)
        except asyncio.CancelledError:
            logger.debug(f"Hub pump cancelled for {stream_key}")
            raise

    async def iter_queue(self, queue: asyncio.Queue, timeout: float = 1.0):
        """Async iterator for queue. Yields (msg_id, fields) or None on timeout."""
        while True:
            try:
                msg = await asyncio.wait_for(queue.get(), timeout=timeout)
                yield msg
            except asyncio.TimeoutError:
                yield None

    def subscription(self, stream_key: str, last_id: str = "0"):
        """Context manager for safe subscribe/unsubscribe."""
        return _HubSubscription(self, stream_key, last_id)

    async def close(self):
        """Cancel all pump tasks on shutdown."""
        async with self._lock:
            tasks = list(self._pumps.values())
            self._pumps.clear()
            self._subs.clear()
        for t in tasks:
            t.cancel()
        for t in tasks:
            try:
                await t
            except asyncio.CancelledError:
                pass
        logger.debug(f"Hub: Closed, cancelled {len(tasks)} pumps")

    def get_stats(self) -> Dict[str, Any]:
        return {
            "streams_active": self.streams_active,
            "subscribers_total": self.subscribers_total,
            "messages_delivered": self.messages_delivered,
            "messages_dropped": self.messages_dropped,
        }



class RedisClient:
    def __init__(self):
        # General pool - for GET/SET/XADD (non-blocking ops)
        self._pool: Optional[ConnectionPool] = None
        self._client: Optional[Redis] = None
        # Stream pool - for XREAD/XREADGROUP (blocking ops) - prevents starvation
        self._stream_pool: Optional[ConnectionPool] = None
        self._stream_client: Optional[Redis] = None
        # Hub for SSE fan-out (1 reader per stream, N clients)
        self._hub: Optional[StreamHub] = None

        self._init_lock: Optional[asyncio.Lock] = None
        self._initialized = False
        # Metrics for monitoring
        self._op_count = 0
        self._timeout_count = 0
        self._error_count = 0
        self._init_time: Optional[float] = None
    
    def _get_config(self) -> Dict[str, Any]:
        load_dotenv()
        
        redis_host = os.getenv("REDIS_HOST", "localhost")
        redis_port = int(os.getenv("REDIS_PORT", 6379))
        redis_password = os.getenv("REDIS_PASSWORD", "")
        redis_username = os.getenv("REDIS_USERNAME", None)
        redis_ssl = os.getenv("REDIS_SSL", "false").lower() == "true"
        
        scheme = "rediss" if redis_ssl else "redis"
        if redis_username and redis_password:
            redis_url = f"{scheme}://{redis_username}:{redis_password}@{redis_host}:{redis_port}"
        elif redis_password:
            redis_url = f"{scheme}://:{redis_password}@{redis_host}:{redis_port}"
        else:
            redis_url = f"{scheme}://{redis_host}:{redis_port}"
        
        return {
            "host": redis_host,
            "port": redis_port,
            "password": redis_password,
            "username": redis_username,
            "ssl": redis_ssl,
            "url": redis_url,
        }
    
    def get_pool_info(self) -> Dict[str, Any]:
        """Get connection pool stats for monitoring."""
        def _pool_stats(pool, name):
            if not pool:
                return {"status": "not_initialized"}
            return {
                "name": name,
                "max_connections": getattr(pool, 'max_connections', 'unknown'),
                "created_connections": len(getattr(pool, '_created_connections', [])),
                "available_connections": len(getattr(pool, '_available_connections', [])),
                "in_use_connections": len(getattr(pool, '_in_use_connections', [])),
            }

        if self._pool:
            uptime = time.time() - self._init_time if self._init_time else 0
            return {
                "general_pool": _pool_stats(self._pool, "general"),
                "stream_pool": _pool_stats(self._stream_pool, "stream"),
                "uptime_seconds": round(uptime, 1),
                "op_count": self._op_count,
                "timeout_count": self._timeout_count,
                "error_count": self._error_count,
                "hub": self._hub.get_stats() if self._hub else None,
            }
        return {"status": "pool_not_initialized"}

    async def get_client(self) -> Redis:
        if self._client is not None and self._initialized:
            return self._client
        
        # Lazily create the async lock (thread-safe via __init__)
        if self._init_lock is None:
            self._init_lock = asyncio.Lock()
        
        async with self._init_lock:
            # Double-check after acquiring lock to prevent race condition
            if self._client is not None and self._initialized:
                return self._client
            
            config = self._get_config()
            
            logger.info(
                f"Initializing Redis to {config['host']}:{config['port']} "
                f"(socket_timeout={SOCKET_TIMEOUT}s, connect_timeout={SOCKET_CONNECT_TIMEOUT}s)"
            )
            
            retry = Retry(ExponentialBackoff(), 3)

            # GENERAL POOL - for GET/SET/XADD (non-blocking ops)
            self._pool = ConnectionPool.from_url(
                config["url"],
                decode_responses=True,
                max_connections=GENERAL_POOL_SIZE,
                socket_timeout=SOCKET_TIMEOUT,
                socket_connect_timeout=SOCKET_CONNECT_TIMEOUT,
                socket_keepalive=True,
                retry_on_timeout=True,
                health_check_interval=HEALTH_CHECK_INTERVAL,
            )
            self._client = Redis(
                connection_pool=self._pool,
                retry=retry,
                retry_on_error=[BusyLoadingError]
            )

            # STREAM POOL - for XREAD/XREADGROUP (blocking ops) - isolated to prevent starvation
            self._stream_pool = ConnectionPool.from_url(
                config["url"],
                decode_responses=True,
                max_connections=STREAM_POOL_SIZE,
                socket_timeout=SOCKET_TIMEOUT,
                socket_connect_timeout=SOCKET_CONNECT_TIMEOUT,
                socket_keepalive=True,
                retry_on_timeout=True,
                health_check_interval=HEALTH_CHECK_INTERVAL,
            )
            self._stream_client = Redis(
                connection_pool=self._stream_pool,
                retry=retry,
                retry_on_error=[BusyLoadingError]
            )

            try:
                await asyncio.wait_for(self._client.ping(), timeout=5.0)
                await asyncio.wait_for(self._stream_client.ping(), timeout=5.0)
                # Initialize hub for SSE fan-out
                self._hub = StreamHub(self._stream_client)
                self._initialized = True
                self._init_time = time.time()
                logger.info(f"Successfully connected to Redis (general_pool={GENERAL_POOL_SIZE}, stream_pool={STREAM_POOL_SIZE})")
            except asyncio.TimeoutError:
                logger.error("Redis ping timed out after 5 seconds")
                raise ConnectionError("Redis connection timeout - is Redis running?")
            except Exception as e:
                logger.error(f"Redis ping failed: {e}")
                raise ConnectionError(f"Redis connection failed: {e}")
            
            return self._client
    
    async def initialize_async(self):
        await self.get_client()
    
    async def close(self):
        # Lazily create the async lock if it doesn't exist
        if self._init_lock is None:
            self._init_lock = asyncio.Lock()

        async with self._init_lock:
            # Close general client/pool
            if self._client:
                try:
                    await self._client.aclose()
                except Exception as e:
                    logger.warning(f"Error closing Redis client: {e}")
                finally:
                    self._client = None

            if self._pool:
                try:
                    await self._pool.aclose()
                except Exception as e:
                    logger.warning(f"Error closing Redis pool: {e}")
                finally:
                    self._pool = None

            # Close stream client/pool
            if self._stream_client:
                try:
                    await self._stream_client.aclose()
                except Exception as e:
                    logger.warning(f"Error closing Redis stream client: {e}")
                finally:
                    self._stream_client = None

            if self._stream_pool:
                try:
                    await self._stream_pool.aclose()
                except Exception as e:
                    logger.warning(f"Error closing Redis stream pool: {e}")
                finally:
                    self._stream_pool = None

            # Close hub (cancels all pump tasks)
            if self._hub:
                try:
                    await self._hub.close()
                except Exception as e:
                    logger.warning(f"Error closing StreamHub: {e}")
                finally:
                    self._hub = None

            self._initialized = False
            logger.info("Redis connections and pools closed")
    
    async def verify_connection(self) -> bool:
        try:
            client = await self.get_client()
            await asyncio.wait_for(client.ping(), timeout=5.0)
            logger.info("✅ Redis connection verified")
            return True
        except Exception as e:
            logger.error(f"❌ Redis connection verification failed: {e}")
            raise ConnectionError(f"Redis connection verification failed: {e}")
    
    async def verify_stream_writable(self, stream_key: str) -> bool:
        test_key = f"{stream_key}:health_check"
        try:
            client = await self.get_client()
            test_id = await asyncio.wait_for(
                client.xadd(test_key, {'_health_check': 'true'}, maxlen=1),
                timeout=5.0
            )
            if test_id:
                await asyncio.wait_for(client.delete(test_key), timeout=2.0)
                logger.info(f"✅ Redis stream {stream_key} is writable")
                return True
            raise ConnectionError(f"Redis stream {stream_key} write returned no ID")
        except ConnectionError:
            raise
        except Exception as e:
            logger.error(f"❌ Redis stream {stream_key} write verification failed: {e}")
            raise ConnectionError(f"Redis stream {stream_key} is not writable: {e}")

    @property
    def hub(self) -> StreamHub:
        """Get StreamHub for SSE fan-out (1 reader per stream, N clients)."""
        if not self._hub:
            raise RuntimeError("Redis not initialized. Call get_client() first.")
        return self._hub

    async def _with_timeout(self, coro, timeout_seconds: float, operation_name: str, default=None):
        """Execute a Redis operation with timeout. Let Redis handle connection errors naturally."""
        self._op_count += 1
        try:
            return await asyncio.wait_for(coro, timeout=timeout_seconds)
        except asyncio.TimeoutError:
            self._timeout_count += 1
            logger.warning(f"⚠️ [REDIS TIMEOUT] {operation_name} timed out after {timeout_seconds}s")
            return default
        except (ConnectionError, RedisConnectionError, OSError) as e:
            self._error_count += 1
            logger.warning(f"⚠️ [REDIS CONNECTION] {operation_name}: {e}")
            return default
        except Exception as e:
            self._error_count += 1
            logger.warning(f"⚠️ [REDIS ERROR] {operation_name}: {e}")
            return default
    
    # ========== Basic Operations with Timeout ==========
    
    async def get(self, key: str, timeout: float = None) -> Optional[str]:
        """Get a key with timeout protection."""
        timeout = timeout or DEFAULT_OP_TIMEOUT
        if self._initialized and self._client:
            client = self._client
        else:
            client = await self.get_client()
        return await self._with_timeout(
            client.get(key),
            timeout_seconds=timeout,
            operation_name=f"get({key[:50]}...)" if len(key) > 50 else f"get({key})",
            default=None
        )
    
    async def set(self, key: str, value: str, ex: int = None, nx: bool = False, timeout: float = None) -> bool:
        """Set a key with timeout protection."""
        timeout = timeout or DEFAULT_OP_TIMEOUT
        if self._initialized and self._client:
            client = self._client
        else:
            client = await self.get_client()
        result = await self._with_timeout(
            client.set(key, value, ex=ex, nx=nx),
            timeout_seconds=timeout,
            operation_name=f"set({key[:50]}...)" if len(key) > 50 else f"set({key})",
            default=False
        )
        return bool(result)
    
    async def setex(self, key: str, seconds: int, value: str, timeout: float = None) -> bool:
        """Set a key with expiration and timeout protection."""
        timeout = timeout or DEFAULT_OP_TIMEOUT
        if self._initialized and self._client:
            client = self._client
        else:
            client = await self.get_client()
        result = await self._with_timeout(
            client.setex(key, seconds, value),
            timeout_seconds=timeout,
            operation_name=f"setex({key[:50]}...)" if len(key) > 50 else f"setex({key})",
            default=False
        )
        return bool(result)
    
    async def delete(self, key: str, timeout: float = None) -> int:
        """Delete a key with timeout protection."""
        timeout = timeout or DEFAULT_OP_TIMEOUT
        if self._initialized and self._client:
            client = self._client
        else:
            client = await self.get_client()
        result = await self._with_timeout(
            client.delete(key),
            timeout_seconds=timeout,
            operation_name=f"delete({key[:50]}...)" if len(key) > 50 else f"delete({key})",
            default=0
        )
        return result or 0
    
    async def delete_multiple(self, keys: List[str], timeout: float = None) -> int:
        """Delete multiple keys using pipelining for efficiency."""
        if not keys:
            return 0
        
        timeout = timeout or DEFAULT_OP_TIMEOUT
        if self._initialized and self._client:
            client = self._client
        else:
            client = await self.get_client()
        
        try:
            # Use pipeline for batch delete - much more efficient than individual deletes
            pipe = client.pipeline()
            for key in keys:
                pipe.delete(key)
            
            results = await self._with_timeout(
                pipe.execute(),
                timeout_seconds=timeout,
                operation_name=f"delete_multiple({len(keys)} keys)",
                default=[0] * len(keys)
            )
            
            # Count successful deletes
            deleted_count = sum(1 for r in results if r)
            return deleted_count
        except Exception as e:
            logger.warning(f"Batch delete failed, falling back to individual deletes: {e}")
            # Fallback to individual deletes if pipeline fails
            deleted_count = 0
            for key in keys:
                try:
                    result = await self.delete(key, timeout=min(timeout / len(keys), 2.0))
                    if result:
                        deleted_count += 1
                except Exception:
                    pass
            return deleted_count
    
    async def incr(self, key: str, timeout: float = None) -> int:
        """Increment a key with timeout protection."""
        timeout = timeout or DEFAULT_OP_TIMEOUT
        client = await self.get_client()
        result = await self._with_timeout(
            client.incr(key),
            timeout_seconds=timeout,
            operation_name=f"incr({key})",
            default=0
        )
        return result or 0
    
    async def expire(self, key: str, seconds: int, timeout: float = None) -> bool:
        """Set key expiration with timeout protection."""
        timeout = timeout or DEFAULT_OP_TIMEOUT
        client = await self.get_client()
        result = await self._with_timeout(
            client.expire(key, seconds),
            timeout_seconds=timeout,
            operation_name=f"expire({key})",
            default=False
        )
        return bool(result)
    
    async def ttl(self, key: str, timeout: float = None) -> int:
        """Get TTL with timeout protection."""
        timeout = timeout or DEFAULT_OP_TIMEOUT
        client = await self.get_client()
        result = await self._with_timeout(
            client.ttl(key),
            timeout_seconds=timeout,
            operation_name=f"ttl({key})",
            default=-2  # -2 means key doesn't exist
        )
        return result if result is not None else -2
    
    async def scan_keys(self, pattern: str, count: int = 100, timeout: float = None) -> List[str]:
        """Scan keys with timeout protection - returns partial results on timeout."""
        timeout = timeout or DEFAULT_STREAM_TIMEOUT
        client = await self.get_client()
        keys = []
        try:
            async def _scan():
                result = []
                async for key in client.scan_iter(match=pattern, count=count):
                    result.append(key)
                    if len(result) >= 1000:  # Safety limit
                        break
                return result
            keys = await self._with_timeout(
                _scan(),
                timeout_seconds=timeout,
                operation_name=f"scan_keys({pattern})",
                default=[]
            )
        except Exception as e:
            logger.warning(f"scan_keys failed: {e}")
        return keys or []
    
    async def scard(self, key: str, timeout: float = None) -> int:
        """Get set cardinality with timeout protection."""
        timeout = timeout or DEFAULT_OP_TIMEOUT
        client = await self.get_client()
        result = await self._with_timeout(
            client.scard(key),
            timeout_seconds=timeout,
            operation_name=f"scard({key})",
            default=0
        )
        return result or 0
    
    async def zrangebyscore(self, key: str, min: str, max: str, timeout: float = None) -> List[str]:
        """Get sorted set range by score with timeout protection."""
        timeout = timeout or DEFAULT_OP_TIMEOUT
        client = await self.get_client()
        result = await self._with_timeout(
            client.zrangebyscore(key, min=min, max=max),
            timeout_seconds=timeout,
            operation_name=f"zrangebyscore({key})",
            default=[]
        )
        return result or []
    
    async def zscore(self, key: str, member: str, timeout: float = None) -> Optional[float]:
        """Get sorted set score with timeout protection."""
        timeout = timeout or DEFAULT_OP_TIMEOUT
        client = await self.get_client()
        return await self._with_timeout(
            client.zscore(key, member),
            timeout_seconds=timeout,
            operation_name=f"zscore({key})",
            default=None
        )
    
    async def llen(self, key: str, timeout: float = None) -> int:
        """Get list length with timeout protection."""
        timeout = timeout or DEFAULT_OP_TIMEOUT
        client = await self.get_client()
        result = await self._with_timeout(
            client.llen(key),
            timeout_seconds=timeout,
            operation_name=f"llen({key})",
            default=0
        )
        return result or 0
    
    # ========== Stream Operations with Timeout ==========
    
    async def stream_add(self, stream_key: str, fields: Dict[str, str], maxlen: int = None, 
                        approximate: bool = True, timeout: Optional[float] = None, 
                        fail_silently: bool = True) -> Optional[str]:
        """Add to stream with timeout protection."""
        if self._initialized and self._client:
            client = self._client
        else:
            client = await self.get_client()
        kwargs = {}
        if maxlen is not None:
            kwargs['maxlen'] = maxlen
            kwargs['approximate'] = approximate
        
        if timeout is None:
            env_timeout = os.getenv("REDIS_STREAM_ADD_TIMEOUT")
            timeout = float(env_timeout) if env_timeout else 5.0
        
        try:
            result = await self._with_timeout(
                client.xadd(stream_key, fields, **kwargs),
                timeout_seconds=timeout,
                operation_name=f"stream_add({stream_key})",
                default=None
            )
            return result
        except Exception as e:
            if fail_silently:
                logger.warning(f"⚠️ stream_add failed (non-fatal) for {stream_key}: {e}")
                return None
            raise
    
    async def stream_read(self, stream_key: str, last_id: str = "0", block_ms: int = None,
                          count: int = None, timeout: Optional[float] = None) -> List[tuple]:
        """Read from stream with timeout protection. Uses STREAM_POOL if blocking."""
        # Use stream pool for blocking reads to prevent starvation
        if block_ms and block_ms > 0:
            if self._initialized and self._stream_client:
                client = self._stream_client
            else:
                await self.get_client()
                client = self._stream_client
        else:
            if self._initialized and self._client:
                client = self._client
            else:
                client = await self.get_client()

        streams = {stream_key: last_id}
        block_arg = block_ms if block_ms and block_ms > 0 else None
        
        # Calculate timeout: block_ms + buffer, or default
        if timeout is None:
            if block_ms and block_ms > 0:
                # Add 2 second buffer to block time
                timeout = (block_ms / 1000) + 2.0
            else:
                timeout = DEFAULT_STREAM_TIMEOUT
            # Cap at reasonable max
            timeout = min(timeout, 30.0)
        
        result = await self._with_timeout(
            client.xread(streams, count=count, block=block_arg),
            timeout_seconds=timeout,
            operation_name=f"stream_read({stream_key})",
            default=[]
        )
        
        if not result:
            return []
        
        entries = []
        for stream_name, stream_entries in result:
            for entry_id, fields in stream_entries:
                entries.append((entry_id, fields))
        
        return entries
    
    async def stream_range(self, stream_key: str, start: str = "-", end: str = "+", 
                           count: int = None, timeout: Optional[float] = None) -> List[tuple]:
        """Get stream range with timeout protection."""
        if self._initialized and self._client:
            client = self._client
        else:
            client = await self.get_client()
        
        timeout = timeout or DEFAULT_STREAM_TIMEOUT
        
        result = await self._with_timeout(
            client.xrange(stream_key, start, end, count=count),
            timeout_seconds=timeout,
            operation_name=f"stream_range({stream_key})",
            default=[]
        )
        
        if not result:
            return []
        return [(entry_id, fields) for entry_id, fields in result]
    
    async def stream_len(self, stream_key: str, timeout: Optional[float] = None) -> int:
        """Get stream length with timeout protection."""
        timeout = timeout or DEFAULT_OP_TIMEOUT
        client = await self.get_client()
        result = await self._with_timeout(
            client.xlen(stream_key),
            timeout_seconds=timeout,
            operation_name=f"stream_len({stream_key})",
            default=0
        )
        return result or 0
    
    async def xadd(self, stream_key: str, fields: Dict[str, str], maxlen: int = None, 
                   approximate: bool = True, timeout: Optional[float] = None) -> Optional[str]:
        return await self.stream_add(stream_key, fields, maxlen=maxlen, approximate=approximate, timeout=timeout)
    
    async def xread(self, streams: Dict[str, str], count: int = None, block: int = None,
                    timeout: Optional[float] = None) -> List:
        """Read from multiple streams with timeout protection. Uses STREAM_POOL if blocking."""
        # Use stream pool for blocking reads to prevent starvation
        if block and block > 0:
            if self._initialized and self._stream_client:
                client = self._stream_client
            else:
                await self.get_client()
                client = self._stream_client
        else:
            if self._initialized and self._client:
                client = self._client
            else:
                client = await self.get_client()

        # Calculate timeout based on block time
        if timeout is None:
            if block and block > 0:
                timeout = (block / 1000) + 2.0
            else:
                timeout = DEFAULT_STREAM_TIMEOUT
            timeout = min(timeout, 30.0)
        
        result = await self._with_timeout(
            client.xread(streams, count=count, block=block),
            timeout_seconds=timeout,
            operation_name=f"xread({list(streams.keys())})",
            default=[]
        )
        return result or []
    
    async def xrange(self, stream_key: str, start: str = "-", end: str = "+", 
                     count: int = None, timeout: Optional[float] = None) -> List:
        """Get stream range with timeout protection."""
        if self._initialized and self._client:
            client = self._client
        else:
            client = await self.get_client()
        
        timeout = timeout or DEFAULT_STREAM_TIMEOUT
        
        result = await self._with_timeout(
            client.xrange(stream_key, start, end, count=count),
            timeout_seconds=timeout,
            operation_name=f"xrange({stream_key})",
            default=[]
        )
        return result or []
    
    async def xlen(self, stream_key: str, timeout: Optional[float] = None) -> int:
        return await self.stream_len(stream_key, timeout=timeout)
    
    async def xtrim_minid(self, stream_key: str, minid: str, approximate: bool = True, 
                          timeout: Optional[float] = None) -> int:
        """Trim stream with timeout protection."""
        timeout = timeout or DEFAULT_OP_TIMEOUT
        client = await self.get_client()
        result = await self._with_timeout(
            client.xtrim(stream_key, minid=minid, approximate=approximate),
            timeout_seconds=timeout,
            operation_name=f"xtrim_minid({stream_key})",
            default=0
        )
        return result or 0
    
    # ========== Agent Run Stop Signal Operations ==========
    
    async def set_stop_signal(self, agent_run_id: str) -> None:
        """Set stop signal for an agent run."""
        key = f"agent_run:{agent_run_id}:stop"
        await self.set(key, "1", ex=300, timeout=2.0)  # Fast timeout for stop signals
        logger.info(f"Set stop signal for agent run {agent_run_id}")
    
    async def check_stop_signal(self, agent_run_id: str) -> bool:
        """Check stop signal - optimized with short timeout."""
        key = f"agent_run:{agent_run_id}:stop"
        value = await self.get(key, timeout=2.0)  # Fast timeout for stop checks
        return value == "1"
    
    async def clear_stop_signal(self, agent_run_id: str) -> None:
        """Clear stop signal for an agent run."""
        key = f"agent_run:{agent_run_id}:stop"
        await self.delete(key, timeout=2.0)
        logger.debug(f"Cleared stop signal for agent run {agent_run_id}")
    
    # ========== Consumer Group Operations ==========
    
    async def xreadgroup(self, groupname: str, consumername: str, streams: Dict[str, str],
                         block: int = None, count: int = None, timeout: Optional[float] = None) -> List:
        """Read from consumer group with timeout protection. Uses STREAM_POOL if blocking."""
        block_ms = block or 0
        # Use stream pool for blocking reads to prevent starvation
        if block_ms > 0:
            if self._initialized and self._stream_client:
                client = self._stream_client
            else:
                await self.get_client()
                client = self._stream_client
        else:
            client = await self.get_client()

        if timeout is None:
            env_timeout = os.getenv("REDIS_XREADGROUP_TIMEOUT")
            if env_timeout:
                timeout = float(env_timeout)
            else:
                timeout = min((block_ms / 1000) + 2.0, 30.0) if block_ms > 0 else 10.0
        
        return await self._with_timeout(
            client.xreadgroup(groupname=groupname, consumername=consumername, 
                             streams=streams, block=block, count=count),
            timeout_seconds=timeout,
            operation_name=f"xreadgroup({groupname})",
            default=[]
        )
    
    async def xack(self, stream: str, group: str, *ids, timeout: Optional[float] = None) -> Optional[int]:
        """Acknowledge stream messages with timeout protection."""
        client = await self.get_client()
        
        if timeout is None:
            env_timeout = os.getenv("REDIS_XACK_TIMEOUT")
            timeout = float(env_timeout) if env_timeout else 10.0
        
        return await self._with_timeout(
            client.xack(stream, group, *ids),
            timeout_seconds=timeout,
            operation_name=f"xack({stream})",
            default=None
        )
    
    # ========== Health Check ==========
    
    async def health_check(self) -> Dict[str, Any]:
        """Perform health check and return diagnostics."""
        start = time.time()
        try:
            client = await self.get_client()
            await asyncio.wait_for(client.ping(), timeout=2.0)
            latency_ms = (time.time() - start) * 1000
            
            pool_info = self.get_pool_info()
            
            return {
                "status": "healthy" if latency_ms < 100 else "degraded",
                "latency_ms": round(latency_ms, 2),
                "pool": pool_info,
                "timeouts": {
                    "op_timeout": DEFAULT_OP_TIMEOUT,
                    "stream_timeout": DEFAULT_STREAM_TIMEOUT,
                    "socket_timeout": SOCKET_TIMEOUT,
                    "connect_timeout": SOCKET_CONNECT_TIMEOUT,
                }
            }
        except Exception as e:
            return {
                "status": "unhealthy",
                "error": str(e),
                "pool": self.get_pool_info()
            }


redis = RedisClient()


def get_redis_config() -> Dict[str, Any]:
    temp_client = RedisClient()
    return temp_client._get_config()


# ========== Compatibility Functions (for backward compatibility) ==========
# These functions allow code to use `from core.services import redis` and call
# `await redis.get()` instead of `await redis.redis.get()`

async def get_client():
    return await redis.get_client()

async def initialize_async():
    await redis.initialize_async()

async def close():
    await redis.close()

async def verify_connection() -> bool:
    return await redis.verify_connection()

async def verify_stream_writable(stream_key: str) -> bool:
    return await redis.verify_stream_writable(stream_key)

async def get(key: str, timeout: float = None):
    return await redis.get(key, timeout=timeout)

async def set(key: str, value: str, ex: int = None, nx: bool = False, timeout: float = None):
    return await redis.set(key, value, ex=ex, nx=nx, timeout=timeout)

async def setex(key: str, seconds: int, value: str, timeout: float = None):
    return await redis.setex(key, seconds, value, timeout=timeout)

async def delete(key: str, timeout: float = None):
    return await redis.delete(key, timeout=timeout)

async def delete_multiple(keys: List[str], timeout: float = None) -> int:
    return await redis.delete_multiple(keys, timeout=timeout)

async def incr(key: str, timeout: float = None) -> int:
    return await redis.incr(key, timeout=timeout)

async def expire(key: str, seconds: int, timeout: float = None):
    return await redis.expire(key, seconds, timeout=timeout)

async def ttl(key: str, timeout: float = None) -> int:
    return await redis.ttl(key, timeout=timeout)

async def scan_keys(pattern: str, count: int = 100, timeout: float = None):
    return await redis.scan_keys(pattern, count=count, timeout=timeout)

async def scard(key: str, timeout: float = None) -> int:
    return await redis.scard(key, timeout=timeout)

async def zrangebyscore(key: str, min: str, max: str, timeout: float = None):
    return await redis.zrangebyscore(key, min=min, max=max, timeout=timeout)

async def zscore(key: str, member: str, timeout: float = None):
    return await redis.zscore(key, member, timeout=timeout)

async def llen(key: str, timeout: float = None) -> int:
    return await redis.llen(key, timeout=timeout)

async def stream_add(stream_key: str, fields: dict, maxlen: int = None, approximate: bool = True, 
                    timeout: Optional[float] = None, fail_silently: bool = True) -> Optional[str]:
    return await redis.stream_add(stream_key, fields, maxlen=maxlen, approximate=approximate, 
                                  timeout=timeout, fail_silently=fail_silently)

async def stream_read(stream_key: str, last_id: str = "0", block_ms: int = None, 
                      count: int = None, timeout: Optional[float] = None):
    return await redis.stream_read(stream_key, last_id, block_ms=block_ms, count=count, timeout=timeout)

async def stream_range(stream_key: str, start: str = "-", end: str = "+", 
                       count: int = None, timeout: Optional[float] = None):
    return await redis.stream_range(stream_key, start, end, count=count, timeout=timeout)

async def stream_len(stream_key: str, timeout: Optional[float] = None) -> int:
    return await redis.stream_len(stream_key, timeout=timeout)

async def xadd(stream_key: str, fields: dict, maxlen: int = None, approximate: bool = True, 
               timeout: Optional[float] = None) -> Optional[str]:
    return await redis.xadd(stream_key, fields, maxlen=maxlen, approximate=approximate, timeout=timeout)

async def xread(streams: dict, count: int = None, block: int = None, timeout: Optional[float] = None):
    return await redis.xread(streams, count=count, block=block, timeout=timeout)

async def xrange(stream_key: str, start: str = "-", end: str = "+", 
                 count: int = None, timeout: Optional[float] = None):
    return await redis.xrange(stream_key, start, end, count=count, timeout=timeout)

async def xlen(stream_key: str, timeout: Optional[float] = None) -> int:
    return await redis.xlen(stream_key, timeout=timeout)

async def xtrim_minid(stream_key: str, minid: str, approximate: bool = True, 
                      timeout: Optional[float] = None) -> int:
    return await redis.xtrim_minid(stream_key, minid, approximate=approximate, timeout=timeout)

async def set_stop_signal(agent_run_id: str):
    await redis.set_stop_signal(agent_run_id)

async def check_stop_signal(agent_run_id: str) -> bool:
    return await redis.check_stop_signal(agent_run_id)

async def clear_stop_signal(agent_run_id: str):
    await redis.clear_stop_signal(agent_run_id)

async def xreadgroup(groupname: str, consumername: str, streams: Dict[str, str], 
                     block: int = None, count: int = None, timeout: Optional[float] = None):
    return await redis.xreadgroup(groupname=groupname, consumername=consumername, 
                                 streams=streams, block=block, count=count, timeout=timeout)

async def xack(stream: str, group: str, *ids, timeout: Optional[float] = None):
    return await redis.xack(stream, group, *ids, timeout=timeout)

async def health_check() -> Dict[str, Any]:
    return await redis.health_check()

def get_pool_info() -> Dict[str, Any]:
    return redis.get_pool_info()


__all__ = [
    'redis',
    'RedisClient',
    'REDIS_KEY_TTL',
    'get_redis_config',
    'get_client',
    'initialize_async',
    'close',
    'verify_connection',
    'verify_stream_writable',
    'get',
    'set',
    'setex',
    'delete',
    'delete_multiple',
    'incr',
    'expire',
    'ttl',
    'scard',
    'zrangebyscore',
    'zscore',
    'llen',
    'scan_keys',
    'stream_add',
    'stream_read',
    'stream_range',
    'stream_len',
    'xadd',
    'xread',
    'xrange',
    'xlen',
    'xtrim_minid',
    'xreadgroup',
    'xack',
    'set_stop_signal',
    'check_stop_signal',
    'clear_stop_signal',
    'health_check',
    'get_pool_info',
]
