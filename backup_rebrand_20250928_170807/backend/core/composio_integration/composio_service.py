import os
from typing import Optional, List, Dict, Any
from composio_client import Composio
from core.utils.logger import logger
from pydantic import BaseModel
from core.services.supabase import DBConnection

from .client import ComposioClient, get_composio_client
from .toolkit_service import ToolkitService, ToolkitInfo
from .auth_config_service import AuthConfigService, AuthConfig
from .connected_account_service import ConnectedAccountService, ConnectedAccount
from .mcp_server_service import MCPServerService, MCPServer, MCPUrlResponse
from .composio_profile_service import ComposioProfileService


class ComposioIntegrationResult(BaseModel):
    toolkit: ToolkitInfo
    auth_config: AuthConfig
    connected_account: ConnectedAccount
    mcp_server: MCPServer
    mcp_url_response: MCPUrlResponse
    final_mcp_url: str
    profile_id: Optional[str] = None


class ComposioIntegrationService:
    def __init__(self, api_key: Optional[str] = None, db_connection: Optional[DBConnection] = None):
        self.api_key = api_key
        self.toolkit_service = ToolkitService(api_key)
        self.auth_config_service = AuthConfigService(api_key)
        self.connected_account_service = ConnectedAccountService(api_key)
        self.mcp_server_service = MCPServerService(api_key)
        self.profile_service = ComposioProfileService(db_connection) if db_connection else None
    
    async def integrate_toolkit(
        self, 
        toolkit_slug: str, 
        account_id: str,
        user_id: str,
        profile_name: Optional[str] = None,
        display_name: Optional[str] = None,
        mcp_server_name: Optional[str] = None,
        save_as_profile: bool = True,
        initiation_fields: Optional[Dict[str, str]] = None,
        custom_auth_config: Optional[Dict[str, str]] = None,
        use_custom_auth: bool = False
    ) -> ComposioIntegrationResult:
        try:
            logger.debug(f"Starting Composio integration for toolkit: {toolkit_slug}")
            logger.debug(f"Initiation fields: {initiation_fields}")
            logger.debug(f"Custom auth: {use_custom_auth}, Custom auth config: {bool(custom_auth_config)}")
            
            toolkit = await self.toolkit_service.get_toolkit_by_slug(toolkit_slug)
            if not toolkit:
                raise ValueError(f"Toolkit '{toolkit_slug}' not found")
            
            logger.debug(f"Step 1 complete: Verified toolkit {toolkit_slug}")
            
            # if toolkit_slug.lower() == "zendesk":
            #     zendesk_auth_config_id = os.getenv("ZENDESK_AUTH_CONFIG")
            #     if not zendesk_auth_config_id:
            #         raise ValueError("ZENDESK_AUTH_CONFIG environment variable is not set")
                
            #     logger.debug(f"Using existing Zendesk auth config from environment: {zendesk_auth_config_id}")
            #     logger.debug(f"Zendesk connection - User ID: {user_id}, Initiation fields: {initiation_fields}")
                
            #     auth_config = AuthConfig(
            #         id=zendesk_auth_config_id,
            #         auth_scheme="OAUTH2",
            #         is_composio_managed=True,
            #         restrict_to_following_tools=[],
            #         toolkit_slug=toolkit_slug
            #     )
                    
            #     logger.debug(f"Step 2 complete: Using Zendesk auth config {auth_config.id}")
            # else:
            #     auth_config = await self.auth_config_service.create_auth_config(
            #         toolkit_slug, 
            #         initiation_fields=initiation_fields
            #     )
            #     logger.debug(f"Step 2 complete: Created auth config {auth_config.id}")

            auth_config = await self.auth_config_service.create_auth_config(
                toolkit_slug, 
                initiation_fields=initiation_fields,
                custom_auth_config=custom_auth_config,
                use_custom_auth=use_custom_auth
            )
            logger.debug(f"Step 2 complete: Created {'custom' if use_custom_auth else 'managed'} auth config {auth_config.id}")
            
            connected_account = await self.connected_account_service.create_connected_account(
                auth_config_id=auth_config.id,
                user_id=user_id,
                initiation_fields=initiation_fields
            )
            logger.debug(f"Step 3 complete: Connected account {connected_account.id}")
            
            mcp_server = await self.mcp_server_service.create_mcp_server(
                auth_config_ids=[auth_config.id],
                name=mcp_server_name,
                toolkit_name=toolkit.name
            )
            logger.debug(f"Step 4 complete: Created MCP server {mcp_server.id}")
            
            mcp_url_response = await self.mcp_server_service.generate_mcp_url(
                mcp_server_id=mcp_server.id,
                connected_account_ids=[connected_account.id],
                user_ids=[user_id]
            )
            logger.debug(f"Step 5 complete: Generated MCP URLs")
            
            final_mcp_url = mcp_url_response.user_ids_url[0] if mcp_url_response.user_ids_url else mcp_url_response.mcp_url
            
            profile_id = None
            if save_as_profile and self.profile_service:
                profile_name = profile_name or f"{toolkit.name} Integration"
                display_name = display_name or f"{toolkit.name} via Composio"
                
                composio_profile = await self.profile_service.create_profile(
                    account_id=account_id,
                    profile_name=profile_name,
                    toolkit_slug=toolkit_slug,
                    toolkit_name=toolkit.name,
                    mcp_url=final_mcp_url,
                    redirect_url=connected_account.redirect_url,
                    user_id=user_id,
                    is_default=False,
                    connected_account_id=connected_account.id
                )
                profile_id = composio_profile.profile_id
                logger.debug(f"Step 6 complete: Saved Composio credential profile {profile_id}")
            
            result = ComposioIntegrationResult(
                toolkit=toolkit,
                auth_config=auth_config,
                connected_account=connected_account,
                mcp_server=mcp_server,
                mcp_url_response=mcp_url_response,
                final_mcp_url=final_mcp_url,
                profile_id=profile_id
            )
            
            logger.debug(f"Successfully completed Composio integration for {toolkit_slug}")
            logger.debug(f"Final MCP URL: {final_mcp_url}")
            
            return result
            
        except Exception as e:
            logger.error(f"Failed to integrate toolkit {toolkit_slug}: {e}", exc_info=True)
            raise
    
    async def list_available_toolkits(self, limit: int = 100, cursor: Optional[str] = None, category: Optional[str] = None) -> Dict[str, Any]:
        return await self.toolkit_service.list_toolkits(limit=limit, cursor=cursor, category=category)
    
    async def search_toolkits(self, query: str, category: Optional[str] = None, limit: int = 100, cursor: Optional[str] = None) -> Dict[str, Any]:
        return await self.toolkit_service.search_toolkits(query, category=category, limit=limit, cursor=cursor)
    
    async def get_integration_status(self, connected_account_id: str) -> Dict[str, Any]:
        return await self.connected_account_service.get_auth_status(connected_account_id)


def get_integration_service(api_key: Optional[str] = None, db_connection: Optional[DBConnection] = None) -> ComposioIntegrationService:
    return ComposioIntegrationService(api_key, db_connection)