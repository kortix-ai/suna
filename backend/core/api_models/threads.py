"""Thread-related API models."""

from pydantic import BaseModel
from typing import Optional, Dict


class UnifiedAgentStartResponse(BaseModel):
    """Unified response model for agent start (both regular and optimistic modes)."""
    thread_id: str
    agent_run_id: Optional[str] = None  # None in optimistic mode
    project_id: Optional[str] = None    # Returned in optimistic mode
    status: str = "running"  # "running" for regular, "pending" for optimistic
    # Optional timing breakdown for stress testing (only present when X-Emit-Timing header is set)
    timing_breakdown: Optional[Dict[str, float]] = None


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
