from dataclasses import dataclass
from typing import Optional, List
from datetime import timedelta
import os
import uuid
from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from core.utils.logger import logger


@dataclass
class AgentWorkflowInput:
    agent_run_id: str
    thread_id: str
    project_id: str
    model_name: str
    agent_id: Optional[str] = None
    account_id: Optional[str] = None


@dataclass
class AgentWorkflowOutput:
    status: str
    error_message: Optional[str] = None
    total_responses: int = 0
    complete_tool_called: bool = False
    duration_seconds: float = 0.0
    memory_pipeline_started: bool = False


@workflow.defn(name="AgentRunWorkflow")
class AgentRunWorkflow:
    
    def __init__(self):
        self._should_stop = False
        self._stop_reason: Optional[str] = None
    
    @workflow.signal
    def stop(self, reason: str = "user_requested"):
        workflow.logger.info(f"Received stop signal: {reason}")
        self._should_stop = True
        self._stop_reason = reason
    
    @workflow.query
    def get_status(self) -> dict:
        return {
            "should_stop": self._should_stop,
            "stop_reason": self._stop_reason,
        }
    
    @workflow.run
    async def run(self, input: AgentWorkflowInput) -> AgentWorkflowOutput:
        from .agent_activities import run_agent_activity, AgentRunInput, AgentRunOutput
        
        workflow.logger.info(f"Starting agent workflow for run: {input.agent_run_id}")
        
        instance_id = str(uuid.uuid4())[:8]
        
        retry_policy = RetryPolicy(
            initial_interval=timedelta(seconds=2),
            backoff_coefficient=2.0,
            maximum_interval=timedelta(minutes=2),
            maximum_attempts=3,
            non_retryable_error_types=["CancelledError"],
        )
        
        try:
            result: AgentRunOutput = await workflow.execute_activity(
                run_agent_activity,
                AgentRunInput(
                    agent_run_id=input.agent_run_id,
                    thread_id=input.thread_id,
                    project_id=input.project_id,
                    model_name=input.model_name,
                    agent_id=input.agent_id,
                    account_id=input.account_id,
                    instance_id=instance_id,
                ),
                start_to_close_timeout=timedelta(hours=2),
                heartbeat_timeout=timedelta(minutes=2),
                retry_policy=retry_policy,
                cancellation_type=workflow.ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
            )
            
            memory_pipeline_started = False
            
            return AgentWorkflowOutput(
                status=result.status,
                error_message=result.error_message,
                total_responses=result.total_responses,
                complete_tool_called=result.complete_tool_called,
                duration_seconds=result.duration_seconds,
                memory_pipeline_started=memory_pipeline_started,
            )
            
        except workflow.CancelledError:
            workflow.logger.warning(f"Agent workflow cancelled: {input.agent_run_id}")
            return AgentWorkflowOutput(
                status="stopped",
                error_message=self._stop_reason or "Workflow cancelled",
            )
        except Exception as e:
            workflow.logger.error(f"Agent workflow failed: {e}")
            return AgentWorkflowOutput(
                status="failed",
                error_message=str(e),
            )

