from fastapi import APIRouter, HTTPException, Depends, Query
from typing import Optional, List, Dict, Any
from datetime import datetime, timedelta
from pydantic import BaseModel
from core.auth import require_admin
from core.services.convex_client import get_convex_client
from core.utils.logger import logger
from core.utils.pagination import PaginationService, PaginationParams, PaginatedResponse
from core.utils.auth_utils import verify_admin_api_key
from core.utils.suna_default_agent_service import SunaDefaultAgentService
from core.utils.config import config, EnvMode
from dotenv import load_dotenv, set_key, find_dotenv, dotenv_values
import os

router = APIRouter(prefix="/admin", tags=["admin"])

# ============================================================================
# MODELS
# ============================================================================

class UserSummary(BaseModel):
    id: str
    email: str
    created_at: datetime
    tier: str
    credit_balance: float
    total_purchased: float
    total_used: float
    subscription_status: Optional[str] = None
    last_activity: Optional[datetime] = None
    trial_status: Optional[str] = None

class UserThreadSummary(BaseModel):
    thread_id: str
    project_id: Optional[str] = None
    project_name: Optional[str] = None
    is_public: bool
    created_at: datetime
    updated_at: datetime

# ============================================================================
# USER MANAGEMENT ENDPOINTS
# ============================================================================

@router.get("/users/list")
async def list_users(
    page: int = Query(1, ge=1, description="Page number"),
    page_size: int = Query(20, ge=1, le=100, description="Items per page"),
    search_email: Optional[str] = Query(None, description="Search by email"),
    search_name: Optional[str] = Query(None, description="Search by name"),
    tier_filter: Optional[str] = Query(None, description="Filter by tier"),
    sort_by: str = Query("created_at", description="Sort field"),
    sort_order: str = Query("desc", description="Sort order: asc, desc"),
    admin: dict = Depends(require_admin)
) -> PaginatedResponse[UserSummary]:
    """List all users with pagination and filtering."""
    try:
        # TODO: Convex migration - need to implement admin_list_users_by_tier RPC equivalent
        # The Convex client currently supports threads, agents, memories but not admin user listing
        # For now, return empty result until Convex functions are implemented
        pagination_params = PaginationParams(page=page, page_size=page_size)

        logger.warning("admin_list_users endpoint not yet migrated to Convex - returning empty result")
        return await PaginationService.paginate_with_total_count(
            items=[],
            total_count=0,
            params=pagination_params
        )

    except Exception as e:
        logger.error(f"Failed to list users: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to retrieve users")

@router.get("/users/{user_id}")
async def get_user_details(
    user_id: str,
    admin: dict = Depends(require_admin)
):
    """Get detailed information about a specific user."""
    try:
        # TODO: Convex migration - need to implement user details endpoint
        # The Convex client currently supports threads, agents, memories but not admin user management
        # For now, return a placeholder until Convex functions are implemented
        logger.warning(f"get_user_details endpoint not yet migrated to Convex for user {user_id}")
        raise HTTPException(status_code=404, detail="User not found (Convex migration pending)")

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to get user details: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to retrieve user details")

@router.get("/users/stats/overview")
async def get_user_stats_overview(
    admin: dict = Depends(require_admin)
):
    """Get overview statistics about all users."""
    try:
        # TODO: Convex migration - need to implement user stats endpoint
        # The Convex client currently supports threads, agents, memories but not admin user stats
        # For now, return placeholder data until Convex functions are implemented
        logger.warning("get_user_stats_overview endpoint not yet migrated to Convex")

        return {
            "total_users": 0,
            "active_users_30d": 0,
            "tier_distribution": [],
            "total_credits_in_system": 0.0,
            "average_credit_balance": 0.0
        }

    except Exception as e:
        logger.error(f"Failed to get user stats: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to retrieve user statistics")

@router.get("/users/{user_id}/activity")
async def get_user_activity(
    user_id: str,
    page: int = Query(1, ge=1, description="Page number"),
    page_size: int = Query(20, ge=1, le=100, description="Items per page"),
    status_filter: Optional[str] = Query(None, description="Filter by status"),
    admin: dict = Depends(require_admin)
):
    """Get paginated activity (agent runs) for a specific user."""
    try:
        pagination_params = PaginationParams(page=page, page_size=page_size)

        # TODO: Convex migration - need to implement user activity endpoint
        # The Convex client currently supports agent_runs but not with the complex joins needed here
        # For now, return empty result until Convex functions are implemented
        logger.warning(f"get_user_activity endpoint not yet migrated to Convex for user {user_id}")

        return await PaginationService.paginate_with_total_count(
            items=[],
            total_count=0,
            params=pagination_params
        )

    except Exception as e:
        logger.error(f"Failed to get user activity: {e}")
        raise HTTPException(status_code=500, detail="Failed to retrieve user activity")

@router.get("/users/threads/by-email")
async def get_user_threads_by_email(
    email: str = Query(..., description="User email to fetch threads for"),
    page: int = Query(1, ge=1, description="Page number"),
    page_size: int = Query(20, ge=1, le=100, description="Items per page"),
    admin: dict = Depends(require_admin)
) -> PaginatedResponse[UserThreadSummary]:
    """Get all project threads for a user by their email with clickable URLs."""
    try:
        pagination_params = PaginationParams(page=page, page_size=page_size)

        # TODO: Convex migration - need to implement user threads by email endpoint
        # The Convex client currently supports thread listing but needs account lookup by email
        # For now, return empty result until Convex functions are implemented
        logger.warning(f"get_user_threads_by_email endpoint not yet migrated to Convex for email {email}")

        return await PaginationService.paginate_with_total_count(
            items=[],
            total_count=0,
            params=pagination_params
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to get user threads by email: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to retrieve user threads")

# ============================================================================
# AGENT & SYSTEM MANAGEMENT
# ============================================================================

@router.post("/suna-agents/install-user/{account_id}")
async def admin_install_suna_for_user(
    account_id: str,
    replace_existing: bool = False,
    _: bool = Depends(verify_admin_api_key)
):
    """Install Suna agent for a specific user."""
    logger.debug(f"Admin installing Suna agent for user: {account_id}")
    
    service = SunaDefaultAgentService()
    agent_id = await service.install_suna_agent_for_user(account_id, replace_existing)
    
    if agent_id:
        return {
            "success": True,
            "message": f"Successfully installed Suna agent for user {account_id}",
            "agent_id": agent_id
        }
    else:
        raise HTTPException(
            status_code=500, 
            detail=f"Failed to install Suna agent for user {account_id}"
        )

@router.get("/env-vars")
def get_env_vars() -> Dict[str, str]:
    """Get environment variables (local mode only)."""
    if config.ENV_MODE != EnvMode.LOCAL:
        raise HTTPException(status_code=403, detail="Env vars management only available in local mode")
    
    try:
        env_path = find_dotenv()
        if not env_path:
            logger.error("Could not find .env file")
            return {}
        
        return dotenv_values(env_path)
    except Exception as e:
        logger.error(f"Failed to get env vars: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to get env variables: {e}")

@router.post("/env-vars")
def save_env_vars(request: Dict[str, str]) -> Dict[str, str]:
    """Save environment variables (local mode only)."""
    if config.ENV_MODE != EnvMode.LOCAL:
        raise HTTPException(status_code=403, detail="Env vars management only available in local mode")

    try:
        env_path = find_dotenv()
        if not env_path:
            raise HTTPException(status_code=500, detail="Could not find .env file")
        
        for key, value in request.items():
            set_key(env_path, key, value)
        
        load_dotenv(override=True)
        logger.debug(f"Env variables saved successfully: {request}")
        return {"message": "Env variables saved successfully"}
    except Exception as e:
        logger.error(f"Failed to save env variables: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to save env variables: {e}")

