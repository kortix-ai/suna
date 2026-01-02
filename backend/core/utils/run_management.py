"""Agent run management utilities - starting, stopping, and monitoring agent runs."""
import json
from typing import Optional, List
from fastapi import HTTPException
from core.services import redis
from ..utils.logger import logger
from run_agent_background import update_agent_run_status, cleanup_redis_keys_for_agent_run


async def stop_agent_run_with_helpers(agent_run_id: str, error_message: Optional[str] = None, stop_source: str = "api_request"):
    """
    Stop an agent run and clean up all associated resources.
    
    This function:
    1. Fetches final responses from Redis stream
    2. Updates database status
    3. Publishes STOP signals to all control channels
    4. Cleans up Redis keys
    
    Args:
        agent_run_id: The ID of the agent run to stop
        error_message: Optional error message if run failed
        stop_source: Source of the stop request (api_request, instance_shutdown, etc.)
    """
    logger.warning(f"🛑 Stopping agent run: {agent_run_id} (source: {stop_source}, error: {error_message or 'none'})")
    
    # Import here to avoid circular dependency
    from ..core_utils import db
    
    client = await db.client
    final_status = "failed" if error_message else "stopped"

    # Attempt to fetch final responses from Redis stream
    stream_key = f"agent_run:{agent_run_id}:stream"
    all_responses = []
    try:
        stream_entries = await redis.xrange(stream_key)
        all_responses = [json.loads(entry[1].get('data', '{}')) for entry in stream_entries] if stream_entries else []
        logger.debug(f"Fetched {len(all_responses)} responses from Redis stream for DB update on stop/fail: {agent_run_id}")
    except Exception as e:
        logger.error(f"Failed to fetch responses from Redis stream for {agent_run_id} during stop/fail: {e}")

    # Update the agent run status in the database
    update_success = await update_agent_run_status(
        client, agent_run_id, final_status, error=error_message
    )

    if not update_success:
        logger.error(f"Failed to update database status for stopped/failed run {agent_run_id}")
        raise HTTPException(status_code=500, detail="Failed to update agent run status in database")

    # Send STOP signal to Temporal workflow
    try:
        from core.temporal.client import get_temporal_client
        from core.temporal.workflows import AgentRunWorkflow
        
        temporal_client = await get_temporal_client()
        
        # Get workflow handle by workflow ID
        workflow_id = f"agent-run-{agent_run_id}"
        handle = temporal_client.get_workflow_handle(workflow_id)
        
        # Send stop signal (pass reason as positional arg, not keyword)
        await handle.signal(AgentRunWorkflow.stop, f"{stop_source}: {error_message or 'user_request'}")
        logger.warning(f"🛑 Sent STOP signal to Temporal workflow {workflow_id} (source: {stop_source})")
    except Exception as e:
        logger.error(f"Failed to send STOP signal to Temporal workflow for {agent_run_id}: {str(e)}")
        # Fallback: still set Redis stop signal for backwards compatibility during migration
        try:
            await redis.set_stop_signal(agent_run_id)
            logger.debug(f"Set Redis stop signal as fallback for {agent_run_id}")
        except Exception as redis_err:
            logger.error(f"Failed to set Redis stop signal fallback: {redis_err}")

    # Comprehensive cleanup of all Redis keys for this agent run
    try:
        await cleanup_redis_keys_for_agent_run(agent_run_id)
    except Exception as e:
        logger.error(f"Failed to cleanup Redis keys for {agent_run_id}: {str(e)}")

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
