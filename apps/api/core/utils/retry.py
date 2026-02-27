import asyncio
import os
import random
from typing import TypeVar, Callable, Awaitable, Optional, Tuple, Type
import httpx

from core.utils.logger import logger
from core.services.supabase import DBConnection

T = TypeVar("T")

DB_DEFAULT_MAX_RETRIES = 6
DB_RETRY_INITIAL_DELAY = 0.5
DB_RETRY_MAX_DELAY = 10.0
DB_RETRY_JITTER_FACTOR = 0.3

DB_RETRYABLE_EXCEPTIONS: Tuple[Type[Exception], ...] = (
    httpx.ConnectTimeout,
    httpx.ReadTimeout,
    httpx.PoolTimeout,
    httpx.ConnectError,
    httpx.NetworkError,
    ConnectionError,
    TimeoutError,
)


def _add_jitter(delay: float, jitter_factor: float = DB_RETRY_JITTER_FACTOR) -> float:
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
    reset_connection_on_error: bool = True,
    reset_on_pool_timeout: bool = True,
) -> T:
    """
    Retry a database operation with exponential backoff, jitter, and connection reset.
    
    Designed for high-concurrency production workloads with:
    - Configurable retry limits (default: 5 attempts via DB_DEFAULT_MAX_RETRIES)
    - Jitter to prevent thundering herd on retries
    - Automatic connection pool reset on timeouts
    - Handles ConnectTimeout, ReadTimeout, PoolTimeout, network errors, 
      client-closed errors, and route-not-found errors

    Args:
        operation: The async database operation to retry
        operation_name: Name for logging purposes (optional)
        max_retries: Maximum retry attempts (default: DB_DEFAULT_MAX_RETRIES=5)
        initial_delay: Initial delay in seconds (default: DB_RETRY_INITIAL_DELAY=0.5)
        max_delay: Maximum delay between retries (default: DB_RETRY_MAX_DELAY=15.0)
        backoff_factor: Multiplier for exponential backoff (default: 2.0)
        reset_connection_on_error: Reset DB connection on connection errors (default: True)
        reset_on_pool_timeout: Reset connection specifically on PoolTimeout (default: True)

    Returns:
        The result of the operation

    Raises:
        The last exception if all retries are exhausted, or immediately for non-retryable errors
    """
    if max_retries is None:
        max_retries = DB_DEFAULT_MAX_RETRIES
    if initial_delay is None:
        initial_delay = DB_RETRY_INITIAL_DELAY
    if max_delay is None:
        max_delay = DB_RETRY_MAX_DELAY
    
    last_exception: Optional[Exception] = None
    # Use singleton - already initialized at startup
    db = DBConnection()
    op_name = operation_name or "Database operation"
    
    for attempt in range(max_retries):
        try:
            return await operation()
        except DB_RETRYABLE_EXCEPTIONS as e:
            last_exception = e
            is_pool_timeout = isinstance(e, httpx.PoolTimeout)
            is_connect_timeout = isinstance(e, httpx.ConnectTimeout)
            
            if attempt < max_retries - 1:
                should_reset = reset_connection_on_error or (reset_on_pool_timeout and is_pool_timeout)
                if should_reset:
                    try:
                        await db.force_reconnect()
                        logger.debug(f"🔄 Reconnected DB after {type(e).__name__}")
                    except Exception as reset_error:
                        logger.warning(f"Failed to reconnect: {reset_error}")
                
                base_delay = min(initial_delay * (backoff_factor ** attempt), max_delay)
                delay = _add_jitter(base_delay)
                
                if is_pool_timeout or is_connect_timeout:
                    delay = min(delay * 1.5, max_delay)
                
                logger.warning(
                    f"{op_name} failed (attempt {attempt + 1}/{max_retries}): {type(e).__name__}. "
                    f"Retrying in {delay:.2f}s..."
                )
                await asyncio.sleep(delay)
            else:
                logger.error(
                    f"{op_name} failed after {max_retries} attempts: {type(e).__name__}. "
                    f"Consider increasing DB_DEFAULT_MAX_RETRIES or SUPABASE_MAX_CONNECTIONS."
                )
        except Exception as e:
            # Check if this is a recoverable connection error (client-closed, route-not-found)
            if DBConnection.is_recoverable_connection_error(e):
                last_exception = e
                if attempt < max_retries - 1:
                    error_type = "client-closed" if DBConnection.is_client_closed_error(e) else "route-not-found"
                    logger.warning(f"🔄 Recoverable {error_type} error in {op_name} (attempt {attempt + 1}/{max_retries}), reconnecting...")
                    try:
                        await db.force_reconnect()
                    except Exception as reconnect_err:
                        logger.warning(f"Failed to reconnect: {reconnect_err}")
                    
                    base_delay = min(initial_delay * (backoff_factor ** attempt), max_delay)
                    delay = _add_jitter(base_delay)
                    await asyncio.sleep(delay)
                else:
                    logger.error(f"{op_name} failed after {max_retries} attempts with {error_type} error")
            else:
                logger.error(f"{op_name} failed with non-retryable error: {type(e).__name__}: {str(e)}")
                raise
    
    if last_exception:
        raise last_exception
    
    raise RuntimeError("Unexpected: retry loop completed without exception")
