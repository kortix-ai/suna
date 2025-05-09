import asyncio
import json
from typing import List, Any, Optional
from datetime import datetime, timezone
from utils.logger import logger
from services.supabase import DBConnection
from services import redis as redis_service # Renamed to avoid conflict if 'redis' is used as a variable

# Global variables for initialized services in the worker context (simplified)
# In a more robust setup, these might be managed by Celery signals (e.g., worker_process_init)
# or passed around. For now, we'll aim to initialize them as needed or ensure they are.
_db_connection_local: Optional[DBConnection] = None
_redis_initialized_local = False

REDIS_RESPONSE_LIST_TTL = 3600 * 24 # Copied from agent/api.py

async def get_db_connection() -> DBConnection:
    global _db_connection_local
    if _db_connection_local is None or not _db_connection_local.is_initialized:
        _db_connection_local = DBConnection()
        await _db_connection_local.initialize()
        logger.info("DBConnection object initialized in run_utils")
    return _db_connection_local

async def get_db_client():
    conn = await get_db_connection()
    return await conn.client

async def ensure_redis_initialized():
    global _redis_initialized_local
    if not _redis_initialized_local:
        try:
            await redis_service.initialize_async()
            _redis_initialized_local = True
            logger.info("Redis initialized in run_utils")
        except Exception as e:
            logger.error(f"Failed to initialize Redis in run_utils: {e}")
            # Decide how to handle this - raise, or let functions fail later?
            # For now, subsequent redis calls will likely fail.
            _redis_initialized_local = False # Ensure it stays false if failed
            raise # Re-raise for clarity of failure

async def update_agent_run_status(
    agent_run_id: str,
    status: str,
    error: Optional[str] = None,
    responses: Optional[List[Any]] = None,
    db_client_override=None # Allow passing client, e.g. from a transaction
) -> bool:
    """
    Centralized function to update agent run status.
    Returns True if update was successful.
    Manages its own DB client if not provided.
    """
    client = db_client_override if db_client_override else await (await get_db_connection()).client
    try:
        update_data = {
            "status": status,
            "updated_at": datetime.now(timezone.utc).isoformat() 
        }
        # Only set completed_at if status indicates completion
        if status in ["completed", "failed", "stopped", "cancelled", "error"]: # Added more terminal states
             update_data["completed_at"] = datetime.now(timezone.utc).isoformat()

        if error:
            update_data["error"] = error

        if responses is not None: # Allow empty list for responses
            update_data["responses"] = responses

        for retry in range(3):
            try:
                update_result = await client.table('agent_runs').update(update_data).eq("id", agent_run_id).execute()
                if hasattr(update_result, 'data') and update_result.data:
                    logger.info(f"Successfully updated agent run {agent_run_id} status to '{status}' (retry {retry})")
                    # Optional: Verification step can be added here if critical
                    return True
                else:
                    logger.warning(f"DB update returned no data for agent run {agent_run_id} (status: {status}) on retry {retry}: {update_result}")
                    if retry == 2:
                        logger.error(f"Failed to update agent run status after all retries: {agent_run_id}")
                        return False
            except Exception as db_error:
                logger.error(f"DB error on retry {retry} updating status for {agent_run_id}: {str(db_error)}")
                if retry < 2:
                    await asyncio.sleep(0.5 * (2 ** retry))
                else:
                    logger.error(f"Failed to update agent run status after all retries: {agent_run_id}", exc_info=True)
                    return False
        return False # Should be unreachable if loop finishes
    except Exception as e:
        logger.error(f"Unexpected error updating agent run status for {agent_run_id}: {str(e)}", exc_info=True)
        return False

async def _cleanup_redis_response_list(agent_run_id: str):
    """Set TTL on the Redis response list."""
    await ensure_redis_initialized()
    response_list_key = f"agent_run:{agent_run_id}:responses"
    try:
        await redis_service.expire(response_list_key, REDIS_RESPONSE_LIST_TTL)
        logger.debug(f"Set TTL ({REDIS_RESPONSE_LIST_TTL}s) on response list: {response_list_key}")
    except Exception as e:
        logger.warning(f"Failed to set TTL on response list {response_list_key}: {str(e)}")

async def stop_agent_run(agent_run_id: str, error_message: Optional[str] = None, instance_id_for_cleanup: Optional[str] = None):
    """
    Update database and publish stop signal to Redis.
    Manages its own DB and Redis connections.
    `instance_id_for_cleanup` is the specific instance_id whose active_run key should be cleared.
    If other instances are processing the same run, their keys are found via a pattern match.
    """
    logger.info(f"Stopping agent run: {agent_run_id}")
    db_conn = await get_db_connection()
    client = await db_conn.client
    await ensure_redis_initialized()
    
    final_status = "failed" if error_message else "stopped"

    all_responses = []
    try:
        response_list_key = f"agent_run:{agent_run_id}:responses"
        all_responses_json = await redis_service.lrange(response_list_key, 0, -1)
        all_responses = [json.loads(r) for r in all_responses_json]
        logger.info(f"Fetched {len(all_responses)} responses from Redis for DB update on stop/fail: {agent_run_id}")
    except Exception as e:
        logger.error(f"Failed to fetch responses from Redis for {agent_run_id} during stop/fail: {e}")

    update_success = await update_agent_run_status(
        agent_run_id, final_status, error=error_message, responses=all_responses, db_client_override=client
    )

    if not update_success:
        logger.error(f"Failed to update database status for stopped/failed run {agent_run_id}")

    # Send STOP signal to the global control channel
    global_control_channel = f"agent_run:{agent_run_id}:control"
    try:
        await redis_service.publish(global_control_channel, "STOP")
        logger.debug(f"Published STOP signal to global channel {global_control_channel}")
    except Exception as e:
        logger.error(f"Failed to publish STOP signal to global channel {global_control_channel}: {str(e)}")

    # Clean up instance-specific keys and signal instance-specific channels
    try:
        # First, try to clean up the specific instance's key if instance_id_for_cleanup is provided
        if instance_id_for_cleanup:
            specific_instance_key = f"active_run:{instance_id_for_cleanup}:{agent_run_id}"
            await _cleanup_redis_instance_key(agent_run_id, instance_id_for_cleanup) # Call specific cleanup

        # Then, find all other potentially active instances and signal them (this might be redundant if global signal is enough)
        # This logic might need refinement based on how multiple workers/instances coordinate for the SAME agent_run_id.
        # Typically, one agent_run_id is handled by one worker.
        instance_keys = await redis_service.keys(f"active_run:*:{agent_run_id}")
        logger.debug(f"Found {len(instance_keys)} active instance keys for agent run {agent_run_id} during stop")

        for key in instance_keys:
            parts = key.split(":")
            if len(parts) == 3:
                instance_id_from_key = parts[1]
                # Also clean up these keys, as stop_agent_run implies the run is over for everyone
                await redis_service.delete(key) 
                logger.debug(f"Deleted active_run key {key} during stop_agent_run.")
                
                instance_control_channel = f"agent_run:{agent_run_id}:control:{instance_id_from_key}"
                try:
                    await redis_service.publish(instance_control_channel, "STOP")
                    logger.debug(f"Published STOP signal to instance channel {instance_control_channel}")
                except Exception as e:
                    logger.warning(f"Failed to publish STOP signal to instance channel {instance_control_channel}: {str(e)}")
            else:
                 logger.warning(f"Unexpected key format found: {key}")
        
        await _cleanup_redis_response_list(agent_run_id)

    except Exception as e:
        logger.error(f"Failed to find/signal active instances or cleanup keys for {agent_run_id}: {str(e)}")

    logger.info(f"Successfully initiated stop process for agent run: {agent_run_id}")


async def _cleanup_redis_instance_key(agent_run_id: str, instance_id: str):
    """Clean up the instance-specific Redis key for an agent run."""
    if not instance_id: # instance_id is now a required param for this specific version
        logger.warning("Instance ID not provided to _cleanup_redis_instance_key, cannot clean up instance key.")
        return
    
    await ensure_redis_initialized()
    key = f"active_run:{instance_id}:{agent_run_id}"
    logger.debug(f"Cleaning up Redis instance key: {key}")
    try:
        await redis_service.delete(key)
        logger.debug(f"Successfully cleaned up Redis key: {key}")
    except Exception as e:
        logger.warning(f"Failed to clean up Redis key {key}: {str(e)}")

# Functions to be called from Celery worker lifecycle (signals)
async def worker_init_services():
    """Initialize services when a Celery worker process starts."""
    logger.info("Celery worker process initializing services...")
    await get_db_connection() # Initialize DB Connection object
    await ensure_redis_initialized() # Initialize Redis
    logger.info("Celery worker process services initialized.")

async def worker_shutdown_services():
    """Clean up services when a Celery worker process shuts down."""
    logger.info("Celery worker process shutting down services...")
    global _db_connection_local, _redis_initialized_local
    if _db_connection_local and _db_connection_local.is_initialized:
        await _db_connection_local.disconnect()
        logger.info("DBConnection disconnected in worker_shutdown_services.")
    _db_connection_local = None
    
    if _redis_initialized_local:
        try:
            await redis_service.close() # Assuming redis_service has a close method
            logger.info("Redis connection closed in worker_shutdown_services.")
        except Exception as e:
            logger.error(f"Error closing Redis connection in worker: {e}")
    _redis_initialized_local = False
    logger.info("Celery worker process services shut down.") 