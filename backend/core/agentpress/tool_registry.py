from typing import Dict, Type, Any, List, Optional, Callable
from core.agentpress.tool import Tool, SchemaType
from core.utils.logger import logger
import json

# Builder tools that should load the comprehensive agent builder prompt
BUILDER_TOOLS = {
    'agent_config_tool',
    'mcp_search_tool',
    'credential_profile_tool',
    'trigger_tool',
    'agent_creation_tool'
}


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

    def get_openapi_schemas(self, core_only: bool = False) -> List[Dict[str, Any]]:
        """Get OpenAPI schemas for function calling.
        
        Args:
            core_only: If True, only return schemas for minimal core tools (messaging + tool_loader)
        
        Returns:
            List of OpenAPI-compatible schema definitions
        """
        # Define truly minimal core tools (only messaging and tool loading)
        MINIMAL_CORE_TOOLS = {'ExpandMessageTool', 'MessageTool', 'TaskListTool', 'ToolLoaderTool'}
        
        schemas = []
        for tool_info in self.tools.values():
            if tool_info['schema'].schema_type == SchemaType.OPENAPI:
                if core_only:
                    instance = tool_info['instance']
                    class_name = instance.__class__.__name__
                    # Only include minimal core tools
                    if class_name in MINIMAL_CORE_TOOLS:
                        schemas.append(tool_info['schema'].schema)
                else:
                    schemas.append(tool_info['schema'].schema)
        
        # logger.debug(f"Retrieved {len(schemas)} OpenAPI schemas (core_only={core_only})")
        return schemas
    
    def get_tool_schemas(self, tool_name: str) -> Dict[str, Any]:
        """Get all OpenAPI schemas and instructions for a specific tool.
        
        Args:
            tool_name: Tool name from centralized registry (e.g., 'browser_tool', 'sb_presentation_tool')
            
        Returns:
            Dict containing:
                - tool_name: The tool identifier
                - class_name: The tool class name
                - schemas: List of OpenAPI schemas for all methods in that tool
                - instructions: Tool instructions if available (from TOOL_INSTRUCTIONS attribute)
        """
        from core.tools.tool_registry import get_tool_info
        
        # Look up tool class name from centralized registry
        tool_info = get_tool_info(tool_name)
        if not tool_info:
            logger.warning(f"Tool {tool_name} not found in centralized registry")
            return {
                "tool_name": tool_name,
                "error": f"Tool '{tool_name}' not found in registry"
            }
        
        _, _, class_name = tool_info
        
        # Find all methods belonging to this tool class
        tool_schemas = []
        tool_instance = None
        
        for method_name, method_info in self.tools.items():
            instance = method_info['instance']
            if instance.__class__.__name__ == class_name:
                tool_instance = instance
                schema = method_info['schema']
                if schema.schema_type == SchemaType.OPENAPI:
                    tool_schemas.append(schema.schema)
        
        # Check if tool has TOOL_INSTRUCTIONS attribute
        instructions = None
        if tool_instance and hasattr(tool_instance, 'TOOL_INSTRUCTIONS'):
            instructions = tool_instance.TOOL_INSTRUCTIONS
        
        # If this is a builder tool, append the comprehensive agent builder prompt
        if tool_name in BUILDER_TOOLS:
            # Lazy import to avoid circular dependency
            from core.prompts.agent_builder_prompt import get_agent_builder_prompt
            builder_prompt = get_agent_builder_prompt()
            
            if instructions:
                instructions = f"{instructions}\n\n{builder_prompt}"
            else:
                instructions = builder_prompt
            
            logger.debug(f"Appended agent builder prompt to {tool_name}")
        
        result = {
            "tool_name": tool_name,
            "class_name": class_name,
            "schemas": tool_schemas,
        }
        
        if instructions:
            result["instructions"] = instructions
        
        logger.debug(f"Retrieved {len(tool_schemas)} schemas for tool {tool_name} ({class_name})")
        
        return result

