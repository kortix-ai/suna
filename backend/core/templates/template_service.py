import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Dict, List, Any, Optional
from uuid import uuid4
import secrets
import string

from core.services.supabase import DBConnection
from core.utils.logger import logger

ConfigType = Dict[str, Any]
ProfileId = str
QualifiedName = str

@dataclass(frozen=True)
class MCPRequirementValue:
    qualified_name: str
    display_name: str
    enabled_tools: List[str] = field(default_factory=list)
    required_config: List[str] = field(default_factory=list)
    custom_type: Optional[str] = None
    toolkit_slug: Optional[str] = None
    app_slug: Optional[str] = None
    source: Optional[str] = None
    trigger_index: Optional[int] = None
    
    def is_custom(self) -> bool:
        if self.qualified_name.startswith('pipedream:'):
            return False
        if self.custom_type == 'composio' or self.qualified_name.startswith('composio.'):
            return False
        return self.custom_type is not None and self.qualified_name.startswith('custom_')

@dataclass(frozen=True)
class AgentTemplate:
    template_id: str
    creator_id: str
    name: str
    config: ConfigType
    description: Optional[str] = None
    tags: List[str] = field(default_factory=list)
    is_public: bool = False
    is_kortix_team: bool = False
    marketplace_published_at: Optional[datetime] = None
    download_count: int = 0
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    profile_image_url: Optional[str] = None
    icon_name: Optional[str] = None
    icon_color: Optional[str] = None
    icon_background: Optional[str] = None
    metadata: ConfigType = field(default_factory=dict)
    creator_name: Optional[str] = None
    
    def with_public_status(self, is_public: bool, published_at: Optional[datetime] = None) -> 'AgentTemplate':
        return AgentTemplate(
            **{**self.__dict__, 
               'is_public': is_public, 
               'marketplace_published_at': published_at}
        )
    
    @property
    def system_prompt(self) -> str:
        return self.config.get('system_prompt', '')
    
    @property
    def agentpress_tools(self) -> Dict[str, Any]:
        return self.config.get('tools', {}).get('agentpress', {})
    
    @property
    def workflows(self) -> List[Dict[str, Any]]:
        return self.config.get('workflows', [])
    
    @property
    def mcp_requirements(self) -> List[MCPRequirementValue]:
        requirements = []
        
        mcps = self.config.get('tools', {}).get('mcp', [])
        for mcp in mcps:
            if isinstance(mcp, dict) and mcp.get('name'):
                qualified_name = mcp.get('qualifiedName', mcp['name'])
                
                requirements.append(MCPRequirementValue(
                    qualified_name=qualified_name,
                    display_name=mcp.get('display_name') or mcp['name'],
                    enabled_tools=mcp.get('enabledTools', []),
                    required_config=mcp.get('requiredConfig', []),
                    source='tool'
                ))
        
        custom_mcps = self.config.get('tools', {}).get('custom_mcp', [])
        for mcp in custom_mcps:
            if isinstance(mcp, dict) and mcp.get('name'):
                mcp_type = mcp.get('type', 'sse')
                mcp_name = mcp['name']
                
                qualified_name = mcp.get('mcp_qualified_name') or mcp.get('qualifiedName')
                if not qualified_name:
                    if mcp_type == 'pipedream':
                        app_slug = mcp.get('app_slug') or mcp.get('config', {}).get('headers', {}).get('x-pd-app-slug')
                        if not app_slug:
                            app_slug = mcp_name.lower().replace(' ', '').replace('(', '').replace(')', '')
                        qualified_name = f"pipedream:{app_slug}"
                    elif mcp_type == 'composio':
                        toolkit_slug = mcp.get('toolkit_slug') or mcp_name.lower().replace(' ', '_')
                        qualified_name = f"composio.{toolkit_slug}"
                    else:
                        safe_name = mcp_name.replace(' ', '_').lower()
                        qualified_name = f"custom_{mcp_type}_{safe_name}"
                
                if mcp_type in ['pipedream', 'composio']:
                    required_config = []
                elif mcp_type in ['http', 'sse', 'json']:
                    required_config = ['url']
                else:
                    required_config = mcp.get('requiredConfig', ['url'])
                
                requirements.append(MCPRequirementValue(
                    qualified_name=qualified_name,
                    display_name=mcp.get('display_name') or mcp_name,
                    enabled_tools=mcp.get('enabledTools', []),
                    required_config=required_config,
                    custom_type=mcp_type,
                    toolkit_slug=mcp.get('toolkit_slug') if mcp_type == 'composio' else None,
                    app_slug=mcp.get('app_slug') if mcp_type == 'pipedream' else None,
                    source='tool'
                ))
        
        triggers = self.config.get('triggers', [])
        
        for i, trigger in enumerate(triggers):
            config = trigger.get('config', {})
            provider_id = config.get('provider_id', '')
            
            if provider_id == 'composio':
                qualified_name = config.get('qualified_name')
                
                if not qualified_name:
                    trigger_slug = config.get('trigger_slug', '')
                    if trigger_slug:
                        app_name = trigger_slug.split('_')[0].lower() if '_' in trigger_slug else 'composio'
                        qualified_name = f'composio.{app_name}'
                    else:
                        qualified_name = 'composio'
                
                if qualified_name:
                    if qualified_name.startswith('composio.'):
                        app_name = qualified_name.split('.', 1)[1]
                    else:
                        app_name = 'composio'
                    
                    trigger_name = trigger.get('name', f'Trigger {i+1}')
                    
                    composio_req = MCPRequirementValue(
                        qualified_name=qualified_name,
                        display_name=f"{app_name.title()} ({trigger_name})",
                        enabled_tools=[],
                        required_config=[],
                        custom_type=None,
                        toolkit_slug=app_name,
                        app_slug=app_name,
                        source='trigger',
                        trigger_index=i
                    )
                    requirements.append(composio_req)
        
        return requirements

@dataclass
class TemplateCreationRequest:
    agent_id: str
    creator_id: str
    make_public: bool = False
    tags: Optional[List[str]] = None

class TemplateNotFoundError(Exception):
    pass

class TemplateAccessDeniedError(Exception):
    pass

class SunaDefaultAgentTemplateError(Exception):
    pass

class TemplateService:
    def __init__(self, db_connection: DBConnection):
        self._db = db_connection
    
    async def create_from_agent(
        self,
        agent_id: str,
        creator_id: str,
        make_public: bool = False,
        tags: Optional[List[str]] = None
    ) -> str:
        logger.debug(f"Creating template from agent {agent_id} for user {creator_id}")
        
        agent = await self._get_agent_by_id(agent_id)
        if not agent:
            raise TemplateNotFoundError("Agent not found")
        
        if agent['account_id'] != creator_id:
            raise TemplateAccessDeniedError("You can only create templates from your own agents")
        
        if self._is_suna_default_agent(agent):
            raise SunaDefaultAgentTemplateError("Cannot create template from Suna default agent")
        
        version_config = await self._get_agent_version_config(agent)
        if not version_config:
            raise TemplateNotFoundError("Agent has no version configuration")
        
        sanitized_config = await self._sanitize_config_for_template(version_config)
        
        template = AgentTemplate(
            template_id=str(uuid4()),
            creator_id=creator_id,
            name=agent['name'],
            description=agent.get('description'),
            config=sanitized_config,
            tags=tags or [],
            is_public=make_public,
            marketplace_published_at=datetime.now(timezone.utc) if make_public else None,
            profile_image_url=agent.get('profile_image_url'),
            icon_name=agent.get('icon_name'),
            icon_color=agent.get('icon_color'),
            icon_background=agent.get('icon_background'),
            metadata=agent.get('metadata', {})
        )
        
        await self._save_template(template)
        
        logger.debug(f"Created template {template.template_id} from agent {agent_id}")
        return template.template_id
    
    async def get_template(self, template_id: str) -> Optional[AgentTemplate]:
        try:
            logger.debug(f"Querying database for template_id: {template_id}")
            client = await self._db.client
            result = await client.table('agent_templates').select('*')\
                .eq('template_id', template_id)\
                .maybe_single()\
                .execute()
            
            logger.debug(f"Database query result for {template_id}: {result.data is not None}")
            
            if not result.data:
                logger.debug(f"No template found with ID: {template_id}")
                return None
            
            creator_id = result.data['creator_id']
            logger.debug(f"Template {template_id} found, creator_id: {creator_id}")
            
            try:
                creator_result = await client.schema('basejump').from_('accounts').select('id, name, slug').eq('id', creator_id).execute()
                
                creator_name = None
                if creator_result.data and len(creator_result.data) > 0:
                    account = creator_result.data[0]
                    creator_name = account.get('name') or account.get('slug')
                
                result.data['creator_name'] = creator_name
                logger.debug(f"Creator name resolved for {template_id}: {creator_name}")
                
            except Exception as e:
                logger.warning(f"Failed to get creator name for template {template_id}: {e}")
                result.data['creator_name'] = None
            
            return self._map_to_template(result.data)
            
        except Exception as e:
            logger.error(f"Error in get_template for {template_id}: {e}", exc_info=True)
            raise
    
    async def get_user_templates(self, creator_id: str) -> List[AgentTemplate]:
        client = await self._db.client
        result = await client.table('agent_templates').select('*')\
            .eq('creator_id', creator_id)\
            .order('created_at', desc=True)\
            .execute()
        
        if not result.data:
            return []
        
        creator_result = await client.schema('basejump').from_('accounts').select('id, name, slug').eq('id', creator_id).execute()
        
        creator_name = None
        if creator_result.data:
            account = creator_result.data[0]
            creator_name = account.get('name') or account.get('slug')
        
        templates = []
        for template_data in result.data:
            template_data['creator_name'] = creator_name
            templates.append(self._map_to_template(template_data))
        
        return templates
    
    async def get_public_templates(
        self,
        is_kortix_team: Optional[bool] = None,
        limit: Optional[int] = None,
        offset: int = 0,
        search: Optional[str] = None,
        tags: Optional[List[str]] = None
    ) -> List[AgentTemplate]:
        client = await self._db.client
        
        query = client.table('agent_templates').select('*').eq('is_public', True)
        
        if is_kortix_team is not None:
            query = query.eq('is_kortix_team', is_kortix_team)
        
        if search:
            query = query.or_(f"name.ilike.%{search}%,description.ilike.%{search}%")
        
        if tags:
            for tag in tags:
                query = query.contains('tags', [tag])
        
        query = query.order('download_count', desc=True)\
                    .order('marketplace_published_at', desc=True)
        
        if limit:
            query = query.limit(limit)
        if offset:
            query = query.offset(offset)
        
        result = await query.execute()
        
        if not result.data:
            return []
        
        creator_ids = list(set(template['creator_id'] for template in result.data))
        
        from core.utils.query_utils import batch_query_in
        
        accounts_data = await batch_query_in(
            client=client,
            table_name='accounts',
            select_fields='id, name, slug',
            in_field='id',
            in_values=creator_ids,
            schema='basejump'
        )
        
        creator_names = {}
        for account in accounts_data:
            creator_names[account['id']] = account.get('name') or account.get('slug')
        
        templates = []
        for template_data in result.data:
            creator_name = creator_names.get(template_data['creator_id'])
            template_data['creator_name'] = creator_name
            templates.append(self._map_to_template(template_data))
        
        return templates
    
    async def publish_template(self, template_id: str, creator_id: str) -> bool:
        logger.debug(f"Publishing template {template_id}")
        
        client = await self._db.client
        result = await client.table('agent_templates').update({
            'is_public': True,
            'marketplace_published_at': datetime.now(timezone.utc).isoformat(),
            'updated_at': datetime.now(timezone.utc).isoformat()
        }).eq('template_id', template_id)\
          .eq('creator_id', creator_id)\
          .execute()
        
        success = len(result.data) > 0
        if success:
            logger.debug(f"Published template {template_id}")
        
        return success
    
    async def unpublish_template(self, template_id: str, creator_id: str) -> bool:
        logger.debug(f"Unpublishing template {template_id}")
        
        client = await self._db.client
        result = await client.table('agent_templates').update({
            'is_public': False,
            'marketplace_published_at': None,
            'updated_at': datetime.now(timezone.utc).isoformat()
        }).eq('template_id', template_id)\
          .eq('creator_id', creator_id)\
          .execute()
        
        success = len(result.data) > 0
        if success:
            logger.debug(f"Unpublished template {template_id}")
        
        return success
    
    async def delete_template(self, template_id: str, creator_id: str) -> bool:
        """Delete a template. Only the creator can delete their templates."""
        logger.debug(f"Deleting template {template_id} for user {creator_id}")
        
        client = await self._db.client
        
        # First check if template exists and user owns it
        template_result = await client.table('agent_templates').select('*')\
            .eq('template_id', template_id)\
            .maybe_single()\
            .execute()
        
        if not template_result.data:
            logger.warning(f"Template {template_id} not found")
            return False
        
        template = template_result.data
        if template['creator_id'] != creator_id:
            logger.warning(f"User {creator_id} cannot delete template {template_id} (owned by {template['creator_id']})")
            return False
        
        # Delete the template
        result = await client.table('agent_templates').delete()\
            .eq('template_id', template_id)\
            .eq('creator_id', creator_id)\
            .execute()
        
        success = len(result.data) > 0
        if success:
            logger.debug(f"Successfully deleted template {template_id}")
        
        return success
    
    async def increment_download_count(self, template_id: str) -> None:
        client = await self._db.client
        await client.rpc('increment_template_download_count', {
            'template_id_param': template_id
        }).execute()
    
    async def validate_access(self, template: AgentTemplate, user_id: str) -> None:
        if template.creator_id != user_id and not template.is_public:
            raise TemplateAccessDeniedError("Access denied to template")
    
    async def _get_agent_by_id(self, agent_id: str) -> Optional[Dict[str, Any]]:
        client = await self._db.client
        result = await client.table('agents').select('*')\
            .eq('agent_id', agent_id)\
            .maybe_single()\
            .execute()
        
        return result.data
    
    async def _get_agent_version_config(self, agent: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        version_id = agent.get('current_version_id')
        if version_id:
            client = await self._db.client
            result = await client.table('agent_versions').select('config')\
                .eq('version_id', version_id)\
                .maybe_single()\
                .execute()
            
            if result.data and result.data['config']:
                return result.data['config']
        
        return {}
    
    async def _sanitize_config_for_template(self, config: Dict[str, Any]) -> Dict[str, Any]:
        return self._fallback_sanitize_config(config)
    
    def _fallback_sanitize_config(self, config: Dict[str, Any]) -> Dict[str, Any]:
        agentpress_tools = config.get('tools', {}).get('agentpress', {})
        sanitized_agentpress = {}
        
        for tool_name, tool_config in agentpress_tools.items():
            if isinstance(tool_config, dict):
                sanitized_agentpress[tool_name] = tool_config.get('enabled', False)
            elif isinstance(tool_config, bool):
                sanitized_agentpress[tool_name] = tool_config
            else:
                sanitized_agentpress[tool_name] = False
        
        workflows = config.get('workflows', [])
        sanitized_workflows = []
        for workflow in workflows:
            if isinstance(workflow, dict):
                sanitized_workflow = {
                    'name': workflow.get('name'),
                    'description': workflow.get('description'),
                    'status': workflow.get('status', 'draft'),
                    'trigger_phrase': workflow.get('trigger_phrase'),
                    'is_default': workflow.get('is_default', False),
                    'steps': workflow.get('steps', [])
                }
                sanitized_workflows.append(sanitized_workflow)
        
        triggers = config.get('triggers', [])
        sanitized_triggers = []
        for trigger in triggers:
            if isinstance(trigger, dict):
                trigger_config = trigger.get('config', {})
                provider_id = trigger_config.get('provider_id', '')
                
                sanitized_config = {
                    'provider_id': provider_id,
                    'agent_prompt': trigger_config.get('agent_prompt', ''),
                    'execution_type': trigger_config.get('execution_type', 'agent')
                }
                
                if sanitized_config['execution_type'] == 'workflow':
                    workflow_id = trigger_config.get('workflow_id')
                    if workflow_id:
                        workflow_name = None
                        for workflow in workflows:
                            if workflow.get('id') == workflow_id:
                                workflow_name = workflow.get('name')
                                break
                        if workflow_name:
                            sanitized_config['workflow_name'] = workflow_name
                    
                    if 'workflow_input' in trigger_config:
                        sanitized_config['workflow_input'] = trigger_config['workflow_input']
                
                if provider_id == 'schedule':
                    sanitized_config['cron_expression'] = trigger_config.get('cron_expression', '')
                    sanitized_config['timezone'] = trigger_config.get('timezone', 'UTC')
                elif provider_id == 'composio':
                    sanitized_config['trigger_slug'] = trigger_config.get('trigger_slug', '')
                    if 'qualified_name' in trigger_config:
                        sanitized_config['qualified_name'] = trigger_config['qualified_name']

                sanitized_trigger = {
                    'name': trigger.get('name'),
                    'description': trigger.get('description'),
                    'trigger_type': trigger.get('trigger_type'),
                    'is_active': trigger.get('is_active', True),
                    'config': sanitized_config
                }
                sanitized_triggers.append(sanitized_trigger)
        
        sanitized = {
            'system_prompt': config.get('system_prompt', ''),
            'model': config.get('model'),
            'tools': {
                'agentpress': sanitized_agentpress,
                'mcp': config.get('tools', {}).get('mcp', []),
                'custom_mcp': []
            },
            'workflows': sanitized_workflows,
            'triggers': sanitized_triggers,
            'metadata': {}
        }
        
        custom_mcps = config.get('tools', {}).get('custom_mcp', [])
        for mcp in custom_mcps:
            if isinstance(mcp, dict):
                mcp_name = mcp.get('name', '')
                mcp_type = mcp.get('type', 'sse')
                
                sanitized_mcp = {
                    'name': mcp_name,
                    'type': mcp_type,
                    'display_name': mcp.get('display_name') or mcp_name,
                    'enabledTools': mcp.get('enabledTools', [])
                }
                
                if mcp_type == 'pipedream':
                    original_config = mcp.get('config', {})
                    app_slug = (
                        mcp.get('app_slug') or
                        original_config.get('headers', {}).get('x-pd-app-slug')
                    )
                    qualified_name = mcp.get('qualifiedName')
                    
                    if not app_slug:
                        if qualified_name and qualified_name.startswith('pipedream:'):
                            app_slug = qualified_name[10:]
                        else:
                            app_slug = mcp_name.lower().replace(' ', '').replace('(', '').replace(')', '')
                    
                    if not qualified_name:
                        qualified_name = f"pipedream:{app_slug}"
                    
                    sanitized_mcp['qualifiedName'] = qualified_name
                    sanitized_mcp['app_slug'] = app_slug
                    
                    sanitized_mcp['config'] = {
                        'url': original_config.get('url'),
                        'headers': {k: v for k, v in original_config.get('headers', {}).items() 
                                  if k not in ['profile_id', 'x-pd-app-slug']}
                    }
                    
                elif mcp_type == 'composio':
                    original_config = mcp.get('config', {})
                    qualified_name = (
                        mcp.get('mcp_qualified_name') or 
                        original_config.get('mcp_qualified_name') or
                        mcp.get('qualifiedName') or
                        original_config.get('qualifiedName')
                    )
                    toolkit_slug = (
                        mcp.get('toolkit_slug') or 
                        original_config.get('toolkit_slug')
                    )
                    
                    if not qualified_name:
                        if not toolkit_slug:
                            toolkit_slug = mcp_name.lower().replace(' ', '_')
                        qualified_name = f"composio.{toolkit_slug}"
                    else:
                        if not toolkit_slug:
                            if qualified_name.startswith('composio.'):
                                toolkit_slug = qualified_name[9:]
                            else:
                                toolkit_slug = mcp_name.lower().replace(' ', '_')
                    
                    sanitized_mcp['mcp_qualified_name'] = qualified_name
                    sanitized_mcp['toolkit_slug'] = toolkit_slug
                    sanitized_mcp['config'] = {}
                
                else:
                    qualified_name = mcp.get('qualifiedName')
                    if not qualified_name:
                        safe_name = mcp_name.replace(' ', '_').lower()
                        qualified_name = f"custom_{mcp_type}_{safe_name}"
                    
                    sanitized_mcp['qualifiedName'] = qualified_name
                    sanitized_mcp['config'] = {}
                
                sanitized['tools']['custom_mcp'].append(sanitized_mcp)
        
        return sanitized
    
    def _is_suna_default_agent(self, agent: Dict[str, Any]) -> bool:
        metadata = agent.get('metadata', {})
        return metadata.get('is_suna_default', False)
    
    async def _save_template(self, template: AgentTemplate) -> None:
        client = await self._db.client
        
        template_data = {
            'template_id': template.template_id,
            'creator_id': template.creator_id,
            'name': template.name,
            'description': template.description,
            'config': template.config,
            'tags': template.tags,
            'is_public': template.is_public,
            'marketplace_published_at': template.marketplace_published_at.isoformat() if template.marketplace_published_at else None,
            'download_count': template.download_count,
            'created_at': template.created_at.isoformat(),
            'updated_at': template.updated_at.isoformat(),
            'profile_image_url': template.profile_image_url,
            'icon_name': template.icon_name,
            'icon_color': template.icon_color,
            'icon_background': template.icon_background,
            'metadata': template.metadata
        }
        
        await client.table('agent_templates').insert(template_data).execute()
    
    def _map_to_template(self, data: Dict[str, Any]) -> AgentTemplate:
        creator_name = data.get('creator_name')
        
        return AgentTemplate(
            template_id=data['template_id'],
            creator_id=data['creator_id'],
            name=data['name'],
            description=data.get('description'),
            config=data.get('config', {}),
            tags=data.get('tags', []),
            is_public=data.get('is_public', False),
            is_kortix_team=data.get('is_kortix_team', False),
            marketplace_published_at=datetime.fromisoformat(data['marketplace_published_at'].replace('Z', '+00:00')) if data.get('marketplace_published_at') else None,
            download_count=data.get('download_count', 0),
            created_at=datetime.fromisoformat(data['created_at'].replace('Z', '+00:00')),
            updated_at=datetime.fromisoformat(data['updated_at'].replace('Z', '+00:00')),
            profile_image_url=data.get('profile_image_url'),
            icon_name=data.get('icon_name'),
            icon_color=data.get('icon_color'),
            icon_background=data.get('icon_background'),
            metadata=data.get('metadata', {}),
            creator_name=creator_name
        )
    
    # Share link functionality removed - now using direct template ID URLs for simplicity

def get_template_service(db_connection: DBConnection) -> TemplateService:
    return TemplateService(db_connection) 