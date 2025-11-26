from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional
from core.auth import get_current_user
from core.utils.logger import logger
from .presence_service import presence_service

router = APIRouter(tags=["presence"], prefix="/presence")


class UpdatePresenceRequest(BaseModel):
    active_thread_id: Optional[str] = None
    platform: str = "web"
    client_timestamp: Optional[str] = None


@router.post("/update")
async def update_presence(
    request: UpdatePresenceRequest,
    current_user: dict = Depends(get_current_user)
):
    try:
        user_id = current_user.get('user_id')
        logger.debug(f"Presence update request: user={user_id}, thread={request.active_thread_id}, timestamp={request.client_timestamp}")
        
        success = await presence_service.update_presence(
            user_id=user_id,
            active_thread_id=request.active_thread_id,
            platform=request.platform,
            client_timestamp=request.client_timestamp
        )
        
        if not success:
            raise HTTPException(status_code=500, detail="Failed to update presence")
        
        return {"success": True}
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error in update_presence endpoint: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/clear")
async def clear_presence(
    current_user: dict = Depends(get_current_user)
):
    try:
        user_id = current_user.get('user_id')
        
        logger.debug(f"Presence clear request: user={user_id}")
        
        success = await presence_service.clear_presence(user_id)
        
        if not success:
            raise HTTPException(status_code=500, detail="Failed to clear presence")
        
        return {"success": True}
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error in clear_presence endpoint: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))
