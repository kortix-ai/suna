from typing import Optional

from core.services.temporal import get_temporal_client
from core.utils.logger import logger
from .agent_workflow import AgentWorkflowInput, AgentWorkflowOutput

AGENT_RUN_TASK_QUEUE = "agent-runs"


async def start_agent_run(
    agent_run_id: str,
    thread_id: str,
    project_id: str,
    model_name: str,
    agent_id: Optional[str] = None,
    account_id: Optional[str] = None,
    wait_for_result: bool = False,
) -> Optional[AgentWorkflowOutput]:
    try:
        client = await get_temporal_client()
        
        workflow_id = f"agent-run-{agent_run_id}"
        
        handle = await client.start_workflow(
            "AgentRunWorkflow",
            AgentWorkflowInput(
                agent_run_id=agent_run_id,
                thread_id=thread_id,
                project_id=project_id,
                model_name=model_name,
                agent_id=agent_id,
                account_id=account_id,
            ),
            id=workflow_id,
            task_queue=AGENT_RUN_TASK_QUEUE,
        )
        
        logger.info(f"Started agent run workflow: {workflow_id}")
        
        if wait_for_result:
            result = await handle.result()
            return result
        
        return None
        
    except Exception as e:
        logger.error(f"Failed to start agent run workflow: {e}")
        raise


async def stop_agent_run(agent_run_id: str, reason: str = "user_requested") -> bool:
    try:
        client = await get_temporal_client()
        workflow_id = f"agent-run-{agent_run_id}"
        handle = client.get_workflow_handle(workflow_id)
        
        await handle.signal("stop", reason)
        logger.info(f"Sent stop signal to agent run: {agent_run_id}")
        return True
    except Exception as e:
        logger.error(f"Failed to stop agent run {agent_run_id}: {e}")
        return False


async def get_workflow_status(workflow_id: str) -> dict:
    client = await get_temporal_client()
    handle = client.get_workflow_handle(workflow_id)
    
    describe = await handle.describe()
    
    return {
        "workflow_id": workflow_id,
        "status": describe.status.name,
        "start_time": describe.start_time.isoformat() if describe.start_time else None,
        "close_time": describe.close_time.isoformat() if describe.close_time else None,
    }


async def cancel_workflow(workflow_id: str) -> bool:
    try:
        client = await get_temporal_client()
        handle = client.get_workflow_handle(workflow_id)
        await handle.cancel()
        logger.info(f"Cancelled workflow: {workflow_id}")
        return True
    except Exception as e:
        logger.error(f"Failed to cancel workflow {workflow_id}: {e}")
        return False
