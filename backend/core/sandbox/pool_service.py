import asyncio
import time
import uuid
from datetime import datetime, timezone
from typing import Optional, Dict, Any, Tuple
from dataclasses import dataclass, field

from core.utils.logger import logger
from core.sandbox.pool_config import get_pool_config, SandboxPoolConfig
from core.sandbox.sandbox import create_sandbox, delete_sandbox
from core.sandbox import pool_repo

@dataclass
class PoolStats:
    pool_size: int = 0
    total_created: int = 0
    total_claimed: int = 0
    total_expired: int = 0
    claim_times_ms: list = field(default_factory=list)
    last_replenish_at: Optional[str] = None
    last_cleanup_at: Optional[str] = None
    
    @property
    def avg_claim_time_ms(self) -> float:
        if not self.claim_times_ms:
            return 0.0
        recent = self.claim_times_ms[-100:]
        return sum(recent) / len(recent)
    
    @property
    def pool_hit_rate(self) -> float:
        total = self.total_claimed + self.total_created
        if total == 0:
            return 0.0
        return (self.total_claimed / total) * 100
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "pool_size": self.pool_size,
            "total_created": self.total_created,
            "total_claimed": self.total_claimed,
            "total_expired": self.total_expired,
            "avg_claim_time_ms": round(self.avg_claim_time_ms, 2),
            "pool_hit_rate": round(self.pool_hit_rate, 2),
            "last_replenish_at": self.last_replenish_at,
            "last_cleanup_at": self.last_cleanup_at,
        }


class SandboxPoolService:
    def __init__(self, config: Optional[SandboxPoolConfig] = None):
        self.config = config or get_pool_config()
        self.stats = PoolStats()
        self._running = False
        self._lock = asyncio.Lock()
    
    async def get_pool_size(self) -> int:
        try:
            count = await pool_repo.get_pool_size()
            self.stats.pool_size = count
            return count
        except Exception as e:
            logger.error(f"[SANDBOX_POOL] Failed to get pool size: {e}")
            return 0
    
    async def create_pooled_sandbox(self) -> Optional[str]:
        try:
            sandbox_pass = str(uuid.uuid4())
            
            logger.info("[SANDBOX_POOL] Creating new sandbox for pool...")
            sandbox = await create_sandbox(sandbox_pass, project_id=None)
            sandbox_id = sandbox.id
            
            try:
                vnc_link = await sandbox.get_preview_link(6080)
                website_link = await sandbox.get_preview_link(8080)
                vnc_url = vnc_link.url if hasattr(vnc_link, 'url') else str(vnc_link).split("url='")[1].split("'")[0]
                website_url = website_link.url if hasattr(website_link, 'url') else str(website_link).split("url='")[1].split("'")[0]
                token = None
                if hasattr(vnc_link, 'token'):
                    token = vnc_link.token
                elif "token='" in str(vnc_link):
                    token = str(vnc_link).split("token='")[1].split("'")[0]
            except Exception:
                logger.warning(f"[SANDBOX_POOL] Failed to get preview links for {sandbox_id}")
                vnc_url = None
                website_url = None
                token = None
            
            sandbox_config = {
                'pass': sandbox_pass,
                'vnc_preview': vnc_url,
                'sandbox_url': website_url,
                'token': token
            }
            
            result = await pool_repo.create_pooled_sandbox(sandbox_id, sandbox_config)
            
            if not result:
                logger.error(f"[SANDBOX_POOL] Failed to store pooled sandbox {sandbox_id}")
                try:
                    await delete_sandbox(sandbox_id)
                except Exception:
                    pass
                return None
            
            logger.info(f"[SANDBOX_POOL] Created pooled sandbox: {sandbox_id}")
            self.stats.total_created += 1
            return sandbox_id
            
        except Exception as e:
            logger.error(f"[SANDBOX_POOL] Failed to create pooled sandbox: {e}")
            return None
    
    async def claim_sandbox(
        self,
        account_id: str,
        project_id: str
    ) -> Optional[Tuple[str, Dict[str, Any]]]:
        start_time = time.time()
        
        try:
            claimed = await pool_repo.claim_pooled_sandbox(account_id, project_id)
            
            if not claimed:
                logger.debug("[SANDBOX_POOL] Pool is empty, no sandbox to claim")
                return None
            
            sandbox_id = claimed['external_id']
            config = claimed.get('config', {})
            
            try:
                from core.cache.runtime_cache import set_cached_project_metadata
                await set_cached_project_metadata(project_id, {
                    'id': sandbox_id,
                    'pass': config.get('pass'),
                    'vnc_preview': config.get('vnc_preview'),
                    'sandbox_url': config.get('sandbox_url'),
                    'token': config.get('token'),
                })
            except Exception as cache_err:
                logger.warning(f"[SANDBOX_POOL] Failed to update cache: {cache_err}")
            
            claim_time_ms = (time.time() - start_time) * 1000
            self.stats.claim_times_ms.append(claim_time_ms)
            self.stats.total_claimed += 1
            
            logger.info(f"[SANDBOX_POOL] Claimed sandbox {sandbox_id} for project {project_id} in {claim_time_ms:.1f}ms")
            return sandbox_id, config
            
        except Exception as e:
            logger.error(f"[SANDBOX_POOL] Failed to claim sandbox: {e}")
            return None
    
    async def ensure_pool_size(self) -> int:
        async with self._lock:
            current_size = await self.get_pool_size()
            
            if current_size >= self.config.replenish_below:
                logger.debug(f"[SANDBOX_POOL] Pool size {current_size} >= threshold {self.config.replenish_below}, no replenishment needed")
                return 0
            
            target = self.config.min_size
            to_create = min(
                target - current_size,
                self.config.max_size - current_size,
                self.config.parallel_create_limit
            )
            
            if to_create <= 0:
                return 0
            
            logger.info(f"[SANDBOX_POOL] Replenishing pool: {current_size} -> {current_size + to_create} (target: {target})")
            
            tasks = [self.create_pooled_sandbox() for _ in range(to_create)]
            results = await asyncio.gather(*tasks, return_exceptions=True)
            
            created = sum(1 for r in results if r is not None and not isinstance(r, Exception))
            self.stats.last_replenish_at = datetime.now(timezone.utc).isoformat()
            
            logger.info(f"[SANDBOX_POOL] Created {created}/{to_create} sandboxes")
            return created
    
    async def cleanup_stale_sandboxes(self) -> int:
        try:
            stale = await pool_repo.get_stale_pooled_sandboxes(self.config.max_age)
            
            if not stale:
                return 0
            
            cleaned = 0
            for resource in stale:
                try:
                    sandbox_id = resource['external_id']
                    resource_id = resource['id']
                    
                    try:
                        await delete_sandbox(sandbox_id)
                    except Exception as e:
                        logger.warning(f"[SANDBOX_POOL] Failed to delete sandbox {sandbox_id}: {e}")
                    
                    await pool_repo.mark_sandbox_deleted(resource_id)
                    
                    cleaned += 1
                    self.stats.total_expired += 1
                    logger.debug(f"[SANDBOX_POOL] Cleaned up stale sandbox: {sandbox_id}")
                    
                except Exception as e:
                    logger.error(f"[SANDBOX_POOL] Failed to cleanup sandbox: {e}")
            
            if cleaned > 0:
                self.stats.last_cleanup_at = datetime.now(timezone.utc).isoformat()
                logger.info(f"[SANDBOX_POOL] Cleaned up {cleaned} stale sandboxes")
            
            return cleaned
            
        except Exception as e:
            logger.error(f"[SANDBOX_POOL] Cleanup failed: {e}")
            return 0
    
    def get_stats(self) -> Dict[str, Any]:
        return self.stats.to_dict()


_pool_service: Optional[SandboxPoolService] = None


def get_pool_service() -> SandboxPoolService:
    global _pool_service
    if _pool_service is None:
        _pool_service = SandboxPoolService()
    return _pool_service


async def claim_sandbox_from_pool(
    account_id: str,
    project_id: str
) -> Optional[Tuple[str, Dict[str, Any]]]:
    service = get_pool_service()
    return await service.claim_sandbox(account_id, project_id)
