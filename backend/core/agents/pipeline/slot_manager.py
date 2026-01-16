import asyncio
import time
from typing import Optional
from dataclasses import dataclass

from core.utils.logger import logger
from core.utils.config import config, EnvMode
from core.services import redis

SLOT_KEY_TTL = 7200
SLOT_OP_TIMEOUT = 2.0

@dataclass
class SlotReservation:
    acquired: bool
    slot_count: int
    limit: int
    message: str
    error_code: Optional[str] = None
    latency_ms: float = 0


def _slot_key(account_id: str) -> str:
    return f"slots:{account_id}"


async def _get_limit(account_id: str) -> int:
    try:
        from core.cache.runtime_cache import get_cached_tier_info
        tier_info = await get_cached_tier_info(account_id)
        if tier_info:
            return tier_info.get('concurrent_runs', 1)
    except Exception:
        pass
    return 1


async def reserve_slot(account_id: str, agent_run_id: str, skip: bool = False) -> SlotReservation:
    if skip or config.ENV_MODE == EnvMode.LOCAL:
        return SlotReservation(True, 0, 999, "skipped")
    
    start = time.time()
    key = _slot_key(account_id)
    
    try:
        limit = await _get_limit(account_id)
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
            result = await sync_from_db(row['account_id'])
            if result.get('synced'):
                reconciled += 1
        
        logger.info(f"[SLOT] Reconciled {reconciled}/{len(rows)} accounts")
        return {"reconciled": reconciled, "total": len(rows)}
        
    except Exception as e:
        logger.error(f"[SLOT] Reconcile all failed: {e}")
        return {"reconciled": 0, "error": str(e)}
