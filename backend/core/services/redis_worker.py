import redis.asyncio as redis_lib
from redis.exceptions import ConnectionError as RedisConnectionError, TimeoutError as RedisTimeoutError
import os
import time as _time
from dotenv import load_dotenv
import asyncio
from core.utils.logger import logger
from typing import List, Any, Optional
from core.utils.retry import retry

from core.services.redis import get_redis_config

client: Optional[redis_lib.Redis] = None
pool: Optional[redis_lib.ConnectionPool] = None
_initialized = False
_init_lock = asyncio.Lock()
_reconnect_lock = asyncio.Lock()

_operation_semaphore: Optional[asyncio.Semaphore] = None

REDIS_KEY_TTL = 3600 * 24

DEFAULT_MAX_CONCURRENT_OPS = 100
DEFAULT_MAX_CONNECTIONS = DEFAULT_MAX_CONCURRENT_OPS + 50

MAX_RETRIES = int(os.getenv("REDIS_MAX_RETRIES", "3"))
RETRY_BACKOFF_BASE = 0.5

_circuit_breaker = {
    "failures": 0,
    "last_failure": 0.0,
    "state": "closed",
}
CIRCUIT_BREAKER_THRESHOLD = 5
CIRCUIT_BREAKER_TIMEOUT = 30.0


def initialize():
    global client, pool, _operation_semaphore

    load_dotenv()
    config = get_redis_config()
    
    max_concurrent_ops = int(os.getenv("REDIS_WORKER_MAX_CONCURRENT_OPS", str(DEFAULT_MAX_CONCURRENT_OPS)))
    default_pool_size = max_concurrent_ops + 20
    max_connections = int(os.getenv("REDIS_WORKER_MAX_CONNECTIONS", str(default_pool_size)))
    
    socket_timeout = 5.0
    connect_timeout = 3.0
    retry_on_timeout = os.getenv("REDIS_RETRY_ON_TIMEOUT", "false").lower() == "true"

    auth_info = f"user={config['username']} " if config['username'] else ""
    ssl_info = "(SSL) " if config['ssl'] else ""
    logger.info(
        f"Initializing WORKER Redis pool to {config['host']}:{config['port']} "
        f"{auth_info}{ssl_info}with max {max_connections} connections, "
        f"{max_concurrent_ops} concurrent operations"
    )

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
    
    _operation_semaphore = asyncio.Semaphore(max_concurrent_ops)

    return client


async def initialize_async():
    global client, _initialized

    async with _init_lock:
        if not _initialized or client is None:
            initialize()

        try:
            await asyncio.wait_for(client.ping(), timeout=5.0)
            logger.info("Successfully connected to WORKER Redis")
            _initialized = True
        except asyncio.TimeoutError:
            logger.error("WORKER Redis connection timeout during initialization")
            client = None
            _initialized = False
            raise ConnectionError("Redis connection timeout")
        except Exception as e:
            logger.error(f"Failed to connect to WORKER Redis: {e}")
            client = None
            _initialized = False
            raise

    return client


async def close():
    global client, pool, _initialized, _operation_semaphore
    if client:
        try:
            await asyncio.wait_for(client.aclose(), timeout=5.0)
        except asyncio.TimeoutError:
            logger.warning("WORKER Redis close timeout, forcing close")
        except Exception as e:
            logger.warning(f"Error closing WORKER Redis client: {e}")
        finally:
            client = None
    
    if pool:
        try:
            await asyncio.wait_for(pool.aclose(), timeout=5.0)
        except asyncio.TimeoutError:
            logger.warning("WORKER Redis pool close timeout, forcing close")
        except Exception as e:
            logger.warning(f"Error closing WORKER Redis pool: {e}")
        finally:
            pool = None
    
    _operation_semaphore = None
    _initialized = False
    logger.info("WORKER Redis connection and pool closed")


async def get_client():
    global client, _initialized
    if client is None or not _initialized:
        await retry(lambda: initialize_async())
    return client


async def force_reconnect():
    global client, pool, _initialized, _circuit_breaker
    
    async with _reconnect_lock:
        logger.warning("🔄 Forcing Redis reconnection...")
        
        if client:
            try:
                await asyncio.wait_for(client.aclose(), timeout=2.0)
            except Exception:
                pass
            client = None
        
        if pool:
            try:
                await asyncio.wait_for(pool.aclose(), timeout=2.0)
            except Exception:
                pass
            pool = None
        
        _initialized = False
        
        try:
            await initialize_async()
            _circuit_breaker["state"] = "closed"
            _circuit_breaker["failures"] = 0
            logger.info("✅ Redis reconnection successful, circuit breaker reset")
            return True
        except Exception as e:
            logger.error(f"❌ Redis reconnection failed: {e}")
            raise


def _is_connection_error(exc: Exception) -> bool:
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
            coro = op_factory()
            
            if _operation_semaphore is None:
                result = await asyncio.wait_for(coro, timeout=10.0)
            else:
                async with _operation_semaphore:
                    result = await asyncio.wait_for(coro, timeout=10.0)
            
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
            _record_failure()
            
            if _is_connection_error(e):
                logger.warning(f"⚠️ Redis connection error on {operation_name} (attempt {attempt + 1}/{MAX_RETRIES}): {e}")
                if attempt < MAX_RETRIES - 1:
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


async def _with_concurrency_limit(coro, allow_circuit_break: bool = True):
    if allow_circuit_break and not _check_circuit_breaker():
        raise RedisCircuitOpenError("Redis circuit breaker is open")
    
    if _operation_semaphore is None:
        try:
            result = await coro
            _record_success()
            return result
        except Exception:
            _record_failure()
            raise
    
    async with _operation_semaphore:
        try:
            result = await coro
            _record_success()
            return result
        except Exception:
            _record_failure()
            raise


async def set(key: str, value: str, ex: int = None, nx: bool = False):
    def _op():
        async def _inner():
            redis_client = await get_client()
            return await redis_client.set(key, value, ex=ex, nx=nx)
        return _inner()
    return await _execute_with_retry(_op, f"SET {key}")


async def get(key: str, default: str = None):
    def _op():
        async def _inner():
            redis_client = await get_client()
            result = await redis_client.get(key)
            return result if result is not None else default
        return _inner()
    return await _execute_with_retry(_op, f"GET {key}")


async def delete(key: str):
    def _op():
        async def _inner():
            redis_client = await get_client()
            return await redis_client.delete(key)
        return _inner()
    return await _execute_with_retry(_op, f"DELETE {key}")


async def publish(channel: str, message: str):
    def _op():
        async def _inner():
            redis_client = await get_client()
            return await redis_client.publish(channel, message)
        return _inner()
    return await _execute_with_retry(_op, f"PUBLISH {channel}")


async def create_pubsub():
    last_exception = None
    for attempt in range(MAX_RETRIES):
        try:
            redis_client = await get_client()
            pubsub = redis_client.pubsub()
            _record_success()
            return pubsub
        except Exception as e:
            last_exception = e
            _record_failure()
            if _is_connection_error(e) and attempt < MAX_RETRIES - 1:
                logger.warning(f"⚠️ Redis pubsub creation failed (attempt {attempt + 1}/{MAX_RETRIES}): {e}")
                try:
                    await force_reconnect()
                except Exception:
                    pass
                await asyncio.sleep(RETRY_BACKOFF_BASE * (2 ** attempt))
            else:
                raise
    raise ConnectionError(f"Redis pubsub creation failed after {MAX_RETRIES} attempts: {last_exception}")


async def rpush(key: str, *values: Any):
    def _op():
        async def _inner():
            redis_client = await get_client()
            return await redis_client.rpush(key, *values)
        return _inner()
    return await _execute_with_retry(_op, f"RPUSH {key}")


async def lrange(key: str, start: int, end: int) -> List[str]:
    def _op():
        async def _inner():
            redis_client = await get_client()
            return await redis_client.lrange(key, start, end)
        return _inner()
    return await _execute_with_retry(_op, f"LRANGE {key}")


async def keys(pattern: str) -> List[str]:
    def _op():
        async def _inner():
            redis_client = await get_client()
            return await redis_client.keys(pattern)
        return _inner()
    return await _execute_with_retry(_op, f"KEYS {pattern}")


async def expire(key: str, seconds: int):
    def _op():
        async def _inner():
            redis_client = await get_client()
            return await redis_client.expire(key, seconds)
        return _inner()
    return await _execute_with_retry(_op, f"EXPIRE {key}")


async def batch_publish(channel: str, messages: List[str]):
    def _op():
        async def _inner():
            redis_client = await get_client()
            async with redis_client.pipeline() as pipe:
                for msg in messages:
                    pipe.publish(channel, msg)
                return await pipe.execute()
        return _inner()
    return await _execute_with_retry(_op, f"BATCH_PUBLISH {channel}")


async def batch_rpush(key: str, values: List[str]):
    def _op():
        async def _inner():
            redis_client = await get_client()
            async with redis_client.pipeline() as pipe:
                for value in values:
                    pipe.rpush(key, value)
                return await pipe.execute()
        return _inner()
    return await _execute_with_retry(_op, f"BATCH_RPUSH {key}")


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
        
        semaphore_info = {}
        if _operation_semaphore:
            semaphore_info = {
                "max_concurrent": _operation_semaphore._value if hasattr(_operation_semaphore, '_value') else None,
            }
        
        return {
            "pool": pool_info,
            "server": server_info,
            "semaphore": semaphore_info,
        }
    except Exception as e:
        logger.error(f"Error getting WORKER Redis connection info: {e}")
        return {"error": str(e)}

async def xadd(stream_key: str, fields: dict, maxlen: int = None, approximate: bool = True) -> str:
    def _op():
        async def _inner():
            redis_client = await get_client()
            kwargs = {}
            if maxlen is not None:
                kwargs['maxlen'] = maxlen
                kwargs['approximate'] = approximate
            return await redis_client.xadd(stream_key, fields, **kwargs)
        return _inner()
    return await _execute_with_retry(_op, f"XADD {stream_key}")


async def xread(streams: dict, count: int = None, block: int = None) -> list:
    def _op():
        async def _inner():
            redis_client = await get_client()
            return await redis_client.xread(streams, count=count, block=block)
        return _inner()
    return await _execute_with_retry(_op, f"XREAD")


async def xrange(stream_key: str, start: str = '-', end: str = '+', count: int = None) -> list:
    def _op():
        async def _inner():
            redis_client = await get_client()
            return await redis_client.xrange(stream_key, start, end, count=count)
        return _inner()
    return await _execute_with_retry(_op, f"XRANGE {stream_key}")


async def xlen(stream_key: str) -> int:
    def _op():
        async def _inner():
            redis_client = await get_client()
            return await redis_client.xlen(stream_key)
        return _inner()
    return await _execute_with_retry(_op, f"XLEN {stream_key}")


async def xtrim(stream_key: str, maxlen: int, approximate: bool = True) -> int:
    def _op():
        async def _inner():
            redis_client = await get_client()
            return await redis_client.xtrim(stream_key, maxlen=maxlen, approximate=approximate)
        return _inner()
    return await _execute_with_retry(_op, f"XTRIM {stream_key}")


async def xtrim_minid(stream_key: str, minid: str, approximate: bool = True) -> int:
    """
    Trim stream entries older than the given minimum ID.
    
    Args:
        stream_key: The Redis stream key
        minid: Minimum entry ID to keep (entries with ID < minid will be removed)
        approximate: Use approximate trimming for better performance
    
    Returns:
        Number of entries removed
    """
    def _op():
        async def _inner():
            redis_client = await get_client()
            return await redis_client.xtrim(stream_key, minid=minid, approximate=approximate)
        return _inner()
    return await _execute_with_retry(_op, f"XTRIM {stream_key} MINID")