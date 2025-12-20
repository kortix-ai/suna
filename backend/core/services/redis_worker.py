import redis.asyncio as redis_lib
from redis.asyncio.cluster import RedisCluster, ClusterNode
import os
from dotenv import load_dotenv
import asyncio
from core.utils.logger import logger
from typing import List, Any, Optional, Union

from core.services.redis import get_redis_config

client: Optional[Union[RedisCluster, redis_lib.Redis]] = None
_initialized = False
_init_lock = asyncio.Lock()
_cluster_mode = False

REDIS_KEY_TTL = 3600 * 24

def initialize():
    global client, _cluster_mode

    load_dotenv()
    config = get_redis_config()
    _cluster_mode = config["cluster_mode"]
    
    max_connections = int(os.getenv("REDIS_WORKER_MAX_CONNECTIONS", "150"))

    mode_info = "cluster" if _cluster_mode else "standalone"
    ssl_info = " (SSL)" if config["ssl"] else ""
    logger.info(f"Initializing WORKER Redis [{mode_info}] -> {config['host']}:{config['port']}{ssl_info}")

    if _cluster_mode:
        startup_nodes = [ClusterNode(config["host"], config["port"])]
        
        cluster_kwargs = {
            "startup_nodes": startup_nodes,
            "decode_responses": True,
            "socket_timeout": 10.0,
            "socket_connect_timeout": 5.0,
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
        pool = redis_lib.ConnectionPool(
            host=config["host"],
            port=config["port"],
            password=config["password"] if config["password"] else None,
            username=config["username"] if config["username"] else None,
            decode_responses=True,
            socket_timeout=10.0,
            socket_connect_timeout=5.0,
            socket_keepalive=True,
            health_check_interval=30,
            max_connections=max_connections,
        )
        client = redis_lib.Redis(connection_pool=pool)

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
            logger.info(f"WORKER Redis connected ({'cluster' if _cluster_mode else 'standalone'})")
            _initialized = True
        except Exception as e:
            logger.error(f"WORKER Redis connection failed: {e}")
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
            logger.warning(f"WORKER Redis close error: {e}")
        finally:
            client = None
    _initialized = False


async def get_client():
    global client, _initialized
    if client is None or not _initialized:
        await initialize_async()
    return client


async def verify_connection() -> bool:
    try:
        redis_client = await get_client()
        await asyncio.wait_for(redis_client.ping(), timeout=5.0)
        return True
    except Exception as e:
        logger.error(f"Redis connection verification failed: {e}")
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
            return True
        raise ConnectionError(f"Redis stream {stream_key} write returned no ID")
    except ConnectionError:
        raise
    except Exception as e:
        raise ConnectionError(f"Redis stream {stream_key} is not writable: {e}")


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


async def batch_publish(channel: str, messages: List[str]):
    redis_client = await get_client()
    if _cluster_mode:
        results = []
        for msg in messages:
            result = await redis_client.publish(channel, msg)
            results.append(result)
        return results
    else:
        async with redis_client.pipeline() as pipe:
            for msg in messages:
                pipe.publish(channel, msg)
            return await pipe.execute()


async def batch_rpush(key: str, values: List[str]):
    redis_client = await get_client()
    if _cluster_mode:
        results = []
        for value in values:
            result = await redis_client.rpush(key, value)
            results.append(result)
        return results
    else:
        async with redis_client.pipeline() as pipe:
            for value in values:
                pipe.rpush(key, value)
            return await pipe.execute()


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
