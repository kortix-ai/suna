from fastapi import APIRouter, HTTPException, Depends, Query, Request
from fastapi.responses import JSONResponse
from typing import Dict, Any, Optional
from pydantic import BaseModel
from uuid import uuid4
from core.utils.auth_utils import verify_and_get_user_id_from_jwt, get_optional_current_user_id_from_jwt
from core.utils.logger import logger
from core.services.supabase import DBConnection
from datetime import datetime
import os
import hmac
import httpx
import asyncio
import json
import hashlib
import time
import re
import base64

from .composio_service import (
    get_integration_service,
)
from .toolkit_service import ToolkitService, ToolsListResponse
from .composio_profile_service import ComposioProfileService, ComposioProfile
from .composio_trigger_service import ComposioTriggerService
from core.triggers.trigger_service import get_trigger_service, TriggerEvent, TriggerType
from core.triggers.execution_service import get_execution_service
from .client import ComposioClient
from core.triggers.api import sync_triggers_to_version_config

router = APIRouter(prefix="/composio", tags=["composio"])

db: Optional[DBConnection] = None

def initialize(database: DBConnection):
    global db
    db = database
    
COMPOSIO_API_BASE = os.getenv("COMPOSIO_API_BASE", "https://backend.composio.dev")

def verify_std_webhook(wid: str, wts: str, wsig: str, raw: bytes, hex_secret: str, max_skew: int = 300) -> bool:
    if not (wid and wts and wsig and hex_secret):
        return False
    try:
        now = int(time.time())
        ts_int = int(wts)
        if abs(now - ts_int) > max_skew:
            return False
    except Exception:
        pass
    try:
        key = bytes.fromhex(hex_secret)
    except Exception:
        return False
    msg = wid.encode() + b"." + (wts.encode()) + b"." + raw
    digest = hmac.new(key, msg, hashlib.sha256).digest()
    expected_b64 = base64.b64encode(digest).decode()

    candidates = []
    for entry in wsig.split():
        entry = entry.strip()
        if "," in entry:
            candidates.append(entry.split(",", 1)[1].strip())
        elif "=" in entry:
            candidates.append(entry.split("=", 1)[1].strip())
        else:
            candidates.append(entry)
    if any(hmac.compare_digest(expected_b64, c) for c in candidates):
        return True
    try:
        expected_hex = digest.hex()
        if any(hmac.compare_digest(expected_hex, c.lower()) for c in candidates):
            return True
    except Exception:
        pass
    return False


def _parse_sigs(wsig: str):
    out = []
    for part in wsig.split():
        part = part.strip()
        if "," in part:
            part = part.split(",", 1)[1].strip()
        elif "=" in part:
            part = part.split("=", 1)[1].strip()
        out.append(part)
    return out


def _b64(d: bytes) -> str:
    return base64.b64encode(d).decode()


async def verify_composio(request: Request, secret_env: str = "COMPOSIO_WEBHOOK_SECRET", max_skew: int = 300) -> bool:
    secret = os.getenv(secret_env, "")
    if not secret:
        raise HTTPException(status_code=500, detail="Webhook secret not configured")

    wid = request.headers.get("webhook-id", "")
    wts = request.headers.get("webhook-timestamp", "")
    wsig = request.headers.get("webhook-signature", "")

    if not (wid and wts and wsig):
        raise HTTPException(status_code=401, detail="Missing standard-webhooks headers")

    try:
        ts = int(wts)
        if ts > 10**12:
            ts //= 1000
        if abs(int(time.time()) - ts) > max_skew:
            raise HTTPException(status_code=401, detail="Timestamp outside tolerance")
    except ValueError:
        pass

    raw = await request.body()

    keys = [("ascii", secret.encode())]
    try:
        keys.append(("hex", bytes.fromhex(secret)))
    except Exception:
        pass
    try:
        keys.append(("b64", base64.b64decode(secret, validate=False)))
    except Exception:
        pass

    msgs = [
        ("id.ts.body", wid.encode() + b"." + wts.encode() + b"." + raw),
        ("ts.body", wts.encode() + b"." + raw),
    ]

    header_sigs = _parse_sigs(wsig)
    for kname, key in keys:
        for mname, msg in msgs:
            dig = hmac.new(key, msg, hashlib.sha256).digest()
            exp_b64 = _b64(dig)
            if any(hmac.compare_digest(exp_b64, s) for s in header_sigs):
                request.state._sig_match = (kname, mname, "b64")
                return True
            exp_hex = dig.hex()
            if any(hmac.compare_digest(exp_hex, s.lower()) for s in header_sigs):
                request.state._sig_match = (kname, mname, "hex")
                return True

    request.state._sig_match = ("none", "none", "none")
    raise HTTPException(status_code=401, detail="Invalid signature")

class IntegrateToolkitRequest(BaseModel):
    toolkit_slug: str
    profile_name: Optional[str] = None
    display_name: Optional[str] = None
    mcp_server_name: Optional[str] = None
    save_as_profile: bool = True

class IntegrationStatusResponse(BaseModel):
    status: str
    toolkit: str
    auth_config_id: str
    connected_account_id: str
    mcp_server_id: str
    final_mcp_url: str
    profile_id: Optional[str] = None
    redirect_url: Optional[str] = None

class CreateProfileRequest(BaseModel):
    toolkit_slug: str
    profile_name: str
    display_name: Optional[str] = None
    mcp_server_name: Optional[str] = None
    is_default: bool = False
    initiation_fields: Optional[Dict[str, str]] = None
    custom_auth_config: Optional[Dict[str, str]] = None
    use_custom_auth: bool = False

class ToolsListRequest(BaseModel):
    toolkit_slug: str
    limit: int = 50
    cursor: Optional[str] = None

class ProfileResponse(BaseModel):
    profile_id: str
    profile_name: str
    display_name: str
    toolkit_slug: str
    toolkit_name: str
    mcp_url: str
    redirect_url: Optional[str] = None
    connected_account_id: Optional[str] = None
    is_connected: bool
    is_default: bool
    created_at: str

    @classmethod
    def from_composio_profile(cls, profile: ComposioProfile) -> "ProfileResponse":
        return cls(
            profile_id=profile.profile_id,
            profile_name=profile.profile_name,
            display_name=profile.display_name,
            toolkit_slug=profile.toolkit_slug,
            toolkit_name=profile.toolkit_name,
            mcp_url=profile.mcp_url,
            redirect_url=profile.redirect_url,
            connected_account_id=getattr(profile, 'connected_account_id', None),
            is_connected=profile.is_connected,
            is_default=profile.is_default,
            created_at=profile.created_at.isoformat() if profile.created_at else datetime.now().isoformat()
        )


@router.get("/categories")
async def list_categories(
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict[str, Any]:
    try:
        logger.debug("Fetching Composio categories")
        
        toolkit_service = ToolkitService()
        categories = await toolkit_service.list_categories()
        
        return {
            "success": True,
            "categories": [cat.dict() for cat in categories],
            "total": len(categories)
        }
        
    except Exception as e:
        logger.error(f"Failed to fetch categories: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to fetch categories: {str(e)}")


@router.get("/toolkits")
async def list_toolkits(
    limit: int = Query(100, le=500),
    cursor: Optional[str] = Query(None),
    search: Optional[str] = Query(None),
    category: Optional[str] = Query(None),
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict[str, Any]:
    try:
        logger.debug(f"Fetching Composio toolkits with limit: {limit}, cursor: {cursor}, search: {search}, category: {category}")
        
        service = get_integration_service()
        
        if search:
            result = await service.search_toolkits(search, category=category, limit=limit, cursor=cursor)
        else:
            result = await service.list_available_toolkits(limit, cursor=cursor, category=category)
        
        return {
            "success": True,
            "toolkits": [toolkit.dict() for toolkit in result.get('items', [])],
            "total_items": result.get('total_items', 0),
            "total_pages": result.get('total_pages', 0),
            "current_page": result.get('current_page', 1),
            "next_cursor": result.get('next_cursor'),
            "has_more": result.get('next_cursor') is not None
        }
        
    except Exception as e:
        logger.error(f"Failed to fetch toolkits: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to fetch toolkits: {str(e)}")


@router.get("/toolkits/{toolkit_slug}/details")
async def get_toolkit_details(
    toolkit_slug: str,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict[str, Any]:
    try:
        logger.debug(f"Fetching detailed toolkit info for: {toolkit_slug}")
        
        toolkit_service = ToolkitService()
        detailed_toolkit = await toolkit_service.get_detailed_toolkit_info(toolkit_slug)
        
        if not detailed_toolkit:
            raise HTTPException(status_code=404, detail=f"Toolkit {toolkit_slug} not found")
        
        return {
            "success": True,
            "toolkit": detailed_toolkit.dict()
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to fetch toolkit details for {toolkit_slug}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to fetch toolkit details: {str(e)}")


@router.post("/integrate", response_model=IntegrationStatusResponse)
async def integrate_toolkit(
    request: IntegrateToolkitRequest,
    current_user_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> IntegrationStatusResponse:
    try:
        integration_user_id = str(uuid4())
        logger.debug(f"Generated integration user_id: {integration_user_id} for account: {current_user_id}")
        
        service = get_integration_service(db_connection=db)
        result = await service.integrate_toolkit(
            toolkit_slug=request.toolkit_slug,
            account_id=current_user_id,
            user_id=integration_user_id,
            profile_name=request.profile_name,
            display_name=request.display_name,
            mcp_server_name=request.mcp_server_name,
            save_as_profile=request.save_as_profile
        )
        
        return IntegrationStatusResponse(
            status="integrated",
            toolkit=result.toolkit.name,
            auth_config_id=result.auth_config.id,
            connected_account_id=result.connected_account.id,
            mcp_server_id=result.mcp_server.id,
            final_mcp_url=result.final_mcp_url,
            profile_id=result.profile_id,
            redirect_url=result.connected_account.redirect_url
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Integration failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/profiles", response_model=ProfileResponse)
async def create_profile(
    request: CreateProfileRequest,
    current_user_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> ProfileResponse:
    try:
        # For Zendesk, we need a unique user_id for each connection
        # even when using a shared auth config
        if request.toolkit_slug.lower() == "zendesk":
            # Create a unique user_id by combining current_user_id with a UUID
            integration_user_id = f"{current_user_id}-{str(uuid4())[:8]}"
            logger.debug(f"Generated unique Zendesk user_id: {integration_user_id} for account: {current_user_id}")
        else:
            # For other toolkits, use a standard UUID
            integration_user_id = str(uuid4())
            logger.debug(f"Generated integration user_id: {integration_user_id} for account: {current_user_id}")
        
        service = get_integration_service(db_connection=db)
        result = await service.integrate_toolkit(
            toolkit_slug=request.toolkit_slug,
            account_id=current_user_id,
            user_id=integration_user_id,
            profile_name=request.profile_name,
            display_name=request.display_name,
            mcp_server_name=request.mcp_server_name,
            save_as_profile=True,
            initiation_fields=request.initiation_fields,
            custom_auth_config=request.custom_auth_config,
            use_custom_auth=request.use_custom_auth
        )
        
        logger.debug(f"Integration result for {request.toolkit_slug}: redirect_url = {result.connected_account.redirect_url}")
        profile_service = ComposioProfileService(db)
        profiles = await profile_service.get_profiles(current_user_id, request.toolkit_slug)

        created_profile = None
        for profile in profiles:
            if profile.profile_name == request.profile_name:
                created_profile = profile
                break
        
        if not created_profile:
            raise HTTPException(status_code=500, detail="Profile created but not found")
        
        logger.debug(f"Returning profile response with redirect_url: {created_profile.redirect_url}")
        
        return ProfileResponse.from_composio_profile(created_profile)
        
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Failed to create profile: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/profiles/check-name-availability")
async def check_profile_name_availability(
    toolkit_slug: str = Query(..., description="The toolkit slug to check against"),
    profile_name: str = Query(..., description="The profile name to check"),
    current_user_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict[str, Any]:
    try:
        profile_service = ComposioProfileService(db)
        profiles = await profile_service.get_profiles(current_user_id, toolkit_slug)
        
        name_exists = any(
            profile.profile_name.lower() == profile_name.lower() 
            for profile in profiles
        )
        suggestions = []
        if name_exists:
            base_name = profile_name.rstrip('0123456789').rstrip()
            counter = 1
            existing_names = {p.profile_name.lower() for p in profiles}
            
            while len(suggestions) < 3:
                suggested_name = f"{base_name} {counter}"
                if suggested_name.lower() not in existing_names:
                    suggestions.append(suggested_name)
                counter += 1
        
        return {
            "available": not name_exists,
            "message": "Profile name is available" if not name_exists else "Profile name already exists",
            "suggestions": suggestions
        }
        
    except Exception as e:
        logger.error(f"Failed to check profile name availability: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/profiles")
async def get_profiles(
    toolkit_slug: Optional[str] = Query(None),
    current_user_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict[str, Any]:
    try:
        profile_service = ComposioProfileService(db)
        profiles = await profile_service.get_profiles(current_user_id, toolkit_slug)
        
        profile_responses = [ProfileResponse.from_composio_profile(profile) for profile in profiles]
        
        return {
            "success": True,
            "profiles": profile_responses
        }
        
    except Exception as e:
        logger.error(f"Failed to get profiles: {e}", exc_info=True)
        return {
            "success": False,
            "profiles": [],
            "error": str(e)
        }


@router.get("/profiles/{profile_id}/mcp-config")
async def get_profile_mcp_config(
    profile_id: str,
    current_user_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict[str, Any]:
    try:
        profile_service = ComposioProfileService(db)
        mcp_config = await profile_service.get_mcp_config_for_agent(profile_id)
        
        return {
            "success": True,
            "mcp_config": mcp_config,
            "profile_id": profile_id
        }
        
    except Exception as e:
        logger.error(f"Failed to get MCP config for profile {profile_id}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to get MCP config: {str(e)}")


@router.get("/profiles/{profile_id}")
async def get_profile_info(
    profile_id: str,
    current_user_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict[str, Any]:
    try:
        profile_service = ComposioProfileService(db)
        profile = await profile_service.get_profile(profile_id, current_user_id)
        
        if not profile:
            raise HTTPException(status_code=404, detail="Profile not found")
        
        return {
            "success": True,
            "profile": {
                "profile_id": profile.profile_id,
                "profile_name": profile.profile_name,
                "toolkit_name": profile.toolkit_name,
                "toolkit_slug": profile.toolkit_slug,
                "created_at": profile.created_at.isoformat() if profile.created_at else None
            }
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to get profile info for {profile_id}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to get profile info: {str(e)}")


@router.get("/integration/{connected_account_id}/status")
async def get_integration_status(
    connected_account_id: str,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict[str, Any]:
    try:
        service = get_integration_service()
        status = await service.get_integration_status(connected_account_id)
        return {"connected_account_id": connected_account_id, **status}
    except Exception as e:
        logger.error(f"Failed to get status: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/profiles/{profile_id}/discover-tools")
async def discover_composio_tools(
    profile_id: str,
    current_user_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict[str, Any]:
    try:
        profile_service = ComposioProfileService(db)
        config = await profile_service.get_profile_config(profile_id)
        
        if config.get('type') != 'composio':
            raise HTTPException(status_code=400, detail="Not a Composio profile")
        
        mcp_url = config.get('mcp_url')
        if not mcp_url:
            raise HTTPException(status_code=400, detail="Profile has no MCP URL")
        
        from core.mcp_module.mcp_service import mcp_service
        
        result = await mcp_service.discover_custom_tools(
            request_type="http",
            config={"url": mcp_url}
        )
        
        if not result.success:
            raise HTTPException(status_code=500, detail=f"Failed to discover tools: {result.message}")
        
        logger.debug(f"Discovered {len(result.tools)} tools from Composio profile {profile_id}")
        
        return {
            "success": True,
            "profile_id": profile_id,
            "toolkit_name": config.get('toolkit_name', 'Unknown'),
            "tools": result.tools,
            "total_tools": len(result.tools)
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to discover tools for profile {profile_id}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/discover-tools/{profile_id}")
async def discover_tools_post(
    profile_id: str,
    current_user_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict[str, Any]:
    return await discover_composio_tools(profile_id, current_user_id)

@router.get("/toolkits/{toolkit_slug}/icon")
async def get_toolkit_icon(
    toolkit_slug: str,
    current_user_id: Optional[str] = Depends(get_optional_current_user_id_from_jwt)
):
    try:
        toolkit_service = ToolkitService()
        icon_url = await toolkit_service.get_toolkit_icon(toolkit_slug)
        
        if icon_url:
            return {
                "success": True,
                "toolkit_slug": toolkit_slug,
                "icon_url": icon_url
            }
        else:
            return {
                "success": False,
                "toolkit_slug": toolkit_slug,
                "icon_url": None,
                "message": "Icon not found"
            }
    
    except Exception as e:
        logger.error(f"Error getting toolkit icon: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")


@router.post("/tools/list")
async def list_toolkit_tools(
    request: ToolsListRequest,
    current_user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    try:
        logger.debug(f"User {current_user_id} requesting tools for toolkit: {request.toolkit_slug}")
        
        toolkit_service = ToolkitService()
        tools_response = await toolkit_service.get_toolkit_tools(
            toolkit_slug=request.toolkit_slug,
            limit=request.limit,
            cursor=request.cursor
        )
        
        return {
            "success": True,
            "tools": [tool.dict() for tool in tools_response.items],
            "total_items": tools_response.total_items,
            "current_page": tools_response.current_page,
            "total_pages": tools_response.total_pages,
            "next_cursor": tools_response.next_cursor
        }
        
    except Exception as e:
        logger.error(f"Failed to list toolkit tools for {request.toolkit_slug}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to get toolkit tools: {str(e)}")


@router.get("/triggers/apps")
async def list_apps_with_triggers(
    user_id: str = Depends(verify_and_get_user_id_from_jwt),
) -> Dict[str, Any]:
    try:
        trigger_service = ComposioTriggerService()
        return await trigger_service.list_apps_with_triggers()
    except httpx.HTTPError as e:
        logger.error(f"Failed to fetch Composio triggers/apps: {e}")
        raise HTTPException(status_code=502, detail="Composio API error")
    except Exception as e:
        logger.error(f"Error building apps-with-triggers list: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")


@router.get("/triggers/apps/{toolkit_slug}")
async def list_triggers_for_app(
    toolkit_slug: str,
    user_id: str = Depends(verify_and_get_user_id_from_jwt),
) -> Dict[str, Any]:
    try:
        trigger_service = ComposioTriggerService()
        return await trigger_service.list_triggers_for_app(toolkit_slug)
    except httpx.HTTPError as e:
        logger.error(f"Failed to fetch triggers for app {toolkit_slug}: {e}")
        raise HTTPException(status_code=502, detail="Composio API error")
    except Exception as e:
        logger.error(f"Error listing triggers for app {toolkit_slug}: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")


class CreateComposioTriggerRequest(BaseModel):
    agent_id: str
    profile_id: str
    slug: str
    trigger_config: Dict[str, Any]
    route: str  # 'agent' | 'workflow'
    name: Optional[str] = None
    agent_prompt: Optional[str] = None
    workflow_id: Optional[str] = None
    workflow_input: Optional[Dict[str, Any]] = None
    connected_account_id: Optional[str] = None
    webhook_url: Optional[str] = None
    toolkit_slug: Optional[str] = None


@router.post("/triggers/create")
async def create_composio_trigger(req: CreateComposioTriggerRequest, current_user_id: str = Depends(verify_and_get_user_id_from_jwt)) -> Dict[str, Any]:
    try:
        client_db = await db.client
        agent_check = await client_db.table('agents').select('agent_id').eq('agent_id', req.agent_id).eq('account_id', current_user_id).execute()
        if not agent_check.data:
            raise HTTPException(status_code=404, detail="Agent not found or access denied")

        profile_service = ComposioProfileService(db)
        profile_config = await profile_service.get_profile_config(req.profile_id)
        composio_user_id = profile_config.get("user_id")
        if not composio_user_id:
            raise HTTPException(status_code=400, detail="Composio profile is missing user_id")
        
        toolkit_slug = req.toolkit_slug
        if not toolkit_slug:
            toolkit_slug = profile_config.get("toolkit_slug")

        if not toolkit_slug and req.slug:
            toolkit_slug = req.slug.split('_')[0].lower() if '_' in req.slug else 'composio'

        qualified_name = f'composio.{toolkit_slug}' if toolkit_slug and toolkit_slug != 'composio' else 'composio'

        api_key = os.getenv("COMPOSIO_API_KEY")
        if not api_key:
            raise HTTPException(status_code=500, detail="COMPOSIO_API_KEY not configured")

        url = f"{COMPOSIO_API_BASE}/api/v3/trigger_instances/{req.slug}/upsert"
        headers = {"x-api-key": api_key, "Content-Type": "application/json"}
        base_url = os.getenv("WEBHOOK_BASE_URL", "http://localhost:8000")
        secret = os.getenv("COMPOSIO_WEBHOOK_SECRET", "")
        webhook_headers = {"X-Composio-Secret": secret} if secret else {}
        vercel_bypass = os.getenv("VERCEL_PROTECTION_BYPASS_KEY", "")
        if vercel_bypass:
            webhook_headers["X-Vercel-Protection-Bypass"] = vercel_bypass

        coerced_config = dict(req.trigger_config or {})
        try:
            type_url = f"{COMPOSIO_API_BASE}/api/v3/triggers_types/{req.slug}"
            async with httpx.AsyncClient(timeout=10) as http_client:
                tr = await http_client.get(type_url, headers=headers)
                if tr.status_code == 200:
                    tdata = tr.json()
                    schema = tdata.get("config") or {}
                    props = schema.get("properties") or {}
                    for key, prop in props.items():
                        if key not in coerced_config:
                            continue
                        val = coerced_config[key]
                        ptype = prop.get("type") if isinstance(prop, dict) else None
                        try:
                            if ptype == "array":
                                if isinstance(val, str):
                                    coerced_config[key] = [val]
                            elif ptype == "integer":
                                if isinstance(val, str) and val.isdigit():
                                    coerced_config[key] = int(val)
                            elif ptype == "number":
                                if isinstance(val, str):
                                    coerced_config[key] = float(val)
                            elif ptype == "boolean":
                                if isinstance(val, str):
                                    coerced_config[key] = val.lower() in ("true", "1", "yes")
                            elif ptype == "string":
                                if isinstance(val, (list, tuple)):
                                    # join list into comma-separated string
                                    coerced_config[key] = ",".join(str(x) for x in val)
                                elif not isinstance(val, str):
                                    coerced_config[key] = str(val)
                        except Exception:
                            pass
        except Exception:
            pass

        body = {
            "user_id": composio_user_id,
            "trigger_config": coerced_config,
        }
        if req.connected_account_id:
            body["connected_account_id"] = req.connected_account_id

        async with httpx.AsyncClient(timeout=20) as http_client:
            resp = await http_client.post(url, headers=headers, json=body)
            try:
                resp.raise_for_status()
            except httpx.HTTPStatusError:
                ct = resp.headers.get("content-type", "")
                if "application/json" in ct:
                    detail = resp.json()
                else:
                    detail = resp.text
                logger.error(f"Composio upsert error: {detail}")
                raise HTTPException(status_code=400, detail=detail)
            created = resp.json()
            try:
                top_keys = list(created.keys()) if isinstance(created, dict) else None
                logger.debug(
                    "Composio upsert ok",
                    slug=req.slug,
                    status_code=resp.status_code,
                    top_keys=top_keys,
                )
            except Exception:
                pass

        composio_trigger_id = None
        def _extract_id(obj: Dict[str, Any]) -> Optional[str]:
            if not isinstance(obj, dict):
                return None
            cand = (
                obj.get("id")
                or obj.get("trigger_id")
                or obj.get("triggerId")
                or obj.get("nano_id")
                or obj.get("nanoId")
                or obj.get("triggerNanoId")
            )
            if cand:
                return cand
            # Nested shapes
            for k in ("trigger", "trigger_instance", "triggerInstance", "data", "result"):
                nested = obj.get(k)
                if isinstance(nested, dict):
                    nid = _extract_id(nested)
                    if nid:
                        return nid
                if isinstance(nested, list) and nested:
                    nid = _extract_id(nested[0])
                    if nid:
                        return nid
            return None

        if isinstance(created, dict):
            composio_trigger_id = _extract_id(created)
            try:
                logger.debug(
                    "Composio extracted trigger id",
                    slug=req.slug,
                    extracted_id=composio_trigger_id,
                )
            except Exception:
                pass

        if not composio_trigger_id:
            raise HTTPException(status_code=500, detail="Failed to get Composio trigger id from response")

        # Build Suna trigger config
        suna_config: Dict[str, Any] = {
            "provider_id": "composio",
            "composio_trigger_id": composio_trigger_id,
            "trigger_slug": req.slug,
            "qualified_name": qualified_name,  # Store the qualified_name for template export
            "execution_type": req.route if req.route in ("agent", "workflow") else "agent",
            "profile_id": req.profile_id,
        }
        if suna_config["execution_type"] == "agent":
            if req.agent_prompt:
                suna_config["agent_prompt"] = req.agent_prompt
        else:
            if not req.workflow_id:
                raise HTTPException(status_code=400, detail="workflow_id is required for workflow route")
            suna_config["workflow_id"] = req.workflow_id
            if req.workflow_input:
                suna_config["workflow_input"] = req.workflow_input

        # Create Suna trigger
        trigger_service = get_trigger_service(db)
        trigger = await trigger_service.create_trigger(
            agent_id=req.agent_id,
            provider_id="composio",
            name=req.name or f"{req.slug}",
            config=suna_config,
            description=f"Composio event: {req.slug}"
        )

        # Immediately sync triggers to the current version config
        await sync_triggers_to_version_config(req.agent_id)

        base_url = os.getenv("WEBHOOK_BASE_URL", "http://localhost:8000")
        webhook_url = f"{base_url}/api/composio/webhook"

        return {
            "success": True,
            "trigger_id": trigger.trigger_id,
            "agent_id": trigger.agent_id,
            "provider": "composio",
            "composio_trigger_id": composio_trigger_id,
            "slug": req.slug,
            "webhook_url": webhook_url,
            "config": trigger.config,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to create Composio trigger: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/webhook")
async def composio_webhook(request: Request):
    """Shared Composio webhook endpoint. Verifies secret, matches triggers, and enqueues execution."""
    try:
     
        # Read raw body first (can only be done once)
        try:
            body = await request.body()
            body_str = body.decode('utf-8') if body else ""
            logger.info("Composio webhook raw body", body=body_str, body_length=len(body) if body else 0)
        except Exception as e:
            logger.info("Composio webhook body read failed", error=str(e))
            body_str = ""
        
        # Get webhook ID early for logging
        wid = request.headers.get("webhook-id", "")

        # Minimal request diagnostics (no secrets)
        try:
            client_ip = request.client.host if request.client else None
            header_names = list(request.headers.keys())
            has_auth = bool(request.headers.get("authorization"))
            has_x_secret = bool(request.headers.get("x-composio-secret") or request.headers.get("X-Composio-Secret"))
            has_x_trigger = bool(request.headers.get("x-trigger-secret") or request.headers.get("X-Trigger-Secret"))
            
            # Parse payload for logging
            payload_preview = {"keys": []}
            try:
                if body_str:
                    _p = json.loads(body_str)
                    payload_preview = {
                        "keys": list(_p.keys()) if isinstance(_p, dict) else [],
                        "id": _p.get("id") if isinstance(_p, dict) else None,
                        "triggerSlug": _p.get("triggerSlug") if isinstance(_p, dict) else None,
                    }
            except Exception:
                payload_preview = {"keys": []}
        except Exception:
            pass

        secret = os.getenv("COMPOSIO_WEBHOOK_SECRET")
        if not secret:
            logger.error("COMPOSIO_WEBHOOK_SECRET is not configured")
            raise HTTPException(status_code=500, detail="Webhook secret not configured")

        # Use robust verifier (tries ASCII/HEX/B64 keys and id.ts.body/ts.body)
        await verify_composio(request, "COMPOSIO_WEBHOOK_SECRET")

        # Parse payload for processing
        try:
            payload = json.loads(body_str) if body_str else {}
        except Exception as parse_error:
            logger.error(f"Failed to parse webhook payload: {parse_error}", payload_raw=body_str)
            payload = {}

        # Look for trigger_nano_id in data.trigger_nano_id (the actual Composio trigger instance ID)
        composio_trigger_id = (
            (payload.get("data", {}) or {}).get("trigger_nano_id")
        )
        provider_event_id = (
            payload.get("eventId")
            or payload.get("payload", {}).get("id")
            or payload.get("id")
            or wid
        )
        # Derive trigger slug from various shapes
        trigger_slug = (
            payload.get("triggerSlug")
            or payload.get("type")
            or (payload.get("data", {}) or {}).get("triggerSlug")
            or (payload.get("data", {}) or {}).get("type")
        )

        # Basic parsed-field logging (no secrets)
        try:
            logger.info(
                "Composio parsed fields",
                webhook_id=wid,
                trigger_slug=trigger_slug,
                composio_trigger_id=composio_trigger_id,
                provider_event_id=provider_event_id,
                payload_keys=list(payload.keys()) if isinstance(payload, dict) else [],
            )
        except Exception:
            pass

        client = await db.client

        # Fetch all active WEBHOOK triggers and filter by provider 'composio'
        # If neither id nor slug present, ack 200 to avoid Composio retries
        if not (composio_trigger_id or trigger_slug):
            logger.warning("No trigger id or slug; acking 200")
            return JSONResponse(content={"success": True, "matched_triggers": 0})

        try:
            res = await client.table("agent_triggers").select("*").eq("trigger_type", "webhook").eq("is_active", True).execute()
            rows = res.data or []
        except Exception as e:
            logger.error(f"Error fetching agent_triggers: {e}")
            rows = []

        matched = []
        
        for row in rows:
            cfg = row.get("config") or {}
            if not isinstance(cfg, dict):
                continue
            prov = cfg.get("provider_id") or row.get("provider_id")
            if prov != "composio":
                logger.debug("Composio skip non-provider", trigger_id=row.get("trigger_id"), provider_id=prov)
                continue
            
            # ONLY match by exact composio_trigger_id - no slug fallback
            cfg_tid = cfg.get("composio_trigger_id")
            if composio_trigger_id and cfg_tid == composio_trigger_id:
                logger.info(
                    "Composio EXACT ID MATCH", 
                    trigger_id=row.get("trigger_id"), 
                    cfg_composio_trigger_id=cfg_tid,
                    payload_composio_trigger_id=composio_trigger_id,
                    is_active=row.get("is_active")
                )
                matched.append(row)
                continue
            else:
                logger.info(
                    "Composio ID mismatch",
                    trigger_id=row.get("trigger_id"),
                    cfg_composio_trigger_id=cfg_tid,
                    payload_composio_trigger_id=composio_trigger_id,
                    match_found=False,
                    is_active=row.get("is_active")
                )

        if not matched:
            logger.error(
                f"No exact ID match found for Composio trigger {composio_trigger_id}",
                payload_id=composio_trigger_id,
                total_triggers=len(rows),
                matched_count=len(matched)
            )
            return JSONResponse(content={"success": True, "matched_triggers": 0})

        trigger_service = get_trigger_service(db)
        execution_service = get_execution_service(db)

        executed = 0
        for row in matched:
            trigger_id = row.get("trigger_id")
            if not trigger_id:
                continue
            result = await trigger_service.process_trigger_event(trigger_id, payload)
            if result.success and (result.should_execute_agent or result.should_execute_workflow):
                trigger = await trigger_service.get_trigger(trigger_id)
                if not trigger:
                    continue
                ctx = {
                    "payload": payload,
                    "trigger_slug": trigger_slug,
                    "webhook_id": wid,
                }
                event = TriggerEvent(
                    trigger_id=trigger_id,
                    agent_id=trigger.agent_id,
                    trigger_type=TriggerType.EVENT,
                    raw_data=payload,
                    context=ctx,
                )
                await execution_service.execute_trigger_result(
                    agent_id=trigger.agent_id,
                    trigger_result=result,
                    trigger_event=event,
                )
                executed += 1

        return JSONResponse(content={
            "success": True,
            "matched_triggers": len(matched),
            "executed": executed,
        })

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error handling Composio webhook: {e}")
        return JSONResponse(status_code=500, content={"success": False, "error": "Internal server error"})


@router.get("/health")
async def health_check() -> Dict[str, str]:
    try:
        from .client import ComposioClient
        ComposioClient.get_client()
        return {"status": "healthy"}
    except Exception as e:
        logger.error(f"Health check failed: {e}")
        raise HTTPException(status_code=503, detail=str(e))
