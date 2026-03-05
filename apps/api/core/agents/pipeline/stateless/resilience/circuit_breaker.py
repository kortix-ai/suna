import asyncio
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Dict, Any, Optional, Callable, Awaitable, TypeVar, Tuple, Type

from core.utils.logger import logger

T = TypeVar("T")


class CircuitState(str, Enum):
    CLOSED = "closed"
    OPEN = "open"
    HALF_OPEN = "half_open"


class CircuitOpenError(Exception):
    def __init__(self, name: str, retry_after: float):
        self.name = name
        self.retry_after = retry_after
        super().__init__(f"Circuit '{name}' is open. Retry after {retry_after:.1f}s")


@dataclass
class CircuitStats:
    total_calls: int = 0
    successful_calls: int = 0
    failed_calls: int = 0
    rejected_calls: int = 0
    last_failure_time: Optional[float] = None
    last_success_time: Optional[float] = None
    consecutive_failures: int = 0
    consecutive_successes: int = 0


@dataclass
class CircuitConfig:
    failure_threshold: int = 5
    success_threshold: int = 3
    timeout_seconds: float = 30.0
    half_open_max_calls: int = 3
    excluded_exceptions: Tuple[Type[Exception], ...] = ()


class CircuitBreaker:
    def __init__(
        self,
        name: str,
        config: Optional[CircuitConfig] = None,
    ):
        self.name = name
        self.config = config or CircuitConfig()
        self._state = CircuitState.CLOSED
        self._stats = CircuitStats()
        self._opened_at: Optional[float] = None
        self._half_open_calls: int = 0
        self._lock = asyncio.Lock()

    @property
    def state(self) -> CircuitState:
        return self._state

    @property
    def stats(self) -> CircuitStats:
        return self._stats

    @property
    def is_closed(self) -> bool:
        return self._state == CircuitState.CLOSED

    @property
    def is_open(self) -> bool:
        return self._state == CircuitState.OPEN

    async def call(
        self,
        func: Callable[..., Awaitable[T]],
        *args,
        **kwargs,
    ) -> T:
        async with self._lock:
            await self._check_state_transition()

            if self._state == CircuitState.OPEN:
                self._stats.rejected_calls += 1
                retry_after = self._get_retry_after()
                raise CircuitOpenError(self.name, retry_after)

            if self._state == CircuitState.HALF_OPEN:
                if self._half_open_calls >= self.config.half_open_max_calls:
                    self._stats.rejected_calls += 1
                    raise CircuitOpenError(self.name, 1.0)
                self._half_open_calls += 1

        self._stats.total_calls += 1

        try:
            result = await func(*args, **kwargs)
            await self._on_success()
            return result
        except Exception as e:
            if isinstance(e, self.config.excluded_exceptions):
                raise
            await self._on_failure(e)
            raise

    async def _check_state_transition(self) -> None:
        if self._state == CircuitState.OPEN:
            if self._opened_at and time.time() - self._opened_at >= self.config.timeout_seconds:
                self._transition_to(CircuitState.HALF_OPEN)

    async def _on_success(self) -> None:
        async with self._lock:
            self._stats.successful_calls += 1
            self._stats.last_success_time = time.time()
            self._stats.consecutive_successes += 1
            self._stats.consecutive_failures = 0

            if self._state == CircuitState.HALF_OPEN:
                if self._stats.consecutive_successes >= self.config.success_threshold:
                    self._transition_to(CircuitState.CLOSED)

    async def _on_failure(self, error: Exception) -> None:
        async with self._lock:
            self._stats.failed_calls += 1
            self._stats.last_failure_time = time.time()
            self._stats.consecutive_failures += 1
            self._stats.consecutive_successes = 0

            if self._state == CircuitState.HALF_OPEN:
                self._transition_to(CircuitState.OPEN)
            elif self._state == CircuitState.CLOSED:
                if self._stats.consecutive_failures >= self.config.failure_threshold:
                    self._transition_to(CircuitState.OPEN)

    def _transition_to(self, new_state: CircuitState) -> None:
        old_state = self._state
        self._state = new_state

        if new_state == CircuitState.OPEN:
            self._opened_at = time.time()
            logger.warning(f"[CircuitBreaker] {self.name}: {old_state.value} -> OPEN")
        elif new_state == CircuitState.HALF_OPEN:
            self._half_open_calls = 0
            logger.info(f"[CircuitBreaker] {self.name}: {old_state.value} -> HALF_OPEN")
        elif new_state == CircuitState.CLOSED:
            self._opened_at = None
            self._stats.consecutive_failures = 0
            logger.info(f"[CircuitBreaker] {self.name}: {old_state.value} -> CLOSED")

    def _get_retry_after(self) -> float:
        if not self._opened_at:
            return self.config.timeout_seconds
        elapsed = time.time() - self._opened_at
        return max(0, self.config.timeout_seconds - elapsed)

    def reset(self) -> None:
        self._state = CircuitState.CLOSED
        self._opened_at = None
        self._half_open_calls = 0
        self._stats = CircuitStats()

    def to_dict(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "state": self._state.value,
            "stats": {
                "total_calls": self._stats.total_calls,
                "successful_calls": self._stats.successful_calls,
                "failed_calls": self._stats.failed_calls,
                "rejected_calls": self._stats.rejected_calls,
                "consecutive_failures": self._stats.consecutive_failures,
                "consecutive_successes": self._stats.consecutive_successes,
            },
            "opened_at": self._opened_at,
            "retry_after": self._get_retry_after() if self._state == CircuitState.OPEN else None,
        }


class CircuitBreakerRegistry:
    def __init__(self):
        self._breakers: Dict[str, CircuitBreaker] = {}
        self._lock = asyncio.Lock()

    async def get_or_create(
        self,
        name: str,
        config: Optional[CircuitConfig] = None,
    ) -> CircuitBreaker:
        async with self._lock:
            if name not in self._breakers:
                self._breakers[name] = CircuitBreaker(name, config)
            return self._breakers[name]

    def get(self, name: str) -> Optional[CircuitBreaker]:
        return self._breakers.get(name)

    def get_all(self) -> Dict[str, CircuitBreaker]:
        return self._breakers.copy()

    def reset_all(self) -> None:
        for breaker in self._breakers.values():
            breaker.reset()

    def to_dict(self) -> Dict[str, Any]:
        return {
            name: breaker.to_dict()
            for name, breaker in self._breakers.items()
        }


registry = CircuitBreakerRegistry()


db_breaker = CircuitBreaker(
    "database",
    CircuitConfig(
        failure_threshold=5,
        success_threshold=2,
        timeout_seconds=30.0,
    )
)

redis_breaker = CircuitBreaker(
    "redis",
    CircuitConfig(
        failure_threshold=3,
        success_threshold=2,
        timeout_seconds=15.0,
    )
)

external_api_breaker = CircuitBreaker(
    "external_api",
    CircuitConfig(
        failure_threshold=3,
        success_threshold=2,
        timeout_seconds=60.0,
    )
)
