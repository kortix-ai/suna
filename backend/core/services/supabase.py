from typing import Optional, Callable, TypeVar, Any
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
import random

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
# With 12 workers: 12 * 120 = 1440 max connections (within Supabase 1500 limit)
SUPABASE_MAX_CONNECTIONS = int(os.getenv("SUPABASE_MAX_CONNECTIONS", "120"))
SUPABASE_MAX_KEEPALIVE = int(os.getenv("SUPABASE_MAX_KEEPALIVE", "60"))
SUPABASE_KEEPALIVE_EXPIRY = float(os.getenv("SUPABASE_KEEPALIVE_EXPIRY", "120.0"))  # 2 min keepalive

# Timeout settings (in seconds)
SUPABASE_CONNECT_TIMEOUT = float(os.getenv("SUPABASE_CONNECT_TIMEOUT", "10.0"))  # TCP connect
SUPABASE_READ_TIMEOUT = float(os.getenv("SUPABASE_READ_TIMEOUT", "30.0"))        # Response read
SUPABASE_WRITE_TIMEOUT = float(os.getenv("SUPABASE_WRITE_TIMEOUT", "30.0"))      # Request write
SUPABASE_POOL_TIMEOUT = float(os.getenv("SUPABASE_POOL_TIMEOUT", "30.0"))        # Wait for pool slot

# HTTP transport settings
SUPABASE_HTTP2_ENABLED = os.getenv("SUPABASE_HTTP2_ENABLED", "true").lower() == "true"
SUPABASE_RETRIES = int(os.getenv("SUPABASE_RETRIES", "3"))  # Transport-level retries

# PostgREST route error retry settings
POSTGREST_ROUTE_ERROR_MAX_RETRIES = int(os.getenv("POSTGREST_ROUTE_ERROR_MAX_RETRIES", "5"))
POSTGREST_ROUTE_ERROR_BASE_DELAY = float(os.getenv("POSTGREST_ROUTE_ERROR_BASE_DELAY", "0.5"))
POSTGREST_ROUTE_ERROR_MAX_DELAY = float(os.getenv("POSTGREST_ROUTE_ERROR_MAX_DELAY", "8.0"))

T = TypeVar('T')


class DBConnection:
    _instance: Optional['DBConnection'] = None
    _lock = threading.Lock()
    _async_lock: Optional[asyncio.Lock] = None
    _reconnect_lock: Optional[asyncio.Lock] = None
    _reconnect_in_progress: bool = False

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
                    cls._instance._reconnect_in_progress = False
        return cls._instance

    def __init__(self):
        pass
    
    async def _get_reconnect_lock(self) -> asyncio.Lock:
        if self._reconnect_lock is None:
            self._reconnect_lock = asyncio.Lock()
        return self._reconnect_lock
    
    @classmethod
    def is_route_not_found_error(cls, error) -> bool:
        error_str = str(error).lower()
        return (
            'route' in error_str and 'not found' in error_str
        ) or (
            'statuscode' in error_str and '404' in error_str and 'route' in error_str
        )
    
    @classmethod
    def is_transient_error(cls, error) -> bool:
        if cls.is_route_not_found_error(error):
            return True
        error_str = str(error).lower()
        transient_indicators = [
            'connection', 'timeout', 'timed out', 'temporarily unavailable',
            'service unavailable', '503', '502', '504', 'connection reset',
            'connection refused', 'network', 'socket', 'eof'
        ]
        return any(indicator in error_str for indicator in transient_indicators)
    
    async def force_reconnect(self, wait_if_in_progress: bool = True) -> bool:
        lock = await self._get_reconnect_lock()
        
        if lock.locked():
            if wait_if_in_progress:
                logger.debug("🔄 Reconnection in progress, waiting for it to complete...")
                async with lock:
                    return True
            else:
                logger.debug("Skipping reconnect - already in progress")
                return False
        
        async with lock:
            current_time = time.time()
            if current_time - self._last_reset_time < 2:
                logger.debug("Skipping reconnect - completed very recently")
                return True
            
            logger.warning("🔄 Forcing Supabase reconnection due to connection issues...")
            self._last_reset_time = current_time
            await self.reset_connection()
            await self.initialize()
            logger.info("✅ Supabase connection re-established")
            return True

    def _create_http_client(self) -> httpx.AsyncClient:
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
        Get client with automatic reconnection on route-not-found errors.
        Use this for critical operations that need resilience.
        """
        for attempt in range(max_retries + 1):
            try:
                if not self._initialized:
                    await self.initialize()
                if not self._client:
                    raise RuntimeError("Database not initialized")
                return self._client
            except Exception as e:
                if self.is_route_not_found_error(e) and attempt < max_retries:
                    logger.warning(f"🔄 DB connection error (attempt {attempt + 1}/{max_retries + 1}), forcing reconnect...")
                    await self.force_reconnect()
                else:
                    raise
        return self._client


async def execute_with_reconnect(db: DBConnection, operation, max_retries: int = 2):
    last_error = None
    for attempt in range(max_retries + 1):
        try:
            client = await db.client
            return await operation(client)
        except Exception as e:
            last_error = e
            if DBConnection.is_route_not_found_error(e) and attempt < max_retries:
                logger.warning(f"🔄 Route-not-found error (attempt {attempt + 1}/{max_retries + 1}), reconnecting...")
                await db.force_reconnect()
            else:
                raise
    raise last_error


async def db_query_with_retry(
    client_or_db,
    query_fn: Callable[[AsyncClient], Any],
    operation_name: str = "db_query",
    max_retries: int = POSTGREST_ROUTE_ERROR_MAX_RETRIES,
    base_delay: float = POSTGREST_ROUTE_ERROR_BASE_DELAY,
    max_delay: float = POSTGREST_ROUTE_ERROR_MAX_DELAY,
) -> T:
    from core.utils.db_helpers import get_db
    
    db = None
    if isinstance(client_or_db, DBConnection):
        db = client_or_db
    else:
        db = await get_db()
    
    last_error = None
    
    for attempt in range(max_retries + 1):
        try:
            client = await db.client
            return await query_fn(client)
        except Exception as e:
            last_error = e
            is_last_attempt = attempt >= max_retries
            
            if is_last_attempt:
                logger.error(
                    f"❌ [{operation_name}] Failed after {max_retries + 1} attempts: {e}",
                    exc_info=False
                )
                raise
            
            is_route_error = DBConnection.is_route_not_found_error(e)
            is_transient = DBConnection.is_transient_error(e)
            
            if is_route_error or is_transient:
                delay = min(base_delay * (2 ** attempt), max_delay)
                jitter = random.uniform(0, delay * 0.3)
                total_delay = delay + jitter
                
                error_type = "Route-not-found" if is_route_error else "Transient"
                logger.warning(
                    f"🔄 [{operation_name}] {error_type} error (attempt {attempt + 1}/{max_retries + 1}), "
                    f"retrying in {total_delay:.2f}s: {str(e)[:200]}"
                )
                
                if is_route_error:
                    await db.force_reconnect(wait_if_in_progress=True)
                
                await asyncio.sleep(total_delay)
            else:
                logger.error(f"❌ [{operation_name}] Non-retryable error: {e}")
                raise
    
    raise last_error


async def db_query_with_fallback(
    client_or_db,
    query_fn: Callable[[AsyncClient], Any],
    fallback_value: T,
    operation_name: str = "db_query",
    max_retries: int = POSTGREST_ROUTE_ERROR_MAX_RETRIES,
) -> T:
    try:
        return await db_query_with_retry(
            client_or_db,
            query_fn,
            operation_name=operation_name,
            max_retries=max_retries,
        )
    except Exception as e:
        logger.warning(
            f"⚠️ [{operation_name}] All retries exhausted, using fallback value. Error: {str(e)[:200]}"
        )
        return fallback_value
