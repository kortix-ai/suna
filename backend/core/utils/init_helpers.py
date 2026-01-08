"""
Helper functions for background task initialization.
"""

import uuid
from core.services.supabase import DBConnection
from core.services import redis
from core.utils.logger import logger
from core.utils.retry import retry
from core.utils.tool_discovery import warm_up_tools_cache

_initialized = False
_db = DBConnection()
_instance_id = ""


async def initialize() -> str:
    """Initialize background task resources (Redis, DB, caches). Returns instance ID."""
    global _initialized, _instance_id, _db

    if _initialized:
        return _instance_id
    
    if not _instance_id:
        _instance_id = str(uuid.uuid4())[:8]
    
    logger.info("Initializing background task resources...")
    
    await retry(lambda: redis.initialize_async())
    await redis.verify_connection()
    await _db.initialize()
    
    warm_up_tools_cache()
    
    try:
        from core.cache.runtime_cache import warm_up_suna_config_cache
        await warm_up_suna_config_cache()
    except Exception as e:
        logger.warning(f"Failed to pre-cache Suna configs (non-fatal): {e}")

    _initialized = True
    logger.info(f"✅ Background task resources initialized (instance: {_instance_id})")
    return _instance_id

