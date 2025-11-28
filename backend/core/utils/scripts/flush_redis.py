#!/usr/bin/env python3
"""
Flush Redis database - with options to protect Dramatiq queues.

Options:
1. Flush everything (including Dramatiq queues) - USE WITH CAUTION
2. Flush everything EXCEPT Dramatiq queues (safer)
3. Flush only cache keys (safest)

Dramatiq keys that will be protected (unless --full flag):
- dramatiq:default (main queue)
- dramatiq:default.DQ (delay queue)
- dramatiq:default.XQ (dead letter queue)
- dramatiq:* (all Dramatiq keys)
"""

import asyncio
import os
import sys
import argparse
from dotenv import load_dotenv

# Add backend directory to path
backend_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
sys.path.insert(0, backend_dir)

load_dotenv()

from core.services import redis as redis_service
from core.utils.logger import logger


# Dramatiq key patterns to protect (unless --full flag)
DRAMATIQ_PATTERNS = [
    "dramatiq:*",  # All Dramatiq keys
]


async def get_all_keys(redis_client) -> list:
    """Get all keys using SCAN."""
    keys = []
    cursor = 0
    
    while True:
        cursor, batch = await redis_client.scan(cursor, count=1000)
        keys.extend([k.decode() if isinstance(k, bytes) else k for k in batch])
        if cursor == 0:
            break
    
    return keys


async def is_dramatiq_key(key: str) -> bool:
    """Check if key belongs to Dramatiq."""
    return key.startswith("dramatiq:")


async def flush_redis(full: bool = False, cache_only: bool = False):
    """Flush Redis database."""
    if full:
        logger.warning("⚠️  FULL FLUSH MODE - Will delete EVERYTHING including Dramatiq queues!")
        logger.warning("⚠️  This will lose all queued jobs!")
    elif cache_only:
        logger.info("🧹 CACHE-ONLY MODE - Will only delete cache keys")
    else:
        logger.info("🛡️  SAFE MODE - Will protect Dramatiq queues")
    
    try:
        await redis_service.initialize_async()
        redis_client = await redis_service.get_client()
        
        # Get all keys
        logger.info("🔍 Scanning all Redis keys...")
        all_keys = await get_all_keys(redis_client)
        total_keys = len(all_keys)
        logger.info(f"📊 Found {total_keys} total keys")
        
        # Count Dramatiq keys
        dramatiq_keys = [k for k in all_keys if await is_dramatiq_key(k)]
        logger.info(f"📋 Found {len(dramatiq_keys)} Dramatiq keys")
        
        if dramatiq_keys:
            logger.info(f"   Examples: {dramatiq_keys[:5]}")
        
        # Determine which keys to delete
        if full:
            keys_to_delete = all_keys
            logger.warning(f"🗑️  Will delete ALL {total_keys} keys (including Dramatiq)")
        elif cache_only:
            # Only delete cache-like keys
            cache_patterns = [
                "agent_run:", "agent_config:", "agent_mcps:", "project:",
                "api_key:", "account_state:", "cache:", "thread_count:"
            ]
            keys_to_delete = [
                k for k in all_keys 
                if not await is_dramatiq_key(k) and any(p in k for p in cache_patterns)
            ]
            logger.info(f"🗑️  Will delete {len(keys_to_delete)} cache keys")
        else:
            # Safe mode: delete everything except Dramatiq
            keys_to_delete = [k for k in all_keys if not await is_dramatiq_key(k)]
            logger.info(f"🗑️  Will delete {len(keys_to_delete)} keys (protecting {len(dramatiq_keys)} Dramatiq keys)")
        
        # Confirm
        if not full and not cache_only:
            logger.info(f"✅ Safe to proceed - Dramatiq queues will be preserved")
        else:
            logger.warning(f"⚠️  About to delete {len(keys_to_delete)} keys")
        
        # Delete keys in batches
        deleted = 0
        batch_size = 1000
        for i in range(0, len(keys_to_delete), batch_size):
            batch = keys_to_delete[i:i + batch_size]
            await redis_client.delete(*batch)
            deleted += len(batch)
            logger.info(f"🗑️  Deleted {deleted}/{len(keys_to_delete)} keys...")
        
        logger.info(f"🎉 Flush complete! Deleted {deleted} keys")
        
        # Get memory info
        try:
            info = await redis_client.info("memory")
            used_memory_mb = info.get("used_memory", 0) / (1024 * 1024)
            max_memory_mb = info.get("maxmemory", 0) / (1024 * 1024) if info.get("maxmemory", 0) > 0 else 0
            logger.info(f"📊 Redis memory: {used_memory_mb:.2f} MB / {max_memory_mb:.2f} MB ({used_memory_mb/max_memory_mb*100:.1f}%)" if max_memory_mb > 0 else f"📊 Redis memory: {used_memory_mb:.2f} MB")
        except Exception as e:
            logger.warning(f"Could not get memory info: {e}")
        
    except Exception as e:
        logger.error(f"❌ Error during flush: {e}", exc_info=True)
        raise
    finally:
        try:
            await redis_service.close()
        except Exception:
            pass


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Flush Redis database")
    parser.add_argument(
        "--full",
        action="store_true",
        help="Flush EVERYTHING including Dramatiq queues (DANGEROUS - will lose queued jobs)"
    )
    parser.add_argument(
        "--cache-only",
        action="store_true",
        help="Only flush cache keys (safest option)"
    )
    
    args = parser.parse_args()
    
    if args.full and args.cache_only:
        logger.error("Cannot use --full and --cache-only together")
        sys.exit(1)
    
    asyncio.run(flush_redis(full=args.full, cache_only=args.cache_only))

