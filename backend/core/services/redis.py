import redis.asyncio as redis_lib
from redis.asyncio import Redis, ConnectionPool
from redis.exceptions import BusyLoadingError
from redis.backoff import ExponentialBackoff
from redis.retry import Retry
import os
import asyncio
from typing import Optional, Dict, List, Any
from dotenv import load_dotenv
from core.utils.logger import logger

REDIS_KEY_TTL = 3600 * 2


def _calculate_max_connections() -> int:
    """
    Calculate optimal Redis pool size based on worker count.
    
    Each gunicorn worker gets its own connection pool.
    15-20 connections per worker handles both local and cloud Redis well.
    
    Override via REDIS_MAX_CONNECTIONS env var if needed.
    """
    workers = int(os.getenv("WORKERS", "16"))
    per_worker = max(15, min(20, 160 // workers))
    return per_worker


class RedisClient:
    def __init__(self):
        self._pool: Optional[ConnectionPool] = None
        self._client: Optional[Redis] = None
        self._init_lock: Optional[asyncio.Lock] = None
        self._initialized = False
    
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
        if self._pool:
            return {
                "max_connections": getattr(self._pool, 'max_connections', 'unknown'),
                "created_connections": len(getattr(self._pool, '_created_connections', [])),
                "available_connections": len(getattr(self._pool, '_available_connections', [])),
                "in_use_connections": len(getattr(self._pool, '_in_use_connections', [])),
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
            max_connections = int(os.getenv("REDIS_MAX_CONNECTIONS", str(_calculate_max_connections())))
            
            workers = int(os.getenv("WORKERS", "16"))
            calculated_default = _calculate_max_connections()
            
            logger.info(
                f"Initializing Redis to {config['host']}:{config['port']} "
                f"with max {max_connections} connections (workers={workers})"
            )
            
            retry = Retry(ExponentialBackoff(), 2)
            
            self._pool = ConnectionPool.from_url(
                config["url"],
                decode_responses=True,
                socket_timeout=30.0,
                socket_connect_timeout=15.0,
                socket_keepalive=True,
                retry_on_timeout=True,
                health_check_interval=60,
                max_connections=max_connections,
            )
            self._client = Redis(
                connection_pool=self._pool,
                retry=retry,
                retry_on_error=[BusyLoadingError]
            )
            
            try:
                await asyncio.wait_for(self._client.ping(), timeout=5.0)
                self._initialized = True
                logger.info("Successfully connected to Redis")
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
            
            self._initialized = False
            logger.info("Redis connection and pool closed")
    
    async def verify_connection(self) -> bool:
        try:
            client = await self.get_client()
            await client.ping()
            logger.info("✅ Redis connection verified")
            return True
        except Exception as e:
            logger.error(f"❌ Redis connection verification failed: {e}")
            raise ConnectionError(f"Redis connection verification failed: {e}")
    
    async def verify_stream_writable(self, stream_key: str) -> bool:
        test_key = f"{stream_key}:health_check"
        try:
            client = await self.get_client()
            test_id = await client.xadd(test_key, {'_health_check': 'true'}, maxlen=1)
            if test_id:
                await client.delete(test_key)
                logger.info(f"✅ Redis stream {stream_key} is writable")
                return True
            raise ConnectionError(f"Redis stream {stream_key} write returned no ID")
        except ConnectionError:
            raise
        except Exception as e:
            logger.error(f"❌ Redis stream {stream_key} write verification failed: {e}")
            raise ConnectionError(f"Redis stream {stream_key} is not writable: {e}")
    
    async def get(self, key: str) -> Optional[str]:
        if self._initialized and self._client:
            return await self._client.get(key)
        client = await self.get_client()
        return await client.get(key)
    
    async def set(self, key: str, value: str, ex: int = None, nx: bool = False) -> bool:
        if self._initialized and self._client:
            return await self._client.set(key, value, ex=ex, nx=nx)
        client = await self.get_client()
        return await client.set(key, value, ex=ex, nx=nx)
    
    async def setex(self, key: str, seconds: int, value: str) -> bool:
        if self._initialized and self._client:
            return await self._client.setex(key, seconds, value)
        client = await self.get_client()
        return await client.setex(key, seconds, value)
    
    async def delete(self, key: str) -> int:
        if self._initialized and self._client:
            return await self._client.delete(key)
        client = await self.get_client()
        return await client.delete(key)
    
    async def incr(self, key: str) -> int:
        client = await self.get_client()
        return await client.incr(key)
    
    async def expire(self, key: str, seconds: int) -> bool:
        client = await self.get_client()
        return await client.expire(key, seconds)
    
    async def ttl(self, key: str) -> int:
        client = await self.get_client()
        return await client.ttl(key)
    
    async def scan_keys(self, pattern: str, count: int = 100) -> List[str]:
        client = await self.get_client()
        keys = []
        async for key in client.scan_iter(match=pattern, count=count):
            keys.append(key)
        return keys
    
    async def scard(self, key: str) -> int:
        client = await self.get_client()
        return await client.scard(key)
    
    async def zrangebyscore(self, key: str, min: str, max: str) -> List[str]:
        client = await self.get_client()
        return await client.zrangebyscore(key, min=min, max=max)
    
    async def zscore(self, key: str, member: str) -> Optional[float]:
        client = await self.get_client()
        return await client.zscore(key, member)
    
    async def llen(self, key: str) -> int:
        client = await self.get_client()
        return await client.llen(key)
    
    async def stream_add(self, stream_key: str, fields: Dict[str, str], maxlen: int = None, 
                        approximate: bool = True, timeout: Optional[float] = None, 
                        fail_silently: bool = True) -> Optional[str]:
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
    
    async def stream_read(self, stream_key: str, last_id: str = "0", block_ms: int = None, count: int = None) -> List[tuple]:
        if self._initialized and self._client:
            client = self._client
        else:
            client = await self.get_client()
        streams = {stream_key: last_id}
        block_arg = block_ms if block_ms and block_ms > 0 else None
        result = await client.xread(streams, count=count, block=block_arg)
        
        if not result:
            return []
        
        entries = []
        for stream_name, stream_entries in result:
            for entry_id, fields in stream_entries:
                entries.append((entry_id, fields))
        
        return entries
    
    async def stream_range(self, stream_key: str, start: str = "-", end: str = "+", count: int = None) -> List[tuple]:
        if self._initialized and self._client:
            client = self._client
        else:
            client = await self.get_client()
        result = await client.xrange(stream_key, start, end, count=count)
        return [(entry_id, fields) for entry_id, fields in result]
    
    async def stream_len(self, stream_key: str) -> int:
        client = await self.get_client()
        return await client.xlen(stream_key)
    
    async def xadd(self, stream_key: str, fields: Dict[str, str], maxlen: int = None, approximate: bool = True) -> str:
        return await self.stream_add(stream_key, fields, maxlen=maxlen, approximate=approximate)
    
    async def xread(self, streams: Dict[str, str], count: int = None, block: int = None) -> List:
        if self._initialized and self._client:
            return await self._client.xread(streams, count=count, block=block)
        client = await self.get_client()
        return await client.xread(streams, count=count, block=block)
    
    async def xrange(self, stream_key: str, start: str = "-", end: str = "+", count: int = None) -> List:
        if self._initialized and self._client:
            return await self._client.xrange(stream_key, start, end, count=count)
        client = await self.get_client()
        return await client.xrange(stream_key, start, end, count=count)
    
    async def xlen(self, stream_key: str) -> int:
        return await self.stream_len(stream_key)
    
    async def xtrim_minid(self, stream_key: str, minid: str, approximate: bool = True) -> int:
        client = await self.get_client()
        return await client.xtrim(stream_key, minid=minid, approximate=approximate)
    
    async def set_stop_signal(self, agent_run_id: str) -> None:
        key = f"agent_run:{agent_run_id}:stop"
        await self.set(key, "1", ex=300)
        logger.info(f"Set stop signal for agent run {agent_run_id}")
    
    async def check_stop_signal(self, agent_run_id: str) -> bool:
        key = f"agent_run:{agent_run_id}:stop"
        value = await self.get(key)
        return value == "1"
    
    async def clear_stop_signal(self, agent_run_id: str) -> None:
        key = f"agent_run:{agent_run_id}:stop"
        await self.delete(key)
        logger.debug(f"Cleared stop signal for agent run {agent_run_id}")
    
    async def _with_timeout(self, coro, timeout_seconds: float, operation_name: str, default=None):
        try:
            return await asyncio.wait_for(coro, timeout=timeout_seconds)
        except asyncio.TimeoutError:
            logger.warning(f"⚠️ [REDIS TIMEOUT] {operation_name} timed out after {timeout_seconds}s")
            if self._pool:
                pool_info = self.get_pool_info()
                logger.warning(f"📊 [POOL STATUS] {pool_info}")
            return default
        except ConnectionError as e:
            if "Too many connections" in str(e):
                pool_info = self.get_pool_info()
                logger.error(f"🚨 [POOL EXHAUSTED] {operation_name} - Pool status: {pool_info}")
            logger.error(f"⚠️ [REDIS CONNECTION ERROR] {operation_name} failed: {e}")
            raise
        except Exception as e:
            logger.error(f"⚠️ [REDIS ERROR] {operation_name} failed: {e}")
            raise
    
    async def xreadgroup(self, groupname: str, consumername: str, streams: Dict[str, str], 
                         block: int = None, count: int = None, timeout: Optional[float] = None) -> List:
        client = await self.get_client()
        block_ms = block or 0
        
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

async def get(key: str):
    return await redis.get(key)

async def set(key: str, value: str, ex: int = None, nx: bool = False):
    return await redis.set(key, value, ex=ex, nx=nx)

async def setex(key: str, seconds: int, value: str):
    return await redis.setex(key, seconds, value)

async def delete(key: str):
    return await redis.delete(key)

async def incr(key: str) -> int:
    return await redis.incr(key)

async def expire(key: str, seconds: int):
    return await redis.expire(key, seconds)

async def ttl(key: str) -> int:
    return await redis.ttl(key)

async def scan_keys(pattern: str, count: int = 100):
    return await redis.scan_keys(pattern, count=count)

async def scard(key: str) -> int:
    return await redis.scard(key)

async def zrangebyscore(key: str, min: str, max: str):
    return await redis.zrangebyscore(key, min=min, max=max)

async def zscore(key: str, member: str):
    return await redis.zscore(key, member)

async def llen(key: str) -> int:
    return await redis.llen(key)

async def stream_add(stream_key: str, fields: dict, maxlen: int = None, approximate: bool = True, 
                    timeout: Optional[float] = None, fail_silently: bool = True) -> Optional[str]:
    return await redis.stream_add(stream_key, fields, maxlen=maxlen, approximate=approximate, 
                                  timeout=timeout, fail_silently=fail_silently)

async def stream_read(stream_key: str, last_id: str = "0", block_ms: int = None, count: int = None):
    return await redis.stream_read(stream_key, last_id, block_ms=block_ms, count=count)

async def stream_range(stream_key: str, start: str = "-", end: str = "+", count: int = None):
    return await redis.stream_range(stream_key, start, end, count=count)

async def stream_len(stream_key: str) -> int:
    return await redis.stream_len(stream_key)

async def xadd(stream_key: str, fields: dict, maxlen: int = None, approximate: bool = True) -> str:
    return await redis.xadd(stream_key, fields, maxlen=maxlen, approximate=approximate)

async def xread(streams: dict, count: int = None, block: int = None):
    return await redis.xread(streams, count=count, block=block)

async def xrange(stream_key: str, start: str = "-", end: str = "+", count: int = None):
    return await redis.xrange(stream_key, start, end, count=count)

async def xlen(stream_key: str) -> int:
    return await redis.xlen(stream_key)

async def xtrim_minid(stream_key: str, minid: str, approximate: bool = True) -> int:
    return await redis.xtrim_minid(stream_key, minid, approximate=approximate)

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
]
