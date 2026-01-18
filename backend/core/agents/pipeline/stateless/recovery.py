import asyncio
from typing import Dict, Any, List, Optional, Callable, Awaitable
from dataclasses import dataclass

from core.utils.logger import logger
from core.agents.pipeline.stateless.config import config as stateless_config


@dataclass
class RecoveryResult:
    run_id: str
    success: bool
    action: str
    message: str
    error: Optional[str] = None


class RunRecovery:
    SWEEP_INTERVAL = stateless_config.RECOVERY_SWEEP_INTERVAL_SECONDS
    MAX_DURATION = stateless_config.STUCK_RUN_THRESHOLD_SECONDS
    STALE_THRESHOLD = stateless_config.ORPHAN_THRESHOLD_SECONDS

    def __init__(self):
        self._task: Optional[asyncio.Task] = None
        self._running: bool = False
        self._callbacks: List[Callable[[str], Awaitable[None]]] = []

    @property
    def is_running(self) -> bool:
        return self._running

    def on_recovery(self, callback: Callable[[str], Awaitable[None]]) -> None:
        self._callbacks.append(callback)

    async def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._task = asyncio.create_task(self._loop())
        logger.info("[Recovery] Sweep started")

    async def stop(self) -> None:
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

    async def _loop(self) -> None:
        while self._running:
            try:
                await asyncio.sleep(self.SWEEP_INTERVAL)
                await self.sweep()
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"[Recovery] Loop error: {e}")

    async def sweep(self) -> Dict[str, Any]:
        from core.agents.pipeline.stateless.ownership import ownership

        result = {"orphaned": 0, "recovered": 0, "stuck": 0, "completed": 0, "errors": []}

        try:
            orphans = await ownership.find_orphans()
            result["orphaned"] = len(orphans)

            for run_id in orphans:
                try:
                    if await ownership.claim(run_id):
                        r = await self.recover(run_id)
                        if r.success:
                            result["recovered"] += 1
                        else:
                            result["errors"].append(f"{run_id}: {r.error}")
                except Exception as e:
                    result["errors"].append(f"{run_id}: {e}")

            stuck = await self._find_stuck()
            result["stuck"] = len(stuck)

            for run_id in stuck:
                try:
                    await self.force_complete(run_id, "max_duration")
                    result["completed"] += 1
                except Exception as e:
                    result["errors"].append(f"{run_id}: {e}")

        except Exception as e:
            logger.error(f"[Recovery] Sweep failed: {e}")
            result["errors"].append(str(e))

        return result

    async def _find_stuck(self) -> List[str]:
        import time
        from core.services import redis

        stuck = []
        try:
            active = await redis.smembers("runs:active")
            for run_id in active:
                run_id = run_id.decode() if isinstance(run_id, bytes) else run_id
                start = await redis.get(f"run:{run_id}:start")
                if start:
                    start = start.decode() if isinstance(start, bytes) else start
                    if time.time() - float(start) > self.MAX_DURATION:
                        stuck.append(run_id)
        except Exception as e:
            logger.error(f"[Recovery] Find stuck failed: {e}")
        return stuck

    async def recover(self, run_id: str) -> RecoveryResult:
        try:
            for cb in self._callbacks:
                try:
                    await cb(run_id)
                except Exception as e:
                    logger.warning(f"[Recovery] Callback failed: {e}")

            return RecoveryResult(run_id, True, "recover", "Recovered")
        except Exception as e:
            return RecoveryResult(run_id, False, "recover", "Failed", str(e))

    async def force_complete(self, run_id: str, reason: str = "admin") -> RecoveryResult:
        try:
            from core.agents.pipeline.stateless.ownership import ownership
            from core.agents.pipeline.stateless.flusher import write_buffer
            from core.services import redis

            await write_buffer.flush_one(run_id)
            await redis.set(f"run:{run_id}:status", "completed", ex=3600)
            await ownership.release(run_id, "completed")

            return RecoveryResult(run_id, True, "force_complete", f"Completed: {reason}")
        except Exception as e:
            return RecoveryResult(run_id, False, "force_complete", "Failed", str(e))

    async def force_fail(self, run_id: str, error: str = "Admin terminated") -> RecoveryResult:
        try:
            from core.agents.pipeline.stateless.ownership import ownership
            from core.agents.pipeline.stateless.flusher import write_buffer
            from core.services import redis
            import json

            await write_buffer.flush_one(run_id)

            stream = f"agent_run:{run_id}:stream"
            await redis.xadd(stream, {"data": json.dumps({"type": "error", "error": error})})

            await redis.set(f"run:{run_id}:status", "failed", ex=3600)
            await redis.set(f"run:{run_id}:error", error, ex=3600)
            await ownership.release(run_id, "failed")

            return RecoveryResult(run_id, True, "force_fail", f"Failed: {error}")
        except Exception as e:
            return RecoveryResult(run_id, False, "force_fail", "Failed", str(e))

    async def force_resume(self, run_id: str) -> RecoveryResult:
        try:
            from core.agents.pipeline.stateless.ownership import ownership
            from core.services import redis

            await redis.delete(f"run:{run_id}:owner")
            await redis.set(f"run:{run_id}:status", "resumable", ex=3600)

            if await ownership.claim(run_id):
                return await self.recover(run_id)

            return RecoveryResult(run_id, True, "force_resume", "Marked resumable")
        except Exception as e:
            return RecoveryResult(run_id, False, "force_resume", "Failed", str(e))

    async def get_stuck(self, min_age_minutes: int = 5) -> List[Dict[str, Any]]:
        import time
        from core.agents.pipeline.stateless.ownership import ownership
        from core.services import redis

        result = []
        try:
            active = await redis.smembers("runs:active")
            for run_id in active:
                run_id = run_id.decode() if isinstance(run_id, bytes) else run_id
                info = await ownership.get_info(run_id)
                if not info:
                    continue

                stuck = False
                reason = None

                if info.get("heartbeat_age") and info["heartbeat_age"] > self.STALE_THRESHOLD:
                    stuck, reason = True, "stale_heartbeat"
                elif not info.get("heartbeat"):
                    stuck, reason = True, "no_heartbeat"
                elif info.get("duration") and info["duration"] > min_age_minutes * 60:
                    stuck, reason = True, "long_running"

                if stuck:
                    result.append({**info, "reason": reason})
        except Exception as e:
            logger.error(f"[Recovery] Get stuck failed: {e}")

        return result

    async def recover_on_startup(self) -> Dict[str, Any]:
        from core.agents.pipeline.stateless.ownership import ownership

        result = {"found": 0, "recovered": 0, "failed": 0}

        try:
            orphans = await ownership.find_orphans()
            result["found"] = len(orphans)

            for run_id in orphans:
                try:
                    if await ownership.claim(run_id):
                        r = await self.recover(run_id)
                        if r.success:
                            result["recovered"] += 1
                        else:
                            result["failed"] += 1
                except Exception:
                    result["failed"] += 1

            logger.info(f"[Recovery] Startup: {result}")
        except Exception as e:
            logger.error(f"[Recovery] Startup failed: {e}")

        return result

    def get_metrics(self) -> Dict[str, Any]:
        return {"running": self._running, "callbacks": len(self._callbacks)}


recovery = RunRecovery()
