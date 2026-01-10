from fastapi import APIRouter
from pydantic import BaseModel
from typing import Optional, List, Literal
from core.services.system_status import get_system_status

router = APIRouter(prefix="/system", tags=["system"])


class MaintenanceNoticeResponse(BaseModel):
    enabled: bool
    startTime: Optional[str] = None
    endTime: Optional[str] = None


class TechnicalIssueResponse(BaseModel):
    enabled: bool
    message: Optional[str] = None
    statusUrl: Optional[str] = None
    affectedServices: Optional[List[str]] = None
    description: Optional[str] = None
    estimatedResolution: Optional[str] = None
    severity: Optional[Literal["degraded", "outage", "maintenance"]] = None


class SystemStatusResponse(BaseModel):
    maintenanceNotice: MaintenanceNoticeResponse
    technicalIssue: TechnicalIssueResponse
    updatedAt: Optional[str] = None


@router.get("/status", response_model=SystemStatusResponse)
async def get_public_system_status() -> SystemStatusResponse:
    status = await get_system_status()
    
    maintenance_notice = MaintenanceNoticeResponse(
        enabled=status.maintenance_notice.enabled,
        startTime=status.maintenance_notice.start_time,
        endTime=status.maintenance_notice.end_time
    )
    
    technical_issue = TechnicalIssueResponse(
        enabled=status.technical_issue.enabled,
        message=status.technical_issue.message,
        statusUrl=status.technical_issue.status_url,
        affectedServices=status.technical_issue.affected_services,
        description=status.technical_issue.description,
        estimatedResolution=status.technical_issue.estimated_resolution,
        severity=status.technical_issue.severity
    )
    
    return SystemStatusResponse(
        maintenanceNotice=maintenance_notice,
        technicalIssue=technical_issue,
        updatedAt=status.updated_at
    )
