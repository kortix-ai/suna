from typing import Dict, Type, Any, List, Optional, Callable
from core.agentpress.tool import Tool, SchemaType
from core.utils.logger import logger
import json


class ToolRegistry:
    """Registry for managing and accessing tools.
    
    Maintains a collection of tool instances and their schemas, allowing for
    selective registration of tool functions and easy access to tool capabilities.
    
    Attributes:
        tools (Dict[str, Dict[str, Any]]): OpenAPI-style tools and schemas
        
    Methods:
        register_tool: Register a tool with optional function filtering
        get_tool: Get a specific tool by name
        get_openapi_schemas: Get OpenAPI schemas for function calling
    """
    
    def __init__(self):
        """Initialize a new ToolRegistry instance."""
        self.tools = {}
        logger.debug("Initialized new ToolRegistry instance")
    
    def register_tool(self, tool_class: Type[Tool], function_names: Optional[List[str]] = None, **kwargs):
        """Register a tool with optional function filtering.
        
        Args:
            tool_class: The tool class to register
            function_names: Optional list of specific functions to register
            **kwargs: Additional arguments passed to tool initialization
            
        Notes:
            - If function_names is None, all functions are registered
            - Handles OpenAPI schema registration
        """
        logger.debug(f"Registering tool class: {tool_class.__name__}")
        tool_instance = tool_class(**kwargs)
        schemas = tool_instance.get_schemas()
        
        logger.debug(f"Available schemas for {tool_class.__name__}: {list(schemas.keys())}")
        
        registered_openapi = 0
        
        for func_name, schema_list in schemas.items():
            if function_names is None or func_name in function_names:
                for schema in schema_list:
                    if schema.schema_type == SchemaType.OPENAPI:
                        self.tools[func_name] = {
                            "instance": tool_instance,
                            "schema": schema
                        }
                        registered_openapi += 1
                        logger.debug(f"Registered OpenAPI function {func_name} from {tool_class.__name__}")
        
        logger.debug(f"Tool registration complete for {tool_class.__name__}: {registered_openapi} OpenAPI functions")

    def get_available_functions(self) -> Dict[str, Callable]:
        """Get all available tool functions.
        
        Returns:
            Dict mapping function names to their implementations
        """
        available_functions = {}
        
        # Get OpenAPI tool functions
        for tool_name, tool_info in self.tools.items():
            tool_instance = tool_info['instance']
            function_name = tool_name
            function = getattr(tool_instance, function_name)
            available_functions[function_name] = function
            
        logger.debug(f"Retrieved {len(available_functions)} available functions")
        return available_functions

    def get_tool(self, tool_name: str) -> Dict[str, Any]:
        """Get a specific tool by name.
        
        Args:
            tool_name: Name of the tool function
            
        Returns:
            Dict containing tool instance and schema, or empty dict if not found
        """
        tool = self.tools.get(tool_name, {})
        if not tool:
            logger.warning(f"Tool not found: {tool_name}")
        return tool

    def get_openapi_schemas(self) -> List[Dict[str, Any]]:
        """Get OpenAPI schemas for function calling.
        
        Returns:
            List of OpenAPI-compatible schema definitions
        """
        schemas = [
            tool_info['schema'].schema 
            for tool_info in self.tools.values()
            if tool_info['schema'].schema_type == SchemaType.OPENAPI
        ]
        logger.debug(f"Retrieved {len(schemas)} OpenAPI schemas")
        return schemas

    def get_usage_examples(self) -> Dict[str, str]:
        """Get usage examples for tools.
        
        Returns:
            Dict mapping function names to their usage examples
        """
        examples = {}
        
        # Get all registered tools and their schemas
        for tool_name, tool_info in self.tools.items():
            tool_instance = tool_info['instance']
            all_schemas = tool_instance.get_schemas()
            
            # Look for usage examples for this function
            if tool_name in all_schemas:
                for schema in all_schemas[tool_name]:
                    if schema.schema_type == SchemaType.USAGE_EXAMPLE:
                        examples[tool_name] = schema.schema.get('example', '')
                        logger.debug(f"Found usage example for {tool_name}")
                        break
        
        logger.debug(f"Retrieved {len(examples)} usage examples")
        return examples

