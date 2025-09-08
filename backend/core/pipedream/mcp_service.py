import asyncio
import json
import os
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone, timedelta
from typing import List, Optional, Dict, Any
from enum import Enum

import httpx
from core.utils.logger import logger

try:
    from mcp import ClientSession
    from mcp.client.streamable_http import streamablehttp_client
    MCP_AVAILABLE = True
except ImportError:
    MCP_AVAILABLE = False
    logger.warning("MCP client libraries not available")


class ConnectionStatus(Enum):
    CONNECTED = "connected"
    DISCONNECTED = "disconnected"
    ERROR = "error"
    PENDING = "pending"


@dataclass
class MCPTool:
    name: str
    description: str
    input_schema: Dict[str, Any]


@dataclass
class MCPServer:
    app_slug: str
    app_name: str
    server_url: str
    project_id: str
    environment: str
    external_user_id: str
    oauth_app_id: Optional[str] = None
    status: ConnectionStatus = ConnectionStatus.DISCONNECTED
    available_tools: List[MCPTool] = field(default_factory=list)
    error_message: Optional[str] = None

    def is_connected(self) -> bool:
        return self.status == ConnectionStatus.CONNECTED

    def get_tool_count(self) -> int:
        return len(self.available_tools)

    def add_tool(self, tool: MCPTool):
        self.available_tools.append(tool)


class MCPServiceError(Exception):
    pass

class MCPConnectionError(MCPServiceError):
    pass

class MCPServerNotAvailableError(MCPServiceError):
    pass

class AuthenticationError(MCPServiceError):
    pass

class RateLimitError(MCPServiceError):
    pass


class ExternalUserId:
    def __init__(self, value: str):
        if not value or not isinstance(value, str):
            raise ValueError("ExternalUserId must be a non-empty string")
        if len(value) > 255:
            raise ValueError("ExternalUserId must be less than 255 characters")
        self.value = value


class AppSlug:
    def __init__(self, value: str):
        if not value or not isinstance(value, str):
            raise ValueError("AppSlug must be a non-empty string")
        if not re.match(r'^[a-z0-9_-]+$', value):
            raise ValueError("AppSlug must contain only lowercase letters, numbers, hyphens, and underscores")
        self.value = value


class MCPService:
    def __init__(self, logger=None):
        self._logger = logger or logger
        self.base_url = "https://api.pipedream.com/v1"
        self.session = None
        self.access_token = None
        self.token_expires_at = None

    async def _get_session(self) -> httpx.AsyncClient:
        if self.session is None or self.session.is_closed:
            self.session = httpx.AsyncClient(
                timeout=httpx.Timeout(30.0),
                headers={"User-Agent": "Suna-Pipedream-Client/1.0"}
            )
        return self.session

    async def _ensure_access_token(self) -> str:
        if self.access_token and self.token_expires_at:
            if datetime.utcnow() < (self.token_expires_at - timedelta(minutes=5)):
                return self.access_token
            else:
                self.access_token = None
                self.token_expires_at = None

        return await self._fetch_fresh_token()

    async def _fetch_fresh_token(self) -> str:
        project_id = os.getenv("PIPEDREAM_PROJECT_ID")
        client_id = os.getenv("PIPEDREAM_CLIENT_ID")
        client_secret = os.getenv("PIPEDREAM_CLIENT_SECRET")

        if not all([project_id, client_id, client_secret]):
            raise AuthenticationError("Missing required environment variables")

        session = await self._get_session()

        try:
            response = await session.post(
                f"{self.base_url}/oauth/token",
                data={
                    "grant_type": "client_credentials",
                    "client_id": client_id,
                    "client_secret": client_secret
                }
            )
            response.raise_for_status()

            data = response.json()
            self.access_token = data["access_token"]
            expires_in = data.get("expires_in", 3600)
            self.token_expires_at = datetime.utcnow() + timedelta(seconds=expires_in)

            return self.access_token

        except httpx.HTTPStatusError as e:
            if e.response.status_code == 429:
                raise RateLimitError("Rate limit exceeded")
            raise AuthenticationError(f"Failed to obtain access token: {e}")

    async def _make_request(self, url: str, headers: Dict[str, str] = None, params: Dict[str, Any] = None) -> Dict[str, Any]:
        session = await self._get_session()
        access_token = await self._ensure_access_token()

        request_headers = {
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json"
        }

        if headers:
            request_headers.update(headers)

        try:
            response = await session.get(url, headers=request_headers, params=params)
            response.raise_for_status()
            return response.json()
        except httpx.HTTPStatusError as e:
            if e.response.status_code == 429:
                raise RateLimitError("Rate limit exceeded")
            raise MCPServiceError(f"HTTP request failed: {e}")

    async def test_connection(self, server: MCPServer) -> MCPServer:
        if not MCP_AVAILABLE:
            logger.warning(f"MCP client not available for testing {server.app_name}")
            server.status = ConnectionStatus.ERROR
            server.error_message = "MCP client libraries not available"
            return server
        
        try:
            access_token = await self._ensure_access_token()
        except Exception as e:
            logger.error(f"Failed to get access token for MCP connection: {str(e)}")
            server.status = ConnectionStatus.ERROR
            server.error_message = f"Authentication failed: {str(e)}"
            return server
        
        headers = {
            "Authorization": f"Bearer {access_token}",
            "x-pd-project-id": server.project_id,
            "x-pd-environment": server.environment,
            "x-pd-external-user-id": server.external_user_id,
            "x-pd-app-slug": server.app_slug,
        }
        
        logger.debug(f"Testing MCP connection for {server.app_name} at {server.server_url}")
        
        try:
            async with asyncio.timeout(15):
                async with streamablehttp_client(server.server_url, headers=headers) as (read_stream, write_stream, _):
                    async with ClientSession(read_stream, write_stream) as session:
                        await session.initialize()
                        tools_result = await session.list_tools()
                        tools = tools_result.tools if hasattr(tools_result, 'tools') else tools_result
                        
                        for tool in tools:
                            mcp_tool = MCPTool(
                                name=tool.name,
                                description=tool.description,
                                input_schema=tool.inputSchema
                            )
                            server.add_tool(mcp_tool)
                        
                        server.status = ConnectionStatus.CONNECTED
                        logger.debug(f"Successfully tested MCP server for {server.app_name} with {server.get_tool_count()} tools")
                        return server
                        
        except asyncio.TimeoutError:
            logger.error(f"Timeout testing MCP connection for {server.app_name}")
            server.status = ConnectionStatus.ERROR
            server.error_message = "Connection timeout"
        except Exception as e:
            logger.error(f"Failed to test MCP connection for {server.app_name}: {str(e)}")
            server.status = ConnectionStatus.ERROR
            server.error_message = str(e)
        
        return server

    async def discover_servers_for_user(self, external_user_id: ExternalUserId, app_slug: Optional[AppSlug] = None) -> List[MCPServer]:
        if not MCP_AVAILABLE:
            logger.warning("MCP client libraries not available - returning empty server list")
            return []
        
        project_id = os.getenv("PIPEDREAM_PROJECT_ID")
        environment = os.getenv("PIPEDREAM_X_PD_ENVIRONMENT", "development")

        if not project_id:
            logger.error("Missing PIPEDREAM_PROJECT_ID environment variable")
            return []

        logger.debug(f"Discovering MCP servers for user: {external_user_id.value}, app_slug: {app_slug.value if app_slug else 'all'}")

        url = f"{self.base_url}/connect/{project_id}/accounts"
        params = {"external_id": external_user_id.value}
        headers = {"X-PD-Environment": environment}

        try:
            data = await self._make_request(url, headers=headers, params=params)

            accounts = data.get("data", [])
            if not accounts:
                logger.debug(f"No connected apps found for user: {external_user_id.value}")
                return []

            user_apps = [account.get("app") for account in accounts if account.get("app")]

            if app_slug:
                user_apps = [app for app in user_apps if app.get("name_slug") == app_slug.value]
                logger.debug(f"Filtered to {len(user_apps)} apps for app_slug: {app_slug.value}")

            mcp_servers = []
            for app in user_apps:
                app_slug_current = app.get('name_slug')
                app_name = app.get('name')
                
                if not app_slug_current:
                    logger.warning(f"App missing name_slug: {app}")
                    continue
                
                logger.debug(f"Creating MCP server for app: {app_name} ({app_slug_current})")
                
                server = MCPServer(
                    app_slug=app_slug_current,
                    app_name=app_name,
                    server_url='https://remote.mcp.pipedream.net',
                    project_id=project_id,
                    environment=environment,
                    external_user_id=external_user_id.value,
                    status=ConnectionStatus.DISCONNECTED
                )
                
                try:
                    tested_server = await self.test_connection(server)
                    mcp_servers.append(tested_server)
                    logger.debug(f"Successfully tested MCP server for {app_name}: {tested_server.status.value}")
                except Exception as e:
                    logger.warning(f"Failed to test MCP server for {app_name}: {str(e)}")
                    server.status = ConnectionStatus.ERROR
                    server.error_message = str(e)
                    mcp_servers.append(server)

            logger.debug(f"Discovered {len(mcp_servers)} MCP servers for user: {external_user_id.value}")
            return mcp_servers

        except Exception as e:
            logger.error(f"Error discovering MCP servers: {str(e)}")
            return []

    async def create_connection(self, external_user_id: ExternalUserId, app_slug: AppSlug, oauth_app_id: Optional[str] = None) -> MCPServer:
        if not MCP_AVAILABLE:
            raise MCPServerNotAvailableError("MCP client not available")
        
        project_id = os.getenv("PIPEDREAM_PROJECT_ID")
        environment = os.getenv("PIPEDREAM_X_PD_ENVIRONMENT", "development")

        if not project_id:
            raise MCPConnectionError("Missing PIPEDREAM_PROJECT_ID")

        logger.debug(f"Creating MCP connection for user: {external_user_id.value}, app: {app_slug.value}")

        url = f"{self.base_url}/connect/{project_id}/accounts"
        params = {"external_id": external_user_id.value}
        headers = {"X-PD-Environment": environment}

        try:
            data = await self._make_request(url, headers=headers, params=params)

            accounts = data.get("data", [])
            user_apps = [account.get("app") for account in accounts if account.get("app")]

            connected_app = None
            for app in user_apps:
                if app.get('name_slug') == app_slug.value:
                    connected_app = app
                    break

            if not connected_app:
                raise MCPConnectionError(f"User {external_user_id.value} does not have {app_slug.value} connected")

            server = MCPServer(
                app_slug=app_slug.value,
                app_name=connected_app.get('name'),
                server_url='https://remote.mcp.pipedream.net',
                project_id=project_id,
                environment=environment,
                external_user_id=external_user_id.value,
                oauth_app_id=oauth_app_id,
                status=ConnectionStatus.DISCONNECTED
            )

            tested_server = await self.test_connection(server)
            logger.debug(f"Successfully created MCP connection for {app_slug.value}")
            return tested_server

        except Exception as e:
            logger.error(f"Failed to create MCP connection for {app_slug.value}: {str(e)}")
            raise MCPConnectionError(str(e))

    async def close(self):
        if self.session and not self.session.is_closed:
            await self.session.aclose()


_mcp_service = None

def get_mcp_service() -> MCPService:
    global _mcp_service
    if _mcp_service is None:
        _mcp_service = MCPService()
    return _mcp_service


PipedreamException = MCPServiceError
MCPServerNotAvailableError = MCPServerNotAvailableError
AuthenticationException = AuthenticationError
HttpClientException = MCPServiceError
RateLimitException = RateLimitError 