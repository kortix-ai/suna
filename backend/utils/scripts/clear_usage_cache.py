#!/usr/bin/env python3
"""
Clear Redis cache for usage tracking - Admin script

This script clears all cached monthly usage data from Redis to ensure
fresh calculations after database usage cleanup.

Usage:
    python clear_usage_cache.py [--user-id USER_ID] [--all-users] [--dry-run]
"""

import asyncio
import argparse
import sys
from typing import Optional
from services.redis import get_client
from utils.logger import logger
from services.supabase import DBConnection


async def clear_user_usage_cache(user_id: str, dry_run: bool = False) -> int:
    """Clear monthly usage cache for a specific user."""
    try:
        redis = await get_client()
        cache_key = f"cache:monthly_usage:{user_id}"
        
        if dry_run:
            exists = await redis.exists(cache_key)
            logger.info(f"[DRY RUN] Would clear cache key: {cache_key} (exists: {exists})")
            return 1 if exists else 0
        else:
            deleted = await redis.delete(cache_key)
            logger.info(f"Cleared cache key: {cache_key} (deleted: {deleted})")
            return deleted
            
    except Exception as e:
        logger.error(f"Error clearing cache for user {user_id}: {e}")
        return 0


async def clear_all_usage_cache(dry_run: bool = False) -> int:
    """Clear monthly usage cache for all users."""
    try:
        redis = await get_client()
        pattern = "cache:monthly_usage:*"
        
        # Find all matching keys
        keys = []
        async for key in redis.scan_iter(match=pattern):
            keys.append(key)
        
        if not keys:
            logger.info("No usage cache keys found")
            return 0
            
        if dry_run:
            logger.info(f"[DRY RUN] Would clear {len(keys)} usage cache keys:")
            for key in keys[:10]:  # Show first 10 as example
                logger.info(f"  - {key}")
            if len(keys) > 10:
                logger.info(f"  ... and {len(keys) - 10} more")
            return len(keys)
        else:
            # Delete all keys
            if keys:
                deleted = await redis.delete(*keys)
                logger.info(f"Cleared {deleted} usage cache keys from Redis")
                return deleted
            return 0
            
    except Exception as e:
        logger.error(f"Error clearing all usage cache: {e}")
        return 0


async def get_all_user_ids() -> list[str]:
    """Get all user IDs from database."""
    try:
        db = DBConnection()
        await db.initialize()
        client = await db.client
        
        result = await client.table('credit_balance').select('user_id').execute()
        user_ids = [row['user_id'] for row in result.data] if result.data else []
        
        await db.disconnect()
        return user_ids
        
    except Exception as e:
        logger.error(f"Error fetching user IDs: {e}")
        return []


async def main():
    parser = argparse.ArgumentParser(description="Clear Redis usage cache")
    parser.add_argument("--user-id", help="Clear cache for specific user ID")
    parser.add_argument("--all-users", action="store_true", help="Clear cache for all users")
    parser.add_argument("--dry-run", action="store_true", help="Show what would be cleared without doing it")
    
    args = parser.parse_args()
    
    if not args.user_id and not args.all_users:
        print("Error: Must specify either --user-id or --all-users")
        sys.exit(1)
    
    if args.user_id and args.all_users:
        print("Error: Cannot specify both --user-id and --all-users")
        sys.exit(1)
    
    try:
        if args.user_id:
            logger.info(f"Clearing cache for user: {args.user_id}")
            cleared = await clear_user_usage_cache(args.user_id, args.dry_run)
            logger.info(f"Total cleared: {cleared}")
            
        elif args.all_users:
            logger.info("Clearing cache for all users...")
            cleared = await clear_all_usage_cache(args.dry_run)
            logger.info(f"Total cleared: {cleared}")
            
        logger.info("✅ Cache cleanup completed successfully")
        
    except Exception as e:
        logger.error(f"Cache cleanup failed: {e}")
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())


# Usage examples:
#
# 1. Clear cache for specific user:
# python clear_usage_cache.py --user-id "123e4567-e89b-12d3-a456-426614174000" --dry-run
# 
# 2. Clear cache for all users:
# python clear_usage_cache.py --all-users --dry-run
#
# 3. Actually execute (remove --dry-run):
# python clear_usage_cache.py --all-users
