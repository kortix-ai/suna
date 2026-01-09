"""
Supabase Database Connection - Production Configuration

Architecture:
- Gunicorn runs 8-16 workers (separate processes)
- Each worker has its own DBConnection singleton
- Each singleton creates one HTTP/2 connection to Supabase
- HTTP/2 supports 100 concurrent streams per connection
- Total capacity: 8 workers × 100 streams = 800 concurrent requests (per container)

PERFORMANCE OPTIMIZATIONS (Jan 2026):
- Increased pool timeout to handle burst traffic
- Added connection stats for monitoring
- Optimized keepalive settings for cloud deployments

Configuration is simple and explicit via environment variables.
"""

from typing import Optional, Dict, Any
from supabase import create_async_client, AsyncClient
from core.utils.logger import logger
from core.utils.config import config
import os
import threading
import httpx
import asyncio
import time

# Connection pool settings (per worker)
# These are conservative for cloud Supabase (HTTP/2 multiplexing handles concurrency)
SUPABASE_MAX_CONNECTIONS = int(os.getenv('SUPABASE_MAX_CONNECTIONS', '50'))
SUPABASE_MAX_KEEPALIVE = int(os.getenv('SUPABASE_MAX_KEEPALIVE', '30'))
SUPABASE_KEEPALIVE_EXPIRY = float(os.getenv('SUPABASE_KEEPALIVE_EXPIRY', '60.0'))  # Increased from 30

# Timeout settings (seconds)
SUPABASE_CONNECT_TIMEOUT = float(os.getenv('SUPABASE_CONNECT_TIMEOUT', '15.0'))  # Increased from 10
SUPABASE_READ_TIMEOUT = float(os.getenv('SUPABASE_READ_TIMEOUT', '60.0'))
SUPABASE_WRITE_TIMEOUT = float(os.getenv('SUPABASE_WRITE_TIMEOUT', '60.0'))
SUPABASE_POOL_TIMEOUT = float(os.getenv('SUPABASE_POOL_TIMEOUT', '45.0'))  # Increased from 30

# Transport settings
SUPABASE_HTTP2_ENABLED = True
SUPABASE_RETRIES = 3


class DBConnection:
    """
    Singleton database connection per worker process.
    
    Provides connection pooling stats for monitoring and diagnostics.
    """
    
    _instance: Optional['DBConnection'] = None
    _lock = threading.Lock()
    
    # Connection stats for monitoring
    _init_time: Optional[float] = None
    _request_count: int = 0
    _error_count: int = 0

    def __new__(cls):
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = super().__new__(cls)
                    cls._instance._initialized = False
                    cls._instance._client = None
                    cls._instance._async_lock = None
                    cls._instance._init_time = None
                    cls._instance._request_count = 0
                    cls._instance._error_count = 0
        return cls._instance

    def __init__(self):
        pass
    
    def get_connection_stats(self) -> Dict[str, Any]:
        """Get connection pool statistics for monitoring."""
        uptime = time.time() - self._init_time if self._init_time else 0
        return {
            'initialized': self._initialized,
            'uptime_seconds': round(uptime, 1),
            'request_count': self._request_count,
            'error_count': self._error_count,
            'config': {
                'max_connections': SUPABASE_MAX_CONNECTIONS,
                'max_keepalive': SUPABASE_MAX_KEEPALIVE,
                'keepalive_expiry': SUPABASE_KEEPALIVE_EXPIRY,
                'connect_timeout': SUPABASE_CONNECT_TIMEOUT,
                'read_timeout': SUPABASE_READ_TIMEOUT,
                'pool_timeout': SUPABASE_POOL_TIMEOUT,
                'http2_enabled': SUPABASE_HTTP2_ENABLED,
            }
        }
    
    def increment_request_count(self):
        """Increment request counter (call on each DB request)."""
        self._request_count += 1
    
    def increment_error_count(self):
        """Increment error counter (call on each DB error)."""
        self._error_count += 1

    def _create_transport(self) -> httpx.AsyncHTTPTransport:
        """Create HTTP transport with connection pooling."""
        return httpx.AsyncHTTPTransport(
            http2=SUPABASE_HTTP2_ENABLED,
            limits=httpx.Limits(
                max_connections=SUPABASE_MAX_CONNECTIONS,
                max_keepalive_connections=SUPABASE_MAX_KEEPALIVE,
                keepalive_expiry=SUPABASE_KEEPALIVE_EXPIRY,
            ),
            retries=SUPABASE_RETRIES,
        )

    def _configure_clients(self):
        """Configure httpx clients with optimized settings."""
        timeout = httpx.Timeout(
            connect=SUPABASE_CONNECT_TIMEOUT,
            read=SUPABASE_READ_TIMEOUT,
            write=SUPABASE_WRITE_TIMEOUT,
            pool=SUPABASE_POOL_TIMEOUT,
        )
        
        if self._client:
            # Configure PostgREST client
            pg = self._client.postgrest
            pg.session.timeout = timeout
            old_transport = pg.session._transport
            pg.session._transport = self._create_transport()
            asyncio.create_task(old_transport.aclose())
            
            # Configure Storage client
            storage = self._client.storage
            storage._client.timeout = timeout
            old_storage = storage._client._transport
            storage._client._transport = self._create_transport()
            asyncio.create_task(old_storage.aclose())

    async def initialize(self):
        """Initialize database connection."""
        if self._initialized:
            return
        
        # Lazily create the async lock (thread-safe via __new__)
        if self._async_lock is None:
            self._async_lock = asyncio.Lock()
        
        async with self._async_lock:
            # Double-check after acquiring lock to prevent race condition
            if self._initialized:
                return
                
        supabase_url = config.SUPABASE_URL
        supabase_key = config.SUPABASE_SERVICE_ROLE_KEY or config.SUPABASE_ANON_KEY
        
        if not supabase_url or not supabase_key:
            raise RuntimeError("SUPABASE_URL and key must be set")

        from supabase.lib.client_options import AsyncClientOptions
        
        options = AsyncClientOptions(
            postgrest_client_timeout=SUPABASE_READ_TIMEOUT,
            storage_client_timeout=SUPABASE_READ_TIMEOUT,
            function_client_timeout=SUPABASE_READ_TIMEOUT,
        )
        
        self._client = await create_async_client(supabase_url, supabase_key, options=options)
        self._configure_clients()
        self._initialized = True
        self._init_time = time.time()
        self._request_count = 0
        self._error_count = 0
        
        key_type = "SERVICE_ROLE" if config.SUPABASE_SERVICE_ROLE_KEY else "ANON"
        logger.info(
            f"Database initialized | key={key_type} pool={SUPABASE_MAX_CONNECTIONS} "
            f"http2={SUPABASE_HTTP2_ENABLED} connect_timeout={SUPABASE_CONNECT_TIMEOUT}s "
            f"pool_timeout={SUPABASE_POOL_TIMEOUT}s"
        )

    async def force_reconnect(self):
        """Force reconnection on errors."""
        logger.warning("Forcing database reconnection...")
        await self.reset_connection()
        await self.initialize()
        logger.info("Database reconnected")

    async def reset_connection(self):
        """Reset connection state."""
        if self._client:
            try:
                await self._client.close()
            except Exception:
                pass
        self._initialized = False
        self._client = None

    @property
    async def client(self) -> AsyncClient:
        """Get database client, initializing if needed."""
        if not self._initialized:
            await self.initialize()
        if not self._client:
            raise RuntimeError("Database not initialized")
        return self._client

    @classmethod
    async def disconnect(cls):
        """Disconnect database."""
        if cls._instance and cls._instance._client:
            try:
                await cls._instance._client.close()
            except Exception:
                pass
            cls._instance._initialized = False
            cls._instance._client = None
            logger.info("Database disconnected")

    @staticmethod
    def is_recoverable_connection_error(error) -> bool:
        """Check if error is recoverable via reconnection."""
        error_str = str(error).lower()
        return (
            ('route' in error_str and 'not found' in error_str) or
            ('client has been closed' in error_str) or
            ('cannot send a request' in error_str and 'closed' in error_str)
        )

    @staticmethod
    def is_client_closed_error(error) -> bool:
        """Check if error indicates closed client."""
        error_str = str(error).lower()
        return 'client has been closed' in error_str or 'closed' in error_str


async def execute_with_reconnect(db: DBConnection, operation, max_retries: int = 2):
    """Execute database operation with automatic reconnection on errors."""
    last_error = None
    for attempt in range(max_retries + 1):
        try:
            client = await db.client
            return await operation(client)
        except Exception as e:
            last_error = e
            if DBConnection.is_recoverable_connection_error(e) and attempt < max_retries:
                logger.warning(f"Recoverable error (attempt {attempt + 1}/{max_retries + 1}), reconnecting...")
                await db.force_reconnect()
            else:
                raise
    raise last_error
