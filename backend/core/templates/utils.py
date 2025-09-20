from typing import List, Dict, Any, Optional

from .template_service import AgentTemplate, MCPRequirementValue, ConfigType, ProfileId, QualifiedName
from .installation_service import TemplateInstallationError



def validate_installation_requirements(
    requirements: List[MCPRequirementValue],
    profile_mappings: Optional[Dict[QualifiedName, ProfileId]],
    custom_configs: Optional[Dict[QualifiedName, ConfigType]]
) -> tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    missing_profiles = []
    missing_configs = []
    
    profile_mappings = profile_mappings or {}
    custom_configs = custom_configs or {}
    
    for req in requirements:
        if req.is_custom():
            if req.qualified_name not in custom_configs:
                missing_configs.append({
                    'qualified_name': req.qualified_name,
                    'display_name': req.display_name,
                    'custom_type': req.custom_type,
                    'required_config': req.required_config
                })
        else:
            if req.qualified_name not in profile_mappings:
                missing_profiles.append({
                    'qualified_name': req.qualified_name,
                    'display_name': req.display_name,
                    'required_config': req.required_config
                })
    
    return missing_profiles, missing_configs


def build_unified_config(
    system_prompt: str,
    agentpress_tools: ConfigType,
    configured_mcps: List[ConfigType],
    custom_mcps: List[ConfigType]
) -> ConfigType:
    try:
        from core.config_helper import build_unified_config as build_config
        return build_config(
            system_prompt=system_prompt,
            agentpress_tools=agentpress_tools,
            configured_mcps=configured_mcps,
            custom_mcps=custom_mcps
        )
    except ImportError:
        return {
            'system_prompt': system_prompt,
            'tools': {
                'agentpress': agentpress_tools,
                'mcp': configured_mcps,
                'custom_mcp': custom_mcps
            },
            'metadata': {}
        }


def build_mcp_config(
    requirement: MCPRequirementValue,
    profile: Any
) -> ConfigType:
    if requirement.is_custom():
        return {
            'name': requirement.display_name,
            'type': requirement.custom_type,
            'customType': requirement.custom_type,
            'config': profile.config if hasattr(profile, 'config') else profile,
            'enabledTools': requirement.enabled_tools
        }
    else:
        return {
            'name': requirement.display_name,
            'qualifiedName': profile.mcp_qualified_name if hasattr(profile, 'mcp_qualified_name') else requirement.qualified_name,
            'config': profile.config if hasattr(profile, 'config') else profile,
            'enabledTools': requirement.enabled_tools,
            'selectedProfileId': profile.profile_id if hasattr(profile, 'profile_id') else None
        }


def create_mcp_requirement_from_dict(data: Dict[str, Any]) -> MCPRequirementValue:
    return MCPRequirementValue(
        qualified_name=data['qualified_name'],
        display_name=data['display_name'],
        enabled_tools=data.get('enabled_tools', []),
        required_config=data.get('required_config', []),
        custom_type=data.get('custom_type'),
        toolkit_slug=data.get('toolkit_slug'),
        app_slug=data.get('app_slug')
    )


def extract_custom_type_from_name(name: str) -> Optional[str]:
    if name.startswith('custom_'):
        parts = name.split('_')
        if len(parts) >= 2:
            return parts[1]
    return None


def is_suna_default_agent(agent_data: Dict[str, Any]) -> bool:
    metadata = agent_data.get('metadata', {})
    return metadata.get('is_suna_default', False)


def format_template_for_response(template: AgentTemplate) -> Dict[str, Any]:
    response = {
        'template_id': template.template_id,
        'creator_id': template.creator_id,
        'name': template.name,
        'description': template.description,
        'system_prompt': template.system_prompt,
        'model': template.config.get('model'),
        'mcp_requirements': format_mcp_requirements_for_response(template.mcp_requirements),
        'agentpress_tools': template.agentpress_tools,
        'tags': template.tags,
        'is_public': template.is_public,
        'is_kortix_team': template.is_kortix_team,
        'marketplace_published_at': template.marketplace_published_at.isoformat() if template.marketplace_published_at else None,
        'download_count': template.download_count,
        'created_at': template.created_at.isoformat(),
        'updated_at': template.updated_at.isoformat(),
        'profile_image_url': template.profile_image_url,
        'icon_name': template.icon_name,
        'icon_color': template.icon_color,
        'icon_background': template.icon_background,
        'metadata': template.metadata,
        'creator_name': template.creator_name
    }
    return response


def format_mcp_requirements_for_response(requirements: List[MCPRequirementValue]) -> List[Dict[str, Any]]:
    formatted = []
    for req in requirements:
        formatted.append({
            'qualified_name': req.qualified_name,
            'display_name': req.display_name,
            'enabled_tools': req.enabled_tools,
            'required_config': req.required_config,
            'custom_type': req.custom_type,
            'toolkit_slug': req.toolkit_slug,
            'app_slug': req.app_slug,
            'source': req.source,
            'trigger_index': req.trigger_index
        })
    return formatted


def filter_templates_by_tags(templates: List[AgentTemplate], tags: List[str]) -> List[AgentTemplate]:
    if not tags:
        return templates
    
    tag_set = set(tags)
    return [t for t in templates if tag_set.intersection(set(t.tags or []))]


def search_templates_by_name(templates: List[AgentTemplate], query: str) -> List[AgentTemplate]:
    if not query:
        return templates
    
    query = query.lower()
    filtered = []
    
    for template in templates:
        if (query in template.name.lower() or 
            (template.description and query in template.description.lower())):
            filtered.append(template)
    
    return filtered 


def sanitize_config_for_security(config: Dict[str, Any]) -> Dict[str, Any]:
    original_agentpress_tools = config.get('tools', {}).get('agentpress', {})
    sanitized_agentpress_tools = {}
    
    for tool_name, tool_config in original_agentpress_tools.items():
        if isinstance(tool_config, bool):
            sanitized_agentpress_tools[tool_name] = tool_config
        elif isinstance(tool_config, dict) and 'enabled' in tool_config:
            sanitized_agentpress_tools[tool_name] = tool_config['enabled']
        else:
            sanitized_agentpress_tools[tool_name] = False

    sanitized = {
        'system_prompt': config.get('system_prompt', ''),
        'tools': {
            'agentpress': sanitized_agentpress_tools,
            'mcp': config.get('tools', {}).get('mcp', []),
            'custom_mcp': []
        },
        'metadata': {}
    }
    
    custom_mcps = config.get('tools', {}).get('custom_mcp', [])
    for mcp in custom_mcps:
        if isinstance(mcp, dict):
            sanitized_mcp = {
                'name': mcp.get('name'),
                'type': mcp.get('type'),
                'display_name': mcp.get('display_name') or mcp.get('name'),
                'enabledTools': mcp.get('enabledTools', [])
            }
            
            if mcp.get('type') == 'pipedream':
                original_config = mcp.get('config', {})
                sanitized_mcp['config'] = {
                    'url': original_config.get('url'),
                    'headers': {k: v for k, v in original_config.get('headers', {}).items() 
                              if k != 'profile_id'}
                }
            else:
                sanitized_mcp['config'] = {}
            
            sanitized['tools']['custom_mcp'].append(sanitized_mcp)
    
    return sanitized 