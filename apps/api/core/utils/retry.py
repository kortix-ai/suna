"""
Retry utilities with exponential backoff and connection management.

CONVEX MIGRATION STATUS: FULLY MIGRATED
=======================================
This module provides generic retry utilities that work with any backend:
- Generic retry() function - works with any async operation
- retry_db_operation() - kept for backward compatibility, uses generic retry

Key differences from Supabase version:
- No connection pool management needed (Convex uses stateless HTTP)
- Simplified error handling for HTTP-based operations

For all operations, use the generic retry() function.
"""
import asyncio
import random
from typing import TypeVar, Callable, Awaitable, Optional, Tuple, Type
import httpx

from core.utils.logger import logger
from core.services.convex_client import ConvexError

T = TypeVar("T")

DEFAULT_MAX_RETRIES = 5
DEFAULT_INITIAL_DELAY = 0.5
DEFAULT_MAX_DELAY = 10.0
DEFAULT_JITTER_FACTOR = 0.3

# Common retryable exceptions for HTTP operations
RETRYABLE_EXCEPTIONS: Tuple[Type[Exception], ...] = (
    httpx.ConnectTimeout,
    httpx.ReadTimeout,
    httpx.PoolTimeout,
    httpx.ConnectError,
    httpx.NetworkError,
    ConnectionError,
    TimeoutError,
    ConvexError,
)


def _add_jitter(delay: float, jitter_factor: float = DEFAULT_JITTER_FACTOR) -> float:
    """Add random jitter to delay to prevent thundering herd."""
    jitter = delay * jitter_factor * random.random()
    return delay + jitter


async def retry(
    fn: Callable[[], Awaitable[T]],
    max_attempts: int = 3,
    delay_seconds: int = 1,
    backoff_factor: float = 2.0,
    max_delay: Optional[float] = None,
    retryable_exceptions: Optional[Tuple[Type[Exception], ...]] = None,
) -> T:
    """
    Retry an async function with exponential backoff.

    Args:
        fn: The async function to retry
        max_attempts: Maximum number of attempts
        delay_seconds: Initial delay between attempts in seconds
        backoff_factor: Multiplier for exponential backoff (default: 2.0)
        max_delay: Maximum delay between retries (None = no limit)
        retryable_exceptions: Tuple of exception types to retry on (None = retry on all exceptions)

    Returns:
        The result of the function call

    Raises:
        The last exception if all attempts fail, or immediately for non-retryable exceptions

    Example:
    ```python
    async def fetch_data():
        # Some operation that might fail
        return await api_call()

    try:
        result = await retry(fetch_data, max_attempts=3, delay_seconds=2)
        print(f"Success: {result}")
    except Exception as e:
        print(f"Failed after all retries: {e}")
    ```
    """
    if max_attempts <= 0:
        raise ValueError("max_attempts must be greater than zero")

    last_error: Optional[Exception] = None
    retryable = retryable_exceptions if retryable_exceptions is not None else (Exception,)

    for attempt in range(1, max_attempts + 1):
        try:
            return await fn()
        except retryable as error:
            last_error = error

            if attempt == max_attempts:
                break

            # Calculate delay with exponential backoff
            delay = delay_seconds * (backoff_factor ** (attempt - 1))
            if max_delay is not None:
                delay = min(delay, max_delay)

            logger.debug(
                f"Retry attempt {attempt}/{max_attempts} failed: {type(error).__name__}. "
                f"Retrying in {delay:.1f}s..."
            )
            await asyncio.sleep(delay)
        except Exception as error:
            # Non-retryable exception - raise immediately
            logger.debug(f"Non-retryable error: {type(error).__name__}: {str(error)}")
            raise

    if last_error:
        raise last_error

    raise RuntimeError("Unexpected: last_error is None")


async def retry_db_operation(
    operation: Callable[[], Awaitable[T]],
    operation_name: Optional[str] = None,
    max_retries: Optional[int] = None,
    initial_delay: Optional[float] = None,
    max_delay: Optional[float] = None,
    backoff_factor: float = 2.0,
    reset_connection_on_error: bool = True,  # Kept for API compatibility, no-op
    reset_on_pool_timeout: bool = True,  # Kept for API compatibility, no-op
) -> T:
    """
    Retry an operation with exponential backoff and jitter.

    This is a simplified version for Convex/HTTP operations.
    Connection reset parameters are kept for backward compatibility but are no-ops
    since Convex uses stateless HTTP connections.

    Args:
        operation: The async operation to retry
        operation_name: Name for logging purposes (optional)
        max_retries: Maximum retry attempts (default: DEFAULT_MAX_RETRIES=5)
        initial_delay: Initial delay in seconds (default: DEFAULT_INITIAL_DELAY=0.5)
        max_delay: Maximum delay between retries (default: DEFAULT_MAX_DELAY=10.0)
        backoff_factor: Multiplier for exponential backoff (default: 2.0)
        reset_connection_on_error: No-op, kept for backward compatibility
        reset_on_pool_timeout: No-op, kept for backward compatibility

    Returns:
        The result of the operation

    Raises:
        The last exception if all retries are exhausted
    """
    if max_retries is None:
        max_retries = DEFAULT_MAX_RETRIES
    if initial_delay is None:
        initial_delay = DEFAULT_INITIAL_DELAY
    if max_delay is None:
        max_delay = DEFAULT_MAX_DELAY

    last_exception: Optional[Exception] = None
    op_name = operation_name or "Operation"

    for attempt in range(max_retries):
        try:
            return await operation()
        except RETRYABLE_EXCEPTIONS as e:
            last_exception = e

            if attempt < max_retries - 1:
                base_delay = min(initial_delay * (backoff_factor ** attempt), max_delay)
                delay = _add_jitter(base_delay)

                # Add extra delay for timeout errors
                if isinstance(e, (httpx.PoolTimeout, httpx.ConnectTimeout)):
                    delay = min(delay * 1.5, max_delay)

                logger.warning(
                    f"{op_name} failed (attempt {attempt + 1}/{max_retries}): {type(e).__name__}. "
                    f"Retrying in {delay:.2f}s..."
                )
                await asyncio.sleep(delay)
            else:
                logger.error(
                    f"{op_name} failed after {max_retries} attempts: {type(e).__name__}"
                )
        except Exception as e:
            logger.error(f"{op_name} failed with non-retryable error: {type(e).__name__}: {str(e)}")
            raise

    if last_exception:
        raise last_exception

    raise RuntimeError("Unexpected: retry loop completed without exception")


# Alias for Convex-specific retry
retry_convex_operation = retry_db_operation
