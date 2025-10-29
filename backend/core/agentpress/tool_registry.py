from typing import Dict, Type, Any, List, Optional, Callable
from core.agentpress.tool import Tool, SchemaType, ExecutionFlowMetadata
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
        # logger.debug(f"Registering tool class: {tool_class.__name__}")
        tool_instance = tool_class(**kwargs)
        schemas = tool_instance.get_schemas()
        
        # logger.debug(f"Available schemas for {tool_class.__name__}: {list(schemas.keys())}")
        
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
                        # logger.debug(f"Registered OpenAPI function {func_name} from {tool_class.__name__}")
        
        # logger.debug(f"Tool registration complete for {tool_class.__name__}: {registered_openapi} OpenAPI functions")

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
        enhanced_schemas = []
        
        for tool_name, tool_info in self.tools.items():
            if tool_info['schema'].schema_type == SchemaType.OPENAPI:
                schema = tool_info['schema'].schema
                tool_instance = tool_info['instance']
                
                # Get execution flow metadata for this specific function
                execution_flow_metadata = tool_instance.get_execution_flow_metadata().get(tool_name)
                
                enhanced_schema = self._add_flow_parameter(schema, execution_flow_metadata)
                enhanced_schemas.append(enhanced_schema)
        
        # logger.debug(f"Retrieved {len(enhanced_schemas)} OpenAPI schemas with flow parameter")
        return enhanced_schemas



    def _add_flow_parameter(self, schema: Dict[str, Any], execution_flow_metadata: Optional[ExecutionFlowMetadata] = None) -> Dict[str, Any]:
        """Add flow parameter to a tool schema.
        
        Args:
            schema: The original OpenAPI schema
            execution_flow_metadata: Optional execution flow metadata from @execution_flow decorator
            
        Returns:
            Enhanced schema with flow parameter
        """
        # Deep copy the schema to avoid modifying the original
        import copy
        enhanced_schema = copy.deepcopy(schema)
        
        if "function" in enhanced_schema and "parameters" in enhanced_schema["function"]:
            params = enhanced_schema["function"]["parameters"]
            
            # Add flow parameter to properties
            if "properties" not in params:
                params["properties"] = {}
            
            # Determine default flow value and whether override is allowed
            if execution_flow_metadata:
                default_flow = execution_flow_metadata.default
                allows_override = execution_flow_metadata.allows_override
            else:
                # Fallback to CONTINUE default if no metadata
                default_flow = "CONTINUE"
                allows_override = True
            
            # Create flow parameter description based on metadata
            if allows_override:
                description = f"Execution flow type. Use 'STOP' to halt execution or 'CONTINUE' for ongoing processing. Default: '{default_flow}'"
            else:
                description = f"Execution flow type (fixed to '{default_flow}'). Use 'STOP' to halt execution or 'CONTINUE' for ongoing processing."
            
            params["properties"]["flow"] = {
                "type": "string",
                "enum": ["STOP", "CONTINUE"],
                "description": description,
                "default": default_flow
            }
            
            # Add flow to required parameters if not already present
            if "required" not in params:
                params["required"] = []
            
            # Note: We don't add flow to required since it has a default value
        
        return enhanced_schema

