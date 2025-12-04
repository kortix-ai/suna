from typing import Dict, Type, Any, List, Optional, Callable
from core.agentpress.tool import Tool, SchemaType
from core.utils.logger import logger
import json


class ToolRegistry:
    def __init__(self):
        self.tools = {}
        self._cached_openapi_schemas = None  # ⚡ Cache schemas for repeated calls
        logger.debug("Initialized new ToolRegistry instance")
    
    def register_tool(self, tool_class: Type[Tool], function_names: Optional[List[str]] = None, **kwargs):
        import time
        start = time.time()
        
        from core.utils.tool_discovery import get_cached_schemas, get_cached_tool_instance
        
        tool_instance = None
        used_cache = False
        if not kwargs:
            tool_instance = get_cached_tool_instance(tool_class)
            if tool_instance:
                used_cache = True
        
        if tool_instance is None:
            tool_instance = tool_class(**kwargs)
        
        schemas = get_cached_schemas(tool_class)
        schema_cached = schemas is not None
        
        if schemas is None:
            schemas = tool_instance.get_schemas()
        
        registered_openapi = 0
        
        self._cached_openapi_schemas = None
        if hasattr(self, '_cached_functions'):
            self._cached_functions = None
        
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
        if elapsed > 10:
            cache_info = f"(instance={'cached' if used_cache else 'new'}, schema={'cached' if schema_cached else 'computed'})"
            logger.debug(f"⏱️ [TIMING] register_tool({tool_class.__name__}): {elapsed:.1f}ms {cache_info}")

    def get_available_functions(self) -> Dict[str, Callable]:
        if hasattr(self, '_cached_functions') and self._cached_functions is not None:
            return self._cached_functions
        
        available_functions = {}
        for tool_name, tool_info in self.tools.items():
            tool_instance = tool_info['instance']
            function_name = tool_name
            function = getattr(tool_instance, function_name)
            available_functions[function_name] = function
        
        self._cached_functions = available_functions
        logger.debug(f"⚡ [CACHE] Cached {len(available_functions)} available functions for reuse")
        return available_functions
    
    def invalidate_function_cache(self):
        if hasattr(self, '_cached_functions'):
            self._cached_functions = None

    def get_tool(self, tool_name: str) -> Dict[str, Any]:
        tool = self.tools.get(tool_name, {})
        if not tool:
            logger.warning(f"Tool not found: {tool_name}")
        return tool

    def get_openapi_schemas(self) -> List[Dict[str, Any]]:
        if self._cached_openapi_schemas is not None:
            return self._cached_openapi_schemas
        
        schemas = [
            tool_info['schema'].schema 
            for tool_info in self.tools.values()
            if tool_info['schema'].schema_type == SchemaType.OPENAPI
        ]
        
        self._cached_openapi_schemas = schemas
        logger.debug(f"⚡ [CACHE] Cached {len(schemas)} OpenAPI schemas for reuse")
        return schemas
    
    def invalidate_schema_cache(self):
        self._cached_openapi_schemas = None

