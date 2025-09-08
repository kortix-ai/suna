from fastapi import APIRouter, HTTPException, Depends
from typing import List, Optional, Dict, Any
from pydantic import BaseModel

from core.utils.logger import logger
from core.utils.auth_utils import verify_and_get_user_id_from_jwt

from .version_service import (
    get_version_service,
    VersionService,
    AgentVersion,
    VersionNotFoundError,
    AgentNotFoundError,
    UnauthorizedError,
    InvalidVersionError,
    VersionConflictError
)

router = APIRouter()

class CreateVersionRequest(BaseModel):
    system_prompt: str
    model: Optional[str] = None  # Add model field
    configured_mcps: List[Dict[str, Any]] = []
    custom_mcps: List[Dict[str, Any]] = []
    agentpress_tools: Dict[str, Any] = {}
    version_name: Optional[str] = None
    description: Optional[str] = None


class UpdateVersionDetailsRequest(BaseModel):
    version_name: Optional[str] = None
    change_description: Optional[str] = None


class VersionResponse(BaseModel):
    version_id: str
    agent_id: str
    version_number: int
    version_name: str
    system_prompt: str
    model: Optional[str] = None  # Add model field
    configured_mcps: List[Dict[str, Any]]
    custom_mcps: List[Dict[str, Any]]
    agentpress_tools: Dict[str, Any]
    is_active: bool
    status: str
    created_at: str
    updated_at: str
    created_by: str
    change_description: Optional[str] = None
    previous_version_id: Optional[str] = None


class VersionComparisonResponse(BaseModel):
    version1: VersionResponse
    version2: VersionResponse
    differences: List[Dict[str, Any]]


@router.get("/agents/{agent_id}/versions", response_model=List[VersionResponse])
async def get_versions(
    agent_id: str,
    user_id: str = Depends(verify_and_get_user_id_from_jwt),
    version_service: VersionService = Depends(get_version_service)
):
    try:
        versions = await version_service.get_all_versions(agent_id, user_id)
        return [VersionResponse(**version.to_dict()) for version in versions]
    except UnauthorizedError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except AgentNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        logger.error(f"Failed to fetch versions: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to fetch versions")


@router.post("/agents/{agent_id}/versions", response_model=VersionResponse)
async def create_version(
    agent_id: str,
    request: CreateVersionRequest,
    user_id: str = Depends(verify_and_get_user_id_from_jwt),
    version_service: VersionService = Depends(get_version_service)
):
    try:
        version = await version_service.create_version(
            agent_id=agent_id,
            user_id=user_id,
            system_prompt=request.system_prompt,
            configured_mcps=request.configured_mcps,
            custom_mcps=request.custom_mcps,
            agentpress_tools=request.agentpress_tools,
            model=request.model,  # Pass model to service
            version_name=request.version_name,
            change_description=request.description
        )
        
        return VersionResponse(**version.to_dict())
    except UnauthorizedError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except AgentNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Failed to create version: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to create version: {str(e)}")


@router.get("/agents/{agent_id}/versions/{version_id}", response_model=VersionResponse)
async def get_version(
    agent_id: str,
    version_id: str,
    user_id: str = Depends(verify_and_get_user_id_from_jwt),
    version_service: VersionService = Depends(get_version_service)
):
    try:
        version = await version_service.get_version(agent_id, version_id, user_id)
        return VersionResponse(**version.to_dict())
    except UnauthorizedError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except VersionNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        logger.error(f"Failed to get version: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to get version")


@router.put("/agents/{agent_id}/versions/{version_id}/activate")
async def activate_version(
    agent_id: str,
    version_id: str,
    user_id: str = Depends(verify_and_get_user_id_from_jwt),
    version_service: VersionService = Depends(get_version_service)
):
    try:
        await version_service.activate_version(agent_id, version_id, user_id)
        return {"message": "Version activated successfully"}
    except UnauthorizedError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except VersionNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except InvalidVersionError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Failed to activate version: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to activate version")


@router.get("/agents/{agent_id}/versions/{version1_id}/compare/{version2_id}", response_model=VersionComparisonResponse)
async def compare_versions(
    agent_id: str,
    version1_id: str,
    version2_id: str,
    user_id: str = Depends(verify_and_get_user_id_from_jwt),
    version_service: VersionService = Depends(get_version_service)
):
    try:
        comparison = await version_service.compare_versions(
            agent_id, version1_id, version2_id, user_id
        )
        
        return VersionComparisonResponse(
            version1=VersionResponse(**comparison['version1']),
            version2=VersionResponse(**comparison['version2']),
            differences=comparison['differences']
        )
    except UnauthorizedError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except VersionNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        logger.error(f"Failed to compare versions: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to compare versions")


@router.post("/agents/{agent_id}/versions/{version_id}/rollback", response_model=VersionResponse)
async def rollback_to_version(
    agent_id: str,
    version_id: str,
    user_id: str = Depends(verify_and_get_user_id_from_jwt),
    version_service: VersionService = Depends(get_version_service)
):
    try:
        new_version = await version_service.rollback_to_version(
            agent_id, version_id, user_id
        )
        
        return VersionResponse(**new_version.to_dict())
    except UnauthorizedError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except VersionNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        logger.error(f"Failed to rollback version: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to rollback version")


@router.put("/agents/{agent_id}/versions/{version_id}/details", response_model=VersionResponse)
async def update_version_details(
    agent_id: str,
    version_id: str,
    request: UpdateVersionDetailsRequest,
    user_id: str = Depends(verify_and_get_user_id_from_jwt),
    version_service: VersionService = Depends(get_version_service)
):
    try:
        updated_version = await version_service.update_version_details(
            agent_id=agent_id,
            version_id=version_id,
            user_id=user_id,
            version_name=request.version_name,
            change_description=request.change_description
        )
        
        return VersionResponse(**updated_version.to_dict())
    except UnauthorizedError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except VersionNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        logger.error(f"Failed to update version details: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to update version details")


def initialize(db_connection=None):
    logger.debug("Versioning API initialized")
    return router 