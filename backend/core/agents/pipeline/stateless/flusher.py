import asyncio
import heapq
import time
from typing import Dict, Any, Optional, List, Tuple, TYPE_CHECKING

from core.utils.logger import logger
from core.agents.pipeline.stateless.config import config as stateless_config

if TYPE_CHECKING:
    from core.agents.pipeline.stateless.state import RunState


class WriteBuffer:
    FLUSH_INTERVAL = stateless_config.FLUSH_INTERVAL_SECONDS
    STALE_RUN_THRESHOLD_SECONDS = stateless_config.STALE_RUN_AGE_SECONDS
    CLEANUP_INTERVAL_SECONDS = stateless_config.CLEANUP_INTERVAL_SECONDS
    MAX_CONCURRENT_FLUSHES = 50
    MAX_BUFFERED_RUNS = stateless_config.MAX_BUFFERED_RUNS
    MEMORY_PRESSURE_THRESHOLD = stateless_config.MEMORY_PRESSURE_THRESHOLD_RUNS

    def __init__(self):
        self._runs: Dict[str, 'RunState'] = {}
        self._task: Optional[asyncio.Task] = None
        self._running: bool = False
        self._last_cleanup: float = 0
        self._flush_semaphore: Optional[asyncio.Semaphore] = None
        self._eviction_count: int = 0
        self._eviction_tasks: set = set()

    @property
    def run_count(self) -> int:
        return len(self._runs)

    @property
    def is_running(self) -> bool:
        return self._running

    def register(self, state: 'RunState') -> None:
        if len(self._runs) >= self.MAX_BUFFERED_RUNS:
            task = asyncio.create_task(self._evict_oldest_run())
            self._eviction_tasks.add(task)
            task.add_done_callback(lambda t: self._eviction_tasks.discard(t))
        self._runs[state.run_id] = state

    def unregister(self, run_id: str) -> None:
        self._runs.pop(run_id, None)

    async def _evict_oldest_run(self) -> None:
        if not self._runs:
            return

        oldest_run_id = None
        oldest_time = float('inf')

        for run_id, state in self._runs.items():
            if state._start_time < oldest_time:
                oldest_time = state._start_time
                oldest_run_id = run_id

        if oldest_run_id:
            state = self._runs.get(oldest_run_id)
            if state:
                logger.warning(f"[WriteBuffer] Evicting oldest run due to memory pressure: {oldest_run_id}")
                try:
                    await state.flush()
                    await state.cleanup()
                except Exception as e:
                    logger.error(f"[WriteBuffer] Eviction flush failed for {oldest_run_id}: {e}")
                self._runs.pop(oldest_run_id, None)
                self._eviction_count += 1

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

        for task in list(self._eviction_tasks):
            if not task.done():
                task.cancel()
        self._eviction_tasks.clear()

        await self.flush_all()
        logger.info("[WriteBuffer] Stopped")

    async def _loop(self) -> None:
        from core.agents.pipeline.stateless.metrics import metrics

        cleanup_counter = 0
        while self._running:
            try:
                await asyncio.sleep(self.FLUSH_INTERVAL)
                await self.flush_all()

                metrics.update_buffered_runs(len(self._runs), self.MAX_BUFFERED_RUNS)

                cleanup_counter += 1
                if cleanup_counter >= (self.CLEANUP_INTERVAL_SECONDS / self.FLUSH_INTERVAL):
                    cleanup_counter = 0
                    cleaned = await self._cleanup_stale_runs()
                    if cleaned > 0:
                        metrics.record_stale_cleanup(cleaned)

                if len(self._runs) > self.MEMORY_PRESSURE_THRESHOLD:
                    evicted = await self._handle_memory_pressure()
                    for _ in range(evicted):
                        metrics.record_eviction()
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
        now = time.time()
        self._last_cleanup = now
        cleaned = 0

        for run_id, state in list(self._runs.items()):
            age = now - state._start_time
            inactive_time = now - state._last_activity

            is_terminated = not state.is_active
            is_old_and_inactive = age > self.STALE_RUN_THRESHOLD_SECONDS and inactive_time > 120
            is_very_old = age > 1800
            is_long_inactive = inactive_time > 300 and is_terminated

            should_clean = (is_old_and_inactive and is_terminated) or is_very_old or is_long_inactive

            if should_clean:
                reason = "very_old" if is_very_old else ("terminated" if is_terminated else "stale_inactive")
                logger.warning(f"[WriteBuffer] Cleaning {reason} run: {run_id} (age: {age:.0f}s, inactive: {inactive_time:.0f}s, active: {state.is_active})")
                try:
                    await state.flush()
                    await state.cleanup()
                except Exception as e:
                    logger.error(f"[WriteBuffer] Failed to cleanup run {run_id}: {e}")
                self._runs.pop(run_id, None)
                cleaned += 1

        if cleaned > 0:
            logger.info(f"[WriteBuffer] Cleaned {cleaned} runs, remaining: {len(self._runs)}")

        return cleaned

    async def _handle_memory_pressure(self) -> int:
        now = time.time()

        terminated_runs = []
        active_runs = []

        for run_id, state in self._runs.items():
            age = now - state._start_time
            inactive_time = now - state._last_activity
            if not state.is_active:
                terminated_runs.append((run_id, state, age, inactive_time))
            else:
                active_runs.append((run_id, state, age, inactive_time))

        terminated_runs.sort(key=lambda x: x[2], reverse=True)
        active_runs.sort(key=lambda x: x[3], reverse=True)

        to_evict = len(self._runs) - self.MEMORY_PRESSURE_THRESHOLD + 50
        evicted = 0

        for run_id, state, age, inactive_time in terminated_runs:
            if evicted >= to_evict:
                break
            logger.warning(f"[WriteBuffer] Memory pressure eviction (terminated): {run_id} (age: {age:.0f}s)")
            try:
                await state.flush()
                await state.cleanup()
            except Exception as e:
                logger.error(f"[WriteBuffer] Eviction cleanup failed for {run_id}: {e}")
            self._runs.pop(run_id, None)
            evicted += 1
            self._eviction_count += 1

        if evicted < to_evict:
            for run_id, state, age, inactive_time in active_runs:
                if evicted >= to_evict:
                    break
                if inactive_time > 300 or age > 1800:
                    logger.warning(f"[WriteBuffer] Memory pressure eviction (inactive active): {run_id} (age: {age:.0f}s, inactive: {inactive_time:.0f}s)")
                    try:
                        await state.flush()
                        await state.cleanup()
                    except Exception as e:
                        logger.error(f"[WriteBuffer] Eviction cleanup failed for {run_id}: {e}")
                    self._runs.pop(run_id, None)
                    evicted += 1
                    self._eviction_count += 1

        if evicted > 0:
            logger.warning(f"[WriteBuffer] Memory pressure: evicted {evicted} runs, remaining: {len(self._runs)}")

        return evicted

    async def finalize(self, state: 'RunState') -> Dict[str, Any]:
        from core.agents.runner import update_agent_run_status

        result = {"run_id": state.run_id, "flushed": 0, "updated": False}

        try:
            result["flushed"] = await state.flush()

            status = "completed" if state.termination_reason == "completed" else "failed"
            error = None if status == "completed" else state.termination_reason

            await update_agent_run_status(
                state.run_id,
                status,
                error=error,
                account_id=state.account_id,
            )
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
            "evictions": self._eviction_count,
            "max_runs": self.MAX_BUFFERED_RUNS,
            "pressure_threshold": self.MEMORY_PRESSURE_THRESHOLD,
        }


write_buffer = WriteBuffer()
