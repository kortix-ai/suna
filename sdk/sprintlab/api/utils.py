from typing import AsyncGenerator
import httpx


async def stream_from_url(url: str, **kwargs) -> AsyncGenerator[str, None]:
    """
    Helper function that takes a URL and returns an async generator yielding lines.

    Args:
        url: The URL to stream from
        **kwargs: Additional arguments to pass to httpx.AsyncClient.stream()

    Yields:
        str: Each line from the streaming response
    """
    # Configure timeout settings to prevent ReadTimeout errors
    timeout = httpx.Timeout(
        connect=30.0,  # 30 seconds to establish connection
        read=300.0,  # 300 seconds to read data (good for streaming)
        write=30.0,  # 30 seconds to write data
        pool=30.0,  # 30 seconds to get connection from pool
    )

    async with httpx.AsyncClient(timeout=timeout) as client:
        async with client.stream("GET", url, **kwargs) as response:
            response.raise_for_status()

            async for line in response.aiter_lines():
                if line.strip():  # Only yield non-empty lines
                    yield line.strip()
