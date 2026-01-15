from fastapi import APIRouter, HTTPException, Depends, Query
from typing import Optional
from pydantic import BaseModel
from core.auth import require_admin
from core.utils.logger import logger

router = APIRouter(prefix="/admin/sandbox-pool", tags=["admin", "sandbox-pool"])


class ForceCreateRequest(BaseModel):
    count: int = 1


class RemoveFromPoolRequest(BaseModel):
    sandbox_ids: list[str]
    delete_sandbox: bool = False


@router.get("/stats")
async def get_sandbox_pool_stats(admin: dict = Depends(require_admin)):
    try:
        from core.sandbox.pool_service import get_pool_service
        from core.sandbox.pool_config import get_pool_config
        from core.sandbox import pool_repo
        
        service = get_pool_service()
        config = get_pool_config()
        pool_size = await pool_repo.get_pool_size()
        
        stats = service.get_stats()
        stats['pool_size'] = pool_size
        stats['config'] = {
            'enabled': config.enabled,
            'min_size': config.min_size,
            'max_size': config.max_size,
            'replenish_threshold': config.replenish_threshold,
            'check_interval': config.check_interval,
            'max_age': config.max_age,
        }
        
        return stats
        
    except Exception as e:
        logger.error(f"Error getting sandbox pool stats: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/health")
async def get_pool_health(admin: dict = Depends(require_admin)):
    try:
        from core.sandbox.pool_background import is_pool_service_running
        from core.sandbox.pool_config import get_pool_config
        from core.sandbox import pool_repo
        
        config = get_pool_config()
        pool_size = await pool_repo.get_pool_size()
        service_running = is_pool_service_running()
        
        health_status = "healthy"
        issues = []
        
        if not config.enabled:
            health_status = "disabled"
            issues.append("Pool service is disabled via configuration")
        elif not service_running:
            health_status = "critical"
            issues.append("Background service is not running")
        elif pool_size == 0:
            health_status = "warning"
            issues.append("Pool is empty")
        elif pool_size < config.replenish_below:
            health_status = "warning"
            issues.append(f"Pool size ({pool_size}) below replenish threshold ({config.replenish_below})")
        
        return {
            "status": health_status,
            "service_running": service_running,
            "pool_enabled": config.enabled,
            "pool_size": pool_size,
            "min_size": config.min_size,
            "replenish_threshold": config.replenish_below,
            "issues": issues,
        }
        
    except Exception as e:
        logger.error(f"Error getting pool health: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/list")
async def list_pooled_sandboxes(
    limit: int = Query(50, ge=1, le=100),
    admin: dict = Depends(require_admin)
):
    try:
        from core.sandbox import pool_repo
        
        sandboxes = await pool_repo.get_pooled_sandboxes(limit=limit)
        
        return {
            "count": len(sandboxes),
            "sandboxes": [
                {
                    "id": s["id"],
                    "external_id": s["external_id"],
                    "pooled_at": s.get("pooled_at"),
                    "created_at": s.get("created_at"),
                }
                for s in sandboxes
            ]
        }
        
    except Exception as e:
        logger.error(f"Error listing pooled sandboxes: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/replenish")
async def trigger_pool_replenish(admin: dict = Depends(require_admin)):
    try:
        from core.sandbox.pool_service import get_pool_service
        from core.sandbox import pool_repo
        
        service = get_pool_service()
        size_before = await pool_repo.get_pool_size()
        created = await service.ensure_pool_size()
        size_after = await pool_repo.get_pool_size()
        
        return {
            "success": True,
            "sandboxes_created": created,
            "pool_size_before": size_before,
            "pool_size_after": size_after,
        }
        
    except Exception as e:
        logger.error(f"Error triggering pool replenish: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/force-create")
async def force_create_sandboxes(
    request_body: ForceCreateRequest,
    admin: dict = Depends(require_admin)
):
    try:
        from core.sandbox.pool_service import get_pool_service
        from core.sandbox import pool_repo
        import asyncio
        
        count = min(request_body.count, 10)
        
        service = get_pool_service()
        size_before = await pool_repo.get_pool_size()
        
        tasks = [service.create_pooled_sandbox() for _ in range(count)]
        results = await asyncio.gather(*tasks, return_exceptions=True)
        
        created = []
        failed = []
        for i, r in enumerate(results):
            if isinstance(r, Exception):
                failed.append(str(r))
            elif r is not None:
                created.append(r)
            else:
                failed.append(f"Sandbox {i+1} returned None")
        
        size_after = await pool_repo.get_pool_size()
        
        return {
            "success": True,
            "requested": count,
            "created_count": len(created),
            "created_ids": created,
            "failed_count": len(failed),
            "failed_errors": failed[:5],
            "pool_size_before": size_before,
            "pool_size_after": size_after,
        }
        
    except Exception as e:
        logger.error(f"Error force creating sandboxes: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/cleanup")
async def trigger_pool_cleanup(admin: dict = Depends(require_admin)):
    try:
        from core.sandbox.pool_service import get_pool_service
        from core.sandbox import pool_repo
        
        service = get_pool_service()
        size_before = await pool_repo.get_pool_size()
        cleaned = await service.cleanup_stale_sandboxes()
        size_after = await pool_repo.get_pool_size()
        
        return {
            "success": True,
            "cleaned_count": cleaned,
            "pool_size_before": size_before,
            "pool_size_after": size_after,
        }
        
    except Exception as e:
        logger.error(f"Error triggering pool cleanup: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/remove")
async def remove_from_pool(
    request_body: RemoveFromPoolRequest,
    admin: dict = Depends(require_admin)
):
    try:
        from core.sandbox import pool_repo
        from core.sandbox.sandbox import delete_sandbox
        
        removed = []
        failed = []
        
        for sandbox_id in request_body.sandbox_ids[:20]:
            try:
                resource = await pool_repo.get_sandbox_by_external_id(sandbox_id)
                if not resource:
                    failed.append({"id": sandbox_id, "error": "Not found"})
                    continue
                
                if resource.get("status") != "pooled":
                    failed.append({"id": sandbox_id, "error": f"Status is {resource.get('status')}, not pooled"})
                    continue
                
                if request_body.delete_sandbox:
                    try:
                        await delete_sandbox(sandbox_id)
                    except Exception as del_err:
                        logger.warning(f"Failed to delete sandbox {sandbox_id}: {del_err}")
                
                await pool_repo.mark_sandbox_deleted(resource["id"])
                removed.append(sandbox_id)
                
            except Exception as e:
                failed.append({"id": sandbox_id, "error": str(e)})
        
        return {
            "success": True,
            "removed_count": len(removed),
            "removed_ids": removed,
            "failed_count": len(failed),
            "failed": failed,
        }
        
    except Exception as e:
        logger.error(f"Error removing sandboxes from pool: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/restart-service")
async def restart_pool_service(admin: dict = Depends(require_admin)):
    try:
        from core.sandbox.pool_background import stop_pool_service, start_pool_service, is_pool_service_running
        
        was_running = is_pool_service_running()
        await stop_pool_service()
        await start_pool_service()
        is_running = is_pool_service_running()
        
        return {
            "success": True,
            "was_running": was_running,
            "is_running": is_running,
            "message": "Pool service restarted" if is_running else "Failed to restart pool service"
        }
        
    except Exception as e:
        logger.error(f"Error restarting pool service: {e}")
        raise HTTPException(status_code=500, detail=str(e))
