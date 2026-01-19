import asyncio
from typing import Optional

from core.utils.logger import logger
from core.sandbox.pool_config import get_pool_config
from core.sandbox.pool_service import get_pool_service, SandboxPoolService

_pool_task: Optional[asyncio.Task] = None
_cleanup_task: Optional[asyncio.Task] = None
_keepalive_task: Optional[asyncio.Task] = None

KEEPALIVE_INTERVAL_SECONDS = 600

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


async def _pool_keepalive_loop(service: SandboxPoolService) -> None:
    logger.info(
        f"[SANDBOX_POOL] Starting keepalive loop "
        f"(interval={KEEPALIVE_INTERVAL_SECONDS}s)"
    )
    
    await asyncio.sleep(30)
    
    while True:
        try:
            pinged = await service.keepalive_pooled_sandboxes()
            
            if pinged > 0:
                logger.debug(f"[SANDBOX_POOL] Keepalive pinged {pinged} sandboxes")
            
        except asyncio.CancelledError:
            logger.info("[SANDBOX_POOL] Keepalive loop cancelled")
            break
        except Exception as e:
            logger.error(f"[SANDBOX_POOL] Error in keepalive loop: {e}")
        
        try:
            await asyncio.sleep(KEEPALIVE_INTERVAL_SECONDS)
        except asyncio.CancelledError:
            logger.info("[SANDBOX_POOL] Keepalive loop cancelled during sleep")
            break


async def _initial_pool_warmup(service: SandboxPoolService) -> None:
    config = service.config
    
    try:
        pool_size = await service.get_pool_size()
        logger.info(f"[SANDBOX_POOL] Initial pool size: {pool_size}")
        
        if pool_size >= config.replenish_below:
            logger.info(f"[SANDBOX_POOL] Pool already at healthy size ({pool_size}), no warmup needed")
            return
        
        logger.info(f"[SANDBOX_POOL] Pool below threshold ({pool_size} < {config.replenish_below}), starting warmup...")
        target = config.min_size
        to_create = min(target - pool_size, config.max_size - pool_size)
        
        if to_create <= 0:
            return
        
        batch_size = config.parallel_create_limit
        created_total = 0
        
        while created_total < to_create:
            batch = min(batch_size, to_create - created_total)
            tasks = [service.create_pooled_sandbox() for _ in range(batch)]
            results = await asyncio.gather(*tasks, return_exceptions=True)
            
            created = sum(1 for r in results if r is not None and not isinstance(r, Exception))
            created_total += created
            
            logger.info(f"[SANDBOX_POOL] Warmup progress: {created_total}/{to_create} sandboxes created")
            
            if created_total < to_create:
                logger.info(f"[SANDBOX_POOL] Waiting {config.batch_delay}s before next batch to avoid rate limits...")
                await asyncio.sleep(config.batch_delay)
        
        logger.info(f"[SANDBOX_POOL] Initial warmup complete: created {created_total} sandboxes")
        
    except Exception as e:
        logger.error(f"[SANDBOX_POOL] Initial warmup failed: {e}")


_warmup_task: Optional[asyncio.Task] = None


async def start_pool_service() -> None:
    global _pool_task, _cleanup_task, _keepalive_task, _warmup_task
    
    config = get_pool_config()
    
    if not config.enabled:
        logger.info("[SANDBOX_POOL] Pool service is disabled via configuration")
        return
    

    # logger.warning("[SANDBOX_POOL] Pool service DISABLED - sandbox creation paused due to Daytona rate limiting")
    # return
    
    service = get_pool_service()
    
    logger.info(
        f"[SANDBOX_POOL] Starting sandbox pool service "
        f"(min={config.min_size}, max={config.max_size}, parallel={config.parallel_create_limit})"
    )
    
    _pool_task = asyncio.create_task(_pool_replenishment_loop(service))
    _cleanup_task = asyncio.create_task(_pool_cleanup_loop(service))
    _keepalive_task = asyncio.create_task(_pool_keepalive_loop(service))
    _warmup_task = asyncio.create_task(_initial_pool_warmup(service))
    
    logger.info("[SANDBOX_POOL] All background tasks started (non-blocking)")


async def stop_pool_service() -> None:
    global _pool_task, _cleanup_task, _keepalive_task, _warmup_task
    
    logger.info("[SANDBOX_POOL] Stopping sandbox pool service...")
    
    tasks = [_pool_task, _cleanup_task, _keepalive_task, _warmup_task]
    
    for task in tasks:
        if task and not task.done():
            task.cancel()
    
    for task in tasks:
        if task:
            try:
                await task
            except asyncio.CancelledError:
                pass
    
    _pool_task = None
    _cleanup_task = None
    _keepalive_task = None
    _warmup_task = None
    
    logger.info("[SANDBOX_POOL] Sandbox pool service stopped")


def is_pool_service_running() -> bool:
    return (
        _pool_task is not None and not _pool_task.done() and
        _cleanup_task is not None and not _cleanup_task.done() and
        _keepalive_task is not None and not _keepalive_task.done()
    )
