"""
Core tool system providing the foundation for creating and managing tools.

This module defines the base classes and decorators for creating tools in AgentPress:
- Tool base class for implementing tool functionality
- Schema decorators for OpenAPI tool definitions
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
    USAGE_EXAMPLE = "usage_example"

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
        output (str): Output message or error description
    """
    success: bool
    output: str

class Tool(ABC):
    """Abstract base class for all tools.
    
    Provides the foundation for implementing tools with schema registration
    and result handling capabilities.
    
    Attributes:
        _schemas (Dict[str, List[ToolSchema]]): Registered schemas for tool methods
        
    Methods:
        get_schemas: Get all registered tool schemas
        success_response: Create a successful result
        fail_response: Create a failed result
    """
    
    def __init__(self):
        """Initialize tool with empty schema registry."""
        self._schemas: Dict[str, List[ToolSchema]] = {}
        logger.debug(f"Initializing tool class: {self.__class__.__name__}")
        self._register_schemas()

    def _register_schemas(self):
        """Register schemas from all decorated methods."""
        for name, method in inspect.getmembers(self, predicate=inspect.ismethod):
            if hasattr(method, 'tool_schemas'):
                self._schemas[name] = method.tool_schemas
                logger.debug(f"Registered schemas for method '{name}' in {self.__class__.__name__}")

    def get_schemas(self) -> Dict[str, List[ToolSchema]]:
        """Get all registered tool schemas.
        
        Returns:
            Dict mapping method names to their schema definitions
        """
        return self._schemas

    def success_response(self, data: Union[Dict[str, Any], str]) -> ToolResult:
        """Create a successful tool result.
        
        Args:
            data: Result data (dictionary or string)
            
        Returns:
            ToolResult with success=True and formatted output
        """
        if isinstance(data, str):
            text = data
        else:
            text = json.dumps(data, indent=2)
        logger.debug(f"Created success response for {self.__class__.__name__}")
        return ToolResult(success=True, output=text)

    def fail_response(self, msg: str) -> ToolResult:
        """Create a failed tool result.
        
        Args:
            msg: Error message describing the failure
            
        Returns:
            ToolResult with success=False and error message
        """
        logger.debug(f"Tool {self.__class__.__name__} returned failed result: {msg}")
        return ToolResult(success=False, output=msg)

def _add_schema(func, schema: ToolSchema):
    """Helper to add schema to a function."""
    if not hasattr(func, 'tool_schemas'):
        func.tool_schemas = []
    func.tool_schemas.append(schema)
    logger.debug(f"Added {schema.schema_type.value} schema to function {func.__name__}")
    return func

def openapi_schema(schema: Dict[str, Any]):
    """Decorator for OpenAPI schema tools."""
    def decorator(func):
        logger.debug(f"Applying OpenAPI schema to function {func.__name__}")
        return _add_schema(func, ToolSchema(
            schema_type=SchemaType.OPENAPI,
            schema=schema
        ))
    return decorator

def usage_example(example: str):
    """Decorator for providing usage examples for tools in prompts."""
    def decorator(func):
        logger.debug(f"Adding usage example to function {func.__name__}")
        return _add_schema(func, ToolSchema(
            schema_type=SchemaType.USAGE_EXAMPLE,
            schema={"example": example}
        ))
    return decorator

# def xml_schema(**kwargs):
#     """Deprecated decorator - does nothing, kept for compatibility."""
#     def decorator(func):
#         logger.debug(f"xml_schema decorator called on {func.__name__} - ignoring (deprecated)")
#         return func
#     return decorator