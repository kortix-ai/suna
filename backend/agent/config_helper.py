from typing import Dict, Any, Optional, List
from utils.logger import logger
from services.supabase import DBConnection
import os


async def get_agent_llamacloud_knowledge_bases(agent_id: str) -> List[Dict[str, Any]]:
    """Fetch LlamaCloud knowledge bases for an agent"""
    try:
        db = DBConnection()
        client = await db.client
        
        result = await client.rpc('get_agent_llamacloud_knowledge_bases', {
            'p_agent_id': agent_id,
            'p_include_inactive': False
        }).execute()
        
        if not result.data:
            return []
        
        # Transform database results to the format expected by KnowledgeSearchTool
        knowledge_bases = []
        for kb_data in result.data:
            kb = {
                'name': kb_data['name'],
                'index_name': kb_data['index_name'],
                'description': kb_data.get('description', '')
            }
            knowledge_bases.append(kb)
        
        logger.info(f"Loaded {len(knowledge_bases)} LlamaCloud knowledge bases for agent {agent_id}")
        return knowledge_bases
        
    except Exception as e:
        logger.error(f"Failed to load LlamaCloud knowledge bases for agent {agent_id}: {e}")
        return []


async def enrich_agent_config_with_llamacloud_kb(config: Dict[str, Any]) -> Dict[str, Any]:
    """Enrich agent config with LlamaCloud knowledge bases"""
    if not config.get('agent_id'):
        return config
    
    try:
        llamacloud_knowledge_bases = await get_agent_llamacloud_knowledge_bases(config['agent_id'])
        if llamacloud_knowledge_bases:
            config['llamacloud_knowledge_bases'] = llamacloud_knowledge_bases
            logger.info(f"Enriched agent {config['agent_id']} config with {len(llamacloud_knowledge_bases)} LlamaCloud knowledge bases")
    except Exception as e:
        logger.error(f"Failed to enrich agent config with LlamaCloud knowledge bases: {e}")
    
    return config


def extract_agent_config(agent_data: Dict[str, Any], version_data: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Extract agent configuration with simplified logic for Suna/Omni vs custom agents."""
    agent_id = agent_data.get('agent_id', 'Unknown')
    metadata = agent_data.get('metadata', {})
    is_suna_default = metadata.get('is_suna_default', False)
    is_omni_default = metadata.get('is_omni_default', False)
    
    # Debug logging
    if os.getenv("ENV_MODE", "").upper() == "STAGING":
        print(f"[DEBUG] extract_agent_config: Called for agent {agent_id}, is_suna_default={is_suna_default}, is_omni_default={is_omni_default}")
        print(f"[DEBUG] extract_agent_config: Input agent_data has icon_name={agent_data.get('icon_name')}, icon_color={agent_data.get('icon_color')}, icon_background={agent_data.get('icon_background')}")
    
    # Handle Suna agents with special logic
    if is_suna_default:
        return _extract_suna_agent_config(agent_data, version_data)
    
    # Handle Omni agents with special logic  
    if is_omni_default:
        return _extract_omni_agent_config(agent_data, version_data)
    
    # Handle custom agents with versioning
    return _extract_custom_agent_config(agent_data, version_data)


def _extract_suna_agent_config(agent_data: Dict[str, Any], version_data: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Extract config for Suna agents - always use central config with user customizations."""
    from agent.suna_config import SUNA_CONFIG
    
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
        'avatar': SUNA_CONFIG['avatar'],
        'avatar_color': SUNA_CONFIG['avatar_color'],
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


def _extract_omni_agent_config(agent_data: Dict[str, Any], version_data: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Extract config for Omni agents - always use central config with user customizations."""
    from agent.omni_config import OMNI_CONFIG
    
    agent_id = agent_data.get('agent_id', 'Unknown')
    logger.debug(f"Using Omni central config for agent {agent_id}")
    
    # Start with central Omni config
    config = {
        'agent_id': agent_data['agent_id'],
        'name': OMNI_CONFIG['name'],
        'description': OMNI_CONFIG['description'],
        'system_prompt': OMNI_CONFIG['system_prompt'],
        'model': OMNI_CONFIG['model'],
        'agentpress_tools': _extract_agentpress_tools_for_run(OMNI_CONFIG['agentpress_tools']),
        'avatar': OMNI_CONFIG['avatar'],
        'avatar_color': OMNI_CONFIG['avatar_color'],
        'is_default': True,
        'is_omni_default': True,
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
            'avatar': agent_data.get('avatar'),
            'avatar_color': agent_data.get('avatar_color'),
            'profile_image_url': agent_data.get('profile_image_url'),
            'icon_name': agent_data.get('icon_name'),
            'icon_color': agent_data.get('icon_color'),
            'icon_background': agent_data.get('icon_background'),
            'is_default': agent_data.get('is_default', False),
            'is_suna_default': False,
            'is_omni_default': False,
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
        'avatar': agent_data.get('avatar'),
        'avatar_color': agent_data.get('avatar_color'),
        'profile_image_url': agent_data.get('profile_image_url'),
        'icon_name': agent_data.get('icon_name'),
        'icon_color': agent_data.get('icon_color'),
        'icon_background': agent_data.get('icon_background'),
        'is_default': agent_data.get('is_default', False),
        'is_suna_default': False,
        'is_omni_default': False,
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
    avatar: Optional[str] = None,
    avatar_color: Optional[str] = None,
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
        'metadata': {
            'avatar': avatar,
            'avatar_color': avatar_color
        }
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


def extract_tools_for_agent_run(config: Dict[str, Any]) -> Dict[str, Any]:
    logger.warning("extract_tools_for_agent_run is deprecated, using config-based extraction")
    tools = config.get('tools', {})
    return _extract_agentpress_tools_for_run(tools.get('agentpress', {}))


def get_mcp_configs(config: Dict[str, Any]) -> List[Dict[str, Any]]:
    tools = config.get('tools', {})
    all_mcps = []
    
    if 'configured_mcps' in config and config['configured_mcps']:
        for mcp in config['configured_mcps']:
            if mcp not in all_mcps:
                all_mcps.append(mcp)
    
    if 'custom_mcps' in config and config['custom_mcps']:
        for mcp in config['custom_mcps']:
            if mcp not in all_mcps:
                all_mcps.append(mcp)
    
    mcp_list = tools.get('mcp', [])
    if mcp_list:
        for mcp in mcp_list:
            if mcp not in all_mcps:
                all_mcps.append(mcp)
    
    custom_mcp_list = tools.get('custom_mcp', [])
    if custom_mcp_list:
        for mcp in custom_mcp_list:
            if mcp not in all_mcps:
                all_mcps.append(mcp)
    
    return all_mcps


def is_suna_default_agent(config: Dict[str, Any]) -> bool:
    """Check if agent is a default agent (Suna or Omni) - backward compatibility."""
    return config.get('is_suna_default', False) or config.get('is_omni_default', False)


def get_agent_restrictions(config: Dict[str, Any]) -> Dict[str, bool]:
    return config.get('restrictions', {})


def can_edit_field(config: Dict[str, Any], field_name: str) -> bool:
    if not is_suna_default_agent(config):
        return True
    
    restrictions = get_agent_restrictions(config)
    return restrictions.get(field_name, True)


def get_default_system_prompt_for_suna_agent() -> str:
    from agent.suna_config import SUNA_CONFIG
    return SUNA_CONFIG['system_prompt']


def get_default_system_prompt_for_omni_agent() -> str:
    from agent.omni_config import OMNI_CONFIG
    return OMNI_CONFIG['system_prompt']


async def get_agent_llamacloud_knowledge_bases(agent_id: str) -> List[Dict[str, Any]]:
    """Fetch LlamaCloud knowledge bases for an agent"""
    try:
        db = DBConnection()
        client = await db.client
        
        result = await client.rpc('get_agent_llamacloud_knowledge_bases', {
            'p_agent_id': agent_id,
            'p_include_inactive': False
        }).execute()
        
        if not result.data:
            return []
        
        # Transform database results to the format expected by KnowledgeSearchTool
        knowledge_bases = []
        for kb_data in result.data:
            kb = {
                'name': kb_data['name'],
                'index_name': kb_data['index_name'],
                'description': kb_data.get('description', '')
            }
            knowledge_bases.append(kb)
        
        logger.info(f"Loaded {len(knowledge_bases)} LlamaCloud knowledge bases for agent {agent_id}")
        return knowledge_bases
        
    except Exception as e:
        logger.error(f"Failed to load LlamaCloud knowledge bases for agent {agent_id}: {e}")
        return []


async def enrich_agent_config_with_llamacloud_kb(config: Dict[str, Any]) -> Dict[str, Any]:
    """Enrich agent config with LlamaCloud knowledge bases"""
    if not config.get('agent_id'):
        return config
    
    try:
        llamacloud_knowledge_bases = await get_agent_llamacloud_knowledge_bases(config['agent_id'])
        if llamacloud_knowledge_bases:
            config['llamacloud_knowledge_bases'] = llamacloud_knowledge_bases
            logger.info(f"Enriched agent {config['agent_id']} config with {len(llamacloud_knowledge_bases)} LlamaCloud knowledge bases")
    except Exception as e:
        logger.error(f"Failed to enrich agent config with LlamaCloud knowledge bases: {e}")
    
    return config
