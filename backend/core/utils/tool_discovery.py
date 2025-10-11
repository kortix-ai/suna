"""
Auto-discovery system for tools.

Uses Python's class inheritance to discover all Tool subclasses and extract their metadata.
Tools are discovered via Tool.__subclasses__() rather than filesystem scanning.
"""

import importlib
import inspect
from typing import Dict, List, Any, Optional, Type
from pathlib import Path

from core.agentpress.tool import Tool, ToolMetadata, MethodMetadata
from core.utils.logger import logger


def _ensure_tools_imported():
    """Ensure all tool modules are imported so classes are registered.
    
    Recursively scans the tools directory and all subdirectories to find and import
    all Python modules. This triggers Tool class definitions so they can be found
    via Tool.__subclasses__().
    """
    tools_dir = Path(__file__).parent.parent / "tools"
    
    # Recursively find all Python files in tools directory and subdirectories
    for tool_file in tools_dir.rglob("*.py"):
        # Skip __init__, __pycache__, and test files
        if tool_file.name.startswith("__") or tool_file.name.startswith("test_") or "__pycache__" in str(tool_file):
            continue
        
        # Build module name from file path relative to tools dir
        # Example: tools/agent_builder_tools/mcp_search_tool.py -> core.tools.agent_builder_tools.mcp_search_tool
        relative_path = tool_file.relative_to(tools_dir.parent)
        module_parts = relative_path.with_suffix('').parts
        module_name = f"core.{'.'.join(module_parts)}"
        
        try:
            importlib.import_module(module_name)
            # logger.debug(f"Imported tool module: {module_name}")
        except Exception as e:
            # logger.debug(f"Could not import {module_name}: {e}")
            pass


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


def _generate_tool_name(class_name: str) -> str:
    """Generate a tool name from class name.
    
    Converts CamelCase class names to snake_case tool names.
    Example: SandboxFilesTool -> sb_files_tool
    
    Args:
        class_name: Name of the tool class
        
    Returns:
        snake_case tool name
    """
    # Remove Tool suffix
    if class_name.endswith('Tool'):
        class_name = class_name[:-4]
    
    # Convert CamelCase to snake_case
    import re
    s1 = re.sub('(.)([A-Z][a-z]+)', r'\1_\2', class_name)
    result = re.sub('([a-z0-9])([A-Z])', r'\1_\2', s1).lower()
    
    # Add _tool suffix
    if not result.endswith('_tool'):
        result += '_tool'
    
    return result


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


def discover_tools() -> Dict[str, Type[Tool]]:
    """Discover all available Tool subclasses.
    
    Returns:
        Dict mapping tool names to tool classes
    """
    # Ensure all tool modules are loaded
    _ensure_tools_imported()
    
    # Get all Tool subclasses
    tool_classes = _get_all_tool_subclasses()
    
    tools_map = {}
    for tool_class in tool_classes:
        tool_name = _generate_tool_name(tool_class.__name__)
        tools_map[tool_name] = tool_class
        # logger.debug(f"Discovered tool: {tool_name} ({tool_class.__name__})")
    
    # logger.info(f"Discovered {len(tools_map)} tools")
    return tools_map


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
