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
        
        return cleaned_count
        
    except Exception as e:
        logger.error(f"Failed to query orphaned agent runs: {e}")
        return 0
