"""
API endpoints for tool discovery and metadata.

Provides endpoints to get all available tools and their metadata.
"""

from typing import Dict, Any
from fastapi import APIRouter, HTTPException, Depends

from core.utils.auth_utils import verify_and_get_user_id_from_jwt
from core.utils.logger import logger
from core.utils.tool_discovery import get_tools_metadata

router = APIRouter(tags=["tools"])


@router.get("/tools", summary="Get All Tools", operation_id="get_all_tools")
async def get_all_tools(
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict[str, Any]:
    """Get metadata for all available tools.
    
    Returns:
        Dict containing all tool metadata with methods
    """
    try:
        logger.debug(f"Fetching all tools metadata for user {user_id}")
        
        tools_metadata = get_tools_metadata()
        
        return {
            "success": True,
            "tools": tools_metadata
        }
        
    except Exception as e:
        logger.error(f"Error fetching tools metadata: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to fetch tools metadata")


@router.get("/tools/{tool_name}", summary="Get Tool Details", operation_id="get_tool_details")
async def get_tool_details(
    tool_name: str,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict[str, Any]:
    """Get detailed metadata for a specific tool.
    
    Args:
        tool_name: Name of the tool
        
    Returns:
        Dict containing tool metadata
    """
    try:
        logger.debug(f"Fetching metadata for tool {tool_name} for user {user_id}")
        
        from core.utils.tool_discovery import get_tool_discovery
        discovery = get_tool_discovery()
        
        metadata = discovery.get_tool_metadata(tool_name)
        
        if not metadata:
            raise HTTPException(status_code=404, detail=f"Tool {tool_name} not found")
        
        return {
            "success": True,
            "tool": metadata
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching tool {tool_name} metadata: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to fetch tool metadata")

