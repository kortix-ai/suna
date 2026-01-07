"""
Orphan cleanup service for agent runs and Redis streams.

Handles cleanup of:
- Agent runs stuck in "running" status from previous instance (on startup)
- Orphaned Redis streams without corresponding DB records

This runs on API startup to ensure clean state and accurate metrics.
"""
import asyncio
import json as json_lib
from datetime import datetime, timezone

from core.utils.logger import logger
from core.services import redis
from core.agents.executor import update_agent_run_status


async def cleanup_orphaned_agent_runs(db_client) -> int:
    """
    Clean up orphaned agent runs on startup.
    
    On server restart, ALL runs with status='running' are orphans since they
    were running on the previous instance which is now gone.
    
    This function:
    1. Marks all "running" runs as "failed" in DB
    2. Deletes corresponding Redis streams and stop signals
    3. Cleans up any orphaned Redis streams without matching DB records
    
    Args:
        db_client: Supabase client instance
        
    Returns:
        Number of orphaned runs cleaned up
    """
    try:
        # Get ALL "running" runs - on startup, any running run is orphaned
        stale_runs = await db_client.table('agent_runs')\
            .select('id, thread_id, started_at, metadata')\
            .eq('status', 'running')\
            .execute()
        
        if not stale_runs.data:
            logger.info("✅ No orphaned agent runs found on startup")
            # Still check for orphaned Redis streams
            await cleanup_orphaned_redis_streams(db_client)
            return 0
        
        total_runs = len(stale_runs.data)
        logger.warning(f"🧹 Found {total_runs} orphaned agent runs to clean up (running in parallel batches)")
        
        # Process in parallel batches of 50 for efficiency
        BATCH_SIZE = 50
        cleaned_count = 0
        
        async def cleanup_single_run(run):
            """Clean up a single orphaned run."""
            agent_run_id = run['id']
            stream_key = f"agent_run:{agent_run_id}:stream"
            
            try:
                # On startup, any "running" run is orphaned from the previous instance
                # The stream might exist from a crashed instance that didn't clean up
                
                # Get account_id from metadata for cache invalidation
                metadata = run.get('metadata', {})
                if isinstance(metadata, str):
                    try:
                        metadata = json_lib.loads(metadata)
                    except:
                        metadata = {}
                account_id = metadata.get('actual_user_id')
                
                # Mark as failed
                await update_agent_run_status(
                    agent_run_id,
                    "failed",
                    error="Orphaned run - instance crashed or was restarted",
                    account_id=account_id
                )
                
                # Clean up any leftover Redis keys (stream + stop signal)
                try:
                    redis_client = await redis.get_client()
                    await redis_client.delete(f"stop:{agent_run_id}")
                    await redis_client.delete(stream_key)
                    logger.debug(f"🧹 Deleted Redis keys for orphaned run {agent_run_id}")
                except Exception as e:
                    logger.warning(f"Failed to delete Redis keys for {agent_run_id}: {e}")
                
                return True  # Cleaned
                    
            except Exception as e:
                logger.error(f"Failed to cleanup orphaned run {agent_run_id}: {e}")
                return False
        
        # Process in batches
        for i in range(0, total_runs, BATCH_SIZE):
            batch = stale_runs.data[i:i + BATCH_SIZE]
            batch_num = (i // BATCH_SIZE) + 1
            total_batches = (total_runs + BATCH_SIZE - 1) // BATCH_SIZE
            
            logger.info(f"🧹 Processing batch {batch_num}/{total_batches} ({len(batch)} runs)")
            
            # Run batch in parallel
            results = await asyncio.gather(*[cleanup_single_run(run) for run in batch], return_exceptions=True)
            
            # Count successes
            batch_cleaned = sum(1 for r in results if r is True)
            cleaned_count += batch_cleaned
        
        logger.info(f"🧹 Cleaned up {cleaned_count}/{total_runs} orphaned agent runs")
        
        # Also clean up orphaned Redis streams without corresponding 'running' DB records
        await cleanup_orphaned_redis_streams(db_client)
        
        return cleaned_count
        
    except Exception as e:
        logger.error(f"Failed to query orphaned agent runs: {e}")
        return 0


async def cleanup_orphaned_redis_streams(db_client) -> int:
    """
    Clean up Redis streams that don't have a corresponding 'running' agent run in DB.
    
    This handles orphaned streams from:
    - Previous bugs in cleanup logic
    - Race conditions during shutdown
    - Partial failures during run completion
    
    Args:
        db_client: Supabase client instance
        
    Returns:
        Number of orphaned streams deleted
    """
    try:
        redis_client = await redis.get_client()
        
        # Scan for all agent_run:*:stream keys
        orphaned_streams = []
        cursor = 0
        pattern = "agent_run:*:stream"
        
        while True:
            cursor, keys = await redis_client.scan(cursor, match=pattern, count=100)
            orphaned_streams.extend(keys)
            if cursor == 0:
                break
        
        if not orphaned_streams:
            logger.debug("✅ No orphaned Redis streams found")
            return 0
        
        logger.info(f"🔍 Found {len(orphaned_streams)} Redis streams, checking for orphans...")
        
        # Extract agent_run_ids from stream keys
        # Format: agent_run:{uuid}:stream
        stream_run_ids = []
        for key in orphaned_streams:
            # Handle both bytes and string keys
            key_str = key.decode() if isinstance(key, bytes) else key
            parts = key_str.split(':')
            if len(parts) >= 2:
                stream_run_ids.append(parts[1])
        
        if not stream_run_ids:
            logger.debug("✅ No valid stream run IDs found")
            return 0
        
        logger.info(f"🔍 Extracted {len(stream_run_ids)} run IDs from streams")
        
        # Check which of these runs are actually still 'running' in DB
        # Process in batches to avoid query length limits (Supabase has URL length limits)
        BATCH_SIZE = 50
        running_run_ids = set()
        
        for i in range(0, len(stream_run_ids), BATCH_SIZE):
            batch = stream_run_ids[i:i + BATCH_SIZE]
            batch_num = (i // BATCH_SIZE) + 1
            total_batches = (len(stream_run_ids) + BATCH_SIZE - 1) // BATCH_SIZE
            
            logger.debug(f"🔍 Querying DB batch {batch_num}/{total_batches} ({len(batch)} IDs)")
            
            try:
                running_runs = await db_client.table('agent_runs')\
                    .select('id')\
                    .eq('status', 'running')\
                    .in_('id', batch)\
                    .execute()
                
                if running_runs.data:
                    running_run_ids.update(run['id'] for run in running_runs.data)
            except Exception as e:
                logger.warning(f"Failed to query batch {batch_num}: {e}")
                # Continue with other batches even if one fails
        
        logger.info(f"🔍 Found {len(running_run_ids)} actually running agents in DB")
        
        # Delete streams that don't have a corresponding 'running' DB record
        deleted_count = 0
        orphans_to_delete = [rid for rid in stream_run_ids if rid not in running_run_ids]
        
        logger.info(f"🧹 Cleaning up {len(orphans_to_delete)} orphaned streams...")
        
        if not orphans_to_delete:
            logger.debug("✅ All Redis streams have corresponding running DB records")
            return 0
        
        # Batch delete for performance (avoid N network calls)
        # Collect all keys to delete
        keys_to_delete = []
        for run_id in orphans_to_delete:
            keys_to_delete.append(f"agent_run:{run_id}:stream")
            keys_to_delete.append(f"stop:{run_id}")
        
        # Delete all keys in one batch operation
        try:
            deleted_count = await redis_client.delete(*keys_to_delete)
            logger.info(f"🧹 Deleted {deleted_count} Redis keys ({len(orphans_to_delete)} orphaned streams)")
        except Exception as e:
            logger.error(f"Failed to batch delete orphaned streams: {e}")
            # Fallback to individual deletion if batch fails
            for run_id in orphans_to_delete:
                try:
                    stream_key = f"agent_run:{run_id}:stream"
                    stop_key = f"stop:{run_id}"
                    await redis_client.delete(stream_key)
                    await redis_client.delete(stop_key)
                    deleted_count += 2
                except Exception as e2:
                    logger.warning(f"Failed to delete orphaned stream for {run_id}: {e2}")
        
        return len(orphans_to_delete)
            
    except Exception as e:
        logger.error(f"Failed to cleanup orphaned Redis streams: {e}")
        return 0

