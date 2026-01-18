import asyncio
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Dict, Any, Optional
from collections import deque

from core.utils.logger import logger


class RateLimiter(ABC):
    @abstractmethod
    async def acquire(self, tokens: int = 1) -> bool:
        pass

    @abstractmethod
    async def try_acquire(self, tokens: int = 1) -> bool:
        pass

    @abstractmethod
    def get_stats(self) -> Dict[str, Any]:
        pass


@dataclass
class TokenBucketConfig:
    rate: float
    capacity: int
    initial_tokens: Optional[int] = None


class TokenBucket(RateLimiter):
    def __init__(self, rate: float, capacity: int, initial_tokens: Optional[int] = None):
        self.rate = rate
        self.capacity = capacity
        self._tokens = initial_tokens if initial_tokens is not None else capacity
        self._last_refill = time.time()
        self._lock = asyncio.Lock()
        self._total_acquired = 0
        self._total_rejected = 0

    async def acquire(self, tokens: int = 1) -> bool:
        while True:
            if await self.try_acquire(tokens):
                return True
            wait_time = tokens / self.rate
            await asyncio.sleep(min(wait_time, 1.0))

    async def try_acquire(self, tokens: int = 1) -> bool:
        async with self._lock:
            self._refill()

            if self._tokens >= tokens:
                self._tokens -= tokens
                self._total_acquired += tokens
                return True

            self._total_rejected += tokens
            return False

    def _refill(self) -> None:
        now = time.time()
        elapsed = now - self._last_refill
        new_tokens = elapsed * self.rate
        self._tokens = min(self.capacity, self._tokens + new_tokens)
        self._last_refill = now

    def get_stats(self) -> Dict[str, Any]:
        return {
            "type": "token_bucket",
            "rate": self.rate,
            "capacity": self.capacity,
            "current_tokens": self._tokens,
            "total_acquired": self._total_acquired,
            "total_rejected": self._total_rejected,
        }


class SlidingWindow(RateLimiter):
    def __init__(self, max_requests: int, window_seconds: float):
        self.max_requests = max_requests
        self.window_seconds = window_seconds
        self._requests: deque = deque()
        self._lock = asyncio.Lock()
        self._total_acquired = 0
        self._total_rejected = 0

    async def acquire(self, tokens: int = 1) -> bool:
        while True:
            if await self.try_acquire(tokens):
                return True
            await asyncio.sleep(0.1)

    async def try_acquire(self, tokens: int = 1) -> bool:
        async with self._lock:
            now = time.time()
            cutoff = now - self.window_seconds

            while self._requests and self._requests[0] < cutoff:
                self._requests.popleft()

            if len(self._requests) + tokens <= self.max_requests:
                for _ in range(tokens):
                    self._requests.append(now)
                self._total_acquired += tokens
                return True

            self._total_rejected += tokens
            return False

    def get_stats(self) -> Dict[str, Any]:
        return {
            "type": "sliding_window",
            "max_requests": self.max_requests,
            "window_seconds": self.window_seconds,
            "current_count": len(self._requests),
            "total_acquired": self._total_acquired,
            "total_rejected": self._total_rejected,
        }


class AdaptiveRateLimiter(RateLimiter):
    def __init__(
        self,
        initial_rate: float,
        min_rate: float,
        max_rate: float,
        capacity: int,
        adjustment_factor: float = 0.1,
    ):
        self.min_rate = min_rate
        self.max_rate = max_rate
        self.adjustment_factor = adjustment_factor
        self._bucket = TokenBucket(initial_rate, capacity)
        self._success_count = 0
        self._failure_count = 0
        self._last_adjustment = time.time()
        self._adjustment_interval = 10.0
        self._lock = asyncio.Lock()

    async def acquire(self, tokens: int = 1) -> bool:
        return await self._bucket.acquire(tokens)

    async def try_acquire(self, tokens: int = 1) -> bool:
        return await self._bucket.try_acquire(tokens)

    async def record_success(self) -> None:
        async with self._lock:
            self._success_count += 1
            await self._maybe_adjust()

    async def record_failure(self) -> None:
        async with self._lock:
            self._failure_count += 1
            await self._maybe_adjust()

    async def _maybe_adjust(self) -> None:
        now = time.time()
        if now - self._last_adjustment < self._adjustment_interval:
            return

        total = self._success_count + self._failure_count
        if total < 10:
            return

        success_rate = self._success_count / total

        if success_rate > 0.95:
            new_rate = min(self.max_rate, self._bucket.rate * (1 + self.adjustment_factor))
        elif success_rate < 0.8:
            new_rate = max(self.min_rate, self._bucket.rate * (1 - self.adjustment_factor))
        else:
            new_rate = self._bucket.rate

        if new_rate != self._bucket.rate:
            logger.info(f"[AdaptiveRateLimiter] Adjusting rate: {self._bucket.rate:.2f} -> {new_rate:.2f}")
            self._bucket.rate = new_rate

        self._success_count = 0
        self._failure_count = 0
        self._last_adjustment = now

    def get_stats(self) -> Dict[str, Any]:
        base_stats = self._bucket.get_stats()
        base_stats.update({
            "type": "adaptive",
            "min_rate": self.min_rate,
            "max_rate": self.max_rate,
            "current_rate": self._bucket.rate,
        })
        return base_stats


class RateLimiterRegistry:
    def __init__(self):
        self._limiters: Dict[str, RateLimiter] = {}
        self._lock = asyncio.Lock()

    async def get_or_create(
        self,
        name: str,
        limiter_type: str = "token_bucket",
        **kwargs,
    ) -> RateLimiter:
        async with self._lock:
            if name not in self._limiters:
                if limiter_type == "token_bucket":
                    self._limiters[name] = TokenBucket(**kwargs)
                elif limiter_type == "sliding_window":
                    self._limiters[name] = SlidingWindow(**kwargs)
                elif limiter_type == "adaptive":
                    self._limiters[name] = AdaptiveRateLimiter(**kwargs)
                else:
                    raise ValueError(f"Unknown limiter type: {limiter_type}")
            return self._limiters[name]

    def get(self, name: str) -> Optional[RateLimiter]:
        return self._limiters.get(name)

    def to_dict(self) -> Dict[str, Any]:
        return {
            name: limiter.get_stats()
            for name, limiter in self._limiters.items()
        }


rate_limiter_registry = RateLimiterRegistry()


run_limiter = TokenBucket(rate=100.0, capacity=200)
flush_limiter = TokenBucket(rate=50.0, capacity=100)
api_limiter = SlidingWindow(max_requests=1000, window_seconds=60.0)
