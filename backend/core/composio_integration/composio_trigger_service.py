import os
import json
import httpx
from datetime import datetime
from typing import Dict, Any, List, Optional
from core.utils.logger import logger
from .toolkit_service import ToolkitService


class ComposioTriggerService:
    def __init__(self):
        self.api_base = os.getenv("COMPOSIO_API_BASE", "https://backend.composio.dev").rstrip("/")
        self.api_key = os.getenv("COMPOSIO_API_KEY")
        
        # Cache settings
        self._apps_cache: Dict[str, Any] = {"ts": 0, "data": None}
        self._apps_ttl = 60
        self._triggers_cache: Dict[str, Dict[str, Any]] = {}
        self._triggers_ttl = 60

    async def list_apps_with_triggers(self) -> Dict[str, Any]:
        """Return toolkits that have at least one available trigger, with logo, slug, name."""
        if not self.api_key:
            raise ValueError("COMPOSIO_API_KEY not configured")

        # Check cache
        now_ts = int(datetime.utcnow().timestamp())
        cached = self._apps_cache.get("data")
        if cached and (now_ts - int(self._apps_cache.get("ts", 0)) < self._apps_ttl):
            return cached

        # Try Redis cache first
        try:
            from core.services import redis as redis_service
            redis_client = await redis_service.get_client()
            cache_key = "composio:apps-with-triggers:v1"
            cached_json = await redis_client.get(cache_key)
            if cached_json:
                parsed = json.loads(cached_json)
                self._apps_cache["data"] = parsed
                self._apps_cache["ts"] = now_ts
                return parsed
        except Exception:
            pass

        # HTTP-only: list trigger types and derive toolkits
        headers = {"x-api-key": self.api_key}
        url = f"{self.api_base}/api/v3/triggers_types"
        params = {"limit": 1000}
        items = []
        async with httpx.AsyncClient(timeout=20) as client_http:
            while True:
                resp = await client_http.get(url, headers=headers, params=params)
                resp.raise_for_status()
                data = resp.json()
                page_items = data.get("items") if isinstance(data, dict) else data
                if page_items is None:
                    page_items = data if isinstance(data, list) else []
                items.extend(page_items)
                next_cursor = None
                if isinstance(data, dict):
                    next_cursor = data.get("next_cursor") or data.get("nextCursor")
                if not next_cursor:
                    break
                params["cursor"] = next_cursor

        # Build toolkit map directly from triggers payload (preserves logos like Slack)
        toolkits_map: Dict[str, Dict[str, Any]] = {}
        for it in items:
            x = it if isinstance(it, dict) else (it.__dict__ if hasattr(it, "__dict__") else None)
            if not isinstance(x, dict):
                continue
            tk = x.get("toolkit")
            if isinstance(tk, dict):
                slug = (tk.get("slug") or tk.get("name") or "").strip()
                if not slug:
                    continue
                key = slug.lower()
                name = (tk.get("name") or slug).strip()
                logo = tk.get("logo")
                existing = toolkits_map.get(key)
                if not existing:
                    toolkits_map[key] = {"slug": slug, "name": name, "logo": logo}
                else:
                    # Upgrade logo if previously missing
                    if not existing.get("logo") and logo:
                        existing["logo"] = logo
                continue
            # Fallback to flat keys
            for k in ("toolkit_slug", "toolkitSlug", "toolkit_name", "toolkitName"):
                val = x.get(k)
                if isinstance(val, str) and val.strip():
                    key = val.strip().lower()
                    if key not in toolkits_map:
                        toolkits_map[key] = {"slug": val.strip(), "name": val.strip().capitalize(), "logo": None}
                    break

        # Fallback enrichment with ToolkitService only for missing logos
        missing = [slug for slug, info in toolkits_map.items() if not info.get("logo")]
        if missing:
            toolkit_service = ToolkitService()
            tk_resp = await toolkit_service.list_toolkits(limit=500)
            tk_items = tk_resp.get("items", [])
            tk_by_slug = {t.slug.lower(): t for t in tk_items if hasattr(t, 'slug')}
            for slug in missing:
                t = tk_by_slug.get(slug)
                if t and t.logo:
                    toolkits_map[slug]["logo"] = t.logo

        # Prepare final list
        result_items = sorted(toolkits_map.values(), key=lambda x: x["slug"].lower())

        # Cache response
        response = {"success": True, "items": result_items, "total": len(result_items)}
        self._apps_cache["data"] = response
        self._apps_cache["ts"] = now_ts

        # Store in Redis cache as well
        try:
            from core.services import redis as redis_service
            redis_client = await redis_service.get_client()
            if redis_client:
                cache_key = "composio:apps-with-triggers:v1"
                await redis_client.set(cache_key, json.dumps(response), ex=self._apps_ttl)
        except Exception:
            pass

        return response

    async def list_triggers_for_app(self, toolkit_slug: str) -> Dict[str, Any]:
        """Return full trigger definitions for a given toolkit (slug), including config/payload and toolkit logo."""
        if not self.api_key:
            raise ValueError("COMPOSIO_API_KEY not configured")

        # Per-toolkit cache
        now_ts = int(datetime.utcnow().timestamp())
        cache_entry = self._triggers_cache.get(toolkit_slug.lower())
        if cache_entry and (now_ts - int(cache_entry.get("ts", 0)) < self._triggers_ttl):
            return cache_entry["data"]

        # HTTP-only: try server-side toolkit filter first, then fetch all and filter client-side
        headers = {"x-api-key": self.api_key}
        url = f"{self.api_base}/api/v3/triggers_types"
        items = []
        async with httpx.AsyncClient(timeout=20) as client_http:
            # Try param filter
            params = {"limit": 1000, "toolkits": toolkit_slug}
            resp = await client_http.get(url, headers=headers, params=params)
            resp.raise_for_status()
            data = resp.json()
            items = data.get("items") if isinstance(data, dict) else data
            if items is None:
                items = data if isinstance(data, list) else []
            # Fallback to fetch all pages then filter client-side
            if not items:
                logger.debug("[Composio HTTP] toolkit filter returned 0, fetching all and filtering", toolkit=toolkit_slug)
                params_all = {"limit": 1000}
                items = []
                while True:
                    resp_all = await client_http.get(url, headers=headers, params=params_all)
                    resp_all.raise_for_status()
                    data_all = resp_all.json()
                    page_items = data_all.get("items") if isinstance(data_all, dict) else data_all
                    if page_items is None:
                        page_items = data_all if isinstance(data_all, list) else []
                    items.extend(page_items)
                    next_cursor = None
                    if isinstance(data_all, dict):
                        next_cursor = data_all.get("next_cursor") or data_all.get("nextCursor")
                    if not next_cursor:
                        break
                    params_all["cursor"] = next_cursor

        # Prepare toolkit info
        toolkit_service = ToolkitService()
        tk_resp = await toolkit_service.list_toolkits(limit=500)
        tk_items = tk_resp.get("items", [])
        tk_by_slug = {t.slug.lower(): t for t in tk_items if hasattr(t, 'slug')}
        tk = tk_by_slug.get(toolkit_slug.lower())
        tk_info = {"slug": toolkit_slug, "name": (tk.name if tk else toolkit_slug), "logo": (tk.logo if tk else None)}

        def match_toolkit(x: Dict[str, Any]) -> bool:
            tkv = x.get("toolkit")
            if isinstance(tkv, dict):
                sl = (tkv.get("slug") or tkv.get("name") or "").lower()
                if sl == toolkit_slug.lower():
                    return True
            for key in ("toolkit_slug", "toolkitSlug", "toolkit_name"):
                val = x.get(key)
                if isinstance(val, str) and val.lower() == toolkit_slug.lower():
                    return True
            return False

        result_items = []
        matched_count = 0
        for it in items:
            x = it if isinstance(it, dict) else (it.__dict__ if hasattr(it, "__dict__") else None)
            if not isinstance(x, dict):
                continue
            if not match_toolkit(x):
                continue
            matched_count += 1
            result_items.append({
                "slug": x.get("slug"),
                "name": x.get("name"),
                "description": x.get("description"),
                "type": x.get("type") or x.get("delivery_type") or "webhook",
                "instructions": x.get("instructions") or "",
                "toolkit": tk_info,
                "config": x.get("config") or {},
                "payload": x.get("payload") or {},
            })

        # Cache response
        response = {"success": True, "items": result_items, "toolkit": tk_info, "total": len(result_items)}
        self._triggers_cache[toolkit_slug.lower()] = {"data": response, "ts": now_ts}

        return response