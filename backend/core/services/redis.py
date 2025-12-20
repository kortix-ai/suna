import redis.asyncio as redis
from redis.asyncio.cluster import RedisCluster, ClusterNode
import os
from dotenv import load_dotenv
import asyncio
from core.utils.logger import logger
from typing import List, Any, Union

client: Union[RedisCluster, redis.Redis, None] = None
_initialized = False
_init_lock = asyncio.Lock()
_cluster_mode = False

REDIS_KEY_TTL = 3600 * 2


def get_redis_config():
    load_dotenv()
    
    redis_host = os.getenv("REDIS_HOST", "localhost")
    redis_port = int(os.getenv("REDIS_PORT", 6379))
    redis_password = os.getenv("REDIS_PASSWORD", "")
    redis_username = os.getenv("REDIS_USERNAME", None)
    redis_ssl = os.getenv("REDIS_SSL", "false").lower() == "true"
    cluster_mode = os.getenv("REDIS_CLUSTER_MODE", "false").lower() == "true"
    
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
        "cluster_mode": cluster_mode,
    }


def initialize():
    global client, _cluster_mode

    config = get_redis_config()
    _cluster_mode = config["cluster_mode"]
    
    max_connections = int(os.getenv("REDIS_MAX_CONNECTIONS", "100"))

    mode_info = "cluster" if _cluster_mode else "standalone"
    ssl_info = " (SSL)" if config["ssl"] else ""
    logger.info(f"Initializing Redis [{mode_info}] -> {config['host']}:{config['port']}{ssl_info}")

    if _cluster_mode:
        startup_nodes = [ClusterNode(config["host"], config["port"])]
        
        cluster_kwargs = {
            "startup_nodes": startup_nodes,
            "decode_responses": True,
            "socket_timeout": 15.0,
            "socket_connect_timeout": 10.0,
            "read_from_replicas": True,
            "reinitialize_steps": 5,
            "skip_full_coverage_check": True,
        }
        
        if config["password"]:
            cluster_kwargs["password"] = config["password"]
        if config["username"]:
            cluster_kwargs["username"] = config["username"]
        if config["ssl"]:
            cluster_kwargs["ssl"] = True
            cluster_kwargs["ssl_cert_reqs"] = None
        
        client = RedisCluster(**cluster_kwargs)
    else:
        pool = redis.ConnectionPool.from_url(
            config["url"],
            decode_responses=True,
            socket_timeout=15.0,
            socket_connect_timeout=10.0,
            socket_keepalive=True,
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
            if _cluster_mode and isinstance(client, RedisCluster):
                await client.initialize()
            await asyncio.wait_for(client.ping(), timeout=5.0)
            logger.info(f"Redis connected ({'cluster' if _cluster_mode else 'standalone'})")
            _initialized = True
        except Exception as e:
            logger.error(f"Redis connection failed: {e}")
            client = None
            _initialized = False
            raise

    return client


async def close():
    global client, _initialized
    if client:
        try:
            await asyncio.wait_for(client.aclose(), timeout=5.0)
        except Exception as e:
            logger.warning(f"Redis close error: {e}")
        finally:
            client = None
    _initialized = False


async def get_client():
    global client, _initialized
    if client is None or not _initialized:
        await initialize_async()
    return client


async def get_connection_info():
    try:
        redis_client = await get_client()
        info = await redis_client.info("clients")
        
        result = {
            "cluster_mode": _cluster_mode,
            "connected_clients": info.get("connected_clients", 0),
        }
        
        if _cluster_mode and isinstance(redis_client, RedisCluster):
            try:
                cluster_info = await redis_client.cluster_info()
                result["cluster_state"] = cluster_info.get("cluster_state", "unknown")
                result["cluster_known_nodes"] = cluster_info.get("cluster_known_nodes", 0)
            except Exception:
                pass
        
        return result
    except Exception as e:
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
                logger.warning(f"Pubsub close error: {e}")
        return False


async def rpush(key: str, *values: Any):
    redis_client = await get_client()
    return await redis_client.rpush(key, *values)


async def lrange(key: str, start: int, end: int) -> List[str]:
    redis_client = await get_client()
    return await redis_client.lrange(key, start, end)


async def keys(pattern: str) -> List[str]:
    redis_client = await get_client()
    if _cluster_mode and isinstance(redis_client, RedisCluster):
        all_keys = []
        for node in redis_client.get_primaries():
            node_keys = await redis_client.keys(pattern, target_nodes=node)
            if isinstance(node_keys, list):
                all_keys.extend(node_keys)
            elif isinstance(node_keys, dict):
                for keys_list in node_keys.values():
                    all_keys.extend(keys_list)
        return list(set(all_keys))
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
