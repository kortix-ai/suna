"""
Worker-optimized Redis connection management.

This module provides Redis connection management specifically optimized for
Dramatiq worker processes that handle high-throughput agent runs.

Key differences from redis.py:
- Higher connection pool size (optimized for worker load)
- Concurrency limiting via semaphore
- Batch operation support
- Optimized for pubsub + publish patterns
"""
import redis.asyncio as redis_lib
import os
from dotenv import load_dotenv
import asyncio
from core.utils.logger import logger
from typing import List, Any, Optional
from core.utils.retry import retry

# Import get_redis_config from base redis module to share config
from core.services.redis import get_redis_config

# Redis client and connection pool
client: Optional[redis_lib.Redis] = None
pool: Optional[redis_lib.ConnectionPool] = None
_initialized = False
_init_lock = asyncio.Lock()

# Concurrency limiting for Redis operations
# Limits concurrent operations to prevent connection pool exhaustion
_operation_semaphore: Optional[asyncio.Semaphore] = None

# Constants
REDIS_KEY_TTL = 3600 * 24  # 24 hour TTL as safety mechanism

# Worker-specific defaults
# KEY INSIGHT: Semaphore prevents exhaustion, pool size just needs to be >= semaphore limit
# 
# Why limits?
# - Semaphore: Prevents concurrent operation explosion (ESSENTIAL - this solves the problem!)
# - Pool size: Prevents connection waste, ensures efficient reuse (nice to have)
#
# Defaults are conservative - adjust based on actual load:
DEFAULT_MAX_CONCURRENT_OPS = 100  # Semaphore limit (prevents exhaustion - THIS IS THE KEY!)
DEFAULT_MAX_CONNECTIONS = DEFAULT_MAX_CONCURRENT_OPS + 50  # Generous: 100 + 50 overhead = 150


# get_redis_config is imported above from core.services.redis


def initialize():
    """Initialize Redis connection pool optimized for worker processes."""
    global client, pool, _operation_semaphore

    load_dotenv()
    config = get_redis_config()
    
    # Worker-optimized connection pool settings
    # Pool size should match semaphore limit + overhead (pubsub, etc.)
    max_concurrent_ops = int(os.getenv("REDIS_WORKER_MAX_CONCURRENT_OPS", str(DEFAULT_MAX_CONCURRENT_OPS)))
    # Calculate pool size: semaphore limit + overhead for pubsub connections
    default_pool_size = max_concurrent_ops + 20
    max_connections = int(os.getenv("REDIS_WORKER_MAX_CONNECTIONS", str(default_pool_size)))
    
    socket_timeout = 15.0
    connect_timeout = 10.0
    retry_on_timeout = not (os.getenv("REDIS_RETRY_ON_TIMEOUT", "True").lower() != "true")

    auth_info = f"user={config['username']} " if config['username'] else ""
    logger.info(
        f"Initializing WORKER Redis pool to {config['host']}:{config['port']} "
        f"{auth_info}with max {max_connections} connections, "
        f"{max_concurrent_ops} concurrent operations"
    )

    # Create connection pool optimized for high-throughput worker operations
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
    
    # Initialize semaphore for concurrency limiting
    _operation_semaphore = asyncio.Semaphore(max_concurrent_ops)

    return client


async def initialize_async():
    """Initialize Redis connection asynchronously."""
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
    """Close Redis connection and connection pool."""
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
    """Get the Redis client, initializing if necessary."""
    global client, _initialized
    if client is None or not _initialized:
        await retry(lambda: initialize_async())
    return client


async def _with_concurrency_limit(coro):
    """Execute a Redis operation with concurrency limiting."""
    if _operation_semaphore is None:
        # Fallback if semaphore not initialized
        return await coro
    async with _operation_semaphore:
        return await coro


# Basic Redis operations with concurrency limiting
async def set(key: str, value: str, ex: int = None, nx: bool = False):
    """Set a Redis key."""
    async def _op():
        redis_client = await get_client()
        return await redis_client.set(key, value, ex=ex, nx=nx)
    return await _with_concurrency_limit(_op())


async def get(key: str, default: str = None):
    """Get a Redis key."""
    async def _op():
        redis_client = await get_client()
        result = await redis_client.get(key)
        return result if result is not None else default
    return await _with_concurrency_limit(_op())


async def delete(key: str):
    """Delete a Redis key."""
    async def _op():
        redis_client = await get_client()
        return await redis_client.delete(key)
    return await _with_concurrency_limit(_op())


async def publish(channel: str, message: str):
    """Publish a message to a Redis channel with concurrency limiting."""
    async def _op():
        redis_client = await get_client()
        return await redis_client.publish(channel, message)
    return await _with_concurrency_limit(_op())


async def create_pubsub():
    """Create a Redis pubsub object."""
    redis_client = await get_client()
    return redis_client.pubsub()


# List operations
async def rpush(key: str, *values: Any):
    """Append one or more values to a list with concurrency limiting."""
    async def _op():
        redis_client = await get_client()
        return await redis_client.rpush(key, *values)
    return await _with_concurrency_limit(_op())


async def lrange(key: str, start: int, end: int) -> List[str]:
    """Get a range of elements from a list."""
    async def _op():
        redis_client = await get_client()
        return await redis_client.lrange(key, start, end)
    return await _with_concurrency_limit(_op())


async def keys(pattern: str) -> List[str]:
    """Get keys matching a pattern."""
    async def _op():
        redis_client = await get_client()
        return await redis_client.keys(pattern)
    return await _with_concurrency_limit(_op())


async def expire(key: str, seconds: int):
    """Set expiration on a key."""
    async def _op():
        redis_client = await get_client()
        return await redis_client.expire(key, seconds)
    return await _with_concurrency_limit(_op())


async def batch_publish(channel: str, messages: List[str]):
    """Publish multiple messages efficiently using pipeline."""
    async def _op():
        redis_client = await get_client()
        async with redis_client.pipeline() as pipe:
            for msg in messages:
                pipe.publish(channel, msg)
            return await pipe.execute()
    return await _with_concurrency_limit(_op())


async def batch_rpush(key: str, values: List[str]):
    """Push multiple values efficiently using pipeline."""
    async def _op():
        redis_client = await get_client()
        async with redis_client.pipeline() as pipe:
            for value in values:
                pipe.rpush(key, value)
            return await pipe.execute()
    return await _with_concurrency_limit(_op())


async def get_connection_info():
    """Get diagnostic information about Redis connections."""
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

