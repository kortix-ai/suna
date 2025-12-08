import json
import time
import asyncio
from typing import Dict, List, Optional
from datetime import timedelta

from core.utils.logger import logger
from core.services import redis as redis_service


class MCPRegistry:
    CACHE_TTL = timedelta(hours=24)
    CACHE_KEY_PREFIX = "mcp_tools:"
    CACHE_VERSION = "v1"
    
    def __init__(self):
        self._redis_client = None
        self._cache_enabled = False
        self._toolkit_cache = {}
    
    async def _ensure_redis(self) -> bool:
        if self._redis_client is None:
            try:
                self._redis_client = await redis_service.get_client()
                self._cache_enabled = True
                logger.debug("⚡ [MCP DYNAMIC] Redis cache enabled")
                return True
            except Exception as e:
                logger.warning(f"⚠️  [MCP DYNAMIC] Redis not available: {e}")
                self._cache_enabled = False
                return False
        return self._cache_enabled
    
    def _make_cache_key(self, toolkit_slug: str) -> str:
        return f"{self.CACHE_KEY_PREFIX}{self.CACHE_VERSION}:{toolkit_slug}"
    
    async def get_toolkit_tools(self, toolkit_slug: str, account_id: Optional[str] = None, cache_only: bool = False) -> List[str]:
        cache_key = self._make_cache_key(toolkit_slug)
        
        redis_available = await self._ensure_redis()
        logger.debug(f"⚡ [MCP DYNAMIC] Redis available: {redis_available} for {toolkit_slug}")
        
        if redis_available:
            try:
                cached_data = await self._redis_client.get(cache_key)
                if cached_data:
                    tools = json.loads(cached_data)
                    logger.info(f"✅ [MCP DYNAMIC] Cache hit: {toolkit_slug} ({len(tools)} tools)")
                    return tools
                else:
                    logger.debug(f"⚡ [MCP DYNAMIC] No cached data for key: {cache_key}")
            except Exception as e:
                logger.warning(f"⚠️  [MCP DYNAMIC] Cache read error for {toolkit_slug}: {e}")
        
        if cache_only:
            logger.debug(f"⚡ [MCP DYNAMIC] Cache miss (cache_only mode): {toolkit_slug} - skipping API query")
            return []
        
        logger.info(f"❌ [MCP DYNAMIC] Cache miss: {toolkit_slug} - querying Composio API")
        
        tools = await self._query_composio_toolkit(toolkit_slug, account_id=account_id)
        await self._cache_toolkit_tools(toolkit_slug, tools)
        
        return tools
    
    async def _query_composio_toolkit(self, toolkit_slug: str, account_id: Optional[str] = None, sample_profile_id: Optional[str] = None) -> List[str]:
        start_time = time.time()
        
        try:
            from core.composio_integration.composio_profile_service import ComposioProfileService
            from core.services.supabase import DBConnection
            
            db = DBConnection()
            profile_service = ComposioProfileService(db)
            
            try:
                if account_id:
                    connected_profiles = await self._find_connected_profiles_for_toolkit(profile_service, toolkit_slug, account_id)
                else:
                    logger.warning(f"⚠️  [MCP DYNAMIC] No account_id provided, cannot find profiles for {toolkit_slug}")
                    connected_profiles = []
                
                if connected_profiles:
                    for profile in connected_profiles:
                        if profile.is_connected and profile.mcp_url:
                            real_tools = await self._query_via_mcp_service_with_url(
                                toolkit_slug, profile.mcp_url, start_time
                            )
                            if real_tools:
                                return real_tools
                
            except Exception as profile_err:
                logger.debug(f"⚡ [MCP DYNAMIC] No connected profiles found for {toolkit_slug}: {profile_err}")

            logger.warning(f"⚠️  [MCP DYNAMIC] No connected profiles for {toolkit_slug} - cannot discover real tool names")
            return []
                
        except Exception as e:
            logger.error(f"❌ [MCP DYNAMIC] Failed to query Composio for {toolkit_slug}: {e}")
            if toolkit_slug in self._toolkit_cache:
                logger.info(f"⚡ [MCP DYNAMIC] Using fallback cache for {toolkit_slug}")
                return self._toolkit_cache[toolkit_slug]
            
            return []
    
    async def _find_connected_profiles_for_toolkit(self, profile_service, toolkit_slug: str, account_id: str):
        try:
            all_profiles = await profile_service.get_profiles(account_id)
            
            connected_profiles = []
            for profile in all_profiles:
                if profile.toolkit_slug == toolkit_slug and profile.is_connected:
                    connected_profiles.append(profile)
            
            return connected_profiles
            
        except Exception as e:
            logger.debug(f"⚡ [MCP DYNAMIC] Error finding profiles for {toolkit_slug}: {e}")
            return []
    
    async def _query_via_mcp_service_with_url(self, toolkit_slug: str, mcp_url: str, start_time: float) -> List[str]:
        try:
            from core.mcp_module.mcp_service import mcp_service
            
            result = await mcp_service.discover_custom_tools(
                request_type="http",
                config={"url": mcp_url}
            )
            
            if result.success and result.tools:
                real_tools = [tool['name'] for tool in result.tools]
                elapsed_ms = (time.time() - start_time) * 1000
                logger.info(f"⚡ [MCP DYNAMIC] Discovered {len(real_tools)} REAL tool names for {toolkit_slug} via MCP server in {elapsed_ms:.1f}ms")
                return real_tools
            
        except Exception as e:
            logger.error(f"❌ [MCP DYNAMIC] MCP service query failed for {toolkit_slug}: {e}")
        
        return []
    
    async def _query_via_mcp_service(self, toolkit_slug: str, profile_id: str, start_time: float) -> List[str]:
        from core.composio_integration.composio_profile_service import ComposioProfileService
        from core.services.supabase import DBConnection
        
        db = DBConnection()
        profile_service = ComposioProfileService(db)
        
        profile = await profile_service.get_profile_by_id(profile_id)
        
        if profile and profile.is_connected and profile.mcp_url:
            return await self._query_via_mcp_service_with_url(toolkit_slug, profile.mcp_url, start_time)
        
        return []
    
    async def _query_toolkit_service_with_mapping(self, toolkit_slug: str, start_time: float) -> List[str]:
        from core.composio_integration.toolkit_service import ToolkitService
        
        toolkit_service = ToolkitService()
        tools_response = await toolkit_service.get_toolkit_tools(
            toolkit_slug=toolkit_slug,
            limit=500
        )
        
        tools = []
        if hasattr(tools_response, 'items'):
            for tool in tools_response.items:
                api_name = self._map_display_name_to_api_name(toolkit_slug, tool)
                if api_name:
                    tools.append(api_name)
        
        elapsed_ms = (time.time() - start_time) * 1000
        logger.info(f"⚡ [MCP DYNAMIC] Mapped {len(tools)} display names to API names for {toolkit_slug} in {elapsed_ms:.1f}ms")
        return tools
    
    def _map_display_name_to_api_name(self, toolkit_slug: str, tool) -> Optional[str]:
        display_name = ""
        if hasattr(tool, 'name'):
            display_name = tool.name
        elif isinstance(tool, dict) and 'name' in tool:
            display_name = tool['name']
        
        if toolkit_slug == "twitter":
            twitter_mappings = {
                "Add a list member": "TWITTER_ADD_A_LIST_MEMBER",
                "Add post to bookmarks": "TWITTER_ADD_POST_TO_BOOKMARKS",
                "Get bookmarks by user": "TWITTER_BOOKMARKS_BY_USER",
                "Create group DM conversation": "TWITTER_CREATE_A_NEW_DM_CONVERSATION",
                "Create list": "TWITTER_CREATE_LIST",
                "Creation of a post": "TWITTER_CREATION_OF_A_POST",
            }
            
            api_name = twitter_mappings.get(display_name)
            if api_name:
                return api_name
            
            api_name = f"TWITTER_{display_name.upper().replace(' ', '_')}"
            return api_name
        
        return None
    
    async def _cache_toolkit_tools(self, toolkit_slug: str, tools: List[str]) -> None:
        if not tools:
            return
        
        self._toolkit_cache[toolkit_slug] = tools
        
        if await self._ensure_redis():
            try:
                cache_key = self._make_cache_key(toolkit_slug)
                ttl_seconds = int(self.CACHE_TTL.total_seconds())
                
                await self._redis_client.setex(
                    cache_key,
                    ttl_seconds,
                    json.dumps(tools)
                )
                
                logger.debug(f"💾 [MCP DYNAMIC] Cached {toolkit_slug}: {len(tools)} tools (TTL={ttl_seconds}s)")
                
            except Exception as e:
                logger.warning(f"⚠️  [MCP DYNAMIC] Failed to cache {toolkit_slug}: {e}")
    
    async def warm_cache_for_toolkits(self, toolkit_slugs: List[str]) -> int:
        logger.info(f"🔥 [MCP DYNAMIC] Warming cache for {len(toolkit_slugs)} toolkits...")
        
        tasks = []
        for toolkit_slug in toolkit_slugs:
            task = self.get_toolkit_tools(toolkit_slug)
            tasks.append((toolkit_slug, task))
        
        results = await asyncio.gather(*[task for _, task in tasks], return_exceptions=True)
        
        successful = 0
        for (toolkit_slug, _), result in zip(tasks, results):
            if isinstance(result, list):
                successful += 1
                logger.debug(f"⚡ [MCP DYNAMIC] Warmed cache: {toolkit_slug} ({len(result)} tools)")
            else:
                logger.warning(f"⚠️  [MCP DYNAMIC] Cache warm failed for {toolkit_slug}: {result}")
        
        logger.info(f"✅ [MCP DYNAMIC] Cache warmed: {successful}/{len(toolkit_slugs)} toolkits")
        return successful
    
    async def invalidate_toolkit_cache(self, toolkit_slug: str) -> bool:
        if await self._ensure_redis():
            try:
                cache_key = self._make_cache_key(toolkit_slug)
                await self._redis_client.delete(cache_key)
                
                self._toolkit_cache.pop(toolkit_slug, None)
                
                logger.info(f"🗑️  [MCP DYNAMIC] Invalidated cache for {toolkit_slug}")
                return True
                
            except Exception as e:
                logger.warning(f"⚠️  [MCP DYNAMIC] Failed to invalidate {toolkit_slug}: {e}")
        
        return False
    
    async def invalidate_all_cache(self) -> int:
        count = 0
        
        if await self._ensure_redis():
            try:
                pattern = f"{self.CACHE_KEY_PREFIX}{self.CACHE_VERSION}:*"
                keys = []
                
                async for key in self._redis_client.scan_iter(match=pattern):
                    keys.append(key)
                
                if keys:
                    count = await self._redis_client.delete(*keys)
                    logger.info(f"🗑️  [MCP DYNAMIC] Invalidated all cache: {count} toolkits")
                
            except Exception as e:
                logger.warning(f"⚠️  [MCP DYNAMIC] Failed to invalidate all cache: {e}")
        
        self._toolkit_cache.clear()
        
        return count
    
    async def get_cache_stats(self) -> Dict[str, any]:
        stats = {
            'cache_enabled': self._cache_enabled,
            'in_memory_toolkits': len(self._toolkit_cache),
            'redis_available': await self._ensure_redis()
        }
        
        if self._cache_enabled:
            try:
                pattern = f"{self.CACHE_KEY_PREFIX}{self.CACHE_VERSION}:*"
                count = 0
                
                async for _ in self._redis_client.scan_iter(match=pattern):
                    count += 1
                
                stats.update({
                    'cached_toolkits': count,
                    'ttl_hours': self.CACHE_TTL.total_seconds() / 3600,
                    'cache_version': self.CACHE_VERSION
                })
                
            except Exception as e:
                stats['cache_error'] = str(e)
        
        return stats


_dynamic_registry: Optional[MCPRegistry] = None


async def get_dynamic_registry() -> MCPRegistry:
    global _dynamic_registry
    if _dynamic_registry is None:
        _dynamic_registry = MCPRegistry()
    return _dynamic_registry


async def get_toolkit_tools(toolkit_slug: str, account_id: Optional[str] = None, cache_only: bool = False) -> List[str]:
    registry = await get_dynamic_registry()
    return await registry.get_toolkit_tools(toolkit_slug, account_id=account_id, cache_only=cache_only)


async def get_all_available_tools_from_toolkits(toolkit_slugs: List[str]) -> Dict[str, str]:
    registry = await get_dynamic_registry()
    tool_map = {}
    
    tasks = [(slug, registry.get_toolkit_tools(slug)) for slug in toolkit_slugs]
    results = await asyncio.gather(*[task for _, task in tasks], return_exceptions=True)
    
    for (toolkit_slug, _), result in zip(tasks, results):
        if isinstance(result, list):
            for tool in result:
                tool_map[tool] = toolkit_slug
        else:
            logger.warning(f"⚠️  [MCP DYNAMIC] Failed to get tools for {toolkit_slug}: {result}")
    
    logger.debug(f"⚡ [MCP DYNAMIC] Built tool map: {len(tool_map)} tools from {len(toolkit_slugs)} toolkits")
    return tool_map


def validate_toolkit_config(toolkit_slug: str) -> bool:
    return True


async def warm_cache_for_agent_toolkits(agent_config: Dict) -> None:
    toolkit_slugs = []
    
    for mcp_config in agent_config.get('custom_mcp', []):
        toolkit_slug = mcp_config.get('toolkit_slug')
        if toolkit_slug and toolkit_slug not in toolkit_slugs:
            toolkit_slugs.append(toolkit_slug)
    
    for mcp_config in agent_config.get('configured_mcps', []):
        qualified_name = mcp_config.get('qualifiedName', '')
        if qualified_name:
            toolkit_slug = qualified_name.split('.')[-1]
            if toolkit_slug not in toolkit_slugs:
                toolkit_slugs.append(toolkit_slug)
    
    if toolkit_slugs:
        registry = await get_dynamic_registry()
        asyncio.create_task(registry.warm_cache_for_toolkits(toolkit_slugs))
        logger.info(f"🔥 [MCP DYNAMIC] Started background cache warming for: {toolkit_slugs}")
