"""
Auto-discovery system for tools.

Uses Python's class inheritance to discover all Tool subclasses and extract their metadata.
Tools are discovered via Tool.__subclasses__() rather than filesystem scanning.

PERFORMANCE OPTIMIZATION:
- Tool classes are pre-imported at startup via warm_up_tools_cache()
- Tool schemas are pre-computed and cached globally to avoid per-request overhead
- The schema cache uses tool class identity as key for O(1) lookups
"""

import importlib
import inspect
from typing import Dict, List, Any, Optional, Type
from pathlib import Path

from core.agentpress.tool import Tool, ToolMetadata, MethodMetadata, ToolSchema
from core.utils.logger import logger


# Global cache for pre-computed tool schemas (keyed by tool class)
# This is populated at startup and reused across all agent runs
_SCHEMA_CACHE: Dict[Type[Tool], Dict[str, List[ToolSchema]]] = {}

# Global cache for pre-instantiated stateless tools
# Tools that don't require per-request state can be reused
_STATELESS_TOOL_INSTANCES: Dict[Type[Tool], Tool] = {}

# Tools that CAN be pre-instantiated (no constructor args required)
STATELESS_TOOLS = {
    'expand_msg_tool', 'message_tool', 'task_list_tool',
    'data_providers_tool', 'web_search_tool', 'image_search_tool',
    'people_search_tool', 'company_search_tool', 'paper_search_tool',
}


def _precompute_schemas_for_class(tool_class: Type[Tool]) -> Dict[str, List[ToolSchema]]:
    """Pre-compute schemas for a tool class by examining its methods.
    
    This extracts schemas directly from the class without instantiating it,
    which is faster and doesn't require constructor arguments.
    
    Args:
        tool_class: The tool class to extract schemas from
        
    Returns:
        Dict mapping method names to their schema definitions
    """
    schemas = {}
    
    # Iterate over all class methods
    for name in dir(tool_class):
        if name.startswith('_'):
            continue
            
        try:
            attr = getattr(tool_class, name)
            # Check if it's a method with tool_schemas attached by the decorator
            if callable(attr) and hasattr(attr, 'tool_schemas'):
                schemas[name] = attr.tool_schemas
        except Exception:
            # Skip any attributes that can't be accessed
            pass
    
    return schemas


def get_cached_schemas(tool_class: Type[Tool]) -> Optional[Dict[str, List[ToolSchema]]]:
    """Get pre-computed schemas for a tool class from the global cache.
    
    Args:
        tool_class: The tool class to get schemas for
        
    Returns:
        Dict mapping method names to schema definitions, or None if not cached
    """
    return _SCHEMA_CACHE.get(tool_class)


def get_cached_tool_instance(tool_class: Type[Tool]) -> Optional[Tool]:
    """Get a pre-instantiated tool instance if available.
    
    Only works for stateless tools that don't require constructor arguments.
    
    Args:
        tool_class: The tool class to get an instance of
        
    Returns:
        Pre-instantiated tool instance, or None if not cached
    """
    return _STATELESS_TOOL_INSTANCES.get(tool_class)


def _get_all_tool_subclasses(base_class: Type[Tool] = None) -> List[Type[Tool]]:
    """Get all subclasses of Tool recursively.
    
    Args:
        base_class: Starting class (defaults to Tool)
        
    Returns:
        List of all Tool subclass types
    """
    if base_class is None:
        base_class = Tool
    
    all_subclasses = []
    
    for subclass in base_class.__subclasses__():
        # Skip abstract base classes
        if not inspect.isabstract(subclass):
            all_subclasses.append(subclass)
        # Recursively get subclasses
        all_subclasses.extend(_get_all_tool_subclasses(subclass))
    
    return all_subclasses


def _generate_display_name(name: str) -> str:
    """Generate a display name from a snake_case or CamelCase name.
    
    Args:
        name: Name to convert (class name or snake_case)
        
    Returns:
        Human-readable display name
    """
    # Remove common suffixes
    if name.endswith('_tool'):
        name = name[:-5]
    if name.endswith('Tool'):
        name = name[:-4]
    
    # Convert snake_case or CamelCase to Title Case
    import re
    s1 = re.sub('(.)([A-Z][a-z]+)', r'\1 \2', name)
    s2 = re.sub('([a-z0-9])([A-Z])', r'\1 \2', s1)
    s3 = s2.replace('_', ' ')
    return s3.title()


# Cache for discovered tools to avoid repeated expensive imports
_TOOLS_CACHE = None
_WARMUP_COMPLETE = False


def warm_up_tools_cache():
    """Pre-load and cache all tool classes, schemas, AND stateless instances on startup.
    
    This should be called when a worker or API process starts to avoid the first
    user request paying the cost of:
    - Importing all tool modules (~100-500ms)
    - Computing schemas via reflection (~50-200ms per tool)
    - Instantiating tools (~5-20ms per tool)
    
    After warm-up, tool registration is nearly instant as it uses cached schemas
    and can reuse pre-instantiated stateless tools.
    """
    global _WARMUP_COMPLETE
    
    if _WARMUP_COMPLETE:
        logger.debug("Tools already warmed up, skipping")
        return
        
    logger.info("🔥 Warming up: loading tool classes, schemas, and stateless instances...")
    import time
    start = time.time()
    
    # Step 1: Discover and cache all tool classes
    tools_map = discover_tools()
    
    # Step 2: Pre-compute schemas for all tool classes
    schema_count = 0
    instance_count = 0
    
    for tool_name, tool_class in tools_map.items():
        # Cache schemas
        if tool_class not in _SCHEMA_CACHE:
            try:
                schemas = _precompute_schemas_for_class(tool_class)
                _SCHEMA_CACHE[tool_class] = schemas
                schema_count += len(schemas)
            except Exception as e:
                logger.warning(f"Failed to pre-compute schemas for {tool_name}: {e}")
        
        # Pre-instantiate stateless tools (no constructor args)
        if tool_name in STATELESS_TOOLS and tool_class not in _STATELESS_TOOL_INSTANCES:
            try:
                # Only instantiate if constructor has no required args (except self)
                import inspect
                sig = inspect.signature(tool_class.__init__)
                required_params = [
                    p for p in sig.parameters.values() 
                    if p.name != 'self' and p.default == inspect.Parameter.empty
                ]
                if not required_params:
                    _STATELESS_TOOL_INSTANCES[tool_class] = tool_class()
                    instance_count += 1
            except Exception as e:
                logger.debug(f"Could not pre-instantiate {tool_name}: {e}")
    
    elapsed = time.time() - start
    _WARMUP_COMPLETE = True
    logger.info(f"✅ Ready: {len(_TOOLS_CACHE)} tools, {schema_count} methods, {instance_count} instances cached in {elapsed:.2f}s")


def discover_tools() -> Dict[str, Type[Tool]]:
    """Discover all available tools from the centralized tool registry.
    
    Tool names and their corresponding classes are defined in the centralized registry
    (core.tools.tool_registry), which is also used for runtime tool registration.
    This ensures tool names are always consistent between runtime and UI metadata,
    eliminating naming mismatches.
    
    Returns:
        Dict mapping tool names (str) to tool classes (Type[Tool])
        Example: {'web_search_tool': SandboxWebSearchTool, 'browser_tool': BrowserTool, ...}
    """
    global _TOOLS_CACHE
    if _TOOLS_CACHE is not None:
        return _TOOLS_CACHE
    
    from core.tools.tool_registry import get_all_tools
    _TOOLS_CACHE = get_all_tools()
    logger.debug(f"Loaded and cached {len(_TOOLS_CACHE)} tool classes")
    return _TOOLS_CACHE


def _extract_tool_metadata(tool_name: str, tool_class: Type[Tool]) -> Dict[str, Any]:
    """Extract metadata from a tool class.
    
    Args:
        tool_name: Name of the tool
        tool_class: Tool class to extract metadata from
        
    Returns:
        Dict containing extracted metadata
    """
    # Get class-level metadata
    tool_metadata = getattr(tool_class, '__tool_metadata__', None)
    
    # Build base metadata
    metadata = {
        "name": tool_name,
        "tool_class": tool_class.__name__,
        "enabled": True,
        "methods": []
    }
    
    # Add tool-level metadata
    if tool_metadata:
        metadata["display_name"] = tool_metadata.display_name
        metadata["description"] = tool_metadata.description
        if tool_metadata.icon:
            metadata["icon"] = tool_metadata.icon
        if tool_metadata.color:
            metadata["color"] = tool_metadata.color
        metadata["is_core"] = tool_metadata.is_core
        metadata["weight"] = tool_metadata.weight
        metadata["visible"] = tool_metadata.visible
    else:
        # Auto-generate defaults
        metadata["display_name"] = _generate_display_name(tool_class.__name__)
        metadata["description"] = tool_class.__doc__.strip() if tool_class.__doc__ else f"{tool_class.__name__} functionality"
        metadata["is_core"] = False
        metadata["weight"] = 100
        metadata["visible"] = False
    
    # Extract method metadata
    for method_name in dir(tool_class):
        if method_name.startswith('_'):
            continue
        
        try:
            method = getattr(tool_class, method_name)
            if not callable(method):
                continue
            
            # Check if method has OpenAPI schema (means it's a tool method)
            if not hasattr(method, 'tool_schemas'):
                continue
            
            # Get method metadata
            method_metadata = getattr(method, '__method_metadata__', None)
            
            method_info = {
                "name": method_name,
                "enabled": True
            }
            
            if method_metadata:
                method_info["display_name"] = method_metadata.display_name
                method_info["description"] = method_metadata.description
                method_info["is_core"] = method_metadata.is_core
                method_info["visible"] = method_metadata.visible
            else:
                # Auto-generate from method name and schema
                method_info["display_name"] = _generate_display_name(method_name)
                
                # Try to extract description from OpenAPI schema
                schemas = method.tool_schemas
                if schemas:
                    schema = schemas[0].schema
                    if 'function' in schema and 'description' in schema['function']:
                        method_info["description"] = schema['function']['description']
                    else:
                        method_info["description"] = f"{method_name} function"
                else:
                    method_info["description"] = f"{method_name} function"
                
                method_info["is_core"] = False
                method_info["visible"] = True
            
            metadata["methods"].append(method_info)
        except Exception as e:
            # logger.debug(f"Could not extract metadata for method {method_name}: {e}")
            continue
    
    return metadata


def get_tools_metadata() -> List[Dict[str, Any]]:
    """Get metadata for all discovered tools.
    
    Returns:
        List of tool metadata dicts
    """
    tools_map = discover_tools()
    metadata_list = []
    
    for tool_name, tool_class in tools_map.items():
        try:
            metadata = _extract_tool_metadata(tool_name, tool_class)
            metadata_list.append(metadata)
        except Exception as e:
            logger.warning(f"Failed to extract metadata for {tool_name}: {e}")
    
    return metadata_list


def get_tool_group(tool_name: str) -> Optional[Dict[str, Any]]:
    """Get metadata for a specific tool.
    
    Args:
        tool_name: Name of the tool
        
    Returns:
        Tool metadata dict or None
    """
    tools_map = discover_tools()
    tool_class = tools_map.get(tool_name)
    
    if not tool_class:
        return None
    
    return _extract_tool_metadata(tool_name, tool_class)


def get_enabled_methods_for_tool(tool_name: str, config: Dict[str, Any]) -> Optional[List[str]]:
    """Get list of enabled method names for a tool.
    
    Args:
        tool_name: Name of the tool
        config: Tool configuration dict
        
    Returns:
        List of enabled method names, or None if all methods should be enabled
    """
    tool_metadata = get_tool_group(tool_name)
    if not tool_metadata:
        return None
    
    tool_config = config.get(tool_name, True)
    
    # If tool is disabled (bool False)
    if isinstance(tool_config, bool) and not tool_config:
        return []
    
    # If tool is enabled (bool True), return None to indicate all methods
    if tool_config is True:
        return None
    
    # Handle dict config with granular control
    if isinstance(tool_config, dict):
        if not tool_config.get('enabled', True):
            return []
        
        methods_config = tool_config.get('methods', {})
        
        # If no methods config, enable all
        if not methods_config:
            return None
        
        enabled_methods = []
        for method in tool_metadata['methods']:
            method_name = method['name']
            
            # Check if method has specific config
            if method_name in methods_config:
                method_config = methods_config[method_name]
                if isinstance(method_config, bool) and method_config:
                    enabled_methods.append(method_name)
                elif isinstance(method_config, dict) and method_config.get('enabled', True):
                    enabled_methods.append(method_name)
            else:
                # Default to enabled if not specified
                enabled_methods.append(method_name)
        
        return enabled_methods if enabled_methods else None
    
    # Default: return None to enable all methods
    return None


def validate_tool_config(config: Dict[str, Any]) -> Dict[str, Any]:
    """Validate and normalize tool configuration.
    
    Args:
        config: Tool configuration to validate
        
    Returns:
        Normalized configuration
    """
    normalized_config = {}
    
    for tool_name, tool_config in config.items():
        tool_metadata = get_tool_group(tool_name)
        if not tool_metadata:
            # Keep unknown tools as-is
            normalized_config[tool_name] = tool_config
            continue
        
        # Normalize bool config
        if isinstance(tool_config, bool):
            normalized_config[tool_name] = tool_config
        # Normalize dict config
        elif isinstance(tool_config, dict):
            validated_config = {
                'enabled': tool_config.get('enabled', True),
                'methods': {}
            }
            
            methods_config = tool_config.get('methods', {})
            for method in tool_metadata['methods']:
                method_name = method['name']
                if method_name in methods_config:
                    method_config = methods_config[method_name]
                    if isinstance(method_config, bool):
                        validated_config['methods'][method_name] = method_config
                    elif isinstance(method_config, dict):
                        validated_config['methods'][method_name] = {
                            'enabled': method_config.get('enabled', method.get('enabled', True))
                        }
                    else:
                        validated_config['methods'][method_name] = method.get('enabled', True)
                else:
                    validated_config['methods'][method_name] = method.get('enabled', True)
            
            normalized_config[tool_name] = validated_config
        else:
            # Default to enabled
            normalized_config[tool_name] = True
    
    return normalized_config
