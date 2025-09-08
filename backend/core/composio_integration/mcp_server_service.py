from typing import Optional, List, Dict, Any
import secrets
import string
from pydantic import BaseModel
from core.utils.logger import logger
from .client import ComposioClient


class MCPCommands(BaseModel):
    cursor: Optional[str] = None
    claude: Optional[str] = None  
    windsurf: Optional[str] = None


class MCPServer(BaseModel):
    id: str
    name: str
    auth_config_ids: List[str] = []
    allowed_tools: List[str] = []
    mcp_url: Optional[str] = None
    toolkits: List[str] = []
    commands: MCPCommands
    updated_at: Optional[str] = None
    created_at: Optional[str] = None
    managed_auth_via_composio: bool = True


class MCPUrlResponse(BaseModel):
    mcp_url: str
    connected_account_urls: List[str] = []
    user_ids_url: List[str] = []


class MCPServerService:
    def __init__(self, api_key: Optional[str] = None):
        self.client = ComposioClient.get_client(api_key)
    
    def _generate_cuid(self, length: int = 8) -> str:
        return ''.join(secrets.choice(string.ascii_lowercase + string.digits) for _ in range(length))
    
    def _generate_server_name(self, toolkit_name: str) -> str:
        clean_name = ''.join(c.lower() if c.isalnum() else '-' for c in toolkit_name)
        clean_name = clean_name.strip('-')
        
        cuid = self._generate_cuid(8)

        server_name = f"{clean_name}-{cuid}"
        
        if len(server_name) > 30:
            max_app_name_length = 30 - len(cuid) - 1
            clean_name = clean_name[:max_app_name_length]
            server_name = f"{clean_name}-{cuid}"
        
        if len(server_name) < 4:
            server_name = f"app-{cuid}"
        
        return server_name
    
    async def create_mcp_server(
        self, 
        auth_config_ids: List[str], 
        name: Optional[str] = None,
        allowed_tools: Optional[List[str]] = None,
        toolkit_name: str = "composio"
    ) -> MCPServer:
        try:
            logger.debug(f"Creating MCP server with auth_configs: {auth_config_ids}")
            
            if not name:
                name = self._generate_server_name(toolkit_name)
            
            if not allowed_tools:
                allowed_tools = []
            
            logger.debug(f"Using MCP server name: {name}")
            
            try:
                response = self.client.mcp.create(
                    auth_config_ids=auth_config_ids,
                    name=name,
                    allowed_tools=allowed_tools
                )
            except AttributeError:
                response = self.client.create_mcp_server(
                    auth_config_ids=auth_config_ids,
                    name=name,
                    allowed_tools=allowed_tools
                )

            commands_obj = getattr(response, 'commands', None)
            
            commands = MCPCommands(
                cursor=getattr(commands_obj, 'cursor', None) if commands_obj else None,
                claude=getattr(commands_obj, 'claude', None) if commands_obj else None,
                windsurf=getattr(commands_obj, 'windsurf', None) if commands_obj else None
            )
            
            mcp_server = MCPServer(
                id=response.id,
                name=response.name,
                auth_config_ids=getattr(response, 'auth_config_ids', []),
                allowed_tools=getattr(response, 'allowed_tools', []),
                mcp_url=getattr(response, 'mcp_url', None),
                toolkits=getattr(response, 'toolkits', []),
                commands=commands,
                updated_at=getattr(response, 'updated_at', None),
                created_at=getattr(response, 'created_at', None),
                managed_auth_via_composio=getattr(response, 'managed_auth_via_composio', True)
            )
            
            logger.debug(f"Successfully created MCP server: {mcp_server.id}")
            return mcp_server
            
        except Exception as e:
            logger.error(f"Failed to create MCP server: {e}", exc_info=True)
            raise
    
    async def generate_mcp_url(
        self, 
        mcp_server_id: str, 
        connected_account_ids: Optional[List[str]] = None,
        user_ids: Optional[List[str]] = None
    ) -> MCPUrlResponse:
        try:
            logger.debug(f"Generating MCP URL for server: {mcp_server_id}")
            
            request_data = {"mcp_server_id": mcp_server_id}
            
            if connected_account_ids:
                request_data["connected_account_ids"] = connected_account_ids
            
            if user_ids:
                request_data["user_ids"] = user_ids

            try:
                response = self.client.mcp.generate_mcp_url(**request_data)
            except AttributeError:
                try:
                    response = self.client.mcp.generate.url(**request_data)
                except AttributeError:
                    response = self.client.generate_mcp_url(**request_data)
            
            mcp_url_response = MCPUrlResponse(
                mcp_url=response.mcp_url,
                connected_account_urls=getattr(response, 'connected_account_urls', []),
                user_ids_url=getattr(response, 'user_ids_url', [])
            )
            
            logger.debug(f"Successfully generated MCP URL: {mcp_url_response.mcp_url}")
            return mcp_url_response
            
        except Exception as e:
            logger.error(f"Failed to generate MCP URL: {e}", exc_info=True)
            raise
    
    async def get_mcp_server(self, mcp_server_id: str) -> Optional[MCPServer]:
        try:
            logger.debug(f"Fetching MCP server: {mcp_server_id}")
            
            try:
                response = self.client.mcp.get(mcp_server_id)
            except AttributeError:
                response = self.client.get_mcp_server(mcp_server_id)
            
            if not response:
                return None
            
            commands_obj = getattr(response, 'commands', None)
            
            commands = MCPCommands(
                cursor=getattr(commands_obj, 'cursor', None) if commands_obj else None,
                claude=getattr(commands_obj, 'claude', None) if commands_obj else None,
                windsurf=getattr(commands_obj, 'windsurf', None) if commands_obj else None
            )
            
            return MCPServer(
                id=response.id,
                name=response.name,
                auth_config_ids=getattr(response, 'auth_config_ids', []),
                allowed_tools=getattr(response, 'allowed_tools', []),
                mcp_url=getattr(response, 'mcp_url', None),
                toolkits=getattr(response, 'toolkits', []),
                commands=commands,
                updated_at=getattr(response, 'updated_at', None),
                created_at=getattr(response, 'created_at', None),
                managed_auth_via_composio=getattr(response, 'managed_auth_via_composio', True)
            )
            
        except Exception as e:
            logger.error(f"Failed to get MCP server {mcp_server_id}: {e}", exc_info=True)
            raise
    
    async def list_mcp_servers(self) -> List[MCPServer]:
        try:
            logger.debug("Listing MCP servers")
            
            try:
                response = self.client.mcp.list()
            except AttributeError:
                response = self.client.list_mcp_servers()
            
            mcp_servers = []
            items = getattr(response, 'items', [])
            
            for item in items:
                commands_obj = getattr(item, 'commands', None)
                
                commands = MCPCommands(
                    cursor=getattr(commands_obj, 'cursor', None) if commands_obj else None,
                    claude=getattr(commands_obj, 'claude', None) if commands_obj else None,
                    windsurf=getattr(commands_obj, 'windsurf', None) if commands_obj else None
                )
                
                mcp_server = MCPServer(
                    id=item.id,
                    name=item.name,
                    auth_config_ids=getattr(item, 'auth_config_ids', []),
                    allowed_tools=getattr(item, 'allowed_tools', []),
                    mcp_url=getattr(item, 'mcp_url', None),
                    toolkits=getattr(item, 'toolkits', []),
                    commands=commands,
                    updated_at=getattr(item, 'updated_at', None),
                    created_at=getattr(item, 'created_at', None),
                    managed_auth_via_composio=getattr(item, 'managed_auth_via_composio', True)
                )
                mcp_servers.append(mcp_server)
            
            logger.debug(f"Successfully listed {len(mcp_servers)} MCP servers")  
            return mcp_servers
            
        except Exception as e:
            logger.error(f"Failed to list MCP servers: {e}", exc_info=True)
            raise
    
    async def delete_mcp_server(self, server_id: str) -> bool:
        try:
            logger.debug(f"Deleting MCP server: {server_id}")
            
            logger.warning(f"Delete MCP server not implemented in SDK for ID: {server_id}")
            return False
            
        except Exception as e:
            logger.error(f"Failed to delete MCP server {server_id}: {e}", exc_info=True)
            raise 