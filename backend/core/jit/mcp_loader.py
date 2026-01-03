import time
import asyncio
from typing import Dict, List, Optional, Any
from dataclasses import dataclass

from core.utils.logger import logger
from core.jit.mcp_registry import get_toolkit_tools
from core.jit.result_types import ActivationResult, ActivationSuccess, ActivationError, ActivationErrorType

@dataclass
class MCPToolInfo:
    tool_name: str
    toolkit_slug: str
    mcp_config: Dict[str, Any]
    loaded: bool = False
    schema: Optional[Dict[str, Any]] = None
    load_time_ms: Optional[float] = None

class MCPJITLoader:

    def __init__(self, agent_config: Dict[str, Any]):
        self.agent_config = agent_config
        self.tool_map: Dict[str, MCPToolInfo] = {}
        self.schema_cache: Dict[str, Dict[str, Any]] = {}
        self._initialized = False
        self._tool_map_built = False
    
    async def rebuild_tool_map(self, fresh_config: Dict[str, Any]) -> None:
        custom_mcps_plural = fresh_config.get('custom_mcps', [])
        custom_mcp_singular = fresh_config.get('custom_mcp', [])
        configured_mcps = fresh_config.get('configured_mcps', [])
        
        old_tools = list(self.tool_map.keys())
        old_agent_config = dict(self.agent_config)
        
        normalized_fresh_config = {
            'custom_mcp': custom_mcp_singular or custom_mcps_plural,
            'configured_mcps': configured_mcps,
            'account_id': fresh_config.get('account_id', old_agent_config.get('account_id'))
        }
        
        self.agent_config.update(normalized_fresh_config)
        
        # Clear existing tool map
        self.tool_map.clear()
        self._tool_map_built = False
        
        # Rebuild with fresh config
        await self.build_tool_map(cache_only=False, force_rebuild=True)
        
        new_tools = list(self.tool_map.keys())
        logger.debug(f"⚡ [MCP JIT] Rebuilt tool map: {len(new_tools)} tools loaded")

    async def build_tool_map(self, cache_only: bool = False, force_rebuild: bool = False) -> None:
        if self._tool_map_built and not force_rebuild and cache_only:
            logger.debug("⚡ [MCP JIT] Tool map already built, skipping")
            return
        
        if not cache_only and self._tool_map_built and len(self.tool_map) == 0:
            logger.info("⚡ [MCP JIT] Rebuilding tool map with full discovery (previous build was cache-only with no results)")
        
        start_time = time.time()
        
        custom_mcps = self.agent_config.get("custom_mcp", [])
        configured_mcps = self.agent_config.get("configured_mcps", [])
        
        mode_str = "cache-only" if cache_only else "full discovery"
        logger.debug(f"⚡ [MCP JIT] Processing {len(custom_mcps)} custom MCPs and {len(configured_mcps)} configured MCPs ({mode_str})")
        
        for i, mcp in enumerate(custom_mcps):
            logger.debug(f"⚡ [MCP JIT] custom_mcp[{i}]: name={mcp.get('name')}, toolkit={mcp.get('toolkit_slug') or mcp.get('config', {}).get('toolkit_name')}")
        
        for i, mcp in enumerate(configured_mcps):
            logger.debug(f"⚡ [MCP JIT] configured_mcp[{i}]: name={mcp.get('name')}, toolkit={mcp.get('toolkit_slug')}")
        
        process_tasks = []
        for mcp_config in custom_mcps:
            process_tasks.append(self._process_mcp_config(mcp_config, "custom", cache_only=cache_only))
        
        for mcp_config in configured_mcps:
            process_tasks.append(self._process_mcp_config(mcp_config, "configured", cache_only=cache_only))
        
        if process_tasks:
            await asyncio.gather(*process_tasks, return_exceptions=True)
        
        elapsed_ms = (time.time() - start_time) * 1000
        
        self._tool_map_built = True
        logger.info(f"⚡ [MCP JIT] Built tool map: {len(self.tool_map)} tools from {len(custom_mcps + configured_mcps)} servers in {elapsed_ms:.1f}ms ({mode_str})")
        
        toolkit_counts = {}
        for tool_info in self.tool_map.values():
            toolkit = tool_info.toolkit_slug
            toolkit_counts[toolkit] = toolkit_counts.get(toolkit, 0) + 1
        
        for toolkit, count in toolkit_counts.items():
            logger.debug(f"⚡ [MCP JIT] {toolkit}: {count} tools")
    
    async def _process_mcp_config(self, mcp_config: Dict[str, Any], config_type: str, cache_only: bool = False) -> None:
        custom_type = mcp_config.get("customType", mcp_config.get("type", ""))
        server_name = mcp_config.get('name', 'unnamed')
        
        if custom_type in ("sse", "http", "json"):
            await self._process_custom_mcp_config(mcp_config, custom_type, server_name, cache_only)
            return
        
        toolkit_slug = self._extract_toolkit_slug(mcp_config)
        
        if not toolkit_slug:
            logger.warning(f"⚠️  [MCP JIT] No toolkit_slug found in {config_type} MCP config")
            return

        enabled_tools = mcp_config.get('enabledTools', [])
        
        if enabled_tools:
            for tool_name in enabled_tools:
                if tool_name in self.tool_map:
                    continue
                
                self.tool_map[tool_name] = MCPToolInfo(
                    tool_name=tool_name,
                    toolkit_slug=toolkit_slug,
                    mcp_config=mcp_config
                )
            return
        
        account_id = self.agent_config.get('account_id')
        available_tools = await get_toolkit_tools(toolkit_slug, account_id=account_id, cache_only=cache_only)
        
        if not available_tools:
            if not cache_only:
                logger.warning(f"⚠️  [MCP JIT] No tools found for toolkit: {toolkit_slug}")
            return
        
        for tool_name in available_tools:
            if tool_name in self.tool_map:
                continue
            
            self.tool_map[tool_name] = MCPToolInfo(
                tool_name=tool_name,
                toolkit_slug=toolkit_slug,
                mcp_config=mcp_config
            )
    
    async def _process_custom_mcp_config(self, mcp_config: Dict[str, Any], custom_type: str, server_name: str, cache_only: bool = False) -> None:
        logger.debug(f"⚡ [MCP JIT] Processing custom MCP: {server_name} (type: {custom_type})")
        
        config = mcp_config.get('config', {})
        enabled_tools = mcp_config.get('enabledTools', [])
        
        if cache_only:
            if enabled_tools:
                for tool_name in enabled_tools:
                    if tool_name not in self.tool_map:
                        self.tool_map[tool_name] = MCPToolInfo(
                            tool_name=tool_name,
                            toolkit_slug=f"custom_{custom_type}_{server_name}",
                            mcp_config=mcp_config
                        )
                logger.debug(f"⚡ [MCP JIT] Custom MCP {server_name}: Added {len(enabled_tools)} enabled tools from config (cache-only mode)")
            else:
                logger.debug(f"⚡ [MCP JIT] Custom MCP {server_name}: No enabled tools in config, will discover later")
            return
        
        try:
            available_tools = await self._discover_custom_mcp_tools(custom_type, config)
            
            if not available_tools:
                logger.warning(f"⚠️  [MCP JIT] No tools discovered for custom MCP: {server_name}")
                return
            
            if enabled_tools:
                tools_to_add = [tool for tool in available_tools if tool in enabled_tools]
                logger.debug(f"⚡ [MCP JIT] Custom MCP {server_name}: Filtered to {len(tools_to_add)}/{len(available_tools)} enabled tools")
            else:
                tools_to_add = available_tools
                logger.debug(f"⚡ [MCP JIT] Custom MCP {server_name}: No enabledTools filter, loading all {len(tools_to_add)} tools")
            
            toolkit_slug = f"custom_{custom_type}_{server_name.replace(' ', '_').lower()}"
            
            for tool_name in tools_to_add:
                if tool_name in self.tool_map:
                    logger.warning(f"⚠️  [MCP JIT] Tool '{tool_name}' already registered, skipping duplicate")
                    continue
                
                self.tool_map[tool_name] = MCPToolInfo(
                    tool_name=tool_name,
                    toolkit_slug=toolkit_slug,
                    mcp_config=mcp_config
                )
            
            logger.info(f"⚡ [MCP JIT] Custom MCP {server_name}: Registered {len(tools_to_add)} tools")
            
        except Exception as e:
            logger.error(f"❌ [MCP JIT] Failed to discover tools for custom MCP {server_name}: {e}")
    
    async def _discover_custom_mcp_tools(self, custom_type: str, config: Dict[str, Any]) -> List[str]:
        if custom_type == "sse":
            return await self._discover_sse_tools(config)
        elif custom_type == "http":
            return await self._discover_http_tools(config)
        elif custom_type == "json":
            return await self._discover_json_tools(config)
        else:
            logger.warning(f"⚠️  [MCP JIT] Unknown custom MCP type: {custom_type}")
            return []
    
    async def _discover_sse_tools(self, config: Dict[str, Any]) -> List[str]:
        url = config.get('url')
        if not url:
            logger.error("❌ [MCP JIT] Missing 'url' in SSE MCP config")
            return []
        
        from mcp.client.sse import sse_client
        from mcp import ClientSession
        
        headers = config.get('headers', {})
        
        try:
            try:
                async with sse_client(url, headers=headers) as (read_stream, write_stream):
                    async with ClientSession(read_stream, write_stream) as session:
                        await session.initialize()
                        tools_result = await session.list_tools()
                        tools = tools_result.tools if hasattr(tools_result, 'tools') else tools_result
                        tool_names = [tool.name for tool in tools]
                        logger.debug(f"⚡ [MCP JIT] Discovered {len(tool_names)} SSE tools")
                        return tool_names
            except TypeError as e:
                if "unexpected keyword argument" in str(e):
                    async with sse_client(url) as (read_stream, write_stream):
                        async with ClientSession(read_stream, write_stream) as session:
                            await session.initialize()
                            tools_result = await session.list_tools()
                            tools = tools_result.tools if hasattr(tools_result, 'tools') else tools_result
                            tool_names = [tool.name for tool in tools]
                            logger.debug(f"⚡ [MCP JIT] Discovered {len(tool_names)} SSE tools (no headers)")
                            return tool_names
                else:
                    raise
        except Exception as e:
            logger.error(f"❌ [MCP JIT] Failed to discover SSE tools: {e}")
            return []
    
    async def _discover_http_tools(self, config: Dict[str, Any]) -> List[str]:
        url = config.get('url')
        if not url:
            logger.error("❌ [MCP JIT] Missing 'url' in HTTP MCP config")
            return []
        
        from mcp.client.streamable_http import streamablehttp_client
        from mcp import ClientSession
        
        try:
            async with streamablehttp_client(url) as (read_stream, write_stream, _):
                async with ClientSession(read_stream, write_stream) as session:
                    await session.initialize()
                    tools_result = await session.list_tools()
                    tools = tools_result.tools if hasattr(tools_result, 'tools') else tools_result
                    tool_names = [tool.name for tool in tools]
                    logger.debug(f"⚡ [MCP JIT] Discovered {len(tool_names)} HTTP tools")
                    return tool_names
        except Exception as e:
            logger.error(f"❌ [MCP JIT] Failed to discover HTTP tools: {e}")
            return []
    
    async def _discover_json_tools(self, config: Dict[str, Any]) -> List[str]:
        command = config.get('command')
        if not command:
            logger.error("❌ [MCP JIT] Missing 'command' in JSON/stdio MCP config")
            return []
        
        from mcp import ClientSession, StdioServerParameters
        from mcp.client.stdio import stdio_client
        
        try:
            server_params = StdioServerParameters(
                command=command,
                args=config.get("args", []),
                env=config.get("env", {})
            )
            
            async with stdio_client(server_params) as (read_stream, write_stream):
                async with ClientSession(read_stream, write_stream) as session:
                    await session.initialize()
                    tools_result = await session.list_tools()
                    tools = tools_result.tools if hasattr(tools_result, 'tools') else tools_result
                    tool_names = [tool.name for tool in tools]
                    logger.debug(f"⚡ [MCP JIT] Discovered {len(tool_names)} JSON/stdio tools")
                    return tool_names
        except Exception as e:
            logger.error(f"❌ [MCP JIT] Failed to discover JSON/stdio tools: {e}")
            return []
    
    def _extract_toolkit_slug(self, mcp_config: Dict[str, Any]) -> Optional[str]:
        toolkit_slug = mcp_config.get("toolkit_slug")
        if not toolkit_slug:
            qualified_name = mcp_config.get("qualifiedName", "")
            if qualified_name:
                toolkit_slug = qualified_name.split(".")[-1]
        
        if not toolkit_slug:
            config_obj = mcp_config.get("config", {})
            if isinstance(config_obj, dict):
                toolkit_slug = config_obj.get("toolkit_slug") or config_obj.get("toolkit_name")
        
        return toolkit_slug
    
    async def _ensure_tool_map_built(self) -> None:
        if not self._tool_map_built:
            await self.build_tool_map()
    
    async def get_available_tools(self) -> List[str]:
        await self._ensure_tool_map_built()
        return list(self.tool_map.keys())
    
    async def get_toolkit_tools(self, toolkit_slug: str) -> List[str]:
        await self._ensure_tool_map_built()
        return [
            tool_name for tool_name, tool_info in self.tool_map.items()
            if tool_info.toolkit_slug == toolkit_slug
        ]
    
    async def get_toolkits(self) -> List[str]:
        await self._ensure_tool_map_built()
        toolkits = set()
        for tool_info in self.tool_map.values():
            toolkits.add(tool_info.toolkit_slug)
        return list(toolkits)
    
    async def is_tool_available(self, tool_name: str) -> bool:
        await self._ensure_tool_map_built()
        return tool_name in self.tool_map
    
    def is_tool_available_sync(self, tool_name: str) -> bool:
        return self._tool_map_built and tool_name in self.tool_map
    
    async def get_tool_info(self, tool_name: str) -> Optional[MCPToolInfo]:
        await self._ensure_tool_map_built()
        return self.tool_map.get(tool_name)
    
    async def activate_tool(self, tool_name: str) -> ActivationResult:
        if tool_name not in self.tool_map:
            return ActivationError(
                error_type=ActivationErrorType.TOOL_NOT_FOUND,
                message=f"MCP tool '{tool_name}' not found in static registry",
                tool_name=tool_name
            )
        
        tool_info = self.tool_map[tool_name]
        
        if tool_info.loaded:
            return ActivationSuccess(
                tool_name=tool_name,
                load_time_ms=tool_info.load_time_ms or 0,
                dependencies_loaded=[]
            )
        
        try:
            start_time = time.time()
            
            schema = await self._load_tool_schema(tool_name, tool_info)
            
            self.schema_cache[tool_name] = schema
            tool_info.schema = schema
            tool_info.loaded = True
            tool_info.load_time_ms = (time.time() - start_time) * 1000
            
            logger.info(f"✅ [MCP JIT] Activated '{tool_name}' in {tool_info.load_time_ms:.1f}ms")
            
            return ActivationSuccess(
                tool_name=tool_name,
                load_time_ms=tool_info.load_time_ms,
                dependencies_loaded=[]
            )
            
        except Exception as e:
            logger.error(f"❌ [MCP JIT] Failed to activate '{tool_name}': {e}")
            return ActivationError(
                error_type=ActivationErrorType.INIT_FAILED,
                message=str(e),
                tool_name=tool_name,
                details={
                    'toolkit_slug': tool_info.toolkit_slug,
                    'mcp_config': tool_info.mcp_config.get('name', 'Unknown')
                }
            )
    
    async def activate_multiple(self, tool_names: List[str]) -> Dict[str, ActivationResult]:
        logger.info(f"⚡ [MCP JIT] Activating {len(tool_names)} MCP tools in parallel")

        tasks = [(tool_name, self.activate_tool(tool_name)) for tool_name in tool_names]

        results = {}
        task_results = await asyncio.gather(*[task for _, task in tasks], return_exceptions=True)
        
        for (tool_name, _), result in zip(tasks, task_results):
            if isinstance(result, Exception):
                results[tool_name] = ActivationError(
                    error_type=ActivationErrorType.INIT_FAILED,
                    message=str(result),
                    tool_name=tool_name
                )
            else:
                results[tool_name] = result
        
        successful = sum(1 for r in results.values() if isinstance(r, ActivationSuccess))
        logger.info(f"⚡ [MCP JIT] Parallel activation completed: {successful}/{len(tool_names)} successful")
        
        return results
    
    async def _load_tool_schema(self, tool_name: str, tool_info: MCPToolInfo) -> Dict[str, Any]:
        toolkit_slug = tool_info.toolkit_slug
        mcp_config = tool_info.mcp_config
        
        custom_type = mcp_config.get("customType", mcp_config.get("type", "standard"))
        
        if custom_type == "composio":
            return await self._load_composio_schema(tool_name, toolkit_slug, mcp_config)
        elif custom_type in ("sse", "http", "json"):
            return await self._load_custom_mcp_schema(tool_name, toolkit_slug, mcp_config, custom_type)
        else:
            return await self._load_custom_mcp_schema(tool_name, toolkit_slug, mcp_config, "http")
    
    async def _load_composio_schema(self, tool_name: str, toolkit_slug: str, mcp_config: Dict[str, Any]) -> Dict[str, Any]:
        try:
            config = mcp_config.get('config', {})
            profile_id = config.get('profile_id')
            
            if not profile_id:
                raise ValueError(f"Missing profile_id for Composio tool {tool_name}")
            
            from core.composio_integration.composio_profile_service import ComposioProfileService
            from core.services.supabase import DBConnection
            from mcp.client.streamable_http import streamablehttp_client
            from mcp import ClientSession
            
            db = DBConnection()
            profile_service = ComposioProfileService(db)
            mcp_url = await profile_service.get_mcp_url_for_runtime(profile_id)
            
            logger.debug(f"⚡ [MCP JIT] Resolved Composio profile {profile_id} to MCP URL for {tool_name}")
            
            async with streamablehttp_client(mcp_url) as (read_stream, write_stream, _):
                async with ClientSession(read_stream, write_stream) as session:
                    await session.initialize()
                    tools_result = await session.list_tools()
                    tools = tools_result.tools if hasattr(tools_result, 'tools') else tools_result
                    
                    for tool in tools:
                        if tool.name == tool_name:
                            schema = {
                                "name": tool.name,
                                "description": tool.description,
                                "input_schema": tool.inputSchema
                            }
                            logger.debug(f"⚡ [MCP JIT] Found Composio schema for {tool_name}")
                            return schema
                    
                    available_tools = [tool.name for tool in tools]
                    raise ValueError(f"Tool '{tool_name}' not found. Available: {available_tools}")
                
        except Exception as e:
            logger.error(f"❌ [MCP JIT] Failed to load Composio schema for {tool_name}: {e}")
            raise
    
    async def _load_custom_mcp_schema(self, tool_name: str, toolkit_slug: str, mcp_config: Dict[str, Any], custom_type: str) -> Dict[str, Any]:
        try:
            config = mcp_config.get('config', {})
            url = config.get('url')
            
            if custom_type == "sse":
                return await self._load_sse_schema(tool_name, url, config)
            elif custom_type == "http":
                return await self._load_http_schema(tool_name, url, config)
            elif custom_type == "json":
                return await self._load_json_schema(tool_name, config)
            else:
                return await self._load_http_schema(tool_name, url, config)
            
        except Exception as e:
            logger.error(f"❌ [MCP JIT] Failed to load {custom_type} MCP schema for {tool_name}: {e}")
            raise
    
    async def _load_sse_schema(self, tool_name: str, url: str, config: Dict[str, Any]) -> Dict[str, Any]:
        if not url:
            raise ValueError(f"Missing 'url' in SSE MCP config for {tool_name}")
        
        from mcp.client.sse import sse_client
        from mcp import ClientSession
        
        headers = config.get('headers', {})
        
        try:
            async with sse_client(url, headers=headers) as (read_stream, write_stream):
                async with ClientSession(read_stream, write_stream) as session:
                    await session.initialize()
                    tools_result = await session.list_tools()
                    tools = tools_result.tools if hasattr(tools_result, 'tools') else tools_result
                    
                    for tool in tools:
                        if tool.name == tool_name:
                            schema = {
                                "name": tool.name,
                                "description": tool.description,
                                "input_schema": tool.inputSchema
                            }
                            logger.debug(f"⚡ [MCP JIT] Found SSE schema for {tool_name}")
                            return schema
                    
                    available_tools = [tool.name for tool in tools]
                    raise ValueError(f"Tool '{tool_name}' not found in SSE server. Available: {available_tools}")
        except TypeError as e:
            if "unexpected keyword argument" in str(e):
                async with sse_client(url) as (read_stream, write_stream):
                    async with ClientSession(read_stream, write_stream) as session:
                        await session.initialize()
                        tools_result = await session.list_tools()
                        tools = tools_result.tools if hasattr(tools_result, 'tools') else tools_result
                        
                        for tool in tools:
                            if tool.name == tool_name:
                                schema = {
                                    "name": tool.name,
                                    "description": tool.description,
                                    "input_schema": tool.inputSchema
                                }
                                logger.debug(f"⚡ [MCP JIT] Found SSE schema for {tool_name} (no headers)")
                                return schema
                        
                        available_tools = [tool.name for tool in tools]
                        raise ValueError(f"Tool '{tool_name}' not found in SSE server. Available: {available_tools}")
            else:
                raise
    
    async def _load_http_schema(self, tool_name: str, url: str, config: Dict[str, Any]) -> Dict[str, Any]:
        if not url:
            raise ValueError(f"Missing 'url' in HTTP MCP config for {tool_name}")
        
        from mcp.client.streamable_http import streamablehttp_client
        from mcp import ClientSession
        
        async with streamablehttp_client(url) as (read_stream, write_stream, _):
            async with ClientSession(read_stream, write_stream) as session:
                await session.initialize()
                tools_result = await session.list_tools()
                tools = tools_result.tools if hasattr(tools_result, 'tools') else tools_result
                
                for tool in tools:
                    if tool.name == tool_name:
                        schema = {
                            "name": tool.name,
                            "description": tool.description,
                            "input_schema": tool.inputSchema
                        }
                        logger.debug(f"⚡ [MCP JIT] Found HTTP schema for {tool_name}")
                        return schema
                
                available_tools = [tool.name for tool in tools]
                raise ValueError(f"Tool '{tool_name}' not found in HTTP server. Available: {available_tools}")
    
    async def _load_json_schema(self, tool_name: str, config: Dict[str, Any]) -> Dict[str, Any]:
        command = config.get('command')
        if not command:
            raise ValueError(f"Missing 'command' in JSON/stdio MCP config for {tool_name}")
        
        from mcp import ClientSession, StdioServerParameters
        from mcp.client.stdio import stdio_client
        
        server_params = StdioServerParameters(
            command=command,
            args=config.get("args", []),
            env=config.get("env", {})
        )
        
        async with stdio_client(server_params) as (read_stream, write_stream):
            async with ClientSession(read_stream, write_stream) as session:
                await session.initialize()
                tools_result = await session.list_tools()
                tools = tools_result.tools if hasattr(tools_result, 'tools') else tools_result
                
                for tool in tools:
                    if tool.name == tool_name:
                        schema = {
                            "name": tool.name,
                            "description": tool.description,
                            "input_schema": tool.inputSchema
                        }
                        logger.debug(f"⚡ [MCP JIT] Found JSON/stdio schema for {tool_name}")
                        return schema
                
                available_tools = [tool.name for tool in tools]
                raise ValueError(f"Tool '{tool_name}' not found in JSON/stdio server. Available: {available_tools}")
    
    def get_activation_stats(self) -> Dict[str, Any]:
        loaded_count = sum(1 for tool_info in self.tool_map.values() if tool_info.loaded)
        
        toolkit_stats = {}
        for tool_info in self.tool_map.values():
            toolkit = tool_info.toolkit_slug
            if toolkit not in toolkit_stats:
                toolkit_stats[toolkit] = {"total": 0, "loaded": 0}
            toolkit_stats[toolkit]["total"] += 1
            if tool_info.loaded:
                toolkit_stats[toolkit]["loaded"] += 1
        
        return {
            "total_tools": len(self.tool_map),
            "loaded_tools": loaded_count,
            "load_percentage": (loaded_count / len(self.tool_map) * 100) if self.tool_map else 0,
            "toolkit_breakdown": toolkit_stats,
            "schema_cache_size": len(self.schema_cache)
        }
    
    def cleanup(self) -> None:
        self.schema_cache.clear()
        for tool_info in self.tool_map.values():
            tool_info.schema = None
            tool_info.loaded = False
        
        logger.info("⚡ [MCP JIT] Cleaned up tool schemas and cache")
