"""
Secure MCP API endpoints

This module provides API endpoints for the secure MCP credential architecture:
1. Credential management (store, retrieve, test, delete)
2. Template management (create, publish, install)
3. Agent instance management
4. Marketplace operations with security
"""

from fastapi import APIRouter, HTTPException, Depends
from typing import List, Optional, Dict, Any
from pydantic import BaseModel, validator
import asyncio
import urllib.parse

from utils.logger import logger
from utils.auth_utils import get_current_user_id_from_jwt
from .credential_manager import credential_manager, MCPCredential
from .template_manager import template_manager

router = APIRouter()

class StoreCredentialRequest(BaseModel):
    """Request model for storing MCP credentials"""
    mcp_qualified_name: str
    display_name: str
    config: Dict[str, Any]
    
    @validator('config')
    def validate_config_not_empty(cls, v):
        if not v:
            raise ValueError('Config cannot be empty')
        return v

class StoreCredentialProfileRequest(BaseModel):
    """Request model for storing MCP credential profiles"""
    mcp_qualified_name: str
    profile_name: str
    display_name: str
    config: Dict[str, Any]
    is_default: bool = False
    
    @validator('config')
    def validate_config_not_empty(cls, v):
        if not v:
            raise ValueError('Config cannot be empty')
        return v

class CredentialResponse(BaseModel):
    """Response model for MCP credentials (without sensitive data)"""
    credential_id: str
    mcp_qualified_name: str
    display_name: str
    config_keys: List[str]
    is_active: bool
    last_used_at: Optional[str]
    created_at: str
    updated_at: str

class CredentialProfileResponse(BaseModel):
    """Response model for MCP credential profiles (without sensitive data)"""
    profile_id: str
    mcp_qualified_name: str
    profile_name: str
    display_name: str
    config_keys: List[str]
    is_active: bool
    is_default: bool
    last_used_at: Optional[str]
    created_at: str
    updated_at: str

class SetDefaultProfileRequest(BaseModel):
    """Request model for setting default profile"""
    profile_id: str

class TestCredentialResponse(BaseModel):
    """Response model for credential testing"""
    success: bool
    message: str
    error_details: Optional[str] = None

class CreateTemplateRequest(BaseModel):
    """Request model for creating agent template"""
    agent_id: str
    make_public: bool = False
    tags: Optional[List[str]] = None

class InstallTemplateRequest(BaseModel):
    """Request model for installing template"""
    template_id: str
    instance_name: Optional[str] = None
    custom_system_prompt: Optional[str] = None
    profile_mappings: Optional[Dict[str, str]] = None
    custom_mcp_configs: Optional[Dict[str, Dict[str, Any]]] = None

class PublishTemplateRequest(BaseModel):
    """Request model for publishing template"""
    tags: Optional[List[str]] = None

class TemplateResponse(BaseModel):
    """Response model for agent templates"""
    template_id: str
    name: str
    description: Optional[str]
    mcp_requirements: List[Dict[str, Any]]
    agentpress_tools: Dict[str, Any]
    tags: List[str]
    is_public: bool
    download_count: int
    marketplace_published_at: Optional[str]
    created_at: str
    creator_name: Optional[str] = None
    avatar: Optional[str]
    avatar_color: Optional[str]
    is_kortix_team: Optional[bool] = False

class InstallationResponse(BaseModel):
    """Response model for template installation"""
    status: str  # 'installed', 'configs_required'
    instance_id: Optional[str] = None
    missing_regular_credentials: Optional[List[Dict[str, Any]]] = None
    missing_custom_configs: Optional[List[Dict[str, Any]]] = None
    template: Optional[Dict[str, Any]] = None

@router.post("/credentials", response_model=CredentialResponse)
async def store_mcp_credential(
    request: StoreCredentialRequest,
    user_id: str = Depends(get_current_user_id_from_jwt)
):
    """Store encrypted MCP credentials for the current user"""
    logger.info(f"Storing credential for {request.mcp_qualified_name} for user {user_id}")
    
    try:
        credential_id = await credential_manager.store_credential(
            account_id=user_id,
            mcp_qualified_name=request.mcp_qualified_name,
            display_name=request.display_name,
            config=request.config
        )
        
        # Return credential info without sensitive data
        credential = await credential_manager.get_credential(user_id, request.mcp_qualified_name)
        if not credential:
            raise HTTPException(status_code=500, detail="Failed to retrieve stored credential")
        
        return CredentialResponse(
            credential_id=credential.credential_id,
            mcp_qualified_name=credential.mcp_qualified_name,
            display_name=credential.display_name,
            config_keys=list(credential.config.keys()),
            is_active=credential.is_active,
            last_used_at=credential.last_used_at.isoformat() if credential.last_used_at and hasattr(credential.last_used_at, 'isoformat') else (str(credential.last_used_at) if credential.last_used_at else None),
            created_at=credential.created_at.isoformat() if credential.created_at and hasattr(credential.created_at, 'isoformat') else (str(credential.created_at) if credential.created_at else ""),
            updated_at=credential.updated_at.isoformat() if credential.updated_at and hasattr(credential.updated_at, 'isoformat') else (str(credential.updated_at) if credential.updated_at else "")
        )
        
    except Exception as e:
        logger.error(f"Error storing credential: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to store credential: {str(e)}")

@router.get("/credentials", response_model=List[CredentialResponse])
async def get_user_credentials(
    user_id: str = Depends(get_current_user_id_from_jwt)
):
    """Get all MCP credentials for the current user"""
    logger.info(f"Getting credentials for user {user_id}")
    
    try:
        credentials = await credential_manager.get_user_credentials(user_id)
        
        logger.debug(f"Found {len(credentials)} credentials for user {user_id}")
        for cred in credentials:
            logger.debug(f"Credential: '{cred.mcp_qualified_name}' (ID: {cred.credential_id})")
        
        return [
            CredentialResponse(
                credential_id=cred.credential_id,
                mcp_qualified_name=cred.mcp_qualified_name,
                display_name=cred.display_name,
                config_keys=list(cred.config.keys()),
                is_active=cred.is_active,
                last_used_at=cred.last_used_at.isoformat() if cred.last_used_at and hasattr(cred.last_used_at, 'isoformat') else (str(cred.last_used_at) if cred.last_used_at else None),
                created_at=cred.created_at.isoformat() if cred.created_at and hasattr(cred.created_at, 'isoformat') else (str(cred.created_at) if cred.created_at else ""),
                updated_at=cred.updated_at.isoformat() if cred.updated_at and hasattr(cred.updated_at, 'isoformat') else (str(cred.updated_at) if cred.updated_at else "")
            )
            for cred in credentials
        ]
        
    except Exception as e:
        logger.error(f"Error getting user credentials: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to get credentials: {str(e)}")

@router.post("/credentials/{mcp_qualified_name:path}/test", response_model=TestCredentialResponse)
async def test_mcp_credential(
    mcp_qualified_name: str,
    user_id: str = Depends(get_current_user_id_from_jwt)
):
    """Test if an MCP credential is valid by attempting to connect"""
    # URL decode the mcp_qualified_name to handle special characters like @
    decoded_name = urllib.parse.unquote(mcp_qualified_name)
    logger.info(f"Testing credential for '{decoded_name}' (raw: '{mcp_qualified_name}') for user {user_id}")
    
    try:
        success = await credential_manager.test_credential(user_id, decoded_name)
        
        return TestCredentialResponse(
            success=success,
            message="Connection successful" if success else "Connection failed",
            error_details=None if success else "Unable to connect with provided credentials"
        )
        
    except Exception as e:
        logger.error(f"Error testing credential: {str(e)}")
        return TestCredentialResponse(
            success=False,
            message="Test failed",
            error_details=str(e)
        )

@router.delete("/credentials/{mcp_qualified_name:path}")
async def delete_mcp_credential(
    mcp_qualified_name: str,
    user_id: str = Depends(get_current_user_id_from_jwt)
):
    """Delete (deactivate) an MCP credential"""
    # URL decode the mcp_qualified_name to handle special characters like @
    decoded_name = urllib.parse.unquote(mcp_qualified_name)
    logger.info(f"Deleting credential for '{decoded_name}' (raw: '{mcp_qualified_name}') for user {user_id}")
    
    try:
        # First check if the credential exists
        existing_credential = await credential_manager.get_credential(user_id, decoded_name)
        if not existing_credential:
            logger.warning(f"Credential not found: '{decoded_name}' for user {user_id}")
            raise HTTPException(status_code=404, detail=f"Credential not found: {decoded_name}")
        
        success = await credential_manager.delete_credential(user_id, decoded_name)
        
        if not success:
            logger.error(f"Failed to delete credential: '{decoded_name}' for user {user_id}")
            raise HTTPException(status_code=404, detail="Credential not found")
        
        logger.info(f"Successfully deleted credential: '{decoded_name}' for user {user_id}")
        return {"message": "Credential deleted successfully"}
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting credential '{decoded_name}': {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to delete credential: {str(e)}")

@router.post("/credential-profiles", response_model=CredentialProfileResponse)
async def store_credential_profile(
    request: StoreCredentialProfileRequest,
    user_id: str = Depends(get_current_user_id_from_jwt)
):
    """Store a named credential profile for an MCP server"""
    logger.info(f"Storing credential profile '{request.profile_name}' for {request.mcp_qualified_name} for user {user_id}")
    
    try:
        profile_id = await credential_manager.store_credential_profile(
            account_id=user_id,
            mcp_qualified_name=request.mcp_qualified_name,
            profile_name=request.profile_name,
            display_name=request.display_name,
            config=request.config,
            is_default=request.is_default
        )
        
        # Return profile info without sensitive data
        profile = await credential_manager.get_credential_by_profile(user_id, profile_id)
        if not profile:
            raise HTTPException(status_code=500, detail="Failed to retrieve stored credential profile")
        
        return CredentialProfileResponse(
            profile_id=profile.profile_id,
            mcp_qualified_name=profile.mcp_qualified_name,
            profile_name=profile.profile_name,
            display_name=profile.display_name,
            config_keys=list(profile.config.keys()),
            is_active=profile.is_active,
            is_default=profile.is_default,
            last_used_at=profile.last_used_at.isoformat() if profile.last_used_at and hasattr(profile.last_used_at, 'isoformat') else (str(profile.last_used_at) if profile.last_used_at else None),
            created_at=profile.created_at.isoformat() if profile.created_at and hasattr(profile.created_at, 'isoformat') else (str(profile.created_at) if profile.created_at else ""),
            updated_at=profile.updated_at.isoformat() if profile.updated_at and hasattr(profile.updated_at, 'isoformat') else (str(profile.updated_at) if profile.updated_at else "")
        )
        
    except Exception as e:
        logger.error(f"Error storing credential profile: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to store credential profile: {str(e)}")

@router.get("/credential-profiles", response_model=List[CredentialProfileResponse])
async def get_all_user_credential_profiles(
    user_id: str = Depends(get_current_user_id_from_jwt)
):
    """Get all credential profiles for the current user across all MCP servers"""
    logger.info(f"Getting all credential profiles for user {user_id}")
    
    try:
        profiles = await credential_manager.get_all_user_credential_profiles(user_id)
        
        return [
            CredentialProfileResponse(
                profile_id=profile.profile_id,
                mcp_qualified_name=profile.mcp_qualified_name,
                profile_name=profile.profile_name,
                display_name=profile.display_name,
                config_keys=list(profile.config.keys()),
                is_active=profile.is_active,
                is_default=profile.is_default,
                last_used_at=profile.last_used_at.isoformat() if profile.last_used_at and hasattr(profile.last_used_at, 'isoformat') else (str(profile.last_used_at) if profile.last_used_at else None),
                created_at=profile.created_at.isoformat() if profile.created_at and hasattr(profile.created_at, 'isoformat') else (str(profile.created_at) if profile.created_at else ""),
                updated_at=profile.updated_at.isoformat() if profile.updated_at and hasattr(profile.updated_at, 'isoformat') else (str(profile.updated_at) if profile.updated_at else "")
            )
            for profile in profiles
        ]
        
    except Exception as e:
        logger.error(f"Error getting user credential profiles: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to get credential profiles: {str(e)}")

@router.get("/credential-profiles/{mcp_qualified_name:path}", response_model=List[CredentialProfileResponse])
async def get_credential_profiles_for_mcp(
    mcp_qualified_name: str,
    user_id: str = Depends(get_current_user_id_from_jwt)
):
    """Get all credential profiles for a specific MCP server"""
    decoded_name = urllib.parse.unquote(mcp_qualified_name)
    logger.info(f"Getting credential profiles for '{decoded_name}' for user {user_id}")
    
    try:
        profiles = await credential_manager.get_credential_profiles(user_id, decoded_name)
        
        return [
            CredentialProfileResponse(
                profile_id=profile.profile_id,
                mcp_qualified_name=profile.mcp_qualified_name,
                profile_name=profile.profile_name,
                display_name=profile.display_name,
                config_keys=list(profile.config.keys()),
                is_active=profile.is_active,
                is_default=profile.is_default,
                last_used_at=profile.last_used_at.isoformat() if profile.last_used_at and hasattr(profile.last_used_at, 'isoformat') else (str(profile.last_used_at) if profile.last_used_at else None),
                created_at=profile.created_at.isoformat() if profile.created_at and hasattr(profile.created_at, 'isoformat') else (str(profile.created_at) if profile.created_at else ""),
                updated_at=profile.updated_at.isoformat() if profile.updated_at and hasattr(profile.updated_at, 'isoformat') else (str(profile.updated_at) if profile.updated_at else "")
            )
            for profile in profiles
        ]
        
    except Exception as e:
        logger.error(f"Error getting credential profiles for {decoded_name}: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to get credential profiles: {str(e)}")

@router.get("/credential-profiles/profile/{profile_id}", response_model=CredentialProfileResponse)
async def get_credential_profile_by_id(
    profile_id: str,
    user_id: str = Depends(get_current_user_id_from_jwt)
):
    """Get a specific credential profile by its ID"""
    logger.info(f"Getting credential profile {profile_id} for user {user_id}")
    
    try:
        profile = await credential_manager.get_credential_by_profile(user_id, profile_id)
        
        if not profile:
            raise HTTPException(status_code=404, detail="Credential profile not found")
        
        return CredentialProfileResponse(
            profile_id=profile.profile_id,
            mcp_qualified_name=profile.mcp_qualified_name,
            profile_name=profile.profile_name,
            display_name=profile.display_name,
            config_keys=list(profile.config.keys()),
            is_active=profile.is_active,
            is_default=profile.is_default,
            last_used_at=profile.last_used_at.isoformat() if profile.last_used_at and hasattr(profile.last_used_at, 'isoformat') else (str(profile.last_used_at) if profile.last_used_at else None),
            created_at=profile.created_at.isoformat() if profile.created_at and hasattr(profile.created_at, 'isoformat') else (str(profile.created_at) if profile.created_at else ""),
            updated_at=profile.updated_at.isoformat() if profile.updated_at and hasattr(profile.updated_at, 'isoformat') else (str(profile.updated_at) if profile.updated_at else "")
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting credential profile {profile_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to get credential profile: {str(e)}")

@router.put("/credential-profiles/{profile_id}/set-default")
async def set_default_credential_profile(
    profile_id: str,
    user_id: str = Depends(get_current_user_id_from_jwt)
):
    """Set a credential profile as the default for its MCP server"""
    logger.info(f"Setting credential profile {profile_id} as default for user {user_id}")
    
    try:
        success = await credential_manager.set_default_profile(user_id, profile_id)
        
        if not success:
            raise HTTPException(status_code=404, detail="Credential profile not found")
        
        return {"message": "Default profile set successfully"}
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error setting default profile {profile_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to set default profile: {str(e)}")

@router.delete("/credential-profiles/{profile_id}")
async def delete_credential_profile(
    profile_id: str,
    user_id: str = Depends(get_current_user_id_from_jwt)
):
    """Delete (deactivate) a credential profile"""
    logger.info(f"Deleting credential profile {profile_id} for user {user_id}")
    
    try:
        success = await credential_manager.delete_credential_profile(user_id, profile_id)
        
        if not success:
            raise HTTPException(status_code=404, detail="Credential profile not found")
        
        return {"message": "Credential profile deleted successfully"}
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting credential profile {profile_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to delete credential profile: {str(e)}")

# =====================================================
# TEMPLATE MANAGEMENT ENDPOINTS
# =====================================================

@router.post("/templates", response_model=Dict[str, str])
async def create_agent_template(
    request: CreateTemplateRequest,
    user_id: str = Depends(get_current_user_id_from_jwt)
):
    """Create an agent template from an existing agent"""
    logger.info(f"Creating template from agent {request.agent_id} for user {user_id}")
    
    try:
        template_id = await template_manager.create_template_from_agent(
            agent_id=request.agent_id,
            creator_id=user_id,
            make_public=request.make_public,
            tags=request.tags
        )
        
        return {
            "template_id": template_id,
            "message": "Template created successfully"
        }
        
    except Exception as e:
        logger.error(f"Error creating template: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to create template: {str(e)}")

@router.post("/templates/{template_id}/publish")
async def publish_template(
    template_id: str,
    request: PublishTemplateRequest,
    user_id: str = Depends(get_current_user_id_from_jwt)
):
    """Publish a template to the marketplace"""
    logger.info(f"Publishing template {template_id} for user {user_id}")
    
    try:
        success = await template_manager.publish_template(
            template_id=template_id,
            creator_id=user_id,
            tags=request.tags
        )
        
        if not success:
            raise HTTPException(status_code=404, detail="Template not found or access denied")
        
        return {"message": "Template published to marketplace successfully"}
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error publishing template: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to publish template: {str(e)}")

@router.post("/templates/{template_id}/unpublish")
async def unpublish_template(
    template_id: str,
    user_id: str = Depends(get_current_user_id_from_jwt)
):
    """Unpublish a template from the marketplace"""
    logger.info(f"Unpublishing template {template_id} for user {user_id}")
    
    try:
        success = await template_manager.unpublish_template(
            template_id=template_id,
            creator_id=user_id
        )
        
        if not success:
            raise HTTPException(status_code=404, detail="Template not found or access denied")
        
        return {"message": "Template unpublished from marketplace successfully"}
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error unpublishing template: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to unpublish template: {str(e)}")

@router.post("/templates/install", response_model=InstallationResponse)
async def install_template(
    request: InstallTemplateRequest,
    user_id: str = Depends(get_current_user_id_from_jwt)
):
    """Install a template as an agent instance"""
    logger.info(f"Installing template {request.template_id} for user {user_id}")
    
    try:
        result = await template_manager.install_template(
            template_id=request.template_id,
            account_id=user_id,
            instance_name=request.instance_name,
            custom_system_prompt=request.custom_system_prompt,
            profile_mappings=request.profile_mappings,
            custom_mcp_configs=request.custom_mcp_configs
        )
        
        return InstallationResponse(**result)
        
    except Exception as e:
        logger.error(f"Error installing template: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to install template: {str(e)}")

@router.get("/templates/marketplace", response_model=List[TemplateResponse])
async def get_marketplace_templates(
    limit: int = 50,
    offset: int = 0,
    search: Optional[str] = None,
    tags: Optional[str] = None,  # Comma-separated tags
    user_id: str = Depends(get_current_user_id_from_jwt)
):
    """Get public templates from the marketplace"""
    logger.info(f"Getting marketplace templates for user {user_id}")
    
    try:
        tag_list = None
        if tags:
            tag_list = [tag.strip() for tag in tags.split(',') if tag.strip()]
        
        templates = await template_manager.get_marketplace_templates(
            limit=limit,
            offset=offset,
            search=search,
            tags=tag_list
        )
        print("templates", templates)
        return [TemplateResponse(**template) for template in templates]
        
    except Exception as e:
        logger.error(f"Error getting marketplace templates: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to get marketplace templates: {str(e)}")

@router.get("/templates/my", response_model=List[TemplateResponse])
async def get_my_templates(
    limit: int = 50,
    offset: int = 0,
    user_id: str = Depends(get_current_user_id_from_jwt)
):
    """Get all templates created by the current user"""
    logger.info(f"Getting user templates for user {user_id}")
    
    try:
        templates = await template_manager.get_user_templates(
            creator_id=user_id,
            limit=limit,
            offset=offset
        )
        
        return [TemplateResponse(**template) for template in templates]
        
    except Exception as e:
        logger.error(f"Error getting user templates: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to get user templates: {str(e)}")

@router.get("/templates/{template_id}", response_model=TemplateResponse)
async def get_template_details(
    template_id: str,
    user_id: str = Depends(get_current_user_id_from_jwt)
):
    """Get detailed information about a specific template"""
    logger.info(f"Getting template {template_id} details for user {user_id}")
    
    try:
        template = await template_manager.get_template(template_id)
        
        if not template:
            raise HTTPException(status_code=404, detail="Template not found")
        
        # Check access permissions
        if not template.is_public and template.creator_id != user_id:
            raise HTTPException(status_code=403, detail="Access denied to private template")
        
        return TemplateResponse(
            template_id=template.template_id,
            name=template.name,
            description=template.description,
            mcp_requirements=[
                {
                    'qualified_name': req.qualified_name,
                    'display_name': req.display_name,
                    'enabled_tools': req.enabled_tools,
                    'required_config': req.required_config
                }
                for req in template.mcp_requirements
            ],
            agentpress_tools=template.agentpress_tools,
            tags=template.tags,
            is_public=template.is_public,
            download_count=template.download_count,
            marketplace_published_at=template.marketplace_published_at.isoformat() if template.marketplace_published_at else None,
            created_at=template.created_at.isoformat() if template.created_at else "",
            avatar=template.avatar,
            avatar_color=template.avatar_color
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting template details: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to get template details: {str(e)}")

# =====================================================
# AGENT INSTANCE ENDPOINTS
# =====================================================

@router.get("/instances/{instance_id}/config")
async def get_agent_runtime_config(
    instance_id: str,
    user_id: str = Depends(get_current_user_id_from_jwt)
):
    """Get complete runtime configuration for an agent instance"""
    logger.info(f"Getting runtime config for instance {instance_id} for user {user_id}")
    
    try:
        config = await template_manager.build_runtime_agent_config(instance_id)
        
        # Verify ownership
        if config['account_id'] != user_id:
            raise HTTPException(status_code=403, detail="Access denied")
        
        return config
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting runtime config: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to get runtime config: {str(e)}")

# =====================================================
# MIGRATION ENDPOINTS
# =====================================================

@router.post("/migrate/agent/{agent_id}")
async def migrate_agent_to_secure_architecture(
    agent_id: str,
    user_id: str = Depends(get_current_user_id_from_jwt)
):
    """
    Migrate an existing agent to the secure architecture by:
    1. Extracting and storing credentials securely
    2. Creating a template
    3. Creating an agent instance
    """
    logger.info(f"Migrating agent {agent_id} to secure architecture for user {user_id}")
    
    try:
        # This would be implemented to handle migration of existing agents
        # For now, return a placeholder response
        return {
            "message": "Migration functionality will be implemented in the next phase",
            "agent_id": agent_id,
            "status": "pending"
        }
        
    except Exception as e:
        logger.error(f"Error migrating agent: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to migrate agent: {str(e)}") 