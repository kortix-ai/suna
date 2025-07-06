"""
MCP Tool Wrapper for AgentPress

This module provides a generic tool wrapper that handles all MCP (Model Context Protocol) 
server tool calls through dynamically generated individual function methods.
"""

import json
from typing import Any, Dict, List, Optional
from agentpress.tool import Tool, ToolResult, openapi_schema, xml_schema, ToolSchema, SchemaType
from mcp_service.client import MCPManager
from utils.logger import logger
import inspect
from mcp import ClientSession
from mcp.client.sse import sse_client
from mcp.client.stdio import stdio_client
from mcp.client.streamable_http import streamablehttp_client
from mcp import StdioServerParameters
import asyncio


class MCPToolWrapper(Tool):
    """
    A generic tool wrapper that dynamically creates individual methods for each MCP tool.
    
    This tool creates separate function calls for each MCP tool while routing them all
    through the same underlying implementation.
    """
    
    def __init__(self, mcp_configs: Optional[List[Dict[str, Any]]] = None):
        """
        Initialize the MCP tool wrapper.
        
        Args:
            mcp_configs: List of MCP configurations from agent's configured_mcps
        """
        # Don't call super().__init__() yet - we need to set up dynamic methods first
        self.mcp_manager = MCPManager()
        self.mcp_configs = mcp_configs or []
        self._initialized = False
        self._dynamic_tools = {}
        self._schemas: Dict[str, List[ToolSchema]] = {}
        self._custom_tools = {}  # Store custom MCP tools separately
        
        # Now initialize the parent class which will call _register_schemas
        super().__init__()
        
    async def _ensure_initialized(self):
        """Ensure MCP servers are initialized."""
        if not self._initialized:
            # Initialize standard MCP servers from Smithery
            standard_configs = [cfg for cfg in self.mcp_configs if not cfg.get('isCustom', False)]
            custom_configs = [cfg for cfg in self.mcp_configs if cfg.get('isCustom', False)]
            
            # Initialize standard MCPs through MCPManager
            if standard_configs:
                for config in standard_configs:
                    try:
                        logger.info(f"Attempting to connect to MCP server: {config['qualifiedName']}")
                        await self.mcp_manager.connect_server(config)
                        logger.info(f"Successfully connected to MCP server: {config['qualifiedName']}")
                    except Exception as e:
                        logger.error(f"Failed to connect to MCP server {config['qualifiedName']}: {e}")
                        import traceback
                        logger.error(f"Full traceback: {traceback.format_exc()}")
            
            # Initialize custom MCPs directly
            if custom_configs:
                await self._initialize_custom_mcps(custom_configs)
            
            # Create dynamic tools for all connected servers
            await self._create_dynamic_tools()
            self._initialized = True
    
    async def _connect_sse_server(self, server_name, server_config, all_tools, timeout):
        url = server_config["url"]
        headers = server_config.get("headers", {})
        
        async with asyncio.timeout(timeout):
            try:
                async with sse_client(url, headers=headers) as (read, write):
                    async with ClientSession(read, write) as session:
                        await session.initialize()
                        tools_result = await session.list_tools()
                        tools_info = []
                        for tool in tools_result.tools:
                            tool_info = {
                                "name": tool.name,
                                "description": tool.description,
                                "input_schema": tool.inputSchema
                            }
                            tools_info.append(tool_info)
                        
                        all_tools[server_name] = {
                            "status": "connected",
                            "transport": "sse",
                            "url": url,
                            "tools": tools_info
                        }
                        
                        logger.info(f"  {server_name}: Connected via SSE ({len(tools_info)} tools)")
            except TypeError as e:
                if "unexpected keyword argument" in str(e):
                    async with sse_client(url) as (read, write):
                        async with ClientSession(read, write) as session:
                            await session.initialize()
                            tools_result = await session.list_tools()
                            tools_info = []
                            for tool in tools_result.tools:
                                tool_info = {
                                    "name": tool.name,
                                    "description": tool.description,
                                    "input_schema": tool.inputSchema
                                }
                                tools_info.append(tool_info)
                            
                            all_tools[server_name] = {
                                "status": "connected",
                                "transport": "sse",
                                "url": url,
                                "tools": tools_info
                            }
                            logger.info(f"  {server_name}: Connected via SSE ({len(tools_info)} tools)")
                else:
                    raise
    
    async def _connect_streamable_http_server(self, url):
        async with streamablehttp_client(url) as (
            read_stream,
            write_stream,
            _,
        ):
            async with ClientSession(read_stream, write_stream) as session:
                await session.initialize()
                tool_result = await session.list_tools()
                print(f"Connected via HTTP ({len(tool_result.tools)} tools)")
                
                tools_info = []
                for tool in tool_result.tools:
                    tool_info = {
                        "name": tool.name,
                        "description": tool.description,
                        "inputSchema": tool.inputSchema
                    }
                    tools_info.append(tool_info)
                
                return tools_info
        
    async def _connect_stdio_server(self, server_name, server_config, all_tools, timeout):
        """Connect to a stdio-based MCP server."""
        server_params = StdioServerParameters(
            command=server_config["command"],
            args=server_config.get("args", []),
            env=server_config.get("env", {})
        )
        
        async with asyncio.timeout(timeout):
            async with stdio_client(server_params) as (read, write):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    tools_result = await session.list_tools()
                    tools_info = []
                    for tool in tools_result.tools:
                        tool_info = {
                            "name": tool.name,
                            "description": tool.description,
                            "input_schema": tool.inputSchema
                        }
                        tools_info.append(tool_info)
                    
                    all_tools[server_name] = {
                        "status": "connected",
                        "transport": "stdio",
                        "tools": tools_info
                    }
                    
                    logger.info(f"  {server_name}: Connected via stdio ({len(tools_info)} tools)")

    async def _initialize_custom_mcps(self, custom_configs):
        """Initialize custom MCP servers."""
        for config in custom_configs:
            try:
                logger.info(f"Initializing custom MCP: {config}")
                custom_type = config.get('customType', 'sse')
                server_config = config.get('config', {})
                enabled_tools = config.get('enabledTools', [])
                server_name = config.get('name', 'Unknown')
                
                logger.info(f"Initializing custom MCP: {server_name} (type: {custom_type})")
                
                if custom_type == 'sse':
                    if 'url' not in server_config:
                        logger.error(f"Custom MCP {server_name}: Missing 'url' in config")
                        continue
                        
                    url = server_config['url']
                    logger.info(f"Initializing custom MCP {url} with SSE type")
                    
                    try:
                        # Use the working connect_sse_server method
                        all_tools = {}
                        await self._connect_sse_server(server_name, server_config, all_tools, 15)
                        
                        # Process the results
                        if server_name in all_tools and all_tools[server_name].get('status') == 'connected':
                            tools_info = all_tools[server_name].get('tools', [])
                            tools_registered = 0
                            
                            for tool_info in tools_info:
                                tool_name_from_server = tool_info['name']
                                if not enabled_tools or tool_name_from_server in enabled_tools:
                                    tool_name = f"custom_{server_name.replace(' ', '_').lower()}_{tool_name_from_server}"
                                    self._custom_tools[tool_name] = {
                                        'name': tool_name,
                                        'description': tool_info['description'],
                                        'parameters': tool_info['input_schema'],
                                        'server': server_name,
                                        'original_name': tool_name_from_server,
                                        'is_custom': True,
                                        'custom_type': custom_type,
                                        'custom_config': server_config
                                    }
                                    tools_registered += 1
                                    logger.debug(f"Registered custom tool: {tool_name}")
                            
                            logger.info(f"Successfully initialized custom MCP {server_name} with {tools_registered} tools")
                        else:
                            logger.error(f"Failed to connect to custom MCP {server_name}")
                            
                    except Exception as e:
                        logger.error(f"Custom MCP {server_name}: Connection failed - {str(e)}")
                        continue
                
                elif custom_type == 'http':
                    if 'url' not in server_config:
                        logger.error(f"Custom MCP {server_name}: Missing 'url' in config")
                        continue
                        
                    url = server_config['url']
                    logger.info(f"Initializing custom MCP {url} with HTTP type")
                    
                    try:

                        tools_info = await self._connect_streamable_http_server(url)
                        tools_registered = 0
                        
                        for tool_info in tools_info:
                            tool_name_from_server = tool_info['name']
                            if not enabled_tools or tool_name_from_server in enabled_tools:
                                tool_name = f"custom_{server_name.replace(' ', '_').lower()}_{tool_name_from_server}"
                                self._custom_tools[tool_name] = {
                                    'name': tool_name,
                                    'description': tool_info['description'],
                                    'parameters': tool_info['inputSchema'],
                                    'server': server_name,
                                    'original_name': tool_name_from_server,
                                    'is_custom': True,
                                    'custom_type': custom_type,
                                    'custom_config': server_config
                                }
                                tools_registered += 1
                                logger.debug(f"Registered custom tool: {tool_name}")
                        
                        logger.info(f"Successfully initialized custom MCP {server_name} with {tools_registered} tools")
                            
                    except Exception as e:
                        logger.error(f"Custom MCP {server_name}: Connection failed - {str(e)}")
                        continue
                        
                elif custom_type == 'json':
                    if 'command' not in server_config:
                        logger.error(f"Custom MCP {server_name}: Missing 'command' in config")
                        continue
                        
                    logger.info(f"Initializing custom MCP {server_name} with JSON/stdio type")
                    
                    try:
                        # Use the stdio connection method
                        all_tools = {}
                        await self._connect_stdio_server(server_name, server_config, all_tools, 15)
                        
                        # Process the results
                        if server_name in all_tools and all_tools[server_name].get('status') == 'connected':
                            tools_info = all_tools[server_name].get('tools', [])
                            tools_registered = 0
                            
                            for tool_info in tools_info:
                                tool_name_from_server = tool_info['name']
                                if not enabled_tools or tool_name_from_server in enabled_tools:
                                    tool_name = f"custom_{server_name.replace(' ', '_').lower()}_{tool_name_from_server}"
                                    self._custom_tools[tool_name] = {
                                        'name': tool_name,
                                        'description': tool_info['description'],
                                        'parameters': tool_info['input_schema'],
                                        'server': server_name,
                                        'original_name': tool_name_from_server,
                                        'is_custom': True,
                                        'custom_type': custom_type,
                                        'custom_config': server_config
                                    }
                                    tools_registered += 1
                                    logger.debug(f"Registered custom tool: {tool_name}")
                            
                            logger.info(f"Successfully initialized custom MCP {server_name} with {tools_registered} tools")
                        else:
                            logger.error(f"Failed to connect to custom MCP {server_name}")
                            
                    except Exception as e:
                        logger.error(f"Custom MCP {server_name}: Connection failed - {str(e)}")
                        continue
                        
                else:
                    logger.error(f"Custom MCP {server_name}: Unsupported type '{custom_type}', supported types are 'sse', 'http' and 'json'")
                    continue
                    
            except Exception as e:
                logger.error(f"Failed to initialize custom MCP {config.get('name', 'Unknown')}: {e}")
                continue
    
    async def initialize_and_register_tools(self, tool_registry=None):
        """Initialize MCP tools and optionally update the tool registry.
        
        This method should be called after the tool has been registered to dynamically
        add the MCP tool schemas to the registry.
        
        Args:
            tool_registry: Optional ToolRegistry instance to update with new schemas
        """
        await self._ensure_initialized()
        
        if tool_registry and self._dynamic_tools:
            logger.info(f"Updating tool registry with {len(self._dynamic_tools)} MCP tools")
            for method_name, schemas in self._schemas.items():
                if method_name not in ['call_mcp_tool']:  # Skip the fallback method
                    pass
    
    async def _create_dynamic_tools(self):
        """Create dynamic tool methods for each available MCP tool."""
        try:
            # Get standard MCP tools
            available_tools = self.mcp_manager.get_all_tools_openapi()
            logger.info(f"MCPManager returned {len(available_tools)} tools")
            
            for tool_info in available_tools:
                tool_name = tool_info.get('name', '')
                logger.info(f"Processing tool: {tool_name}")
                if tool_name:
                    # Create a dynamic method for this tool with proper OpenAI schema
                    self._create_dynamic_method(tool_name, tool_info)
            
            # Get custom MCP tools
            logger.info(f"Processing {len(self._custom_tools)} custom MCP tools")
            for tool_name, tool_info in self._custom_tools.items():
                logger.info(f"Processing custom tool: {tool_name}")
                # Convert custom tool info to the expected format
                openapi_tool_info = {
                    "name": tool_name,
                    "description": tool_info['description'],
                    "parameters": tool_info['parameters']
                }
                self._create_dynamic_method(tool_name, openapi_tool_info)
                    
            logger.info(f"Created {len(self._dynamic_tools)} dynamic MCP tool methods")
            
        except Exception as e:
            logger.error(f"Error creating dynamic MCP tools: {e}")
    
    def _create_dynamic_method(self, tool_name: str, tool_info: Dict[str, Any]):
        """Create a dynamic method for a specific MCP tool with proper OpenAI schema."""
        if tool_name.startswith("custom_"):
            if tool_name in self._custom_tools:
                clean_tool_name = self._custom_tools[tool_name]['original_name']
                server_name = self._custom_tools[tool_name]['server']
            else:
                parts = tool_name.split("_")
                if len(parts) >= 3:
                    clean_tool_name = "_".join(parts[2:])
                    server_name = parts[1] if len(parts) > 1 else "unknown"
                else:
                    clean_tool_name = tool_name
                    server_name = "unknown"
        else:
            parts = tool_name.split("_", 2)
            clean_tool_name = parts[2] if len(parts) > 2 else tool_name
            server_name = parts[1] if len(parts) > 1 else "unknown"

        method_name = clean_tool_name.replace('-', '_')
        
        logger.info(f"Creating dynamic method for tool '{tool_name}': clean_tool_name='{clean_tool_name}', method_name='{method_name}', server='{server_name}'")

        original_full_name = tool_name
        
        # Create the dynamic method
        async def dynamic_tool_method(**kwargs) -> ToolResult:
            """Dynamically created method for MCP tool."""
            # Use the original full tool name for execution
            return await self._execute_mcp_tool(original_full_name, kwargs)
        
        # Set the method name to match the tool name
        dynamic_tool_method.__name__ = method_name
        dynamic_tool_method.__qualname__ = f"{self.__class__.__name__}.{method_name}"
        
        # Build a more descriptive description
        base_description = tool_info.get("description", f"MCP tool from {server_name}")
        full_description = f"{base_description} (MCP Server: {server_name})"
        
        # Create the OpenAI schema for this tool
        openapi_function_schema = {
            "type": "function",
            "function": {
                "name": method_name,  # Use the clean method name for function calling
                "description": full_description,
                "parameters": tool_info.get("parameters", {
                    "type": "object",
                    "properties": {},
                    "required": []
                })
            }
        }
        
        # Create a ToolSchema object
        tool_schema = ToolSchema(
            schema_type=SchemaType.OPENAPI,
            schema=openapi_function_schema
        )
        
        # Add the schema to our schemas dict
        self._schemas[method_name] = [tool_schema]
        
        # Also add the schema to the method itself (for compatibility)
        dynamic_tool_method.tool_schemas = [tool_schema]
        
        # Store the method and its info
        self._dynamic_tools[tool_name] = {
            'method': dynamic_tool_method,
            'method_name': method_name,
            'original_tool_name': tool_name,
            'clean_tool_name': clean_tool_name,
            'server_name': server_name,
            'info': tool_info,
            'schema': tool_schema
        }
        
        # Add the method to this instance
        setattr(self, method_name, dynamic_tool_method)
        
        logger.debug(f"Created dynamic method '{method_name}' for MCP tool '{tool_name}' from server '{server_name}'")
    
    def _register_schemas(self):
        """Register schemas from all decorated methods and dynamic tools."""
        # First register static schemas from decorated methods
        for name, method in inspect.getmembers(self, predicate=inspect.ismethod):
            if hasattr(method, 'tool_schemas'):
                self._schemas[name] = method.tool_schemas
                logger.debug(f"Registered schemas for method '{name}' in {self.__class__.__name__}")
        
        # Note: Dynamic schemas will be added after async initialization
        logger.debug(f"Initial registration complete for MCPToolWrapper")
    
    def get_schemas(self) -> Dict[str, List[ToolSchema]]:
        """Get all registered tool schemas including dynamic ones."""
        # Return all schemas including dynamically added ones
        return self._schemas
    
    def __getattr__(self, name: str):
        """Handle calls to dynamically created MCP tool methods."""
        # Look for exact method name match first
        for tool_data in self._dynamic_tools.values():
            if tool_data['method_name'] == name:
                return tool_data['method']
        
        # Try with underscore/hyphen conversion
        name_with_hyphens = name.replace('_', '-')
        for tool_name, tool_data in self._dynamic_tools.items():
            if tool_data['method_name'] == name or tool_name == name_with_hyphens:
                return tool_data['method']
        
        raise AttributeError(f"'{self.__class__.__name__}' object has no attribute '{name}'")
            
    async def get_available_tools(self) -> List[Dict[str, Any]]:
        """Get all available MCP tools in OpenAPI format."""
        await self._ensure_initialized()
        return self.mcp_manager.get_all_tools_openapi()
    
    async def _execute_mcp_tool(self, tool_name: str, arguments: Dict[str, Any]) -> ToolResult:
        """Execute an MCP tool call."""
        await self._ensure_initialized()
        logger.info(f"Executing MCP tool {tool_name} with arguments {arguments}")
        try:
            # Check if it's a custom MCP tool first
            if tool_name in self._custom_tools:
                tool_info = self._custom_tools[tool_name]
                return await self._execute_custom_mcp_tool(tool_name, arguments, tool_info)
            else:
                # Use standard MCP manager for Smithery servers
                result = await self.mcp_manager.execute_tool(tool_name, arguments)
                
                if isinstance(result, dict):
                    if result.get('isError', False):
                        return self.fail_response(result.get('content', 'Tool execution failed'))
                    else:
                        return self.success_response(result.get('content', result))
                else:
                    return self.success_response(result)
                    
        except Exception as e:
            logger.error(f"Error executing MCP tool {tool_name}: {str(e)}")
            return self.fail_response(f"Error executing tool: {str(e)}")
    
    async def _execute_custom_mcp_tool(self, tool_name: str, arguments: Dict[str, Any], tool_info: Dict[str, Any]) -> ToolResult:
        """Execute a custom MCP tool call."""
        try:
            custom_type = tool_info['custom_type']
            custom_config = tool_info['custom_config']
            original_tool_name = tool_info['original_name']
            
            if custom_type == 'sse':
                # Execute SSE-based custom MCP using the same pattern as _connect_sse_server
                url = custom_config['url']
                headers = custom_config.get('headers', {})
                
                async with asyncio.timeout(30):  # 30 second timeout for tool execution
                    try:
                        # Try with headers first (same pattern as _connect_sse_server)
                        async with sse_client(url, headers=headers) as (read, write):
                            async with ClientSession(read, write) as session:
                                await session.initialize()
                                result = await session.call_tool(original_tool_name, arguments)
                                
                                # Handle the result properly
                                if hasattr(result, 'content'):
                                    content = result.content
                                    if isinstance(content, list):
                                        # Extract text from content list
                                        text_parts = []
                                        for item in content:
                                            if hasattr(item, 'text'):
                                                text_parts.append(item.text)
                                            else:
                                                text_parts.append(str(item))
                                        content_str = "\n".join(text_parts)
                                    elif hasattr(content, 'text'):
                                        content_str = content.text
                                    else:
                                        content_str = str(content)
                                    
                                    return self.success_response(content_str)
                                else:
                                    return self.success_response(str(result))
                                    
                    except TypeError as e:
                        if "unexpected keyword argument" in str(e):
                            # Fallback: try without headers (exact pattern from _connect_sse_server)
                            async with sse_client(url) as (read, write):
                                async with ClientSession(read, write) as session:
                                    await session.initialize()
                                    result = await session.call_tool(original_tool_name, arguments)
                                    
                                    # Handle the result properly
                                    if hasattr(result, 'content'):
                                        content = result.content
                                        if isinstance(content, list):
                                            # Extract text from content list
                                            text_parts = []
                                            for item in content:
                                                if hasattr(item, 'text'):
                                                    text_parts.append(item.text)
                                                else:
                                                    text_parts.append(str(item))
                                            content_str = "\n".join(text_parts)
                                        elif hasattr(content, 'text'):
                                            content_str = content.text
                                        else:
                                            content_str = str(content)
                                        
                                        return self.success_response(content_str)
                                    else:
                                        return self.success_response(str(result))
                        else:
                            raise
            
            elif custom_type == 'http':
                # Execute HTTP-based custom MCP
                url = custom_config['url']
                
                async with asyncio.timeout(30):  # 30 second timeout for tool execution
                    async with streamablehttp_client(url) as (read, write, _):
                        async with ClientSession(read, write) as session:
                            await session.initialize()
                            result = await session.call_tool(original_tool_name, arguments)
                            
                            # Handle the result properly
                            if hasattr(result, 'content'):
                                content = result.content
                                if isinstance(content, list):
                                    # Extract text from content list
                                    text_parts = []
                                    for item in content:
                                        if hasattr(item, 'text'):
                                            text_parts.append(item.text)
                                        else:
                                            text_parts.append(str(item))
                                    content_str = "\n".join(text_parts)
                                elif hasattr(content, 'text'):
                                    content_str = content.text
                                else:
                                    content_str = str(content)
                                
                                return self.success_response(content_str)
                            else:
                                return self.success_response(str(result))
                                
            elif custom_type == 'json':
                # Execute stdio-based custom MCP using the same pattern as _connect_stdio_server
                server_params = StdioServerParameters(
                    command=custom_config["command"],
                    args=custom_config.get("args", []),
                    env=custom_config.get("env", {})
                )
                
                async with asyncio.timeout(30):  # 30 second timeout for tool execution
                    async with stdio_client(server_params) as (read, write):
                        async with ClientSession(read, write) as session:
                            await session.initialize()
                            result = await session.call_tool(original_tool_name, arguments)
                            
                            # Handle the result properly
                            if hasattr(result, 'content'):
                                content = result.content
                                if isinstance(content, list):
                                    # Extract text from content list
                                    text_parts = []
                                    for item in content:
                                        if hasattr(item, 'text'):
                                            text_parts.append(item.text)
                                        else:
                                            text_parts.append(str(item))
                                    content_str = "\n".join(text_parts)
                                elif hasattr(content, 'text'):
                                    content_str = content.text
                                else:
                                    content_str = str(content)
                                
                                return self.success_response(content_str)
                            else:
                                return self.success_response(str(result))
            else:
                return self.fail_response(f"Unsupported custom MCP type: {custom_type}")
                                
        except asyncio.TimeoutError:
            return self.fail_response(f"Tool execution timeout for {tool_name}")
        except Exception as e:
            logger.error(f"Error executing custom MCP tool {tool_name}: {str(e)}")
            return self.fail_response(f"Error executing custom tool: {str(e)}")
    
    # Keep the original call_mcp_tool method as a fallback
    @openapi_schema({
        "type": "function",
        "function": {
            "name": "call_mcp_tool",
            "description": "Execute a tool from any connected MCP server. This is a fallback wrapper that forwards calls to MCP tools. The tool_name should be in the format 'mcp_{server}_{tool}' where {server} is the MCP server's qualified name and {tool} is the specific tool name.",
            "parameters": {
                "type": "object",
                "properties": {
                    "tool_name": {
                        "type": "string",
                        "description": "The full MCP tool name in format 'mcp_{server}_{tool}', e.g., 'mcp_exa_web_search_exa'"
                    },
                    "arguments": {
                        "type": "object",
                        "description": "The arguments to pass to the MCP tool, as a JSON object. The required arguments depend on the specific tool being called.",
                        "additionalProperties": True
                    }
                },
                "required": ["tool_name", "arguments"]
            }
        }
    })
    @xml_schema(
        tag_name="call-mcp-tool",
        mappings=[
            {"param_name": "tool_name", "node_type": "attribute", "path": "."},
            {"param_name": "arguments", "node_type": "content", "path": "."}
        ],
        example='''
        <function_calls>
        <invoke name="call_mcp_tool">
        <parameter name="tool_name">mcp_exa_web_search_exa</parameter>
        <parameter name="arguments">{"query": "latest developments in AI", "num_results": 10}</parameter>
        </invoke>
        </function_calls>
        '''
    )
    async def call_mcp_tool(self, tool_name: str, arguments: Dict[str, Any]) -> ToolResult:
        """
        Execute an MCP tool call (fallback method).
        
        Args:
            tool_name: The full MCP tool name (e.g., "mcp_exa_web_search_exa")
            arguments: The arguments to pass to the tool
            
        Returns:
            ToolResult with the tool execution result
        """
        return await self._execute_mcp_tool(tool_name, arguments)
            
    async def cleanup(self):
        """Disconnect all MCP servers."""
        if self._initialized:
            try:
                await self.mcp_manager.disconnect_all()
            except Exception as e:
                logger.error(f"Error during MCP cleanup: {str(e)}")
            finally:
                self._initialized = False 