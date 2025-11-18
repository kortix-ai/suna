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


class MessageFeedbackRequest(BaseModel):
    """Request model for submitting message feedback."""
    rating: float
    feedback_text: Optional[str] = None
    help_improve: bool = True


class MessageFeedbackResponse(BaseModel):
    """Response model for message feedback."""
    feedback_id: str
    thread_id: str
    message_id: str
    rating: float
    feedback_text: Optional[str] = None
    help_improve: bool
    created_at: str
    updated_at: str
