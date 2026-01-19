import asyncio
from dataclasses import dataclass, field
from typing import Dict, Any, List, Optional, Union
from datetime import datetime, timezone

@dataclass
class PipelineContext:
    agent_run_id: str
    thread_id: str
    project_id: str
    account_id: str
    model_name: str
    agent_config: Optional[Dict[str, Any]] = None
    is_new_thread: bool = False
    skip_limits_check: bool = False
    cancellation_event: Optional[asyncio.Event] = None
    stream_key: str = field(default="")
    start_time: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    user_message: Optional[str] = None
    
    def __post_init__(self):
        if not self.stream_key:
            self.stream_key = f"agent_run:{self.agent_run_id}:stream"

@dataclass
class BillingResult:
    can_run: bool
    message: str
    balance: Optional[float] = None
    error_code: Optional[str] = None

@dataclass
class LimitsResult:
    can_run: bool
    message: str
    concurrent_runs: int = 0
    concurrent_limit: int = 1
    error_code: Optional[str] = None

@dataclass
class MessagesResult:
    messages: List[Dict[str, Any]]
    count: int
    from_cache: bool = False
    fetch_time_ms: float = 0

@dataclass
class PromptResult:
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
    billing: Optional[BillingResult] = None
    limits: Optional[LimitsResult] = None
    messages: Optional[MessagesResult] = None
    prompt: Optional[PromptResult] = None
    tools: Optional[ToolsResult] = None
    mcp: Optional[MCPResult] = None
    errors: List[str] = field(default_factory=list)
    total_prep_time_ms: float = 0
    
    @property
    def has_errors(self) -> bool:
        return len(self.errors) > 0
    
    @property
    def can_proceed(self) -> bool:
        if self.has_errors:
            return False
        if self.billing and not self.billing.can_run:
            return False
        if self.limits and not self.limits.can_run:
            return False
        return True
    
    def get_error_response(self) -> Dict[str, Any]:
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
    count: int = 0
    active: bool = True
    accumulated_content: str = ""
    thread_run_id: Optional[str] = None
    force_tool_fallback: bool = False
    error_retry_count: int = 0
    tool_result_tokens: int = 0
    
    def to_dict(self) -> Dict[str, Any]:
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
