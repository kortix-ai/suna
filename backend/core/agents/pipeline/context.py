"""
Pipeline Context - Shared state and result types for the pipeline.
"""

import asyncio
from dataclasses import dataclass, field
from typing import Dict, Any, List, Optional, Union
from datetime import datetime, timezone


@dataclass
class PipelineContext:
    """Input context for pipeline execution."""
    
    # Required identifiers
    agent_run_id: str
    thread_id: str
    project_id: str
    account_id: str
    
    # Model configuration
    model_name: str
    
    # Agent configuration
    agent_config: Optional[Dict[str, Any]] = None
    
    # Execution flags
    is_new_thread: bool = False
    skip_limits_check: bool = False
    
    # Cancellation
    cancellation_event: Optional[asyncio.Event] = None
    
    # Stream key for Redis
    stream_key: str = field(default="")
    
    # Timing
    start_time: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    
    def __post_init__(self):
        if not self.stream_key:
            self.stream_key = f"agent_run:{self.agent_run_id}:stream"


@dataclass
class BillingResult:
    """Result of billing/credit check."""
    can_run: bool
    message: str
    balance: Optional[float] = None
    error_code: Optional[str] = None


@dataclass
class LimitsResult:
    """Result of tier limit checks."""
    can_run: bool
    message: str
    concurrent_runs: int = 0
    concurrent_limit: int = 1
    error_code: Optional[str] = None


@dataclass
class MessagesResult:
    """Result of message fetching."""
    messages: List[Dict[str, Any]]
    count: int
    from_cache: bool = False
    fetch_time_ms: float = 0


@dataclass
class PromptResult:
    """Result of system prompt building."""
    system_prompt: Dict[str, Any]
    memory_context: Optional[Dict[str, Any]] = None
    build_time_ms: float = 0


@dataclass
class ToolsResult:
    """Result of tool schema fetching."""
    schemas: Optional[List[Dict[str, Any]]]
    count: int = 0
    fetch_time_ms: float = 0


@dataclass
class MCPResult:
    """Result of MCP initialization."""
    initialized: bool
    tool_count: int = 0
    init_time_ms: float = 0


@dataclass
class PrepResult:
    """Combined result of all prep tasks."""
    
    # Individual results
    billing: Optional[BillingResult] = None
    limits: Optional[LimitsResult] = None
    messages: Optional[MessagesResult] = None
    prompt: Optional[PromptResult] = None
    tools: Optional[ToolsResult] = None
    mcp: Optional[MCPResult] = None
    
    # Errors collected during prep
    errors: List[str] = field(default_factory=list)
    
    # Timing
    total_prep_time_ms: float = 0
    
    @property
    def has_errors(self) -> bool:
        """Check if any critical errors occurred."""
        return len(self.errors) > 0
    
    @property
    def can_proceed(self) -> bool:
        """Check if we can proceed to LLM call."""
        if self.has_errors:
            return False
        if self.billing and not self.billing.can_run:
            return False
        if self.limits and not self.limits.can_run:
            return False
        return True
    
    def get_error_response(self) -> Dict[str, Any]:
        """Generate error response for streaming."""
        if self.billing and not self.billing.can_run:
            return {
                "type": "error",
                "error": self.billing.message,
                "error_code": self.billing.error_code or "BILLING_ERROR"
            }
        if self.limits and not self.limits.can_run:
            return {
                "type": "error",
                "error": self.limits.message,
                "error_code": self.limits.error_code or "LIMIT_EXCEEDED"
            }
        if self.errors:
            return {
                "type": "error",
                "error": "; ".join(self.errors),
                "error_code": "PREP_ERROR"
            }
        return {
            "type": "error",
            "error": "Unknown error during preparation",
            "error_code": "UNKNOWN_ERROR"
        }


@dataclass
class AutoContinueState:
    """State for auto-continue loop."""
    count: int = 0
    active: bool = True
    accumulated_content: str = ""
    thread_run_id: Optional[str] = None
    force_tool_fallback: bool = False
    error_retry_count: int = 0
    tool_result_tokens: int = 0
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dict for compatibility with existing code."""
        return {
            'count': self.count,
            'active': self.active,
            'continuous_state': {
                'accumulated_content': self.accumulated_content,
                'thread_run_id': self.thread_run_id
            },
            'force_tool_fallback': self.force_tool_fallback,
            'error_retry_count': self.error_retry_count,
            'tool_result_tokens': self.tool_result_tokens
        }
