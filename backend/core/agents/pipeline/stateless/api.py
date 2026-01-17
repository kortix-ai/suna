from fastapi import APIRouter, HTTPException, Depends, Query
from typing import Dict, Any, List, Optional
from pydantic import BaseModel

from core.utils.logger import logger
from core.utils.auth_utils import verify_and_get_user_id_from_jwt


class RecoveryResponse(BaseModel):
    run_id: str
    success: bool
    action: str
    message: str
    error: Optional[str] = None


class StuckRunResponse(BaseModel):
    run_id: str
    owner: Optional[str]
    status: Optional[str]
    heartbeat: Optional[float]
    heartbeat_age: Optional[float]
    start: Optional[float]
    duration: Optional[float]
    reason: Optional[str]


class ForceFailRequest(BaseModel):
    error: str = "Admin terminated"


router = APIRouter(prefix="/admin/recovery", tags=["admin-recovery"])


async def require_admin(user_id: str = Depends(verify_and_get_user_id_from_jwt)) -> str:
    return user_id


@router.get("/stuck", response_model=List[StuckRunResponse])
async def list_stuck_runs(
    min_age: int = Query(default=5, ge=1, le=120),
    admin_id: str = Depends(require_admin)
) -> List[StuckRunResponse]:
    from core.agents.pipeline.stateless import recovery

    stuck = await recovery.get_stuck(min_age)
    logger.info(f"[Admin] {admin_id} listed {len(stuck)} stuck runs")
    return [StuckRunResponse(**r) for r in stuck]


@router.post("/resume/{run_id}", response_model=RecoveryResponse)
async def force_resume(run_id: str, admin_id: str = Depends(require_admin)) -> RecoveryResponse:
    from core.agents.pipeline.stateless import recovery

    result = await recovery.force_resume(run_id)
    logger.info(f"[Admin] {admin_id} resumed {run_id}: {result.success}")
    return RecoveryResponse(
        run_id=result.run_id,
        success=result.success,
        action=result.action,
        message=result.message,
        error=result.error,
    )


@router.post("/complete/{run_id}", response_model=RecoveryResponse)
async def force_complete(
    run_id: str,
    reason: str = Query(default="admin"),
    admin_id: str = Depends(require_admin)
) -> RecoveryResponse:
    from core.agents.pipeline.stateless import recovery

    result = await recovery.force_complete(run_id, reason)
    logger.info(f"[Admin] {admin_id} completed {run_id}: {reason}")
    return RecoveryResponse(
        run_id=result.run_id,
        success=result.success,
        action=result.action,
        message=result.message,
        error=result.error,
    )


@router.post("/fail/{run_id}", response_model=RecoveryResponse)
async def force_fail(
    run_id: str,
    request: ForceFailRequest,
    admin_id: str = Depends(require_admin)
) -> RecoveryResponse:
    from core.agents.pipeline.stateless import recovery

    result = await recovery.force_fail(run_id, request.error)
    logger.info(f"[Admin] {admin_id} failed {run_id}: {request.error}")
    return RecoveryResponse(
        run_id=result.run_id,
        success=result.success,
        action=result.action,
        message=result.message,
        error=result.error,
    )


@router.get("/run/{run_id}")
async def get_run_info(run_id: str, admin_id: str = Depends(require_admin)) -> Dict[str, Any]:
    from core.agents.pipeline.stateless import ownership

    info = await ownership.get_info(run_id)
    if not info:
        raise HTTPException(status_code=404, detail=f"Run {run_id} not found")
    return info


@router.get("/dashboard")
async def get_dashboard(admin_id: str = Depends(require_admin)) -> Dict[str, Any]:
    from core.agents.pipeline.stateless import metrics, recovery, ownership, write_buffer

    stuck = await recovery.get_stuck(5)
    health = metrics.check_health()

    return {
        "active_runs": int(metrics.active_runs.get()),
        "owned_runs": ownership.owned_count,
        "pending_writes": int(metrics.pending_writes.get()),
        "stuck_count": len(stuck),
        "runs_started": metrics.runs_started.get(),
        "runs_completed": metrics.runs_completed.get(),
        "runs_failed": metrics.runs_failed.get(),
        "runs_recovered": metrics.runs_recovered.get(),
        "flush_latency_avg": metrics.flush_latency.avg(),
        "flush_latency_p99": metrics.flush_latency.percentile(99),
        "healthy": health["healthy"],
        "alerts": health["alerts"],
    }


@router.get("/health")
async def get_health() -> Dict[str, Any]:
    from core.agents.pipeline.stateless import lifecycle
    return await lifecycle.get_health()


@router.get("/metrics")
async def get_metrics(admin_id: str = Depends(require_admin)) -> str:
    from core.agents.pipeline.stateless import metrics
    return metrics.to_prometheus()


@router.post("/sweep")
async def trigger_sweep(admin_id: str = Depends(require_admin)) -> Dict[str, Any]:
    from core.agents.pipeline.stateless import recovery

    result = await recovery.sweep()
    logger.info(f"[Admin] {admin_id} triggered sweep: {result}")
    return result


@router.post("/flush")
async def trigger_flush(admin_id: str = Depends(require_admin)) -> Dict[str, Any]:
    from core.agents.pipeline.stateless import write_buffer

    result = await write_buffer.flush_all()
    total = sum(result.values())
    logger.info(f"[Admin] {admin_id} triggered flush: {total} writes")
    return {"runs": len(result), "total": total, "details": result}
