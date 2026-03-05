from fastapi import APIRouter, HTTPException, Depends, Query, Request
from typing import List, Optional, Dict, Any
from pydantic import BaseModel

from core.utils.logger import logger
from core.utils.auth_utils import verify_and_get_user_id_from_jwt
from core.services.convex_client import get_convex_client, ConvexClient
from core.utils.pagination import PaginationParams

from .template_service import (
    get_template_service,
    AgentTemplate,
    TemplateNotFoundError,
    TemplateAccessDeniedError,
    SunaDefaultAgentTemplateError
)
from .installation_service import (
    get_installation_service,
    TemplateInstallationRequest,
    TemplateInstallationError,
    InvalidCredentialError
)
from .utils import format_template_for_response

router = APIRouter(tags=["templates"])


class UsageExampleMessage(BaseModel):
    role: str
    content: str
    tool_calls: Optional[List[Dict[str, Any]]] = None


class CreateTemplateRequest(BaseModel):
    agent_id: str
    make_public: bool = False
    tags: Optional[List[str]] = None
    usage_examples: Optional[List[UsageExampleMessage]] = None


class InstallTemplateRequest(BaseModel):
    template_id: str
    instance_name: Optional[str] = None
    custom_system_prompt: Optional[str] = None
    profile_mappings: Optional[Dict[str, str]] = None
    custom_mcp_configs: Optional[Dict[str, Dict[str, Any]]] = None
    trigger_configs: Optional[Dict[str, Dict[str, Any]]] = None
    trigger_variables: Optional[Dict[str, Dict[str, str]]] = None


class PublishTemplateRequest(BaseModel):
    tags: Optional[List[str]] = None
    usage_examples: Optional[List[UsageExampleMessage]] = None


class TemplateResponse(BaseModel):
    template_id: str
    creator_id: str
    name: str
    system_prompt: str
    mcp_requirements: List[Dict[str, Any]]
    agentpress_tools: Dict[str, Any]
    tags: List[str]
    categories: List[str]
    is_public: bool
    is_kortix_team: Optional[bool] = False
    marketplace_published_at: Optional[str] = None
    download_count: int
    created_at: str
    updated_at: str
    icon_name: Optional[str] = None
    icon_color: Optional[str] = None
    icon_background: Optional[str] = None
    metadata: Dict[str, Any]
    creator_name: Optional[str] = None
    usage_examples: Optional[List[UsageExampleMessage]] = None
    config: Optional[Dict[str, Any]] = None


class InstallationResponse(BaseModel):
    status: str
    instance_id: Optional[str] = None
    name: Optional[str] = None
    missing_regular_credentials: List[Dict[str, Any]] = []
    missing_custom_configs: List[Dict[str, Any]] = []
    missing_trigger_variables: Optional[Dict[str, Dict[str, Any]]] = None
    template_info: Optional[Dict[str, Any]] = None


async def validate_template_ownership_and_get(template_id: str, user_id: str) -> AgentTemplate:
    """Validate that user owns the template and return it."""
    convex = get_convex_client()
    template_service = get_template_service(convex)
    template = await template_service.get_template(template_id)

    if not template:
        logger.warning(f"Template {template_id} not found")
        raise HTTPException(status_code=404, detail="Template not found")

    if template.creator_id != user_id:
        logger.warning(f"User {user_id} attempted to access template {template_id} owned by {template.creator_id}")
        raise HTTPException(status_code=403, detail="You don't have permission to access this template")

    return template


async def validate_template_access_and_get(template_id: str, user_id: str) -> AgentTemplate:
    """Validate that user has access to the template and return it."""
    convex = get_convex_client()
    template_service = get_template_service(convex)
    template = await template_service.get_template(template_id)

    if not template:
        logger.warning(f"Template {template_id} not found")
        raise HTTPException(status_code=404, detail="Template not found")

    if template.creator_id != user_id and not template.is_public:
        logger.warning(f"User {user_id} attempted to access private template {template_id} owned by {template.creator_id}")
        raise HTTPException(status_code=403, detail="Access denied to private template")

    return template


async def validate_agent_ownership(agent_id: str, user_id: str) -> Dict[str, Any]:
    """Validate that user owns the agent and return agent data."""
    convex = get_convex_client()

    try:
        agent = await convex.get_agent(agent_id)
    except Exception:
        agent = None

    if not agent:
        logger.warning(f"Agent {agent_id} not found")
        raise HTTPException(status_code=404, detail="Worker not found")

    if agent.get('account_id') != user_id:
        logger.warning(f"User {user_id} attempted to access agent {agent_id} owned by {agent.get('account_id')}")
        raise HTTPException(status_code=403, detail="You don't have permission to access this agent")

    return agent


@router.post("", response_model=Dict[str, str])
async def create_template_from_agent(
    request: CreateTemplateRequest,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """Create a new template from an existing agent."""
    try:
        await validate_agent_ownership(request.agent_id, user_id)

        logger.debug(f"User {user_id} creating template from agent {request.agent_id}")

        convex = get_convex_client()
        template_service = get_template_service(convex)

        usage_examples = None
        if request.usage_examples:
            usage_examples = [msg.dict() for msg in request.usage_examples]

        template_id = await template_service.create_from_agent(
            agent_id=request.agent_id,
            creator_id=user_id,
            make_public=request.make_public,
            tags=request.tags,
            usage_examples=usage_examples
        )

        logger.debug(f"Successfully created template {template_id} from agent {request.agent_id}")
        return {"template_id": template_id}

    except HTTPException:
        raise
    except TemplateNotFoundError as e:
        logger.warning(f"Template creation failed - not found: {e}")
        raise HTTPException(status_code=404, detail=str(e))
    except TemplateAccessDeniedError as e:
        logger.warning(f"Template creation failed - access denied: {e}")
        raise HTTPException(status_code=403, detail=str(e))
    except SunaDefaultAgentTemplateError as e:
        logger.warning(f"Template creation failed - Suna default agent: {e}")
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Error creating template from agent {request.agent_id}: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")


@router.post("/{template_id}/publish")
async def publish_template(
    template_id: str,
    request: PublishTemplateRequest,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """Publish a template to the marketplace."""
    try:
        template = await validate_template_ownership_and_get(template_id, user_id)

        logger.debug(f"User {user_id} publishing template {template_id}")

        convex = get_convex_client()
        template_service = get_template_service(convex)

        usage_examples = None
        if request.usage_examples:
            usage_examples = [msg.dict() for msg in request.usage_examples]

        success = await template_service.publish_template(
            template_id,
            user_id,
            usage_examples=usage_examples
        )

        if not success:
            logger.warning(f"Failed to publish template {template_id} for user {user_id}")
            raise HTTPException(status_code=500, detail="Failed to publish template")

        logger.debug(f"Successfully published template {template_id}")
        return {"message": "Template published successfully"}

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error publishing template {template_id}: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")


@router.post("/{template_id}/unpublish")
async def unpublish_template(
    template_id: str,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """Unpublish a template from the marketplace."""
    try:
        template = await validate_template_ownership_and_get(template_id, user_id)

        logger.debug(f"User {user_id} unpublishing template {template_id}")

        convex = get_convex_client()
        template_service = get_template_service(convex)

        success = await template_service.unpublish_template(template_id, user_id)

        if not success:
            logger.warning(f"Failed to unpublish template {template_id} for user {user_id}")
            raise HTTPException(status_code=500, detail="Failed to unpublish template")

        logger.debug(f"Successfully unpublished template {template_id}")
        return {"message": "Template unpublished successfully"}

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error unpublishing template {template_id}: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")


@router.delete("/{template_id}")
async def delete_template(
    template_id: str,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """Delete a template."""
    try:
        template = await validate_template_ownership_and_get(template_id, user_id)

        logger.debug(f"User {user_id} deleting template {template_id}")

        convex = get_convex_client()
        template_service = get_template_service(convex)

        success = await template_service.delete_template(template_id, user_id)

        if not success:
            logger.warning(f"Failed to delete template {template_id} for user {user_id}")
            raise HTTPException(status_code=500, detail="Failed to delete template")

        logger.debug(f"Successfully deleted template {template_id}")
        return {"message": "Template deleted successfully"}

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting template {template_id}: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")


@router.post("/install", response_model=InstallationResponse)
async def install_template(
    request: InstallTemplateRequest,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """Install a template as a new agent instance."""
    try:
        await validate_template_access_and_get(request.template_id, user_id)

        # Check agent count limit
        convex = get_convex_client()
        try:
            from core.utils.limits_checker import check_agent_count_limit
            limit_check = await check_agent_count_limit(user_id)

            if not limit_check['can_create']:
                error_detail = {
                    "message": f"Maximum of {limit_check['limit']} agents allowed for your current plan. You have {limit_check['current_count']} agents.",
                    "current_count": limit_check['current_count'],
                    "limit": limit_check['limit'],
                    "tier_name": limit_check['tier_name'],
                    "error_code": "AGENT_LIMIT_EXCEEDED"
                }
                logger.warning(f"Agent limit exceeded for account {user_id}: {limit_check['current_count']}/{limit_check['limit']} agents")
                raise HTTPException(status_code=402, detail=error_detail)
        except ImportError:
            logger.debug("limits_checker not available, skipping limit check")

        logger.debug(f"User {user_id} installing template {request.template_id}")

        installation_service = get_installation_service(convex)

        logger.info(f"Installing template with trigger_configs: {request.trigger_configs}")

        install_request = TemplateInstallationRequest(
            template_id=request.template_id,
            account_id=user_id,
            instance_name=request.instance_name,
            custom_system_prompt=request.custom_system_prompt,
            profile_mappings=request.profile_mappings,
            custom_mcp_configs=request.custom_mcp_configs,
            trigger_configs=request.trigger_configs,
            trigger_variables=request.trigger_variables
        )

        result = await installation_service.install_template(install_request)

        logger.debug(f"Successfully installed template {request.template_id} as instance {result.instance_id}")

        return InstallationResponse(
            status=result.status,
            instance_id=result.instance_id,
            name=result.name,
            missing_regular_credentials=result.missing_regular_credentials,
            missing_custom_configs=result.missing_custom_configs,
            missing_trigger_variables=result.missing_trigger_variables,
            template_info=result.template_info
        )

    except HTTPException:
        raise
    except TemplateInstallationError as e:
        logger.warning(f"Template installation failed: {e}")
        raise HTTPException(status_code=400, detail=str(e))
    except InvalidCredentialError as e:
        logger.warning(f"Template installation failed - invalid credentials: {e}")
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Error installing template {request.template_id}: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")


class MarketplacePaginationInfo(BaseModel):
    current_page: int
    page_size: int
    total_items: int
    total_pages: int
    has_next: bool
    has_previous: bool


class MarketplaceTemplatesResponse(BaseModel):
    templates: List[TemplateResponse]
    pagination: MarketplacePaginationInfo


@router.get("/kortix-all", response_model=MarketplaceTemplatesResponse)
async def get_all_kortix_templates(
    request: Request = None
):
    """Get all Kortix team templates for the marketplace."""
    try:
        convex = get_convex_client()
        template_service = get_template_service(convex)

        templates = await template_service.get_public_templates(
            is_kortix_team=True,
            limit=1000
        )

        template_responses = []
        for template in templates:
            template_response = TemplateResponse(**format_template_for_response(template))
            template_responses.append(template_response)

        return MarketplaceTemplatesResponse(
            templates=template_responses,
            pagination=MarketplacePaginationInfo(
                current_page=1,
                page_size=len(template_responses),
                total_items=len(template_responses),
                total_pages=1,
                has_next=False,
                has_previous=False
            )
        )

    except Exception as e:
        logger.error(f"Error getting all Kortix templates: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")


@router.get("/marketplace", response_model=MarketplaceTemplatesResponse)
async def get_marketplace_templates(
    page: Optional[int] = Query(1, ge=1, description="Page number (1-based)"),
    limit: Optional[int] = Query(20, ge=1, le=100, description="Number of items per page"),
    search: Optional[str] = Query(None, description="Search term for name"),
    tags: Optional[str] = Query(None, description="Comma-separated list of tags to filter by"),
    is_kortix_team: Optional[bool] = Query(None, description="Filter for Kortix team templates"),
    mine: Optional[bool] = Query(None, description="Filter to show only user's own templates"),
    sort_by: Optional[str] = Query("download_count", description="Sort field: download_count, newest, name"),
    sort_order: Optional[str] = Query("desc", description="Sort order: asc, desc"),
    request: Request = None
):
    """Get public templates for the marketplace with filtering and pagination."""
    try:
        creator_id_filter = None
        if mine:
            try:
                user_id = await verify_and_get_user_id_from_jwt(request)
                creator_id_filter = user_id
            except Exception:
                raise HTTPException(status_code=401, detail="Authentication required for 'mine' filter")

        tags_list = []
        if tags:
            if isinstance(tags, str):
                tags_list = [tag.strip() for tag in tags.split(',') if tag.strip()]

        convex = get_convex_client()
        template_service = get_template_service(convex)

        # Map sort_by to Convex format
        convex_sort_by = sort_by
        if sort_by == "newest":
            convex_sort_by = "created_at"

        templates = await template_service.get_public_templates(
            is_kortix_team=is_kortix_team,
            limit=limit,
            offset=(page - 1) * limit,
            search=search,
            tags=tags_list if tags_list else None
        )

        if creator_id_filter:
            templates = [t for t in templates if t.creator_id == creator_id_filter]

        template_responses = []
        for template in templates:
            template_response = TemplateResponse(**format_template_for_response(template))
            template_responses.append(template_response)

        # Calculate pagination info
        total_items = len(template_responses)
        total_pages = (total_items + limit - 1) // limit if limit > 0 else 1

        return MarketplaceTemplatesResponse(
            templates=template_responses,
            pagination=MarketplacePaginationInfo(
                current_page=page,
                page_size=limit,
                total_items=total_items,
                total_pages=total_pages,
                has_next=page < total_pages,
                has_previous=page > 1
            )
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting marketplace templates: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")


@router.get("/my", response_model=MarketplaceTemplatesResponse)
async def get_my_templates(
    page: Optional[int] = Query(1, ge=1, description="Page number (1-based)"),
    limit: Optional[int] = Query(20, ge=1, le=100, description="Number of items per page"),
    search: Optional[str] = Query(None, description="Search term for name"),
    sort_by: Optional[str] = Query("created_at", description="Sort field: created_at, name, download_count"),
    sort_order: Optional[str] = Query("desc", description="Sort order: asc, desc"),
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """Get the current user's templates."""
    try:
        convex = get_convex_client()
        template_service = get_template_service(convex)

        templates = await template_service.get_user_templates(user_id)

        # Apply search filter
        if search:
            templates = [t for t in templates if search.lower() in t.name.lower()]

        template_responses = []
        for template in templates:
            template_response = TemplateResponse(**format_template_for_response(template))
            template_responses.append(template_response)

        # Calculate pagination info
        total_items = len(template_responses)
        total_pages = (total_items + limit - 1) // limit if limit > 0 else 1

        # Apply pagination
        start_idx = (page - 1) * limit
        end_idx = start_idx + limit
        template_responses = template_responses[start_idx:end_idx]

        return MarketplaceTemplatesResponse(
            templates=template_responses,
            pagination=MarketplacePaginationInfo(
                current_page=page,
                page_size=limit,
                total_items=total_items,
                total_pages=total_pages,
                has_next=page < total_pages,
                has_previous=page > 1
            )
        )

    except Exception as e:
        logger.error(f"Error getting templates for user {user_id}: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")


@router.get("/public/{template_id}", response_model=TemplateResponse)
async def get_public_template(template_id: str):
    """Get a public template by ID (no authentication required)."""
    try:
        logger.info(f"Attempting to fetch public template: {template_id}")

        if not template_id or len(template_id) < 10:
            logger.warning(f"Invalid template_id format: {template_id}")
            raise HTTPException(status_code=404, detail="Template not found")

        convex = get_convex_client()
        template_service = get_template_service(convex)

        try:
            template = await template_service.get_template(template_id)
        except Exception as db_error:
            logger.error(f"Database error getting template {template_id}: {db_error}")
            raise HTTPException(status_code=404, detail="Template not found")

        if not template:
            logger.warning(f"Template {template_id} not found in database")
            raise HTTPException(status_code=404, detail="Template not found")

        logger.info(f"Template {template_id} found, is_public: {template.is_public}")

        if not template.is_public:
            logger.warning(f"Template {template_id} is not public (is_public={template.is_public})")
            raise HTTPException(status_code=404, detail="Template not found")

        logger.info(f"Successfully returning public template {template_id}: {template.name}")

        return TemplateResponse(**format_template_for_response(template))

    except HTTPException as http_exc:
        raise http_exc
    except Exception as e:
        logger.error(f"Unexpected error getting public template {template_id}: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")


@router.get("/{template_id}", response_model=TemplateResponse)
async def get_template(
    template_id: str,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """Get a template by ID (requires authentication)."""
    try:
        template = await validate_template_access_and_get(template_id, user_id)

        logger.debug(f"User {user_id} accessing template {template_id}")

        return TemplateResponse(**format_template_for_response(template))

    except HTTPException:
        raise
    except TemplateAccessDeniedError as e:
        logger.warning(f"Access denied to template {template_id} for user {user_id}: {e}")
        raise HTTPException(status_code=403, detail="Access denied to template")
    except Exception as e:
        logger.error(f"Error getting template {template_id}: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")
