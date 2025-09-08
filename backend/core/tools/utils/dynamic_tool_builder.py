from typing import Dict, Any, List, Callable, Awaitable
from core.agentpress.tool import ToolResult, ToolSchema, SchemaType
from core.utils.logger import logger


class DynamicToolBuilder:
    def __init__(self):
        self.dynamic_tools: Dict[str, Dict[str, Any]] = {}
        self.schemas: Dict[str, List[ToolSchema]] = {}
    
    def create_dynamic_methods(self, tools_info: List[Dict[str, Any]], custom_tools: Dict[str, Dict[str, Any]], execute_callback: Callable[[str, Dict[str, Any]], Awaitable[ToolResult]]) -> Dict[str, Callable]:
        methods = {}
        
        for tool_info in tools_info:
            tool_name = tool_info.get('name', '')
            if tool_name:
                method = self._create_dynamic_method(tool_name, tool_info, execute_callback)
                if method:
                    methods[method['method_name']] = method['method']
        
        for tool_name, tool_info in custom_tools.items():
            openapi_tool_info = {
                "name": tool_name,
                "description": tool_info['description'],
                "parameters": tool_info['parameters']
            }
            method = self._create_dynamic_method(tool_name, openapi_tool_info, execute_callback)
            if method:
                methods[method['method_name']] = method['method']
        
        logger.debug(f"Created {len(methods)} dynamic MCP tool methods")
        return methods
    
    def _create_dynamic_method(self, tool_name: str, tool_info: Dict[str, Any], execute_callback: Callable[[str, Dict[str, Any]], Awaitable[ToolResult]]) -> Dict[str, Any]:
        method_name, clean_tool_name, server_name = self._parse_tool_name(tool_name)
        
        logger.debug(f"Creating dynamic method for tool '{tool_name}': clean_tool_name='{clean_tool_name}', method_name='{method_name}', server='{server_name}'")
        
        async def dynamic_tool_method(**kwargs) -> ToolResult:
            return await execute_callback(tool_name, kwargs)
        
        dynamic_tool_method.__name__ = method_name
        dynamic_tool_method.__qualname__ = f"MCPToolWrapper.{method_name}"
        
        description = self._build_description(tool_info, server_name)
        schema = self._create_tool_schema(method_name, description, tool_info)
        
        dynamic_tool_method.tool_schemas = [schema]
        
        tool_data = {
            'method': dynamic_tool_method,
            'method_name': method_name,
            'original_tool_name': tool_name,
            'clean_tool_name': clean_tool_name,
            'server_name': server_name,
            'info': tool_info,
            'schema': schema
        }
        
        self.dynamic_tools[tool_name] = tool_data
        self.schemas[method_name] = [schema]
        
        logger.debug(f"Created dynamic method '{method_name}' for MCP tool '{tool_name}' from server '{server_name}'")
        
        return tool_data
    
    def _parse_tool_name(self, tool_name: str) -> tuple[str, str, str]:
        if tool_name.startswith("custom_"):
            parts = tool_name.split("_")
            if len(parts) >= 3:
                clean_tool_name = "_".join(parts[2:])
                server_name = parts[1] if len(parts) > 1 else "unknown"
            else:
                clean_tool_name = tool_name
                server_name = "unknown"
        else:
            parts = tool_name.split("_", 2)
            clean_tool_name = parts[2] if len(parts) > 2 else tool_name
            server_name = parts[1] if len(parts) > 1 else "unknown"
        
        method_name = clean_tool_name.replace('-', '_')
        return method_name, clean_tool_name, server_name
    
    def _build_description(self, tool_info: Dict[str, Any], server_name: str) -> str:
        base_description = tool_info.get("description", f"MCP tool from {server_name}")
        return f"{base_description} (MCP Server: {server_name})"
    
    def _create_tool_schema(self, method_name: str, description: str, tool_info: Dict[str, Any]) -> ToolSchema:
        openapi_function_schema = {
            "type": "function",
            "function": {
                "name": method_name,
                "description": description,
                "parameters": tool_info.get("parameters", {
                    "type": "object",
                    "properties": {},
                    "required": []
                })
            }
        }
        
        return ToolSchema(
            schema_type=SchemaType.OPENAPI,
            schema=openapi_function_schema
        )
    
    def get_dynamic_tools(self) -> Dict[str, Dict[str, Any]]:
        return self.dynamic_tools
    
    def get_schemas(self) -> Dict[str, List[ToolSchema]]:
        return self.schemas
    
    def find_method_by_name(self, name: str) -> Callable:
        for tool_data in self.dynamic_tools.values():
            if tool_data['method_name'] == name:
                return tool_data['method']
        
        name_with_hyphens = name.replace('_', '-')
        for tool_name, tool_data in self.dynamic_tools.items():
            if tool_data['method_name'] == name or tool_name == name_with_hyphens:
                return tool_data['method']
        
        return None 