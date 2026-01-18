import asyncio
import heapq
import os
import time
import uuid
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Dict, Any, List, Optional, Tuple

from core.utils.logger import logger
from core.agents.pipeline.stateless.config import config as stateless_config


@dataclass
class HeartbeatState:
    last_success: float = field(default_factory=time.time)
    consecutive_failures: int = 0
    total_failures: int = 0
    last_failure_error: Optional[str] = None
    
    def record_success(self) -> None:
        self.last_success = time.time()
        self.consecutive_failures = 0
    
    def record_failure(self, error: str) -> None:
        self.consecutive_failures += 1
        self.total_failures += 1
        self.last_failure_error = error
    
    @property
    def seconds_since_success(self) -> float:
        return time.time() - self.last_success
    
    @property
    def is_healthy(self) -> bool:
        return self.consecutive_failures == 0


class RunOwnership:
    HEARTBEAT_INTERVAL = stateless_config.HEARTBEAT_INTERVAL_SECONDS
    HEARTBEAT_TTL = stateless_config.HEARTBEAT_TTL_SECONDS
    CLAIM_TTL = stateless_config.CLAIM_TTL_SECONDS
    ORPHAN_THRESHOLD = stateless_config.ORPHAN_THRESHOLD_SECONDS
    MAX_OWNED_RUNS = 100
    STALE_OWNED_THRESHOLD_SECONDS = 7200
    
    HEARTBEAT_GRACE_PERIOD_SECONDS = 60
    HEARTBEAT_CRITICAL_THRESHOLD_SECONDS = 75
    HEARTBEAT_MAX_CONSECUTIVE_FAILURES = 4

    def __init__(self, worker_id: Optional[str] = None):
        self.worker_id = worker_id or os.getenv("WORKER_ID", str(uuid.uuid4())[:8])
        self._owned: Dict[str, float] = {}
        self._owned_heap: List[Tuple[float, str]] = []
        self._heartbeat_task: Optional[asyncio.Task] = None
        self._running: bool = False
        
        self._heartbeat_states: Dict[str, HeartbeatState] = {}
        self._global_heartbeat_failures: int = 0
        self._last_successful_batch: float = time.time()

    @property
    def owned_count(self) -> int:
        return len(self._owned)

    @property
    def owned_runs(self) -> List[str]:
        return list(self._owned.keys())

    async def claim(self, run_id: str) -> bool:
        try:
            from core.services import redis

            client = await redis.get_client()
            pipeline = client.pipeline()
            
            pipeline.set(f"run:{run_id}:owner", self.worker_id, nx=True, ex=self.CLAIM_TTL)
            pipeline.set(f"run:{run_id}:status", "running", ex=self.CLAIM_TTL)
            pipeline.set(f"run:{run_id}:start", str(time.time()), ex=self.CLAIM_TTL)
            pipeline.set(f"run:{run_id}:heartbeat", str(time.time()), ex=self.HEARTBEAT_TTL)
            pipeline.sadd("runs:active", run_id)
            
            results = await pipeline.execute()
            claimed = results[0]

            if claimed:
                now = time.time()
                self._owned[run_id] = now
                heapq.heappush(self._owned_heap, (now, run_id))
                self._heartbeat_states[run_id] = HeartbeatState()
                logger.info(f"[Ownership] Claimed {run_id}")
                return True

            current = await redis.get(f"run:{run_id}:owner")
            if current:
                current = current.decode() if isinstance(current, bytes) else current
                if current == self.worker_id:
                    if run_id not in self._heartbeat_states:
                        self._heartbeat_states[run_id] = HeartbeatState()
                    return True

            return False
        except Exception as e:
            logger.error(f"[Ownership] Claim {run_id} failed: {e}")
            return False

    async def release(self, run_id: str, status: str = "completed") -> bool:
        try:
            from core.services import redis

            client = await redis.get_client()
            pipeline = client.pipeline()
            
            pipeline.set(f"run:{run_id}:status", status, ex=self.CLAIM_TTL)
            pipeline.delete(f"run:{run_id}:owner")
            if status in ("completed", "failed", "cancelled"):
                pipeline.srem("runs:active", run_id)
            
            await pipeline.execute()

            self._owned.pop(run_id, None)
            self._heartbeat_states.pop(run_id, None)
            logger.info(f"[Ownership] Released {run_id} as {status}")
            return True
        except Exception as e:
            logger.error(f"[Ownership] Release {run_id} failed: {e}")
            return False

    async def mark_resumable(self, run_id: str) -> bool:
        try:
            from core.services import redis

            client = await redis.get_client()
            pipeline = client.pipeline()
            
            pipeline.set(f"run:{run_id}:status", "resumable", ex=self.CLAIM_TTL)
            pipeline.delete(f"run:{run_id}:owner")
            
            await pipeline.execute()
            self._owned.pop(run_id, None)
            self._heartbeat_states.pop(run_id, None)
            return True
        except Exception as e:
            logger.error(f"[Ownership] Mark resumable {run_id} failed: {e}")
            return False

    async def _heartbeat(self, run_id: str) -> bool:
        try:
            from core.services import redis
            await redis.set(f"run:{run_id}:heartbeat", str(time.time()), ex=self.HEARTBEAT_TTL)
            
            if run_id in self._heartbeat_states:
                self._heartbeat_states[run_id].record_success()
            return True
        except Exception as e:
            if run_id in self._heartbeat_states:
                state = self._heartbeat_states[run_id]
                state.record_failure(str(e))
                self._log_heartbeat_failure(run_id, state, e)
            else:
                logger.warning(f"[Ownership] Heartbeat {run_id} failed: {e}")
            return False

    def _log_heartbeat_failure(self, run_id: str, state: HeartbeatState, error: Exception) -> None:
        seconds_since = state.seconds_since_success
        consecutive = state.consecutive_failures
        
        if seconds_since >= self.HEARTBEAT_CRITICAL_THRESHOLD_SECONDS:
            logger.error(
                f"[Ownership] CRITICAL: Heartbeat for {run_id} failing! "
                f"No success for {seconds_since:.0f}s (orphan threshold: {self.ORPHAN_THRESHOLD}s), "
                f"consecutive failures: {consecutive}. Error: {error}"
            )
        elif seconds_since >= self.HEARTBEAT_GRACE_PERIOD_SECONDS:
            logger.warning(
                f"[Ownership] Heartbeat {run_id} degraded: no success for {seconds_since:.0f}s, "
                f"consecutive failures: {consecutive}. Error: {error}"
            )
        elif consecutive >= self.HEARTBEAT_MAX_CONSECUTIVE_FAILURES:
            logger.warning(
                f"[Ownership] Heartbeat {run_id} unstable: {consecutive} consecutive failures. "
                f"Error: {error}"
            )
        else:
            logger.debug(f"[Ownership] Heartbeat {run_id} failed (attempt {consecutive}): {error}")

    async def _heartbeat_batch(self, run_ids: List[str]) -> int:
        if not run_ids:
            return 0

        success_count = 0
        error_msg: Optional[str] = None
        
        try:
            from core.services import redis

            client = await redis.get_client()
            pipeline = client.pipeline()

            now_str = str(time.time())
            for run_id in run_ids:
                pipeline.set(f"run:{run_id}:heartbeat", now_str, ex=self.HEARTBEAT_TTL)

            results = await pipeline.execute()
            success_count = sum(1 for r in results if r)
            
            if success_count == len(run_ids):
                self._last_successful_batch = time.time()
                self._global_heartbeat_failures = 0
                for run_id in run_ids:
                    if run_id in self._heartbeat_states:
                        self._heartbeat_states[run_id].record_success()
            else:
                for i, (run_id, result) in enumerate(zip(run_ids, results)):
                    if result and run_id in self._heartbeat_states:
                        self._heartbeat_states[run_id].record_success()
                    elif not result and run_id in self._heartbeat_states:
                        self._heartbeat_states[run_id].record_failure("Pipeline result was falsy")
                        
            return success_count
            
        except Exception as e:
            error_msg = str(e)
            self._global_heartbeat_failures += 1
            
            for run_id in run_ids:
                if run_id in self._heartbeat_states:
                    state = self._heartbeat_states[run_id]
                    state.record_failure(error_msg)
            
            self._log_batch_heartbeat_failure(run_ids, error_msg)
            return 0

    def _log_batch_heartbeat_failure(self, run_ids: List[str], error: str) -> None:
        worst_seconds = 0.0
        for run_id in run_ids:
            if run_id in self._heartbeat_states:
                seconds = self._heartbeat_states[run_id].seconds_since_success
                worst_seconds = max(worst_seconds, seconds)
        
        if worst_seconds >= self.HEARTBEAT_CRITICAL_THRESHOLD_SECONDS:
            logger.error(
                f"[Ownership] CRITICAL: Batch heartbeat failed for {len(run_ids)} runs! "
                f"Worst case: {worst_seconds:.0f}s since success (orphan threshold: {self.ORPHAN_THRESHOLD}s). "
                f"Global failures: {self._global_heartbeat_failures}. Error: {error}"
            )
        elif worst_seconds >= self.HEARTBEAT_GRACE_PERIOD_SECONDS:
            logger.warning(
                f"[Ownership] Batch heartbeat degraded for {len(run_ids)} runs. "
                f"Worst case: {worst_seconds:.0f}s since success. Error: {error}"
            )
        elif self._global_heartbeat_failures >= self.HEARTBEAT_MAX_CONSECUTIVE_FAILURES:
            logger.warning(
                f"[Ownership] Batch heartbeat unstable: {self._global_heartbeat_failures} consecutive batch failures. "
                f"Affecting {len(run_ids)} runs. Error: {error}"
            )
        else:
            logger.warning(f"[Ownership] Batch heartbeat failed: {error}")

    async def start_heartbeats(self) -> None:
        if self._running:
            return
        self._running = True
        self._heartbeat_task = asyncio.create_task(self._heartbeat_loop())
        logger.info(f"[Ownership] Heartbeats started for {self.worker_id}")

    async def stop_heartbeats(self) -> None:
        self._running = False
        if self._heartbeat_task:
            self._heartbeat_task.cancel()
            try:
                await self._heartbeat_task
            except asyncio.CancelledError:
                pass
            self._heartbeat_task = None

    async def _heartbeat_loop(self) -> None:
        while self._running:
            try:
                await asyncio.sleep(self.HEARTBEAT_INTERVAL)
                run_ids = list(self._owned.keys())
                if run_ids:
                    count = await self._heartbeat_batch(run_ids)
                    if count < len(run_ids):
                        logger.warning(f"[Ownership] Heartbeat partial: {count}/{len(run_ids)}")
                    
                    await self._check_critical_runs()
                
                await self._cleanup_stale_owned()
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"[Ownership] Heartbeat loop error: {e}")

    async def _check_critical_runs(self) -> None:
        critical_runs = []
        warning_runs = []
        healthy_runs = []
        worst_seconds = 0.0
        
        for run_id, state in self._heartbeat_states.items():
            if run_id not in self._owned:
                continue
                
            seconds_since = state.seconds_since_success
            worst_seconds = max(worst_seconds, seconds_since)
            
            if seconds_since >= self.HEARTBEAT_CRITICAL_THRESHOLD_SECONDS:
                critical_runs.append((run_id, seconds_since, state.consecutive_failures))
            elif seconds_since >= self.HEARTBEAT_GRACE_PERIOD_SECONDS:
                warning_runs.append((run_id, seconds_since, state.consecutive_failures))
            else:
                healthy_runs.append(run_id)
        
        try:
            from core.agents.pipeline.stateless.metrics import metrics
            metrics.update_heartbeat_health(
                healthy=len(healthy_runs),
                warning=len(warning_runs),
                critical=len(critical_runs),
                worst_age=worst_seconds,
            )
        except Exception:
            pass
        
        if critical_runs:
            run_info = ", ".join(f"{r[0]}({r[1]:.0f}s)" for r in critical_runs)
            logger.error(
                f"[Ownership] CRITICAL: {len(critical_runs)} runs at risk of orphan takeover: {run_info}. "
                f"Orphan threshold is {self.ORPHAN_THRESHOLD}s."
            )
        
        if warning_runs and not critical_runs:
            run_info = ", ".join(f"{r[0]}({r[1]:.0f}s)" for r in warning_runs[:5])
            if len(warning_runs) > 5:
                run_info += f" and {len(warning_runs) - 5} more"
            logger.warning(f"[Ownership] Heartbeat degraded for {len(warning_runs)} runs: {run_info}")

    async def _cleanup_stale_owned(self) -> int:
        now = time.time()
        threshold = now - self.STALE_OWNED_THRESHOLD_SECONDS
        cleaned = 0
        
        while self._owned_heap:
            oldest_time, run_id = self._owned_heap[0]
            
            if run_id not in self._owned:
                heapq.heappop(self._owned_heap)
                continue
            
            if self._owned[run_id] != oldest_time:
                heapq.heappop(self._owned_heap)
                continue
            
            if oldest_time > threshold:
                break
            
            heapq.heappop(self._owned_heap)
            logger.warning(f"[Ownership] Cleaning stale owned run: {run_id}")
            await self.mark_resumable(run_id)
            cleaned += 1
        
        return cleaned

    async def find_orphans(self) -> List[str]:
        try:
            from core.services import redis

            orphans = []
            active = await redis.smembers("runs:active")
            
            if not active:
                return []
            
            run_ids = [r.decode() if isinstance(r, bytes) else r for r in active]
            
            client = await redis.get_client()
            pipeline = client.pipeline()
            
            for run_id in run_ids:
                pipeline.get(f"run:{run_id}:status")
                pipeline.get(f"run:{run_id}:heartbeat")
            
            results = await pipeline.execute()
            now = time.time()
            
            for i, run_id in enumerate(run_ids):
                status = results[i * 2]
                hb = results[i * 2 + 1]
                
                if status:
                    status = status.decode() if isinstance(status, bytes) else status
                    if status not in ("running", "resumable"):
                        continue
                
                if not hb:
                    orphans.append(run_id)
                else:
                    hb = hb.decode() if isinstance(hb, bytes) else hb
                    if now - float(hb) > self.ORPHAN_THRESHOLD:
                        orphans.append(run_id)

            return orphans
        except Exception as e:
            logger.error(f"[Ownership] Find orphans failed: {e}")
            return []

    async def find_orphans_sharded(self, shard_id: int, total_shards: int) -> List[str]:
        try:
            from core.services import redis

            active = await redis.smembers("runs:active")
            
            if not active:
                return []
            
            run_ids = [
                r.decode() if isinstance(r, bytes) else r 
                for r in active
            ]
            run_ids = [r for r in run_ids if hash(r) % total_shards == shard_id]
            
            if not run_ids:
                return []
            
            client = await redis.get_client()
            pipeline = client.pipeline()
            
            for run_id in run_ids:
                pipeline.get(f"run:{run_id}:status")
                pipeline.get(f"run:{run_id}:heartbeat")
            
            results = await pipeline.execute()
            now = time.time()
            orphans = []
            
            for i, run_id in enumerate(run_ids):
                status = results[i * 2]
                hb = results[i * 2 + 1]
                
                if status:
                    status = status.decode() if isinstance(status, bytes) else status
                    if status not in ("running", "resumable"):
                        continue
                
                if not hb:
                    orphans.append(run_id)
                else:
                    hb = hb.decode() if isinstance(hb, bytes) else hb
                    if now - float(hb) > self.ORPHAN_THRESHOLD:
                        orphans.append(run_id)

            return orphans
        except Exception as e:
            logger.error(f"[Ownership] Find orphans sharded failed: {e}")
            return []

    async def get_info(self, run_id: str) -> Optional[Dict[str, Any]]:
        try:
            from core.services import redis

            def decode(v):
                return v.decode() if isinstance(v, bytes) else v

            owner = decode(await redis.get(f"run:{run_id}:owner"))
            status = decode(await redis.get(f"run:{run_id}:status"))
            hb = decode(await redis.get(f"run:{run_id}:heartbeat"))
            start = decode(await redis.get(f"run:{run_id}:start"))

            return {
                "run_id": run_id,
                "owner": owner,
                "status": status,
                "heartbeat": float(hb) if hb else None,
                "heartbeat_age": time.time() - float(hb) if hb else None,
                "start": float(start) if start else None,
                "duration": time.time() - float(start) if start else None,
            }
        except Exception as e:
            logger.error(f"[Ownership] Get info {run_id} failed: {e}")
            return None

    async def get_info_batch(self, run_ids: List[str]) -> Dict[str, Dict[str, Any]]:
        if not run_ids:
            return {}

        try:
            from core.services import redis

            client = await redis.get_client()
            pipeline = client.pipeline()

            for run_id in run_ids:
                pipeline.get(f"run:{run_id}:owner")
                pipeline.get(f"run:{run_id}:status")
                pipeline.get(f"run:{run_id}:heartbeat")
                pipeline.get(f"run:{run_id}:start")

            results = await pipeline.execute()

            infos = {}
            for i, run_id in enumerate(run_ids):
                base_idx = i * 4

                def decode(v):
                    return v.decode() if isinstance(v, bytes) else v

                owner = decode(results[base_idx])
                status = decode(results[base_idx + 1])
                hb = decode(results[base_idx + 2])
                start = decode(results[base_idx + 3])

                infos[run_id] = {
                    "run_id": run_id,
                    "owner": owner,
                    "status": status,
                    "heartbeat": float(hb) if hb else None,
                    "heartbeat_age": time.time() - float(hb) if hb else None,
                    "start": float(start) if start else None,
                    "duration": time.time() - float(start) if start else None,
                }

            return infos
        except Exception as e:
            logger.error(f"[Ownership] Get info batch failed: {e}")
            return {}

    async def graceful_shutdown(self) -> Dict[str, Any]:
        from core.agents.pipeline.stateless.flusher import write_buffer

        result = {"released": 0, "failed": 0}

        await self.stop_heartbeats()

        for run_id in list(self._owned.keys()):
            try:
                await write_buffer.flush_one(run_id)
                await self.mark_resumable(run_id)
                result["released"] += 1
            except Exception as e:
                logger.error(f"[Ownership] Shutdown {run_id} failed: {e}")
                result["failed"] += 1

        return result

    def get_metrics(self) -> Dict[str, Any]:
        healthy_count = 0
        warning_count = 0
        critical_count = 0
        worst_seconds_since_success = 0.0
        
        for run_id in self._owned:
            if run_id in self._heartbeat_states:
                state = self._heartbeat_states[run_id]
                seconds = state.seconds_since_success
                worst_seconds_since_success = max(worst_seconds_since_success, seconds)
                
                if seconds >= self.HEARTBEAT_CRITICAL_THRESHOLD_SECONDS:
                    critical_count += 1
                elif seconds >= self.HEARTBEAT_GRACE_PERIOD_SECONDS:
                    warning_count += 1
                else:
                    healthy_count += 1
        
        return {
            "worker_id": self.worker_id,
            "owned": len(self._owned),
            "running": self._running,
            "run_ids": list(self._owned.keys()),
            "heartbeat_health": {
                "healthy": healthy_count,
                "warning": warning_count,
                "critical": critical_count,
                "worst_seconds_since_success": round(worst_seconds_since_success, 1),
                "global_consecutive_failures": self._global_heartbeat_failures,
                "last_successful_batch_age": round(time.time() - self._last_successful_batch, 1),
            },
            "thresholds": {
                "grace_period_seconds": self.HEARTBEAT_GRACE_PERIOD_SECONDS,
                "critical_threshold_seconds": self.HEARTBEAT_CRITICAL_THRESHOLD_SECONDS,
                "orphan_threshold_seconds": self.ORPHAN_THRESHOLD,
            }
        }
    
    def get_heartbeat_state(self, run_id: str) -> Optional[Dict[str, Any]]:
        state = self._heartbeat_states.get(run_id)
        if not state:
            return None
        
        return {
            "run_id": run_id,
            "last_success": state.last_success,
            "seconds_since_success": round(state.seconds_since_success, 1),
            "consecutive_failures": state.consecutive_failures,
            "total_failures": state.total_failures,
            "last_failure_error": state.last_failure_error,
            "is_healthy": state.is_healthy,
            "status": (
                "critical" if state.seconds_since_success >= self.HEARTBEAT_CRITICAL_THRESHOLD_SECONDS
                else "warning" if state.seconds_since_success >= self.HEARTBEAT_GRACE_PERIOD_SECONDS
                else "healthy"
            ),
        }


class IdempotencyTracker:
    def __init__(self, ttl: int = 3600):
        self.ttl = ttl
        self._local_cache: OrderedDict[str, int] = OrderedDict()
        self._cache_max_size = 1000

    async def check(self, run_id: str, step: int, operation: str) -> bool:
        try:
            from core.services import redis
            key = f"run:{run_id}:idem:{step}:{operation}"
            return bool(await redis.set(key, "1", nx=True, ex=self.ttl))
        except Exception:
            return True

    async def mark_step(self, run_id: str, step: int) -> None:
        if run_id in self._local_cache:
            self._local_cache.move_to_end(run_id)
        self._local_cache[run_id] = step
        
        while len(self._local_cache) > self._cache_max_size:
            self._local_cache.popitem(last=False)
        
        try:
            from core.services import redis
            await redis.set(f"run:{run_id}:last_step", str(step), ex=self.ttl)
        except Exception:
            pass

    async def get_last_step(self, run_id: str) -> int:
        if run_id in self._local_cache:
            self._local_cache.move_to_end(run_id)
            return self._local_cache[run_id]
        
        try:
            from core.services import redis
            last_step = await redis.get(f"run:{run_id}:last_step")
            if last_step:
                last_step = last_step.decode() if isinstance(last_step, bytes) else last_step
                step = int(last_step)
                self._local_cache[run_id] = step
                return step
            return 0
        except Exception:
            return 0
    
    def remove(self, run_id: str) -> None:
        self._local_cache.pop(run_id, None)


ownership = RunOwnership()
idempotency = IdempotencyTracker()
