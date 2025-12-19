from fastapi import APIRouter, Depends, HTTPException
from typing import Dict, Optional, Any
from pydantic import BaseModel
from core.utils.logger import logger
from core.auth import require_admin
from core.notifications.notification_service import notification_service

router = APIRouter(prefix="/admin/notifications", tags=["admin-notifications"])


class TriggerWorkflowRequest(BaseModel):
    workflow_id: str
    payload: Dict[str, Any]
    subscriber_id: Optional[str] = None
    subscriber_email: Optional[str] = None
    broadcast: bool = False


@router.get("/workflows")
async def list_workflows(
    admin: dict = Depends(require_admin)
):
    try:
        logger.info("[ADMIN] Fetching workflows from Novu")
        
        result = await notification_service.novu.list_workflows()
        
        if not result.get("success"):
            raise HTTPException(
                status_code=500,
                detail=result.get("error", "Failed to fetch workflows")
            )
        
        return {
            "success": True,
            "workflows": result.get("workflows", []),
            "total": result.get("total", 0)
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[ADMIN] Error fetching workflows: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/trigger-workflow")
async def trigger_workflow_admin(
    request: TriggerWorkflowRequest,
    admin: dict = Depends(require_admin)
):
    try:
        logger.info(f"[ADMIN] Triggering workflow: {request.workflow_id}, broadcast: {request.broadcast}, subscriber_id: {request.subscriber_id}, subscriber_email: {request.subscriber_email}")
        
        if not request.workflow_id:
            raise HTTPException(status_code=400, detail="workflow_id is required")
        
        if not request.broadcast and not request.subscriber_id and not request.subscriber_email:
            raise HTTPException(
                status_code=400,
                detail="Either subscriber_id, subscriber_email, or broadcast=true must be provided"
            )
        
        if request.broadcast and (request.subscriber_id or request.subscriber_email):
            raise HTTPException(
                status_code=400,
                detail="Cannot specify broadcast with subscriber_id or subscriber_email"
            )
        
        if request.subscriber_id and request.subscriber_email:
            raise HTTPException(
                status_code=400,
                detail="Cannot specify both subscriber_id and subscriber_email"
            )
        
        result = await notification_service.trigger_workflow_admin(
            workflow_id=request.workflow_id,
            payload_template=request.payload,
            subscriber_id=request.subscriber_id,
            subscriber_email=request.subscriber_email,
            broadcast=request.broadcast
        )
        
        if not result.get("success"):
            raise HTTPException(
                status_code=500,
                detail=result.get("error", "Failed to trigger workflow")
            )
        
        return {
            "success": True,
            "message": "Workflow triggered successfully",
            **result
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[ADMIN] Error triggering workflow: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))
