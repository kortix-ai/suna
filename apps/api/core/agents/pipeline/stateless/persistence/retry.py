import asyncio
import random
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import TypeVar, Callable, Awaitable, Optional, Tuple, Type

T = TypeVar("T")


class RetryPolicy(ABC):
    @abstractmethod
    def get_delay(self, attempt: int) -> float:
        pass

    @abstractmethod
    def should_retry(self, attempt: int, error: Exception) -> bool:
        pass


@dataclass
class ExponentialBackoff(RetryPolicy):
    base_delay: float = 0.1
    max_delay: float = 30.0
    max_attempts: int = 3
    jitter: float = 0.1
    retryable_exceptions: Tuple[Type[Exception], ...] = (
        ConnectionError,
        TimeoutError,
        asyncio.TimeoutError,
        OSError,
    )

    def get_delay(self, attempt: int) -> float:
        delay = min(self.base_delay * (2 ** attempt), self.max_delay)
        jitter_amount = delay * self.jitter * random.random()
        return delay + jitter_amount

    def should_retry(self, attempt: int, error: Exception) -> bool:
        if attempt >= self.max_attempts:
            return False
        return isinstance(error, self.retryable_exceptions)


@dataclass
class FixedDelay(RetryPolicy):
    delay: float = 1.0
    max_attempts: int = 3
    retryable_exceptions: Tuple[Type[Exception], ...] = (
        ConnectionError,
        TimeoutError,
    )

    def get_delay(self, attempt: int) -> float:
        return self.delay

    def should_retry(self, attempt: int, error: Exception) -> bool:
        if attempt >= self.max_attempts:
            return False
        return isinstance(error, self.retryable_exceptions)


async def with_retry(
    func: Callable[..., Awaitable[T]],
    policy: RetryPolicy,
    *args,
    on_retry: Optional[Callable[[int, Exception], Awaitable[None]]] = None,
    **kwargs,
) -> T:
    attempt = 0
    last_error: Optional[Exception] = None

    while True:
        try:
            return await func(*args, **kwargs)
        except Exception as e:
            last_error = e
            attempt += 1

            if not policy.should_retry(attempt, e):
                raise

            if on_retry:
                await on_retry(attempt, e)

            delay = policy.get_delay(attempt)
            await asyncio.sleep(delay)

    raise last_error
