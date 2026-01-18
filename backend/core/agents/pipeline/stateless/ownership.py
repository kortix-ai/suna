import asyncio
import os
import time
import uuid
from typing import Dict, Any, List, Optional

from core.utils.logger import logger
from core.agents.pipeline.stateless.config import config as stateless_config

class RunOwnership:
    HEARTBEAT_INTERVAL = stateless_config.HEARTBEAT_INTERVAL_SECONDS
    HEARTBEAT_TTL = stateless_config.HEARTBEAT_TTL_SECONDS
    CLAIM_TTL = stateless_config.CLAIM_TTL_SECONDS
    ORPHAN_THRESHOLD = stateless_config.ORPHAN_THRESHOLD_SECONDS

    def __init__(self, worker_id: Optional[str] = None):
        self.worker_id = worker_id or os.getenv("WORKER_ID", str(uuid.uuid4())[:8])
        self._owned: Dict[str, float] = {}
        self._heartbeat_task: Optional[asyncio.Task] = None
        self._running: bool = False

    @property
    def owned_count(self) -> int:
        return len(self._owned)

    @property
    def owned_runs(self) -> List[str]:
        return list(self._owned.keys())

    async def claim(self, run_id: str) -> bool:
        try:
            from core.services import redis

            claimed = await redis.set(
                f"run:{run_id}:owner",
                self.worker_id,
                nx=True,
                ex=self.CLAIM_TTL
            )

            if claimed:
                await redis.set(f"run:{run_id}:status", "running", ex=self.CLAIM_TTL)
                await redis.set(f"run:{run_id}:start", str(time.time()), ex=self.CLAIM_TTL)
                await redis.sadd("runs:active", run_id)
                await self._heartbeat(run_id)
                self._owned[run_id] = time.time()
                logger.info(f"[Ownership] Claimed {run_id}")
                return True

            current = await redis.get(f"run:{run_id}:owner")
            if current and current.decode() if isinstance(current, bytes) else current == self.worker_id:
                return True

            return False
        except Exception as e:
            logger.error(f"[Ownership] Claim {run_id} failed: {e}")
            return False

    async def release(self, run_id: str, status: str = "completed") -> bool:
        try:
            from core.services import redis

            await redis.set(f"run:{run_id}:status", status, ex=self.CLAIM_TTL)
            await redis.delete(f"run:{run_id}:owner")

            if status in ("completed", "failed", "cancelled"):
                await redis.srem("runs:active", run_id)

            self._owned.pop(run_id, None)
            logger.info(f"[Ownership] Released {run_id} as {status}")
            return True
        except Exception as e:
            logger.error(f"[Ownership] Release {run_id} failed: {e}")
            return False

    async def mark_resumable(self, run_id: str) -> bool:
        try:
            from core.services import redis

            await redis.set(f"run:{run_id}:status", "resumable", ex=self.CLAIM_TTL)
            await redis.delete(f"run:{run_id}:owner")
            self._owned.pop(run_id, None)
            return True
        except Exception as e:
            logger.error(f"[Ownership] Mark resumable {run_id} failed: {e}")
            return False

    async def _heartbeat(self, run_id: str) -> None:
        try:
            from core.services import redis
            await redis.set(f"run:{run_id}:heartbeat", str(time.time()), ex=self.HEARTBEAT_TTL)
        except Exception as e:
            logger.warning(f"[Ownership] Heartbeat {run_id} failed: {e}")

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
                for run_id in list(self._owned.keys()):
                    await self._heartbeat(run_id)
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"[Ownership] Heartbeat loop error: {e}")

    async def find_orphans(self) -> List[str]:
        try:
            from core.services import redis

            orphans = []
            active = await redis.smembers("runs:active")

            for run_id in active:
                run_id = run_id.decode() if isinstance(run_id, bytes) else run_id
                status = await redis.get(f"run:{run_id}:status")
                status = status.decode() if isinstance(status, bytes) else status

                if status not in ("running", "resumable"):
                    continue

                hb = await redis.get(f"run:{run_id}:heartbeat")
                if not hb:
                    orphans.append(run_id)
                else:
                    hb = hb.decode() if isinstance(hb, bytes) else hb
                    if time.time() - float(hb) > self.ORPHAN_THRESHOLD:
                        orphans.append(run_id)

            return orphans
        except Exception as e:
            logger.error(f"[Ownership] Find orphans failed: {e}")
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
        return {
            "worker_id": self.worker_id,
            "owned": len(self._owned),
            "running": self._running,
            "run_ids": list(self._owned.keys()),
        }


class IdempotencyTracker:
    def __init__(self, ttl: int = 3600):
        self.ttl = ttl

    async def check(self, run_id: str, step: int, operation: str) -> bool:
        try:
            from core.services import redis
            key = f"run:{run_id}:idem:{step}:{operation}"
            return bool(await redis.set(key, "1", nx=True, ex=self.ttl))
        except Exception:
            return True

    async def mark_step(self, run_id: str, step: int) -> None:
        try:
            from core.services import redis
            await redis.set(f"run:{run_id}:step:{step}", str(time.time()), ex=self.ttl)
        except Exception:
            pass

    async def get_last_step(self, run_id: str) -> int:
        try:
            from core.services import redis
            cursor, max_step = 0, 0

            while True:
                cursor, keys = await redis.scan(cursor, f"run:{run_id}:step:*", 100)
                for key in keys:
                    key = key.decode() if isinstance(key, bytes) else key
                    parts = key.split(":")
                    if len(parts) >= 4:
                        try:
                            max_step = max(max_step, int(parts[3]))
                        except ValueError:
                            pass
                if cursor == 0:
                    break

            return max_step
        except Exception:
            return 0


ownership = RunOwnership()
idempotency = IdempotencyTracker()
