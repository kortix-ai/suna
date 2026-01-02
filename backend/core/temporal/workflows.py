"""
Temporal workflows - orchestrate activities and handle signals/queries.

Workflows define the business logic and orchestration of activities. They support
signals for external control (e.g., stop), queries for status, and child workflows
for composition.

NOTE: Workflows run in a sandboxed environment. Use workflow.logger instead of
importing logger modules directly.

TASK QUEUE ARCHITECTURE:
- "agent-runs": High-priority queue for long-running agent executions
- "background": Lower-priority queue for memory extraction, categorization, etc.
"""
import asyncio
from datetime import timedelta
from typing import Optional, Dict, Any, List

from temporalio import workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import ApplicationError

# Do NOT import logger here - workflows run in sandbox
# Use workflow.logger instead (provided by Temporal)

# Task queue constants
TASK_QUEUE_AGENT_RUNS = "agent-runs"
TASK_QUEUE_BACKGROUND = "background"

# Import activities - must use unsafe imports for workflow code
with workflow.unsafe.imports_passed_through():
    from core.temporal.activities import (
        run_agent_activity,
        initialize_thread_activity,
        extract_memories_activity,
        embed_and_store_memories_activity,
        consolidate_memories_activity,
        find_stale_projects_activity,
        categorize_project_activity,
    )


@workflow.defn(name="AgentRunWorkflow")
class AgentRunWorkflow:
    """
    Main workflow for executing an agent run.
    
    Supports:
    - Stop signal for cancellation
    - Status query for monitoring
    - Long-running agent execution with heartbeating
    
    Runs on: agent-runs queue (high priority)
    """
    
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
        """
        Execute the agent run workflow.
        
        Args:
            agent_run_id: Unique ID for this agent run
            thread_id: Thread ID for the conversation
            instance_id: Worker instance ID
            project_id: Project ID
            model_name: Model to use
            agent_id: Optional agent ID
            account_id: Account ID
            request_id: Optional request ID for tracing
            
        Returns:
            Dict with status and results
        """
        workflow.logger.info(f"Starting AgentRunWorkflow for {agent_run_id}")
        self._status = "running"
        
        try:
            # Execute the agent run activity with long timeout and heartbeat
            # Activities handle their own heartbeating, but we set generous timeouts
            result = await workflow.execute_activity(
                run_agent_activity,
                args=[agent_run_id, thread_id, instance_id, project_id, model_name, agent_id, account_id, request_id],
                start_to_close_timeout=timedelta(hours=2),  # Long timeout for agent runs
                heartbeat_timeout=timedelta(minutes=5),  # Heartbeat timeout
                retry_policy=RetryPolicy(
                    initial_interval=timedelta(seconds=1),
                    maximum_interval=timedelta(seconds=30),
                    maximum_attempts=3,
                    backoff_coefficient=2.0,
                ),
            )
            
            self._result = result
            self._status = result.get("status", "completed")
            workflow.logger.info(f"AgentRunWorkflow completed for {agent_run_id} with status {self._status}")
            return result
            
        except asyncio.CancelledError:
            workflow.logger.warning(f"AgentRunWorkflow cancelled for {agent_run_id}")
            self._status = "cancelled"
            raise
        except Exception as e:
            error_msg = str(e)
            workflow.logger.error(f"AgentRunWorkflow failed for {agent_run_id}: {error_msg}")
            self._status = "failed"
            self._error = error_msg
            raise ApplicationError(f"Agent run failed: {error_msg}", non_retryable=True)
    
    @workflow.signal
    async def stop(self, reason: Optional[str] = None) -> None:
        """
        Signal to stop the agent run.
        
        Args:
            reason: Optional reason for stopping
        """
        workflow.logger.warning(f"Stop signal received for workflow (reason: {reason})")
        self._stop_requested = True
        # The activity will check for cancellation via Temporal's cancellation mechanism
        # We can't directly cancel the activity from here, but Temporal will propagate cancellation
    
    @workflow.query
    def get_status(self) -> Dict[str, Any]:
        """
        Query the current status of the workflow.
        
        Returns:
            Dict with status, error, and result if available
        """
        return {
            "status": self._status,
            "error": self._error,
            "result": self._result,
            "stop_requested": self._stop_requested,
        }


@workflow.defn(name="ThreadInitWorkflow")
class ThreadInitWorkflow:
    """
    Workflow for initializing a thread and then starting the agent run.
    
    OPTIMIZATION: Uses fire-and-forget pattern for child workflow.
    Parent workflow completes immediately after starting child,
    reducing resource usage for long-running agent runs.
    
    Runs on: agent-runs queue (high priority)
    """
    
    @workflow.run
    async def run(
        self,
        thread_id: str,
        project_id: str,
        account_id: str,
        prompt: str,
        agent_id: Optional[str] = None,
        model_name: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Initialize thread and start agent run (fire-and-forget).
        
        Args:
            thread_id: Thread ID
            project_id: Project ID
            account_id: Account ID
            prompt: Initial prompt
            agent_id: Optional agent ID
            model_name: Optional model name
            
        Returns:
            Dict with agent_run_id and status (returns immediately, doesn't wait for agent run)
        """
        workflow.logger.info(f"Starting ThreadInitWorkflow for thread {thread_id}")
        
        try:
            # Execute thread initialization activity
            init_result = await workflow.execute_activity(
                initialize_thread_activity,
                args=[thread_id, project_id, account_id, prompt, agent_id, model_name],
                start_to_close_timeout=timedelta(minutes=5),
                retry_policy=RetryPolicy(
                    initial_interval=timedelta(seconds=1),
                    maximum_interval=timedelta(seconds=30),
                    maximum_attempts=3,
                    backoff_coefficient=2.0,
                ),
            )
            
            agent_run_id = init_result["agent_run_id"]
            effective_model = init_result["effective_model"]
            
            workflow.logger.info(f"Thread {thread_id} initialized, starting agent run: {agent_run_id}")
            
            # Start agent run as child workflow with FIRE-AND-FORGET pattern
            # Use workflow.uuid4() for deterministic UUID generation in workflows
            worker_instance_id = str(workflow.uuid4())[:8]
            
            # Start child workflow but DON'T await it
            # Parent close policy ABANDON means child continues even if parent completes
            await workflow.start_child_workflow(
                AgentRunWorkflow.run,
                args=[agent_run_id, thread_id, worker_instance_id, project_id, effective_model, agent_id, account_id, None],
                id=f"agent-run-{agent_run_id}",
                task_queue=TASK_QUEUE_AGENT_RUNS,
                parent_close_policy=workflow.ParentClosePolicy.ABANDON,  # Child continues if parent closes
            )
            
            workflow.logger.info(f"ThreadInitWorkflow completed for thread {thread_id}, agent_run_id: {agent_run_id} (fire-and-forget)")
            
            # Return immediately - don't wait for agent run to complete
            return {
                "thread_id": thread_id,
                "agent_run_id": agent_run_id,
                "status": "started",  # Changed from "completed" to "started"
            }
            
        except Exception as e:
            error_msg = str(e)
            workflow.logger.error(f"ThreadInitWorkflow failed for thread {thread_id}: {error_msg}")
            raise ApplicationError(f"Thread initialization failed: {error_msg}", non_retryable=True)


@workflow.defn(name="MemoryExtractionWorkflow")
class MemoryExtractionWorkflow:
    """
    Workflow for extracting and storing memories from a conversation.
    
    Orchestrates: extract → embed_and_store
    
    Runs on: background queue (lower priority)
    """
    
    @workflow.run
    async def run(
        self,
        thread_id: str,
        account_id: str,
        message_ids: List[str],
    ) -> Dict[str, Any]:
        """
        Extract and store memories from conversation.
        
        Args:
            thread_id: Thread ID
            account_id: Account ID
            message_ids: List of message IDs to extract from
            
        Returns:
            Dict with extraction and storage results
        """
        workflow.logger.info(f"Starting MemoryExtractionWorkflow for thread {thread_id}")
        
        try:
            # Step 1: Extract memories
            extracted_memories = await workflow.execute_activity(
                extract_memories_activity,
                args=[thread_id, account_id, message_ids],
                start_to_close_timeout=timedelta(minutes=10),
                retry_policy=RetryPolicy(
                    initial_interval=timedelta(seconds=1),
                    maximum_interval=timedelta(seconds=30),
                    maximum_attempts=3,
                ),
            )
            
            if not extracted_memories:
                workflow.logger.info(f"No memories extracted from thread {thread_id}")
                return {"extracted_count": 0, "stored_count": 0}
            
            # Step 2: Embed and store memories
            storage_result = await workflow.execute_activity(
                embed_and_store_memories_activity,
                args=[account_id, thread_id, extracted_memories],
                start_to_close_timeout=timedelta(minutes=10),
                retry_policy=RetryPolicy(
                    initial_interval=timedelta(seconds=1),
                    maximum_interval=timedelta(seconds=30),
                    maximum_attempts=3,
                ),
            )
            
            workflow.logger.info(
                f"MemoryExtractionWorkflow completed for thread {thread_id}: "
                f"extracted {len(extracted_memories)}, stored {storage_result.get('stored_count', 0)}"
            )
            
            return {
                "extracted_count": len(extracted_memories),
                "stored_count": storage_result.get("stored_count", 0),
            }
            
        except Exception as e:
            error_msg = str(e)
            workflow.logger.error(f"MemoryExtractionWorkflow failed for thread {thread_id}: {error_msg}")
            raise ApplicationError(f"Memory extraction failed: {error_msg}", non_retryable=True)


@workflow.defn(name="CategorizationWorkflow")
class CategorizationWorkflow:
    """
    Workflow for batch categorization of stale projects.
    
    Finds stale projects and categorizes them in parallel.
    
    Runs on: background queue (lower priority)
    """
    
    @workflow.run
    async def run(self) -> Dict[str, Any]:
        """
        Find and categorize stale projects.
        
        Returns:
            Dict with count of projects processed
        """
        workflow.logger.info("Starting CategorizationWorkflow")
        
        try:
            # Find stale projects via activity
            projects = await workflow.execute_activity(
                find_stale_projects_activity,
                start_to_close_timeout=timedelta(minutes=2),
                retry_policy=RetryPolicy(
                    initial_interval=timedelta(seconds=1),
                    maximum_interval=timedelta(seconds=10),
                    maximum_attempts=2,
                ),
            )
            
            if not projects:
                workflow.logger.debug("No stale projects to categorize")
                return {"processed_count": 0}
            
            workflow.logger.info(f"Found {len(projects)} stale projects")
            
            # Start child workflows for each project (with staggered delays)
            DELAY_BETWEEN_PROJECTS_SECONDS = 2
            child_handles = []
            
            for i, project in enumerate(projects):
                # Stagger workflow starts to avoid rate limits
                delay_seconds = i * DELAY_BETWEEN_PROJECTS_SECONDS
                
                if delay_seconds > 0:
                    await asyncio.sleep(delay_seconds)
                
                handle = await workflow.start_child_workflow(
                    CategorizeProjectWorkflow.run,
                    args=[project['project_id']],
                    id=f"categorize-{project['project_id']}",
                    task_queue=TASK_QUEUE_BACKGROUND,
                )
                child_handles.append(handle)
            
            # Wait for all children to complete
            results = []
            for handle in child_handles:
                try:
                    result = await handle
                    results.append(result)
                except Exception as e:
                    workflow.logger.error(f"Child categorization workflow failed: {e}")
                    results.append({"error": str(e)})
            
            processed_count = len([r for r in results if not r.get("error")])
            
            workflow.logger.info(f"CategorizationWorkflow completed: processed {processed_count}/{len(projects)} projects")
            
            return {"processed_count": processed_count, "total_count": len(projects)}
            
        except Exception as e:
            error_msg = str(e)
            workflow.logger.error(f"CategorizationWorkflow failed: {error_msg}")
            raise ApplicationError(f"Categorization failed: {error_msg}", non_retryable=True)


@workflow.defn(name="CategorizeProjectWorkflow")
class CategorizeProjectWorkflow:
    """
    Workflow for categorizing a single project.
    
    Runs on: background queue (lower priority)
    """
    
    @workflow.run
    async def run(self, project_id: str) -> Dict[str, Any]:
        """
        Categorize a single project.
        
        Args:
            project_id: Project ID to categorize
            
        Returns:
            Dict with categories assigned
        """
        workflow.logger.info(f"Categorizing project {project_id}")
        
        try:
            result = await workflow.execute_activity(
                categorize_project_activity,
                project_id,
                start_to_close_timeout=timedelta(minutes=5),
                retry_policy=RetryPolicy(
                    initial_interval=timedelta(seconds=1),
                    maximum_interval=timedelta(seconds=10),
                    maximum_attempts=2,
                ),
            )
            
            return result
            
        except Exception as e:
            error_msg = str(e)
            workflow.logger.error(f"CategorizeProjectWorkflow failed for {project_id}: {error_msg}")
            raise ApplicationError(f"Project categorization failed: {error_msg}", non_retryable=True)
