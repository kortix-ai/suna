#!/usr/bin/env python3
"""
Cleanup script to remove old Redis keys with expired TTLs.

This script safely removes old keys that were created with 24h TTLs
before we reduced them to 1-2h. It only deletes keys that are safe to remove:
- Old agent_run response lists (data is in DB anyway)
- Old agent_config cache entries (will be regenerated)
- Old project metadata cache (will be regenerated)

DO NOT DELETE:
- Dramatiq queue keys (dramatiq:*)
- Active agent runs (check if still running)
- Thread counts (active data)
"""

import asyncio
import os
import sys
from datetime import datetime, timezone, timedelta
from dotenv import load_dotenv

# Add backend directory to path
backend_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
sys.path.insert(0, backend_dir)

load_dotenv()

from core.services import redis as redis_service
from core.utils.logger import logger


# Key patterns to clean up (safe to delete - will be regenerated)
SAFE_PATTERNS = [
    "agent_run:*:responses",  # Old response lists (data in DB)
    "agent_config:*",  # Old config cache (will regenerate)
    "agent_mcps:*",  # Old MCP cache (will regenerate)
    "project:*",  # Old project metadata (will regenerate)
]

# Keys to NEVER delete
PROTECTED_PATTERNS = [
    "dramatiq:*",  # Queue messages
    "active_run:*",  # Active runs tracking
    "thread_count:*",  # Thread counts
    "api_key:*",  # API key validation cache
    "last_used_throttle:*",  # Throttle cache
    "account_state:*",  # Account state cache
]


async def get_all_keys_matching_pattern(pattern: str, redis_client) -> list:
    """Get all keys matching a pattern using SCAN."""
    keys = []
    cursor = 0
    
    while True:
        cursor, batch = await redis_client.scan(cursor, match=pattern, count=1000)
        keys.extend([k.decode() if isinstance(k, bytes) else k for k in batch])
        if cursor == 0:
            break
    
    return keys


async def is_key_safe_to_delete(key: str) -> bool:
    """Check if a key is safe to delete."""
    # Never delete protected keys
    for protected in PROTECTED_PATTERNS:
        if protected.replace("*", "") in key:
            return False
    return True


async def get_key_ttl(redis_client, key: str) -> int:
    """Get TTL for a key (-1 if no expiry, -2 if doesn't exist)."""
    return await redis_client.ttl(key)


async def cleanup_old_keys():
    """Clean up old Redis keys."""
    logger.info("🔍 Starting Redis key cleanup...")
    
    try:
        await redis_service.initialize_async()
        redis_client = await redis_service.get_client()
        
        total_deleted = 0
        total_scanned = 0
        
        # Process each safe pattern
        for pattern in SAFE_PATTERNS:
            logger.info(f"📋 Scanning pattern: {pattern}")
            keys = await get_all_keys_matching_pattern(pattern, redis_client)
            total_scanned += len(keys)
            
            deleted_count = 0
            for key in keys:
                if not await is_key_safe_to_delete(key):
                    logger.debug(f"⏭️  Skipping protected key: {key}")
                    continue
                
                # Check TTL - if it's very long (> 12 hours), it's likely an old key
                ttl = await get_key_ttl(redis_client, key)
                
                if ttl == -2:
                    # Key doesn't exist, skip
                    continue
                elif ttl == -1:
                    # No expiry set - safe to delete if it's an old pattern
                    logger.debug(f"🗑️  Deleting key without TTL: {key}")
                    await redis_client.delete(key)
                    deleted_count += 1
                    total_deleted += 1
                elif ttl > 12 * 3600:  # More than 12 hours remaining
                    # Likely an old key with 24h TTL - delete it
                    logger.debug(f"🗑️  Deleting old key (TTL: {ttl}s): {key}")
                    await redis_client.delete(key)
                    deleted_count += 1
                    total_deleted += 1
            
            logger.info(f"✅ Pattern {pattern}: Deleted {deleted_count} keys")
        
        logger.info(f"🎉 Cleanup complete! Scanned {total_scanned} keys, deleted {total_deleted} old keys")
        
        # Get memory info
        try:
            info = await redis_client.info("memory")
            used_memory_mb = info.get("used_memory", 0) / (1024 * 1024)
            logger.info(f"📊 Redis memory usage: {used_memory_mb:.2f} MB")
        except Exception as e:
            logger.warning(f"Could not get memory info: {e}")
        
    except Exception as e:
        logger.error(f"❌ Error during cleanup: {e}", exc_info=True)
        raise
    finally:
        try:
            await redis_service.close()
        except Exception:
            pass


if __name__ == "__main__":
    asyncio.run(cleanup_old_keys())

