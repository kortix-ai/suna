from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from typing import Optional, Dict
from core.utils.logger import logger
from core.utils.auth_utils import get_user_id_from_stream_auth
from .presence_service import presence_service

router = APIRouter(tags=["presence"], prefix="/presence")

class UpdatePresenceRequest(BaseModel):
    session_id: str
    active_thread_id: Optional[str] = None
    platform: str = "web"
    client_timestamp: Optional[str] = None
    device_info: Optional[Dict] = None


@router.post("/update")
async def update_presence(
    payload: UpdatePresenceRequest,
    request: Request,
    token: Optional[str] = None
):
    try:
        account_id = await get_user_id_from_stream_auth(request, token)
        
        if not payload.session_id:
            raise HTTPException(status_code=400, detail="session_id is required")
        
        logger.debug(
            f"Presence update request: account={account_id}, session={payload.session_id}, "
            f"thread={payload.active_thread_id}, timestamp={payload.client_timestamp}"
        )
        
        success = await presence_service.update_presence(
            session_id=payload.session_id,
            account_id=account_id,
            active_thread_id=payload.active_thread_id,
            platform=payload.platform,
            client_timestamp=payload.client_timestamp,
            device_info=payload.device_info
        )
        
        if not success:
            raise HTTPException(status_code=500, detail="Failed to update presence")
        
        return {"success": True, "session_id": payload.session_id}
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error in update_presence endpoint: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/clear")
async def clear_presence(
    request: Request,
    session_id: Optional[str] = None,
    token: Optional[str] = None
):
    try:
        account_id = await get_user_id_from_stream_auth(request, token)
        
        if not session_id:
            raise HTTPException(status_code=400, detail="session_id is required")
        
        logger.debug(f"Presence clear request: account={account_id}, session={session_id}")
        
        success = await presence_service.clear_presence(session_id, account_id)
        
        if not success:
            raise HTTPException(status_code=500, detail="Failed to clear presence")
        
        return {"success": True}
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error in clear_presence endpoint: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/thread/{thread_id}/viewers")
async def get_thread_viewers(
    thread_id: str,
    request: Request,
    token: Optional[str] = None
):
    try:
        await get_user_id_from_stream_auth(request, token)
        viewers = await presence_service.get_thread_viewers(thread_id)
        return {"thread_id": thread_id, "viewers": viewers}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting thread viewers: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/account/threads")
async def get_account_active_threads(
    request: Request,
    token: Optional[str] = None
):
    try:
        account_id = await get_user_id_from_stream_auth(request, token)
        threads = await presence_service.get_account_active_threads(account_id)
        return {"account_id": account_id, "active_threads": threads}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting account active threads: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/cleanup")
async def cleanup_stale_sessions(
    request: Request,
    token: Optional[str] = None
):
    try:
        account_id = await get_user_id_from_stream_auth(request, token)
        count = await presence_service.cleanup_stale_sessions(account_id)
        return {"success": True, "cleaned": count}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error cleaning up stale sessions: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))
