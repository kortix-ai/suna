"""
Task Registry - Tracks all spawned tasks to prevent memory/CPU leaks.

Every asyncio.Task created during pipeline execution is registered here.
On cleanup, all tasks are properly cancelled and awaited.
"""

import asyncio
import weakref
from typing import Dict, Set, Optional
from dataclasses import dataclass, field
from datetime import datetime, timezone

from core.utils.logger import logger


@dataclass
class TaskInfo:
    """Metadata about a tracked task."""
    task: asyncio.Task
    name: str
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    critical: bool = False  # If True, failure stops the pipeline


class TaskRegistry:
    """
    Thread-safe registry for tracking asyncio tasks per agent run.
    
    Ensures no task leaks by:
    1. Tracking all spawned tasks
    2. Cancelling all on cleanup
    3. Awaiting cancellation to ensure proper cleanup
    """
    
    _instance: Optional['TaskRegistry'] = None
    _lock: asyncio.Lock = None
    
    def __init__(self):
        self._runs: Dict[str, Dict[str, TaskInfo]] = {}
        self._lock = asyncio.Lock()
    
    @classmethod
    def get_instance(cls) -> 'TaskRegistry':
        """Get singleton instance."""
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
        """Register a task for tracking."""
        async with self._lock:
            if run_id not in self._runs:
                self._runs[run_id] = {}
            
            task_id = f"{name}_{id(task)}"
            self._runs[run_id][task_id] = TaskInfo(
                task=task,
                name=name,
                critical=critical
            )
            
            # Auto-remove when task completes
            task.add_done_callback(
                lambda t, rid=run_id, tid=task_id: asyncio.create_task(
                    self._on_task_done(rid, tid)
                )
            )
    
    async def _on_task_done(self, run_id: str, task_id: str) -> None:
        """Remove completed task from registry."""
        async with self._lock:
            if run_id in self._runs and task_id in self._runs[run_id]:
                del self._runs[run_id][task_id]
                if not self._runs[run_id]:
                    del self._runs[run_id]
    
    async def cancel_all(self, run_id: str, reason: str = "cleanup") -> int:
        """
        Cancel all tasks for a run and await their completion.
        Returns number of tasks cancelled.
        """
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
                    pass  # Expected
                except Exception as e:
                    logger.warning(f"Error cancelling task {task_info.name}: {e}")
        
        # Clean up registry
        async with self._lock:
            self._runs.pop(run_id, None)
        
        if cancelled_count > 0:
            logger.debug(f"Cancelled {cancelled_count} tasks for run {run_id} ({reason})")
        
        return cancelled_count
    
    async def get_active_count(self, run_id: str) -> int:
        """Get count of active tasks for a run."""
        async with self._lock:
            if run_id not in self._runs:
                return 0
            return sum(
                1 for info in self._runs[run_id].values()
                if not info.task.done()
            )
    
    async def cleanup_stale(self, max_age_seconds: int = 3600) -> int:
        """Clean up tasks from runs older than max_age_seconds."""
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


# Global instance
task_registry = TaskRegistry.get_instance()
