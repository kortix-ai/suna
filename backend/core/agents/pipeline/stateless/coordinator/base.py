import asyncio
from typing import Optional, AsyncGenerator, Dict, Any
from abc import ABC, abstractmethod

from core.agents.pipeline.context import PipelineContext
from core.agents.pipeline.stateless.state import RunState

class BaseCoordinator(ABC):
    def __init__(self):
        self._state: Optional[RunState] = None
        self._thread_manager = None
        self._tool_registry = None
        self._flush_task: Optional[asyncio.Task] = None
        self._heartbeat_task: Optional[asyncio.Task] = None
        self._thread_run_id: str = ""
        self._sequence: int = 0

    @abstractmethod
    async def execute(
        self, ctx: PipelineContext, max_steps: int = 25
    ) -> AsyncGenerator[Dict[str, Any], None]:
        raise NotImplementedError

    @abstractmethod
    async def _init_managers(self, ctx: PipelineContext) -> None:
        raise NotImplementedError

    @abstractmethod
    async def _cleanup(self, ctx: PipelineContext) -> None:
        raise NotImplementedError

    def _increment_sequence(self) -> int:
        seq = self._sequence
        self._sequence += 1
        return seq

    def _reset_sequence(self) -> None:
        self._sequence = 0
