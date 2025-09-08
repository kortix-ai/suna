"""
Centralized database connection management for AgentPress using Supabase.
"""

from typing import Optional
from supabase import create_async_client, AsyncClient
from core.utils.logger import logger
from core.utils.config import config
import base64
import uuid
from datetime import datetime
import threading

class DBConnection:
    """Thread-safe singleton database connection manager using Supabase."""
    
    _instance: Optional['DBConnection'] = None
    _lock = threading.Lock()

    def __new__(cls):
        if cls._instance is None:
            with cls._lock:
                # Double-check locking pattern
                if cls._instance is None:
                    cls._instance = super().__new__(cls)
                    cls._instance._initialized = False
                    cls._instance._client = None
        return cls._instance

    def __init__(self):
        """No initialization needed in __init__ as it's handled in __new__"""
        pass

    async def initialize(self):
        """Initialize the database connection."""
        if self._initialized:
            return
                
        try:
            supabase_url = config.SUPABASE_URL
            # Use service role key preferentially for backend operations
            supabase_key = config.SUPABASE_SERVICE_ROLE_KEY or config.SUPABASE_ANON_KEY
            
            if not supabase_url or not supabase_key:
                logger.error("Missing required environment variables for Supabase connection")
                raise RuntimeError("SUPABASE_URL and a key (SERVICE_ROLE_KEY or ANON_KEY) environment variables must be set.")

            logger.debug("Initializing Supabase connection")
            
            # Create Supabase client with timeout configuration
            self._client = await create_async_client(
                supabase_url, 
                supabase_key,
            )
            
            self._initialized = True
            key_type = "SERVICE_ROLE_KEY" if config.SUPABASE_SERVICE_ROLE_KEY else "ANON_KEY"
            logger.debug(f"Database connection initialized with Supabase using {key_type}")
            
        except Exception as e:
            logger.error(f"Database initialization error: {e}")
            raise RuntimeError(f"Failed to initialize database connection: {str(e)}")

    @classmethod
    async def disconnect(cls):
        """Disconnect from the database."""
        if cls._instance and cls._instance._client:
            logger.debug("Disconnecting from Supabase database")
            try:
                # Close Supabase client
                if hasattr(cls._instance._client, 'close'):
                    await cls._instance._client.close()
                    
            except Exception as e:
                logger.warning(f"Error during disconnect: {e}")
            finally:
                cls._instance._initialized = False
                cls._instance._client = None
                logger.debug("Database disconnected successfully")

    @property
    async def client(self) -> AsyncClient:
        """Get the Supabase client instance."""
        if not self._initialized:
            logger.debug("Supabase client not initialized, initializing now")
            await self.initialize()
        if not self._client:
            logger.error("Database client is None after initialization")
            raise RuntimeError("Database not initialized")
        return self._client
