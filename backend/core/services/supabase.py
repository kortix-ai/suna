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

SUPABASE_MAX_CONNECTIONS = 500
SUPABASE_MAX_KEEPALIVE = 100

SUPABASE_CONNECT_TIMEOUT = 5.0
SUPABASE_READ_TIMEOUT = 30.0
SUPABASE_POOL_TIMEOUT = 10.0
SUPABASE_WRITE_TIMEOUT = 30.0


class DBConnection:
    _instance: Optional['DBConnection'] = None
    _lock = threading.Lock()

    def __new__(cls):
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = super().__new__(cls)
                    cls._instance._initialized = False
                    cls._instance._client = None
                    cls._instance._http_client = None
        return cls._instance

    def __init__(self):
        pass

    def _create_http_client(self) -> httpx.AsyncClient:
        limits = httpx.Limits(
            max_connections=SUPABASE_MAX_CONNECTIONS,
            max_keepalive_connections=SUPABASE_MAX_KEEPALIVE,
            keepalive_expiry=30.0,
        )
        
        timeout = httpx.Timeout(
            connect=SUPABASE_CONNECT_TIMEOUT,
            read=SUPABASE_READ_TIMEOUT,
            write=SUPABASE_WRITE_TIMEOUT,
            pool=SUPABASE_POOL_TIMEOUT,
        )
        
        return httpx.AsyncClient(
            limits=limits,
            timeout=timeout,
            http2=True,
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
            
            self._http_client = self._create_http_client()
            
            options = AsyncClientOptions(
                postgrest_client_timeout=SUPABASE_READ_TIMEOUT,
            )
            
            self._client = await create_async_client(
                supabase_url, 
                supabase_key,
                options=options
            )
            
            if hasattr(self._client, 'postgrest') and hasattr(self._client.postgrest, '_session'):
                self._client.postgrest._session = self._http_client
            
            self._initialized = True
            key_type = "SERVICE_ROLE_KEY" if config.SUPABASE_SERVICE_ROLE_KEY else "ANON_KEY"
            logger.info(
                f"Database connection initialized with Supabase using {key_type} "
                f"(max_conn={SUPABASE_MAX_CONNECTIONS}, connect_timeout={SUPABASE_CONNECT_TIMEOUT}s)"
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
