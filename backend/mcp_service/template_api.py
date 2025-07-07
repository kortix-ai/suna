"""
Template API endpoints

This module provides API endpoints for template management:
1. Creating agent templates from existing agents
2. Publishing/unpublishing templates to marketplace
3. Installing templates as agent instances
4. Browsing marketplace and user templates
"""

from fastapi import APIRouter, HTTPException, Depends
from typing import List, Optional, Dict, Any
from pydantic import BaseModel

from utils.logger import logger
from utils.auth_utils import get_current_user_id_from_jwt
from .template_manager import template_manager

router = APIRouter()

# =====================================================
# PYDANTIC MODELS
# =====================================================

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

# =====================================================
# TEMPLATE MANAGEMENT ENDPOINTS
# =====================================================

@router.post("", response_model=Dict[str, str])
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

@router.post("/{template_id}/publish")
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

@router.post("/{template_id}/unpublish")
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

@router.post("/install", response_model=InstallationResponse)
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

@router.get("/marketplace", response_model=List[TemplateResponse])
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

@router.get("/my", response_model=List[TemplateResponse])
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

@router.get("/{template_id}", response_model=TemplateResponse)
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