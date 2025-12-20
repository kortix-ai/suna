import redis.asyncio as redis
import os
from dotenv import load_dotenv
import asyncio
from core.utils.logger import logger
from typing import List, Any
from core.utils.retry import retry

client: redis.Redis | None = None
pool: redis.ConnectionPool | None = None
_initialized = False
_init_lock = asyncio.Lock()

REDIS_KEY_TTL = 3600 * 2

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
    redis_url = config["url"]
    redis_host = config["host"]
    redis_port = config["port"]
    redis_username = config["username"]
    redis_ssl = config["ssl"]
    
    max_connections = int(os.getenv("REDIS_MAX_CONNECTIONS", "100"))
    socket_timeout = 15.0
    connect_timeout = 10.0
    retry_on_timeout = not (os.getenv("REDIS_RETRY_ON_TIMEOUT", "True").lower() != "true")

    auth_info = f"user={redis_username} " if redis_username else ""
    ssl_info = "(SSL) " if redis_ssl else ""
    logger.info(f"Initializing Redis connection pool to {redis_host}:{redis_port} {auth_info}{ssl_info}with max {max_connections} connections")

    pool = redis.ConnectionPool.from_url(
        redis_url,
        decode_responses=True,
        socket_timeout=socket_timeout,
        socket_connect_timeout=connect_timeout,
        socket_keepalive=True,
        retry_on_timeout=retry_on_timeout,
        health_check_interval=30,
        max_connections=max_connections,
    )

    client = redis.Redis(connection_pool=pool)

    return client


async def initialize_async():
    global client, _initialized

    async with _init_lock:
        if not _initialized or client is None:
            initialize()

        try:
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


async def get_connection_info():
    try:
        redis_client = await get_client()
        
        pool_info = {}
        if pool:
            pool_info = {
                "max_connections": pool.max_connections,
                "created_connections": pool.created_connections if hasattr(pool, 'created_connections') else None,
            }
        
        info = await redis_client.info("clients")
        server_info = {
            "connected_clients": info.get("connected_clients", 0),
            "client_recent_max_input_buffer": info.get("client_recent_max_input_buffer", 0),
            "client_recent_max_output_buffer": info.get("client_recent_max_output_buffer", 0),
        }
        
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


async def set(key: str, value: str, ex: int = None, nx: bool = False):
    redis_client = await get_client()
    return await redis_client.set(key, value, ex=ex, nx=nx)


async def get(key: str, default: str = None):
    redis_client = await get_client()
    result = await redis_client.get(key)
    return result if result is not None else default


async def delete(key: str):
    redis_client = await get_client()
    return await redis_client.delete(key)


async def publish(channel: str, message: str):
    redis_client = await get_client()
    return await redis_client.publish(channel, message)


async def create_pubsub():
    redis_client = await get_client()
    return redis_client.pubsub()


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


async def rpush(key: str, *values: Any):
    redis_client = await get_client()
    return await redis_client.rpush(key, *values)


async def lrange(key: str, start: int, end: int) -> List[str]:
    redis_client = await get_client()
    return await redis_client.lrange(key, start, end)


async def keys(pattern: str) -> List[str]:
    redis_client = await get_client()
    return await redis_client.keys(pattern)


async def expire(key: str, seconds: int):
    redis_client = await get_client()
    return await redis_client.expire(key, seconds)


async def incr(key: str):
    redis_client = await get_client()
    return await redis_client.incr(key)


async def decr(key: str):
    redis_client = await get_client()
    return await redis_client.decr(key)


async def xadd(stream_key: str, fields: dict, maxlen: int = None, approximate: bool = True) -> str:
    redis_client = await get_client()
    kwargs = {}
    if maxlen is not None:
        kwargs['maxlen'] = maxlen
        kwargs['approximate'] = approximate
    return await redis_client.xadd(stream_key, fields, **kwargs)


async def xread(streams: dict, count: int = None, block: int = None) -> list:
    redis_client = await get_client()
    return await redis_client.xread(streams, count=count, block=block)


async def xrange(stream_key: str, start: str = '-', end: str = '+', count: int = None) -> list:
    redis_client = await get_client()
    return await redis_client.xrange(stream_key, start, end, count=count)


async def xlen(stream_key: str) -> int:
    redis_client = await get_client()
    return await redis_client.xlen(stream_key)


async def xtrim(stream_key: str, maxlen: int, approximate: bool = True) -> int:
    redis_client = await get_client()
    return await redis_client.xtrim(stream_key, maxlen=maxlen, approximate=approximate)


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
    redis_client = await get_client()
    return await redis_client.xtrim(stream_key, minid=minid, approximate=approximate)
