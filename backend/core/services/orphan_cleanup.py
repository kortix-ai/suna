"""
Orphan cleanup service for agent runs and Redis streams.

INSTANCE-AWARE DESIGN:
- Each agent run stores its instance_id in metadata
- On startup, we ONLY clean up runs that belonged to THIS instance
- We NEVER touch runs or Redis streams from other instances
- This prevents one instance from killing agents running on other instances

Handles cleanup of:
- Agent runs stuck in "running" status from THIS instance (on startup after crash)
- Legacy runs without instance_id (backward compatibility, only if very old)

This runs on API startup to ensure clean state for THIS instance only.
"""
import asyncio
import json as json_lib
from datetime import datetime, timezone, timedelta

from core.utils.logger import logger
from core.services import redis
from core.agents.runner.agent_runner import update_agent_run_status
from core.utils.instance import get_instance_id


async def cleanup_orphaned_agent_runs(db_client) -> int:
    """
    Clean up orphaned agent runs on startup - INSTANCE-AWARE.
    
    This function ONLY cleans up runs that:
    1. Have status='running' AND belong to THIS instance (via metadata.instance_id)
    2. Are legacy runs without instance_id that are > 1 hour old (backward compat)
    
    Runs from OTHER instances are NEVER touched - they may be actively running.
    
    Args:
        db_client: Supabase client instance
        
    Returns:
        Number of orphaned runs cleaned up
    """
    current_instance_id = get_instance_id()
    logger.info(f"🔍 Starting instance-aware orphan cleanup for instance: {current_instance_id}")
    
    try:
        # Get ALL "running" runs to filter by instance
        stale_runs = await db_client.table('agent_runs')\
            .select('id, thread_id, started_at, metadata')\
            .eq('status', 'running')\
            .execute()
        
        if not stale_runs.data:
            logger.info("✅ No orphaned agent runs found on startup")
            return 0
        
        # Filter runs to only those belonging to THIS instance
        # or legacy runs without instance_id that are very old
        now = datetime.now(timezone.utc)
        legacy_cutoff = now - timedelta(hours=1)  # Legacy runs older than 1 hour
        
        runs_to_cleanup = []
        skipped_other_instance = 0
        skipped_recent_legacy = 0
        
        for run in stale_runs.data:
            metadata = run.get('metadata', {})
            if isinstance(metadata, str):
                try:
                    metadata = json_lib.loads(metadata)
                except:
                    metadata = {}
            
            run_instance_id = metadata.get('instance_id')
            
            if run_instance_id == current_instance_id:
                # This run belonged to THIS instance - it's an orphan from our crash
                runs_to_cleanup.append(run)
            elif run_instance_id is None:
                # Legacy run without instance_id - only cleanup if old
                started_at_str = run.get('started_at')
                if started_at_str:
                    try:
                        started_at = datetime.fromisoformat(started_at_str.replace('Z', '+00:00'))
                        if started_at < legacy_cutoff:
                            runs_to_cleanup.append(run)
                        else:
                            skipped_recent_legacy += 1
                    except:
                        # Can't parse date, skip for safety
                        skipped_recent_legacy += 1
                else:
                    skipped_recent_legacy += 1
            else:
                # Run belongs to a DIFFERENT instance - NEVER touch it
                skipped_other_instance += 1
        
        if skipped_other_instance > 0:
            logger.info(f"⏭️ Skipped {skipped_other_instance} runs belonging to other instances")
        if skipped_recent_legacy > 0:
            logger.info(f"⏭️ Skipped {skipped_recent_legacy} recent legacy runs (no instance_id, <1h old)")
        
        if not runs_to_cleanup:
            logger.info("✅ No orphaned agent runs to clean up for this instance")
            return 0
        
        total_runs = len(runs_to_cleanup)
        logger.warning(f"🧹 Found {total_runs} orphaned agent runs for instance {current_instance_id}")
        
        # Process in parallel batches of 50 for efficiency
        BATCH_SIZE = 50
        cleaned_count = 0
        
        async def cleanup_single_run(run):
            """Clean up a single orphaned run."""
            agent_run_id = run['id']
            stream_key = f"agent_run:{agent_run_id}:stream"
            
            try:
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
                    error=f"Orphaned run - instance {current_instance_id} crashed or was restarted",
                    account_id=account_id
                )
                
                # Clean up Redis keys for THIS run only
                try:
                    redis_client = await redis.get_client()
                    await redis_client.delete(f"stop:{agent_run_id}")
                    await redis_client.delete(stream_key)
                    logger.debug(f"🧹 Deleted Redis keys for orphaned run {agent_run_id}")
                except Exception as e:
                    logger.warning(f"Failed to delete Redis keys for {agent_run_id}: {e}")
                
                return True
                    
            except Exception as e:
                logger.error(f"Failed to cleanup orphaned run {agent_run_id}: {e}")
                return False
        
        # Process in batches
        for i in range(0, total_runs, BATCH_SIZE):
            batch = runs_to_cleanup[i:i + BATCH_SIZE]
            batch_num = (i // BATCH_SIZE) + 1
            total_batches = (total_runs + BATCH_SIZE - 1) // BATCH_SIZE
            
            logger.info(f"🧹 Processing batch {batch_num}/{total_batches} ({len(batch)} runs)")
            
            results = await asyncio.gather(*[cleanup_single_run(run) for run in batch], return_exceptions=True)
            batch_cleaned = sum(1 for r in results if r is True)
            cleaned_count += batch_cleaned
        
        logger.info(f"🧹 Cleaned up {cleaned_count}/{total_runs} orphaned agent runs for instance {current_instance_id}")
        
        # NOTE: We deliberately DO NOT call cleanup_orphaned_redis_streams here
        # because it's not instance-aware and would kill streams from other instances
        
        return cleaned_count
        
    except Exception as e:
        logger.error(f"Failed to query orphaned agent runs: {e}")
        return 0


async def cleanup_orphaned_redis_streams(db_client) -> int:
    """
    ⚠️  DEPRECATED - NOT INSTANCE-AWARE - DO NOT USE IN MULTI-INSTANCE DEPLOYMENTS
    
    This function is dangerous in multi-instance deployments because:
    - It scans ALL Redis streams globally
    - It cannot determine which instance owns which stream
    - It may delete streams belonging to other active instances
    
    This function is kept for potential manual cleanup use only.
    It is NOT called during normal startup/shutdown.
    
    If you need to clean up Redis streams, use this function only when:
    - All instances are stopped
    - You're doing a full system maintenance
    
    Args:
        db_client: Supabase client instance
        
    Returns:
        Number of orphaned streams deleted
    """
    logger.warning("⚠️  cleanup_orphaned_redis_streams is NOT instance-aware - use with caution!")
    
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
            logger.debug("✅ No Redis streams found")
            return 0
        
        logger.info(f"🔍 Found {len(orphaned_streams)} Redis streams, checking for orphans...")
        
        # Extract agent_run_ids from stream keys
        stream_run_ids = []
        for key in orphaned_streams:
            key_str = key.decode() if isinstance(key, bytes) else key
            parts = key_str.split(':')
            if len(parts) >= 2:
                stream_run_ids.append(parts[1])
        
        if not stream_run_ids:
            logger.debug("✅ No valid stream run IDs found")
            return 0
        
        logger.info(f"🔍 Extracted {len(stream_run_ids)} run IDs from streams")
        
        # Check which of these runs are actually still 'running' in DB
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
        
        logger.info(f"🔍 Found {len(running_run_ids)} actually running agents in DB")
        
        # Delete streams that don't have a corresponding 'running' DB record
        orphans_to_delete = [rid for rid in stream_run_ids if rid not in running_run_ids]
        
        logger.info(f"🧹 Would clean up {len(orphans_to_delete)} orphaned streams...")
        
        if not orphans_to_delete:
            logger.debug("✅ All Redis streams have corresponding running DB records")
            return 0
        
        # Batch delete
        keys_to_delete = []
        for run_id in orphans_to_delete:
            keys_to_delete.append(f"agent_run:{run_id}:stream")
            keys_to_delete.append(f"stop:{run_id}")
        
        try:
            deleted_count = await redis_client.delete(*keys_to_delete)
            logger.info(f"🧹 Deleted {deleted_count} Redis keys ({len(orphans_to_delete)} orphaned streams)")
        except Exception as e:
            logger.error(f"Failed to batch delete orphaned streams: {e}")
            deleted_count = 0
            for run_id in orphans_to_delete:
                try:
                    await redis_client.delete(f"agent_run:{run_id}:stream")
                    await redis_client.delete(f"stop:{run_id}")
                    deleted_count += 2
                except Exception as e2:
                    logger.warning(f"Failed to delete orphaned stream for {run_id}: {e2}")
        
        return len(orphans_to_delete)
            
    except Exception as e:
        logger.error(f"Failed to cleanup orphaned Redis streams: {e}")
        return 0

