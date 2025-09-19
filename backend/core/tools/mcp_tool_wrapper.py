from typing import Any, Dict, List, Optional
from core.agentpress.tool import Tool, ToolResult, ToolSchema, SchemaType
from core.mcp_module import mcp_service
from core.utils.logger import logger
import inspect
import asyncio
import time
import hashlib
import json
from core.tools.utils.mcp_connection_manager import MCPConnectionManager
from core.tools.utils.custom_mcp_handler import CustomMCPHandler
from core.tools.utils.dynamic_tool_builder import DynamicToolBuilder
from core.tools.utils.mcp_tool_executor import MCPToolExecutor
from core.services import redis as redis_service


class MCPSchemaRedisCache:
    def __init__(self, ttl_seconds: int = 3600, key_prefix: str = "mcp_schema:"):
        self._ttl = ttl_seconds
        self._key_prefix = key_prefix
        self._redis_client = None
    
    async def _ensure_redis(self):
        if not self._redis_client:
            try:
                self._redis_client = await redis_service.get_client()
            except Exception as e:
                logger.warning(f"Redis not available for MCP cache: {e}")
                return False
        return True
    
    def _get_cache_key(self, config: Dict[str, Any]) -> str:
        config_str = json.dumps(config, sort_keys=True)
        config_hash = hashlib.md5(config_str.encode()).hexdigest()
        return f"{self._key_prefix}{config_hash}"
    
    async def get(self, config: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        if not await self._ensure_redis():
            return None
            
        try:
            key = self._get_cache_key(config)
            cached_data = await self._redis_client.get(key)
            
            if cached_data:
                logger.debug(f"⚡ Redis cache hit for MCP: {config.get('name', config.get('qualifiedName', 'Unknown'))}")
                return json.loads(cached_data)
            else:
                logger.debug(f"Redis cache miss for MCP: {config.get('name', config.get('qualifiedName', 'Unknown'))}")
                return None
                
        except Exception as e:
            logger.warning(f"Error reading from Redis cache: {e}")
            return None
    
    async def set(self, config: Dict[str, Any], data: Dict[str, Any]):
        if not await self._ensure_redis():
            return
            
        try:
            key = self._get_cache_key(config)
            serialized_data = json.dumps(data)
            
            await self._redis_client.setex(key, self._ttl, serialized_data)
            logger.debug(f"✅ Cached MCP schema in Redis for {config.get('name', config.get('qualifiedName', 'Unknown'))} (TTL: {self._ttl}s)")
            
        except Exception as e:
            logger.warning(f"Error writing to Redis cache: {e}")
    
    async def clear_pattern(self, pattern: Optional[str] = None):
        if not await self._ensure_redis():
            return
        try:
            if pattern:
                search_pattern = f"{self._key_prefix}{pattern}*"
            else:
                search_pattern = f"{self._key_prefix}*"
            
            keys = []
            async for key in self._redis_client.scan_iter(match=search_pattern):
                keys.append(key)
            
            if keys:
                await self._redis_client.delete(*keys)
                logger.debug(f"Cleared {len(keys)} MCP schema cache entries from Redis")
            
        except Exception as e:
            logger.warning(f"Error clearing Redis cache: {e}")
    
    async def get_stats(self) -> Dict[str, Any]:
        if not await self._ensure_redis():
            return {"available": False}
        try:
            count = 0
            async for _ in self._redis_client.scan_iter(match=f"{self._key_prefix}*"):
                count += 1
            
            return {
                "available": True,
                "cached_schemas": count,
                "ttl_seconds": self._ttl,
                "key_prefix": self._key_prefix
            }
        except Exception as e:
            logger.warning(f"Error getting cache stats: {e}")
            return {"available": False, "error": str(e)}


_redis_cache = MCPSchemaRedisCache(ttl_seconds=3600)

class MCPToolWrapper(Tool):
    def __init__(self, mcp_configs: Optional[List[Dict[str, Any]]] = None, use_cache: bool = True):
        self.mcp_manager = mcp_service
        self.mcp_configs = mcp_configs or []
        self._initialized = False
        self._schemas: Dict[str, List[ToolSchema]] = {}
        self._dynamic_tools = {}
        self._custom_tools = {}
        self.use_cache = use_cache
        
        self.connection_manager = MCPConnectionManager()
        self.custom_handler = CustomMCPHandler(self.connection_manager)
        self.tool_builder = DynamicToolBuilder()
        self.tool_executor = None
        
        super().__init__()
        
    async def _ensure_initialized(self):
        if not self._initialized:
            await self._initialize_servers()
            await self._create_dynamic_tools()
            self._initialized = True
    
    async def _initialize_servers(self):
        start_time = time.time()
        
        standard_configs = [cfg for cfg in self.mcp_configs if not cfg.get('isCustom', False)]
        custom_configs = [cfg for cfg in self.mcp_configs if cfg.get('isCustom', False)]
        
        cached_configs = []
        cached_tools_data = []
        
        initialization_tasks = []
        
        if standard_configs:
            for config in standard_configs:
                if self.use_cache:
                    cached_data = await _redis_cache.get(config)
                    if cached_data:
                        cached_configs.append(config.get('qualifiedName', 'Unknown'))
                        cached_tools_data.append(cached_data)
                        continue
                
                task = self._initialize_single_standard_server(config)
                initialization_tasks.append(('standard', config, task))
        
        if custom_configs:
            for config in custom_configs:
                if self.use_cache:
                    cached_data = await _redis_cache.get(config)
                    if cached_data:
                        cached_configs.append(config.get('name', 'Unknown'))
                        cached_tools_data.append(cached_data)
                        continue
                
                task = self._initialize_single_custom_mcp(config)
                initialization_tasks.append(('custom', config, task))
        
        if cached_tools_data:
            logger.debug(f"⚡ Loaded {len(cached_configs)} MCP schemas from Redis cache: {', '.join(cached_configs)}")
            for cached_data in cached_tools_data:
                try:
                    if cached_data.get('type') == 'standard':
                        logger.debug("Standard MCP tools found in cache but require connection to restore")
                    elif cached_data.get('type') == 'custom':
                        custom_tools = cached_data.get('tools', {})
                        if custom_tools:
                            self.custom_handler.custom_tools.update(custom_tools)
                            logger.debug(f"Restored {len(custom_tools)} custom tools from cache")
                except Exception as e:
                    logger.warning(f"Failed to restore cached tools: {e}")
        
        if initialization_tasks:
            logger.debug(f"🚀 Initializing {len(initialization_tasks)} MCP servers in parallel (cache enabled: {self.use_cache})...")
            
            tasks = [task for _, _, task in initialization_tasks]
            results = await asyncio.gather(*tasks, return_exceptions=True)
            
            successful = 0
            failed = 0
            
            for i, result in enumerate(results):
                task_type, config, _ = initialization_tasks[i]
                if isinstance(result, Exception):
                    failed += 1
                    config_name = config.get('name', config.get('qualifiedName', 'Unknown'))
                    logger.error(f"Failed to initialize MCP server '{config_name}': {result}")
                else:
                    successful += 1
                    if self.use_cache and result:
                        await _redis_cache.set(config, result)
            
            elapsed_time = time.time() - start_time
            logger.debug(f"⚡ MCP initialization completed in {elapsed_time:.2f}s - {successful} successful, {failed} failed, {len(cached_configs)} from cache")
        else:
            if cached_configs:
                elapsed_time = time.time() - start_time
                logger.debug(f"⚡ All {len(cached_configs)} MCP schemas loaded from Redis cache in {elapsed_time:.2f}s - instant startup!")
            else:
                logger.debug("No MCP servers to initialize")
    
    async def _initialize_single_standard_server(self, config: Dict[str, Any]):
        try:
            logger.debug(f"Connecting to standard MCP server: {config['qualifiedName']}")
            await self.mcp_manager.connect_server(config)
            logger.debug(f"✓ Connected to MCP server: {config['qualifiedName']}")
            
            tools_info = self.mcp_manager.get_all_tools_openapi()
            return {'tools': tools_info, 'type': 'standard', 'timestamp': time.time()}
        except Exception as e:
            logger.error(f"✗ Failed to connect to MCP server {config['qualifiedName']}: {e}")
            raise e
    
    async def _initialize_single_custom_mcp(self, config: Dict[str, Any]):
        try:
            logger.debug(f"Initializing custom MCP: {config.get('name', 'Unknown')}")
            await self.custom_handler._initialize_single_custom_mcp(config)
            logger.debug(f"✓ Initialized custom MCP: {config.get('name', 'Unknown')}")
            
            custom_tools = self.custom_handler.get_custom_tools()
            return {'tools': custom_tools, 'type': 'custom', 'timestamp': time.time()}
        except Exception as e:
            logger.error(f"✗ Failed to initialize custom MCP {config.get('name', 'Unknown')}: {e}")
            raise e
            
    async def _initialize_standard_servers(self, standard_configs: List[Dict[str, Any]]):
        pass
    
    async def _create_dynamic_tools(self):
        try:
            available_tools = self.mcp_manager.get_all_tools_openapi()
            custom_tools = self.custom_handler.get_custom_tools()
            
            logger.debug(f"MCPManager returned {len(available_tools)} tools")
            logger.debug(f"Custom handler returned {len(custom_tools)} custom tools")
            
            self._custom_tools = custom_tools
            
            self.tool_executor = MCPToolExecutor(custom_tools, self)
            
            dynamic_methods = self.tool_builder.create_dynamic_methods(
                available_tools, 
                custom_tools, 
                self._execute_mcp_tool
            )
            
            self._dynamic_tools = self.tool_builder.get_dynamic_tools()
            
            for method_name, method in dynamic_methods.items():
                setattr(self, method_name, method)
            
            self._schemas.update(self.tool_builder.get_schemas())
            
            logger.debug(f"Created {len(self._dynamic_tools)} dynamic MCP tool methods")
            
            self._register_schemas()
            logger.debug(f"Re-registered schemas after creating dynamic tools - total: {len(self._schemas)}")
            
        except Exception as e:
            logger.error(f"Error creating dynamic MCP tools: {e}")
    
    def _register_schemas(self):
        self._schemas.clear()

        for name, method in inspect.getmembers(self, predicate=inspect.ismethod):
            if hasattr(method, 'tool_schemas'):
                self._schemas[name] = method.tool_schemas
                logger.debug(f"Registered schemas for method '{name}' in {self.__class__.__name__}")
        
        if hasattr(self, '_dynamic_tools') and self._dynamic_tools:
            for tool_name, tool_data in self._dynamic_tools.items():
                method_name = tool_data.get('method_name')
                if method_name and method_name in self._schemas:
                    continue
                
                method = tool_data.get('method')
                if method and hasattr(method, 'tool_schemas'):
                    self._schemas[method_name] = method.tool_schemas
                    logger.debug(f"Registered dynamic method schemas for '{method_name}'")
        
        logger.debug(f"Registration complete for MCPToolWrapper - total schemas: {len(self._schemas)}")
    
    def get_schemas(self) -> Dict[str, List[ToolSchema]]:
        logger.debug(f"get_schemas called - returning {len(self._schemas)} schemas")
        for method_name in self._schemas:
            logger.debug(f"  - Schema available for: {method_name}")
        return self._schemas
    
    def __getattr__(self, name: str):
        if hasattr(self, 'tool_builder') and self.tool_builder:
            method = self.tool_builder.find_method_by_name(name)
            if method:
                return method
        
        if hasattr(self, '_dynamic_tools') and self._dynamic_tools:
            for tool_data in self._dynamic_tools.values():
                if tool_data.get('method_name') == name:
                    return tool_data.get('method')
            
            name_with_hyphens = name.replace('_', '-')
            for tool_name, tool_data in self._dynamic_tools.items():
                if tool_data.get('method_name') == name or tool_name == name_with_hyphens:
                    return tool_data.get('method')
        
        raise AttributeError(f"'{self.__class__.__name__}' object has no attribute '{name}'")
    
    async def initialize_and_register_tools(self, tool_registry=None):
        await self._ensure_initialized()
        if tool_registry and self._dynamic_tools:
            logger.debug(f"Updating tool registry with {len(self._dynamic_tools)} MCP tools")
            
    async def get_available_tools(self) -> List[Dict[str, Any]]:
        await self._ensure_initialized()
        return self.mcp_manager.get_all_tools_openapi()
    
    async def _execute_mcp_tool(self, tool_name: str, arguments: Dict[str, Any]) -> ToolResult:
        await self._ensure_initialized()
        return await self.tool_executor.execute_tool(tool_name, arguments)
    
    async def cleanup(self):
        if self._initialized:
            try:
                await self.mcp_manager.disconnect_all()
            except Exception as e:
                logger.error(f"Error during MCP cleanup: {str(e)}")
            finally:
                self._initialized = False 