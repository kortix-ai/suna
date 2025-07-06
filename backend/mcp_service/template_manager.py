"""
Agent Template Manager

This module handles:
1. Creating agent templates from existing agents (stripping credentials)
2. Installing templates as agent instances
3. Managing template lifecycle and marketplace operations
4. Converting between legacy agents and new secure architecture
"""

import json
from typing import Dict, List, Any, Optional
from dataclasses import dataclass
from datetime import datetime, timezone

from utils.logger import logger
from services.supabase import DBConnection

from .credential_manager import credential_manager, MCPRequirement, MCPCredential

db = DBConnection()


@dataclass
class AgentTemplate:
    """Represents an agent template"""
    template_id: str
    creator_id: str
    name: str
    description: Optional[str]
    system_prompt: str
    mcp_requirements: List[MCPRequirement]
    agentpress_tools: Dict[str, Any]
    tags: List[str]
    is_public: bool
    marketplace_published_at: Optional[datetime]
    download_count: int
    created_at: datetime
    updated_at: datetime
    avatar: Optional[str]
    avatar_color: Optional[str]
    metadata: Optional[Dict[str, Any]] = None


@dataclass
class AgentInstance:
    """Represents an agent instance"""
    instance_id: str
    template_id: Optional[str]
    account_id: str
    name: str
    description: Optional[str]
    credential_mappings: Dict[str, str]
    custom_system_prompt: Optional[str]
    is_active: bool
    is_default: bool
    created_at: datetime
    updated_at: datetime
    avatar: Optional[str]
    avatar_color: Optional[str]


class TemplateManager:
    """Manages agent templates and instances"""
    
    async def create_template_from_agent(
        self, 
        agent_id: str, 
        creator_id: str,
        make_public: bool = False,
        tags: Optional[List[str]] = None
    ) -> str:
        """
        Create a secure template from an existing agent
        
        This extracts the agent configuration and creates a template with
        MCP requirements (without credentials) that can be safely shared
        """
        logger.info(f"Creating template from agent {agent_id} for user {creator_id}")
        
        try:
            client = await db.client
            
            # Get the agent
            agent_result = await client.table('agents').select('*').eq('agent_id', agent_id).execute()
            if not agent_result.data:
                raise ValueError("Agent not found")
            
            agent = agent_result.data[0]
            
            # Verify ownership
            if agent['account_id'] != creator_id:
                raise ValueError("Access denied - you can only create templates from your own agents")
            
            # Extract MCP requirements from agent configuration
            mcp_requirements = []
            
            # Process configured_mcps (regular MCP servers)
            for mcp in agent.get('configured_mcps', []):
                if isinstance(mcp, dict) and 'qualifiedName' in mcp:
                    # Extract required config keys from the config
                    config_keys = list(mcp.get('config', {}).keys())
                    
                    requirement = {
                        'qualified_name': mcp['qualifiedName'],
                        'display_name': mcp.get('name', mcp['qualifiedName']),
                        'enabled_tools': mcp.get('enabledTools', []),
                        'required_config': config_keys
                    }
                    mcp_requirements.append(requirement)
            
            # Process custom_mcps (custom MCP servers)
            for custom_mcp in agent.get('custom_mcps', []):
                if isinstance(custom_mcp, dict) and 'name' in custom_mcp:
                    # Extract required config keys from the config
                    config_keys = list(custom_mcp.get('config', {}).keys())
                    
                    requirement = {
                        'qualified_name': custom_mcp['name'].lower().replace(' ', '_'),
                        'display_name': custom_mcp['name'],
                        'enabled_tools': custom_mcp.get('enabledTools', []),
                        'required_config': config_keys,
                        'custom_type': custom_mcp.get('type', 'http')  # Default to http
                    }
                    mcp_requirements.append(requirement)
            
            kortix_team_account_ids = [
                'xxxxxxxx',
            ]
            
            is_kortix_team = creator_id in kortix_team_account_ids
            
            # Create the template
            template_data = {
                'creator_id': creator_id,
                'name': agent['name'],
                'description': agent.get('description'),
                'system_prompt': agent['system_prompt'],
                'mcp_requirements': mcp_requirements,
                'agentpress_tools': agent.get('agentpress_tools', {}),
                'tags': tags or [],
                'is_public': make_public,
                'is_kortix_team': is_kortix_team,
                'avatar': agent.get('avatar'),
                'avatar_color': agent.get('avatar_color'),
                'metadata': {
                    'source_agent_id': agent_id,
                    'source_version_id': agent.get('current_version_id'),
                    'source_version_name': agent.get('current_version', {}).get('version_name', 'v1.0')
                }
            }
            
            if make_public:
                template_data['marketplace_published_at'] = datetime.now(timezone.utc).isoformat()
            
            result = await client.table('agent_templates').insert(template_data).execute()
            
            if not result.data:
                raise ValueError("Failed to create template")
            
            template_id = result.data[0]['template_id']
            logger.info(f"Successfully created template {template_id} from agent {agent_id} with is_kortix_team={is_kortix_team}")
            
            return template_id
            
        except Exception as e:
            logger.error(f"Error creating template from agent {agent_id}: {str(e)}")
            raise
    
    async def get_template(self, template_id: str) -> Optional[AgentTemplate]:
        """Get an agent template by ID"""
        try:
            client = await db.client
            
            result = await client.table('agent_templates').select('*')\
                .eq('template_id', template_id).execute()
            
            if not result.data:
                return None
            
            template_data = result.data[0]
            
            # Convert mcp_requirements to MCPRequirement objects
            mcp_requirements = []
            for req_data in template_data.get('mcp_requirements', []):
                mcp_requirements.append(MCPRequirement(
                    qualified_name=req_data.get('qualified_name') or req_data.get('qualifiedName'),
                    display_name=req_data.get('display_name') or req_data.get('name'),
                    enabled_tools=req_data.get('enabled_tools') or req_data.get('enabledTools', []),
                    required_config=req_data.get('required_config') or req_data.get('requiredConfig', []),
                    custom_type=req_data.get('custom_type')
                ))
            
            return AgentTemplate(
                template_id=template_data['template_id'],
                creator_id=template_data['creator_id'],
                name=template_data['name'],
                description=template_data.get('description'),
                system_prompt=template_data['system_prompt'],
                mcp_requirements=mcp_requirements,
                agentpress_tools=template_data.get('agentpress_tools', {}),
                tags=template_data.get('tags', []),
                is_public=template_data.get('is_public', False),
                marketplace_published_at=template_data.get('marketplace_published_at'),
                download_count=template_data.get('download_count', 0),
                created_at=template_data['created_at'],
                updated_at=template_data['updated_at'],
                avatar=template_data.get('avatar'),
                avatar_color=template_data.get('avatar_color'),
                metadata=template_data.get('metadata', {})
            )
            
        except Exception as e:
            logger.error(f"Error getting template {template_id}: {str(e)}")
            return None
    
    async def install_template(
        self, 
        template_id: str, 
        account_id: str,
        instance_name: Optional[str] = None,
        custom_system_prompt: Optional[str] = None,
        profile_mappings: Optional[Dict[str, str]] = None,
        custom_mcp_configs: Optional[Dict[str, Dict[str, Any]]] = None
    ) -> Dict[str, Any]:
        """
        Install a template as an agent instance for a user
        
        Args:
            template_id: ID of the template to install
            account_id: ID of the user installing the template
            instance_name: Optional custom name for the instance
            custom_system_prompt: Optional custom system prompt override
            profile_mappings: Optional dict mapping qualified_name to profile_id
            custom_mcp_configs: Optional dict mapping qualified_name to config for custom MCPs
            
        Returns:
            Dictionary with installation result and any missing credentials
        """
        logger.info(f"Installing template {template_id} for user {account_id}")
        
        try:
            # Get the template
            template = await self.get_template(template_id)
            if not template:
                raise ValueError("Template not found")
            
            # Check if template is accessible
            if not template.is_public:
                # Check if user owns the template
                if template.creator_id != account_id:
                    raise ValueError("Access denied to private template")
            
            # Debug: Log template requirements
            logger.info(f"Template MCP requirements: {[(req.qualified_name, req.display_name, getattr(req, 'custom_type', None)) for req in template.mcp_requirements]}")
            
            # Separate custom and regular MCP requirements
            custom_requirements = [req for req in template.mcp_requirements if getattr(req, 'custom_type', None)]
            regular_requirements = [req for req in template.mcp_requirements if not getattr(req, 'custom_type', None)]
            
            # If no profile mappings provided, try to use default profiles
            if not profile_mappings and regular_requirements:
                profile_mappings = {}
                for req in regular_requirements:
                    # Get default profile for this MCP service
                    default_profile = await credential_manager.get_default_credential_profile(
                        account_id, req.qualified_name
                    )
                    if default_profile:
                        profile_mappings[req.qualified_name] = default_profile.profile_id
            
            # Check for missing profile mappings for regular requirements
            missing_profile_mappings = []
            if regular_requirements:
                provided_mappings = profile_mappings or {}
                for req in regular_requirements:
                    if req.qualified_name not in provided_mappings:
                        missing_profile_mappings.append({
                            'qualified_name': req.qualified_name,
                            'display_name': req.display_name,
                            'required_config': req.required_config
                        })
            
            # Check for missing custom MCP configs
            missing_custom_configs = []
            if custom_requirements:
                provided_custom_configs = custom_mcp_configs or {}
                for req in custom_requirements:
                    if req.qualified_name not in provided_custom_configs:
                        missing_custom_configs.append({
                            'qualified_name': req.qualified_name,
                            'display_name': req.display_name,
                            'custom_type': req.custom_type,
                            'required_config': req.required_config
                        })
            
            # If we have any missing profile mappings or configs, return them
            if missing_profile_mappings or missing_custom_configs:
                return {
                    'status': 'configs_required',
                    'missing_regular_credentials': missing_profile_mappings,
                    'missing_custom_configs': missing_custom_configs,
                    'template': {
                        'template_id': template.template_id,
                        'name': template.name,
                        'description': template.description
                    }
                }
            
            # Create regular agent with secure credentials
            client = await db.client
            
            # Build configured_mcps and custom_mcps with user's credential profiles
            configured_mcps = []
            custom_mcps = []
            
            for req in template.mcp_requirements:
                logger.info(f"Processing requirement: {req.qualified_name}, custom_type: {getattr(req, 'custom_type', None)}")
                
                if hasattr(req, 'custom_type') and req.custom_type:
                    # For custom MCP servers, use the provided config from installation
                    if custom_mcp_configs and req.qualified_name in custom_mcp_configs:
                        provided_config = custom_mcp_configs[req.qualified_name]
                        
                        custom_mcp_config = {
                            'name': req.display_name,
                            'type': req.custom_type,
                            'config': provided_config,
                            'enabledTools': req.enabled_tools
                        }
                        custom_mcps.append(custom_mcp_config)
                        logger.info(f"Added custom MCP with provided config: {custom_mcp_config}")
                    else:
                        logger.warning(f"No custom config provided for {req.qualified_name}")
                        continue
                else:
                    # For regular MCP servers, use the selected credential profile
                    if profile_mappings and req.qualified_name in profile_mappings:
                        profile_id = profile_mappings[req.qualified_name]
                        
                        # Validate profile_id is not empty
                        if not profile_id or profile_id.strip() == '':
                            logger.error(f"Empty profile_id provided for {req.qualified_name}")
                            raise ValueError(f"Invalid credential profile selected for {req.display_name}")
                        
                        # Get the credential profile
                        profile = await credential_manager.get_credential_by_profile(
                            account_id, profile_id
                        )
                        
                        if not profile:
                            logger.error(f"Credential profile {profile_id} not found for {req.qualified_name}")
                            raise ValueError(f"Credential profile not found for {req.display_name}. Please select a valid profile or create a new one.")
                        
                        # Validate profile is active
                        if not profile.is_active:
                            logger.error(f"Credential profile {profile_id} is inactive for {req.qualified_name}")
                            raise ValueError(f"Selected credential profile for {req.display_name} is inactive. Please select an active profile.")
                        
                        mcp_config = {
                            'name': req.display_name,
                            'qualifiedName': req.qualified_name,
                            'config': profile.config,
                            'enabledTools': req.enabled_tools,
                            'selectedProfileId': profile_id
                        }
                        configured_mcps.append(mcp_config)
                        logger.info(f"Added regular MCP with profile: {mcp_config}")
                    else:
                        logger.error(f"No profile mapping provided for {req.qualified_name}")
                        raise ValueError(f"Missing credential profile for {req.display_name}. Please select a credential profile.")
            
            logger.info(f"Final configured_mcps: {configured_mcps}")
            logger.info(f"Final custom_mcps: {custom_mcps}")
            
            agent_data = {
                'account_id': account_id,
                'name': instance_name or f"{template.name} (from marketplace)",
                'description': template.description,
                'system_prompt': custom_system_prompt or template.system_prompt,
                'configured_mcps': configured_mcps,
                'custom_mcps': custom_mcps,
                'agentpress_tools': template.agentpress_tools,
                'is_default': False,
                'avatar': template.avatar,
                'avatar_color': template.avatar_color
            }
            
            result = await client.table('agents').insert(agent_data).execute()
            
            if not result.data:
                raise ValueError("Failed to create agent")
            
            instance_id = result.data[0]['agent_id']

            try:
                initial_version_data = {
                    "agent_id": instance_id,
                    "version_number": 1,
                    "version_name": "v1",
                    "system_prompt": agent_data['system_prompt'],
                    "configured_mcps": agent_data['configured_mcps'],
                    "custom_mcps": agent_data['custom_mcps'],
                    "agentpress_tools": agent_data['agentpress_tools'],
                    "is_active": True,
                    "created_by": account_id
                }
                
                version_result = await client.table('agent_versions').insert(initial_version_data).execute()
                
                if version_result.data:
                    version_id = version_result.data[0]['version_id']
                    await client.table('agents').update({
                        'current_version_id': version_id,
                        'version_count': 1
                    }).eq('agent_id', instance_id).execute()
                    await client.table('agent_version_history').insert({
                        "agent_id": instance_id,
                        "version_id": version_id,
                        "action": "created",
                        "changed_by": account_id,
                        "change_description": "Initial version created from template installation"
                    }).execute()
                    
                    logger.info(f"Created initial version v1 for installed agent {instance_id}")
                else:
                    logger.warning(f"Failed to create initial version for agent {instance_id}")
                    
            except Exception as e:
                logger.warning(f"Failed to create initial version for agent {instance_id}: {e}")
            await client.table('agent_templates')\
                .update({'download_count': template.download_count + 1})\
                .eq('template_id', template_id).execute()
            
            logger.info(f"Successfully installed template {template_id} as instance {instance_id}")
            
            return {
                'status': 'installed',
                'instance_id': instance_id,
                'name': agent_data['name']
            }
            
        except Exception as e:
            logger.error(f"Error installing template {template_id}: {str(e)}")
            raise
    
    async def get_agent_instance(self, instance_id: str) -> Optional[AgentInstance]:
        """Get an agent instance by ID"""
        try:
            client = await db.client
            
            result = await client.table('agent_instances').select('*')\
                .eq('instance_id', instance_id).execute()
            
            if not result.data:
                return None
            
            instance_data = result.data[0]
            
            return AgentInstance(
                instance_id=instance_data['instance_id'],
                template_id=instance_data.get('template_id'),
                account_id=instance_data['account_id'],
                name=instance_data['name'],
                description=instance_data.get('description'),
                credential_mappings=instance_data.get('credential_mappings', {}),
                custom_system_prompt=instance_data.get('custom_system_prompt'),
                is_active=instance_data.get('is_active', True),
                is_default=instance_data.get('is_default', False),
                created_at=instance_data['created_at'],
                updated_at=instance_data['updated_at'],
                avatar=instance_data.get('avatar'),
                avatar_color=instance_data.get('avatar_color')
            )
            
        except Exception as e:
            logger.error(f"Error getting agent instance {instance_id}: {str(e)}")
            return None
    
    async def build_runtime_agent_config(self, instance_id: str) -> Dict[str, Any]:
        """
        Build a complete agent configuration for runtime use by combining
        template data with user credentials
        
        Args:
            instance_id: ID of the agent instance
            
        Returns:
            Complete agent configuration with populated MCP configs
        """
        logger.info(f"Building runtime config for agent instance {instance_id}")
        
        try:
            # Get the agent instance
            instance = await self.get_agent_instance(instance_id)
            if not instance:
                raise ValueError("Agent instance not found")
            
            # If this is a legacy agent (no template), handle differently
            if not instance.template_id:
                return await self._build_legacy_agent_config(instance_id)
            
            # Get the template
            template = await self.get_template(instance.template_id)
            if not template:
                raise ValueError("Template not found")
            
            # Build configured_mcps and custom_mcps with user's credentials
            configured_mcps = []
            custom_mcps = []
            
            for req in template.mcp_requirements:
                credential_id = instance.credential_mappings.get(req.qualified_name)
                if not credential_id:
                    logger.warning(f"No credential mapping for {req.qualified_name}")
                    continue
                
                # Get the credential
                credential = await credential_manager.get_credential(
                    instance.account_id, req.qualified_name
                )
                
                if not credential:
                    logger.warning(f"Credential not found for {req.qualified_name}")
                    continue
                
                # Check if this is a custom MCP server
                if req.custom_type:
                    # Build custom MCP config
                    custom_mcp_config = {
                        'name': req.display_name,
                        'type': req.custom_type,
                        'config': credential.config,
                        'enabledTools': req.enabled_tools
                    }
                    custom_mcps.append(custom_mcp_config)
                else:
                    # Build regular MCP config
                    mcp_config = {
                        'name': req.display_name,
                        'qualifiedName': req.qualified_name,
                        'config': credential.config,
                        'enabledTools': req.enabled_tools
                    }
                    configured_mcps.append(mcp_config)
            
            # Build complete agent config
            agent_config = {
                'agent_id': instance.instance_id,
                'account_id': instance.account_id,
                'name': instance.name,
                'description': instance.description,
                'system_prompt': instance.custom_system_prompt or template.system_prompt,
                'configured_mcps': configured_mcps,
                'custom_mcps': custom_mcps,
                'agentpress_tools': template.agentpress_tools,
                'is_default': instance.is_default,
                'avatar': instance.avatar,
                'avatar_color': instance.avatar_color,
                'created_at': instance.created_at,
                'updated_at': instance.updated_at
            }
            
            return agent_config
            
        except Exception as e:
            logger.error(f"Error building runtime config for instance {instance_id}: {str(e)}")
            raise
    
    async def _build_legacy_agent_config(self, instance_id: str) -> Dict[str, Any]:
        """Build config for legacy agents (backward compatibility)"""
        try:
            client = await db.client
            
            # For legacy agents, instance_id should match agent_id in agents table
            result = await client.table('agents').select('*').eq('agent_id', instance_id).execute()
            
            if not result.data:
                raise ValueError("Legacy agent not found")
            
            agent = result.data[0]
            return agent
            
        except Exception as e:
            logger.error(f"Error building legacy agent config: {str(e)}")
            raise
    
    async def publish_template(self, template_id: str, creator_id: str, tags: Optional[List[str]] = None) -> bool:
        """Publish a template to the marketplace"""
        try:
            client = await db.client
            
            # Verify ownership
            template = await self.get_template(template_id)
            if not template or template.creator_id != creator_id:
                raise ValueError("Template not found or access denied")
            
            # Check if this is a Kortix team account
            kortix_team_account_ids = [
                'bc14b70b-2edf-473c-95be-5f5b109d6553',  # Your Kortix team account ID
                # Add more Kortix team account IDs here as needed
            ]
            
            is_kortix_team = template.creator_id in kortix_team_account_ids
            
            # Update template
            update_data = {
                'is_public': True,
                'marketplace_published_at': datetime.now(timezone.utc).isoformat(),
                'is_kortix_team': is_kortix_team  # Set based on account
            }
            
            if tags:
                update_data['tags'] = tags
            
            result = await client.table('agent_templates')\
                .update(update_data)\
                .eq('template_id', template_id)\
                .execute()
            
            logger.info(f"Published template {template_id} with is_kortix_team={is_kortix_team}")
            return len(result.data) > 0
            
        except Exception as e:
            logger.error(f"Error publishing template {template_id}: {str(e)}")
            return False

    async def unpublish_template(self, template_id: str, creator_id: str) -> bool:
        """Unpublish a template from the marketplace"""
        try:
            client = await db.client
            
            # Verify ownership
            template = await self.get_template(template_id)
            if not template or template.creator_id != creator_id:
                raise ValueError("Template not found or access denied")
            
            # Update template to make it private
            update_data = {
                'is_public': False,
                'marketplace_published_at': None
            }
            
            result = await client.table('agent_templates')\
                .update(update_data)\
                .eq('template_id', template_id)\
                .execute()
            
            return len(result.data) > 0
            
        except Exception as e:
            logger.error(f"Error unpublishing template {template_id}: {str(e)}")
            return False
    
    async def get_marketplace_templates(
        self, 
        limit: int = 50, 
        offset: int = 0,
        search: Optional[str] = None,
        tags: Optional[List[str]] = None
    ) -> List[Dict[str, Any]]:
        """Get public templates from marketplace"""
        try:
            client = await db.client
            
            query = client.table('agent_templates')\
                .select('*')\
                .eq('is_public', True)\
                .order('is_kortix_team', desc=True)\
                .order('marketplace_published_at', desc=True)\
                .range(offset, offset + limit - 1)
            
            if search:
                query = query.or_(f'name.ilike.%{search}%,description.ilike.%{search}%')
            
            if tags:
                query = query.overlaps('tags', tags)
            
            result = await query.execute()
            
            templates = []
            for template_data in result.data:
                # Use the database field for is_kortix_team
                is_kortix_team = template_data.get('is_kortix_team', False)
                
                templates.append({
                    'template_id': template_data['template_id'],
                    'name': template_data['name'],
                    'description': template_data.get('description'),
                    'mcp_requirements': template_data.get('mcp_requirements', []),
                    'agentpress_tools': template_data.get('agentpress_tools', {}),
                    'tags': template_data.get('tags', []),
                    'is_public': template_data.get('is_public', True),
                    'download_count': template_data.get('download_count', 0),
                    'marketplace_published_at': template_data.get('marketplace_published_at'),
                    'created_at': template_data['created_at'],
                    'creator_name': 'Kortix Team' if is_kortix_team else 'Community',
                    'avatar': template_data.get('avatar'),
                    'avatar_color': template_data.get('avatar_color'),
                    'is_kortix_team': is_kortix_team
                })
            
            # Templates are already sorted by database query (Kortix team first, then by date)
            return templates
            
        except Exception as e:
            logger.error(f"Error getting marketplace templates: {str(e)}")
            return []

    async def get_user_templates(
        self, 
        creator_id: str,
        limit: int = 50, 
        offset: int = 0
    ) -> List[Dict[str, Any]]:
        """Get all templates created by a specific user"""
        try:
            client = await db.client
            
            query = client.table('agent_templates')\
                .select('*')\
                .eq('creator_id', creator_id)\
                .order('created_at', desc=True)\
                .range(offset, offset + limit - 1)
            
            result = await query.execute()
            
            templates = []
            for template_data in result.data:
                templates.append({
                    'template_id': template_data['template_id'],
                    'name': template_data['name'],
                    'description': template_data.get('description'),
                    'mcp_requirements': template_data.get('mcp_requirements', []),
                    'agentpress_tools': template_data.get('agentpress_tools', {}),
                    'tags': template_data.get('tags', []),
                    'is_public': template_data.get('is_public', False),
                    'download_count': template_data.get('download_count', 0),
                    'marketplace_published_at': template_data.get('marketplace_published_at'),
                    'created_at': template_data['created_at'],
                    'creator_name': 'You',
                    'avatar': template_data.get('avatar'),
                    'avatar_color': template_data.get('avatar_color')
                })
            
            return templates
            
        except Exception as e:
            logger.error(f"Error getting user templates: {str(e)}")
            return []


# Global template manager instance
template_manager = TemplateManager() 