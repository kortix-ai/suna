"""Agent run management utilities - starting, stopping, and monitoring agent runs."""
import json
from typing import Optional, List
from fastapi import HTTPException
from core.services import redis
from ..utils.logger import logger
from run_agent_background import update_agent_run_status, _cleanup_redis_response_list


async def cleanup_instance_runs(instance_id: str):
    """Clean up all running agents for a specific instance."""
    logger.debug(f"Starting cleanup of agent runs for instance {instance_id}")

    try:
        if not instance_id:
            logger.warning("Instance ID not set, cannot clean up instance-specific agent runs.")
            return

        running_keys = await redis.keys(f"active_run:{instance_id}:*")
        logger.debug(f"Found {len(running_keys)} running agent runs for instance {instance_id} to clean up")

        for key in running_keys:
            # Key format: active_run:{instance_id}:{agent_run_id}
            parts = key.split(":")
            if len(parts) == 3:
                agent_run_id = parts[2]
                await stop_agent_run_with_helpers(agent_run_id, error_message=f"Instance {instance_id} shutting down")
            else:
                logger.warning(f"Unexpected key format found: {key}")

    except Exception as e:
        logger.error(f"Failed to clean up running agent runs for instance {instance_id}: {str(e)}")


async def stop_agent_run_with_helpers(agent_run_id: str, error_message: Optional[str] = None):
    """
    Stop an agent run and clean up all associated resources.
    
    This function:
    1. Fetches final responses from Redis
    2. Updates database status
    3. Publishes STOP signals to all control channels
    4. Cleans up Redis keys
    
    Args:
        agent_run_id: The ID of the agent run to stop
        error_message: Optional error message if run failed
    """
    logger.debug(f"Stopping agent run: {agent_run_id}")
    
    # Import here to avoid circular dependency
    from ..core_utils import db
    
    client = await db.client
    final_status = "failed" if error_message else "stopped"

    # Attempt to fetch final responses from Redis
    response_list_key = f"agent_run:{agent_run_id}:responses"
    all_responses = []
    try:
        all_responses_json = await redis.lrange(response_list_key, 0, -1)
        all_responses = [json.loads(r) for r in all_responses_json]
        logger.debug(f"Fetched {len(all_responses)} responses from Redis for DB update on stop/fail: {agent_run_id}")
    except Exception as e:
        logger.error(f"Failed to fetch responses from Redis for {agent_run_id} during stop/fail: {e}")

    # Update the agent run status in the database
    update_success = await update_agent_run_status(
        client, agent_run_id, final_status, error=error_message
    )

    if not update_success:
        logger.error(f"Failed to update database status for stopped/failed run {agent_run_id}")
        raise HTTPException(status_code=500, detail="Failed to update agent run status in database")

    # Send STOP signal to the global control channel
    global_control_channel = f"agent_run:{agent_run_id}:control"
    try:
        await redis.publish(global_control_channel, "STOP")
        logger.debug(f"Published STOP signal to global channel {global_control_channel}")
    except Exception as e:
        logger.error(f"Failed to publish STOP signal to global channel {global_control_channel}: {str(e)}")

    # Find all instances handling this agent run and send STOP to instance-specific channels
    try:
        instance_keys = await redis.keys(f"active_run:*:{agent_run_id}")
        logger.debug(f"Found {len(instance_keys)} active instance keys for agent run {agent_run_id}")

        for key in instance_keys:
            # Key format: active_run:{instance_id}:{agent_run_id}
            parts = key.split(":")
            if len(parts) == 3:
                instance_id_from_key = parts[1]
                instance_control_channel = f"agent_run:{agent_run_id}:control:{instance_id_from_key}"
                try:
                    await redis.publish(instance_control_channel, "STOP")
                    logger.debug(f"Published STOP signal to instance channel {instance_control_channel}")
                except Exception as e:
                    logger.warning(f"Failed to publish STOP signal to instance channel {instance_control_channel}: {str(e)}")
            else:
                 logger.warning(f"Unexpected key format found: {key}")

        # Clean up the response list immediately on stop/fail
        await _cleanup_redis_response_list(agent_run_id)

    except Exception as e:
        logger.error(f"Failed to find or signal active instances for {agent_run_id}: {str(e)}")

    logger.debug(f"Successfully initiated stop process for agent run: {agent_run_id}")


async def check_for_active_project_agent_run(client, project_id: str) -> Optional[str]:
    """
    Check if there are any active agent runs for a project.
    
    Args:
        client: Database client
        project_id: The project ID to check
        
    Returns:
        The ID of an active agent run, or None if no active runs
    """
    project_threads = await client.table('threads').select('thread_id').eq('project_id', project_id).execute()
    project_thread_ids = [t['thread_id'] for t in project_threads.data]

    if project_thread_ids:
        from .query_utils import batch_query_in
        
        active_runs = await batch_query_in(
            client=client,
            table_name='agent_runs',
            select_fields='id',
            in_field='thread_id',
            in_values=project_thread_ids,
            additional_filters={'status': 'running'}
        )
        
        if active_runs:
            return active_runs[0]['id']
    return None
