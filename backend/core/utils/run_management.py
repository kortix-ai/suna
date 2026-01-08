"""Agent run management utilities - starting, stopping, and monitoring agent runs."""
import json
from typing import Optional, List
from fastapi import HTTPException
from core.services import redis
from core.utils.logger import logger
from core.agents.runner.agent_runner import update_agent_run_status


async def stop_agent_run_with_helpers(agent_run_id: str, error_message: Optional[str] = None, stop_source: str = "api_request"):
    """
    Stop an agent run - SIMPLIFIED.
    
    This function:
    1. Sets cancellation event (in-memory, per instance)
    2. Sets Redis stop signal (for cross-instance stops)
    3. Updates database status
    
    Args:
        agent_run_id: The ID of the agent run to stop
        error_message: Optional error message if run failed
        stop_source: Source of the stop request (api_request, instance_shutdown, etc.)
    """
    logger.warning(f"🛑 Stopping agent run: {agent_run_id} (source: {stop_source}, error: {error_message or 'none'})")
    
    # Import here to avoid circular dependency
    from core.services.supabase import DBConnection
    from core.agents.api import _cancellation_events
    
    # Set in-memory cancellation event (if run is on this instance)
    if agent_run_id in _cancellation_events:
        _cancellation_events[agent_run_id].set()
        logger.debug(f"Set cancellation event for {agent_run_id} (local instance)")
    
    # Set Redis stop signal (for cross-instance stops)
    try:
        await redis.set_stop_signal(agent_run_id)
        logger.debug(f"Set Redis stop signal for {agent_run_id}")
    except Exception as e:
        logger.error(f"Failed to set Redis stop signal for {agent_run_id}: {str(e)}")
    
    # Update database status
    final_status = "failed" if error_message else "stopped"
    
    update_success = await update_agent_run_status(
        agent_run_id, final_status, error=error_message
    )

    if not update_success:
        logger.error(f"Failed to update database status for stopped/failed run {agent_run_id}")
        raise HTTPException(status_code=500, detail="Failed to update agent run status in database")

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
