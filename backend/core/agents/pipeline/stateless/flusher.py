import asyncio
import heapq
from typing import Dict, Any, Optional, List, Tuple, TYPE_CHECKING

from core.utils.logger import logger
from core.agents.pipeline.stateless.config import config as stateless_config

if TYPE_CHECKING:
    from core.agents.pipeline.stateless.state import RunState


class WriteBuffer:
    FLUSH_INTERVAL = stateless_config.FLUSH_INTERVAL_SECONDS
    STALE_RUN_THRESHOLD_SECONDS = 7200
    CLEANUP_INTERVAL_SECONDS = 300
    MAX_CONCURRENT_FLUSHES = 50

    def __init__(self):
        self._runs: Dict[str, 'RunState'] = {}
        self._task: Optional[asyncio.Task] = None
        self._running: bool = False
        self._last_cleanup: float = 0
        self._flush_semaphore: Optional[asyncio.Semaphore] = None

    @property
    def run_count(self) -> int:
        return len(self._runs)

    @property
    def is_running(self) -> bool:
        return self._running

    def register(self, state: 'RunState') -> None:
        self._runs[state.run_id] = state

    def unregister(self, run_id: str) -> None:
        self._runs.pop(run_id, None)

    def get(self, run_id: str) -> Optional['RunState']:
        return self._runs.get(run_id)

    async def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._flush_semaphore = asyncio.Semaphore(self.MAX_CONCURRENT_FLUSHES)
        self._task = asyncio.create_task(self._loop())
        logger.info("[WriteBuffer] Started")

    async def stop(self) -> None:
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        await self.flush_all()
        logger.info("[WriteBuffer] Stopped")

    async def _loop(self) -> None:
        while self._running:
            try:
                await asyncio.sleep(self.FLUSH_INTERVAL)
                await self.flush_all()
                await self._cleanup_stale_runs()
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"[WriteBuffer] Loop error: {e}")

    async def flush_all(self) -> Dict[str, int]:
        if not self._flush_semaphore:
            self._flush_semaphore = asyncio.Semaphore(self.MAX_CONCURRENT_FLUSHES)
        
        results = {}
        
        if not self._runs:
            return results
        
        priority_queue: List[Tuple[int, str, 'RunState']] = [
            (-state.pending_write_count, run_id, state)
            for run_id, state in self._runs.items()
            if state.pending_write_count > 0
        ]
        heapq.heapify(priority_queue)
        
        if not priority_queue:
            return results
        
        async def bounded_flush(run_id: str, state: 'RunState') -> tuple:
            async with self._flush_semaphore:
                try:
                    count = await state.flush()
                    return run_id, count, None
                except Exception as e:
                    return run_id, 0, e
        
        tasks = [
            bounded_flush(run_id, state) 
            for _, run_id, state in priority_queue
        ]
        completed = await asyncio.gather(*tasks, return_exceptions=True)
        
        for item in completed:
            if isinstance(item, Exception):
                logger.error(f"[WriteBuffer] Flush task error: {item}")
                continue
            if isinstance(item, tuple) and len(item) == 3:
                run_id, count, error = item
                if error:
                    logger.error(f"[WriteBuffer] Flush {run_id} failed: {error}")
                elif count > 0:
                    results[run_id] = count
        
        return results

    async def flush_one(self, run_id: str) -> int:
        state = self._runs.get(run_id)
        return await state.flush() if state else 0

    async def _cleanup_stale_runs(self) -> int:
        import time
        now = time.time()

        if now - self._last_cleanup < self.CLEANUP_INTERVAL_SECONDS:
            return 0
        
        self._last_cleanup = now
        cleaned = 0
        
        for run_id, state in list(self._runs.items()):
            if now - state._start_time > self.STALE_RUN_THRESHOLD_SECONDS:
                logger.warning(f"[WriteBuffer] Cleaning stale run: {run_id} (age: {now - state._start_time:.0f}s)")
                try:
                    await state.flush()
                except Exception as e:
                    logger.error(f"[WriteBuffer] Failed to flush stale run {run_id}: {e}")
                self._runs.pop(run_id, None)
                cleaned += 1
        
        if cleaned > 0:
            logger.info(f"[WriteBuffer] Cleaned {cleaned} stale runs")
        
        return cleaned

    async def finalize(self, state: 'RunState') -> Dict[str, Any]:
        from core.agents import repo as agents_repo

        result = {"run_id": state.run_id, "flushed": 0, "updated": False}

        try:
            result["flushed"] = await state.flush()

            status = "completed" if state.termination_reason == "completed" else "failed"
            error = None if status == "completed" else state.termination_reason

            await agents_repo.update_agent_run_status(state.run_id, status, error)
            result["updated"] = True

            self.unregister(state.run_id)
        except Exception as e:
            logger.error(f"[WriteBuffer] Finalize {state.run_id} failed: {e}")
            result["error"] = str(e)

        return result

    def get_metrics(self) -> Dict[str, Any]:
        total_pending = sum(s.pending_write_count for s in self._runs.values())
        return {
            "runs": len(self._runs),
            "pending": total_pending,
            "running": self._running,
        }


write_buffer = WriteBuffer()
