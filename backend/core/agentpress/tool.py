"""
Core tool system providing the foundation for creating and managing tools.

This module defines the base classes and decorators for creating tools:
- Tool base class for implementing tool functionality
- Schema decorators for OpenAPI tool definitions
- Metadata decorators for tool and method information
- Result containers for standardized tool outputs
"""

from typing import Dict, Any, Union, Optional, List
from dataclasses import dataclass, field
from abc import ABC
import json
import inspect
from enum import Enum
from core.utils.logger import logger

class SchemaType(Enum):
    """Enumeration of supported schema types for tool definitions."""
    OPENAPI = "openapi"

@dataclass
class ToolSchema:
    """Container for tool schemas with type information.
    
    Attributes:
        schema_type (SchemaType): Type of schema (OpenAPI)
        schema (Dict[str, Any]): The actual schema definition
    """
    schema_type: SchemaType
    schema: Dict[str, Any]

@dataclass
class ToolResult:
    """Container for tool execution results.
    
    Attributes:
        success (bool): Whether the tool execution succeeded
        output (Any): Output data (can be dict, list, or string)
    """
    success: bool
    output: Any

@dataclass
class ToolMetadata:
    """Container for tool-level metadata.
    
    Attributes:
        display_name (str): Human-readable tool name
        description (str): Tool description
        icon (Optional[str]): Icon identifier for UI
        color (Optional[str]): Color class for UI styling
        is_core (bool): Whether this is a core tool (always enabled)
        weight (int): Sort order (lower = higher priority, default 100)
        visible (bool): Whether tool is visible in frontend UI (default False)
    """
    display_name: str
    description: str
    icon: Optional[str] = None
    color: Optional[str] = None
    is_core: bool = False
    weight: int = 100
    visible: bool = False

@dataclass
class MethodMetadata:
    """Container for method-level metadata.
    
    Attributes:
        display_name (str): Human-readable method name
        description (str): Method description
        is_core (bool): Whether this is a core method (always enabled)
        visible (bool): Whether method is visible in frontend UI (default True)
    """
    display_name: str
    description: str
    is_core: bool = False
    visible: bool = True

class Tool(ABC):
    """Abstract base class for all tools.
    
    Provides the foundation for implementing tools with schema registration
    and result handling capabilities.
    
    Attributes:
        _schemas (Dict[str, List[ToolSchema]]): Registered schemas for tool methods
        _metadata (Optional[ToolMetadata]): Tool-level metadata
        _method_metadata (Dict[str, MethodMetadata]): Method-level metadata
        
    Methods:
        get_schemas: Get all registered tool schemas
        get_metadata: Get tool metadata
        get_method_metadata: Get metadata for all methods
        success_response: Create a successful result
        fail_response: Create a failed result
    """
    
    def __init__(self):
        """Initialize tool with empty schema registry."""
        self._schemas: Dict[str, List[ToolSchema]] = {}
        self._metadata: Optional[ToolMetadata] = None
        self._method_metadata: Dict[str, MethodMetadata] = {}
        # logger.debug(f"Initializing tool class: {self.__class__.__name__}")
        self._register_metadata()
        self._register_schemas()

    def _register_metadata(self):
        """Register metadata from class and method decorators."""
        # Register tool-level metadata
        if hasattr(self.__class__, '__tool_metadata__'):
            self._metadata = self.__class__.__tool_metadata__
        
        # Register method-level metadata
        for name, method in inspect.getmembers(self, predicate=inspect.ismethod):
            if hasattr(method, '__method_metadata__'):
                self._method_metadata[name] = method.__method_metadata__

    def _register_schemas(self):
        """Register schemas from all decorated methods."""
        for name, method in inspect.getmembers(self, predicate=inspect.ismethod):
            if hasattr(method, 'tool_schemas'):
                self._schemas[name] = method.tool_schemas
                # logger.debug(f"Registered schemas for method '{name}' in {self.__class__.__name__}")

    def get_schemas(self) -> Dict[str, List[ToolSchema]]:
        """Get all registered tool schemas.
        
        Returns:
            Dict mapping method names to their schema definitions
        """
        return self._schemas

    def get_metadata(self) -> Optional[ToolMetadata]:
        """Get tool-level metadata.
        
        Returns:
            ToolMetadata object or None if not set
        """
        return self._metadata

    def get_method_metadata(self) -> Dict[str, MethodMetadata]:
        """Get metadata for all methods.
        
        Returns:
            Dict mapping method names to their metadata
        """
        return self._method_metadata

    def success_response(self, data: Union[Dict[str, Any], str, list]) -> ToolResult:
        """Create a successful tool result.
        
        Args:
            data: Result data (dictionary, list, or string)
            
        Returns:
            ToolResult with success=True and data as JSON string (if dict/list) or plain string
        """
        if isinstance(data, (dict, list)):
            output = json.dumps(data)
        else:
            output = str(data)
        
        return ToolResult(success=True, output=output)

    def fail_response(self, msg: str) -> ToolResult:
        """Create a failed tool result.
        
        Args:
            msg: Error message describing the failure
            
        Returns:
            ToolResult with success=False and error message
        """
        # logger.debug(f"Tool {self.__class__.__name__} returned failed result: {msg}")
        return ToolResult(success=False, output=msg)

def _add_schema(func, schema: ToolSchema):
    """Helper to add schema to a function."""
    if not hasattr(func, 'tool_schemas'):
        func.tool_schemas = []
    func.tool_schemas.append(schema)
    # logger.debug(f"Added {schema.schema_type.value} schema to function {func.__name__}")
    return func

def openapi_schema(schema: Dict[str, Any]):
    """Decorator for OpenAPI schema tools."""
    def decorator(func):
        # logger.debug(f"Applying OpenAPI schema to function {func.__name__}")
        return _add_schema(func, ToolSchema(
            schema_type=SchemaType.OPENAPI,
            schema=schema
        ))
    return decorator

def tool_metadata(
    display_name: str,
    description: str,
    icon: Optional[str] = None,
    color: Optional[str] = None,
    is_core: bool = False,
    weight: int = 100,
    visible: bool = False
):
    """Decorator to add metadata to a Tool class.
    
    Args:
        display_name: Human-readable tool name
        description: Tool description
        icon: Icon identifier for UI (optional)
        color: Color class for UI styling (optional)
        is_core: Whether this is a core tool that's always enabled
        weight: Sort order (lower = higher priority, default 100)
                Examples: Core tools=10, File ops=20, Advanced=90
        visible: Whether tool is visible in frontend UI (default True)
                 Set to False to hide from UI (internal/experimental tools)
    
    Usage:
        @tool_metadata(
            display_name="File Operations",
            description="Create, read, edit, and manage files",
            icon="FolderOpen",
            color="bg-blue-100 dark:bg-blue-800/50",
            weight=20,
            visible=True
        )
        class SandboxFilesTool(Tool):
            ...
        
        # Example: Hidden from UI (internal tool)
        @tool_metadata(
            display_name="Internal Feature",
            description="Internal functionality not shown in UI",
            visible=False
        )
        class InternalTool(Tool):
            ...
    """
    def decorator(cls):
        cls.__tool_metadata__ = ToolMetadata(
            display_name=display_name,
            description=description,
            icon=icon,
            color=color,
            is_core=is_core,
            weight=weight,
            visible=visible
        )
        return cls
    return decorator

def method_metadata(
    display_name: str,
    description: str,
    is_core: bool = False,
    visible: bool = True
):
    """Decorator to add metadata to a tool method.
    
    Args:
        display_name: Human-readable method name
        description: Method description
        is_core: Whether this is a core method that's always enabled
        visible: Whether method is visible in frontend UI (default True)
                 Set to False to hide from UI (internal/experimental methods)
    
    Usage:
        @method_metadata(
            display_name="Create File",
            description="Create new files with content",
            visible=True
        )
        @openapi_schema({...})
        def create_file(self, ...):
            ...
        
        # Example: Hidden from UI (internal method)
        @method_metadata(
            display_name="Internal Helper",
            description="Internal functionality not shown in UI",
            visible=False
        )
        @openapi_schema({...})
        def internal_method(self, ...):
            ...
    """
    def decorator(func):
        func.__method_metadata__ = MethodMetadata(
            display_name=display_name,
            description=description,
            is_core=is_core,
            visible=visible
        )
        return func
    return decorator

