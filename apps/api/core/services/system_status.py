from typing import Optional, List, Dict, Any, Literal
from pydantic import BaseModel
from datetime import datetime
import json
from core.services import redis
from core.utils.logger import logger

SYSTEM_STATUS_KEY = "system:status"
SYSTEM_STATUS_TTL = 60 * 60 * 24 * 7


class MaintenanceNotice(BaseModel):
    enabled: bool = False
    start_time: Optional[str] = None
    end_time: Optional[str] = None


class TechnicalIssue(BaseModel):
    enabled: bool = False
    message: Optional[str] = None
    status_url: Optional[str] = None
    affected_services: Optional[List[str]] = None
    description: Optional[str] = None
    estimated_resolution: Optional[str] = None
    severity: Optional[Literal["degraded", "outage", "maintenance"]] = None


class SystemStatus(BaseModel):
    maintenance_notice: MaintenanceNotice = MaintenanceNotice()
    technical_issue: TechnicalIssue = TechnicalIssue()
    updated_at: Optional[str] = None
    updated_by: Optional[str] = None


async def get_system_status() -> SystemStatus:
    try:
        data = await redis.get(SYSTEM_STATUS_KEY)
        if data:
            parsed = json.loads(data)
            return SystemStatus(**parsed)
    except Exception as e:
        logger.warning(f"Failed to get system status from Redis: {e}")
    
    return SystemStatus()


async def set_system_status(
    status: SystemStatus,
    updated_by: Optional[str] = None
) -> bool:
    try:
        status.updated_at = datetime.utcnow().isoformat() + "Z"
        status.updated_by = updated_by
        
        data = status.model_dump_json()
        result = await redis.set(SYSTEM_STATUS_KEY, data, ex=SYSTEM_STATUS_TTL)
        
        if result:
            logger.info(f"System status updated by {updated_by}: maintenance={status.maintenance_notice.enabled}, technical_issue={status.technical_issue.enabled}")
        
        return result
    except Exception as e:
        logger.error(f"Failed to set system status in Redis: {e}")
        return False


async def update_maintenance_notice(
    enabled: bool,
    start_time: Optional[str] = None,
    end_time: Optional[str] = None,
    updated_by: Optional[str] = None
) -> SystemStatus:
    status = await get_system_status()
    
    status.maintenance_notice = MaintenanceNotice(
        enabled=enabled,
        start_time=start_time if enabled else None,
        end_time=end_time if enabled else None
    )
    
    await set_system_status(status, updated_by=updated_by)
    return status


async def update_technical_issue(
    enabled: bool,
    message: Optional[str] = None,
    status_url: Optional[str] = None,
    affected_services: Optional[List[str]] = None,
    description: Optional[str] = None,
    estimated_resolution: Optional[str] = None,
    severity: Optional[Literal["degraded", "outage", "maintenance"]] = None,
    updated_by: Optional[str] = None
) -> SystemStatus:
    status = await get_system_status()
    
    if enabled:
        status.technical_issue = TechnicalIssue(
            enabled=True,
            message=message or "We are investigating a technical issue",
            status_url=status_url,
            affected_services=affected_services,
            description=description,
            estimated_resolution=estimated_resolution,
            severity=severity or "degraded"
        )
    else:
        status.technical_issue = TechnicalIssue(enabled=False)
    
    await set_system_status(status, updated_by=updated_by)
    return status


async def clear_system_status(updated_by: Optional[str] = None) -> SystemStatus:
    status = SystemStatus()
    await set_system_status(status, updated_by=updated_by)
    logger.info(f"System status cleared by {updated_by}")
    return status
