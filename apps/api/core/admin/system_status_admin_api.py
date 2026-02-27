from fastapi import APIRouter, HTTPException, Depends
from typing import Optional, List, Literal
from pydantic import BaseModel
from core.auth import require_admin
from core.services.system_status import (
    get_system_status,
    update_maintenance_notice,
    update_technical_issue,
    clear_system_status,
    SystemStatus,
    MaintenanceNotice,
    TechnicalIssue,
    set_system_status
)
from core.utils.logger import logger

router = APIRouter(prefix="/admin/system-status", tags=["admin", "system-status"])


class MaintenanceNoticeRequest(BaseModel):
    enabled: bool
    start_time: Optional[str] = None
    end_time: Optional[str] = None


class TechnicalIssueRequest(BaseModel):
    enabled: bool
    message: Optional[str] = None
    status_url: Optional[str] = None
    affected_services: Optional[List[str]] = None
    description: Optional[str] = None
    estimated_resolution: Optional[str] = None
    severity: Optional[Literal["degraded", "outage", "maintenance"]] = None


class FullSystemStatusRequest(BaseModel):
    maintenance_notice: Optional[MaintenanceNoticeRequest] = None
    technical_issue: Optional[TechnicalIssueRequest] = None


@router.get("", response_model=SystemStatus)
async def admin_get_system_status(
    admin: dict = Depends(require_admin)
) -> SystemStatus:
    try:
        return await get_system_status()
    except Exception as e:
        logger.error(f"Failed to get system status: {e}")
        raise HTTPException(status_code=500, detail="Failed to get system status")


@router.put("", response_model=SystemStatus)
async def admin_update_full_system_status(
    request: FullSystemStatusRequest,
    admin: dict = Depends(require_admin)
) -> SystemStatus:
    try:
        admin_email = admin.get("email", "unknown")
        status = await get_system_status()
        
        if request.maintenance_notice is not None:
            status.maintenance_notice = MaintenanceNotice(
                enabled=request.maintenance_notice.enabled,
                start_time=request.maintenance_notice.start_time if request.maintenance_notice.enabled else None,
                end_time=request.maintenance_notice.end_time if request.maintenance_notice.enabled else None
            )
        
        if request.technical_issue is not None:
            if request.technical_issue.enabled:
                status.technical_issue = TechnicalIssue(
                    enabled=True,
                    message=request.technical_issue.message or "We are investigating a technical issue",
                    status_url=request.technical_issue.status_url,
                    affected_services=request.technical_issue.affected_services,
                    description=request.technical_issue.description,
                    estimated_resolution=request.technical_issue.estimated_resolution,
                    severity=request.technical_issue.severity or "degraded"
                )
            else:
                status.technical_issue = TechnicalIssue(enabled=False)
        
        await set_system_status(status, updated_by=admin_email)
        return status
    except Exception as e:
        logger.error(f"Failed to update system status: {e}")
        raise HTTPException(status_code=500, detail="Failed to update system status")


@router.put("/maintenance", response_model=SystemStatus)
async def admin_update_maintenance_notice(
    request: MaintenanceNoticeRequest,
    admin: dict = Depends(require_admin)
) -> SystemStatus:
    try:
        admin_email = admin.get("email", "unknown")
        
        if request.enabled and (not request.start_time or not request.end_time):
            raise HTTPException(
                status_code=400,
                detail="start_time and end_time are required when enabling maintenance notice"
            )
        
        return await update_maintenance_notice(
            enabled=request.enabled,
            start_time=request.start_time,
            end_time=request.end_time,
            updated_by=admin_email
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to update maintenance notice: {e}")
        raise HTTPException(status_code=500, detail="Failed to update maintenance notice")


@router.put("/technical-issue", response_model=SystemStatus)
async def admin_update_technical_issue(
    request: TechnicalIssueRequest,
    admin: dict = Depends(require_admin)
) -> SystemStatus:
    try:
        admin_email = admin.get("email", "unknown")
        
        return await update_technical_issue(
            enabled=request.enabled,
            message=request.message,
            status_url=request.status_url,
            affected_services=request.affected_services,
            description=request.description,
            estimated_resolution=request.estimated_resolution,
            severity=request.severity,
            updated_by=admin_email
        )
    except Exception as e:
        logger.error(f"Failed to update technical issue: {e}")
        raise HTTPException(status_code=500, detail="Failed to update technical issue")


@router.delete("", response_model=SystemStatus)
async def admin_clear_system_status(
    admin: dict = Depends(require_admin)
) -> SystemStatus:
    try:
        admin_email = admin.get("email", "unknown")
        return await clear_system_status(updated_by=admin_email)
    except Exception as e:
        logger.error(f"Failed to clear system status: {e}")
        raise HTTPException(status_code=500, detail="Failed to clear system status")
