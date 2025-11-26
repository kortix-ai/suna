from typing import Dict, Type, Any, List, Optional, Callable
from core.agentpress.tool import Tool, SchemaType
from core.utils.logger import logger
import json


class ToolRegistry:
    """Registry for managing and accessing tools.
    
    Maintains a collection of tool instances and their schemas, allowing for
    selective registration of tool functions and easy access to tool capabilities.
    
    PERFORMANCE: Uses pre-computed schemas from the global cache when available,
    avoiding expensive reflection-based schema extraction on each registration.
    
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
            - Uses cached schemas and instances when available for better performance
        """
        import time
        start = time.time()
        
        # Try to use cached instance first (for stateless tools without kwargs)
        from core.utils.tool_discovery import get_cached_schemas, get_cached_tool_instance
        
        tool_instance = None
        used_cache = False
        if not kwargs:
            # Only use cached instance if no custom kwargs
            tool_instance = get_cached_tool_instance(tool_class)
            if tool_instance:
                used_cache = True
        
        if tool_instance is None:
            # Create new instance if not cached or has custom kwargs
            tool_instance = tool_class(**kwargs)
        
        # Try to use cached schemas first (pre-computed at startup)
        schemas = get_cached_schemas(tool_class)
        schema_cached = schemas is not None
        
        if schemas is None:
            # Fall back to instance-based schema extraction
            schemas = tool_instance.get_schemas()
        
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
        
        elapsed = (time.time() - start) * 1000
        if elapsed > 10:  # Only log if took >10ms (noisy otherwise)
            cache_info = f"(instance={'cached' if used_cache else 'new'}, schema={'cached' if schema_cached else 'computed'})"
            logger.debug(f"⏱️ [TIMING] register_tool({tool_class.__name__}): {elapsed:.1f}ms {cache_info}")

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
            
        # logger.debug(f"Retrieved {len(available_functions)} available functions")
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
        # logger.debug(f"Retrieved {len(schemas)} OpenAPI schemas")
        return schemas

