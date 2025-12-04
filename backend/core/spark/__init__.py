"""
SPARK - Smart Progressive Activation Runtime Kit

An intelligent lazy-loading system for tools that enables:
- Just-In-Time (JIT) tool registration
- Minimal startup overhead  
- Dynamic tool activation on-demand
- Smart parameter detection for different tool types
- MCP tool support

The SPARK algorithm:
1. Startup: Register only 3 core tools (message, task_list, expand_msg)
2. Runtime: When agent calls load_tool_guide(tool_name):
   a. Load usage guide for documentation
   b. Dynamically register tool with ThreadManager
   c. Cache registration for subsequent uses
3. Result: Instant availability, minimal memory footprint
"""

from .loader import SPARKLoader, get_spark_loader
from .detector import ParameterDetector
from .registry import ToolActivationRegistry
from .function_map import get_tool_for_function, build_function_map
from .config import SPARKConfig
from .result_types import (
    ActivationResult, ActivationSuccess, ActivationError,
    ActivationErrorType, BatchActivationResult,
    is_success, is_error
)
from .bloom_filter import FunctionBloomFilter, create_function_bloom_filter

__all__ = [
    'SPARKLoader',
    'get_spark_loader',
    'ParameterDetector',
    'ToolActivationRegistry',
    'get_tool_for_function',
    'build_function_map',
    'SPARKConfig',
    'ActivationResult',
    'ActivationSuccess',
    'ActivationError',
    'ActivationErrorType',
    'BatchActivationResult',
    'is_success',
    'is_error',
    'FunctionBloomFilter',
    'create_function_bloom_filter',
]
