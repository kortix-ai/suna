import asyncio
import time
from typing import Optional, Tuple, Dict, Any
from dataclasses import dataclass

from core.utils.logger import logger
from core.utils.config import config, EnvMode
from core.services import redis

SLOT_KEY_TTL = 7200
RESOURCE_COUNT_TTL = 3600
SLOT_OP_TIMEOUT = 2.0

@dataclass
class SlotReservation:
    acquired: bool
    slot_count: int
    limit: int
    message: str
    error_code: Optional[str] = None
    latency_ms: float = 0


@dataclass
class ResourceReservation:
    allowed: bool
    current_count: int
    limit: int
    message: str
    error_code: Optional[str] = None
    latency_ms: float = 0


def _slot_key(account_id: str) -> str:
    return f"slots:{account_id}"


def _thread_count_key(account_id: str) -> str:
    return f"thread_count:{account_id}"


def _project_count_key(account_id: str) -> str:
    return f"project_count:{account_id}"


def _tier_info_key(account_id: str) -> str:
    return f"tier_limits:{account_id}"


def _get_tier_from_config(tier_name: str) -> Dict[str, Any]:
    from core.billing.shared.config import TIERS
    tier_obj = TIERS.get(tier_name, TIERS.get('free'))
    if not tier_obj:
        return {
            'name': 'free',
            'thread_limit': 10,
            'project_limit': 20,
            'concurrent_runs': 1,
            'custom_workers_limit': 0,
            'scheduled_triggers_limit': 0,
            'app_triggers_limit': 0,
        }
    return {
        'name': tier_obj.name,
        'thread_limit': tier_obj.thread_limit,
        'project_limit': tier_obj.project_limit,
        'concurrent_runs': tier_obj.concurrent_runs,
        'custom_workers_limit': tier_obj.custom_workers_limit,
        'scheduled_triggers_limit': tier_obj.scheduled_triggers_limit,
        'app_triggers_limit': tier_obj.app_triggers_limit,
    }


async def get_tier_limits(account_id: str) -> Dict[str, Any]:
    if config.ENV_MODE == EnvMode.LOCAL:
        return {'name': 'local', 'thread_limit': 999, 'project_limit': 999, 'concurrent_runs': 999}
    
    try:
        from core.billing import subscription_service
        tier_info = await subscription_service.get_user_subscription_tier(account_id, skip_cache=False)
        tier_name = tier_info.get('name', 'free')
        
        return _get_tier_from_config(tier_name)
        
    except Exception as e:
        logger.warning(f"[TIER] Failed to get tier for {account_id}: {e}, using free defaults")
        return _get_tier_from_config('free')


async def invalidate_tier_cache(account_id: str) -> None:
    try:
        await redis.delete(_tier_info_key(account_id))
        logger.debug(f"[TIER] Invalidated cache for {account_id}")
    except Exception as e:
        logger.warning(f"[TIER] Failed to invalidate cache for {account_id}: {e}")


async def reserve_slot(account_id: str, agent_run_id: str, skip: bool = False) -> SlotReservation:
    if skip or config.ENV_MODE == EnvMode.LOCAL:
        return SlotReservation(True, 0, 999, "skipped")
    
    start = time.time()
    key = _slot_key(account_id)
    
    try:
        tier = await get_tier_limits(account_id)
        limit = tier['concurrent_runs']
        
        count = await asyncio.wait_for(
            redis.incr(key),
            timeout=SLOT_OP_TIMEOUT
        )
        
        asyncio.create_task(_set_ttl(key))
        latency = (time.time() - start) * 1000
        
        if count <= limit:
            logger.debug(f"[SLOT] Reserved {agent_run_id}: {count}/{limit} ({latency:.1f}ms)")
            return SlotReservation(True, count, limit, "ok", latency_ms=latency)
        
        await asyncio.wait_for(redis.decr(key), timeout=SLOT_OP_TIMEOUT)
        
        logger.info(f"[SLOT] Rejected {agent_run_id}: {count}/{limit}")
        return SlotReservation(
            acquired=False,
            slot_count=count - 1,
            limit=limit,
            message=f"Concurrent limit reached ({limit})",
            error_code="AGENT_RUN_LIMIT_EXCEEDED",
            latency_ms=latency
        )
        
    except asyncio.TimeoutError:
        logger.warning(f"[SLOT] Redis timeout for {agent_run_id} - allowing")
        return SlotReservation(True, 0, 999, "timeout_allow")
    except Exception as e:
        logger.warning(f"[SLOT] Error for {agent_run_id}: {e} - allowing")
        return SlotReservation(True, 0, 999, "error_allow")


async def release_slot(account_id: str, agent_run_id: str) -> bool:
    if config.ENV_MODE == EnvMode.LOCAL:
        return True
    
    try:
        key = _slot_key(account_id)
        count = await asyncio.wait_for(redis.decr(key), timeout=SLOT_OP_TIMEOUT)
        
        if count < 0:
            await redis.set(key, "0", ex=SLOT_KEY_TTL)
        
        logger.debug(f"[SLOT] Released {agent_run_id}: now {max(0, count)}")
        return True
    except Exception as e:
        logger.error(f"[SLOT] Release failed for {agent_run_id}: {e}")
        return False


async def get_count(account_id: str) -> int:
    try:
        val = await redis.get(_slot_key(account_id))
        return int(val) if val else 0
    except Exception:
        return 0


async def sync_from_db(account_id: str) -> dict:
    if config.ENV_MODE == EnvMode.LOCAL:
        return {"synced": False}
    
    try:
        from core.utils.limits_repo import count_running_agent_runs
        
        key = _slot_key(account_id)
        
        redis_val = await redis.get(key)
        redis_count = int(redis_val) if redis_val else 0
        
        db_result = await count_running_agent_runs(account_id)
        db_count = db_result.get('running_count', 0)
        
        if redis_count != db_count:
            await redis.set(key, str(db_count), ex=SLOT_KEY_TTL)
            logger.warning(f"[SLOT] Synced {account_id}: Redis {redis_count} → DB {db_count}")
            return {"synced": True, "old": redis_count, "new": db_count}
        
        return {"synced": False, "count": db_count}
    except Exception as e:
        logger.error(f"[SLOT] Sync failed for {account_id}: {e}")
        return {"synced": False, "error": str(e)}


async def _set_ttl(key: str) -> None:
    try:
        await redis.expire(key, SLOT_KEY_TTL)
    except Exception:
        pass


async def check_thread_limit(account_id: str, skip: bool = False) -> ResourceReservation:
    if skip or config.ENV_MODE == EnvMode.LOCAL:
        return ResourceReservation(True, 0, 999, "skipped")
    
    start = time.time()
    key = _thread_count_key(account_id)
    
    try:
        tier = await get_tier_limits(account_id)
        thread_limit = tier['thread_limit']
        current = await redis.get(key)
        
        if current is None:
            asyncio.create_task(_warm_thread_cache(account_id, key))
            latency = (time.time() - start) * 1000
            logger.debug(f"[THREAD_LIMIT] Cache cold, allowing optimistically for {account_id} ({latency:.1f}ms)")
            return ResourceReservation(True, 0, thread_limit, "cache_cold_allow", latency_ms=latency)
        
        current = int(current)
        latency = (time.time() - start) * 1000
        
        if current < thread_limit:
            logger.debug(f"[THREAD_LIMIT] Allowed for {account_id}: {current}/{thread_limit} ({latency:.1f}ms)")
            return ResourceReservation(True, current, thread_limit, "ok", latency_ms=latency)
        
        logger.info(f"[THREAD_LIMIT] Rejected for {account_id}: {current}/{thread_limit}")
        return ResourceReservation(
            allowed=False,
            current_count=current,
            limit=thread_limit,
            message=f"Maximum of {thread_limit} threads allowed. You have {current} threads.",
            error_code="THREAD_LIMIT_EXCEEDED",
            latency_ms=latency
        )
        
    except asyncio.TimeoutError:
        logger.warning(f"[THREAD_LIMIT] Redis timeout for {account_id} - allowing")
        return ResourceReservation(True, 0, 999, "timeout_allow")
    except Exception as e:
        logger.warning(f"[THREAD_LIMIT] Error for {account_id}: {e} - allowing")
        return ResourceReservation(True, 0, 999, "error_allow")


async def _warm_thread_cache(account_id: str, key: str) -> None:
    try:
        from core.utils.limits_repo import count_user_threads
        count = await count_user_threads(account_id)
        await redis.set(key, str(count), ex=RESOURCE_COUNT_TTL)
        logger.debug(f"[THREAD_LIMIT] Warmed cache: {account_id}={count}")
    except Exception as e:
        logger.warning(f"[THREAD_LIMIT] Cache warm failed: {e}")


async def check_project_limit(account_id: str, skip: bool = False) -> ResourceReservation:
    if skip or config.ENV_MODE == EnvMode.LOCAL:
        return ResourceReservation(True, 0, 999, "skipped")
    
    start = time.time()
    key = _project_count_key(account_id)
    
    try:
        tier = await get_tier_limits(account_id)
        project_limit = tier['project_limit']
        current = await redis.get(key)
        
        if current is None:
            asyncio.create_task(_warm_project_cache(account_id, key))
            latency = (time.time() - start) * 1000
            logger.debug(f"[PROJECT_LIMIT] Cache cold, allowing optimistically for {account_id} ({latency:.1f}ms)")
            return ResourceReservation(True, 0, project_limit, "cache_cold_allow", latency_ms=latency)
        
        current = int(current)
        latency = (time.time() - start) * 1000
        
        if current < project_limit:
            logger.debug(f"[PROJECT_LIMIT] Allowed for {account_id}: {current}/{project_limit} ({latency:.1f}ms)")
            return ResourceReservation(True, current, project_limit, "ok", latency_ms=latency)
        
        logger.info(f"[PROJECT_LIMIT] Rejected for {account_id}: {current}/{project_limit}")
        return ResourceReservation(
            allowed=False,
            current_count=current,
            limit=project_limit,
            message=f"Maximum of {project_limit} projects allowed. You have {current} projects.",
            error_code="PROJECT_LIMIT_EXCEEDED",
            latency_ms=latency
        )
        
    except asyncio.TimeoutError:
        logger.warning(f"[PROJECT_LIMIT] Redis timeout for {account_id} - allowing")
        return ResourceReservation(True, 0, 999, "timeout_allow")
    except Exception as e:
        logger.warning(f"[PROJECT_LIMIT] Error for {account_id}: {e} - allowing")
        return ResourceReservation(True, 0, 999, "error_allow")


async def _warm_project_cache(account_id: str, key: str) -> None:
    try:
        from core.utils.limits_repo import count_user_projects
        count = await count_user_projects(account_id)
        await redis.set(key, str(count), ex=RESOURCE_COUNT_TTL)
        logger.debug(f"[PROJECT_LIMIT] Warmed cache: {account_id}={count}")
    except Exception as e:
        logger.warning(f"[PROJECT_LIMIT] Cache warm failed: {e}")


async def increment_thread_count(account_id: str) -> None:
    if config.ENV_MODE == EnvMode.LOCAL:
        return
    
    try:
        key = _thread_count_key(account_id)
        current = await redis.get(key)
        if current is not None:
            await redis.incr(key)
            logger.debug(f"[THREAD_LIMIT] Incremented count for {account_id}")
    except Exception as e:
        logger.warning(f"[THREAD_LIMIT] Failed to increment for {account_id}: {e}")


async def decrement_thread_count(account_id: str) -> None:
    if config.ENV_MODE == EnvMode.LOCAL:
        return
    
    try:
        key = _thread_count_key(account_id)
        current = await redis.get(key)
        if current is not None:
            count = await redis.decr(key)
            if count < 0:
                await redis.set(key, "0", ex=RESOURCE_COUNT_TTL)
            logger.debug(f"[THREAD_LIMIT] Decremented count for {account_id}")
    except Exception as e:
        logger.warning(f"[THREAD_LIMIT] Failed to decrement for {account_id}: {e}")


async def increment_project_count(account_id: str) -> None:
    if config.ENV_MODE == EnvMode.LOCAL:
        return
    
    try:
        key = _project_count_key(account_id)
        current = await redis.get(key)
        if current is not None:
            await redis.incr(key)
            logger.debug(f"[PROJECT_LIMIT] Incremented count for {account_id}")
    except Exception as e:
        logger.warning(f"[PROJECT_LIMIT] Failed to increment for {account_id}: {e}")


async def decrement_project_count(account_id: str) -> None:
    if config.ENV_MODE == EnvMode.LOCAL:
        return
    
    try:
        key = _project_count_key(account_id)
        current = await redis.get(key)
        if current is not None:
            count = await redis.decr(key)
            if count < 0:
                await redis.set(key, "0", ex=RESOURCE_COUNT_TTL)
            logger.debug(f"[PROJECT_LIMIT] Decremented count for {account_id}")
    except Exception as e:
        logger.warning(f"[PROJECT_LIMIT] Failed to decrement for {account_id}: {e}")


async def invalidate_thread_count(account_id: str) -> None:
    if config.ENV_MODE == EnvMode.LOCAL:
        return
    
    try:
        await redis.delete(_thread_count_key(account_id))
        logger.debug(f"[THREAD_LIMIT] Invalidated cache for {account_id}")
    except Exception as e:
        logger.warning(f"[THREAD_LIMIT] Failed to invalidate for {account_id}: {e}")


async def invalidate_project_count(account_id: str) -> None:
    if config.ENV_MODE == EnvMode.LOCAL:
        return
    
    try:
        await redis.delete(_project_count_key(account_id))
        logger.debug(f"[PROJECT_LIMIT] Invalidated cache for {account_id}")
    except Exception as e:
        logger.warning(f"[PROJECT_LIMIT] Failed to invalidate for {account_id}: {e}")


async def sync_thread_count_from_db(account_id: str) -> dict:
    if config.ENV_MODE == EnvMode.LOCAL:
        return {"synced": False}
    
    try:
        from core.utils.limits_repo import count_user_threads
        
        key = _thread_count_key(account_id)
        redis_val = await redis.get(key)
        redis_count = int(redis_val) if redis_val else 0
        
        db_count = await count_user_threads(account_id)
        
        if redis_count != db_count:
            await redis.set(key, str(db_count), ex=RESOURCE_COUNT_TTL)
            logger.warning(f"[THREAD_LIMIT] Synced {account_id}: Redis {redis_count} → DB {db_count}")
            return {"synced": True, "old": redis_count, "new": db_count}
        
        return {"synced": False, "count": db_count}
    except Exception as e:
        logger.error(f"[THREAD_LIMIT] Sync failed for {account_id}: {e}")
        return {"synced": False, "error": str(e)}


async def sync_project_count_from_db(account_id: str) -> dict:
    if config.ENV_MODE == EnvMode.LOCAL:
        return {"synced": False}
    
    try:
        from core.utils.limits_repo import count_user_projects
        
        key = _project_count_key(account_id)
        redis_val = await redis.get(key)
        redis_count = int(redis_val) if redis_val else 0
        
        db_count = await count_user_projects(account_id)
        
        if redis_count != db_count:
            await redis.set(key, str(db_count), ex=RESOURCE_COUNT_TTL)
            logger.warning(f"[PROJECT_LIMIT] Synced {account_id}: Redis {redis_count} → DB {db_count}")
            return {"synced": True, "old": redis_count, "new": db_count}
        
        return {"synced": False, "count": db_count}
    except Exception as e:
        logger.error(f"[PROJECT_LIMIT] Sync failed for {account_id}: {e}")
        return {"synced": False, "error": str(e)}


async def sync_slots_from_db(account_id: str) -> dict:
    if config.ENV_MODE == EnvMode.LOCAL:
        return {"synced": False}
    
    try:
        from core.utils.limits_repo import count_running_agent_runs
        
        key = _slot_key(account_id)
        
        redis_val = await redis.get(key)
        redis_count = int(redis_val) if redis_val else 0
        
        db_result = await count_running_agent_runs(account_id)
        db_count = db_result.get('running_count', 0)
        
        if redis_count != db_count:
            await redis.set(key, str(db_count), ex=SLOT_KEY_TTL)
            logger.warning(f"[SLOT] Synced {account_id}: Redis {redis_count} → DB {db_count}")
            return {"synced": True, "old": redis_count, "new": db_count}
        
        return {"synced": False, "count": db_count}
    except Exception as e:
        logger.error(f"[SLOT] Sync failed for {account_id}: {e}")
        return {"synced": False, "error": str(e)}


async def reconcile_all_active() -> dict:
    if config.ENV_MODE == EnvMode.LOCAL:
        return {"reconciled": 0}
    
    try:
        from core.services.db import execute
        
        sql = """
        SELECT DISTINCT t.account_id 
        FROM agent_runs ar
        JOIN threads t ON ar.thread_id = t.thread_id
        WHERE ar.status = 'running'
        """
        rows = await execute(sql, {})
        
        if not rows:
            return {"reconciled": 0}
        
        reconciled = 0
        for row in rows:
            result = await sync_slots_from_db(row['account_id'])
            if result.get('synced'):
                reconciled += 1
        
        logger.info(f"[SLOT] Reconciled {reconciled}/{len(rows)} accounts")
        return {"reconciled": reconciled, "total": len(rows)}
        
    except Exception as e:
        logger.error(f"[SLOT] Reconcile all failed: {e}")
        return {"reconciled": 0, "error": str(e)}


async def warm_all_caches(account_id: str, thread_count: int = None, project_count: int = None) -> None:
    if config.ENV_MODE == EnvMode.LOCAL:
        return
    
    try:
        if thread_count is not None:
            await redis.set(_thread_count_key(account_id), str(thread_count), ex=RESOURCE_COUNT_TTL)
        else:
            asyncio.create_task(_warm_thread_cache(account_id, _thread_count_key(account_id)))
        
        if project_count is not None:
            await redis.set(_project_count_key(account_id), str(project_count), ex=RESOURCE_COUNT_TTL)
        else:
            asyncio.create_task(_warm_project_cache(account_id, _project_count_key(account_id)))
        
        logger.debug(f"[CACHE] Warmed caches for {account_id}")
    except Exception as e:
        logger.warning(f"[CACHE] Failed to warm caches for {account_id}: {e}")
