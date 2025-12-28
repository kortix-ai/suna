import asyncio
from typing import TypeVar, Callable, Awaitable, Optional, Tuple, Type
import httpx

from core.utils.logger import logger
from core.services.supabase import DBConnection

T = TypeVar("T")

# Common retryable exceptions for database operations
DB_RETRYABLE_EXCEPTIONS: Tuple[Type[Exception], ...] = (
    httpx.ConnectTimeout,
    httpx.ReadTimeout,
    httpx.PoolTimeout,
    httpx.ConnectError,
    httpx.NetworkError,
    ConnectionError,
    TimeoutError,
)


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
    max_retries: int = 3,
    initial_delay: float = 1.0,
    max_delay: float = 10.0,
    backoff_factor: float = 2.0,
    reset_connection_on_error: bool = True,
) -> T:
    """
    Retry a database operation with exponential backoff and connection reset.
    
    Specifically handles transient database connection errors like ConnectTimeout,
    ReadTimeout, PoolTimeout, etc. Optionally resets the DB connection on errors
    to handle stale connections.

    Args:
        operation: The async database operation to retry
        operation_name: Name for logging purposes (optional)
        max_retries: Maximum number of retry attempts (default: 3)
        initial_delay: Initial delay in seconds before first retry (default: 1.0)
        max_delay: Maximum delay between retries in seconds (default: 10.0)
        backoff_factor: Multiplier for exponential backoff (default: 2.0)
        reset_connection_on_error: If True, reset DB connection on connection errors (default: True)

    Returns:
        The result of the operation

    Raises:
        The last exception if all retries are exhausted, or immediately for non-retryable errors

    Example:
    ```python
    from core.utils.retry import retry_db_operation
    
    client = await db.client
    result = await retry_db_operation(
        lambda: client.table('users').select('*').eq('id', user_id).execute(),
        operation_name=f"Fetch user {user_id}",
    )
    ```
    """
    last_exception: Optional[Exception] = None
    db = DBConnection()
    
    for attempt in range(max_retries):
        try:
            return await operation()
        except DB_RETRYABLE_EXCEPTIONS as e:
            last_exception = e
            if attempt < max_retries - 1:
                # Reset connection if requested (helps with stale connections)
                if reset_connection_on_error:
                    try:
                        await db.reset_connection()
                        logger.debug(f"Reset DB connection after {type(e).__name__}")
                    except Exception as reset_error:
                        logger.warning(f"Failed to reset connection: {reset_error}")
                
                delay = min(initial_delay * (backoff_factor ** attempt), max_delay)
                op_name = operation_name or "Database operation"
                logger.warning(
                    f"{op_name} failed (attempt {attempt + 1}/{max_retries}): {type(e).__name__}. "
                    f"Retrying in {delay:.1f}s..."
                )
                await asyncio.sleep(delay)
            else:
                op_name = operation_name or "Database operation"
                logger.error(f"{op_name} failed after {max_retries} attempts: {type(e).__name__}")
        except Exception as e:
            # For non-retryable errors, don't retry
            op_name = operation_name or "Database operation"
            logger.error(f"{op_name} failed with non-retryable error: {type(e).__name__}: {str(e)}")
            raise
    
    # If we exhausted retries, raise the last exception
    if last_exception:
        raise last_exception
    
    raise RuntimeError("Unexpected: retry loop completed without exception")
