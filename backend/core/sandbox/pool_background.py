import asyncio
from typing import Optional

from core.utils.logger import logger
from core.sandbox.pool_config import get_pool_config
from core.sandbox.pool_service import get_pool_service, SandboxPoolService

_pool_task: Optional[asyncio.Task] = None
_cleanup_task: Optional[asyncio.Task] = None


async def _pool_replenishment_loop(service: SandboxPoolService) -> None:
    config = service.config
    
    logger.info(
        f"[SANDBOX_POOL] Starting replenishment loop "
        f"(min_size={config.min_size}, check_interval={config.check_interval}s)"
    )
    
    await asyncio.sleep(5)
    
    while True:
        try:
            created = await service.ensure_pool_size()
            
            if created > 0:
                logger.info(f"[SANDBOX_POOL] Replenished {created} sandboxes")
            
        except asyncio.CancelledError:
            logger.info("[SANDBOX_POOL] Replenishment loop cancelled")
            break
        except Exception as e:
            logger.error(f"[SANDBOX_POOL] Error in replenishment loop: {e}")
        
        try:
            await asyncio.sleep(config.check_interval)
        except asyncio.CancelledError:
            logger.info("[SANDBOX_POOL] Replenishment loop cancelled during sleep")
            break


async def _pool_cleanup_loop(service: SandboxPoolService) -> None:
    config = service.config
    
    cleanup_interval = min(300, config.max_age // 4)
    
    logger.info(
        f"[SANDBOX_POOL] Starting cleanup loop "
        f"(max_age={config.max_age}s, cleanup_interval={cleanup_interval}s)"
    )
    
    await asyncio.sleep(60)
    
    while True:
        try:
            cleaned = await service.cleanup_stale_sandboxes()
            
            if cleaned > 0:
                logger.info(f"[SANDBOX_POOL] Cleaned up {cleaned} stale sandboxes")
            
        except asyncio.CancelledError:
            logger.info("[SANDBOX_POOL] Cleanup loop cancelled")
            break
        except Exception as e:
            logger.error(f"[SANDBOX_POOL] Error in cleanup loop: {e}")
        
        try:
            await asyncio.sleep(cleanup_interval)
        except asyncio.CancelledError:
            logger.info("[SANDBOX_POOL] Cleanup loop cancelled during sleep")
            break


async def start_pool_service() -> None:
    global _pool_task, _cleanup_task
    
    config = get_pool_config()
    
    if not config.enabled:
        logger.info("[SANDBOX_POOL] Pool service is disabled via configuration")
        return
    
    service = get_pool_service()
    
    logger.info("[SANDBOX_POOL] Starting sandbox pool service...")
    
    _pool_task = asyncio.create_task(_pool_replenishment_loop(service))
    _cleanup_task = asyncio.create_task(_pool_cleanup_loop(service))
    
    try:
        pool_size = await service.get_pool_size()
        logger.info(f"[SANDBOX_POOL] Initial pool size: {pool_size}")
        
        if pool_size < config.replenish_below:
            logger.info(f"[SANDBOX_POOL] Pool below threshold, triggering initial replenishment...")
            created = await service.ensure_pool_size()
            logger.info(f"[SANDBOX_POOL] Initial replenishment created {created} sandboxes")
    except Exception as e:
        logger.error(f"[SANDBOX_POOL] Failed initial pool check: {e}")


async def stop_pool_service() -> None:
    global _pool_task, _cleanup_task
    
    logger.info("[SANDBOX_POOL] Stopping sandbox pool service...")
    
    if _pool_task and not _pool_task.done():
        _pool_task.cancel()
        try:
            await _pool_task
        except asyncio.CancelledError:
            pass
    
    if _cleanup_task and not _cleanup_task.done():
        _cleanup_task.cancel()
        try:
            await _cleanup_task
        except asyncio.CancelledError:
            pass
    
    _pool_task = None
    _cleanup_task = None
    
    logger.info("[SANDBOX_POOL] Sandbox pool service stopped")


def is_pool_service_running() -> bool:
    return (
        _pool_task is not None and not _pool_task.done() and
        _cleanup_task is not None and not _cleanup_task.done()
    )
