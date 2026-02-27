"""
Processor configuration for agent pipelines.

This module provides configuration classes for response processing and tool execution.
"""

from typing import Literal
from dataclasses import dataclass

# Type alias for tool execution strategy
ToolExecutionStrategy = Literal["sequential", "parallel"]

@dataclass
class ProcessorConfig:
    """
    Configuration for response processing and tool execution.
    
    This class controls how the LLM's responses are processed, including how tool calls
    are detected, executed, and their results handled.
    
    Attributes:
        xml_tool_calling: Enable XML-based tool call detection (<tool>...</tool>)
        native_tool_calling: Enable OpenAI-style function calling format
        execute_tools: Whether to automatically execute detected tool calls
        execute_on_stream: For streaming, execute tools as they appear vs. at the end
        tool_execution_strategy: How to execute multiple tools ("sequential" or "parallel")
        
    NOTE: Default values are loaded from core.utils.config (backend/core/utils/config.py)
    Change AGENT_XML_TOOL_CALLING, AGENT_NATIVE_TOOL_CALLING, etc. in config.py
    to modify the defaults globally.
    """

    xml_tool_calling: bool = None  # Set in __post_init__ from global config
    native_tool_calling: bool = None  # Set in __post_init__ from global config

    execute_tools: bool = True
    execute_on_stream: bool = None  # Set in __post_init__ from global config
    tool_execution_strategy: ToolExecutionStrategy = None  # Set in __post_init__ from global config
    
    def __post_init__(self):
        """Load defaults from global config and validate configuration."""
        # Import here to avoid circular dependency
        from core.utils.config import config
        
        # Load defaults from global config if not explicitly set
        if self.xml_tool_calling is None:
            self.xml_tool_calling = config.AGENT_XML_TOOL_CALLING
        if self.native_tool_calling is None:
            self.native_tool_calling = config.AGENT_NATIVE_TOOL_CALLING
        if self.execute_on_stream is None:
            self.execute_on_stream = config.AGENT_EXECUTE_ON_STREAM
        if self.tool_execution_strategy is None:
            self.tool_execution_strategy = config.AGENT_TOOL_EXECUTION_STRATEGY
        
        # Validate
        if self.xml_tool_calling is False and self.native_tool_calling is False and self.execute_tools:
            raise ValueError("At least one tool calling format (XML or native) must be enabled if execute_tools is True")
