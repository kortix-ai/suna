from typing import List, Optional, Dict, Any
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from enum import Enum
import os
import re
import httpx
import json
import asyncio
from core.utils.logger import logger

class AppSlug:
    def __init__(self, value: str):
        if not value or not isinstance(value, str):
            raise ValueError("AppSlug must be a non-empty string")
        if not re.match(r'^[a-z0-9_-]+$', value):
            raise ValueError("AppSlug must contain only lowercase letters, numbers, hyphens, and underscores")
        self.value = value

class SearchQuery:
    def __init__(self, value: Optional[str] = None):
        self.value = value
    
    def is_empty(self) -> bool:
        return not self.value or not self.value.strip()

class Category:
    def __init__(self, value: str):
        if not value or not isinstance(value, str):
            raise ValueError("Category must be a non-empty string")
        self.value = value

class PaginationCursor:
    def __init__(self, value: Optional[str] = None):
        self.value = value
    
    def has_more(self) -> bool:
        return self.value is not None

# Domain Entities
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

class AppServiceError(Exception):
    pass

class AppNotFoundError(AppServiceError):
    pass

class InvalidAppSlugError(AppServiceError):
    pass

class AuthenticationError(AppServiceError):
    pass

class RateLimitError(AppServiceError):
    pass

class AppService:
    def __init__(self):
        self.base_url = "https://api.pipedream.com/v1"
        self.session: Optional[httpx.AsyncClient] = None
        self.access_token: Optional[str] = None
        self.token_expires_at: Optional[datetime] = None
        self._semaphore = asyncio.Semaphore(10)

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
                raise RateLimitError()
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
                raise RateLimitError()
            raise AppServiceError(f"HTTP request failed: {e}")

    async def _search(self, query: SearchQuery, category: Optional[Category] = None, 
                    page: int = 1, limit: int = 20, cursor: Optional[PaginationCursor] = None) -> Dict[str, Any]:
        url = f"{self.base_url}/apps"
        params = {}
        
        if not query.is_empty():
            params["q"] = query.value
        if category:
            params["category"] = category.value
        if cursor and cursor.value:
            params["after"] = cursor.value
        
        try:
            data = await self._make_request(url, params=params)
            apps = []
            for app_data in data.get("data", []):
                try:
                    app = self._map_to_domain(app_data)
                    apps.append(app)
                except Exception as e:
                    logger.warning(f"Error mapping app data: {str(e)}")
                    continue
            
            page_info = data.get("page_info", {})
            page_info["has_more"] = bool(page_info.get("end_cursor"))
            
            logger.debug(f"Found {len(apps)} apps from search")
            
            return {
                "success": True,
                "apps": apps,
                "page_info": page_info,
                "total_count": page_info.get("total_count", 0)
            }
            
        except Exception as e:
            logger.error(f"Error searching apps: {str(e)}")
            return {
                "success": False,
                "error": str(e),
                "apps": [],
                "page_info": {},
                "total_count": 0
            }

    async def _get_by_slug(self, app_slug: str) -> Optional[App]:
        cache_key = f"pipedream:app:{app_slug}"
        try:
            from core.services import redis
            redis_client = await redis.get_client()
            cached_data = await redis_client.get(cache_key)
            
            if cached_data:
                logger.debug(f"Found cached app for slug: {app_slug}")
                cached_app_data = json.loads(cached_data)
                return self._map_cached_app_to_domain(cached_app_data)
        except Exception as e:
            logger.warning(f"Redis cache error for app {app_slug}: {e}")
        
        async with self._semaphore:
            url = f"{self.base_url}/apps"
            params = {"q": app_slug, "pageSize": 20}
            
            try:
                data = await self._make_request(url, params=params)
                
                apps = data.get("data", [])
                exact_match = next((app for app in apps if app.get("name_slug") == app_slug), None)
                
                if exact_match:
                    app = self._map_to_domain(exact_match)
                    
                    try:
                        from core.services import redis
                        redis_client = await redis.get_client()
                        app_data = self._map_domain_app_to_cache(app)
                        await redis_client.setex(cache_key, 21600, json.dumps(app_data))
                        logger.debug(f"Cached app: {app_slug}")
                    except Exception as e:
                        logger.warning(f"Failed to cache app {app_slug}: {e}")
                    
                    return app
                
                return None
                
            except Exception as e:
                logger.error(f"Error getting app by slug: {str(e)}")
                return None

    async def _get_popular(self, category: Optional[str] = None, limit: int = 100) -> List[App]:
        popular_slugs = [
            "slack", "microsoft_teams", "discord", "zoom", "telegram_bot_api",
            "gmail", "microsoft_outlook", "google_calendar", "microsoft_exchange", "calendly",
            "google_drive", "microsoft_onedrive", "dropbox", "google_docs", "google_sheets",
            "notion", "asana", "monday", "trello", "linear", "jira", "clickup",
            "salesforce", "hubspot", "pipedrive", "zendesk", "freshdesk", "intercom",
            "github", "gitlab", "bitbucket", "docker", "jenkins", "vercel", "netlify",
            "supabase", "firebase", "mongodb", "postgresql", "mysql", "redis", "airtable",
            "openai", "anthropic", "hugging_face", "replicate",
            "google_analytics", "facebook", "instagram", "twitter", "linkedin", "mailchimp",
            "stripe", "paypal", "quickbooks", "xero", "square",
            "aws", "google_cloud", "microsoft_azure", "digitalocean", "heroku",
            "shopify", "woocommerce", "magento", "bigcommerce"
        ]
        
        apps = []
        batch_size = 20
        target_slugs = popular_slugs[:limit]
        
        async def fetch_app(slug: str):
            try:
                app = await self._get_by_slug(slug)
                if app and (not category or app.category == category):
                    return app
                return None
            except Exception as e:
                logger.warning(f"Error fetching popular app {slug}: {e}")
                return None
        
        for i in range(0, len(target_slugs), batch_size):
            batch_slugs = target_slugs[i:i+batch_size]
            
            if i > 0:
                await asyncio.sleep(0.1)
            
            batch_tasks = [fetch_app(slug) for slug in batch_slugs]
            batch_results = await asyncio.gather(*batch_tasks, return_exceptions=True)
            
            for result in batch_results:
                if isinstance(result, App):
                    apps.append(result)
                    
                if len(apps) >= limit:
                    break
            
            if len(apps) >= limit:
                break
        
        return apps

    async def _get_by_category(self, category: str, limit: int = 20) -> List[App]:
        query = SearchQuery(None)
        category_obj = Category(category)
        result = await self._search(query, category_obj, limit=limit)
        return result.get("apps", [])

    def _map_to_domain(self, app_data: Dict[str, Any]) -> App:
        try:
            auth_type_str = app_data.get("auth_type", "oauth")
            auth_type = AuthType(auth_type_str)
        except ValueError:
            logger.warning(f"Unknown auth type '{auth_type_str}', using CUSTOM")
            auth_type = AuthType.CUSTOM
        
        return App(
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
    
    def _map_domain_app_to_cache(self, app: App) -> Dict[str, Any]:
        return {
            "name": app.name,
            "name_slug": app.slug,
            "description": app.description,
            "category": app.category,
            "img_src": app.logo_url,
            "auth_type": app.auth_type.value,
            "verified": app.is_verified,
            "url": app.url,
            "tags": app.tags,
            "featured_weight": app.featured_weight
        }
    
    def _map_cached_app_to_domain(self, app_data: Dict[str, Any]) -> App:
        try:
            auth_type_str = app_data.get("auth_type", "oauth")
            auth_type = AuthType(auth_type_str)
        except ValueError:
            logger.warning(f"Unknown auth type '{auth_type_str}', using CUSTOM")
            auth_type = AuthType.CUSTOM
        
        return App(
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

    async def search_apps(
        self,
        query: Optional[str] = None,
        category: Optional[str] = None,
        page: int = 1,
        limit: int = 20,
        cursor: Optional[str] = None
    ) -> Dict[str, Any]:
        search_query = SearchQuery(query)
        category_vo = Category(category) if category else None
        cursor_vo = PaginationCursor(cursor) if cursor else None
        
        logger.debug(f"Searching apps: query='{query}', category='{category}', page={page}")
        
        result = await self._search(search_query, category_vo, page, limit, cursor_vo)
        
        logger.debug(f"Found {len(result.get('apps', []))} apps")
        return result

    async def get_app_by_slug(self, app_slug: str) -> Optional[App]:
        logger.debug(f"Getting app by slug: {app_slug}")
        
        app = await self._get_by_slug(app_slug)
        
        if app:
            logger.debug(f"Found app: {app.name}")
        else:
            logger.debug(f"App not found: {app_slug}")
        
        return app

    async def get_popular_apps(self, category: Optional[str] = None, limit: int = 10) -> List[App]:
        logger.debug(f"Getting popular apps: category='{category}', limit={limit}")
        
        apps = await self._get_popular(category, limit)
        
        logger.debug(f"Found {len(apps)} popular apps")
        return apps

    async def close(self):
        if self.session and not self.session.is_closed:
            await self.session.aclose()
    
    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        await self.close()


_app_service = None

def get_app_service() -> AppService:
    global _app_service
    if _app_service is None:
        _app_service = AppService()
    return _app_service


PipedreamException = AppServiceError
HttpClientException = AppServiceError
AuthenticationException = AuthenticationError
RateLimitException = RateLimitError 