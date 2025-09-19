from fastapi import APIRouter, HTTPException, Depends
from typing import List, Optional, Dict, Any
from pydantic import BaseModel

from core.utils.auth_utils import verify_and_get_user_id_from_jwt
from core.utils.logger import logger
from .mcp_service import mcp_service, MCPException

router = APIRouter()


class CustomMCPConnectionRequest(BaseModel):
    url: str
    config: Optional[Dict[str, Any]] = {}


class CustomMCPConnectionResponse(BaseModel):
    success: bool
    qualified_name: str
    display_name: str
    tools: List[Dict[str, Any]]
    config: Dict[str, Any]
    url: str
    message: str


class CustomMCPDiscoverRequest(BaseModel):
    type: str
    config: Dict[str, Any]


@router.post("/mcp/discover-custom-tools")
async def discover_custom_mcp_tools(request: CustomMCPDiscoverRequest):
    try:
        result = await mcp_service.discover_custom_tools(request.type, request.config)
        
        return CustomMCPConnectionResponse(
            success=result.success,
            qualified_name=result.qualified_name,
            display_name=result.display_name,
            tools=result.tools,
            config=result.config,
            url=result.url,
            message=result.message
        )
        
    except MCPException as e:
        logger.error(f"Error discovering custom MCP tools: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e)) 