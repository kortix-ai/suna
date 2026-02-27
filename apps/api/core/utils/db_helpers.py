"""
Centralized database dependency helpers.

This module provides reusable FastAPI dependencies for database connections,
reducing duplication across 50+ files.
"""
from typing import AsyncGenerator
from core.services.supabase import DBConnection
from core.utils.logger import logger


_db_instance: DBConnection | None = None


async def get_db() -> DBConnection:
    """
    FastAPI dependency for database connection.
    
    Returns initialized DBConnection singleton.
    Use as: db = Depends(get_db)
    """
    global _db_instance
    
    if _db_instance is None:
        _db_instance = DBConnection()
        await _db_instance.initialize()
        logger.debug("Database connection initialized via dependency")
    
    return _db_instance


async def get_db_client():
    """
    FastAPI dependency that returns the actual Supabase client.
    
    Use as: client = Depends(get_db_client)
    """
    db = await get_db()
    return await db.client


# For modules that need to set a module-level db variable
def get_initialized_db() -> DBConnection:
    """
    Get or create initialized DBConnection for module-level usage.
    
    This is for backward compatibility with modules using global db variables.
    New code should use get_db() dependency instead.
    """
    global _db_instance
    
    if _db_instance is None:
        _db_instance = DBConnection()
        # Note: Cannot await here, caller must call initialize() separately
        logger.debug("Created DBConnection instance (needs initialization)")
    
    return _db_instance

