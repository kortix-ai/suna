import redis.asyncio as redis
import os
from dotenv import load_dotenv
import asyncio
from core.utils.logger import logger
from typing import List, Any
from core.utils.retry import retry

# Redis client and connection pool
client: redis.Redis | None = None
pool: redis.ConnectionPool | None = None
_initialized = False
_init_lock = asyncio.Lock()

# Constants
REDIS_KEY_TTL = 3600 * 24  # 24 hour TTL as safety mechanism


def get_redis_config():
    """Get Redis configuration from environment variables.
    
    Returns:
        dict: Dictionary with host, port, password, username, and url keys
    """
    load_dotenv()
    
    redis_host = os.getenv("REDIS_HOST", "redis")
    redis_port = int(os.getenv("REDIS_PORT", 6379))
    redis_password = os.getenv("REDIS_PASSWORD", "")
    redis_username = os.getenv("REDIS_USERNAME", None)
    
    # Build Redis URL for clients that support it (like Dramatiq)
    if redis_username and redis_password:
        redis_url = f"redis://{redis_username}:{redis_password}@{redis_host}:{redis_port}"
    elif redis_password:
        redis_url = f"redis://:{redis_password}@{redis_host}:{redis_port}"
    else:
        redis_url = None
    
    return {
        "host": redis_host,
        "port": redis_port,
        "password": redis_password,
        "username": redis_username,
        "url": redis_url,
    }


def initialize():
    """Initialize Redis connection pool and client using environment variables."""
    global client, pool

    # Load environment variables if not already loaded
    load_dotenv()

    # Get Redis configuration
    config = get_redis_config()
    redis_host = config["host"]
    redis_port = config["port"]
    redis_password = config["password"]
    redis_username = config["username"]
    
    # Connection pool configuration - optimized for API (light usage)
    # API typically has < 20 concurrent Redis operations
    # Default is generous - Redis will handle rejection if we exceed server limits
    max_connections = int(os.getenv("REDIS_MAX_CONNECTIONS", "100"))
    socket_timeout = 15.0            # 15 seconds socket timeout
    connect_timeout = 10.0           # 10 seconds connection timeout
    retry_on_timeout = not (os.getenv("REDIS_RETRY_ON_TIMEOUT", "True").lower() != "true")

    auth_info = f"user={redis_username} " if redis_username else ""
    logger.info(f"Initializing Redis connection pool to {redis_host}:{redis_port} {auth_info}with max {max_connections} connections")

    # Create connection pool with production-optimized settings
    pool_kwargs = {
        "host": redis_host,
        "port": redis_port,
        "password": redis_password,
        "decode_responses": True,
        "socket_timeout": socket_timeout,
        "socket_connect_timeout": connect_timeout,
        "socket_keepalive": True,
        "retry_on_timeout": retry_on_timeout,
        "health_check_interval": 30,
        "max_connections": max_connections,
    }
    
    # Add username if provided (required for Redis Cloud)
    if redis_username:
        pool_kwargs["username"] = redis_username
    
    pool = redis.ConnectionPool(**pool_kwargs)

    # Create Redis client from connection pool
    client = redis.Redis(connection_pool=pool)

    return client


async def initialize_async():
    """Initialize Redis connection asynchronously."""
    global client, _initialized

    async with _init_lock:
        if not _initialized:
            # logger.debug("Initializing Redis connection")
            initialize()

        try:
            # Test connection with timeout
            await asyncio.wait_for(client.ping(), timeout=5.0)
            logger.info("Successfully connected to Redis")
            _initialized = True
        except asyncio.TimeoutError:
            logger.error("Redis connection timeout during initialization")
            client = None
            _initialized = False
            raise ConnectionError("Redis connection timeout")
        except Exception as e:
            logger.error(f"Failed to connect to Redis: {e}")
            client = None
            _initialized = False
            raise

    return client


async def close():
    """Close Redis connection and connection pool."""
    global client, pool, _initialized
    if client:
        # logger.debug("Closing Redis connection")
        try:
            await asyncio.wait_for(client.aclose(), timeout=5.0)
        except asyncio.TimeoutError:
            logger.warning("Redis close timeout, forcing close")
        except Exception as e:
            logger.warning(f"Error closing Redis client: {e}")
        finally:
            client = None
    
    if pool:
        # logger.debug("Closing Redis connection pool")
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
    """Get the Redis client, initializing if necessary."""
    global client, _initialized
    if client is None or not _initialized:
        await retry(lambda: initialize_async())
    return client


async def get_connection_info():
    """Get diagnostic information about Redis connections.
    
    Returns:
        dict: Dictionary with connection pool stats and Redis server info
    """
    try:
        redis_client = await get_client()
        
        # Get connection pool stats
        pool_info = {}
        if pool:
            pool_info = {
                "max_connections": pool.max_connections,
                "created_connections": pool.created_connections if hasattr(pool, 'created_connections') else None,
            }
        
        # Get Redis server info about clients
        info = await redis_client.info("clients")
        server_info = {
            "connected_clients": info.get("connected_clients", 0),
            "client_recent_max_input_buffer": info.get("client_recent_max_input_buffer", 0),
            "client_recent_max_output_buffer": info.get("client_recent_max_output_buffer", 0),
        }
        
        # Get current connection count from pool if available
        if pool and hasattr(pool, '_available_connections'):
            pool_info["available_connections"] = len(pool._available_connections)
        if pool and hasattr(pool, '_in_use_connections'):
            pool_info["in_use_connections"] = len(pool._in_use_connections)
        
        return {
            "pool": pool_info,
            "server": server_info,
        }
    except Exception as e:
        logger.error(f"Error getting Redis connection info: {e}")
        return {"error": str(e)}


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
    """Create a Redis pubsub object."""
    redis_client = await get_client()
    return redis_client.pubsub()


class PubSubContextManager:
    """Context manager for Redis PubSub to ensure proper cleanup."""
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
        return False  # Don't suppress exceptions


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
