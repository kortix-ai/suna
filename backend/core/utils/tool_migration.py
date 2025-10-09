from typing import Dict, Any, Optional
from core.utils.tool_discovery import get_tool_group, get_tools_metadata, get_enabled_methods_for_tool
from core.utils.logger import logger

def migrate_legacy_tool_config(legacy_config: Dict[str, Any]) -> Dict[str, Any]:
    migrated_config = {}
    
    for tool_name, tool_value in legacy_config.items():
        tool_metadata = get_tool_group(tool_name)
        
        if not tool_metadata:
            migrated_config[tool_name] = tool_value
            continue
        
        methods = tool_metadata.get('methods', [])
        
        if isinstance(tool_value, bool):
            if len(methods) > 1:
                migrated_config[tool_name] = {
                    'enabled': tool_value,
                    'methods': {
                        method['name']: tool_value for method in methods
                    }
                }
            else:
                migrated_config[tool_name] = tool_value
                
        elif isinstance(tool_value, dict) and 'enabled' in tool_value:
            enabled = tool_value.get('enabled', True)
            
            if len(methods) > 1:
                methods_config = tool_value.get('methods', {})
                
                complete_methods = {}
                for method in methods:
                    method_name = method['name']
                    if method_name in methods_config:
                        complete_methods[method_name] = methods_config[method_name]
                    else:
                        complete_methods[method_name] = enabled and method.get('enabled', True)
                
                migrated_config[tool_name] = {
                    'enabled': enabled,
                    'methods': complete_methods
                }
            else:
                migrated_config[tool_name] = enabled
        else:
            logger.warning(f"Invalid tool config format for {tool_name}: {tool_value}, defaulting to enabled")
            migrated_config[tool_name] = True
    
    return migrated_config

def ensure_all_tools_present(config: Dict[str, Any]) -> Dict[str, Any]:
    complete_config = dict(config)
    
    all_tools = get_tools_metadata()
    for tool_name, tool_metadata in all_tools.items():
        if tool_name not in complete_config:
            methods = tool_metadata.get('methods', [])
            if len(methods) > 1:
                complete_config[tool_name] = {
                    'enabled': tool_metadata.get('enabled', True),
                    'methods': {
                        method['name']: method.get('enabled', True) for method in methods
                    }
                }
            else:
                complete_config[tool_name] = tool_metadata.get('enabled', True)
    
    return complete_config

def convert_to_legacy_format(granular_config: Dict[str, Any]) -> Dict[str, Any]:
    legacy_config = {}
    
    for tool_name, tool_config in granular_config.items():
        if isinstance(tool_config, bool):
            legacy_config[tool_name] = tool_config
        elif isinstance(tool_config, dict) and 'enabled' in tool_config:
            legacy_config[tool_name] = tool_config['enabled']
        else:
            legacy_config[tool_name] = True
    
    return legacy_config

def get_disabled_methods_for_tool(tool_name: str, config: Dict[str, Any]) -> list[str]:
    tool_metadata = get_tool_group(tool_name)
    if not tool_metadata:
        return []
    
    methods = tool_metadata.get('methods', [])
    tool_config = config.get(tool_name)
    
    if isinstance(tool_config, bool) and not tool_config:
        return [method['name'] for method in methods]
    
    if tool_config is True or tool_config is None:
        return []
    
    if isinstance(tool_config, dict):
        if not tool_config.get('enabled', True):
            return [method['name'] for method in methods]
        
        methods_config = tool_config.get('methods', {})
        disabled_methods = []
        
        for method in methods:
            method_name = method['name']
            method_enabled = method.get('enabled', True)
            
            if method_name in methods_config:
                method_config = methods_config[method_name]
                if isinstance(method_config, bool):
                    method_enabled = method_config
                elif isinstance(method_config, dict):
                    method_enabled = method_config.get('enabled', method.get('enabled', True))
            
            if not method_enabled:
                disabled_methods.append(method_name)
        
        return disabled_methods
    
    return []

def is_tool_effectively_enabled(tool_name: str, config: Dict[str, Any]) -> bool:
    enabled_methods = get_enabled_methods_for_tool(tool_name, config)
    return len(enabled_methods) > 0

def get_tool_configuration_summary(config: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    summary = {}
    
    all_tools = get_tools_metadata()
    for tool_name, tool_metadata in all_tools.items():
        methods = tool_metadata.get('methods', [])
        tool_config = config.get(tool_name, True)
        enabled_methods = []
        disabled_methods = []
        
        if isinstance(tool_config, bool):
            if tool_config:
                enabled_methods = [m['name'] for m in methods if m.get('enabled', True)]
            else:
                disabled_methods = [m['name'] for m in methods]
        elif isinstance(tool_config, dict):
            group_enabled = tool_config.get('enabled', True)
            methods_config = tool_config.get('methods', {})
            
            for method in methods:
                method_name = method['name']
                method_enabled = method.get('enabled', True)
                
                if group_enabled and method_name in methods_config:
                    method_config = methods_config[method_name]
                    if isinstance(method_config, bool):
                        method_enabled = method_config
                    elif isinstance(method_config, dict):
                        method_enabled = method_config.get('enabled', method.get('enabled', True))
                elif not group_enabled:
                    method_enabled = False
                
                if method_enabled:
                    enabled_methods.append(method_name)
                else:
                    disabled_methods.append(method_name)
        
        summary[tool_name] = {
            'total_methods': len(methods),
            'enabled_methods': len(enabled_methods),
            'disabled_methods': len(disabled_methods),
            'enabled_method_names': enabled_methods,
            'disabled_method_names': disabled_methods,
            'is_core': tool_metadata.get('is_core', False),
            'effectively_enabled': len(enabled_methods) > 0
        }
    
    return summary
