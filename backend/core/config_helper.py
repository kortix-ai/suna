from typing import Dict, Any, Optional, List
from core.utils.logger import logger
import os


def extract_agent_config(agent_data: Dict[str, Any], version_data: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Extract agent configuration with simplified logic for Suna vs custom agents."""
    agent_id = agent_data.get('agent_id', 'Unknown')
    metadata = agent_data.get('metadata', {})
    is_suna_default = metadata.get('is_suna_default', False)
    
    # Debug logging
    if os.getenv("ENV_MODE", "").upper() == "STAGING":
        print(f"[DEBUG] extract_agent_config: Called for agent {agent_id}, is_suna_default={is_suna_default}")
        print(f"[DEBUG] extract_agent_config: Input agent_data has icon_name={agent_data.get('icon_name')}, icon_color={agent_data.get('icon_color')}, icon_background={agent_data.get('icon_background')}")
    
    # Handle Suna agents with special logic
    if is_suna_default:
        return _extract_suna_agent_config(agent_data, version_data)
    
    # Handle custom agents with versioning
    return _extract_custom_agent_config(agent_data, version_data)


def _extract_suna_agent_config(agent_data: Dict[str, Any], version_data: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Extract config for Suna agents - always use central config with user customizations."""
    from core.suna_config import SUNA_CONFIG
    
    agent_id = agent_data.get('agent_id', 'Unknown')
    logger.debug(f"Using Suna central config for agent {agent_id}")
    
    # Start with central Suna config
    config = {
        'agent_id': agent_data['agent_id'],
        'name': SUNA_CONFIG['name'],
        'description': SUNA_CONFIG['description'],
        'system_prompt': SUNA_CONFIG['system_prompt'],
        'model': SUNA_CONFIG['model'],
        'agentpress_tools': _extract_agentpress_tools_for_run(SUNA_CONFIG['agentpress_tools']),
        'is_default': True,
        'is_suna_default': True,
        'centrally_managed': True,
        'account_id': agent_data.get('account_id'),
        'current_version_id': agent_data.get('current_version_id'),
        'version_name': version_data.get('version_name', 'v1') if version_data else 'v1',
        'profile_image_url': agent_data.get('profile_image_url'),
        'restrictions': {
            'system_prompt_editable': False,
            'tools_editable': False,
            'name_editable': False,
            'description_editable': False,
            'mcps_editable': True
        }
    }
    
    if version_data:
        if version_data.get('config'):
            version_config = version_data['config']
            tools = version_config.get('tools', {})
            config['configured_mcps'] = tools.get('mcp', [])
            config['custom_mcps'] = tools.get('custom_mcp', [])
            config['workflows'] = version_config.get('workflows', [])
            config['triggers'] = version_config.get('triggers', [])
        else:
            config['configured_mcps'] = version_data.get('configured_mcps', [])
            config['custom_mcps'] = version_data.get('custom_mcps', [])
            config['workflows'] = []
            config['triggers'] = []
    else:
        config['configured_mcps'] = agent_data.get('configured_mcps', [])
        config['custom_mcps'] = agent_data.get('custom_mcps', [])
        config['workflows'] = []
        config['triggers'] = []
    
    return config


def _extract_custom_agent_config(agent_data: Dict[str, Any], version_data: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    agent_id = agent_data.get('agent_id', 'Unknown')
    
    # Debug logging for icon fields
    if os.getenv("ENV_MODE", "").upper() == "STAGING":
        print(f"[DEBUG] _extract_custom_agent_config: Input agent_data has icon_name={agent_data.get('icon_name')}, icon_color={agent_data.get('icon_color')}, icon_background={agent_data.get('icon_background')}")
    
    if version_data:
        logger.debug(f"Using version data for custom agent {agent_id} (version: {version_data.get('version_name', 'unknown')})")
        
        if version_data.get('config'):
            config = version_data['config'].copy()
            system_prompt = config.get('system_prompt', '')
            model = config.get('model')
            tools = config.get('tools', {})
            configured_mcps = tools.get('mcp', [])
            custom_mcps = tools.get('custom_mcp', [])
            agentpress_tools = tools.get('agentpress', {})
            workflows = config.get('workflows', [])
            triggers = config.get('triggers', [])
        else:
            system_prompt = version_data.get('system_prompt', '')
            model = version_data.get('model')
            configured_mcps = version_data.get('configured_mcps', [])
            custom_mcps = version_data.get('custom_mcps', [])
            agentpress_tools = version_data.get('agentpress_tools', {})
            workflows = []
            triggers = []
        
        config = {
            'agent_id': agent_data['agent_id'],
            'name': agent_data['name'],
            'description': agent_data.get('description'),
            'system_prompt': system_prompt,
            'model': model,
            'agentpress_tools': _extract_agentpress_tools_for_run(agentpress_tools),
            'configured_mcps': configured_mcps,
            'custom_mcps': custom_mcps,
            'workflows': workflows,
            'triggers': triggers,
            'profile_image_url': agent_data.get('profile_image_url'),
            'icon_name': agent_data.get('icon_name'),
            'icon_color': agent_data.get('icon_color'),
            'icon_background': agent_data.get('icon_background'),
            'is_default': agent_data.get('is_default', False),
            'is_suna_default': False,
            'centrally_managed': False,
            'account_id': agent_data.get('account_id'),
            'current_version_id': agent_data.get('current_version_id'),
            'version_name': version_data.get('version_name', 'v1'),
            'restrictions': {}
        }
        
        # Debug logging for returned config
        if os.getenv("ENV_MODE", "").upper() == "STAGING":
            print(f"[DEBUG] _extract_custom_agent_config: Returning config with icon_name={config.get('icon_name')}, icon_color={config.get('icon_color')}, icon_background={config.get('icon_background')}")
        
        return config
    
    logger.warning(f"No version data found for custom agent {agent_id}, creating default configuration")
    logger.debug(f"Agent data keys: {list(agent_data.keys())}")
    logger.debug(f"Agent current_version_id: {agent_data.get('current_version_id')}")
    
    fallback_config = {
        'agent_id': agent_data['agent_id'],
        'name': agent_data.get('name', 'Unnamed Agent'),
        'description': agent_data.get('description', ''),
        'system_prompt': 'You are a helpful AI assistant.',
        'model': None,
        'agentpress_tools': _extract_agentpress_tools_for_run(_get_default_agentpress_tools()),
        'configured_mcps': [],
        'custom_mcps': [],
        'workflows': [],
        'triggers': [],
        'profile_image_url': agent_data.get('profile_image_url'),
        'icon_name': agent_data.get('icon_name'),
        'icon_color': agent_data.get('icon_color'),
        'icon_background': agent_data.get('icon_background'),
        'is_default': agent_data.get('is_default', False),
        'is_suna_default': False,
        'centrally_managed': False,
        'account_id': agent_data.get('account_id'),
        'current_version_id': agent_data.get('current_version_id'),
        'version_name': 'v1',
        'restrictions': {}
    }
    
    # Debug logging for fallback config
    if os.getenv("ENV_MODE", "").upper() == "STAGING":
        print(f"[DEBUG] _extract_custom_agent_config: Fallback config with icon_name={fallback_config.get('icon_name')}, icon_color={fallback_config.get('icon_color')}, icon_background={fallback_config.get('icon_background')}")
    
    return fallback_config


def build_unified_config(
    system_prompt: str,
    agentpress_tools: Dict[str, Any],
    configured_mcps: List[Dict[str, Any]],
    custom_mcps: Optional[List[Dict[str, Any]]] = None,
    suna_metadata: Optional[Dict[str, Any]] = None,
    workflows: Optional[List[Dict[str, Any]]] = None,
    triggers: Optional[List[Dict[str, Any]]] = None
) -> Dict[str, Any]:
    simplified_tools = {}
    for tool_name, tool_config in agentpress_tools.items():
        if isinstance(tool_config, dict):
            simplified_tools[tool_name] = tool_config.get('enabled', False)
        elif isinstance(tool_config, bool):
            simplified_tools[tool_name] = tool_config
    
    config = {
        'system_prompt': system_prompt,
        'tools': {
            'agentpress': simplified_tools,
            'mcp': configured_mcps or [],
            'custom_mcp': custom_mcps or []
        },
        'workflows': workflows or [],
        'triggers': triggers or [],
        'metadata': {}
    }
    
    if suna_metadata:
        config['suna_metadata'] = suna_metadata
    
    return config


def _get_default_agentpress_tools() -> Dict[str, bool]:
    return {
        "sb_shell_tool": True,
        "sb_files_tool": True,
        "sb_deploy_tool": True,
        "sb_expose_tool": True,
        "web_search_tool": True,
        "sb_vision_tool": True,
        "sb_image_edit_tool": True,
        "sb_presentation_outline_tool": True,
        "sb_presentation_tool": True,

        "sb_sheets_tool": False,
        # "sb_web_dev_tool": True,
        "browser_tool": True,
        "data_providers_tool": True,
        "agent_config_tool": True,
        "mcp_search_tool": True,
        "credential_profile_tool": True,
        "agent_creation_tool": True,
        "workflow_tool": True,
        "trigger_tool": True
    }


def _extract_agentpress_tools_for_run(agentpress_config: Dict[str, Any]) -> Dict[str, Any]:
    if not agentpress_config:
        return {}
    
    run_tools = {}
    for tool_name, enabled in agentpress_config.items():
        if isinstance(enabled, bool):
            run_tools[tool_name] = {
                'enabled': enabled,
                'description': f"{tool_name} tool"
            }
        elif isinstance(enabled, dict):
            run_tools[tool_name] = enabled
        else:
            run_tools[tool_name] = {
                'enabled': bool(enabled),
                'description': f"{tool_name} tool"
            }
    
    return run_tools


