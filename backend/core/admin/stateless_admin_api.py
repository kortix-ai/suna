from fastapi import APIRouter, HTTPException, Depends, Query
from typing import Dict, Any, List, Optional
from pydantic import BaseModel

from core.utils.logger import logger
from core.auth import require_admin


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


class DLQEntryResponse(BaseModel):
    entry_id: str
    run_id: str
    write_type: str
    error: str
    attempt_count: int
    created_at: float
    failed_at: float


router = APIRouter(prefix="/admin/stateless", tags=["admin-stateless"])


@router.get("/stuck", response_model=List[StuckRunResponse])
async def list_stuck_runs(
    min_age: int = Query(default=5, ge=1, le=120),
    admin_user: Dict = Depends(require_admin)
) -> List[StuckRunResponse]:
    from core.agents.pipeline.stateless import recovery

    stuck = await recovery.get_stuck(min_age)
    logger.info(f"[Admin] {admin_user.get('id')} listed {len(stuck)} stuck runs")
    return [StuckRunResponse(**r) for r in stuck]


@router.post("/resume/{run_id}", response_model=RecoveryResponse)
async def force_resume(
    run_id: str,
    admin_user: Dict = Depends(require_admin)
) -> RecoveryResponse:
    from core.agents.pipeline.stateless import recovery

    result = await recovery.force_resume(run_id)
    logger.info(f"[Admin] {admin_user.get('id')} resumed {run_id}: {result.success}")
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
    admin_user: Dict = Depends(require_admin)
) -> RecoveryResponse:
    from core.agents.pipeline.stateless import recovery

    result = await recovery.force_complete(run_id, reason)
    logger.info(f"[Admin] {admin_user.get('id')} completed {run_id}: {reason}")
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
    admin_user: Dict = Depends(require_admin)
) -> RecoveryResponse:
    from core.agents.pipeline.stateless import recovery

    result = await recovery.force_fail(run_id, request.error)
    logger.info(f"[Admin] {admin_user.get('id')} failed {run_id}: {request.error}")
    return RecoveryResponse(
        run_id=result.run_id,
        success=result.success,
        action=result.action,
        message=result.message,
        error=result.error,
    )


@router.get("/run/{run_id}")
async def get_run_info(
    run_id: str,
    admin_user: Dict = Depends(require_admin)
) -> Dict[str, Any]:
    from core.agents.pipeline.stateless import ownership

    info = await ownership.get_info(run_id)
    if not info:
        raise HTTPException(status_code=404, detail=f"Run {run_id} not found")
    return info


@router.get("/dashboard")
async def get_dashboard(admin_user: Dict = Depends(require_admin)) -> Dict[str, Any]:
    from core.agents.pipeline.stateless import metrics, recovery, ownership, write_buffer
    from core.agents.pipeline.stateless.persistence import wal, dlq

    stuck = await recovery.get_stuck(5)
    health = metrics.check_health()
    wal_stats = await wal.get_stats()
    dlq_stats = await dlq.get_stats()

    return {
        "active_runs": int(metrics.active_runs.get()),
        "owned_runs": ownership.owned_count,
        "pending_writes": int(metrics.pending_writes.get()),
        "stuck_count": len(stuck),
        "runs_started": metrics.runs_started.get(),
        "runs_completed": metrics.runs_completed.get(),
        "runs_failed": metrics.runs_failed.get(),
        "runs_recovered": metrics.runs_recovered.get(),
        "runs_rejected": metrics.runs_rejected.get(),
        "flush_latency_avg": metrics.flush_latency.avg(),
        "flush_latency_p99": metrics.flush_latency.percentile(99),
        "wal": wal_stats,
        "dlq": dlq_stats,
        "healthy": health["healthy"],
        "alerts": health["alerts"],
    }


@router.get("/health")
async def get_health() -> Dict[str, Any]:
    from core.agents.pipeline.stateless import lifecycle
    from fastapi.responses import JSONResponse
    
    health = await lifecycle.get_health()
    
    if health.get("shutting_down") or not health.get("healthy"):
        return JSONResponse(content=health, status_code=503)
    
    return health


@router.get("/metrics")
async def get_metrics(admin_user: Dict = Depends(require_admin)) -> str:
    from core.agents.pipeline.stateless import metrics
    return metrics.to_prometheus()


@router.post("/sweep")
async def trigger_sweep(admin_user: Dict = Depends(require_admin)) -> Dict[str, Any]:
    from core.agents.pipeline.stateless import recovery

    result = await recovery.sweep()
    logger.info(f"[Admin] {admin_user.get('id')} triggered sweep: {result}")
    return result


@router.post("/flush")
async def trigger_flush(admin_user: Dict = Depends(require_admin)) -> Dict[str, Any]:
    from core.agents.pipeline.stateless import write_buffer

    result = await write_buffer.flush_all()
    total = sum(result.values())
    logger.info(f"[Admin] {admin_user.get('id')} triggered flush: {total} writes")
    return {"runs": len(result), "total": total, "details": result}


@router.get("/dlq/entries", response_model=List[DLQEntryResponse])
async def list_dlq_entries(
    count: int = Query(default=50, ge=1, le=500),
    run_id: Optional[str] = None,
    admin_user: Dict = Depends(require_admin)
) -> List[DLQEntryResponse]:
    from core.agents.pipeline.stateless.persistence import dlq

    entries = await dlq.get_entries(count=count, run_id=run_id)
    return [
        DLQEntryResponse(
            entry_id=e.entry_id,
            run_id=e.run_id,
            write_type=e.write_type,
            error=e.error,
            attempt_count=e.attempt_count,
            created_at=e.created_at,
            failed_at=e.failed_at,
        )
        for e in entries
    ]


@router.post("/dlq/retry/{entry_id}")
async def retry_dlq_entry(
    entry_id: str,
    admin_user: Dict = Depends(require_admin)
) -> Dict[str, Any]:
    from core.agents.pipeline.stateless.persistence import dlq

    success = await dlq.retry_entry(entry_id)
    logger.info(f"[Admin] {admin_user.get('id')} retried DLQ entry {entry_id}: {success}")
    return {"success": success, "entry_id": entry_id}


@router.delete("/dlq/{entry_id}")
async def delete_dlq_entry(
    entry_id: str,
    admin_user: Dict = Depends(require_admin)
) -> Dict[str, Any]:
    from core.agents.pipeline.stateless.persistence import dlq

    success = await dlq.delete_entry(entry_id)
    logger.info(f"[Admin] {admin_user.get('id')} deleted DLQ entry {entry_id}: {success}")
    return {"success": success, "entry_id": entry_id}


@router.post("/dlq/purge")
async def purge_dlq(
    older_than_hours: Optional[int] = Query(default=None, ge=1, le=168),
    admin_user: Dict = Depends(require_admin)
) -> Dict[str, Any]:
    from core.agents.pipeline.stateless.persistence import dlq

    older_than_seconds = older_than_hours * 3600 if older_than_hours else None
    deleted = await dlq.purge(older_than_seconds)
    logger.info(f"[Admin] {admin_user.get('id')} purged DLQ: {deleted} entries")
    return {"deleted": deleted}


@router.get("/wal/stats")
async def get_wal_stats(admin_user: Dict = Depends(require_admin)) -> Dict[str, Any]:
    from core.agents.pipeline.stateless.persistence import wal
    return await wal.get_stats()


@router.get("/circuit-breakers")
async def get_circuit_breakers(admin_user: Dict = Depends(require_admin)) -> Dict[str, Any]:
    from core.agents.pipeline.stateless.resilience.circuit_breaker import registry
    return registry.to_dict()


@router.post("/circuit-breakers/reset")
async def reset_circuit_breakers(admin_user: Dict = Depends(require_admin)) -> Dict[str, Any]:
    from core.agents.pipeline.stateless.resilience.circuit_breaker import registry
    registry.reset_all()
    logger.info(f"[Admin] {admin_user.get('id')} reset all circuit breakers")
    return {"success": True}


@router.get("/rate-limiters")
async def get_rate_limiters(admin_user: Dict = Depends(require_admin)) -> Dict[str, Any]:
    from core.agents.pipeline.stateless.resilience.rate_limiter import rate_limiter_registry
    return rate_limiter_registry.to_dict()


@router.get("/backpressure")
async def get_backpressure(admin_user: Dict = Depends(require_admin)) -> Dict[str, Any]:
    from core.agents.pipeline.stateless.resilience.backpressure import backpressure
    return backpressure.to_dict()


@router.get("/metrics/history")
async def get_metrics_history(
    minutes: int = Query(default=30, ge=5, le=120),
    admin_user: Dict = Depends(require_admin)
) -> Dict[str, Any]:
    from core.services import redis
    from core.agents.pipeline.stateless import metrics
    import json
    import time
    
    HISTORY_KEY = "stateless:metrics:history"
    MAX_ENTRIES = 360
    
    now = time.time()
    current = {
        "timestamp": now,
        "active_runs": int(metrics.active_runs.get()),
        "pending_writes": int(metrics.pending_writes.get()),
        "runs_started": metrics.runs_started.get(),
        "runs_completed": metrics.runs_completed.get(),
        "runs_failed": metrics.runs_failed.get(),
        "flush_latency_avg": metrics.flush_latency.avg(),
        "flush_latency_p99": metrics.flush_latency.percentile(99),
        "writes_dropped": metrics.writes_dropped.get(),
        "dlq_entries": metrics.dlq_entries.get(),
    }
    
    try:
        await redis.lpush(HISTORY_KEY, json.dumps(current))
        await redis.ltrim(HISTORY_KEY, 0, MAX_ENTRIES - 1)
        await redis.expire(HISTORY_KEY, 86400)
    except Exception as e:
        logger.warning(f"Failed to store metrics history: {e}")
    
    cutoff = now - (minutes * 60)
    history = []
    
    try:
        raw_entries = await redis.lrange(HISTORY_KEY, 0, MAX_ENTRIES)
        for raw in raw_entries:
            try:
                entry = json.loads(raw)
                if entry.get("timestamp", 0) >= cutoff:
                    history.append(entry)
            except:
                continue
        history.reverse()
    except Exception as e:
        logger.warning(f"Failed to retrieve metrics history: {e}")
    
    return {
        "current": current,
        "history": history,
        "minutes": minutes,
    }
