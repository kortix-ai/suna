import redis.asyncio as redis_lib
from redis.exceptions import ConnectionError as RedisConnectionError, TimeoutError as RedisTimeoutError
import os
import time as _time
from dotenv import load_dotenv
import asyncio
from core.utils.logger import logger
from typing import List, Any, Optional
from core.utils.retry import retry

client: Optional[redis_lib.Redis] = None
pool: Optional[redis_lib.ConnectionPool] = None
_initialized = False
_init_lock = asyncio.Lock()
_reconnect_lock = asyncio.Lock()
_reconnect_in_progress = False
_last_reconnect_attempt = 0.0
RECONNECT_DEBOUNCE_SECONDS = 2.0  # Don't reconnect more than once every 2 seconds

# Semaphore to limit concurrent streaming operations
_streaming_semaphore: Optional[asyncio.Semaphore] = None
MAX_CONCURRENT_STREAMING_OPS = 20  # Limit concurrent publish_and_xadd calls

REDIS_KEY_TTL = 3600 * 2

MAX_RETRIES = int(os.getenv("REDIS_MAX_RETRIES", "3"))
RETRY_BACKOFF_BASE = 0.5

_circuit_breaker = {
    "failures": 0,
    "last_failure": 0.0,
    "state": "closed",
}
CIRCUIT_BREAKER_THRESHOLD = 5
CIRCUIT_BREAKER_TIMEOUT = 30.0


def get_redis_config():
    load_dotenv()
    
    redis_host = os.getenv("REDIS_HOST", "redis")
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


def initialize():
    global client, pool

    load_dotenv()
    config = get_redis_config()
    
    max_connections = int(os.getenv("REDIS_MAX_CONNECTIONS", "50"))
    socket_timeout = 10.0
    connect_timeout = 5.0
    retry_on_timeout = os.getenv("REDIS_RETRY_ON_TIMEOUT", "true").lower() == "true"
    
    auth_info = f"user={config['username']} " if config['username'] else ""
    ssl_info = "(SSL) " if config['ssl'] else ""
    logger.info(f"Initializing Redis to {config['host']}:{config['port']} {auth_info}{ssl_info}with max {max_connections} connections")

    pool = redis_lib.ConnectionPool.from_url(
        config["url"],
        decode_responses=True,
        socket_timeout=socket_timeout,
        socket_connect_timeout=connect_timeout,
        socket_keepalive=True,
        retry_on_timeout=retry_on_timeout,
        health_check_interval=30,
        max_connections=max_connections,
    )
    client = redis_lib.Redis(connection_pool=pool)

    return client


async def initialize_async():
    global client, pool, _initialized

    async with _init_lock:
        # If already initialized and client exists, just verify it's still alive
        if _initialized and client is not None:
            try:
                await asyncio.wait_for(client.ping(), timeout=2.0)
                return client  # Connection is good, reuse it
            except Exception:
                # Connection is dead, need to recreate
                logger.warning("Existing Redis connection is dead, recreating...")
                # Close old resources before recreating
                if client:
                    try:
                        await asyncio.wait_for(client.aclose(), timeout=2.0)
                    except Exception:
                        pass
                if pool:
                    try:
                        await asyncio.wait_for(pool.aclose(), timeout=2.0)
                    except Exception:
                        pass
                client = None
                pool = None
                _initialized = False
        
        # Create new connection
        if client is None:
            initialize()
            logger.info("Created new Redis connection pool")

        try:
            await asyncio.wait_for(client.ping(), timeout=5.0)
            if not _initialized:
                logger.info("Successfully connected to Redis")
            _initialized = True
        except asyncio.TimeoutError:
            logger.error("Redis connection timeout during initialization")
            client = None
            pool = None
            _initialized = False
            raise ConnectionError("Redis connection timeout")
        except Exception as e:
            logger.error(f"Failed to connect to Redis: {e}")
            client = None
            pool = None
            _initialized = False
            raise

    return client


async def close():
    global client, pool, _initialized
    if client:
        try:
            await asyncio.wait_for(client.aclose(), timeout=5.0)
        except asyncio.TimeoutError:
            logger.warning("Redis close timeout, forcing close")
        except Exception as e:
            logger.warning(f"Error closing Redis client: {e}")
        finally:
            client = None
    
    if pool:
        try:
            await asyncio.wait_for(pool.aclose(), timeout=5.0)
        except asyncio.TimeoutError:
            logger.warning("Redis pool close timeout, forcing close")
        except Exception as e:
            logger.warning(f"Error closing Redis pool: {e}")
        finally:
            pool = None
    
    _initialized = False
    logger.info("Redis connection and pool closed")


async def get_client():
    global client, _initialized
    if client is None or not _initialized:
        await retry(lambda: initialize_async())
    return client


async def force_reconnect():
    """Force a Redis reconnection with proper debouncing and locking.
    
    IMPORTANT: All debounce checks happen INSIDE the lock to prevent thundering herd.
    """
    global client, pool, _initialized, _circuit_breaker, _reconnect_in_progress, _last_reconnect_attempt
    
    # Try to acquire lock without blocking - if we can't, someone else is reconnecting
    try:
        acquired = _reconnect_lock.locked()
        if acquired:
            # Lock is held by someone else - wait for them to finish
            logger.debug("⏸️  Reconnect lock held by another coroutine, waiting...")
            async with _reconnect_lock:
                # By the time we get here, the other coroutine finished
                # Check if reconnect was successful (circuit breaker reset)
                if _circuit_breaker["state"] == "closed" and _initialized:
                    logger.debug("✅ Reconnect completed by another coroutine")
                    return True
                # If not, we'll fall through and try ourselves
    except Exception:
        pass
    
    async with _reconnect_lock:
        now = _time.time()
        
        # ALL debounce checks INSIDE the lock to prevent thundering herd
        if now - _last_reconnect_attempt < RECONNECT_DEBOUNCE_SECONDS:
            logger.debug(f"⏸️  Skipping reconnect (debounced, last attempt {now - _last_reconnect_attempt:.2f}s ago)")
            return False
        
        if _reconnect_in_progress:
            logger.debug("⏸️  Reconnect already in progress, skipping")
            return False
        
        _reconnect_in_progress = True
        _last_reconnect_attempt = now
        
        try:
            logger.warning("🔄 Forcing Redis reconnection...")
            
            # Close client first
            if client:
                try:
                    await asyncio.wait_for(client.aclose(), timeout=2.0)
                except Exception as e:
                    logger.debug(f"Error closing client: {e}")
                finally:
                    client = None
            
            # Close pool with more aggressive cleanup
            if pool:
                try:
                    # Wait a bit for any in-flight operations to complete
                    await asyncio.sleep(0.1)
                    await asyncio.wait_for(pool.aclose(), timeout=3.0)
                except Exception as e:
                    logger.debug(f"Error closing pool: {e}")
                finally:
                    pool = None
            
            # Ensure everything is cleaned up
            _initialized = False
            
            # Small delay to ensure connections are fully released
            await asyncio.sleep(0.2)
            
            try:
                await initialize_async()
                _circuit_breaker["state"] = "closed"
                _circuit_breaker["failures"] = 0
                logger.info("✅ Redis reconnection successful, circuit breaker reset")
                return True
            except Exception as e:
                logger.error(f"❌ Redis reconnection failed: {e}")
                raise
        finally:
            _reconnect_in_progress = False


def _is_pool_exhausted(exc: Exception) -> bool:
    """Check if the error is due to connection pool exhaustion.
    
    Pool exhaustion should NOT trigger reconnection - it means we need to
    wait for connections to be returned to the pool, not create a new pool.
    """
    error_str = str(exc).lower()
    return "too many connections" in error_str or "connection pool" in error_str


def _is_connection_error(exc: Exception) -> bool:
    """Check if the error is a genuine connection error.
    
    Pool exhaustion is NOT a connection error - reconnecting would make it worse.
    """
    # Pool exhaustion is NOT a connection error
    if _is_pool_exhausted(exc):
        return False
    
    return isinstance(exc, (
        RedisConnectionError,
        RedisTimeoutError,
        ConnectionError,
        ConnectionRefusedError,
        ConnectionResetError,
        asyncio.TimeoutError,
        OSError,
    ))


async def verify_connection() -> bool:
    try:
        redis_client = await get_client()
        await asyncio.wait_for(redis_client.ping(), timeout=5.0)
        logger.info("✅ Redis connection verified")
        return True
    except Exception as e:
        logger.error(f"❌ Redis connection verification failed: {e}")
        raise ConnectionError(f"Redis connection verification failed: {e}")


async def verify_stream_writable(stream_key: str) -> bool:
    test_key = f"{stream_key}:health_check"
    try:
        redis_client = await get_client()
        test_id = await asyncio.wait_for(
            redis_client.xadd(test_key, {'_health_check': 'true'}, maxlen=1),
            timeout=5.0
        )
        if test_id:
            await asyncio.wait_for(redis_client.delete(test_key), timeout=2.0)
            logger.info(f"✅ Redis stream {stream_key} is writable")
            return True
        raise ConnectionError(f"Redis stream {stream_key} write returned no ID")
    except ConnectionError:
        raise
    except Exception as e:
        logger.error(f"❌ Redis stream {stream_key} write verification failed: {e}")
        raise ConnectionError(f"Redis stream {stream_key} is not writable: {e}")


def _check_circuit_breaker() -> bool:
    global _circuit_breaker
    now = _time.time()
    
    if _circuit_breaker["state"] == "closed":
        return True
    
    if _circuit_breaker["state"] == "open":
        if now - _circuit_breaker["last_failure"] > CIRCUIT_BREAKER_TIMEOUT:
            _circuit_breaker["state"] = "half-open"
            logger.info("🔌 Redis circuit breaker: half-open (testing)")
            return True
        return False
    
    return True


def _record_success():
    global _circuit_breaker
    if _circuit_breaker["state"] == "half-open":
        _circuit_breaker["state"] = "closed"
        _circuit_breaker["failures"] = 0
        logger.info("✅ Redis circuit breaker: closed (healthy)")


def _record_failure():
    global _circuit_breaker
    _circuit_breaker["failures"] += 1
    _circuit_breaker["last_failure"] = _time.time()
    
    if _circuit_breaker["failures"] >= CIRCUIT_BREAKER_THRESHOLD:
        if _circuit_breaker["state"] != "open":
            _circuit_breaker["state"] = "open"
            logger.warning(f"🔴 Redis circuit breaker: OPEN (failures={_circuit_breaker['failures']})")


class RedisCircuitOpenError(Exception):
    pass


def is_redis_healthy() -> bool:
    return _circuit_breaker["state"] != "open"


def get_circuit_breaker_state() -> dict:
    return {
        "state": _circuit_breaker["state"],
        "failures": _circuit_breaker["failures"],
        "threshold": CIRCUIT_BREAKER_THRESHOLD,
        "timeout": CIRCUIT_BREAKER_TIMEOUT,
    }


async def _execute_with_retry(op_factory, operation_name: str = "redis_op"):
    last_exception = None
    
    for attempt in range(MAX_RETRIES):
        if not _check_circuit_breaker():
            if attempt == 0:
                logger.warning(f"🔄 Circuit breaker open for {operation_name}, attempting reconnect...")
                try:
                    await force_reconnect()
                except Exception as e:
                    raise RedisCircuitOpenError(f"Redis circuit breaker is open and reconnection failed: {e}")
            else:
                raise RedisCircuitOpenError("Redis circuit breaker is open after retry attempts")
        
        try:
            result = await asyncio.wait_for(op_factory(), timeout=10.0)
            _record_success()
            return result
            
        except asyncio.TimeoutError as e:
            last_exception = e
            _record_failure()
            logger.warning(f"⚠️ Redis timeout on {operation_name} (attempt {attempt + 1}/{MAX_RETRIES})")
            
        except RedisCircuitOpenError:
            raise
            
        except Exception as e:
            last_exception = e
            
            # Handle pool exhaustion separately - DON'T reconnect, just wait
            if _is_pool_exhausted(e):
                logger.warning(f"⚠️ Redis pool exhausted on {operation_name} (attempt {attempt + 1}/{MAX_RETRIES}): {e}")
                # Don't record as failure - this is a temporary condition
                # Just wait longer for connections to be released
                if attempt < MAX_RETRIES - 1:
                    backoff = RETRY_BACKOFF_BASE * (2 ** (attempt + 1))  # Longer backoff for pool exhaustion
                    logger.info(f"⏳ Pool exhausted, waiting {backoff:.1f}s for connections to be released...")
                    await asyncio.sleep(backoff)
                    continue
                else:
                    # After all retries, still exhausted - this is a problem
                    logger.error(f"❌ Pool still exhausted after {MAX_RETRIES} attempts for {operation_name}")
                    raise
            
            _record_failure()
            
            if _is_connection_error(e):
                logger.warning(f"⚠️ Redis connection error on {operation_name} (attempt {attempt + 1}/{MAX_RETRIES}): {e}")
                # Only reconnect on first attempt or if circuit breaker is open
                # This prevents thundering herd of reconnection attempts
                if attempt == 0 or _circuit_breaker["state"] == "open":
                    try:
                        await force_reconnect()
                    except Exception as reconnect_err:
                        logger.error(f"Reconnect failed during retry: {reconnect_err}")
            else:
                logger.error(f"❌ Redis error on {operation_name} (attempt {attempt + 1}/{MAX_RETRIES}): {e}")
        
        if attempt < MAX_RETRIES - 1:
            backoff = RETRY_BACKOFF_BASE * (2 ** attempt)
            logger.info(f"🔄 Retrying {operation_name} in {backoff:.1f}s...")
            await asyncio.sleep(backoff)
    
    error_msg = f"Redis operation {operation_name} failed after {MAX_RETRIES} attempts"
    logger.error(f"❌ {error_msg}: {last_exception}")
    raise ConnectionError(f"{error_msg}: {last_exception}")


async def get_connection_info():
    try:
        redis_client = await get_client()
        
        pool_info = {}
        if pool:
            pool_info = {
                "max_connections": pool.max_connections,
                "created_connections": pool.created_connections if hasattr(pool, 'created_connections') else None,
            }
            if hasattr(pool, '_available_connections'):
                pool_info["available_connections"] = len(pool._available_connections)
            if hasattr(pool, '_in_use_connections'):
                pool_info["in_use_connections"] = len(pool._in_use_connections)
        
        info = await redis_client.info("clients")
        server_info = {
            "connected_clients": info.get("connected_clients", 0),
            "client_recent_max_input_buffer": info.get("client_recent_max_input_buffer", 0),
            "client_recent_max_output_buffer": info.get("client_recent_max_output_buffer", 0),
        }
        
        return {
            "pool": pool_info,
            "server": server_info,
        }
    except Exception as e:
        logger.error(f"Error getting Redis connection info: {e}")
        return {"error": str(e)}


class PubSubContextManager:
    def __init__(self, channels=None):
        self.channels = channels or []
        self.pubsub = None
    
    async def __aenter__(self):
        redis_client = await get_client()
        self.pubsub = redis_client.pubsub()
        if self.channels:
            await self.pubsub.subscribe(*self.channels)
        return self.pubsub
    
    async def __aexit__(self, exc_type, exc_val, exc_tb):
        if self.pubsub:
            try:
                if self.channels:
                    await self.pubsub.unsubscribe(*self.channels)
                await self.pubsub.close()
            except Exception as e:
                logger.warning(f"Error closing pubsub in context manager: {e}")
        return False


async def set(key: str, value: str, ex: int = None, nx: bool = False):
    async def _op():
        redis_client = await get_client()
        return await redis_client.set(key, value, ex=ex, nx=nx)
    return await _execute_with_retry(_op, f"SET {key}")


async def setex(key: str, seconds: int, value: str):
    async def _op():
        redis_client = await get_client()
        return await redis_client.setex(key, seconds, value)
    return await _execute_with_retry(_op, f"SETEX {key}")


async def get(key: str, default: str = None):
    async def _op():
        redis_client = await get_client()
        result = await redis_client.get(key)
        return result if result is not None else default
    return await _execute_with_retry(_op, f"GET {key}")


async def delete(key: str):
    async def _op():
        redis_client = await get_client()
        return await redis_client.delete(key)
    return await _execute_with_retry(_op, f"DELETE {key}")


async def publish(channel: str, message: str):
    async def _op():
        redis_client = await get_client()
        return await redis_client.publish(channel, message)
    return await _execute_with_retry(_op, f"PUBLISH {channel}")


def _get_streaming_semaphore() -> asyncio.Semaphore:
    """Get or create the streaming semaphore (lazy initialization)."""
    global _streaming_semaphore
    if _streaming_semaphore is None:
        _streaming_semaphore = asyncio.Semaphore(MAX_CONCURRENT_STREAMING_OPS)
    return _streaming_semaphore


async def publish_and_xadd(channel: str, message: str, stream_key: str, maxlen: int = None, approximate: bool = True):
    """Publish to a channel and add to a stream atomically.
    
    Uses a semaphore to limit concurrent operations and prevent pool exhaustion.
    """
    semaphore = _get_streaming_semaphore()
    
    async def _op():
        redis_client = await get_client()
        async with redis_client.pipeline() as pipe:
            pipe.publish(channel, message)
            kwargs = {}
            if maxlen is not None:
                kwargs['maxlen'] = maxlen
                kwargs['approximate'] = approximate
            pipe.xadd(stream_key, {'data': message}, **kwargs)
            results = await pipe.execute()
            return results
    
    # Use semaphore to limit concurrent streaming operations
    async with semaphore:
        return await _execute_with_retry(_op, f"PUBLISH+XADD {channel}")


async def create_pubsub():
    redis_client = await get_client()
    return redis_client.pubsub()


async def rpush(key: str, *values: Any):
    async def _op():
        redis_client = await get_client()
        return await redis_client.rpush(key, *values)
    return await _execute_with_retry(_op, f"RPUSH {key}")


async def lrange(key: str, start: int, end: int) -> List[str]:
    async def _op():
        redis_client = await get_client()
        return await redis_client.lrange(key, start, end)
    return await _execute_with_retry(_op, f"LRANGE {key}")


async def llen(key: str) -> int:
    async def _op():
        redis_client = await get_client()
        return await redis_client.llen(key)
    return await _execute_with_retry(_op, f"LLEN {key}")


async def keys(pattern: str) -> List[str]:
    async def _op():
        redis_client = await get_client()
        return await redis_client.keys(pattern)
    return await _execute_with_retry(_op, f"KEYS {pattern}")


async def scan_keys(pattern: str, count: int = 100) -> List[str]:
    async def _op():
        redis_client = await get_client()
        keys = []
        async for key in redis_client.scan_iter(match=pattern, count=count):
            keys.append(key)
        return keys
    return await _execute_with_retry(_op, f"SCAN {pattern}")


async def expire(key: str, seconds: int):
    async def _op():
        redis_client = await get_client()
        return await redis_client.expire(key, seconds)
    return await _execute_with_retry(_op, f"EXPIRE {key}")


async def ttl(key: str) -> int:
    async def _op():
        redis_client = await get_client()
        return await redis_client.ttl(key)
    return await _execute_with_retry(_op, f"TTL {key}")


async def zrangebyscore(key: str, min: str, max: str, start: int = None, num: int = None) -> List[str]:
    async def _op():
        redis_client = await get_client()
        if start is not None and num is not None:
            return await redis_client.zrangebyscore(key, min, max, start=start, num=num)
        return await redis_client.zrangebyscore(key, min, max)
    return await _execute_with_retry(_op, f"ZRANGEBYSCORE {key}")


async def zscore(key: str, member: str) -> Optional[float]:
    async def _op():
        redis_client = await get_client()
        return await redis_client.zscore(key, member)
    return await _execute_with_retry(_op, f"ZSCORE {key}")


async def scard(key: str) -> int:
    async def _op():
        redis_client = await get_client()
        return await redis_client.scard(key)
    return await _execute_with_retry(_op, f"SCARD {key}")


async def incr(key: str):
    async def _op():
        redis_client = await get_client()
        return await redis_client.incr(key)
    return await _execute_with_retry(_op, f"INCR {key}")


async def decr(key: str):
    async def _op():
        redis_client = await get_client()
        return await redis_client.decr(key)
    return await _execute_with_retry(_op, f"DECR {key}")


async def xadd(stream_key: str, fields: dict, maxlen: int = None, approximate: bool = True) -> str:
    async def _op():
        redis_client = await get_client()
        kwargs = {}
        if maxlen is not None:
            kwargs['maxlen'] = maxlen
            kwargs['approximate'] = approximate
        return await redis_client.xadd(stream_key, fields, **kwargs)
    return await _execute_with_retry(_op, f"XADD {stream_key}")


async def xread(streams: dict, count: int = None, block: int = None) -> list:
    async def _op():
        redis_client = await get_client()
        return await redis_client.xread(streams, count=count, block=block)
    return await _execute_with_retry(_op, f"XREAD")


async def xrange(stream_key: str, start: str = '-', end: str = '+', count: int = None) -> list:
    async def _op():
        redis_client = await get_client()
        return await redis_client.xrange(stream_key, start, end, count=count)
    return await _execute_with_retry(_op, f"XRANGE {stream_key}")


async def xlen(stream_key: str) -> int:
    async def _op():
        redis_client = await get_client()
        return await redis_client.xlen(stream_key)
    return await _execute_with_retry(_op, f"XLEN {stream_key}")


async def xtrim(stream_key: str, maxlen: int, approximate: bool = True) -> int:
    async def _op():
        redis_client = await get_client()
        return await redis_client.xtrim(stream_key, maxlen=maxlen, approximate=approximate)
    return await _execute_with_retry(_op, f"XTRIM {stream_key}")


async def xtrim_minid(stream_key: str, minid: str, approximate: bool = True) -> int:
    async def _op():
        redis_client = await get_client()
        return await redis_client.xtrim(stream_key, minid=minid, approximate=approximate)
    return await _execute_with_retry(_op, f"XTRIM {stream_key} MINID")
