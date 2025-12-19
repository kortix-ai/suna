import redis.asyncio as redis_lib
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

_operation_semaphore: Optional[asyncio.Semaphore] = None

REDIS_KEY_TTL = 3600 * 24

DEFAULT_MAX_CONCURRENT_OPS = 100
DEFAULT_MAX_CONNECTIONS = DEFAULT_MAX_CONCURRENT_OPS + 50

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
    logger.info(
        f"Initializing WORKER Redis pool to {config['host']}:{config['port']} "
        f"{auth_info}with max {max_connections} connections, "
        f"{max_concurrent_ops} concurrent operations"
    )

    pool_kwargs = {
        "host": config["host"],
        "port": config["port"],
        "password": config["password"],
        "decode_responses": True,
        "socket_timeout": socket_timeout,
        "socket_connect_timeout": connect_timeout,
        "socket_keepalive": True,
        "retry_on_timeout": retry_on_timeout,
        "health_check_interval": 30,
        "max_connections": max_connections,
    }
    
    if config["username"]:
        pool_kwargs["username"] = config["username"]
    
    pool = redis_lib.ConnectionPool(**pool_kwargs)
    client = redis_lib.Redis(connection_pool=pool)
    
    _operation_semaphore = asyncio.Semaphore(max_concurrent_ops)

    return client


async def initialize_async():
    global client, _initialized

    async with _init_lock:
        if not _initialized:
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
    async def _op():
        redis_client = await get_client()
        return await redis_client.set(key, value, ex=ex, nx=nx)
    return await _with_concurrency_limit(_op())


async def get(key: str, default: str = None):
    async def _op():
        redis_client = await get_client()
        result = await redis_client.get(key)
        return result if result is not None else default
    return await _with_concurrency_limit(_op())


async def delete(key: str):
    async def _op():
        redis_client = await get_client()
        return await redis_client.delete(key)
    return await _with_concurrency_limit(_op())


async def publish(channel: str, message: str):
    async def _op():
        redis_client = await get_client()
        return await redis_client.publish(channel, message)
    return await _with_concurrency_limit(_op())


async def create_pubsub():
    redis_client = await get_client()
    return redis_client.pubsub()


async def rpush(key: str, *values: Any):
    async def _op():
        redis_client = await get_client()
        return await redis_client.rpush(key, *values)
    return await _with_concurrency_limit(_op())


async def lrange(key: str, start: int, end: int) -> List[str]:
    async def _op():
        redis_client = await get_client()
        return await redis_client.lrange(key, start, end)
    return await _with_concurrency_limit(_op())


async def keys(pattern: str) -> List[str]:
    async def _op():
        redis_client = await get_client()
        return await redis_client.keys(pattern)
    return await _with_concurrency_limit(_op())


async def expire(key: str, seconds: int):
    async def _op():
        redis_client = await get_client()
        return await redis_client.expire(key, seconds)
    return await _with_concurrency_limit(_op())


async def batch_publish(channel: str, messages: List[str]):
    async def _op():
        redis_client = await get_client()
        async with redis_client.pipeline() as pipe:
            for msg in messages:
                pipe.publish(channel, msg)
            return await pipe.execute()
    return await _with_concurrency_limit(_op())


async def batch_rpush(key: str, values: List[str]):
    async def _op():
        redis_client = await get_client()
        async with redis_client.pipeline() as pipe:
            for value in values:
                pipe.rpush(key, value)
            return await pipe.execute()
    return await _with_concurrency_limit(_op())


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
    async def _op():
        redis_client = await get_client()
        kwargs = {}
        if maxlen is not None:
            kwargs['maxlen'] = maxlen
            kwargs['approximate'] = approximate
        return await redis_client.xadd(stream_key, fields, **kwargs)
    return await _with_concurrency_limit(_op())


async def xread(streams: dict, count: int = None, block: int = None) -> list:
    async def _op():
        redis_client = await get_client()
        return await redis_client.xread(streams, count=count, block=block)
    return await _with_concurrency_limit(_op())


async def xrange(stream_key: str, start: str = '-', end: str = '+', count: int = None) -> list:
    async def _op():
        redis_client = await get_client()
        return await redis_client.xrange(stream_key, start, end, count=count)
    return await _with_concurrency_limit(_op())


async def xlen(stream_key: str) -> int:
    async def _op():
        redis_client = await get_client()
        return await redis_client.xlen(stream_key)
    return await _with_concurrency_limit(_op())


async def xtrim(stream_key: str, maxlen: int, approximate: bool = True) -> int:
    async def _op():
        redis_client = await get_client()
        return await redis_client.xtrim(stream_key, maxlen=maxlen, approximate=approximate)
    return await _with_concurrency_limit(_op())
