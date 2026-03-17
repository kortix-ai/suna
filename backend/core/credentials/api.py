from fastapi import APIRouter, HTTPException, Depends
from typing import List, Optional, Dict, Any, cast
from pydantic import BaseModel, validator
import urllib.parse

from core.utils.logger import logger
from core.utils.auth_utils import verify_and_get_user_id_from_jwt
from core.services.supabase import DBConnection

from .credential_service import (
    get_credential_service
)
from .profile_service import (
    get_profile_service, 
    ProfileAccessDeniedError
)
from .utils import validate_config_not_empty, decode_mcp_qualified_name, extract_config_keys

router = APIRouter(tags=["credentials"])

db: Optional[DBConnection] = None

class StoreCredentialRequest(BaseModel):
    mcp_qualified_name: str
    display_name: str
    config: Dict[str, Any]
    
    @validator('config')
    def validate_config_not_empty_field(cls, v):
        return validate_config_not_empty(v)


class StoreCredentialProfileRequest(BaseModel):
    mcp_qualified_name: str
    profile_name: str
    display_name: str
    config: Dict[str, Any]
    is_default: bool = False
    
    @validator('config')
    def validate_config_not_empty_field(cls, v):
        return validate_config_not_empty(v)


class BulkDeleteProfilesRequest(BaseModel):
    profile_ids: List[str]


class CredentialResponse(BaseModel):
    credential_id: str
    mcp_qualified_name: str
    display_name: str
    config_keys: List[str]
    is_active: bool
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class CredentialProfileResponse(BaseModel):
    profile_id: str
    mcp_qualified_name: str
    profile_name: str
    display_name: str
    config_keys: List[str]
    is_active: bool
    is_default: bool
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class BulkDeleteProfilesResponse(BaseModel):
    success: bool
    deleted_count: int
    failed_profiles: List[str] = []
    message: str


class ComposioProfileSummary(BaseModel):
    profile_id: str
    profile_name: str
    display_name: str
    toolkit_slug: str
    toolkit_name: str
    is_connected: bool
    is_default: bool
    created_at: str
    has_mcp_url: bool


class ComposioToolkitGroup(BaseModel):
    toolkit_slug: str
    toolkit_name: str
    icon_url: Optional[str] = None
    profiles: List[ComposioProfileSummary]


class ComposioCredentialsResponse(BaseModel):
    success: bool
    toolkits: List[ComposioToolkitGroup]
    total_profiles: int


class ComposioMcpUrlResponse(BaseModel):
    success: bool
    mcp_url: str
    profile_name: str
    toolkit_name: str
    warning: str


def initialize(database: DBConnection):
    global db
    db = database


def _get_db() -> DBConnection:
    if db is None:
        raise RuntimeError("Credentials API database is not initialized")
    return cast(DBConnection, db)


def _extract_profile_id_from_mcp(mcp: Any) -> Optional[str]:
    if not isinstance(mcp, dict):
        return None
    config = mcp.get("config")
    if not isinstance(config, dict):
        return None
    profile_id = config.get("profile_id")
    return str(profile_id) if profile_id is not None else None


async def _remove_profile_references_from_agent_configs(account_id: str, profile_id: str) -> int:
    """Remove a deleted credential profile reference from current agent custom_mcps."""
    client = await _get_db().client
    agents_result = await client.table("agents").select("agent_id,current_version_id").eq("account_id", account_id).execute()
    agent_rows = agents_result.data or []
    if not agent_rows:
        return 0

    from core.versioning.version_service import get_version_service

    version_service = await get_version_service()
    updated_agents = 0

    for agent_row in agent_rows:
        agent_id = agent_row.get("agent_id")
        current_version_id = agent_row.get("current_version_id")
        if not agent_id or not current_version_id:
            continue

        version_result = await client.table("agent_versions").select("config").eq("version_id", current_version_id).maybe_single().execute()
        version_result_data: Dict[str, Any] = {}
        if version_result is not None and isinstance(getattr(version_result, "data", None), dict):
            version_result_data = cast(Dict[str, Any], getattr(version_result, "data"))
        version_config: Dict[str, Any] = {}
        raw_config = version_result_data.get("config")
        if isinstance(raw_config, dict):
            version_config = raw_config

        tools_config: Dict[str, Any] = {}
        raw_tools = version_config.get("tools")
        if isinstance(raw_tools, dict):
            tools_config = raw_tools

        current_custom_mcps_raw = tools_config.get("custom_mcp")
        if not isinstance(current_custom_mcps_raw, list) or not current_custom_mcps_raw:
            continue

        current_custom_mcps = cast(List[Dict[str, Any]], current_custom_mcps_raw)

        filtered_custom_mcps = [
            mcp for mcp in current_custom_mcps
            if _extract_profile_id_from_mcp(mcp) != profile_id
        ]

        if len(filtered_custom_mcps) == len(current_custom_mcps):
            continue

        configured_mcps_raw = tools_config.get("mcp")
        configured_mcps = configured_mcps_raw if isinstance(configured_mcps_raw, list) else []
        agentpress_tools_raw = tools_config.get("agentpress")
        agentpress_tools = agentpress_tools_raw if isinstance(agentpress_tools_raw, dict) else {}
        system_prompt_raw = version_config.get("system_prompt") if isinstance(version_config, dict) else ""
        system_prompt = system_prompt_raw if isinstance(system_prompt_raw, str) else ""
        model = version_config.get("model")

        await version_service.create_version(
            agent_id=cast(str, agent_id),
            user_id=account_id,
            system_prompt=cast(str, system_prompt),
            model=model,
            configured_mcps=cast(List[Dict[str, Any]], configured_mcps),
            custom_mcps=cast(List[Dict[str, Any]], filtered_custom_mcps),
            agentpress_tools=cast(Dict[str, Any], agentpress_tools),
            change_description=f"Removed deleted credential profile {profile_id}",
        )
        updated_agents += 1

    return updated_agents


@router.post("/credentials", response_model=CredentialResponse)
async def store_credential(
    request: StoreCredentialRequest,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    try:
        credential_service = get_credential_service(_get_db())
        
        credential_id = await credential_service.store_credential(
            account_id=user_id,
            mcp_qualified_name=request.mcp_qualified_name,
            display_name=request.display_name,
            config=request.config
        )
        
        credential = await credential_service.get_credential(user_id, request.mcp_qualified_name)
        if not credential:
            raise HTTPException(status_code=500, detail="Failed to retrieve stored credential")
        
        return CredentialResponse(
            credential_id=credential.credential_id,
            mcp_qualified_name=credential.mcp_qualified_name,
            display_name=credential.display_name,
            config_keys=extract_config_keys(credential.config),
            is_active=credential.is_active,
            created_at=credential.created_at.isoformat() if credential.created_at else None,
            updated_at=credential.updated_at.isoformat() if credential.updated_at else None
        )
        
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Error storing credential: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")


@router.get("/credentials", response_model=List[CredentialResponse])
async def get_user_credentials(
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    try:
        credential_service = get_credential_service(_get_db())
        credentials = await credential_service.get_user_credentials(user_id)
        
        return [
            CredentialResponse(
                credential_id=cred.credential_id,
                mcp_qualified_name=cred.mcp_qualified_name,
                display_name=cred.display_name,
                config_keys=extract_config_keys(cred.config),
                is_active=cred.is_active,
                created_at=cred.created_at.isoformat() if cred.created_at else None,
                updated_at=cred.updated_at.isoformat() if cred.updated_at else None
            )
            for cred in credentials
        ]
        
    except Exception as e:
        logger.error(f"Error getting user credentials: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")


@router.delete("/credentials/{mcp_qualified_name:path}")
async def delete_credential(
    mcp_qualified_name: str,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    try:
        decoded_name = decode_mcp_qualified_name(mcp_qualified_name)
        
        credential_service = get_credential_service(_get_db())
        success = await credential_service.delete_credential(user_id, decoded_name)
        
        if not success:
            raise HTTPException(status_code=404, detail="Credential not found")
        
        return {"message": "Credential deleted successfully"}
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting credential: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")


@router.post("/credential-profiles", response_model=CredentialProfileResponse)
async def store_credential_profile(
    request: StoreCredentialProfileRequest,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    try:
        profile_service = get_profile_service(_get_db())
        
        profile_id = await profile_service.store_profile(
            account_id=user_id,
            mcp_qualified_name=request.mcp_qualified_name,
            profile_name=request.profile_name,
            display_name=request.display_name,
            config=request.config,
            is_default=request.is_default
        )
        
        profile = await profile_service.get_profile(user_id, profile_id)
        if not profile:
            raise HTTPException(status_code=500, detail="Failed to retrieve stored profile")
        
        return CredentialProfileResponse(
            profile_id=profile.profile_id,
            mcp_qualified_name=profile.mcp_qualified_name,
            profile_name=profile.profile_name,
            display_name=profile.display_name,
            config_keys=extract_config_keys(profile.config),
            is_active=profile.is_active,
            is_default=profile.is_default,
            created_at=profile.created_at.isoformat() if profile.created_at else None,
            updated_at=profile.updated_at.isoformat() if profile.updated_at else None
        )
        
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Error storing credential profile: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")


@router.get("/credential-profiles", response_model=List[CredentialProfileResponse])
async def get_user_credential_profiles(
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    try:
        profile_service = get_profile_service(_get_db())
        profiles = await profile_service.get_all_user_profiles(user_id)
        
        return [
            CredentialProfileResponse(
                profile_id=profile.profile_id,
                mcp_qualified_name=profile.mcp_qualified_name,
                profile_name=profile.profile_name,
                display_name=profile.display_name,
                config_keys=extract_config_keys(profile.config),
                is_active=profile.is_active,
                is_default=profile.is_default,
                created_at=profile.created_at.isoformat() if profile.created_at else None,
                updated_at=profile.updated_at.isoformat() if profile.updated_at else None
            )
            for profile in profiles
        ]
        
    except Exception as e:
        logger.error(f"Error getting user credential profiles: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")


@router.get("/credential-profiles/{mcp_qualified_name:path}", response_model=List[CredentialProfileResponse])
async def get_credential_profiles_for_mcp(
    mcp_qualified_name: str,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    try:
        decoded_name = decode_mcp_qualified_name(mcp_qualified_name)
        
        profile_service = get_profile_service(_get_db())
        profiles = await profile_service.get_profiles(user_id, decoded_name)
        
        return [
            CredentialProfileResponse(
                profile_id=profile.profile_id,
                mcp_qualified_name=profile.mcp_qualified_name,
                profile_name=profile.profile_name,
                display_name=profile.display_name,
                config_keys=extract_config_keys(profile.config),
                is_active=profile.is_active,
                is_default=profile.is_default,
                created_at=profile.created_at.isoformat() if profile.created_at else None,
                updated_at=profile.updated_at.isoformat() if profile.updated_at else None
            )
            for profile in profiles
        ]
        
    except Exception as e:
        logger.error(f"Error getting credential profiles for MCP: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")


@router.get("/credential-profiles/profile/{profile_id}", response_model=CredentialProfileResponse)
async def get_credential_profile(
    profile_id: str,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    try:
        profile_service = get_profile_service(_get_db())
        profile = await profile_service.get_profile(user_id, profile_id)
        
        if not profile:
            raise HTTPException(status_code=404, detail="Profile not found")
        
        return CredentialProfileResponse(
            profile_id=profile.profile_id,
            mcp_qualified_name=profile.mcp_qualified_name,
            profile_name=profile.profile_name,
            display_name=profile.display_name,
            config_keys=extract_config_keys(profile.config),
            is_active=profile.is_active,
            is_default=profile.is_default,
            created_at=profile.created_at.isoformat() if profile.created_at else None,
            updated_at=profile.updated_at.isoformat() if profile.updated_at else None
        )
        
    except ProfileAccessDeniedError:
        raise HTTPException(status_code=403, detail="Access denied to profile")
    except Exception as e:
        logger.error(f"Error getting credential profile: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")


@router.put("/credential-profiles/{profile_id}/set-default")
async def set_default_credential_profile(
    profile_id: str,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    try:
        profile_service = get_profile_service(_get_db())
        success = await profile_service.set_default_profile(user_id, profile_id)
        
        if not success:
            raise HTTPException(status_code=404, detail="Profile not found")
        
        return {"message": "Profile set as default successfully"}
        
    except Exception as e:
        logger.error(f"Error setting default profile: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")


@router.delete("/credential-profiles/{profile_id}")
async def delete_credential_profile(
    profile_id: str,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    try:
        profile_service = get_profile_service(_get_db())
        updated_agents = await _remove_profile_references_from_agent_configs(user_id, profile_id)
        success = await profile_service.delete_profile(user_id, profile_id)
        
        if not success:
            raise HTTPException(status_code=404, detail="Profile not found")
        
        return {
            "message": "Profile deleted successfully",
            "updated_agents": updated_agents,
        }
        
    except Exception as e:
        logger.error(f"Error deleting profile: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")


@router.post("/credential-profiles/bulk-delete", response_model=BulkDeleteProfilesResponse)
async def bulk_delete_credential_profiles(
    request: BulkDeleteProfilesRequest,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    try:
        profile_service = get_profile_service(_get_db())
        deleted_count = 0
        failed_profiles = []
        for profile_id in request.profile_ids:
            try:
                await _remove_profile_references_from_agent_configs(user_id, profile_id)
                success = await profile_service.delete_profile(user_id, profile_id)
                if success:
                    deleted_count += 1
                else:
                    failed_profiles.append(profile_id)
            except Exception as e:
                logger.error(f"Error deleting profile {profile_id}: {e}")
                failed_profiles.append(profile_id)
        
        return BulkDeleteProfilesResponse(
            success=True,
            deleted_count=deleted_count,
            failed_profiles=failed_profiles,
            message="Bulk deletion completed"
        )
    except Exception as e:
        logger.error(f"Error performing bulk deletion: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")


@router.get("/composio-profiles", response_model=ComposioCredentialsResponse)
async def get_composio_profiles(
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    try:
        profile_service = get_profile_service(_get_db())
        from core.composio_integration.composio_profile_service import ComposioProfileService
        composio_service = ComposioProfileService(_get_db())
        
        all_profiles = await profile_service.get_all_user_profiles(user_id)
        
        composio_profiles = [
            profile for profile in all_profiles 
            if profile.mcp_qualified_name.startswith('composio.')
        ]
        
        from core.composio_integration.toolkit_service import ToolkitService
        toolkit_service = ToolkitService()
        
        toolkit_groups = {}
        for profile in composio_profiles:
            mcp_parts = profile.mcp_qualified_name.split('.')
            if len(mcp_parts) >= 2:
                toolkit_slug = mcp_parts[1]
                toolkit_name = toolkit_slug.replace('_', ' ').title()
            else:
                config = profile.config
                toolkit_slug = config.get('toolkit_slug', 'unknown')
                toolkit_name = config.get('toolkit_name', toolkit_slug.title())
            
            if toolkit_slug not in toolkit_groups:
                try:
                    icon_url = await toolkit_service.get_toolkit_icon(toolkit_slug)
                except:
                    icon_url = None
                
                toolkit_groups[toolkit_slug] = {
                    'toolkit_slug': toolkit_slug,
                    'toolkit_name': toolkit_name,
                    'icon_url': icon_url,
                    'profiles': []
                }
            
            has_mcp_url = False
            try:
                mcp_url = await composio_service.get_mcp_url_for_runtime(profile.profile_id, account_id=user_id)
                has_mcp_url = bool(mcp_url)
            except:
                has_mcp_url = False
            
            profile_summary = ComposioProfileSummary(
                profile_id=profile.profile_id,
                profile_name=profile.profile_name,
                display_name=profile.display_name,
                toolkit_slug=toolkit_slug,
                toolkit_name=toolkit_name,
                is_connected=has_mcp_url,
                is_default=profile.is_default,
                created_at=profile.created_at.isoformat() if profile.created_at else "",
                has_mcp_url=has_mcp_url
            )
            
            toolkit_groups[toolkit_slug]['profiles'].append(profile_summary)
        
        toolkits = []
        for group_data in toolkit_groups.values():
            group_data['profiles'].sort(key=lambda p: p.created_at, reverse=True)
            toolkits.append(ComposioToolkitGroup(**group_data))
        
        toolkits.sort(key=lambda t: t.toolkit_name)
        
        return ComposioCredentialsResponse(
            success=True,
            toolkits=toolkits,
            total_profiles=len(composio_profiles)
        )
        
    except Exception as e:
        logger.error(f"Error getting Composio profiles: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")


@router.get("/composio-profiles/{profile_id}/mcp-url", response_model=ComposioMcpUrlResponse)
async def get_composio_mcp_url(
    profile_id: str,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    try:
        from core.composio_integration.composio_profile_service import ComposioProfileService
        composio_service = ComposioProfileService(_get_db())

        profile_service = get_profile_service(_get_db())
        profile = await profile_service.get_profile(user_id, profile_id)
        
        if not profile:
            raise HTTPException(status_code=404, detail="Profile not found")
        
        if not profile.mcp_qualified_name.startswith('composio.'):
            raise HTTPException(status_code=400, detail="Not a Composio profile")
        
        try:
            mcp_url = await composio_service.get_mcp_url_for_runtime(profile_id, account_id=user_id)
            config = await composio_service.get_profile_config(profile_id, account_id=user_id)
            toolkit_name = config.get('toolkit_name', 'Unknown')
        except Exception as e:
            logger.error(f"Failed to decrypt Composio profile {profile_id}: {e}")
            raise HTTPException(status_code=404, detail="MCP URL not found or could not be decrypted")
        
        return ComposioMcpUrlResponse(
            success=True,
            mcp_url=mcp_url,
            profile_name=profile.profile_name,
            toolkit_name=toolkit_name,
            warning="This MCP URL contains sensitive authentication information. Never share it publicly or include it in code repositories. Anyone with access to this URL can perform actions on your behalf."
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting Composio MCP URL: {e}")
        raise HTTPException(status_code=500, detail="Internal server error") 
