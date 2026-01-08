import os
import json
import base64
import asyncio
import logging
from typing import Dict, List, Any, Optional, Tuple
from dataclasses import dataclass, field
from datetime import datetime
from collections import OrderedDict
from time import time

from mcp import ClientSession
from mcp.client.sse import sse_client
from mcp.client.streamable_http import streamablehttp_client

from core.utils.logger import logger
from core.credentials import EncryptionService
from core.utils.config import config as app_config, EnvMode
from core.tools.utils.mcp_tool_executor import is_safe_url


class MCPException(Exception):
    pass

class MCPConnectionError(MCPException):
    pass

class MCPToolNotFoundError(MCPException):
    pass

class MCPToolExecutionError(MCPException):
    pass

class MCPProviderError(MCPException):
    pass

class MCPConfigurationError(MCPException):
    pass

class MCPAuthenticationError(MCPException):
    pass

class CustomMCPError(MCPException):
    pass


@dataclass
class MCPServerInfo:
    """
    Cached metadata about an MCP server.
    
    NOTE: We do NOT cache active sessions/connections here.
    Each tool execution creates a fresh connection (connect-use-disconnect).
    This prevents connection leaks from context managers exiting.
    """
    qualified_name: str
    name: str
    config: Dict[str, Any]
    enabled_tools: List[str]
    provider: str = 'custom'
    external_user_id: Optional[str] = None
    tools: Optional[List[Any]] = field(default=None)
    server_url: Optional[str] = None
    headers: Optional[Dict[str, str]] = None


# Keep for backwards compatibility but mark as metadata-only
MCPConnection = MCPServerInfo


@dataclass(frozen=True)
class ToolInfo:
    name: str
    description: str
    input_schema: Dict[str, Any]


@dataclass(frozen=True)
class CustomMCPConnectionResult:
    success: bool
    qualified_name: str
    display_name: str
    tools: List[Dict[str, Any]]
    config: Dict[str, Any]
    url: str
    message: str


@dataclass
class MCPConnectionRequest:
    qualified_name: str
    name: str
    config: Dict[str, Any]
    enabled_tools: List[str]
    provider: str = 'custom'
    external_user_id: Optional[str] = None


@dataclass
class ToolExecutionRequest:
    tool_name: str
    arguments: Dict[str, Any]
    external_user_id: Optional[str] = None


@dataclass
class ToolExecutionResult:
    success: bool
    result: Any
    error: Optional[str] = None


class MCPService:
    """
    MCP Service with ephemeral connections.
    
    Architecture:
    - We cache SERVER METADATA (tools list, URLs, headers) for fast lookups
    - Each tool execution creates a FRESH connection (connect -> use -> disconnect)
    - This prevents connection leaks from context managers closing prematurely
    
    The previous design stored ClientSession objects, but those became invalid
    when the streamablehttp_client context manager exited.
    """
    
    def __init__(self):
        self._logger = logger
        # LRU cache: Dict[name, (server_info, created_at_timestamp)]
        # NOTE: This caches METADATA only, not active connections
        self._servers: OrderedDict[str, Tuple[MCPServerInfo, float]] = OrderedDict()
        self._encryption_service = EncryptionService()
        self._max_servers = 100  # Maximum server configs to cache
        self._server_ttl = 3600  # 1 hour TTL for cached metadata
    
    # Backwards compatibility alias
    @property
    def _connections(self):
        return self._servers

    async def connect_server(self, mcp_config: Dict[str, Any], external_user_id: Optional[str] = None) -> MCPServerInfo:
        """
        Discover and cache an MCP server's tools.
        
        This connects temporarily to fetch tool metadata, then disconnects.
        The metadata is cached for fast tool lookups during execution.
        """
        provider = mcp_config.get('type', mcp_config.get('provider', 'custom'))
        
        request = MCPConnectionRequest(
            qualified_name=mcp_config.get('qualifiedName', mcp_config.get('name', '')),
            name=mcp_config.get('name', ''),
            config=mcp_config.get('config', {}),
            enabled_tools=mcp_config.get('enabledTools', mcp_config.get('enabled_tools', [])),
            provider=provider,
            external_user_id=external_user_id
        )
        return await self._discover_and_cache_server(request)
    
    async def _discover_and_cache_server(self, request: MCPConnectionRequest) -> MCPServerInfo:
        """
        Connect to server, fetch tools, cache metadata, then disconnect.
        
        The connection is ephemeral - we only keep the metadata.
        """
        self._logger.debug(f"Discovering MCP server: {request.qualified_name}")
        
        try:
            server_url = await self._get_server_url(request.qualified_name, request.config, request.provider)
            headers = self._get_headers(request.qualified_name, request.config, request.provider, request.external_user_id)
            
            self._logger.debug(f"MCP discovery - Provider: {request.provider}, URL: {server_url}")
            
            # Ephemeral connection: connect, fetch tools, disconnect
            tools = []
            async with asyncio.timeout(30):
                async with streamablehttp_client(server_url, headers=headers) as (
                    read_stream, write_stream, _
                ):
                    async with ClientSession(read_stream, write_stream) as session:
                        await session.initialize()
                        tool_result = await session.list_tools()
                        tools = tool_result.tools if tool_result else []
            # Connection is now closed (context manager exited)
            
            # Cache only metadata - no session reference
            server_info = MCPServerInfo(
                qualified_name=request.qualified_name,
                name=request.name,
                config=request.config,
                enabled_tools=request.enabled_tools,
                provider=request.provider,
                external_user_id=request.external_user_id,
                tools=tools,
                server_url=server_url,
                headers=headers
            )
            
            # Store with timestamp for TTL tracking
            self._servers[request.qualified_name] = (server_info, time())
            self._servers.move_to_end(request.qualified_name)
            self._logger.debug(f"Cached {request.qualified_name} ({len(tools)} tools)")
            
            # Cleanup old entries
            self._cleanup_old_servers()
            
            return server_info
                    
        except asyncio.TimeoutError:
            error_msg = f"Connection timeout for {request.qualified_name} after 30 seconds"
            self._logger.error(error_msg)
            raise MCPConnectionError(error_msg)
        except Exception as e:
            self._logger.error(f"Failed to discover {request.qualified_name}: {str(e)}")
            raise MCPConnectionError(f"Failed to connect to MCP server: {str(e)}")
    
    # Backwards compatibility alias
    async def _connect_server_internal(self, request: MCPConnectionRequest) -> MCPServerInfo:
        return await self._discover_and_cache_server(request)
    
    async def connect_all(self, mcp_configs: List[Dict[str, Any]]) -> None:
        """Discover and cache multiple MCP servers."""
        for config in mcp_configs:
            provider = config.get('type', config.get('provider', 'custom'))
            
            request = MCPConnectionRequest(
                qualified_name=config.get('qualifiedName', config.get('name', '')),
                name=config.get('name', ''),
                config=config.get('config', {}),
                enabled_tools=config.get('enabledTools', config.get('enabled_tools', [])),
                provider=provider,
                external_user_id=config.get('external_user_id')
            )
            
            try:
                await self._discover_and_cache_server(request)
            except MCPConnectionError as e:
                self._logger.error(f"Failed to discover {request.qualified_name}: {str(e)}")
                continue
    
    def _cleanup_old_servers(self) -> None:
        """Remove expired or excess cached server metadata (sync - no connections to close)."""
        now = time()
        expired_names = [
            name for name, (_, created_at) in self._servers.items()
            if now - created_at > self._server_ttl
        ]
        
        for name in expired_names:
            self._servers.pop(name, None)
            self._logger.debug(f"Expired cached metadata for {name}")
        
        # Enforce LRU limit
        while len(self._servers) > self._max_servers:
            oldest_name = next(iter(self._servers))
            self._servers.pop(oldest_name, None)
            self._logger.debug(f"Evicted cached metadata for {oldest_name}")
    
    # Backwards compatibility
    async def _cleanup_old_connections(self) -> None:
        self._cleanup_old_servers()
    
    async def disconnect_server(self, qualified_name: str) -> None:
        """Remove cached server metadata. No connections to close (they're ephemeral)."""
        if qualified_name in self._servers:
            self._servers.pop(qualified_name, None)
            self._logger.debug(f"Removed cached metadata for {qualified_name}")
    
    async def disconnect_all(self) -> None:
        """Clear all cached server metadata."""
        self._servers.clear()
        self._logger.debug("Cleared all cached MCP server metadata")
    
    def get_connection(self, qualified_name: str) -> Optional[MCPServerInfo]:
        """Get cached server info, updating LRU position."""
        if qualified_name in self._servers:
            self._servers.move_to_end(qualified_name)
            return self._servers[qualified_name][0]
        return None
    
    def get_all_connections(self) -> List[MCPServerInfo]:
        """Get all cached server infos."""
        return [info for info, _ in self._servers.values()]

    def get_all_tools_openapi(self) -> List[Dict[str, Any]]:
        """Get OpenAPI-formatted tools from all cached servers."""
        tools = []
        
        for server_info in self.get_all_connections():
            if not server_info.tools:
                continue
            
            for tool in server_info.tools:
                if tool.name not in server_info.enabled_tools:
                    continue
                
                openapi_tool = {
                    "type": "function",
                    "function": {
                        "name": tool.name,
                        "description": tool.description,
                        "parameters": tool.inputSchema
                    }
                }
                tools.append(openapi_tool)
        
        return tools
    
    async def execute_tool(self, tool_name: str, arguments: Dict[str, Any], external_user_id: Optional[str] = None) -> ToolExecutionResult:
        """
        Execute a tool with a fresh ephemeral connection.
        
        Pattern: connect -> execute -> disconnect
        This prevents connection leaks.
        """
        request = ToolExecutionRequest(
            tool_name=tool_name,
            arguments=arguments,
            external_user_id=external_user_id
        )
        return await self._execute_tool_internal(request)
    
    async def _execute_tool_internal(self, request: ToolExecutionRequest) -> ToolExecutionResult:
        self._logger.debug(f"Executing tool: {request.tool_name}")
        
        # Find which server has this tool
        server_info = self._find_tool_server(request.tool_name)
        if not server_info:
            raise MCPToolNotFoundError(f"Tool not found: {request.tool_name}")
        
        if request.tool_name not in server_info.enabled_tools:
            raise MCPToolExecutionError(f"Tool not enabled: {request.tool_name}")
        
        if not server_info.server_url:
            raise MCPToolExecutionError(f"No server URL for tool: {request.tool_name}")
        
        try:
            # Create fresh ephemeral connection for this execution
            async with asyncio.timeout(30):
                async with streamablehttp_client(server_info.server_url, headers=server_info.headers or {}) as (
                    read_stream, write_stream, _
                ):
                    async with ClientSession(read_stream, write_stream) as session:
                        await session.initialize()
                        result = await session.call_tool(request.tool_name, request.arguments)
            # Connection closed here (context manager exited)
            
            self._logger.debug(f"Tool {request.tool_name} executed successfully")
            
            # Extract result content
            if hasattr(result, 'content'):
                content = result.content
                if isinstance(content, list) and content:
                    if hasattr(content[0], 'text'):
                        result_data = content[0].text
                    else:
                        result_data = str(content[0])
                else:
                    result_data = str(content)
            else:
                result_data = str(result)
            
            return ToolExecutionResult(
                success=True,
                result=result_data
            )
            
        except asyncio.TimeoutError:
            error_msg = f"Tool execution timeout for {request.tool_name}"
            self._logger.error(error_msg)
            return ToolExecutionResult(success=False, result=None, error=error_msg)
        except Exception as e:
            error_msg = f"Tool execution failed: {str(e)}"
            self._logger.error(error_msg)
            return ToolExecutionResult(success=False, result=None, error=error_msg)
    
    def _find_tool_server(self, tool_name: str) -> Optional[MCPServerInfo]:
        """Find which cached server has the given tool."""
        for server_info in self.get_all_connections():
            if not server_info.tools:
                continue
            
            for tool in server_info.tools:
                if tool.name == tool_name:
                    # Update LRU position
                    if server_info.qualified_name in self._servers:
                        self._servers.move_to_end(server_info.qualified_name)
                    return server_info
        
        return None
    
    # Backwards compatibility alias
    def _find_tool_connection(self, tool_name: str) -> Optional[MCPServerInfo]:
        return self._find_tool_server(tool_name)

    async def discover_custom_tools(self, request_type: str, config: Dict[str, Any]) -> CustomMCPConnectionResult:
        if request_type == "http":
            return await self._discover_http_tools(config)
        elif request_type == "sse":
            return await self._discover_sse_tools(config)
        else:
            raise CustomMCPError(f"Unsupported request type: {request_type}")
    
    async def _discover_http_tools(self, config: Dict[str, Any]) -> CustomMCPConnectionResult:
        url = config.get("url")
        if not url:
            raise CustomMCPError("URL is required for HTTP MCP connections")
        
        # Validate URL safety (only block private URLs in non-local environments)
        if app_config.ENV_MODE != EnvMode.LOCAL:
            is_safe, error_msg = is_safe_url(url)
            if not is_safe:
                return CustomMCPConnectionResult(
                    success=False,
                    qualified_name="",
                    display_name="",
                    tools=[],
                    config=config,
                    url=url,
                    message=f"Private/local MCP servers are not allowed in production: {error_msg}"
                )
        
        try:
            async with streamablehttp_client(url) as (read_stream, write_stream, _):
                async with ClientSession(read_stream, write_stream) as session:
                    await session.initialize()
                    tool_result = await session.list_tools()
                    
                    tools_info = []
                    for tool in tool_result.tools:
                        tools_info.append({
                            "name": tool.name,
                            "description": tool.description,
                            "inputSchema": tool.inputSchema
                        })
                    
                    return CustomMCPConnectionResult(
                        success=True,
                        qualified_name=f"custom_http_{url.split('/')[-1]}",
                        display_name=f"Custom HTTP MCP ({url})",
                        tools=tools_info,
                        config=config,
                        url=url,
                        message=f"Connected via HTTP ({len(tools_info)} tools)"
                    )
        
        except Exception as e:
            self._logger.error(f"Error connecting to HTTP MCP server: {str(e)}")
            return CustomMCPConnectionResult(
                success=False,
                qualified_name="",
                display_name="",
                tools=[],
                config=config,
                url=url,
                message=f"Failed to connect: {str(e)}"
            )
    
    async def _discover_sse_tools(self, config: Dict[str, Any]) -> CustomMCPConnectionResult:
        url = config.get("url")
        if not url:
            raise CustomMCPError("URL is required for SSE MCP connections")
        
        # Validate URL safety (only block private URLs in non-local environments)
        if app_config.ENV_MODE != EnvMode.LOCAL:
            is_safe, error_msg = is_safe_url(url)
            if not is_safe:
                return CustomMCPConnectionResult(
                    success=False,
                    qualified_name="",
                    display_name="",
                    tools=[],
                    config=config,
                    url=url,
                    message=f"Private/local MCP servers are not allowed in production: {error_msg}"
                )
        
        try:
            async with sse_client(url) as (read_stream, write_stream):
                async with ClientSession(read_stream, write_stream) as session:
                    await session.initialize()
                    tool_result = await session.list_tools()
                    
                    tools_info = []
                    for tool in tool_result.tools:
                        tools_info.append({
                            "name": tool.name,
                            "description": tool.description,
                            "inputSchema": tool.inputSchema
                        })
                    
                    return CustomMCPConnectionResult(
                        success=True,
                        qualified_name=f"custom_sse_{url.split('/')[-1]}",
                        display_name=f"Custom SSE MCP ({url})",
                        tools=tools_info,
                        config=config,
                        url=url,
                        message=f"Connected via SSE ({len(tools_info)} tools)"
                    )
        
        except Exception as e:
            self._logger.error(f"Error connecting to SSE MCP server: {str(e)}")
            return CustomMCPConnectionResult(
                success=False,
                qualified_name="",
                display_name="",
                tools=[],
                config=config,
                url=url,
                message=f"Failed to connect: {str(e)}"
            )

    async def _get_server_url(self, qualified_name: str, config: Dict[str, Any], provider: str) -> str:
        if provider in ['custom', 'http', 'sse']:
            return await self._get_custom_server_url(qualified_name, config)
        elif provider == 'composio':
            return await self._get_composio_server_url(qualified_name, config)
        else:
            raise MCPProviderError(f"Unknown provider type: {provider}")
    
    def _get_headers(self, qualified_name: str, config: Dict[str, Any], provider: str, external_user_id: Optional[str] = None) -> Dict[str, str]:
        if provider in ['custom', 'http', 'sse']:
            return self._get_custom_headers(qualified_name, config, external_user_id)
        elif provider == 'composio':
            return self._get_composio_headers(qualified_name, config, external_user_id)
        else:
            raise MCPProviderError(f"Unknown provider type: {provider}")
    
    async def _get_custom_server_url(self, qualified_name: str, config: Dict[str, Any]) -> str:
        url = config.get("url")
        if not url:
            raise MCPProviderError(f"URL not provided for custom MCP server: {qualified_name}")
        return url
    
    def _get_custom_headers(self, qualified_name: str, config: Dict[str, Any], external_user_id: Optional[str] = None) -> Dict[str, str]:
        headers = {"Content-Type": "application/json"}
        
        if "headers" in config:
            headers.update(config["headers"])
        
        if external_user_id:
            headers["X-External-User-Id"] = external_user_id
        
        return headers
    
    async def _get_composio_server_url(self, qualified_name: str, config: Dict[str, Any]) -> str:
        """Resolve Composio profile_id to actual MCP URL"""
        profile_id = config.get("profile_id")
        if not profile_id:
            raise MCPProviderError(f"profile_id not provided for Composio MCP server: {qualified_name}")
        
        # Import here to avoid circular dependency
        from core.composio_integration.composio_profile_service import ComposioProfileService
        from core.services.supabase import DBConnection
        
        try:
            db = DBConnection()
            profile_service = ComposioProfileService(db)
            mcp_url = await profile_service.get_mcp_url_for_runtime(profile_id)
            
            self._logger.debug(f"Resolved Composio profile {profile_id} to MCP URL {mcp_url}")
            return mcp_url
            
        except Exception as e:
            self._logger.error(f"Failed to resolve Composio profile {profile_id}: {str(e)}")
            raise MCPProviderError(f"Failed to resolve Composio profile: {str(e)}")
    
    def _get_composio_headers(self, qualified_name: str, config: Dict[str, Any], external_user_id: Optional[str] = None) -> Dict[str, str]:
        """Get headers for Composio MCP connection"""
        headers = {"Content-Type": "application/json"}
        # Composio handles auth through the URL itself
        return headers


mcp_service = MCPService()
