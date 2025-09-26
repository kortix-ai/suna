from typing import Dict, Any, Optional
from core.utils.tool_groups import TOOL_GROUPS, get_tool_group
from core.utils.logger import logger

def migrate_legacy_tool_config(legacy_config: Dict[str, Any]) -> Dict[str, Any]:
    migrated_config = {}
    
    for tool_name, tool_value in legacy_config.items():
        tool_group = get_tool_group(tool_name)
        
        if not tool_group:
            migrated_config[tool_name] = tool_value
            continue
        
        if isinstance(tool_value, bool):
            if len(tool_group.methods) > 1:
                migrated_config[tool_name] = {
                    'enabled': tool_value,
                    'methods': {
                        method.name: tool_value for method in tool_group.methods
                    }
                }
            else:
                migrated_config[tool_name] = tool_value
                
        elif isinstance(tool_value, dict) and 'enabled' in tool_value:
            enabled = tool_value.get('enabled', True)
            
            if len(tool_group.methods) > 1:
                methods_config = tool_value.get('methods', {})
                
                complete_methods = {}
                for method in tool_group.methods:
                    if method.name in methods_config:
                        complete_methods[method.name] = methods_config[method.name]
                    else:
                        complete_methods[method.name] = enabled and method.enabled
                
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
    
    for tool_name, tool_group in TOOL_GROUPS.items():
        if tool_name not in complete_config:
            if len(tool_group.methods) > 1:
                complete_config[tool_name] = {
                    'enabled': tool_group.enabled,
                    'methods': {
                        method.name: method.enabled for method in tool_group.methods
                    }
                }
            else:
                complete_config[tool_name] = tool_group.enabled
    
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
    tool_group = get_tool_group(tool_name)
    if not tool_group:
        return []
    
    tool_config = config.get(tool_name)
    
    if isinstance(tool_config, bool) and not tool_config:
        return [method.name for method in tool_group.methods]
    
    if tool_config is True or tool_config is None:
        return []
    
    if isinstance(tool_config, dict):
        if not tool_config.get('enabled', True):
            return [method.name for method in tool_group.methods]
        
        methods_config = tool_config.get('methods', {})
        disabled_methods = []
        
        for method in tool_group.methods:
            method_enabled = method.enabled
            
            if method.name in methods_config:
                method_config = methods_config[method.name]
                if isinstance(method_config, bool):
                    method_enabled = method_config
                elif isinstance(method_config, dict):
                    method_enabled = method_config.get('enabled', method.enabled)
            
            if not method_enabled:
                disabled_methods.append(method.name)
        
        return disabled_methods
    
    return []

def is_tool_effectively_enabled(tool_name: str, config: Dict[str, Any]) -> bool:
    from core.utils.tool_groups import get_enabled_methods_for_tool
    
    enabled_methods = get_enabled_methods_for_tool(tool_name, config)
    return len(enabled_methods) > 0

def get_tool_configuration_summary(config: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    summary = {}
    
    for tool_name in TOOL_GROUPS.keys():
        tool_group = get_tool_group(tool_name)
        if not tool_group:
            continue
        
        tool_config = config.get(tool_name, True)
        enabled_methods = []
        disabled_methods = []
        
        if isinstance(tool_config, bool):
            if tool_config:
                enabled_methods = [m.name for m in tool_group.methods if m.enabled]
            else:
                disabled_methods = [m.name for m in tool_group.methods]
        elif isinstance(tool_config, dict):
            group_enabled = tool_config.get('enabled', True)
            methods_config = tool_config.get('methods', {})
            
            for method in tool_group.methods:
                method_enabled = method.enabled
                
                if group_enabled and method.name in methods_config:
                    method_config = methods_config[method.name]
                    if isinstance(method_config, bool):
                        method_enabled = method_config
                    elif isinstance(method_config, dict):
                        method_enabled = method_config.get('enabled', method.enabled)
                elif not group_enabled:
                    method_enabled = False
                
                if method_enabled:
                    enabled_methods.append(method.name)
                else:
                    disabled_methods.append(method.name)
        
        summary[tool_name] = {
            'total_methods': len(tool_group.methods),
            'enabled_methods': len(enabled_methods),
            'disabled_methods': len(disabled_methods),
            'enabled_method_names': enabled_methods,
            'disabled_method_names': disabled_methods,
            'is_core': tool_group.is_core,
            'effectively_enabled': len(enabled_methods) > 0
        }
    
    return summary
