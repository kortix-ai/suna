"""
Secure MCP Client

This module provides a secure MCP client that:
1. Uses encrypted credentials from the credential manager
2. Builds runtime configurations from agent instances
3. Maintains backward compatibility with existing agents
4. Logs credential usage for auditing
"""

import asyncio
import json
import base64
from typing import Dict, List, Any, Optional, Tuple
from dataclasses import dataclass

# Import MCP components
from mcp import ClientSession
try:
    from mcp.client.streamable_http import streamablehttp_client
except ImportError:
    try:
        from mcp.client import streamablehttp_client
    except ImportError:
        raise ImportError(
            "Could not import streamablehttp_client. "
            "Make sure you have installed mcp with: pip install 'mcp[cli]'"
        )

try:
    from mcp.types import Tool, CallToolResult as ToolResult
except ImportError:
    try:
        from mcp import types
        Tool = types.Tool
        ToolResult = types.CallToolResult
    except AttributeError:
        Tool = Any
        ToolResult = Any

from utils.logger import logger
from .credential_manager import credential_manager
from .template_manager import template_manager
import os

# Get Smithery API key from environment
SMITHERY_API_KEY = os.getenv("SMITHERY_API_KEY")
SMITHERY_SERVER_BASE_URL = "https://server.smithery.ai"


@dataclass
class SecureMCPConnection:
    """Represents a secure connection to an MCP server"""
    qualified_name: str
    name: str
    credential_id: str
    enabled_tools: List[str]
    session: Optional[ClientSession] = None
    tools: Optional[List[Tool]] = None


class SecureMCPManager:
    """Manages secure connections to multiple MCP servers using encrypted credentials"""
    
    def __init__(self):
        self.connections: Dict[str, SecureMCPConnection] = {}
        self._sessions: Dict[str, Tuple[Any, Any, Any]] = {}
        
    async def connect_from_agent_instance(self, instance_id: str, account_id: str) -> None:
        """
        Connect to all MCP servers for an agent instance using secure credentials
        
        Args:
            instance_id: ID of the agent instance
            account_id: ID of the account (for verification)
        """
        logger.info(f"Connecting to MCP servers for agent instance {instance_id}")
        
        try:
            # Get the runtime configuration
            agent_config = await template_manager.build_runtime_agent_config(instance_id)
            
            # Verify ownership
            if agent_config['account_id'] != account_id:
                raise ValueError("Access denied: not agent owner")
            
            # Connect to each configured MCP
            for mcp_config in agent_config.get('configured_mcps', []):
                try:
                    await self._connect_secure_server(mcp_config, instance_id)
                except Exception as e:
                    logger.error(f"Failed to connect to {mcp_config['qualifiedName']}: {str(e)}")
                    # Continue with other servers even if one fails
                    
        except Exception as e:
            logger.error(f"Error connecting MCP servers for instance {instance_id}: {str(e)}")
            raise
    
    async def connect_from_legacy_agent(self, agent_config: Dict[str, Any]) -> None:
        """
        Connect to MCP servers using legacy agent configuration (backward compatibility)
        
        Args:
            agent_config: Legacy agent configuration with configured_mcps
        """
        logger.info(f"Connecting to MCP servers for legacy agent {agent_config.get('agent_id')}")
        
        try:
            # Connect to each configured MCP using the old method
            for mcp_config in agent_config.get('configured_mcps', []):
                try:
                    await self._connect_legacy_server(mcp_config)
                except Exception as e:
                    logger.error(f"Failed to connect to {mcp_config['qualifiedName']}: {str(e)}")
                    # Continue with other servers even if one fails
                    
        except Exception as e:
            logger.error(f"Error connecting MCP servers for legacy agent: {str(e)}")
            raise
    
    async def _connect_secure_server(self, mcp_config: Dict[str, Any], instance_id: str) -> SecureMCPConnection:
        """Connect to an MCP server using secure credentials"""
        qualified_name = mcp_config["qualifiedName"]
        
        # Check if already connected
        if qualified_name in self.connections:
            logger.info(f"MCP server {qualified_name} already connected")
            return self.connections[qualified_name]
            
        logger.info(f"Connecting to secure MCP server: {qualified_name}")
        
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
                    logger.info(f"Secure MCP session initialized for {qualified_name}")
                    
                    # List available tools
                    tools_result = await session.list_tools()
            
            tools = tools_result.tools if hasattr(tools_result, 'tools') else tools_result
            
            logger.info(f"Available tools from {qualified_name}: {[t.name for t in tools]}")
            
            # Create connection object (without persistent session)
            connection = SecureMCPConnection(
                qualified_name=qualified_name,
                name=mcp_config["name"],
                credential_id="", # We don't store credential_id in mcp_config anymore
                enabled_tools=mcp_config.get("enabledTools", []),
                session=None,  # No persistent session
                tools=tools
            )
            
            self.connections[qualified_name] = connection
            
            # Log successful connection
            await self._log_connection_usage(instance_id, qualified_name, True)
            
            return connection
            
        except Exception as e:
            logger.error(f"Failed to connect to secure MCP server {qualified_name}: {str(e)}")
            
            # Log failed connection
            await self._log_connection_usage(instance_id, qualified_name, False, str(e))
            
            raise
    
    async def _connect_legacy_server(self, mcp_config: Dict[str, Any]) -> SecureMCPConnection:
        """Connect to an MCP server using legacy configuration (backward compatibility)"""
        qualified_name = mcp_config["qualifiedName"]
        
        # Check if already connected
        if qualified_name in self.connections:
            logger.info(f"Legacy MCP server {qualified_name} already connected")
            return self.connections[qualified_name]
            
        logger.info(f"Connecting to legacy MCP server: {qualified_name}")
        
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
                    logger.info(f"Legacy MCP session initialized for {qualified_name}")
                    
                    # List available tools
                    tools_result = await session.list_tools()
            
            tools = tools_result.tools if hasattr(tools_result, 'tools') else tools_result
            
            logger.info(f"Available tools from legacy {qualified_name}: {[t.name for t in tools]}")
            
            # Create connection object (without persistent session)
            connection = SecureMCPConnection(
                qualified_name=qualified_name,
                name=mcp_config["name"],
                credential_id="legacy",
                enabled_tools=mcp_config.get("enabledTools", []),
                session=None,  # No persistent session
                tools=tools
            )
            
            self.connections[qualified_name] = connection
            return connection
            
        except Exception as e:
            logger.error(f"Failed to connect to legacy MCP server {qualified_name}: {str(e)}")
            raise
    
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
    
    async def execute_tool(self, tool_name: str, arguments: Dict[str, Any], instance_id: Optional[str] = None) -> Dict[str, Any]:
        """
        Execute an MCP tool call with secure credential handling
        
        Args:
            tool_name: Name in format "mcp_{qualified_name}_{original_tool_name}"
            arguments: Tool arguments
            instance_id: Optional instance ID for logging
            
        Returns:
            Tool execution result
        """
        # Parse the tool name to get server and original tool name
        parts = tool_name.split("_", 2)
        if len(parts) != 3 or parts[0] != "mcp":
            raise ValueError(f"Invalid MCP tool name format: {tool_name}")
            
        _, qualified_name, original_tool_name = parts
        
        # Find the connection
        if qualified_name not in self.connections:
            raise ValueError(f"MCP server {qualified_name} not connected")
            
        conn = self.connections[qualified_name]
            
        logger.info(f"Executing secure MCP tool {original_tool_name} on server {qualified_name}")
        
        # Check if Smithery API key is available
        if not SMITHERY_API_KEY:
            raise ValueError("SMITHERY_API_KEY environment variable is not set")
        
        try:
            # For secure connections, we need to get the config from the credential manager
            # For now, we'll use a placeholder approach
            # In a full implementation, we'd need to pass the account_id and get the credential
            
            # Create fresh connection for this tool call
            # This is a simplified approach - in production, you'd want to cache credentials
            config = {}  # This would be retrieved from credential manager
            
            config_json = json.dumps(config)
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
                    
                    # Log tool usage
                    await self._log_tool_usage(instance_id, qualified_name, original_tool_name, True)
                        
                    return {
                        "content": content_str,
                        "isError": is_error
                    }
                
        except Exception as e:
            logger.error(f"Error executing secure MCP tool {tool_name}: {str(e)}")
            
            # Log failed tool usage
            await self._log_tool_usage(instance_id, qualified_name, original_tool_name, False, str(e))
            
            return {
                "content": f"Error executing tool: {str(e)}",
                "isError": True
            }
    
    async def disconnect_all(self):
        """Disconnect all MCP servers (clear stored configurations)"""
        for qualified_name in list(self.connections.keys()):
            try:
                del self.connections[qualified_name]
                logger.info(f"Cleared secure MCP server configuration for {qualified_name}")
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
                    "enabled": not conn.enabled_tools or tool.name in conn.enabled_tools,
                    "credential_id": conn.credential_id
                }
                
        return None
    
    async def _log_connection_usage(self, instance_id: str, qualified_name: str, success: bool, error_message: Optional[str] = None):
        """Log MCP connection usage for auditing"""
        try:
            # This would log to the credential_usage_log table
            # For now, just log to the application logger
            status = "SUCCESS" if success else "FAILED"
            logger.info(f"MCP Connection {status}: instance={instance_id}, server={qualified_name}")
            if error_message:
                logger.error(f"Connection error: {error_message}")
        except Exception as e:
            logger.error(f"Failed to log connection usage: {e}")
    
    async def _log_tool_usage(self, instance_id: Optional[str], qualified_name: str, tool_name: str, success: bool, error_message: Optional[str] = None):
        """Log MCP tool usage for auditing"""
        try:
            # This would log to the credential_usage_log table
            # For now, just log to the application logger
            status = "SUCCESS" if success else "FAILED"
            logger.info(f"MCP Tool {status}: instance={instance_id}, server={qualified_name}, tool={tool_name}")
            if error_message:
                logger.error(f"Tool execution error: {error_message}")
        except Exception as e:
            logger.error(f"Failed to log tool usage: {e}")


# Factory function to create the appropriate MCP manager
async def create_mcp_manager_for_agent(agent_config: Dict[str, Any], account_id: str) -> SecureMCPManager:
    """
    Create and configure an MCP manager for an agent
    
    Args:
        agent_config: Agent configuration (could be legacy or instance-based)
        account_id: Account ID for verification
        
    Returns:
        Configured SecureMCPManager
    """
    manager = SecureMCPManager()
    
    # Check if this is an agent instance (has template_id) or legacy agent
    if 'template_id' in agent_config and agent_config['template_id']:
        # This is an agent instance - use secure credential system
        await manager.connect_from_agent_instance(agent_config['agent_id'], account_id)
    else:
        # This is a legacy agent - use backward compatibility
        await manager.connect_from_legacy_agent(agent_config)
    
    return manager 