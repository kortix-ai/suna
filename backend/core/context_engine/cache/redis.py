import json
import hashlib
from typing import Dict, Any, Optional, List
from contextlib import asynccontextmanager
from core.utils.logger import logger
from core.utils.cache import Cache


class ContextCache:
    def __init__(self, prefix: str = "ctx", default_ttl: int = 3600):
        self.prefix = prefix
        self.default_ttl = default_ttl
        self._tracked_keys: set = set()
    
    def _make_key(self, *parts: str) -> str:
        key = f"{self.prefix}:{':'.join(parts)}"
        self._tracked_keys.add(key)
        return key
    
    def _hash_content(self, content: Any) -> str:
        return hashlib.md5(
            json.dumps(content, sort_keys=True, default=str).encode()
        ).hexdigest()[:16]
    
    async def get_compiled_context(
        self,
        thread_id: str,
        version_hash: str,
    ) -> Optional[Dict[str, Any]]:
        key = self._make_key("compiled", thread_id, version_hash)
        try:
            cached = await Cache.get(key)
            if cached:
                logger.debug(f"Cache hit for compiled context: {thread_id}")
                return cached
        except Exception as e:
            logger.debug(f"Cache get failed: {e}")
        return None
    
    async def set_compiled_context(
        self,
        thread_id: str,
        version_hash: str,
        context: Dict[str, Any],
        ttl: Optional[int] = None,
    ):
        key = self._make_key("compiled", thread_id, version_hash)
        try:
            await Cache.set(key, context, ttl=ttl or self.default_ttl)
            logger.debug(f"Cached compiled context: {thread_id}")
        except Exception as e:
            logger.debug(f"Cache set failed: {e}")
    
    async def get_summary(self, content_hash: str) -> Optional[str]:
        key = self._make_key("summary", content_hash)
        try:
            return await Cache.get(key)
        except Exception:
            return None
    
    async def set_summary(
        self,
        content_hash: str,
        summary: str,
        ttl: Optional[int] = None,
    ):
        key = self._make_key("summary", content_hash)
        try:
            await Cache.set(key, summary, ttl=ttl or self.default_ttl * 24)
        except Exception as e:
            logger.debug(f"Failed to cache summary: {e}")
    
    async def get_embeddings(self, text_hash: str) -> Optional[List[float]]:
        key = self._make_key("embed", text_hash)
        try:
            return await Cache.get(key)
        except Exception:
            return None
    
    async def set_embeddings(
        self,
        text_hash: str,
        embeddings: List[float],
        ttl: Optional[int] = None,
    ):
        key = self._make_key("embed", text_hash)
        try:
            await Cache.set(key, embeddings, ttl=ttl or self.default_ttl * 168)
        except Exception as e:
            logger.debug(f"Failed to cache embeddings: {e}")
    
    async def invalidate_thread(self, thread_id: str):
        keys_to_remove = [k for k in self._tracked_keys if thread_id in k]
        for key in keys_to_remove:
            try:
                await Cache.delete(key)
                self._tracked_keys.discard(key)
            except Exception as e:
                logger.debug(f"Failed to invalidate key {key}: {e}")
        logger.debug(f"Invalidated {len(keys_to_remove)} cache keys for thread: {thread_id}")
    
    async def cleanup(self):
        self._tracked_keys.clear()
        logger.debug("ContextCache cleanup complete")
    
    def compute_version_hash(
        self,
        message_count: int,
        last_message_id: Optional[str] = None,
        config_hash: Optional[str] = None,
    ) -> str:
        parts = [str(message_count)]
        if last_message_id:
            parts.append(last_message_id[:8])
        if config_hash:
            parts.append(config_hash[:8])
        return hashlib.md5(":".join(parts).encode()).hexdigest()[:12]
    
    @asynccontextmanager
    async def session(self):
        try:
            yield self
        finally:
            await self.cleanup()


async def create_context_cache(
    prefix: str = "ctx",
    ttl: int = 3600,
) -> ContextCache:
    return ContextCache(prefix=prefix, default_ttl=ttl)
