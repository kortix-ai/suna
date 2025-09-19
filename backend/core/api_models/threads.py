"""Thread-related API models."""

from pydantic import BaseModel
from typing import Optional


class AgentStartRequest(BaseModel):
    """Request model for starting an agent."""
    model_name: Optional[str] = None  # Will be set to default model in the endpoint
    enable_thinking: Optional[bool] = False
    reasoning_effort: Optional[str] = 'low'
    stream: Optional[bool] = True
    enable_context_manager: Optional[bool] = False
    agent_id: Optional[str] = None  # Custom agent to use


class InitiateAgentResponse(BaseModel):
    """Response model for agent initiation."""
    thread_id: str
    agent_run_id: Optional[str] = None


class CreateThreadResponse(BaseModel):
    """Response model for thread creation."""
    thread_id: str
    project_id: str


class MessageCreateRequest(BaseModel):
    """Request model for creating a message."""
    type: str
    content: str
    is_llm_message: bool = True
