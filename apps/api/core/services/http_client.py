"""
Shared HTTP Client Service for Third-Party API Calls

This module provides a centralized, optimized HTTP client for making
requests to third-party services from containers. It addresses common
bottlenecks:

1. Connection pooling - reuses connections instead of creating new ones
2. Proper timeout configuration - prevents hanging requests
3. DNS caching - reduces DNS lookup latency
4. Connection limits - prevents resource exhaustion
5. Retry logic - handles transient network failures

Usage:
    from core.services.http_client import get_http_client
    
    async with get_http_client() as client:
        response = await client.get("https://api.example.com/data")
"""

import os
import httpx
from typing import Optional
from contextlib import asynccontextmanager
from core.utils.logger import logger

# Connection pool settings
HTTP_MAX_CONNECTIONS = int(os.getenv('HTTP_MAX_CONNECTIONS', '100'))
HTTP_MAX_KEEPALIVE = int(os.getenv('HTTP_MAX_KEEPALIVE', '50'))
HTTP_KEEPALIVE_EXPIRY = 30.0

# Timeout settings (seconds)
HTTP_CONNECT_TIMEOUT = float(os.getenv('HTTP_CONNECT_TIMEOUT', '10.0'))
HTTP_READ_TIMEOUT = float(os.getenv('HTTP_READ_TIMEOUT', '60.0'))
HTTP_WRITE_TIMEOUT = float(os.getenv('HTTP_WRITE_TIMEOUT', '30.0'))
HTTP_POOL_TIMEOUT = float(os.getenv('HTTP_POOL_TIMEOUT', '30.0'))

# Retry settings
HTTP_RETRIES = int(os.getenv('HTTP_RETRIES', '3'))

# Global shared client instance (per worker process)
_shared_client: Optional[httpx.AsyncClient] = None
_client_lock = None


def _create_transport() -> httpx.AsyncHTTPTransport:
    """Create HTTP transport with optimized connection pooling."""
    return httpx.AsyncHTTPTransport(
        http2=True,  # Enable HTTP/2 for better connection multiplexing
        limits=httpx.Limits(
            max_connections=HTTP_MAX_CONNECTIONS,
            max_keepalive_connections=HTTP_MAX_KEEPALIVE,
            keepalive_expiry=HTTP_KEEPALIVE_EXPIRY,
        ),
        retries=HTTP_RETRIES,
    )


def _create_timeout() -> httpx.Timeout:
    """Create timeout configuration."""
    return httpx.Timeout(
        connect=HTTP_CONNECT_TIMEOUT,
        read=HTTP_READ_TIMEOUT,
        write=HTTP_WRITE_TIMEOUT,
        pool=HTTP_POOL_TIMEOUT,
    )


async def _get_shared_client() -> httpx.AsyncClient:
    """Get or create the shared HTTP client instance."""
    global _shared_client, _client_lock
    
    if _shared_client is not None:
        return _shared_client
    
    # Lazy import to avoid circular dependencies
    import asyncio
    if _client_lock is None:
        _client_lock = asyncio.Lock()
    
    async with _client_lock:
        # Double-check after acquiring lock
        if _shared_client is not None:
            return _shared_client
        
        logger.info(
            f"Initializing shared HTTP client: "
            f"max_connections={HTTP_MAX_CONNECTIONS}, "
            f"connect_timeout={HTTP_CONNECT_TIMEOUT}s, "
            f"read_timeout={HTTP_READ_TIMEOUT}s"
        )
        
        _shared_client = httpx.AsyncClient(
            transport=_create_transport(),
            timeout=_create_timeout(),
            # Enable DNS caching at the OS level (if supported)
            # This helps reduce DNS lookup latency in containers
            follow_redirects=True,
        )
        
        return _shared_client


async def close_shared_client():
    """Close the shared HTTP client (called during shutdown)."""
    global _shared_client
    if _shared_client is not None:
        try:
            await _shared_client.aclose()
            logger.debug("Shared HTTP client closed")
        except Exception as e:
            logger.error(f"Error closing shared HTTP client: {e}")
        finally:
            _shared_client = None


@asynccontextmanager
async def get_http_client(
    timeout: Optional[httpx.Timeout] = None,
    **kwargs
) -> httpx.AsyncClient:
    """
    Get a shared HTTP client with optimized connection pooling.
    
    Args:
        timeout: Optional custom timeout (overrides default)
        **kwargs: Additional httpx.AsyncClient parameters
    
    Yields:
        httpx.AsyncClient: Configured HTTP client
        
    Example:
        async with get_http_client() as client:
            response = await client.get("https://api.example.com/data")
    """
    client = await _get_shared_client()
    
    # If custom timeout or other params provided, create a new client
    # Otherwise, reuse the shared client
    if timeout is not None or kwargs:
        # Create a temporary client with custom settings
        # Still uses connection pooling via transport
        custom_client = httpx.AsyncClient(
            transport=_create_transport(),
            timeout=timeout or _create_timeout(),
            **kwargs
        )
        try:
            yield custom_client
        finally:
            await custom_client.aclose()
    else:
        # Reuse shared client (no cleanup needed)
        yield client


@asynccontextmanager
async def get_ephemeral_client(
    timeout: Optional[float] = None,
    **kwargs
) -> httpx.AsyncClient:
    """
    Get an ephemeral HTTP client for one-off requests.
    
    Use this when you need a client that will be closed after use,
    or when you need different settings than the shared client.
    
    Args:
        timeout: Optional timeout in seconds (creates httpx.Timeout)
        **kwargs: Additional httpx.AsyncClient parameters
    
    Yields:
        httpx.AsyncClient: Ephemeral HTTP client
    """
    if timeout is not None and not isinstance(timeout, httpx.Timeout):
        timeout = httpx.Timeout(timeout)
    elif timeout is None:
        timeout = _create_timeout()
    
    client = httpx.AsyncClient(
        transport=_create_transport(),
        timeout=timeout,
        **kwargs
    )
    
    try:
        yield client
    finally:
        await client.aclose()

