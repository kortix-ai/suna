import os
import re
from datetime import datetime, timedelta
from typing import Dict, Any, Optional

import httpx
from core.utils.logger import logger


class ConnectionTokenServiceError(Exception):
    pass

class AuthenticationError(ConnectionTokenServiceError):
    pass

class RateLimitError(ConnectionTokenServiceError):
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


class ConnectionTokenService:
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

    async def _make_request(self, url: str, headers: Dict[str, str] = None, json: Dict[str, Any] = None) -> Dict[str, Any]:
        session = await self._get_session()
        access_token = await self._ensure_access_token()

        request_headers = {
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json"
        }

        if headers:
            request_headers.update(headers)

        try:
            response = await session.post(url, headers=request_headers, json=json)
            response.raise_for_status()
            return response.json()
        except httpx.HTTPStatusError as e:
            if e.response.status_code == 429:
                raise RateLimitError("Rate limit exceeded")
            raise ConnectionTokenServiceError(f"HTTP request failed: {e}")

    async def create(self, external_user_id: ExternalUserId, app: Optional[AppSlug] = None) -> Dict[str, Any]:
        project_id = os.getenv("PIPEDREAM_PROJECT_ID")
        environment = os.getenv("PIPEDREAM_X_PD_ENVIRONMENT", "development")

        if not project_id:
            raise AuthenticationError("Missing PIPEDREAM_PROJECT_ID")

        url = f"{self.base_url}/connect/{project_id}/tokens"

        payload = {
            "external_user_id": external_user_id.value
        }

        if app:
            payload["app"] = app.value

        headers = {
            "X-PD-Environment": environment
        }

        logger.debug(f"Creating connection token for user: {external_user_id.value}")

        try:
            data = await self._make_request(url, headers=headers, json=payload)

            if app and "connect_link_url" in data:
                link = data["connect_link_url"]
                if "app=" not in link:
                    separator = "&" if "?" in link else "?"
                    data["connect_link_url"] = f"{link}{separator}app={app.value}"

            logger.debug(f"Successfully created connection token for user: {external_user_id.value}")
            return data

        except Exception as e:
            logger.error(f"Error creating connection token: {str(e)}")
            raise

    async def close(self):
        if self.session and not self.session.is_closed:
            await self.session.aclose()


_connection_token_service = None

def get_connection_token_service() -> ConnectionTokenService:
    global _connection_token_service
    if _connection_token_service is None:
        _connection_token_service = ConnectionTokenService()
    return _connection_token_service


PipedreamException = ConnectionTokenServiceError
AuthenticationException = AuthenticationError
HttpClientException = ConnectionTokenServiceError
RateLimitException = RateLimitError 