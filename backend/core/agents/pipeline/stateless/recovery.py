import asyncio
import os
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

    def __init__(self, shard_id: Optional[int] = None, total_shards: Optional[int] = None):
        self._task: Optional[asyncio.Task] = None
        self._running: bool = False
        self._callbacks: List[Callable[[str], Awaitable[None]]] = []
        self._shard_id = shard_id
        self._total_shards = total_shards
        self._init_sharding()

    def _init_sharding(self) -> None:
        if self._shard_id is None:
            shard_env = os.getenv("RECOVERY_SHARD_ID")
            if shard_env:
                self._shard_id = int(shard_env)

        if self._total_shards is None:
            total_env = os.getenv("RECOVERY_TOTAL_SHARDS")
            if total_env:
                self._total_shards = int(total_env)

    @property
    def is_running(self) -> bool:
        return self._running

    @property
    def is_sharded(self) -> bool:
        return self._shard_id is not None and self._total_shards is not None

    def on_recovery(self, callback: Callable[[str], Awaitable[None]]) -> None:
        self._callbacks.append(callback)

    async def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._task = asyncio.create_task(self._loop())
        shard_info = f" (shard {self._shard_id}/{self._total_shards})" if self.is_sharded else ""
        logger.info(f"[Recovery] Sweep started{shard_info}")

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
            if self.is_sharded:
                orphans = await ownership.find_orphans_sharded(self._shard_id, self._total_shards)
            else:
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

                if self.is_sharded and hash(run_id) % self._total_shards != self._shard_id:
                    continue

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

            from core.agents.pipeline.stateless.metrics import metrics
            metrics.record_run_recovered()

            return RecoveryResult(run_id, True, "recover", "Recovered")
        except Exception as e:
            return RecoveryResult(run_id, False, "recover", "Failed", str(e))

    async def force_complete(self, run_id: str, reason: str = "admin") -> RecoveryResult:
        try:
            from core.agents.pipeline.stateless.ownership import ownership
            from core.agents.pipeline.stateless.flusher import write_buffer
            from core.services import redis
            from core.agents.runner.services import update_agent_run_status
            from core.agents import repo as agents_repo

            await write_buffer.flush_one(run_id)
            await redis.set(f"run:{run_id}:status", "completed", ex=3600)
            await ownership.release(run_id, "completed")

            agent_run = await agents_repo.get_agent_run_with_thread(run_id)
            if agent_run:
                account_id = agent_run.get("thread_account_id")
                await update_agent_run_status(
                    agent_run_id=run_id,
                    status="completed",
                    account_id=account_id
                )
                logger.info(f"[Recovery] Updated database status for {run_id} to completed")

            return RecoveryResult(run_id, True, "force_complete", f"Completed: {reason}")
        except Exception as e:
            return RecoveryResult(run_id, False, "force_complete", "Failed", str(e))

    async def force_fail(self, run_id: str, error: str = "Admin terminated") -> RecoveryResult:
        try:
            from core.agents.pipeline.stateless.ownership import ownership
            from core.agents.pipeline.stateless.flusher import write_buffer
            from core.services import redis
            from core.agents.runner.services import update_agent_run_status
            from core.agents import repo as agents_repo
            import json

            await write_buffer.flush_one(run_id)

            stream = f"agent_run:{run_id}:stream"
            await redis.xadd(stream, {"data": json.dumps({"type": "error", "error": error})})

            await redis.set(f"run:{run_id}:status", "failed", ex=3600)
            await redis.set(f"run:{run_id}:error", error, ex=3600)
            await ownership.release(run_id, "failed")

            agent_run = await agents_repo.get_agent_run_with_thread(run_id)
            if agent_run:
                account_id = agent_run.get("thread_account_id")
                await update_agent_run_status(
                    agent_run_id=run_id,
                    status="failed",
                    error=error,
                    account_id=account_id
                )
                logger.info(f"[Recovery] Updated database status for {run_id} to failed")

            return RecoveryResult(run_id, True, "force_fail", f"Failed: {error}")
        except Exception as e:
            return RecoveryResult(run_id, False, "force_fail", "Failed", str(e))

    async def force_resume(self, run_id: str) -> RecoveryResult:
        try:
            from core.agents.pipeline.stateless.ownership import ownership
            from core.services import redis
            from core.agents import repo as agents_repo
            from core.agents.runner.services import update_agent_run_status
            from core.agents.api import start_agent_run
            import asyncio

            agent_run = await agents_repo.get_agent_run_with_thread(run_id)
            if not agent_run:
                return RecoveryResult(run_id, False, "force_resume", "Agent run not found")

            thread_id = agent_run.get("thread_id")
            account_id = agent_run.get("thread_account_id")
            agent_id = agent_run.get("agent_id")

            if not thread_id or not account_id:
                return RecoveryResult(run_id, False, "force_resume", "Missing thread or account info")

            await redis.delete(f"run:{run_id}:owner")
            await redis.srem("runs:active", run_id)
            await ownership.release(run_id, "resumed")

            await update_agent_run_status(
                agent_run_id=run_id,
                status="stopped",
                error="Stopped for resume",
                account_id=account_id
            )

            try:
                result = await start_agent_run(
                    account_id=account_id,
                    prompt="Continue from where you left off.",
                    agent_id=agent_id,
                    thread_id=thread_id,
                    skip_limits_check=True
                )
                new_run_id = result.get("agent_run_id")
                logger.info(f"[Recovery] Started new run {new_run_id} to resume {run_id}")
                return RecoveryResult(
                    run_id, 
                    True, 
                    "force_resume", 
                    f"Resumed with new run {new_run_id}"
                )
            except Exception as e:
                logger.error(f"[Recovery] Failed to start new run for resume: {e}")
                return RecoveryResult(run_id, False, "force_resume", f"Failed to start new run: {e}")

        except Exception as e:
            return RecoveryResult(run_id, False, "force_resume", "Failed", str(e))

    async def get_stuck(self, min_age_minutes: int = 5) -> List[Dict[str, Any]]:
        import time
        from core.agents.pipeline.stateless.ownership import ownership
        from core.services import redis

        result = []
        try:
            active = await redis.smembers("runs:active")
            run_ids = [
                r.decode() if isinstance(r, bytes) else r
                for r in active
            ]

            if self.is_sharded:
                run_ids = [r for r in run_ids if hash(r) % self._total_shards == self._shard_id]

            infos = await ownership.get_info_batch(run_ids)

            for run_id, info in infos.items():
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
            if self.is_sharded:
                orphans = await ownership.find_orphans_sharded(self._shard_id, self._total_shards)
            else:
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
        return {
            "running": self._running,
            "callbacks": len(self._callbacks),
            "sharded": self.is_sharded,
            "shard_id": self._shard_id,
            "total_shards": self._total_shards,
        }


recovery = RunRecovery()
