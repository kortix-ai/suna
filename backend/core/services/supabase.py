from typing import Optional
from supabase import create_async_client, AsyncClient
from core.utils.logger import logger
from core.utils.config import config
import base64
import uuid
import os
from datetime import datetime
import threading
import httpx
import time
import asyncio

# =============================================================================
# Connection Pool Configuration
# =============================================================================
# Tuned for Supabase 2XL tier:
#   - Max client connections: 1500
#   - Pool size: 250 (per user+db combination)
#
# With 12 workers x 48 concurrency = 576 max concurrent operations
# We allocate ~120 connections per worker (12 * 120 = 1440, within 1500 limit)
#
# Key considerations:
# - Each worker has its own connection pool (singleton per process)
# - HTTP/2 multiplexes many requests over fewer TCP connections
# - Pool timeout should be generous to avoid failures during traffic spikes
# - Keepalive prevents connection churn under sustained load
# =============================================================================

# Connection limits (per worker process)
# With 12 workers: 12 * 30 = 360 max connections (reduced to avoid overwhelming PostgREST)
SUPABASE_MAX_CONNECTIONS = 30
SUPABASE_MAX_KEEPALIVE = 20
SUPABASE_KEEPALIVE_EXPIRY = 30.0  # 30s keepalive

# Timeout settings (in seconds) - aggressive to fail fast
SUPABASE_CONNECT_TIMEOUT = 5.0   # TCP connect
SUPABASE_READ_TIMEOUT = 10.0        # Response read
SUPABASE_WRITE_TIMEOUT = 10.0      # Request write
SUPABASE_POOL_TIMEOUT = 5.0         # Wait for pool slot

# HTTP transport settings
SUPABASE_HTTP2_ENABLED = True
SUPABASE_RETRIES = 1  # Single retry only


class DBConnection:
    _instance: Optional['DBConnection'] = None
    _lock = threading.Lock()
    _async_lock: Optional[asyncio.Lock] = None

    def __new__(cls):
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = super().__new__(cls)
                    cls._instance._initialized = False
                    cls._instance._client = None
                    cls._instance._http_client = None
                    cls._instance._last_reset_time = 0
                    cls._instance._consecutive_errors = 0
        return cls._instance

    def __init__(self):
        pass
    
    @classmethod
    def is_route_not_found_error(cls, error) -> bool:
        """Check if an error is a PostgREST 'Route not found' error indicating stale connection."""
        error_str = str(error).lower()
        return (
            'route' in error_str and 'not found' in error_str
        ) or (
            'statuscode' in error_str and '404' in error_str and 'route' in error_str
        )
    
    @classmethod
    def is_client_closed_error(cls, error) -> bool:
        """Check if an error indicates the HTTP client has been closed."""
        error_str = str(error).lower()
        return (
            'client has been closed' in error_str or
            'cannot send a request' in error_str and 'closed' in error_str
        )
    
    @classmethod
    def is_recoverable_connection_error(cls, error) -> bool:
        """Check if an error is recoverable via reconnection (route-not-found or client-closed)."""
        return cls.is_route_not_found_error(error) or cls.is_client_closed_error(error)
    
    async def force_reconnect(self):
        """Force reconnection - call this when you detect route-not-found errors."""
        current_time = time.time()
        # Prevent reconnection spam (max once per 1 second to allow retries with backoff)
        if current_time - self._last_reset_time < 1:
            logger.debug("Skipping reconnect - too soon since last reset")
            return
        
        logger.warning("🔄 Forcing Supabase reconnection due to connection issues...")
        self._last_reset_time = current_time
        await self.reset_connection()
        await self.initialize()
        logger.info("✅ Supabase connection re-established")

    def _create_http_client(self) -> httpx.AsyncClient:
        """
        Create an HTTP client with optimized settings for high-concurrency workloads.
        
        Features:
        - Connection pooling with keepalive
        - Transport-level retries for transient failures
        - HTTP/2 multiplexing (configurable)
        - Generous timeouts for stability under load
        """
        limits = httpx.Limits(
            max_connections=SUPABASE_MAX_CONNECTIONS,
            max_keepalive_connections=SUPABASE_MAX_KEEPALIVE,
            keepalive_expiry=SUPABASE_KEEPALIVE_EXPIRY,
        )
        
        timeout = httpx.Timeout(
            connect=SUPABASE_CONNECT_TIMEOUT,
            read=SUPABASE_READ_TIMEOUT,
            write=SUPABASE_WRITE_TIMEOUT,
            pool=SUPABASE_POOL_TIMEOUT,
        )
        
        # Create transport with retries for connection-level failures
        # This handles TCP connect failures, TLS handshake failures, etc.
        transport = httpx.AsyncHTTPTransport(
            retries=SUPABASE_RETRIES,
            http2=SUPABASE_HTTP2_ENABLED,
        )
        
        return httpx.AsyncClient(
            limits=limits,
            timeout=timeout,
            transport=transport,
        )

    async def initialize(self):
        if self._initialized:
            return
                
        try:
            supabase_url = config.SUPABASE_URL
            supabase_key = config.SUPABASE_SERVICE_ROLE_KEY or config.SUPABASE_ANON_KEY
            
            if not supabase_url or not supabase_key:
                logger.error("Missing required environment variables for Supabase connection")
                raise RuntimeError("SUPABASE_URL and a key (SERVICE_ROLE_KEY or ANON_KEY) environment variables must be set.")

            from supabase.lib.client_options import AsyncClientOptions
            
            # Create our custom HTTP client with optimized settings
            self._http_client = self._create_http_client()
            
            # Pass the custom httpx client directly to the Supabase SDK
            # This ensures ALL Supabase operations use our pooled/optimized client
            options = AsyncClientOptions(
                httpx_client=self._http_client,  # <-- KEY FIX: Use our custom client
                postgrest_client_timeout=SUPABASE_READ_TIMEOUT,
                storage_client_timeout=SUPABASE_READ_TIMEOUT,
                function_client_timeout=SUPABASE_READ_TIMEOUT,
            )
            
            self._client = await create_async_client(
                supabase_url, 
                supabase_key,
                options=options
            )
            
            self._initialized = True
            key_type = "SERVICE_ROLE_KEY" if config.SUPABASE_SERVICE_ROLE_KEY else "ANON_KEY"
            logger.info(
                f"Database connection initialized with Supabase using {key_type} | "
                f"pool(max={SUPABASE_MAX_CONNECTIONS}, keepalive={SUPABASE_MAX_KEEPALIVE}) | "
                f"timeout(connect={SUPABASE_CONNECT_TIMEOUT}s, pool={SUPABASE_POOL_TIMEOUT}s) | "
                f"transport(http2={SUPABASE_HTTP2_ENABLED}, retries={SUPABASE_RETRIES})"
            )
            
        except Exception as e:
            logger.error(f"Database initialization error: {e}")
            raise RuntimeError(f"Failed to initialize database connection: {str(e)}")

    @classmethod
    async def disconnect(cls):
        if cls._instance:
            try:
                if cls._instance._http_client:
                    await cls._instance._http_client.aclose()
                if cls._instance._client and hasattr(cls._instance._client, 'close'):
                    await cls._instance._client.close()
            except Exception as e:
                logger.warning(f"Error during disconnect: {e}")
            finally:
                cls._instance._initialized = False
                cls._instance._client = None
                cls._instance._http_client = None
                logger.info("Database disconnected successfully")

    async def reset_connection(self):
        try:
            if self._http_client:
                await self._http_client.aclose()
            if self._client and hasattr(self._client, 'close'):
                await self._client.close()
        except Exception as e:
            logger.warning(f"Error closing client during reset: {e}")
        
        self._initialized = False
        self._client = None
        self._http_client = None
        logger.debug("Database connection reset")

    @property
    async def client(self) -> AsyncClient:
        if not self._initialized:
            await self.initialize()
        if not self._client:
            logger.error("Database client is None after initialization")
            raise RuntimeError("Database not initialized")
        return self._client
    
    async def get_client_with_retry(self, max_retries: int = 2) -> AsyncClient:
        """
        Get client with automatic reconnection on recoverable errors.
        Use this for critical operations that need resilience.
        Handles both route-not-found and client-closed errors.
        """
        for attempt in range(max_retries + 1):
            try:
                if not self._initialized:
                    await self.initialize()
                if not self._client:
                    raise RuntimeError("Database not initialized")
                return self._client
            except Exception as e:
                if self.is_recoverable_connection_error(e) and attempt < max_retries:
                    error_type = "client-closed" if self.is_client_closed_error(e) else "route-not-found"
                    logger.warning(f"🔄 Recoverable {error_type} error (attempt {attempt + 1}/{max_retries + 1}), forcing reconnect...")
                    await self.force_reconnect()
                else:
                    raise
        return self._client


async def execute_with_reconnect(db: DBConnection, operation, max_retries: int = 2):
    """
    Execute a database operation with automatic reconnection on recoverable errors.
    Handles both route-not-found and client-closed errors.
    
    Usage:
        result = await execute_with_reconnect(db, lambda client: client.table('x').select('*').execute())
    """
    last_error = None
    for attempt in range(max_retries + 1):
        try:
            client = await db.client
            return await operation(client)
        except Exception as e:
            last_error = e
            if DBConnection.is_recoverable_connection_error(e) and attempt < max_retries:
                error_type = "client-closed" if DBConnection.is_client_closed_error(e) else "route-not-found"
                logger.warning(f"🔄 Recoverable {error_type} error (attempt {attempt + 1}/{max_retries + 1}), reconnecting...")
                await db.force_reconnect()
            else:
                raise
    raise last_error
