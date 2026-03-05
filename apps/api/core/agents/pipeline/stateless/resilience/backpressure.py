import asyncio
import time
from dataclasses import dataclass
from enum import Enum
from typing import Dict, Any, Optional, Callable, Awaitable

from core.utils.logger import logger


class LoadLevel(str, Enum):
    NORMAL = "normal"
    ELEVATED = "elevated"
    HIGH = "high"
    CRITICAL = "critical"


@dataclass
class BackpressureThresholds:
    pending_writes_elevated: int = 50
    pending_writes_high: int = 80
    pending_writes_critical: int = 95
    active_runs_elevated: int = 300
    active_runs_high: int = 500
    active_runs_critical: int = 800
    flush_latency_elevated_ms: float = 500
    flush_latency_high_ms: float = 2000
    flush_latency_critical_ms: float = 5000
    memory_percent_elevated: float = 60.0
    memory_percent_high: float = 75.0
    memory_percent_critical: float = 90.0


@dataclass
class BackpressureState:
    level: LoadLevel
    pending_writes: int
    active_runs: int
    flush_latency_ms: float
    memory_percent: float
    should_accept_work: bool
    should_shed_load: bool
    recommended_batch_size: int
    recommended_flush_interval: float


class BackpressureController:
    def __init__(self, thresholds: Optional[BackpressureThresholds] = None):
        self.thresholds = thresholds or BackpressureThresholds()
        self._current_level = LoadLevel.NORMAL
        self._last_check = time.time()
        self._check_interval = 1.0
        self._lock = asyncio.Lock()
        self._level_change_callbacks: list = []
        self._pending_writes = 0
        self._active_runs = 0
        self._flush_latency_ms = 0.0
        self._memory_percent = 0.0

    @property
    def level(self) -> LoadLevel:
        return self._current_level

    def on_level_change(self, callback: Callable[[LoadLevel, LoadLevel], Awaitable[None]]) -> None:
        self._level_change_callbacks.append(callback)

    async def update_metrics(
        self,
        pending_writes: int,
        active_runs: int,
        flush_latency_ms: float,
        memory_percent: Optional[float] = None,
    ) -> BackpressureState:
        async with self._lock:
            self._pending_writes = pending_writes
            self._active_runs = active_runs
            self._flush_latency_ms = flush_latency_ms

            if memory_percent is not None:
                self._memory_percent = memory_percent
            else:
                self._memory_percent = await self._get_memory_percent()

            new_level = self._calculate_level()

            if new_level != self._current_level:
                old_level = self._current_level
                self._current_level = new_level
                logger.warning(f"[Backpressure] Level changed: {old_level.value} -> {new_level.value}")

                for callback in self._level_change_callbacks:
                    try:
                        await callback(old_level, new_level)
                    except Exception as e:
                        logger.warning(f"[Backpressure] Callback error: {e}")

            return self._get_state()

    def _calculate_level(self) -> LoadLevel:
        levels = []

        if self._pending_writes >= self.thresholds.pending_writes_critical:
            levels.append(LoadLevel.CRITICAL)
        elif self._pending_writes >= self.thresholds.pending_writes_high:
            levels.append(LoadLevel.HIGH)
        elif self._pending_writes >= self.thresholds.pending_writes_elevated:
            levels.append(LoadLevel.ELEVATED)

        if self._active_runs >= self.thresholds.active_runs_critical:
            levels.append(LoadLevel.CRITICAL)
        elif self._active_runs >= self.thresholds.active_runs_high:
            levels.append(LoadLevel.HIGH)
        elif self._active_runs >= self.thresholds.active_runs_elevated:
            levels.append(LoadLevel.ELEVATED)

        if self._flush_latency_ms >= self.thresholds.flush_latency_critical_ms:
            levels.append(LoadLevel.CRITICAL)
        elif self._flush_latency_ms >= self.thresholds.flush_latency_high_ms:
            levels.append(LoadLevel.HIGH)
        elif self._flush_latency_ms >= self.thresholds.flush_latency_elevated_ms:
            levels.append(LoadLevel.ELEVATED)

        if self._memory_percent >= self.thresholds.memory_percent_critical:
            levels.append(LoadLevel.CRITICAL)
        elif self._memory_percent >= self.thresholds.memory_percent_high:
            levels.append(LoadLevel.HIGH)
        elif self._memory_percent >= self.thresholds.memory_percent_elevated:
            levels.append(LoadLevel.ELEVATED)

        if not levels:
            return LoadLevel.NORMAL

        priority = {
            LoadLevel.CRITICAL: 4,
            LoadLevel.HIGH: 3,
            LoadLevel.ELEVATED: 2,
            LoadLevel.NORMAL: 1,
        }
        return max(levels, key=lambda l: priority[l])

    def _get_state(self) -> BackpressureState:
        level = self._current_level

        should_accept = level != LoadLevel.CRITICAL
        should_shed = level in (LoadLevel.HIGH, LoadLevel.CRITICAL)

        if level == LoadLevel.NORMAL:
            batch_size = 100
            flush_interval = 5.0
        elif level == LoadLevel.ELEVATED:
            batch_size = 75
            flush_interval = 3.0
        elif level == LoadLevel.HIGH:
            batch_size = 50
            flush_interval = 2.0
        else:
            batch_size = 25
            flush_interval = 1.0

        return BackpressureState(
            level=level,
            pending_writes=self._pending_writes,
            active_runs=self._active_runs,
            flush_latency_ms=self._flush_latency_ms,
            memory_percent=self._memory_percent,
            should_accept_work=should_accept,
            should_shed_load=should_shed,
            recommended_batch_size=batch_size,
            recommended_flush_interval=flush_interval,
        )

    async def _get_memory_percent(self) -> float:
        try:
            import psutil
            process = psutil.Process()
            return process.memory_percent()
        except Exception:
            return 0.0

    async def should_accept_work(self) -> bool:
        state = self._get_state()
        return state.should_accept_work

    async def get_recommended_batch_size(self) -> int:
        state = self._get_state()
        return state.recommended_batch_size

    async def get_recommended_flush_interval(self) -> float:
        state = self._get_state()
        return state.recommended_flush_interval

    def to_dict(self) -> Dict[str, Any]:
        state = self._get_state()
        return {
            "level": state.level.value,
            "pending_writes": state.pending_writes,
            "active_runs": state.active_runs,
            "flush_latency_ms": state.flush_latency_ms,
            "memory_percent": state.memory_percent,
            "should_accept_work": state.should_accept_work,
            "should_shed_load": state.should_shed_load,
            "recommended_batch_size": state.recommended_batch_size,
            "recommended_flush_interval": state.recommended_flush_interval,
        }


backpressure = BackpressureController()
