"""Clean Redis client with proper connection management.

This module provides a simplified Redis client that:
- Uses redis-py's built-in connection pooling and retry mechanisms
- Eliminates Pub/Sub in favor of Redis Streams
- Uses simple keys for control signals
- Avoids event loop issues with proper threading.Lock usage
"""

import redis.asyncio as redis_lib
from redis.asyncio import Redis, ConnectionPool
from redis.exceptions import ConnectionError as RedisConnectionError, BusyLoadingError
from redis.backoff import ExponentialBackoff
from redis.retry import Retry
import os
import threading
from typing import Optional, Dict, List, Any
from dotenv import load_dotenv
from core.utils.logger import logger

# Constants
REDIS_KEY_TTL = 3600 * 2  # 2 hours default TTL


class RedisClient:
    """Clean Redis client with proper connection management.
    
    Thread-safe initialization using threading.Lock (not asyncio.Lock)
    to avoid event loop binding issues in worker processes.
    """
    
    def __init__(self):
        self._pool: Optional[ConnectionPool] = None
        self._client: Optional[Redis] = None
        self._init_lock = threading.Lock()
        self._initialized = False
    
    def _get_config(self) -> Dict[str, Any]:
        """Get Redis configuration from environment."""
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
    
    async def get_client(self) -> Redis:
        """Get or create Redis client. Thread-safe, event-loop safe."""
        if self._client is not None and self._initialized:
            return self._client
        
        with self._init_lock:
            # Double-check after acquiring lock
            if self._client is not None and self._initialized:
                return self._client
            
            config = self._get_config()
            max_connections = int(os.getenv("REDIS_MAX_CONNECTIONS", "50"))
            
            logger.info(
                f"Initializing Redis to {config['host']}:{config['port']} "
                f"with max {max_connections} connections"
            )
            
            # Configure explicit retry with exponential backoff for robust reconnection
            retry = Retry(ExponentialBackoff(), 3)
            
            self._pool = ConnectionPool.from_url(
                config["url"],
                decode_responses=True,
                socket_timeout=10.0,
                socket_connect_timeout=5.0,
                socket_keepalive=True,
                retry_on_timeout=True,
                health_check_interval=30,
                max_connections=max_connections,
            )
            self._client = Redis(
                connection_pool=self._pool,
                retry=retry,
                retry_on_error=[BusyLoadingError, RedisConnectionError]
            )
            
            # Verify connection
            await self._client.ping()
            self._initialized = True
            logger.info("Successfully connected to Redis")
            
            return self._client
    
    async def initialize_async(self):
        """Initialize Redis connection (alias for get_client for compatibility)."""
        await self.get_client()
    
    async def close(self):
        """Close Redis connection and pool."""
        with self._init_lock:
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
        """Verify Redis connection is alive."""
        try:
            client = await self.get_client()
            await client.ping()
            logger.info("✅ Redis connection verified")
            return True
        except Exception as e:
            logger.error(f"❌ Redis connection verification failed: {e}")
            raise ConnectionError(f"Redis connection verification failed: {e}")
    
    async def verify_stream_writable(self, stream_key: str) -> bool:
        """Verify a Redis stream is writable."""
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
    
    # ========== Basic Key Operations ==========
    
    async def get(self, key: str) -> Optional[str]:
        """Get value for a key."""
        client = await self.get_client()
        return await client.get(key)
    
    async def set(self, key: str, value: str, ex: int = None, nx: bool = False) -> bool:
        """Set value for a key with optional expiration and NX flag."""
        client = await self.get_client()
        return await client.set(key, value, ex=ex, nx=nx)
    
    async def setex(self, key: str, seconds: int, value: str) -> bool:
        """Set value for a key with expiration."""
        client = await self.get_client()
        return await client.setex(key, seconds, value)
    
    async def delete(self, key: str) -> int:
        """Delete a key."""
        client = await self.get_client()
        return await client.delete(key)
    
    async def expire(self, key: str, seconds: int) -> bool:
        """Set expiration on a key."""
        client = await self.get_client()
        return await client.expire(key, seconds)
    
    async def ttl(self, key: str) -> int:
        """Get TTL for a key."""
        client = await self.get_client()
        return await client.ttl(key)
    
    async def scan_keys(self, pattern: str, count: int = 100) -> List[str]:
        """Scan for keys matching a pattern (non-blocking alternative to keys())."""
        client = await self.get_client()
        keys = []
        async for key in client.scan_iter(match=pattern, count=count):
            keys.append(key)
        return keys
    
    async def scard(self, key: str) -> int:
        """Get the number of members in a set."""
        client = await self.get_client()
        return await client.scard(key)
    
    async def zrangebyscore(self, key: str, min: str, max: str) -> List[str]:
        """Get members from a sorted set by score range."""
        client = await self.get_client()
        return await client.zrangebyscore(key, min=min, max=max)
    
    async def zscore(self, key: str, member: str) -> Optional[float]:
        """Get score of a member in a sorted set."""
        client = await self.get_client()
        return await client.zscore(key, member)
    
    async def llen(self, key: str) -> int:
        """Get the length of a list."""
        client = await self.get_client()
        return await client.llen(key)
    
    # ========== Stream Operations ==========
    
    async def stream_add(self, stream_key: str, fields: Dict[str, str], maxlen: int = None, approximate: bool = True) -> str:
        """Add entry to a Redis stream.
        
        Args:
            stream_key: Stream key name
            fields: Dictionary of field-value pairs
            maxlen: Maximum length of stream (None = no limit)
            approximate: Use approximate trimming (faster)
        
        Returns:
            Entry ID (e.g., "1234567890-0")
        """
        client = await self.get_client()
        kwargs = {}
        if maxlen is not None:
            kwargs['maxlen'] = maxlen
            kwargs['approximate'] = approximate
        return await client.xadd(stream_key, fields, **kwargs)
    
    async def stream_read(self, stream_key: str, last_id: str = "0", block_ms: int = 0, count: int = None) -> List[tuple]:
        """Read entries from a Redis stream.
        
        Args:
            stream_key: Stream key name
            last_id: Last read ID (use "0" for all, "$" for new only)
            block_ms: Block for this many milliseconds (0 = non-blocking)
            count: Maximum number of entries to return
        
        Returns:
            List of (entry_id, fields_dict) tuples
        """
        client = await self.get_client()
        streams = {stream_key: last_id}
        result = await client.xread(streams, count=count, block=block_ms)
        
        if not result:
            return []
        
        # xread returns [(stream_key, [(id, fields), ...])]
        entries = []
        for stream_name, stream_entries in result:
            for entry_id, fields in stream_entries:
                entries.append((entry_id, fields))
        
        return entries
    
    async def stream_range(self, stream_key: str, start: str = "-", end: str = "+", count: int = None) -> List[tuple]:
        """Get range of entries from a Redis stream.
        
        Args:
            stream_key: Stream key name
            start: Start ID ("-" = beginning, "+" = end)
            end: End ID
            count: Maximum number of entries
        
        Returns:
            List of (entry_id, fields_dict) tuples
        """
        client = await self.get_client()
        result = await client.xrange(stream_key, start, end, count=count)
        return [(entry_id, fields) for entry_id, fields in result]
    
    async def stream_len(self, stream_key: str) -> int:
        """Get length of a Redis stream."""
        client = await self.get_client()
        return await client.xlen(stream_key)
    
    # Legacy aliases for compatibility
    async def xadd(self, stream_key: str, fields: Dict[str, str], maxlen: int = None, approximate: bool = True) -> str:
        """Legacy alias for stream_add."""
        return await self.stream_add(stream_key, fields, maxlen=maxlen, approximate=approximate)
    
    async def xread(self, streams: Dict[str, str], count: int = None, block: int = None) -> List:
        """Legacy xread interface for compatibility."""
        client = await self.get_client()
        return await client.xread(streams, count=count, block=block)
    
    async def xrange(self, stream_key: str, start: str = "-", end: str = "+", count: int = None) -> List:
        """Legacy xrange interface for compatibility."""
        client = await self.get_client()
        return await client.xrange(stream_key, start, end, count=count)
    
    async def xlen(self, stream_key: str) -> int:
        """Legacy alias for stream_len."""
        return await self.stream_len(stream_key)
    
    async def xtrim_minid(self, stream_key: str, minid: str, approximate: bool = True) -> int:
        """Trim stream entries older than minid."""
        client = await self.get_client()
        return await client.xtrim(stream_key, minid=minid, approximate=approximate)
    
    # ========== Control Signal Helpers ==========
    
    async def set_stop_signal(self, agent_run_id: str) -> None:
        """Set stop signal for an agent run.
        
        Uses a simple Redis key: agent_run:{agent_run_id}:stop = "1"
        """
        key = f"agent_run:{agent_run_id}:stop"
        await self.set(key, "1", ex=300)  # 5 minute TTL
        logger.info(f"Set stop signal for agent run {agent_run_id}")
    
    async def check_stop_signal(self, agent_run_id: str) -> bool:
        """Check if stop signal is set for an agent run."""
        key = f"agent_run:{agent_run_id}:stop"
        value = await self.get(key)
        return value == "1"
    
    async def clear_stop_signal(self, agent_run_id: str) -> None:
        """Clear stop signal for an agent run."""
        key = f"agent_run:{agent_run_id}:stop"
        await self.delete(key)
        logger.debug(f"Cleared stop signal for agent run {agent_run_id}")


# Global singleton instance
redis = RedisClient()


# Compatibility function for get_redis_config
def get_redis_config() -> Dict[str, Any]:
    """Get Redis configuration (for compatibility with existing code)."""
    temp_client = RedisClient()
    return temp_client._get_config()


# ========== Compatibility Functions (for backward compatibility) ==========
# These functions allow code to use `from core.services import redis` and call
# `await redis.get()` instead of `await redis.redis.get()`

async def get_client():
    """Get Redis client (compatibility function)."""
    return await redis.get_client()

async def initialize_async():
    """Initialize Redis connection (compatibility function)."""
    await redis.initialize_async()

async def close():
    """Close Redis connection (compatibility function)."""
    await redis.close()

async def verify_connection() -> bool:
    """Verify Redis connection (compatibility function)."""
    return await redis.verify_connection()

async def verify_stream_writable(stream_key: str) -> bool:
    """Verify stream is writable (compatibility function)."""
    return await redis.verify_stream_writable(stream_key)

# Basic operations
async def get(key: str):
    """Get value for a key (compatibility function)."""
    return await redis.get(key)

async def set(key: str, value: str, ex: int = None, nx: bool = False):
    """Set value for a key (compatibility function)."""
    return await redis.set(key, value, ex=ex, nx=nx)

async def setex(key: str, seconds: int, value: str):
    """Set value with expiration (compatibility function)."""
    return await redis.setex(key, seconds, value)

async def delete(key: str):
    """Delete a key (compatibility function)."""
    return await redis.delete(key)

async def expire(key: str, seconds: int):
    """Set expiration on a key (compatibility function)."""
    return await redis.expire(key, seconds)

async def ttl(key: str) -> int:
    """Get TTL for a key (compatibility function)."""
    return await redis.ttl(key)

async def scan_keys(pattern: str, count: int = 100):
    """Scan for keys matching a pattern (compatibility function)."""
    return await redis.scan_keys(pattern, count=count)

async def scard(key: str) -> int:
    """Get the number of members in a set (compatibility function)."""
    return await redis.scard(key)

async def zrangebyscore(key: str, min: str, max: str):
    """Get members from sorted set by score (compatibility function)."""
    return await redis.zrangebyscore(key, min=min, max=max)

async def zscore(key: str, member: str):
    """Get score of member in sorted set (compatibility function)."""
    return await redis.zscore(key, member)

async def llen(key: str) -> int:
    """Get length of a list (compatibility function)."""
    return await redis.llen(key)

# Stream operations
async def stream_add(stream_key: str, fields: dict, maxlen: int = None, approximate: bool = True) -> str:
    """Add entry to stream (compatibility function)."""
    return await redis.stream_add(stream_key, fields, maxlen=maxlen, approximate=approximate)

async def stream_read(stream_key: str, last_id: str = "0", block_ms: int = 0, count: int = None):
    """Read from stream (compatibility function)."""
    return await redis.stream_read(stream_key, last_id, block_ms=block_ms, count=count)

async def stream_range(stream_key: str, start: str = "-", end: str = "+", count: int = None):
    """Get stream range (compatibility function)."""
    return await redis.stream_range(stream_key, start, end, count=count)

async def stream_len(stream_key: str) -> int:
    """Get stream length (compatibility function)."""
    return await redis.stream_len(stream_key)

# Legacy stream aliases
async def xadd(stream_key: str, fields: dict, maxlen: int = None, approximate: bool = True) -> str:
    """Legacy xadd alias (compatibility function)."""
    return await redis.xadd(stream_key, fields, maxlen=maxlen, approximate=approximate)

async def xread(streams: dict, count: int = None, block: int = None):
    """Legacy xread alias (compatibility function)."""
    return await redis.xread(streams, count=count, block=block)

async def xrange(stream_key: str, start: str = "-", end: str = "+", count: int = None):
    """Legacy xrange alias (compatibility function)."""
    return await redis.xrange(stream_key, start, end, count=count)

async def xlen(stream_key: str) -> int:
    """Legacy xlen alias (compatibility function)."""
    return await redis.xlen(stream_key)

async def xtrim_minid(stream_key: str, minid: str, approximate: bool = True) -> int:
    """Trim stream entries older than minid (compatibility function)."""
    return await redis.xtrim_minid(stream_key, minid, approximate=approximate)

# Control signal helpers
async def set_stop_signal(agent_run_id: str):
    """Set stop signal (compatibility function)."""
    await redis.set_stop_signal(agent_run_id)

async def check_stop_signal(agent_run_id: str) -> bool:
    """Check stop signal (compatibility function)."""
    return await redis.check_stop_signal(agent_run_id)

async def clear_stop_signal(agent_run_id: str):
    """Clear stop signal (compatibility function)."""
    await redis.clear_stop_signal(agent_run_id)


# Export everything for backward compatibility
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
    'set_stop_signal',
    'check_stop_signal',
    'clear_stop_signal',
]
