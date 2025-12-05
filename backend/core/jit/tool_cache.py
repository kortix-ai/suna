"""
Tool Guide Cache - Redis-based caching to preserve prompt caching

Problem:
    Every time tools are loaded, the prompt changes (tool guides added).
    This invalidates Claude's prompt caching, wasting tokens.

Solution:
    Cache tool guides in Redis with TTL. Same cache key returns identical text,
    preserving prompt caching across requests.

Example:
    Request 1: Load web_search_tool → Cache guide → Prompt cached by Claude
    Request 2: Load web_search_tool → Use cached guide → Same prompt → Cache hit!
"""

import redis
import json
from typing import Optional, Dict, List
from datetime import timedelta
from core.utils.logger import logger
from core.utils.config import config


class ToolGuideCache:
    """
    Redis-based cache for tool guides to preserve prompt caching.
    """
    
    # Cache TTL (1 hour default - long enough to preserve caching across conversation)
    DEFAULT_TTL = timedelta(hours=1)
    CACHE_KEY_PREFIX = "tool_guide:"
    CACHE_VERSION = "v1"  # Increment when tool guides change format
    
    def __init__(self, redis_client: Optional[redis.Redis] = None, ttl: Optional[timedelta] = None):
        """
        Initialize tool guide cache.
        
        Args:
            redis_client: Redis client instance (optional, will create if not provided)
            ttl: Cache TTL duration (default: 1 hour)
        """
        self.redis_client = redis_client or self._create_redis_client()
        self.ttl = ttl or self.DEFAULT_TTL
        self.enabled = self.redis_client is not None
        
        if self.enabled:
            logger.info(f"⚡ [TOOL CACHE] Enabled with TTL={self.ttl}")
        else:
            logger.warning("⚠️  [TOOL CACHE] Disabled (Redis not available)")
    
    def _create_redis_client(self) -> Optional[redis.Redis]:
        """Create Redis client from config."""
        try:
            redis_url = config.get('REDIS_URL') or 'redis://localhost:6379'
            client = redis.from_url(redis_url, decode_responses=True)
            # Test connection
            client.ping()
            logger.info(f"⚡ [TOOL CACHE] Connected to Redis: {redis_url}")
            return client
        except Exception as e:
            logger.warning(f"⚠️  [TOOL CACHE] Redis connection failed: {e}")
            return None
    
    def _make_cache_key(self, tool_name: str) -> str:
        """Generate cache key for a tool."""
        return f"{self.CACHE_KEY_PREFIX}{self.CACHE_VERSION}:{tool_name}"
    
    def get_tool_guide(self, tool_name: str) -> Optional[str]:
        """
        Get cached tool guide.
        
        Args:
            tool_name: Name of the tool
            
        Returns:
            Cached guide text or None if not cached
        """
        if not self.enabled:
            return None
        
        try:
            cache_key = self._make_cache_key(tool_name)
            cached_data = self.redis_client.get(cache_key)
            
            if cached_data:
                data = json.loads(cached_data)
                logger.debug(f"✅ [TOOL CACHE] Hit: {tool_name}")
                return data['guide']
            
            logger.debug(f"❌ [TOOL CACHE] Miss: {tool_name}")
            return None
            
        except Exception as e:
            logger.error(f"❌ [TOOL CACHE] Error reading cache for {tool_name}: {e}")
            return None
    
    def set_tool_guide(self, tool_name: str, guide: str) -> bool:
        """
        Cache tool guide with TTL.
        
        Args:
            tool_name: Name of the tool
            guide: Tool guide text to cache
            
        Returns:
            True if cached successfully
        """
        if not self.enabled or not guide:
            return False
        
        try:
            cache_key = self._make_cache_key(tool_name)
            data = {
                'tool_name': tool_name,
                'guide': guide,
                'version': self.CACHE_VERSION
            }
            
            self.redis_client.setex(
                cache_key,
                self.ttl,
                json.dumps(data)
            )
            
            logger.debug(f"💾 [TOOL CACHE] Stored: {tool_name} (TTL={self.ttl})")
            return True
            
        except Exception as e:
            logger.error(f"❌ [TOOL CACHE] Error caching {tool_name}: {e}")
            return False
    
    def get_multiple(self, tool_names: List[str]) -> Dict[str, Optional[str]]:
        """
        Get multiple tool guides in one call (pipeline for efficiency).
        
        Args:
            tool_names: List of tool names
            
        Returns:
            Dict mapping tool_name to guide (or None if not cached)
        """
        if not self.enabled or not tool_names:
            return {name: None for name in tool_names}
        
        try:
            pipe = self.redis_client.pipeline()
            cache_keys = [self._make_cache_key(name) for name in tool_names]
            
            for key in cache_keys:
                pipe.get(key)
            
            results = pipe.execute()
            
            guides = {}
            hits = 0
            for tool_name, cached_data in zip(tool_names, results):
                if cached_data:
                    data = json.loads(cached_data)
                    guides[tool_name] = data['guide']
                    hits += 1
                else:
                    guides[tool_name] = None
            
            logger.info(f"⚡ [TOOL CACHE] Batch fetch: {hits}/{len(tool_names)} hits")
            return guides
            
        except Exception as e:
            logger.error(f"❌ [TOOL CACHE] Error in batch fetch: {e}")
            return {name: None for name in tool_names}
    
    def set_multiple(self, guides: Dict[str, str]) -> int:
        """
        Cache multiple tool guides in one call (pipeline for efficiency).
        
        Args:
            guides: Dict mapping tool_name to guide text
            
        Returns:
            Number of guides successfully cached
        """
        if not self.enabled or not guides:
            return 0
        
        try:
            pipe = self.redis_client.pipeline()
            
            for tool_name, guide in guides.items():
                if guide:
                    cache_key = self._make_cache_key(tool_name)
                    data = {
                        'tool_name': tool_name,
                        'guide': guide,
                        'version': self.CACHE_VERSION
                    }
                    pipe.setex(cache_key, self.ttl, json.dumps(data))
            
            pipe.execute()
            
            logger.info(f"💾 [TOOL CACHE] Batch stored: {len(guides)} guides")
            return len(guides)
            
        except Exception as e:
            logger.error(f"❌ [TOOL CACHE] Error in batch store: {e}")
            return 0
    
    def invalidate(self, tool_name: str) -> bool:
        """
        Invalidate cache for a specific tool.
        Useful when tool guide is updated.
        
        Args:
            tool_name: Name of the tool
            
        Returns:
            True if invalidated successfully
        """
        if not self.enabled:
            return False
        
        try:
            cache_key = self._make_cache_key(tool_name)
            self.redis_client.delete(cache_key)
            logger.info(f"🗑️  [TOOL CACHE] Invalidated: {tool_name}")
            return True
            
        except Exception as e:
            logger.error(f"❌ [TOOL CACHE] Error invalidating {tool_name}: {e}")
            return False
    
    def invalidate_all(self) -> int:
        """
        Invalidate all cached tool guides.
        Useful after deployment with updated tools.
        
        Returns:
            Number of keys invalidated
        """
        if not self.enabled:
            return 0
        
        try:
            pattern = f"{self.CACHE_KEY_PREFIX}{self.CACHE_VERSION}:*"
            keys = list(self.redis_client.scan_iter(match=pattern))
            
            if keys:
                count = self.redis_client.delete(*keys)
                logger.info(f"🗑️  [TOOL CACHE] Invalidated all: {count} guides")
                return count
            
            return 0
            
        except Exception as e:
            logger.error(f"❌ [TOOL CACHE] Error invalidating all: {e}")
            return 0
    
    def warm_cache(self, tool_names: List[str]) -> int:
        """
        Pre-warm cache with tool guides.
        Useful on startup to prepare cache.
        
        Args:
            tool_names: List of tool names to warm
            
        Returns:
            Number of guides successfully cached
        """
        if not self.enabled:
            return 0
        
        try:
            from core.tools.tool_guide_registry import get_tool_guide
            
            guides = {}
            for tool_name in tool_names:
                guide = get_tool_guide(tool_name)
                if guide:
                    guides[tool_name] = guide
            
            count = self.set_multiple(guides)
            logger.info(f"🔥 [TOOL CACHE] Cache warmed: {count}/{len(tool_names)} guides")
            return count
            
        except Exception as e:
            logger.error(f"❌ [TOOL CACHE] Error warming cache: {e}")
            return 0
    
    def get_stats(self) -> Dict[str, any]:
        """Get cache statistics."""
        if not self.enabled:
            return {'enabled': False}
        
        try:
            pattern = f"{self.CACHE_KEY_PREFIX}{self.CACHE_VERSION}:*"
            keys = list(self.redis_client.scan_iter(match=pattern))
            
            return {
                'enabled': True,
                'cached_tools': len(keys),
                'ttl': str(self.ttl),
                'version': self.CACHE_VERSION
            }
            
        except Exception as e:
            logger.error(f"❌ [TOOL CACHE] Error getting stats: {e}")
            return {'enabled': True, 'error': str(e)}


# Singleton instance
_cache_instance: Optional[ToolGuideCache] = None


def get_tool_cache() -> ToolGuideCache:
    """Get singleton tool guide cache instance."""
    global _cache_instance
    if _cache_instance is None:
        _cache_instance = ToolGuideCache()
    return _cache_instance

