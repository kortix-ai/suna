import asyncio
from typing import TypeVar, Callable, Awaitable, Optional

T = TypeVar("T")


async def retry(
    fn: Callable[[], Awaitable[T]],
    max_attempts: int = 3,
    delay_seconds: int = 1,
) -> T:
    """
    Retry an async function with exponential backoff.

    Args:
        fn: The async function to retry
        max_attempts: Maximum number of attempts
        delay_seconds: Delay between attempts in seconds

    Returns:
        The result of the function call

    Raises:
        The last exception if all attempts fail

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

    for attempt in range(1, max_attempts + 1):
        try:
            return await fn()
        except Exception as error:
            last_error = error

            if attempt == max_attempts:
                break

            await asyncio.sleep(delay_seconds)

    if last_error:
        raise last_error

    raise RuntimeError("Unexpected: last_error is None")
