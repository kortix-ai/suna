"""
Centralized error processing for AgentPress.

This module provides a unified way to handle, format, and propagate errors
throughout the agent execution pipeline using LiteLLM's standardized exceptions.
"""

from typing import Dict, Any, Optional, Union
from dataclasses import dataclass
from core.utils.logger import logger

# Import LiteLLM exceptions as documented at https://docs.litellm.ai/docs/exception_mapping
try:
    from litellm import (
        BadRequestError,
        ContextWindowExceededError,
        AuthenticationError,
        RateLimitError,
        ServiceUnavailableError,
        APIConnectionError,
        APIError,
        InternalServerError,
        NotFoundError,
        ContentPolicyViolationError,
        UnprocessableEntityError,
        InvalidRequestError,
        BudgetExceededError
    )
    LITELLM_IMPORTED = True
except ImportError:
    logger.warning("Could not import LiteLLM exceptions, using generic exception handling")
    # Fallback to generic exceptions if LiteLLM imports fail
    BadRequestError = Exception
    ContextWindowExceededError = Exception
    AuthenticationError = Exception
    RateLimitError = Exception
    ServiceUnavailableError = Exception
    APIConnectionError = Exception
    APIError = Exception
    InternalServerError = Exception
    NotFoundError = Exception
    ContentPolicyViolationError = Exception
    UnprocessableEntityError = Exception
    InvalidRequestError = Exception
    BudgetExceededError = Exception
    LITELLM_IMPORTED = False


@dataclass
class ProcessedError:
    """Standardized error representation."""
    error_type: str
    message: str
    original_error: Optional[Exception] = None
    context: Optional[Dict[str, Any]] = None
    
    def to_stream_dict(self) -> Dict[str, Any]:
        """Convert to stream-compatible error dict."""
        return {
            "type": "status",
            "status": "error",
            "message": self.message,
            "error_type": self.error_type
        }


class ErrorProcessor:
    """Centralized error processing using LiteLLM's exception hierarchy."""
    
    @staticmethod
    def process_llm_error(error: Exception, context: Optional[Dict[str, Any]] = None) -> ProcessedError:
        """Process LLM-related errors using LiteLLM's exception types."""
        error_message = ErrorProcessor.safe_error_to_string(error)
        
        if isinstance(error, ContextWindowExceededError):
            return ProcessedError(
                error_type="context_window_exceeded",
                message=f"Context window exceeded: The conversation is too long for this model. {error_message}",
                original_error=error,
                context=context
            )
        
        elif isinstance(error, AuthenticationError):
            return ProcessedError(
                error_type="authentication_error",
                message=f"Authentication failed: Please check your API credentials. {error_message}",
                original_error=error,
                context=context
            )
        
        elif isinstance(error, RateLimitError):
            return ProcessedError(
                error_type="rate_limit_error",
                message=f"Rate limit exceeded: Too many requests to the API. Please retry later. {error_message}",
                original_error=error,
                context=context
            )
        
        elif isinstance(error, InvalidRequestError):
            return ProcessedError(
                error_type="invalid_request_error",
                message=f"Invalid request: {error_message}",
                original_error=error,
                context=context
            )
        
        elif isinstance(error, BudgetExceededError):
            return ProcessedError(
                error_type="budget_exceeded_error",
                message=f"Budget exceeded: API usage limit reached. {error_message}",
                original_error=error,
                context=context
            )
        
        elif isinstance(error, ServiceUnavailableError):
            return ProcessedError(
                error_type="service_unavailable",
                message=f"Service unavailable: The AI service is temporarily unavailable. {error_message}",
                original_error=error,
                context=context
            )
        
        elif isinstance(error, ContentPolicyViolationError):
            return ProcessedError(
                error_type="content_policy_violation",
                message=f"Content policy violation: The request was rejected by content filters. {error_message}",
                original_error=error,
                context=context
            )
        
        elif isinstance(error, BadRequestError):
            return ProcessedError(
                error_type="bad_request",
                message=f"Invalid request: {error_message}",
                original_error=error,
                context=context
            )
        
        elif isinstance(error, (APIConnectionError, APIError, InternalServerError)):
            return ProcessedError(
                error_type="api_error",
                message=f"API error: {error_message}",
                original_error=error,
                context=context
            )
        
        else:
            # Fallback for unknown error types
            return ProcessedError(
                error_type="llm_error",
                message=f"LLM error: {error_message}",
                original_error=error,
                context=context
            )
    
    @staticmethod
    def process_tool_error(error: Exception, tool_name: str, context: Optional[Dict[str, Any]] = None) -> ProcessedError:
        """Process tool execution errors."""
        return ProcessedError(
            error_type="tool_execution_error",
            message=f"Tool '{tool_name}' execution failed: {ErrorProcessor.safe_error_to_string(error)}",
            original_error=error,
            context=context
        )
    
    @staticmethod
    def process_system_error(error: Exception, context: Optional[Dict[str, Any]] = None) -> ProcessedError:
        """Process general system errors."""
        return ProcessedError(
            error_type="system_error",
            message=f"System error: {ErrorProcessor.safe_error_to_string(error)}",
            original_error=error,
            context=context
        )
    
    @staticmethod
    def safe_error_to_string(error: Exception) -> str:
        """Safely convert an exception to a string with fallback"""
        try:
            return str(error)
            
        except Exception:
            try:
                # Handle case where error.args[0] might be a list or other non-string type
                if error.args:
                    first_arg = error.args[0]
                    if isinstance(first_arg, (list, tuple)):
                        # Convert list/tuple to string safely
                        return f"{type(error).__name__}: {str(first_arg)}"
                    else:
                        return f"{type(error).__name__}: {str(first_arg)}"
                else:
                    return f"{type(error).__name__}: Unknown error"
            except Exception:
                return f"Error of type {type(error).__name__}"
    
    @staticmethod
    def log_error(processed_error: ProcessedError, level: str = "error") -> None:
        """Log a processed error with appropriate level."""
        log_func = getattr(logger, level, logger.error)
        
        log_message = f"[{processed_error.error_type.upper()}] {processed_error.message}"
        
        # NEVER pass exc_info to structlog - it causes concatenation errors with complex exceptions
        # Instead, log the error details safely
        if processed_error.original_error:
            try:
                error_details = f"Original error: {ErrorProcessor.safe_error_to_string(processed_error.original_error)}"
                log_func(f"{log_message} | {error_details}")
            except Exception:
                # If even our safe conversion fails, just log the message
                log_func(log_message)
        else:
            log_func(log_message)
        
        if processed_error.context:
            logger.debug(f"Error context: {processed_error.context}")
