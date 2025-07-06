"""
MCP Client module for connecting to and using MCP servers

This module handles:
1. Connecting to MCP servers via Smithery
2. Converting MCP tools to OpenAPI format for LLMs
3. Executing MCP tool calls
"""

import asyncio
import json
import base64
from typing import Dict, List, Any, Optional, Tuple
from dataclasses import dataclass

# Import MCP components according to the official SDK
from mcp import ClientSession
try:
    from mcp.client.streamable_http import streamablehttp_client
except ImportError:
    # Fallback import if the module structure is different
    try:
        from mcp.client import streamablehttp_client
    except ImportError:
        raise ImportError(
            "Could not import streamablehttp_client. "
            "Make sure you have installed mcp with: pip install 'mcp[cli]'"
        )

# Import types - these should be in mcp.types according to the docs
try:
    from mcp.types import Tool, CallToolResult as ToolResult
except ImportError:
    # Fallback to a different location if needed
    try:
        from mcp import types
        Tool = types.Tool
        ToolResult = types.CallToolResult
    except AttributeError:
        # If CallToolResult doesn't exist, create a simple class
        Tool = Any
        ToolResult = Any

from utils.logger import logger
import os

# Get Smithery API key from environment
SMITHERY_API_KEY = os.getenv("SMITHERY_API_KEY")
SMITHERY_SERVER_BASE_URL = "https://server.smithery.ai"

@dataclass
class MCPConnection:
    """Represents a connection to an MCP server"""
    qualified_name: str
    name: str
    config: Dict[str, Any]
    enabled_tools: List[str]
    session: Optional[ClientSession] = None
    tools: Optional[List[Tool]] = None
    
class MCPManager:
    """Manages connections to multiple MCP servers"""
    
    def __init__(self):
        self.connections: Dict[str, MCPConnection] = {}
        self._sessions: Dict[str, Tuple[Any, Any, Any]] = {}  # Store streams for cleanup
        
    async def connect_server(self, mcp_config: Dict[str, Any]) -> MCPConnection:
        """
        Connect to an MCP server using configuration
        
        Args:
            mcp_config: Configuration from agent's configured_mcps field
                {
                    "name": "Exa Search",
                    "qualifiedName": "exa",
                    "config": {"exaApiKey": "xxx"},
                    "enabledTools": ["web_search_exa"]
                }
        """
        qualified_name = mcp_config["qualifiedName"]
        
        # Check if already connected
        if qualified_name in self.connections:
            logger.info(f"MCP server {qualified_name} already connected")
            return self.connections[qualified_name]
            
        logger.info(f"Connecting to MCP server: {qualified_name}")
        
        # Check if Smithery API key is available
        if not SMITHERY_API_KEY:
            raise ValueError(
                "SMITHERY_API_KEY environment variable is not set. "
                "Please set it to use MCP servers from Smithery."
            )
        
        try:
            # Encode config in base64
            config_json = json.dumps(mcp_config["config"])
            config_b64 = base64.b64encode(config_json.encode()).decode()
            
            # Create server URL
            url = f"{SMITHERY_SERVER_BASE_URL}/{qualified_name}/mcp?config={config_b64}&api_key={SMITHERY_API_KEY}"
            
            # Test connection and get available tools
            async with streamablehttp_client(url) as (read_stream, write_stream, _):
                async with ClientSession(read_stream, write_stream) as session:
                    # Initialize the connection
                    await session.initialize()
                    logger.info(f"MCP session initialized for {qualified_name}")
                    
                    # List available tools
                    tools_result = await session.list_tools()
            tools = tools_result.tools if hasattr(tools_result, 'tools') else tools_result
            
            logger.info(f"Available tools from {qualified_name}: {[t.name for t in tools]}")
            
            # Create connection object (without persistent session)
            connection = MCPConnection(
                qualified_name=qualified_name,
                name=mcp_config["name"],
                config=mcp_config["config"],
                enabled_tools=mcp_config.get("enabledTools", []),
                session=None,  # No persistent session
                tools=tools
            )
            
            self.connections[qualified_name] = connection
            return connection
            
        except Exception as e:
            logger.error(f"Failed to connect to MCP server {qualified_name}: {str(e)}")
            raise
            
    async def connect_all(self, mcp_configs: List[Dict[str, Any]]) -> None:
        """Connect to all MCP servers in the configuration"""
        for config in mcp_configs:
            try:
                await self.connect_server(config)
            except Exception as e:
                logger.error(f"Failed to connect to {config['qualifiedName']}: {str(e)}")
                # Continue with other servers even if one fails
                
    def get_all_tools_openapi(self) -> List[Dict[str, Any]]:
        """
        Convert all connected MCP tools to OpenAPI format for LLM
        
        Returns a list of tool definitions in OpenAPI format
        """
        all_tools = []
        
        for conn in self.connections.values():
            if not conn.tools:
                continue
                
            for tool in conn.tools:
                # Skip tools that are not enabled
                if conn.enabled_tools and tool.name not in conn.enabled_tools:
                    continue
                    
                # Convert MCP tool to OpenAPI format
                openapi_tool = {
                    "name": f"mcp_{conn.qualified_name}_{tool.name}",  # Prefix to avoid conflicts
                    "description": tool.description or f"MCP tool from {conn.name}",
                    "parameters": {
                        "type": "object",
                        "properties": {},
                        "required": []
                    }
                }
                
                # Convert input schema if available
                if hasattr(tool, 'inputSchema') and tool.inputSchema:
                    schema = tool.inputSchema
                    if isinstance(schema, dict):
                        openapi_tool["parameters"]["properties"] = schema.get("properties", {})
                        openapi_tool["parameters"]["required"] = schema.get("required", [])
                        
                all_tools.append(openapi_tool)
                
        return all_tools
        
    async def execute_tool(self, tool_name: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
        """
        Execute an MCP tool call
        
        Args:
            tool_name: Name in format "mcp_{qualified_name}_{original_tool_name}"
            arguments: Tool arguments
            
        Returns:
            Tool execution result
        """
        # Parse the tool name to get server and original tool name
        parts = tool_name.split("_", 2)
        if len(parts) != 3 or parts[0] != "mcp":
            raise ValueError(f"Invalid MCP tool name format: {tool_name}")
            
        _, qualified_name, original_tool_name = parts
        
        # Find the connection config
        if qualified_name not in self.connections:
            raise ValueError(f"MCP server {qualified_name} not connected")
            
        conn = self.connections[qualified_name]
            
        logger.info(f"Executing MCP tool {original_tool_name} on server {qualified_name}")
        
        # Check if Smithery API key is available
        if not SMITHERY_API_KEY:
            raise ValueError("SMITHERY_API_KEY environment variable is not set")
        
        try:
            # Create fresh connection for this tool call
            config_json = json.dumps(conn.config)
            config_b64 = base64.b64encode(config_json.encode()).decode()
            url = f"{SMITHERY_SERVER_BASE_URL}/{qualified_name}/mcp?config={config_b64}&api_key={SMITHERY_API_KEY}"
            
            # Use the documented pattern with proper context management
            async with streamablehttp_client(url) as (read_stream, write_stream, _):
                async with ClientSession(read_stream, write_stream) as session:
                    # Initialize the connection
                    await session.initialize()
                    
                    # Call the tool
                    result = await session.call_tool(original_tool_name, arguments)
            
                    # Convert result to dict - handle MCP response properly
                    if hasattr(result, 'content'):
                        # Handle content which might be a list of TextContent objects
                        content = result.content
                        if isinstance(content, list):
                            # Extract text from TextContent objects
                            text_parts = []
                            for item in content:
                                if hasattr(item, 'text'):
                                    text_parts.append(item.text)
                                elif hasattr(item, 'content'):
                                    text_parts.append(str(item.content))
                                else:
                                    text_parts.append(str(item))
                            content_str = "\n".join(text_parts)
                        elif hasattr(content, 'text'):
                            # Single TextContent object
                            content_str = content.text
                        elif hasattr(content, 'content'):
                            content_str = str(content.content)
                        else:
                            content_str = str(content)
                        
                        is_error = getattr(result, 'isError', False)
                    else:
                        content_str = str(result)
                        is_error = False
                        
                return {
                        "content": content_str,
                        "isError": is_error
                }
                
        except Exception as e:
            logger.error(f"Error executing MCP tool {tool_name}: {str(e)}")
            return {
                "content": f"Error executing tool: {str(e)}",
                "isError": True
            }
            
    async def disconnect_all(self):
        """Disconnect all MCP servers (clear stored configurations)"""
        for qualified_name in list(self.connections.keys()):
            try:
                del self.connections[qualified_name]
                logger.info(f"Cleared MCP server configuration for {qualified_name}")
            except Exception as e:
                logger.error(f"Error clearing configuration for {qualified_name}: {str(e)}")
                
        # Clear sessions dict
        self._sessions.clear()
                
    def get_tool_info(self, tool_name: str) -> Optional[Dict[str, Any]]:
        """Get information about a specific tool"""
        parts = tool_name.split("_", 2)
        if len(parts) != 3 or parts[0] != "mcp":
            return None
            
        _, qualified_name, original_tool_name = parts
        
        if qualified_name not in self.connections:
            return None
            
        conn = self.connections[qualified_name]
        if not conn.tools:
            return None
            
        for tool in conn.tools:
            if tool.name == original_tool_name:
                return {
                    "server": conn.name,
                    "qualified_name": qualified_name,
                    "original_name": tool.name,
                    "description": tool.description,
                    "enabled": not conn.enabled_tools or tool.name in conn.enabled_tools
                }
                
        return None 