import os
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone, timedelta
from typing import List, Optional, Dict, Any
from enum import Enum

import httpx
from core.utils.logger import logger


class AuthType(Enum):
    OAUTH = "oauth"
    API_KEY = "api_key"
    BASIC = "basic" 
    NONE = "none"
    KEYS = "keys"
    CUSTOM = "custom"
    
    @classmethod
    def _missing_(cls, value):
        if isinstance(value, str):
            return cls.CUSTOM
        return super()._missing_(value)


@dataclass
class App:
    name: str
    slug: str
    description: str
    category: str
    logo_url: Optional[str] = None
    auth_type: AuthType = AuthType.OAUTH
    is_verified: bool = False
    url: Optional[str] = None
    tags: List[str] = field(default_factory=list)
    featured_weight: int = 0
    
    def is_featured(self) -> bool:
        return self.featured_weight > 0


@dataclass
class Connection:
    external_user_id: str
    app: App
    created_at: datetime
    updated_at: datetime
    is_active: bool = True


class ConnectionServiceError(Exception):
    pass

class AuthenticationError(ConnectionServiceError):
    pass

class RateLimitError(ConnectionServiceError):
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


class ConnectionService:
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

    async def _make_request(self, method: str, url: str, headers: Dict[str, str] = None, 
                           params: Dict[str, Any] = None, json: Dict[str, Any] = None, 
                           retry_count: int = 0) -> Dict[str, Any]:
        session = await self._get_session()
        access_token = await self._ensure_access_token()

        request_headers = {
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json"
        }

        if headers:
            request_headers.update(headers)

        try:
            if method == "GET":
                response = await session.get(url, headers=request_headers, params=params)
            elif method == "POST":
                response = await session.post(url, headers=request_headers, json=json)
            else:
                raise ValueError(f"Unsupported HTTP method: {method}")

            response.raise_for_status()
            return response.json()

        except httpx.HTTPStatusError as e:
            if e.response.status_code == 429:
                raise RateLimitError("Rate limit exceeded")
            elif e.response.status_code == 401 and retry_count < 1:
                self.access_token = None
                self.token_expires_at = None
                return await self._make_request(method, url, headers=headers, params=params, 
                                              json=json, retry_count=retry_count + 1)
            else:
                raise ConnectionServiceError(f"HTTP request failed: {e}")

    async def get_connections_for_user(self, external_user_id: ExternalUserId) -> List[Connection]:
        logger.debug(f"Getting connections for user: {external_user_id.value}")

        project_id = os.getenv("PIPEDREAM_PROJECT_ID")
        environment = os.getenv("PIPEDREAM_X_PD_ENVIRONMENT", "development")

        if not project_id:
            logger.error("Missing PIPEDREAM_PROJECT_ID environment variable")
            return []

        url = f"{self.base_url}/connect/{project_id}/accounts"
        params = {"external_id": external_user_id.value}
        headers = {"X-PD-Environment": environment}

        try:
            data = await self._make_request("GET", url, headers=headers, params=params)

            connections = []
            accounts = data.get("data", [])

            for account in accounts:
                app_data = account.get("app", {})
                if app_data:
                    try:
                        auth_type_str = app_data.get("auth_type", "oauth")
                        auth_type = AuthType(auth_type_str)
                    except ValueError:
                        logger.warning(f"Unknown auth type '{auth_type_str}', using CUSTOM")
                        auth_type = AuthType.CUSTOM

                    app = App(
                        name=app_data.get("name", "Unknown"),
                        slug=app_data.get("name_slug", ""),
                        description=app_data.get("description", ""),
                        category=app_data.get("category", "Other"),
                        logo_url=app_data.get("img_src"),
                        auth_type=auth_type,
                        is_verified=app_data.get("verified", False),
                        url=app_data.get("url"),
                        tags=app_data.get("tags", []),
                        featured_weight=app_data.get("featured_weight", 0)
                    )

                    connection = Connection(
                        external_user_id=external_user_id.value,
                        app=app,
                        created_at=datetime.utcnow(),
                        updated_at=datetime.utcnow(),
                        is_active=True
                    )
                    connections.append(connection)

            logger.debug(f"Retrieved {len(connections)} connections for user: {external_user_id.value}")
            return connections

        except Exception as e:
            logger.error(f"Error getting connections: {str(e)}")
            return []

    async def has_connection(self, external_user_id: ExternalUserId, app_slug: AppSlug) -> bool:
        connections = await self.get_connections_for_user(external_user_id)

        for connection in connections:
            if connection.app.slug == app_slug.value and connection.is_active:
                return True

        return False

    async def close(self):
        if self.session and not self.session.is_closed:
            await self.session.aclose()


_connection_service = None

def get_connection_service() -> ConnectionService:
    global _connection_service
    if _connection_service is None:
        _connection_service = ConnectionService()
    return _connection_service


PipedreamException = ConnectionServiceError
HttpClientException = ConnectionServiceError
AuthenticationException = AuthenticationError
RateLimitException = RateLimitError 