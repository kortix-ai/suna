from typing import Dict, Any, Optional, List
from dataclasses import dataclass

@dataclass
class UserFriendlyError:
    message: str
    error_code: str
    recoverable: bool
    actions: List[Dict[str, Any]]

class ErrorMapper:
    MAPPINGS = {
        "RATE_LIMIT": UserFriendlyError(
            message="We're experiencing high demand. Your request will be processed shortly.",
            error_code="RATE_LIMIT",
            recoverable=True,
            actions=[
                {"type": "retry", "label": "Try again", "delay_seconds": 5}
            ]
        ),
        "CREDIT_EXHAUSTED": UserFriendlyError(
            message="You've used all your credits for this billing period.",
            error_code="CREDIT_EXHAUSTED",
            recoverable=False,
            actions=[
                {"type": "link", "label": "Upgrade plan", "url": "/settings/billing"},
                {"type": "link", "label": "View usage", "url": "/settings/usage"}
            ]
        ),
        "CONCURRENT_LIMIT": UserFriendlyError(
            message="You have too many tasks running. Please wait for one to complete.",
            error_code="CONCURRENT_LIMIT",
            recoverable=True,
            actions=[
                {"type": "retry", "label": "Try again", "delay_seconds": 10}
            ]
        ),
        "MODEL_ACCESS_DENIED": UserFriendlyError(
            message="Your plan doesn't include access to this AI model.",
            error_code="MODEL_ACCESS_DENIED",
            recoverable=False,
            actions=[
                {"type": "link", "label": "Upgrade plan", "url": "/settings/billing"},
                {"type": "switch_model", "label": "Use default model"}
            ]
        ),
        "SANDBOX_UNAVAILABLE": UserFriendlyError(
            message="The development environment is temporarily unavailable. We're working on it.",
            error_code="SANDBOX_UNAVAILABLE",
            recoverable=True,
            actions=[
                {"type": "retry", "label": "Try again", "delay_seconds": 30}
            ]
        ),
        "LLM_OVERLOADED": UserFriendlyError(
            message="The AI service is experiencing high load. Retrying automatically.",
            error_code="LLM_OVERLOADED",
            recoverable=True,
            actions=[
                {"type": "retry", "label": "Try again", "delay_seconds": 5}
            ]
        ),
        "LLM_TIMEOUT": UserFriendlyError(
            message="The AI took too long to respond. This can happen with complex requests.",
            error_code="LLM_TIMEOUT",
            recoverable=True,
            actions=[
                {"type": "retry", "label": "Try again"},
                {"type": "simplify", "label": "Try a simpler request"}
            ]
        ),
        "CONTEXT_TOO_LONG": UserFriendlyError(
            message="The conversation is too long for the AI to process. Try starting a new thread.",
            error_code="CONTEXT_TOO_LONG",
            recoverable=False,
            actions=[
                {"type": "new_thread", "label": "Start new conversation"},
                {"type": "link", "label": "Learn more", "url": "/docs/context-limits"}
            ]
        ),
        "MCP_CONNECTION_FAILED": UserFriendlyError(
            message="Couldn't connect to one of your integrations. The task will continue without it.",
            error_code="MCP_CONNECTION_FAILED",
            recoverable=True,
            actions=[
                {"type": "link", "label": "Check integrations", "url": "/settings/integrations"}
            ]
        ),
        "TOOL_EXECUTION_FAILED": UserFriendlyError(
            message="A tool encountered an error. The AI will try an alternative approach.",
            error_code="TOOL_EXECUTION_FAILED",
            recoverable=True,
            actions=[]
        ),
        "AUTHENTICATION_EXPIRED": UserFriendlyError(
            message="Your session has expired. Please sign in again.",
            error_code="AUTHENTICATION_EXPIRED",
            recoverable=False,
            actions=[
                {"type": "link", "label": "Sign in", "url": "/login"}
            ]
        ),
        "NETWORK_ERROR": UserFriendlyError(
            message="Connection issue detected. Please check your internet connection.",
            error_code="NETWORK_ERROR",
            recoverable=True,
            actions=[
                {"type": "retry", "label": "Try again"}
            ]
        ),
        "INTERNAL_ERROR": UserFriendlyError(
            message="Something went wrong on our end. Our team has been notified.",
            error_code="INTERNAL_ERROR",
            recoverable=True,
            actions=[
                {"type": "retry", "label": "Try again", "delay_seconds": 5},
                {"type": "link", "label": "Check status", "url": "https://status.suna.so"}
            ]
        ),
        "BILLING_ERROR": UserFriendlyError(
            message="There's an issue with your billing. Please update your payment method.",
            error_code="BILLING_ERROR",
            recoverable=False,
            actions=[
                {"type": "link", "label": "Update payment", "url": "/settings/billing"}
            ]
        ),
        "PROJECT_NOT_FOUND": UserFriendlyError(
            message="This project no longer exists or you don't have access to it.",
            error_code="PROJECT_NOT_FOUND",
            recoverable=False,
            actions=[
                {"type": "link", "label": "Go to projects", "url": "/projects"}
            ]
        ),
        "THREAD_NOT_FOUND": UserFriendlyError(
            message="This conversation no longer exists.",
            error_code="THREAD_NOT_FOUND",
            recoverable=False,
            actions=[
                {"type": "new_thread", "label": "Start new conversation"}
            ]
        ),
    }
    
    EXCEPTION_PATTERNS = [
        ("rate limit", "RATE_LIMIT"),
        ("rate_limit", "RATE_LIMIT"),
        ("429", "RATE_LIMIT"),
        ("credit", "CREDIT_EXHAUSTED"),
        ("insufficient_credits", "CREDIT_EXHAUSTED"),
        ("concurrent", "CONCURRENT_LIMIT"),
        ("too many", "CONCURRENT_LIMIT"),
        ("model access", "MODEL_ACCESS_DENIED"),
        ("not allowed", "MODEL_ACCESS_DENIED"),
        ("sandbox", "SANDBOX_UNAVAILABLE"),
        ("workspace", "SANDBOX_UNAVAILABLE"),
        ("overloaded", "LLM_OVERLOADED"),
        ("capacity", "LLM_OVERLOADED"),
        ("timeout", "LLM_TIMEOUT"),
        ("timed out", "LLM_TIMEOUT"),
        ("context length", "CONTEXT_TOO_LONG"),
        ("token limit", "CONTEXT_TOO_LONG"),
        ("max.*token", "CONTEXT_TOO_LONG"),
        ("mcp", "MCP_CONNECTION_FAILED"),
        ("integration", "MCP_CONNECTION_FAILED"),
        ("tool.*fail", "TOOL_EXECUTION_FAILED"),
        ("tool.*error", "TOOL_EXECUTION_FAILED"),
        ("auth", "AUTHENTICATION_EXPIRED"),
        ("unauthorized", "AUTHENTICATION_EXPIRED"),
        ("401", "AUTHENTICATION_EXPIRED"),
        ("network", "NETWORK_ERROR"),
        ("connection", "NETWORK_ERROR"),
        ("billing", "BILLING_ERROR"),
        ("payment", "BILLING_ERROR"),
        ("project.*not found", "PROJECT_NOT_FOUND"),
        ("thread.*not found", "THREAD_NOT_FOUND"),
    ]
    
    @classmethod
    def map_error(
        cls,
        error: Exception,
        error_code: Optional[str] = None
    ) -> UserFriendlyError:
        if error_code and error_code in cls.MAPPINGS:
            return cls.MAPPINGS[error_code]
        
        error_str = str(error).lower()
        
        import re
        for pattern, code in cls.EXCEPTION_PATTERNS:
            if re.search(pattern, error_str):
                return cls.MAPPINGS[code]
        
        return cls.MAPPINGS["INTERNAL_ERROR"]
    
    @classmethod
    def map_code(cls, error_code: str) -> UserFriendlyError:
        return cls.MAPPINGS.get(error_code, cls.MAPPINGS["INTERNAL_ERROR"])
    
    @classmethod
    def to_stream_event(
        cls,
        error: Exception,
        error_code: Optional[str] = None
    ) -> Dict[str, Any]:
        mapped = cls.map_error(error, error_code)
        return {
            "error": mapped.message,
            "error_code": mapped.error_code,
            "recoverable": mapped.recoverable,
            "actions": mapped.actions
        }


error_mapper = ErrorMapper()
