import redis.asyncio as redis
import os
from dotenv import load_dotenv
import asyncio
from core.utils.logger import logger
from typing import List, Any
from core.utils.retry import retry

# Redis clients and connection pools
# GENERAL pool: for fast non-blocking ops (GET, SET, RPUSH, LRANGE, PUBLISH, etc.)
# BLOCKING pool: for long-lived blocking ops (PUBSUB subscribe/listen)
# This separation prevents pubsub from starving general operations
client: redis.Redis | None = None
pool: redis.ConnectionPool | None = None
blocking_client: redis.Redis | None = None
blocking_pool: redis.ConnectionPool | None = None
_initialized = False
_init_lock = asyncio.Lock()

# Constants
REDIS_KEY_TTL = 3600 * 24  # 24 hour TTL as safety mechanism


def initialize():
    """Initialize Redis connection pools and clients using environment variables."""
    global client, pool, blocking_client, blocking_pool

    # Load environment variables if not already loaded
    load_dotenv()

    # Get Redis configuration
    redis_host = os.getenv("REDIS_HOST", "redis")
    redis_port = int(os.getenv("REDIS_PORT", 6379))
    redis_password = os.getenv("REDIS_PASSWORD", "")

    # Connection pool configuration - optimized for production
    # GENERAL pool: for fast ops (GET/SET/RPUSH/LRANGE/PUBLISH)
    general_max_connections = 128
    # BLOCKING pool: for pubsub (isolated to prevent starvation)
    blocking_max_connections = 256

    socket_timeout = 15.0            # 15 seconds socket timeout
    connect_timeout = 10.0           # 10 seconds connection timeout
    retry_on_timeout = not (os.getenv("REDIS_RETRY_ON_TIMEOUT", "True").lower() != "true")

    # Pool acquisition timeouts - fail fast if pool exhausted
    general_pool_timeout = 0.5       # Fast ops should fail fast if no connections
    blocking_pool_timeout = 5.0      # Blocking ops can wait longer

    logger.info(f"Initializing Redis connection pools to {redis_host}:{redis_port}")
    logger.info(f"  General pool: max_connections={general_max_connections}, timeout={general_pool_timeout}s")
    logger.info(f"  Blocking pool: max_connections={blocking_max_connections}, timeout={blocking_pool_timeout}s")

    # GENERAL pool - for fast non-blocking operations
    # Uses BlockingConnectionPool with short timeout for fail-fast behavior
    pool = redis.BlockingConnectionPool(
        host=redis_host,
        port=redis_port,
        password=redis_password,
        decode_responses=True,
        socket_timeout=socket_timeout,
        socket_connect_timeout=connect_timeout,
        socket_keepalive=True,
        retry_on_timeout=retry_on_timeout,
        health_check_interval=30,
        max_connections=general_max_connections,
        timeout=general_pool_timeout,  # Wait max 0.5s for pool connection
    )
    client = redis.Redis(connection_pool=pool)

    # BLOCKING pool - for pubsub (subscribe/listen) operations
    # Isolated from general pool to prevent blocking ops from starving GET/SET
    # Uses BlockingConnectionPool with longer timeout since pubsub is long-lived
    blocking_pool = redis.BlockingConnectionPool(
        host=redis_host,
        port=redis_port,
        password=redis_password,
        decode_responses=True,
        socket_timeout=socket_timeout,
        socket_connect_timeout=connect_timeout,
        socket_keepalive=True,
        retry_on_timeout=retry_on_timeout,
        health_check_interval=30,
        max_connections=blocking_max_connections,
        timeout=blocking_pool_timeout,  # Wait max 5s for pool connection
    )
    blocking_client = redis.Redis(connection_pool=blocking_pool)

    return client


async def initialize_async():
    """Initialize Redis connections asynchronously."""
    global client, blocking_client, _initialized

    async with _init_lock:
        if not _initialized:
            initialize()

        try:
            # Test both connections with timeout
            await asyncio.wait_for(client.ping(), timeout=5.0)
            await asyncio.wait_for(blocking_client.ping(), timeout=5.0)
            logger.info("Successfully connected to Redis (both pools)")
            _initialized = True
        except asyncio.TimeoutError:
            logger.error("Redis connection timeout during initialization")
            client = None
            blocking_client = None
            _initialized = False
            raise ConnectionError("Redis connection timeout")
        except Exception as e:
            logger.error(f"Failed to connect to Redis: {e}")
            client = None
            blocking_client = None
            _initialized = False
            raise

    return client


async def close():
    """Close Redis connections and connection pools."""
    global client, pool, blocking_client, blocking_pool, _initialized

    # Close general client and pool
    if client:
        try:
            await asyncio.wait_for(client.aclose(), timeout=5.0)
        except asyncio.TimeoutError:
            logger.warning("Redis general client close timeout")
        except Exception as e:
            logger.warning(f"Error closing Redis general client: {e}")
        finally:
            client = None

    if pool:
        try:
            await asyncio.wait_for(pool.aclose(), timeout=5.0)
        except asyncio.TimeoutError:
            logger.warning("Redis general pool close timeout")
        except Exception as e:
            logger.warning(f"Error closing Redis general pool: {e}")
        finally:
            pool = None

    # Close blocking client and pool
    if blocking_client:
        try:
            await asyncio.wait_for(blocking_client.aclose(), timeout=5.0)
        except asyncio.TimeoutError:
            logger.warning("Redis blocking client close timeout")
        except Exception as e:
            logger.warning(f"Error closing Redis blocking client: {e}")
        finally:
            blocking_client = None

    if blocking_pool:
        try:
            await asyncio.wait_for(blocking_pool.aclose(), timeout=5.0)
        except asyncio.TimeoutError:
            logger.warning("Redis blocking pool close timeout")
        except Exception as e:
            logger.warning(f"Error closing Redis blocking pool: {e}")
        finally:
            blocking_pool = None

    _initialized = False
    logger.info("Redis connections and pools closed")


async def get_client():
    """Get the general Redis client, initializing if necessary."""
    global client, _initialized
    if client is None or not _initialized:
        await retry(lambda: initialize_async())
    return client


async def get_blocking_client():
    """Get the blocking Redis client (for pubsub), initializing if necessary."""
    global blocking_client, _initialized
    if blocking_client is None or not _initialized:
        await retry(lambda: initialize_async())
    return blocking_client


# Basic Redis operations
async def set(key: str, value: str, ex: int = None, nx: bool = False):
    """Set a Redis key."""
    redis_client = await get_client()
    return await redis_client.set(key, value, ex=ex, nx=nx)


async def get(key: str, default: str = None):
    """Get a Redis key."""
    redis_client = await get_client()
    result = await redis_client.get(key)
    return result if result is not None else default


async def delete(key: str):
    """Delete a Redis key."""
    redis_client = await get_client()
    return await redis_client.delete(key)


async def publish(channel: str, message: str):
    """Publish a message to a Redis channel."""
    redis_client = await get_client()
    return await redis_client.publish(channel, message)


async def create_pubsub():
    """Create a Redis pubsub object using the blocking pool.

    Pubsub operations (subscribe, listen, get_message) hold connections for
    extended periods. Using a separate blocking pool prevents these from
    starving fast operations (GET, SET, RPUSH, etc.) on the general pool.
    """
    redis_client = await get_blocking_client()
    return redis_client.pubsub()


# List operations
async def rpush(key: str, *values: Any):
    """Append one or more values to a list."""
    redis_client = await get_client()
    return await redis_client.rpush(key, *values)


async def lrange(key: str, start: int, end: int) -> List[str]:
    """Get a range of elements from a list."""
    redis_client = await get_client()
    return await redis_client.lrange(key, start, end)


# Key management


async def keys(pattern: str) -> List[str]:
    redis_client = await get_client()
    return await redis_client.keys(pattern)


async def expire(key: str, seconds: int):
    redis_client = await get_client()
    return await redis_client.expire(key, seconds)
