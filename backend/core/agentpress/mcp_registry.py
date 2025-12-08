import time
import asyncio
from typing import Dict, List, Optional, Any, Set
from dataclasses import dataclass
from enum import Enum

from core.utils.logger import logger
from core.agentpress.tool import ToolResult


class MCPToolStatus(Enum):
    DISCOVERED = "discovered"
    LOADING = "loading"
    ACTIVE = "active"
    FAILED = "failed"
    DISABLED = "disabled"


@dataclass
class MCPToolInfo:
    tool_name: str
    toolkit_slug: str
    mcp_config: Dict[str, Any]
    status: MCPToolStatus = MCPToolStatus.DISCOVERED
    
    load_time_ms: Optional[float] = None
    last_used_ms: Optional[float] = None
    call_count: int = 0
    
    schema: Optional[Dict[str, Any]] = None
    description: Optional[str] = None
    instance: Optional[Any] = None
    
    last_error: Optional[str] = None
    error_count: int = 0


class MCPExecutionContext:
    def __init__(self, thread_manager, user_context: Optional[Dict] = None):
        self.thread_manager = thread_manager
        self.user_context = user_context or {}
        self.execution_stats = {
            'tools_executed': 0,
            'total_execution_time_ms': 0,
            'cache_hits': 0,
            'activation_requests': 0
        }


class MCPRegistry:
    SCHEMA_CACHE_TTL_HOURS = 24
    SCHEMA_CACHE_KEY_PREFIX = "mcp_schema:"
    
    def __init__(self):
        self._tools: Dict[str, MCPToolInfo] = {}
        self._toolkit_mapping: Dict[str, Set[str]] = {}
        self._status_index: Dict[MCPToolStatus, Set[str]] = {
            status: set() for status in MCPToolStatus
        }
        self._schema_cache: Dict[str, Dict[str, Any]] = {}
        self._initialized = False
        self._redis_client = None
        
        logger.info("🏗️ [MCP REGISTRY] Initialized isolated MCP tool registry")
    
    def register_tool_info(self, tool_info: MCPToolInfo) -> None:
        tool_name = tool_info.tool_name
        
        self._tools[tool_name] = tool_info
        
        toolkit = tool_info.toolkit_slug
        if toolkit not in self._toolkit_mapping:
            self._toolkit_mapping[toolkit] = set()
        self._toolkit_mapping[toolkit].add(tool_name)
        
        self._status_index[tool_info.status].add(tool_name)
        
        logger.debug(f"🔧 [MCP REGISTRY] Registered {tool_name} from {toolkit}")
    
    def activate_tool(self, tool_name: str, instance: Any, schema: Optional[Dict] = None) -> bool:
        if tool_name not in self._tools:
            logger.warning(f"⚠️  [MCP REGISTRY] Cannot activate unknown tool: {tool_name}")
            return False
        
        tool_info = self._tools[tool_name]
        
        self._update_tool_status(tool_name, MCPToolStatus.ACTIVE)
        
        tool_info.instance = instance
        tool_info.schema = schema
        tool_info.load_time_ms = time.time() * 1000
        
        logger.info(f"✅ [MCP REGISTRY] Activated {tool_name} successfully")
        return True
    
    def _update_tool_status(self, tool_name: str, new_status: MCPToolStatus) -> None:
        if tool_name not in self._tools:
            return
        
        tool_info = self._tools[tool_name]
        old_status = tool_info.status
     
        if tool_name in self._status_index[old_status]:
            self._status_index[old_status].remove(tool_name)
        self._status_index[new_status].add(tool_name)
        
        tool_info.status = new_status
    
    def get_tool_info(self, tool_name: str) -> Optional[MCPToolInfo]:
        return self._tools.get(tool_name)
    
    def is_tool_available(self, tool_name: str) -> bool:
        return tool_name in self._tools
    
    def is_tool_active(self, tool_name: str) -> bool:
        tool_info = self._tools.get(tool_name)
        return tool_info and tool_info.status == MCPToolStatus.ACTIVE
    
    def get_tools_by_status(self, status: MCPToolStatus) -> List[str]:
        return list(self._status_index[status])
    
    def get_tools_by_toolkit(self, toolkit_slug: str) -> List[str]:
        return list(self._toolkit_mapping.get(toolkit_slug, set()))
    
    def get_available_toolkits(self) -> List[str]:
        return list(self._toolkit_mapping.keys())
    
    async def _ensure_redis(self) -> bool:
        if self._redis_client is None:
            try:
                from core.services import redis as redis_service
                self._redis_client = await redis_service.get_client()
                return True
            except Exception as e:
                logger.debug(f"⚠️ [MCP REGISTRY] Redis not available: {e}")
                return False
        return True
    
    async def _get_cached_toolkit_schemas(self, toolkit_slug: str) -> Optional[Dict[str, Dict[str, Any]]]:
        if not await self._ensure_redis():
            return None
        
        try:
            cache_key = f"{self.SCHEMA_CACHE_KEY_PREFIX}{toolkit_slug}"
            cached_data = await self._redis_client.get(cache_key)
            
            if cached_data:
                import json
                schemas = json.loads(cached_data)
                logger.info(f"⚡ [MCP SCHEMA CACHE] HIT for {toolkit_slug} ({len(schemas)} schemas)")
                return schemas
        except Exception as e:
            logger.debug(f"⚠️ [MCP SCHEMA CACHE] Read error: {e}")
        
        return None
    
    async def _cache_toolkit_schemas(self, toolkit_slug: str, schemas: Dict[str, Dict[str, Any]]) -> None:
        if not await self._ensure_redis():
            return
        
        try:
            import json
            cache_key = f"{self.SCHEMA_CACHE_KEY_PREFIX}{toolkit_slug}"
            ttl_seconds = int(self.SCHEMA_CACHE_TTL_HOURS * 3600)
            
            await self._redis_client.setex(
                cache_key,
                ttl_seconds,
                json.dumps(schemas)
            )
            logger.info(f"✅ [MCP SCHEMA CACHE] Stored {len(schemas)} schemas for {toolkit_slug} (TTL: {self.SCHEMA_CACHE_TTL_HOURS}h)")
        except Exception as e:
            logger.debug(f"⚠️ [MCP SCHEMA CACHE] Write error: {e}")
    
    async def get_discovery_info(self, filter_pattern: Optional[str] = None, load_schemas: bool = True, account_id: Optional[str] = None) -> Dict[str, Any]:
        available_tools = {}
        tools_needing_schemas = []
        
        if filter_pattern and ',' in filter_pattern:
            tool_names = [name.strip() for name in filter_pattern.split(',')]
            for tool_name in tool_names:
                if tool_name in self._tools:
                    tool_info = self._tools[tool_name]
                    if tool_info.schema:
                        available_tools[tool_name] = tool_info.schema
                    else:
                        tools_needing_schemas.append(tool_name)
        else:
            for tool_name, tool_info in self._tools.items():
                if filter_pattern and filter_pattern.lower() not in tool_name.lower():
                    continue
                
                if tool_info.schema:
                    available_tools[tool_name] = tool_info.schema
                else:
                    tools_needing_schemas.append(tool_name)
        
        if load_schemas and tools_needing_schemas:
            logger.info(f"📥 [MCP REGISTRY] Loading {len(tools_needing_schemas)} schemas from MCP servers...")
            schemas_loaded = await self._load_schemas_from_mcp(tools_needing_schemas, account_id)
            available_tools.update(schemas_loaded)
        
        if tools_needing_schemas and not load_schemas:
            for tool_name in tools_needing_schemas:
                tool_info = self._tools[tool_name]
                available_tools[tool_name] = {
                    "type": "function",
                    "function": {
                        "name": tool_name,
                        "description": f"External integration tool: {tool_name} ({tool_info.toolkit_slug})",
                        "parameters": {"type": "object", "properties": {}}
                    }
                }
        
        return {
            "available_tools": available_tools,
            "total_count": len(available_tools),
            "toolkits": list(self._toolkit_mapping.keys()),
            "filter_applied": filter_pattern
        }
    
    async def _load_schemas_from_mcp(self, tool_names: List[str], account_id: Optional[str] = None) -> Dict[str, Dict[str, Any]]:
        from core.composio_integration.composio_profile_service import ComposioProfileService
        from core.services.supabase import DBConnection
        
        schemas = {}
        toolkits_to_query = {}
        
        for tool_name in tool_names:
            if tool_name not in self._tools:
                continue
            
            tool_info = self._tools[tool_name]
            toolkit_slug = tool_info.toolkit_slug
            
            if toolkit_slug not in toolkits_to_query:
                toolkits_to_query[toolkit_slug] = []
            toolkits_to_query[toolkit_slug].append(tool_name)
        
        try:
            db = DBConnection()
            profile_service = ComposioProfileService(db)
            
            for toolkit_slug, tools in toolkits_to_query.items():
                try:
                    cached_schemas = await self._get_cached_toolkit_schemas(toolkit_slug)
                    
                    if cached_schemas:
                        for tool_name in tools:
                            if tool_name in cached_schemas:
                                schemas[tool_name] = cached_schemas[tool_name]
                                if tool_name in self._tools:
                                    self._tools[tool_name].schema = cached_schemas[tool_name]
                                logger.debug(f"⚡ [MCP SCHEMA CACHE] Using cached schema for {tool_name}")
                        continue
                    if not account_id:
                        account_id = self._tools[tools[0]].mcp_config.get('account_id')
                    
                    if not account_id:
                        logger.warning(f"⚠️  [MCP REGISTRY] No account_id available for {toolkit_slug}")
                        continue
                    
                    profiles = await profile_service.get_profiles(account_id, toolkit_slug=toolkit_slug)
                    
                    if not profiles or len(profiles) == 0:
                        logger.warning(f"⚠️  [MCP REGISTRY] No profile found for {toolkit_slug}")
                        continue
                    
                    profile = profiles[0]
                    profile_config = await profile_service.get_profile_config(profile.profile_id)
                    mcp_url = profile_config.get('mcp_url')
                    
                    if not mcp_url:
                        logger.warning(f"⚠️  [MCP REGISTRY] No MCP URL for {toolkit_slug}")
                        continue
                    
                    from core.mcp_module.mcp_service import mcp_service
                    result = await mcp_service.discover_custom_tools(
                        request_type="http",
                        config={"url": mcp_url}
                    )
                    
                    if not result.success:
                        logger.warning(f"⚠️  [MCP REGISTRY] Failed to discover tools from {toolkit_slug}: {result.message}")
                        continue
                    
                    toolkit_schemas = {}
                    for discovered_tool in result.tools:
                        tool_name = discovered_tool.get('name')
                        schema = {
                            "type": "function",
                            "function": {
                                "name": tool_name,
                                "description": discovered_tool.get('description', f"Execute {tool_name}"),
                                "parameters": discovered_tool.get('inputSchema', {
                                    "type": "object",
                                    "properties": {},
                                    "required": []
                                })
                            }
                        }
                        
                        toolkit_schemas[tool_name] = schema
                        
                        if tool_name in self._tools and not self._tools[tool_name].schema:
                            self._tools[tool_name].schema = schema
                            logger.debug(f"⚡ [MCP REGISTRY] Cached schema for {tool_name} (opportunistic)")
                        
                        if tool_name in tools:
                            schemas[tool_name] = schema
                            logger.debug(f"✅ [MCP REGISTRY] Loaded schema for {tool_name} (requested)")
                    
                    await self._cache_toolkit_schemas(toolkit_slug, toolkit_schemas)
                
                except Exception as e:
                    logger.warning(f"⚠️  [MCP REGISTRY] Failed to load schemas for {toolkit_slug}: {e}")
                    continue
        
        except Exception as e:
            logger.error(f"❌ [MCP REGISTRY] Failed to load schemas: {e}")
        
        return schemas
    

    async def execute_tool(self, tool_name: str, args: Dict[str, Any], 
                          context: MCPExecutionContext) -> ToolResult:
        start_time = time.time()
        
        try:
            # Validate tool existence
            if not self.is_tool_available(tool_name):
                return self._fail_response(f"MCP tool '{tool_name}' not found in registry")
            
            tool_info = self._tools[tool_name]
            
            # Activate tool if needed
            if not self.is_tool_active(tool_name):
                logger.info(f"🔄 [MCP EXECUTION] Auto-activating {tool_name}")
                success = await self._auto_activate_tool(tool_name, context)
                if not success:
                    return self._fail_response(f"Failed to activate MCP tool: {tool_name}")
            
            # Execute tool
            tool_info = self._tools[tool_name]  # Refresh after activation
            if not tool_info.instance:
                return self._fail_response(f"MCP tool {tool_name} has no active instance")
            
            # Call the tool method
            method = getattr(tool_info.instance, tool_name)
            result = await method(**args) if args else await method()
            
            # Update statistics
            execution_time_ms = (time.time() - start_time) * 1000
            tool_info.call_count += 1
            tool_info.last_used_ms = time.time() * 1000
            context.execution_stats['tools_executed'] += 1
            context.execution_stats['total_execution_time_ms'] += execution_time_ms
            
            logger.debug(f"✅ [MCP EXECUTION] {tool_name} executed in {execution_time_ms:.1f}ms")
            return result
            
        except Exception as e:
            # Error tracking
            tool_info = self._tools.get(tool_name)
            if tool_info:
                tool_info.last_error = str(e)
                tool_info.error_count += 1
                self._update_tool_status(tool_name, MCPToolStatus.FAILED)
            
            logger.error(f"❌ [MCP EXECUTION] {tool_name} failed: {e}")
            return self._fail_response(f"MCP tool execution error: {str(e)}")
    
    async def _auto_activate_tool(self, tool_name: str, context: MCPExecutionContext) -> bool:
        try:
            self._update_tool_status(tool_name, MCPToolStatus.LOADING)
            
            tool_info = self._tools.get(tool_name)
            cached_schema = tool_info.schema if tool_info else None
            
            if cached_schema:
                logger.info(f"⚡ [MCP ACTIVATION] Using cached schema for {tool_name} (skipping MCP call)")
                context.execution_stats['cache_hits'] += 1
            
            mcp_loader = getattr(context.thread_manager, 'mcp_loader', None)
            if mcp_loader and cached_schema:
                jit_tool_info = mcp_loader.tool_map.get(tool_name)
                if jit_tool_info and not jit_tool_info.loaded:
                    jit_tool_info.schema = {
                        "name": cached_schema.get("function", {}).get("name", tool_name),
                        "description": cached_schema.get("function", {}).get("description", ""),
                        "input_schema": cached_schema.get("function", {}).get("parameters", {})
                    }
                    jit_tool_info.loaded = True
                    logger.debug(f"⚡ [MCP ACTIVATION] Pre-populated JIT loader cache for {tool_name}")
            
            from core.jit import JITLoader
            result = await JITLoader.activate_mcp_tool(tool_name, context.thread_manager)
            
            if hasattr(result, 'tool_name') and result.tool_name == tool_name:
                main_registry = context.thread_manager.tool_registry
                if tool_name in main_registry.tools:
                    tool_data = main_registry.tools[tool_name]
                    instance = tool_data["instance"]
                    schema = tool_data["schema"].schema
                    
                    del main_registry.tools[tool_name]
                    main_registry.invalidate_schema_cache()
                    main_registry.invalidate_function_cache()
                    
                    return self.activate_tool(tool_name, instance, schema)
            
            return False
            
        except Exception as e:
            logger.error(f"❌ [MCP ACTIVATION] Failed to activate {tool_name}: {e}")
            self._update_tool_status(tool_name, MCPToolStatus.FAILED)
            return False
    
    def _fail_response(self, message: str) -> ToolResult:
        """Create standardized failure response"""
        return ToolResult(success=False, output=message)
    
    async def prewarm_schemas(self, account_id: Optional[str] = None) -> int:
        toolkits = self.get_available_toolkits()
        if not toolkits:
            return 0
        
        logger.info(f"🔥 [MCP SCHEMA CACHE] Pre-warming schemas for {len(toolkits)} toolkits...")
        
        warmed_count = 0
        for toolkit_slug in toolkits:
            cached = await self._get_cached_toolkit_schemas(toolkit_slug)
            if cached:
                for tool_name, schema in cached.items():
                    if tool_name in self._tools and not self._tools[tool_name].schema:
                        self._tools[tool_name].schema = schema
                        warmed_count += 1
        
        if warmed_count > 0:
            logger.info(f"✅ [MCP SCHEMA CACHE] Pre-warmed {warmed_count} schemas from Redis")
        
        return warmed_count
    

    def get_registry_stats(self) -> Dict[str, Any]:
        return {
            "total_tools": len(self._tools),
            "active_tools": len(self._status_index[MCPToolStatus.ACTIVE]),
            "failed_tools": len(self._status_index[MCPToolStatus.FAILED]),
            "toolkits": len(self._toolkit_mapping),
            "status_breakdown": {
                status.value: len(tools) 
                for status, tools in self._status_index.items()
            }
        }


# === Global Registry Instance ===

_mcp_registry: Optional[MCPRegistry] = None


def get_mcp_registry() -> MCPRegistry:
    """Get the global MCP registry instance (singleton)"""
    global _mcp_registry
    if _mcp_registry is None:
        _mcp_registry = MCPRegistry()
    return _mcp_registry


def init_mcp_registry_from_loader(mcp_loader) -> None:
    """Initialize MCP registry from existing JIT loader configuration"""
    if not mcp_loader:
        return
    
    registry = get_mcp_registry()
    
    # Register all discovered tools
    for tool_name, tool_info in mcp_loader.tool_map.items():
        mcp_tool_info = MCPToolInfo(
            tool_name=tool_name,
            toolkit_slug=tool_info.toolkit_slug,
            mcp_config=tool_info.mcp_config,
            status=MCPToolStatus.DISCOVERED
        )
        registry.register_tool_info(mcp_tool_info)
    
    logger.info(f"🔧 [MCP REGISTRY] Initialized with {len(registry._tools)} tools from {len(registry._toolkit_mapping)} toolkits")
