import json
from typing import Optional, Dict, List
from datetime import timedelta
from core.utils.logger import logger


class ToolGuideCache:
    
    DEFAULT_TTL = timedelta(hours=1)
    CACHE_KEY_PREFIX = "tool_guide:"
    CACHE_VERSION = "v1"
    
    def __init__(self, ttl: Optional[timedelta] = None):
        self.ttl = ttl or self.DEFAULT_TTL
        self.enabled = True
        logger.info(f"⚡ [TOOL CACHE] Initialized with TTL={self.ttl}, using shared async Redis pool")
    
    async def _get_redis(self):
        from core.services import redis as redis_service
        try:
            return await redis_service.get_client()
        except Exception as e:
            logger.error(f"⚠️  [TOOL CACHE] Redis connection failed: {e}")
            self.enabled = False
            return None
    
    def _make_cache_key(self, tool_name: str) -> str:
        return f"{self.CACHE_KEY_PREFIX}{self.CACHE_VERSION}:{tool_name}"
    
    async def get_tool_guide(self, tool_name: str) -> Optional[str]:
        if not self.enabled:
            return None
        
        try:
            redis_client = await self._get_redis()
            if not redis_client:
                return None
            
            cache_key = self._make_cache_key(tool_name)
            cached_data = await redis_client.get(cache_key)
            
            if cached_data:
                data = json.loads(cached_data)
                logger.debug(f"✅ [TOOL CACHE] Hit: {tool_name}")
                return data['guide']
            
            logger.debug(f"❌ [TOOL CACHE] Miss: {tool_name}")
            return None
            
        except Exception as e:
            logger.error(f"❌ [TOOL CACHE] Error reading cache for {tool_name}: {e}")
            return None
    
    async def set_tool_guide(self, tool_name: str, guide: str) -> bool:
        if not self.enabled or not guide:
            return False
        
        try:
            redis_client = await self._get_redis()
            if not redis_client:
                return False
            
            cache_key = self._make_cache_key(tool_name)
            data = {
                'tool_name': tool_name,
                'guide': guide,
                'version': self.CACHE_VERSION
            }
            
            await redis_client.setex(
                cache_key,
                int(self.ttl.total_seconds()),
                json.dumps(data)
            )
            
            logger.debug(f"💾 [TOOL CACHE] Stored: {tool_name} (TTL={self.ttl})")
            return True
            
        except Exception as e:
            logger.error(f"❌ [TOOL CACHE] Error caching {tool_name}: {e}")
            return False
    
    async def get_multiple(self, tool_names: List[str]) -> Dict[str, Optional[str]]:

        if not self.enabled or not tool_names:
            return {name: None for name in tool_names}
        
        try:
            redis_client = await self._get_redis()
            if not redis_client:
                return {name: None for name in tool_names}
            
            pipe = redis_client.pipeline()
            cache_keys = [self._make_cache_key(name) for name in tool_names]
            
            for key in cache_keys:
                pipe.get(key)
            
            results = await pipe.execute()
            
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
    
    async def set_multiple(self, guides: Dict[str, str]) -> int:
        if not self.enabled or not guides:
            return 0
        
        try:
            redis_client = await self._get_redis()
            if not redis_client:
                return 0
            
            pipe = redis_client.pipeline()
            
            for tool_name, guide in guides.items():
                if guide:
                    cache_key = self._make_cache_key(tool_name)
                    data = {
                        'tool_name': tool_name,
                        'guide': guide,
                        'version': self.CACHE_VERSION
                    }
                    pipe.setex(cache_key, int(self.ttl.total_seconds()), json.dumps(data))
            
            await pipe.execute()
            
            logger.info(f"💾 [TOOL CACHE] Batch stored: {len(guides)} guides")
            return len(guides)
            
        except Exception as e:
            logger.error(f"❌ [TOOL CACHE] Error in batch store: {e}")
            return 0
    
    async def invalidate(self, tool_name: str) -> bool:
        if not self.enabled:
            return False
        
        try:
            redis_client = await self._get_redis()
            if not redis_client:
                return False
            
            cache_key = self._make_cache_key(tool_name)
            await redis_client.delete(cache_key)
            logger.info(f"🗑️  [TOOL CACHE] Invalidated: {tool_name}")
            return True
            
        except Exception as e:
            logger.error(f"❌ [TOOL CACHE] Error invalidating {tool_name}: {e}")
            return False
    
    async def invalidate_all(self) -> int:
        if not self.enabled:
            return 0
        
        try:
            redis_client = await self._get_redis()
            if not redis_client:
                return 0
            
            pattern = f"{self.CACHE_KEY_PREFIX}{self.CACHE_VERSION}:*"
            keys = []
            async for key in redis_client.scan_iter(match=pattern):
                keys.append(key)
            
            if keys:
                count = await redis_client.delete(*keys)
                logger.info(f"🗑️  [TOOL CACHE] Invalidated all: {count} guides")
                return count
            
            return 0
            
        except Exception as e:
            logger.error(f"❌ [TOOL CACHE] Error invalidating all: {e}")
            return 0
    
    async def warm_cache(self, tool_names: List[str]) -> int:
        if not self.enabled:
            return 0
        
        try:
            from core.tools.tool_guide_registry import get_tool_guide
            
            guides = {}
            for tool_name in tool_names:
                guide = get_tool_guide(tool_name)
                if guide:
                    guides[tool_name] = guide
            
            count = await self.set_multiple(guides)
            logger.info(f"🔥 [TOOL CACHE] Cache warmed: {count}/{len(tool_names)} guides")
            return count
            
        except Exception as e:
            logger.error(f"❌ [TOOL CACHE] Error warming cache: {e}")
            return 0
    
    async def get_stats(self) -> Dict[str, any]:
        if not self.enabled:
            return {'enabled': False}
        
        try:
            redis_client = await self._get_redis()
            if not redis_client:
                return {'enabled': False, 'error': 'Redis unavailable'}
            
            pattern = f"{self.CACHE_KEY_PREFIX}{self.CACHE_VERSION}:*"
            keys = []
            async for key in redis_client.scan_iter(match=pattern):
                keys.append(key)
            
            return {
                'enabled': True,
                'cached_tools': len(keys),
                'ttl': str(self.ttl),
                'version': self.CACHE_VERSION
            }
            
        except Exception as e:
            logger.error(f"❌ [TOOL CACHE] Error getting stats: {e}")
            return {'enabled': True, 'error': str(e)}


_cache_instance: Optional[ToolGuideCache] = None


def get_tool_cache() -> ToolGuideCache:
    global _cache_instance
    if _cache_instance is None:
        _cache_instance = ToolGuideCache()
    return _cache_instance

