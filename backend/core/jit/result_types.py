from dataclasses import dataclass
from enum import Enum
from typing import Optional, Dict, Any, List, Union

class ActivationErrorType(Enum):
    TOOL_NOT_FOUND = "tool_not_found"
    BLOCKED_BY_CONFIG = "blocked_by_config"
    DEPENDENCY_MISSING = "dependency_missing"
    CYCLIC_DEPENDENCY = "cyclic_dependency"
    IMPORT_ERROR = "import_error"
    INIT_FAILED = "init_failed"
    ALREADY_ACTIVATED = "already_activated"
    PARAMETER_ERROR = "parameter_error"

@dataclass
class ActivationError:
    error_type: ActivationErrorType
    message: str
    tool_name: str
    details: Optional[Dict[str, Any]] = None
    
    def to_user_message(self) -> str:
        if self.error_type == ActivationErrorType.BLOCKED_BY_CONFIG:
            return (
                f"Tool '{self.tool_name}' is not available for this agent. "
                f"Reason: {self.message}. "
                f"Try using alternative tools instead."
            )
        elif self.error_type == ActivationErrorType.DEPENDENCY_MISSING:
            deps = self.details.get('missing_dependencies', []) if self.details else []
            return (
                f"Tool '{self.tool_name}' requires {', '.join(deps)} to be loaded first. "
                f"Try: initialize_tools({deps + [self.tool_name]})"
            )
        elif self.error_type == ActivationErrorType.CYCLIC_DEPENDENCY:
            cycle = self.details.get('cycle', []) if self.details else []
            return (
                f"Cannot activate '{self.tool_name}' due to circular dependency: "
                f"{' -> '.join(cycle)}. Please check tool configuration."
            )
        elif self.error_type == ActivationErrorType.TOOL_NOT_FOUND:
            suggestions = self.details.get('suggestions', []) if self.details else []
            msg = f"Tool '{self.tool_name}' not found in registry."
            if suggestions:
                msg += f" Did you mean: {', '.join(suggestions)}?"
            return msg
        elif self.error_type == ActivationErrorType.IMPORT_ERROR:
            return (
                f"Failed to import tool '{self.tool_name}': {self.message}. "
                f"This tool may be misconfigured or have missing dependencies."
            )
        elif self.error_type == ActivationErrorType.INIT_FAILED:
            return (
                f"Failed to initialize tool '{self.tool_name}': {self.message}. "
                f"Check that all required parameters are available."
            )
        elif self.error_type == ActivationErrorType.PARAMETER_ERROR:
            missing = self.details.get('missing_params', []) if self.details else []
            return (
                f"Tool '{self.tool_name}' requires parameters that are not available: "
                f"{', '.join(missing)}. Context may be insufficient."
            )
        else:
            return f"Failed to activate tool '{self.tool_name}': {self.message}"
    
    def is_retryable(self) -> bool:
        non_retryable = {
            ActivationErrorType.BLOCKED_BY_CONFIG,
            ActivationErrorType.CYCLIC_DEPENDENCY,
            ActivationErrorType.TOOL_NOT_FOUND,
        }
        return self.error_type not in non_retryable

@dataclass
class ActivationSuccess:
    tool_name: str
    load_time_ms: float
    dependencies_loaded: Optional[List[str]] = None
    function_count: Optional[int] = None
    
    def __str__(self) -> str:
        msg = f"✅ Tool '{self.tool_name}' activated in {self.load_time_ms:.1f}ms"
        if self.dependencies_loaded:
            msg += f" (with dependencies: {', '.join(self.dependencies_loaded)})"
        if self.function_count:
            msg += f" - {self.function_count} functions available"
        return msg


ActivationResult = Union[ActivationSuccess, ActivationError]

def is_success(result: ActivationResult) -> bool:
    return isinstance(result, ActivationSuccess)

def is_error(result: ActivationResult) -> bool:
    return isinstance(result, ActivationError)

@dataclass
class BatchActivationResult:
    successful: List[ActivationSuccess]
    failed: List[ActivationError]
    total_time_ms: float
    
    @property
    def success_rate(self) -> float:
        total = len(self.successful) + len(self.failed)
        if total == 0:
            return 0.0
        return (len(self.successful) / total) * 100
    
    def get_activated_tools(self) -> List[str]:
        return [s.tool_name for s in self.successful]
    
    def get_failed_tools(self) -> List[str]:
        return [f.tool_name for f in self.failed]
    
    def __str__(self) -> str:
        return (
            f"Batch activation: {len(self.successful)}/{len(self.successful) + len(self.failed)} "
            f"succeeded ({self.success_rate:.1f}%) in {self.total_time_ms:.1f}ms"
        )
