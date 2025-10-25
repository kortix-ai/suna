"""Thread-related API models."""

from pydantic import BaseModel
from typing import Optional


class UnifiedAgentStartResponse(BaseModel):
    """Unified response model for agent start (both new and existing threads)."""
    thread_id: str
    agent_run_id: str
    status: str = "running"


class CreateThreadResponse(BaseModel):
    """Response model for thread creation."""
    thread_id: str
    project_id: str


class MessageCreateRequest(BaseModel):
    """Request model for creating a message."""
    type: str
    content: str
    is_llm_message: bool = True
