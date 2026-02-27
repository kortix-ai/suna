import asyncio
import weakref
from typing import Dict, Set, Optional
from dataclasses import dataclass, field
from datetime import datetime, timezone

from core.utils.logger import logger


@dataclass
class TaskInfo:
    task: asyncio.Task
    name: str
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    critical: bool = False


class TaskRegistry:
    _instance: Optional['TaskRegistry'] = None
    _lock: asyncio.Lock = None
    
    def __init__(self):
        self._runs: Dict[str, Dict[str, TaskInfo]] = {}
        self._lock = asyncio.Lock()
    
    @classmethod
    def get_instance(cls) -> 'TaskRegistry':
        if cls._instance is None:
            cls._instance = TaskRegistry()
        return cls._instance
    
    async def register(
        self,
        run_id: str,
        task: asyncio.Task,
        name: str,
        critical: bool = False
    ) -> None:
        async with self._lock:
            if run_id not in self._runs:
                self._runs[run_id] = {}
            
            task_id = f"{name}_{id(task)}"
            self._runs[run_id][task_id] = TaskInfo(
                task=task,
                name=name,
                critical=critical
            )
            
            task.add_done_callback(
                lambda t, rid=run_id, tid=task_id: asyncio.create_task(
                    self._on_task_done(rid, tid)
                )
            )
    
    async def _on_task_done(self, run_id: str, task_id: str) -> None:
        async with self._lock:
            if run_id in self._runs and task_id in self._runs[run_id]:
                del self._runs[run_id][task_id]
                if not self._runs[run_id]:
                    del self._runs[run_id]
    
    async def cancel_all(self, run_id: str, reason: str = "cleanup") -> int:
        async with self._lock:
            if run_id not in self._runs:
                return 0
            
            tasks_to_cancel = list(self._runs[run_id].values())
        
        cancelled_count = 0
        for task_info in tasks_to_cancel:
            if not task_info.task.done():
                task_info.task.cancel()
                cancelled_count += 1
                try:
                    await asyncio.wait_for(
                        asyncio.shield(task_info.task),
                        timeout=5.0
                    )
                except asyncio.TimeoutError:
                    logger.warning(
                        f"Task {task_info.name} did not complete within timeout during {reason}"
                    )
                except asyncio.CancelledError:
                    pass
                except Exception as e:
                    logger.warning(f"Error cancelling task {task_info.name}: {e}")
        
        async with self._lock:
            self._runs.pop(run_id, None)
        
        if cancelled_count > 0:
            logger.debug(f"Cancelled {cancelled_count} tasks for run {run_id} ({reason})")
        
        return cancelled_count
    
    async def get_active_count(self, run_id: str) -> int:
        async with self._lock:
            if run_id not in self._runs:
                return 0
            return sum(
                1 for info in self._runs[run_id].values()
                if not info.task.done()
            )
    
    async def cleanup_stale(self, max_age_seconds: int = 3600) -> int:
        now = datetime.now(timezone.utc)
        stale_runs = []
        
        async with self._lock:
            for run_id, tasks in self._runs.items():
                if tasks:
                    oldest = min(info.created_at for info in tasks.values())
                    age = (now - oldest).total_seconds()
                    if age > max_age_seconds:
                        stale_runs.append(run_id)
        
        cleaned = 0
        for run_id in stale_runs:
            cleaned += await self.cancel_all(run_id, reason="stale cleanup")
        
        return cleaned


task_registry = TaskRegistry.get_instance()
