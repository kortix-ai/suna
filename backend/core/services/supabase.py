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
# Connection Pool Configuration for High Traffic
# =============================================================================
# Tuned for Supabase with high concurrency workloads.
# Each service (PostgREST, Storage) gets its own client to avoid base_url conflicts.
# =============================================================================

# Connection limits (per API instance)
# HTTP/2 has a hard limit of 100 concurrent streams per connection
# To avoid "Max outbound streams" errors, we either need:
# - More connections (spread load across multiple HTTP/2 connections)
# - Or disable HTTP/2 (use HTTP/1.1 with separate connections)
# Each agent run makes ~10-20 concurrent DB calls
# Auto-scale connection pool based on concurrency: (concurrent_runs * 20) + buffer
def _calculate_db_connections() -> int:
    """Calculate optimal DB connection pool size based on concurrency."""
    import multiprocessing
    
    cpu_count = multiprocessing.cpu_count()
    
    # Try to detect available memory to estimate concurrency (same logic as agent runs)
    try:
        import psutil
        available_memory_gb = psutil.virtual_memory().total / (1024**3)
        memory_per_run_gb = 0.2  # 200MB per run
        # Use 75% of memory limit (same safety factor as agent runs)
        safety_factor = 0.75
        estimated_concurrent = int((available_memory_gb / memory_per_run_gb) * safety_factor)
    except:
        # Fallback: use CPU-based estimate (conservative)
        estimated_concurrent = int(cpu_count * 7.5)  # 75% of CPU * 10
    
    # Each run uses ~10-20 DB connections, add 50% buffer for bursts
    connections_needed = int(estimated_concurrent * 20 * 1.5)
    
    # PostgreSQL can handle 1000+ connections, but cap at 1500 for safety
    # With 32 vCPUs, 128GB RAM: 480 concurrent * 20 * 1.5 = 14,400 connections needed
    # Cap at 1500 for practical reasons (connection overhead, leave headroom)
    return min(max(connections_needed, 250), 1500)

SUPABASE_MAX_CONNECTIONS = int(os.getenv('SUPABASE_MAX_CONNECTIONS', str(_calculate_db_connections())))
SUPABASE_MAX_KEEPALIVE = int(SUPABASE_MAX_CONNECTIONS * 0.6)  # 60% of max connections
SUPABASE_KEEPALIVE_EXPIRY = 60.0  # 60s keepalive

# Log DB connection settings on module load
if not os.getenv('SUPABASE_MAX_CONNECTIONS'):
    import multiprocessing
    logger.info(f"🔌 Auto-detected DB connections: {SUPABASE_MAX_CONNECTIONS} max connections (CPU count: {multiprocessing.cpu_count()})")
else:
    logger.info(f"🔌 Using configured DB connections: {SUPABASE_MAX_CONNECTIONS} max connections")

# Timeout settings (in seconds) - increased for stability under load
# Note: ConnectTimeout issues under high concurrency are often due to HTTP/2 stream limits
# not actual network issues. Increasing connect timeout helps when pool creates new connections.
SUPABASE_CONNECT_TIMEOUT = 15.0   # TCP connect - increased from 10s for high concurrency
SUPABASE_READ_TIMEOUT = 60.0      # Response read - increased for complex queries
SUPABASE_WRITE_TIMEOUT = 60.0     # Request write - increased for large payloads
SUPABASE_POOL_TIMEOUT = 45.0      # Wait for pool slot - increased from 30s for high concurrency bursts

# HTTP transport settings
SUPABASE_HTTP2_ENABLED = True
SUPABASE_RETRIES = 3  # Retries for transient connection failures


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

    def _create_optimized_transport(self) -> httpx.AsyncHTTPTransport:
        """Create an optimized HTTP transport for high-traffic workloads."""
        limits = httpx.Limits(
            max_connections=SUPABASE_MAX_CONNECTIONS,
            max_keepalive_connections=SUPABASE_MAX_KEEPALIVE,
            keepalive_expiry=SUPABASE_KEEPALIVE_EXPIRY,
        )
        return httpx.AsyncHTTPTransport(
            http2=SUPABASE_HTTP2_ENABLED,
            limits=limits,
            retries=SUPABASE_RETRIES,
        )

    def _configure_service_clients(self):
        """
        Configure each service's httpx client with optimized connection pool settings.
        
        This is called AFTER the SDK creates separate clients for each service,
        so we can optimize without causing the shared client base_url bug.
        """
        optimized_timeout = httpx.Timeout(
            connect=SUPABASE_CONNECT_TIMEOUT,
            read=SUPABASE_READ_TIMEOUT,
            write=SUPABASE_WRITE_TIMEOUT,
            pool=SUPABASE_POOL_TIMEOUT,
        )
        
        # Configure PostgREST client
        if self._client:
            pg = self._client.postgrest
            pg.session.timeout = optimized_timeout
            # Replace transport with optimized one (old transport has 0 connections at this point)
            old_pg_transport = pg.session._transport
            pg.session._transport = self._create_optimized_transport()
            # Close old transport to prevent any potential resource leak
            asyncio.create_task(old_pg_transport.aclose())
            
            # Configure Storage client  
            storage = self._client.storage
            storage._client.timeout = optimized_timeout
            old_storage_transport = storage._client._transport
            storage._client._transport = self._create_optimized_transport()
            asyncio.create_task(old_storage_transport.aclose())

    async def initialize(self):
        if self._initialized:
            return
        
        # Lazily create the async lock (thread-safe via __new__)
        if self._async_lock is None:
            self._async_lock = asyncio.Lock()
        
        async with self._async_lock:
            # Double-check after acquiring lock to prevent race condition
            if self._initialized:
                return
                
            try:
                supabase_url = config.SUPABASE_URL
                supabase_key = config.SUPABASE_SERVICE_ROLE_KEY or config.SUPABASE_ANON_KEY
                
                if not supabase_url or not supabase_key:
                    logger.error("Missing required environment variables for Supabase connection")
                    raise RuntimeError("SUPABASE_URL and a key (SERVICE_ROLE_KEY or ANON_KEY) environment variables must be set.")

                from supabase.lib.client_options import AsyncClientOptions
                
                # NOTE: We intentionally do NOT pass a shared httpx_client here.
                # The Supabase SDK has a bug where postgrest and storage3 both mutate
                # the shared client's base_url, causing a race condition:
                # - PostgREST sets base_url to /rest/v1
                # - Storage sets base_url to /storage/v1
                # - Whichever runs last "wins", corrupting requests for the other service
                # This caused production errors like "Route POST:/projects not found" 
                # when REST requests were incorrectly routed to the Storage service.
                # Let each service create its own httpx client with correct base_url.
                options = AsyncClientOptions(
                    postgrest_client_timeout=SUPABASE_READ_TIMEOUT,
                    storage_client_timeout=SUPABASE_READ_TIMEOUT,
                    function_client_timeout=SUPABASE_READ_TIMEOUT,
                )
                
                self._client = await create_async_client(
                    supabase_url, 
                    supabase_key,
                    options=options
                )
                
                # Configure each service's httpx client with optimized connection pool settings.
                # We do this AFTER creation to avoid the shared client bug while still getting
                # optimal connection pooling for high traffic.
                self._configure_service_clients()
                
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
                if cls._instance._client and hasattr(cls._instance._client, 'close'):
                    await cls._instance._client.close()
            except Exception as e:
                logger.warning(f"Error during disconnect: {e}")
            finally:
                cls._instance._initialized = False
                cls._instance._client = None
                logger.info("Database disconnected successfully")

    async def reset_connection(self):
        try:
            if self._client and hasattr(self._client, 'close'):
                await self._client.close()
        except Exception as e:
            logger.warning(f"Error closing client during reset: {e}")
        
        self._initialized = False
        self._client = None
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
