"""
Temporal workflows - orchestrate activities.

Task queues:
- "agent-runs": High-priority, long-running agent executions
- "background": Memory extraction, categorization, etc.

NOTE: Use workflow.logger, not imported logger (sandbox restriction).
"""
import asyncio
from datetime import timedelta
from typing import Optional, Dict, Any, List

from temporalio import workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import ApplicationError

# Task queue constants
TASK_QUEUE_AGENT_RUNS = "agent-runs"
TASK_QUEUE_BACKGROUND = "background"

# Shared retry policies
RETRY_STANDARD = RetryPolicy(
    initial_interval=timedelta(seconds=1),
    maximum_interval=timedelta(seconds=30),
    maximum_attempts=3,
    backoff_coefficient=2.0,
)
RETRY_LIGHT = RetryPolicy(
    initial_interval=timedelta(seconds=1),
    maximum_interval=timedelta(seconds=10),
    maximum_attempts=2,
)

with workflow.unsafe.imports_passed_through():
    from core.temporal.activities import (
        run_agent_activity,
        extract_memories_activity,
        embed_and_store_memories_activity,
        consolidate_memories_activity,
        find_stale_projects_activity,
        categorize_project_activity,
    )


@workflow.defn(name="AgentRunWorkflow")
class AgentRunWorkflow:
    """Execute an agent run with stop signal support."""
    
    def __init__(self) -> None:
        self._status = "running"
        self._error: Optional[str] = None
        self._stop_requested = False
        self._result: Optional[Dict[str, Any]] = None
    
    @workflow.run
    async def run(
        self,
        agent_run_id: str,
        thread_id: str,
        instance_id: str,
        project_id: str,
        model_name: str = "openai/gpt-5-mini",
        agent_id: Optional[str] = None,
        account_id: Optional[str] = None,
        request_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        workflow.logger.info(f"🚀 [WORKFLOW] AgentRunWorkflow STARTING: agent_run_id={agent_run_id}, thread_id={thread_id}, instance_id={instance_id}, task_queue=agent-runs")
        workflow.logger.info(f"📋 [WORKFLOW] Parameters: project_id={project_id}, model_name={model_name}, agent_id={agent_id}, account_id={account_id}")
        
        try:
            workflow.logger.info(f"⚙️ [WORKFLOW] Executing run_agent_activity for {agent_run_id}")
            result = await workflow.execute_activity(
                run_agent_activity,
                args=[agent_run_id, thread_id, instance_id, project_id, model_name, agent_id, account_id, request_id],
                start_to_close_timeout=timedelta(hours=2),
                heartbeat_timeout=timedelta(minutes=5),
                retry_policy=RETRY_STANDARD,
            )
            workflow.logger.info(f"✅ [WORKFLOW] Activity completed: {agent_run_id}, result status: {result.get('status', 'unknown')}")
            self._result = result
            self._status = result.get("status", "completed")
            return result
            
        except asyncio.CancelledError:
            workflow.logger.warning(f"⚠️ [WORKFLOW] Cancelled: {agent_run_id}")
            self._status = "cancelled"
            raise
        except Exception as e:
            workflow.logger.error(f"❌ [WORKFLOW] Error: {agent_run_id}, error: {e}", exc_info=True)
            self._status = "failed"
            self._error = str(e)
            raise ApplicationError(f"Agent run failed: {e}", non_retryable=True)
    
    @workflow.signal
    async def stop(self, reason: Optional[str] = None) -> None:
        workflow.logger.warning(f"Stop signal: {reason}")
        self._stop_requested = True
    
    @workflow.query
    def get_status(self) -> Dict[str, Any]:
        return {"status": self._status, "error": self._error, "stop_requested": self._stop_requested}


# ThreadInitWorkflow removed - thread initialization is now done directly in the API
# before starting AgentRunWorkflow. This simplifies the architecture significantly.


@workflow.defn(name="MemoryExtractionWorkflow")
class MemoryExtractionWorkflow:
    """Extract and store memories from conversation."""
    
    @workflow.run
    async def run(self, thread_id: str, account_id: str, message_ids: List[str]) -> Dict[str, Any]:
        workflow.logger.info(f"MemoryExtractionWorkflow: {thread_id}")
        
        try:
            memories = await workflow.execute_activity(
                extract_memories_activity,
                args=[thread_id, account_id, message_ids],
                start_to_close_timeout=timedelta(minutes=10),
                retry_policy=RETRY_STANDARD,
            )
            
            if not memories:
                return {"extracted_count": 0, "stored_count": 0}
            
            result = await workflow.execute_activity(
                embed_and_store_memories_activity,
                args=[account_id, thread_id, memories],
                start_to_close_timeout=timedelta(minutes=10),
                retry_policy=RETRY_STANDARD,
            )
            
            return {"extracted_count": len(memories), "stored_count": result.get("stored_count", 0)}
            
        except Exception as e:
            raise ApplicationError(f"Memory extraction failed: {e}", non_retryable=True)


@workflow.defn(name="CategorizationWorkflow")
class CategorizationWorkflow:
    """Batch categorize stale projects."""
    
    @workflow.run
    async def run(self) -> Dict[str, Any]:
        workflow.logger.info("CategorizationWorkflow starting")
        
        try:
            projects = await workflow.execute_activity(
                find_stale_projects_activity,
                start_to_close_timeout=timedelta(minutes=2),
                retry_policy=RETRY_LIGHT,
            )
            
            if not projects:
                return {"processed_count": 0}
            
            # Start child workflows with stagger
            handles = []
            for i, project in enumerate(projects):
                if i > 0:
                    await asyncio.sleep(2)
                
                handle = await workflow.start_child_workflow(
                    CategorizeProjectWorkflow.run,
                    args=[project['project_id']],
                    id=f"categorize-{project['project_id']}",
                    task_queue=TASK_QUEUE_BACKGROUND,
                )
                handles.append(handle)
            
            # Wait for all
            results = []
            for handle in handles:
                try:
                    results.append(await handle)
                except Exception as e:
                    results.append({"error": str(e)})
            
            processed = len([r for r in results if not r.get("error")])
            return {"processed_count": processed, "total_count": len(projects)}
            
        except Exception as e:
            raise ApplicationError(f"Categorization failed: {e}", non_retryable=True)


@workflow.defn(name="CategorizeProjectWorkflow")
class CategorizeProjectWorkflow:
    """Categorize a single project."""
    
    @workflow.run
    async def run(self, project_id: str) -> Dict[str, Any]:
        try:
            return await workflow.execute_activity(
                categorize_project_activity,
                project_id,
                start_to_close_timeout=timedelta(minutes=5),
                retry_policy=RETRY_LIGHT,
            )
        except Exception as e:
            raise ApplicationError(f"Project categorization failed: {e}", non_retryable=True)
