import asyncio
from typing import Dict, Any, Optional, List, TYPE_CHECKING

from core.utils.logger import logger

if TYPE_CHECKING:
    from core.agents.pipeline.stateless.state import RunState


class WriteBuffer:
    FLUSH_INTERVAL = 5.0

    def __init__(self):
        self._runs: Dict[str, 'RunState'] = {}
        self._task: Optional[asyncio.Task] = None
        self._running: bool = False

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
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"[WriteBuffer] Loop error: {e}")

    async def flush_all(self) -> Dict[str, int]:
        results = {}
        for run_id, state in list(self._runs.items()):
            try:
                count = await state.flush()
                if count > 0:
                    results[run_id] = count
            except Exception as e:
                logger.error(f"[WriteBuffer] Flush {run_id} failed: {e}")
        return results

    async def flush_one(self, run_id: str) -> int:
        state = self._runs.get(run_id)
        return await state.flush() if state else 0

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
