#!/usr/bin/env python3
"""
Reset monthly usage for all users - Admin script

This script resets monthly usage tracking for all users back to $0,
giving everyone fresh free tier limits. Use with caution.

Usage:
    python reset_all_user_usage.py [--dry-run] [--with-conversations]
"""

import asyncio
import argparse
import sys
from datetime import datetime
from typing import Dict, List
from services.supabase import DBConnection
from services.redis import get_client
from utils.logger import logger
from utils.config import config


async def get_all_users_usage_stats(client) -> List[Dict]:
    """Get current usage stats for all users."""
    try:
        result = await client.table('credit_balance') \
            .select('user_id, balance_dollars, total_purchased, total_used, last_updated') \
            .execute()
        
        return result.data if result.data else []
        
    except Exception as e:
        logger.error(f"Error fetching user usage stats: {e}")
        return []


async def count_usage_records(client) -> int:
    """Count total credit_usage records."""
    try:
        result = await client.table('credit_usage') \
            .select('id', count='exact') \
            .execute()
        
        return result.count if result.count else 0
        
    except Exception as e:
        logger.error(f"Error counting usage records: {e}")
        return 0


async def reset_all_user_usage(dry_run: bool = False, include_conversations: bool = False) -> Dict:
    """Reset usage for all users."""
    stats = {
        "users_processed": 0,
        "usage_records_deleted": 0,
        "users_reset": 0,
        "conversations_deleted": 0,
        "errors": 0
    }
    
    try:
        # Initialize database
        db = DBConnection()
        await db.initialize()
        client = await db.client
        logger.info("✓ Connected to Supabase")
        
        # Get current stats
        users_before = await get_all_users_usage_stats(client)
        usage_records_count = await count_usage_records(client)
        
        logger.info(f"Found {len(users_before)} users with usage data")
        logger.info(f"Found {usage_records_count} total usage records")
        
        # Show users with usage > 0
        users_with_usage = [u for u in users_before if u['total_used'] > 0]
        logger.info(f"Users currently over $0 usage: {len(users_with_usage)}")
        
        for user in users_with_usage[:5]:  # Show first 5 as example
            logger.info(f"  User {user['user_id'][:8]}... - Used: ${user['total_used']}")
        
        if dry_run:
            logger.info("\n[DRY RUN] Would perform the following actions:")
            logger.info(f"  - Delete {usage_records_count} credit_usage records")
            logger.info(f"  - Reset total_used to 0 for {len(users_with_usage)} users") 
            if include_conversations:
                logger.info(f"  - Delete ALL conversations and agent runs")
            logger.info(f"  - Clear Redis cache for all users")
            return stats
        
        logger.info("\n🧹 Starting cleanup process...")
        
        # Step 1: Delete all credit_usage records
        logger.info("Step 1: Deleting all credit usage records...")
        delete_result = await client.table('credit_usage').delete().neq('id', '00000000-0000-0000-0000-000000000000').execute()
        stats["usage_records_deleted"] = usage_records_count
        logger.info(f"✓ Deleted all credit_usage records")
        
        # Step 2: Reset total_used for all users
        logger.info("Step 2: Resetting total_used for all users...")
        reset_result = await client.table('credit_balance') \
            .update({'total_used': 0, 'last_updated': datetime.now().isoformat()}) \
            .gt('total_used', 0) \
            .execute()
        stats["users_reset"] = len(users_with_usage)
        logger.info(f"✓ Reset usage for {len(users_with_usage)} users")
        
        # Step 3: [OPTIONAL] Delete conversations and agent runs
        if include_conversations:
            logger.info("Step 3: Deleting all conversations and agent runs...")
            
            # Delete agent_runs first (they reference threads)
            runs_result = await client.table('agent_runs').delete().neq('id', '00000000-0000-0000-0000-000000000000').execute()
            
            # Delete threads (this cascades to messages)
            threads_result = await client.table('threads').delete().neq('thread_id', '00000000-0000-0000-0000-000000000000').execute()
            
            # Delete projects (this removes sandbox data)
            projects_result = await client.table('projects').delete().neq('project_id', '00000000-0000-0000-0000-000000000000').execute()
            
            stats["conversations_deleted"] = 1  # Flag that conversations were deleted
            logger.info("✓ Deleted all conversations, agent runs, and projects")
        
        # Step 4: Clear Redis cache
        logger.info("Step 4: Clearing Redis usage cache...")
        try:
            redis = await get_client()
            
            # Clear monthly usage cache for all users
            keys = []
            async for key in redis.scan_iter(match="cache:monthly_usage:*"):
                keys.append(key)
            
            if keys:
                await redis.delete(*keys)
                logger.info(f"✓ Cleared {len(keys)} usage cache entries from Redis")
            else:
                logger.info("✓ No usage cache entries found in Redis")
                
        except Exception as redis_error:
            logger.warning(f"Redis cache clear failed: {redis_error}")
        
        # Step 5: Log the admin action
        logger.info("Step 5: Logging admin action...")
        for user in users_with_usage:
            await client.table('credit_usage').insert({
                'user_id': user['user_id'],
                'amount_dollars': 0.01,
                'description': f'ADMIN: Global usage reset - all users monthly limits restored',
                'usage_type': 'adjustment'
            }).execute()
        
        logger.info("✓ Admin action logged for all affected users")
        
        # Final verification
        users_after = await get_all_users_usage_stats(client)
        usage_after = await count_usage_records(client)
        
        logger.info(f"\n✅ CLEANUP COMPLETED:")
        logger.info(f"  Users processed: {len(users_before)}")
        logger.info(f"  Usage records deleted: {usage_records_count}")
        logger.info(f"  Users reset: {len(users_with_usage)}")
        logger.info(f"  Usage records remaining: {usage_after}")
        
        stats["users_processed"] = len(users_before)
        
        await db.disconnect()
        return stats
        
    except Exception as e:
        logger.error(f"Error in reset process: {e}")
        stats["errors"] = 1
        return stats


def main():
    parser = argparse.ArgumentParser(description="Reset monthly usage for all users")
    parser.add_argument("--dry-run", action="store_true", help="Show what would be done without executing")
    parser.add_argument("--with-conversations", action="store_true", help="Also delete all conversations and agent runs")
    
    args = parser.parse_args()
    
    if args.with_conversations:
        confirm = input("⚠️  WARNING: This will delete ALL user conversations and agent runs. Type 'CONFIRM' to proceed: ")
        if confirm != "CONFIRM":
            print("Aborted.")
            sys.exit(0)
    
    try:
        logger.info("🧹 Starting global usage cleanup...")
        stats = asyncio.run(reset_all_user_usage(args.dry_run, args.with_conversations))
        
        if stats.get("errors", 0) == 0:
            logger.info("✅ Usage cleanup completed successfully")
            sys.exit(0)
        else:
            logger.error("❌ Usage cleanup completed with errors")
            sys.exit(1)
            
    except Exception as e:
        logger.error(f"Script failed: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()


# Usage examples:
#
# 1. Dry run to see what would be cleaned:
# python reset_all_user_usage.py --dry-run
#
# 2. Reset usage for all users (preserves conversations):
# python reset_all_user_usage.py
# 
# 3. Complete reset including conversations (DANGEROUS):
# python reset_all_user_usage.py --with-conversations
#
