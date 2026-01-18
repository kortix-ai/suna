import asyncio
from typing import Optional

from core.utils.logger import logger


class BackgroundTaskManager:
    def __init__(self, state, ownership):
        self._state = state
        self._ownership = ownership
        self._flush_task: Optional[asyncio.Task] = None
        self._heartbeat_task: Optional[asyncio.Task] = None

    def start(self):
        self._flush_task = asyncio.create_task(self._flush_loop())
        self._heartbeat_task = asyncio.create_task(self._heartbeat_loop())

    async def stop(self):
        cleanup_errors = []
        
        if self._flush_task:
            self._flush_task.cancel()
            try:
                await asyncio.wait_for(self._flush_task, timeout=2.0)
            except (asyncio.CancelledError, asyncio.TimeoutError):
                pass
            except Exception as e:
                cleanup_errors.append(f"flush_task: {e}")
            self._flush_task = None

        if self._heartbeat_task:
            self._heartbeat_task.cancel()
            try:
                await asyncio.wait_for(self._heartbeat_task, timeout=2.0)
            except (asyncio.CancelledError, asyncio.TimeoutError):
                pass
            except Exception as e:
                cleanup_errors.append(f"heartbeat_task: {e}")
            self._heartbeat_task = None

        return cleanup_errors

    async def _flush_loop(self):
        while True:
            try:
                await asyncio.sleep(5)
                if self._state:
                    await self._state.flush()
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.warning(f"[BackgroundTasks] Flush error: {e}")

    async def _heartbeat_loop(self):
        while True:
            try:
                await asyncio.sleep(10)
                if self._state:
                    await self._ownership._heartbeat(self._state.run_id)
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.warning(f"[BackgroundTasks] Heartbeat error: {e}")
