import json
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Dict, List, Any, Optional
from uuid import uuid4

from core.services.convex_client import get_convex_client, ConvexClient
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
        if self.custom_type == 'composio' or self.qualified_name.startswith('composio.'):
            return False
        return self.custom_type is not None and self.qualified_name.startswith('custom_')


@dataclass(frozen=True)
class AgentTemplate:
    template_id: str
    creator_id: str
    name: str
    config: ConfigType
    tags: List[str] = field(default_factory=list)
    categories: List[str] = field(default_factory=list)
    is_public: bool = False
    is_kortix_team: bool = False
    marketplace_published_at: Optional[datetime] = None
    download_count: int = 0
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    icon_name: Optional[str] = None
    icon_color: Optional[str] = None
    icon_background: Optional[str] = None
    metadata: ConfigType = field(default_factory=dict)
    creator_name: Optional[str] = None
    usage_examples: List[Dict[str, Any]] = field(default_factory=list)

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
                    if mcp_type == 'composio':
                        toolkit_slug = mcp.get('toolkit_slug') or mcp_name.lower().replace(' ', '_')
                        qualified_name = f"composio.{toolkit_slug}"
                    else:
                        safe_name = mcp_name.replace(' ', '_').lower()
                        qualified_name = f"custom_{mcp_type}_{safe_name}"

                if mcp_type == 'composio':
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
                    app_slug=None,
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
    """Service for managing agent templates using Convex backend."""

    def __init__(self, convex_client: ConvexClient = None):
        self._convex = convex_client or get_convex_client()

    async def create_from_agent(
        self,
        agent_id: str,
        creator_id: str,
        make_public: bool = False,
        tags: Optional[List[str]] = None,
        usage_examples: Optional[List[Dict[str, Any]]] = None
    ) -> str:
        """Create a template from an existing agent."""
        logger.debug(f"Creating template from agent {agent_id} for user {creator_id}")

        agent = await self._get_agent_by_id(agent_id)
        if not agent:
            raise TemplateNotFoundError("Worker not found")

        if agent.get('account_id') != creator_id:
            raise TemplateAccessDeniedError("You can only create templates from your own agents")

        if self._is_suna_default_agent(agent):
            raise SunaDefaultAgentTemplateError("Cannot create template from Suna default agent")

        version_config = await self._get_agent_version_config(agent)
        if not version_config:
            raise TemplateNotFoundError("Agent has no version configuration")

        sanitized_config = self._sanitize_config_for_template(version_config)

        template_id = str(uuid4())

        await self._convex.create_template(
            template_id=template_id,
            name=agent['name'],
            creator_id=creator_id,
            config=sanitized_config,
            tags=tags or [],
            categories=[],
            is_public=make_public,
            icon_name=agent.get('icon_name'),
            icon_color=agent.get('icon_color'),
            icon_background=agent.get('icon_background'),
            metadata=agent.get('metadata', {}),
            usage_examples=usage_examples or []
        )

        logger.debug(f"Created template {template_id} from agent {agent_id}")
        return template_id

    async def get_template(self, template_id: str) -> Optional[AgentTemplate]:
        """Get a template by ID."""
        try:
            logger.debug(f"Querying Convex for template_id: {template_id}")

            data = await self._convex.get_template(template_id)

            if not data:
                logger.debug(f"No template found with ID: {template_id}")
                return None

            logger.debug(f"Template {template_id} found, creator_id: {data.get('creator_id')}")

            return self._map_to_template(data)

        except Exception as e:
            logger.error(f"Error in get_template for {template_id}: {e}")
            raise

    async def get_user_templates(self, creator_id: str) -> List[AgentTemplate]:
        """Get all templates for a creator."""
        data_list = await self._convex.list_templates(creator_id=creator_id)

        templates = []
        for data in data_list:
            templates.append(self._map_to_template(data))

        return templates

    async def get_public_templates(
        self,
        is_kortix_team: Optional[bool] = None,
        limit: Optional[int] = None,
        offset: int = 0,
        search: Optional[str] = None,
        tags: Optional[List[str]] = None
    ) -> List[AgentTemplate]:
        """Get public templates for the marketplace."""
        data_list = await self._convex.list_templates(
            is_public=True,
            is_kortix_team=is_kortix_team,
            search=search,
            tags=tags,
            limit=limit or 100,
            offset=offset
        )

        templates = []
        for data in data_list:
            templates.append(self._map_to_template(data))

        return templates

    async def publish_template(
        self,
        template_id: str,
        creator_id: str,
        usage_examples: Optional[List[Dict[str, Any]]] = None
    ) -> bool:
        """Publish a template to the marketplace."""
        logger.debug(f"Publishing template {template_id}")

        try:
            await self._convex.publish_template(template_id, creator_id, usage_examples)
            logger.debug(f"Published template {template_id}")
            return True
        except Exception as e:
            logger.warning(f"Failed to publish template {template_id}: {e}")
            return False

    async def unpublish_template(self, template_id: str, creator_id: str) -> bool:
        """Unpublish a template from the marketplace."""
        logger.debug(f"Unpublishing template {template_id}")

        try:
            await self._convex.unpublish_template(template_id, creator_id)
            logger.debug(f"Unpublished template {template_id}")
            return True
        except Exception as e:
            logger.warning(f"Failed to unpublish template {template_id}: {e}")
            return False

    async def delete_template(self, template_id: str, creator_id: str) -> bool:
        """Delete a template. Only the creator can delete their templates."""
        logger.debug(f"Deleting template {template_id} for user {creator_id}")

        try:
            await self._convex.delete_template(template_id, creator_id)
            logger.debug(f"Successfully deleted template {template_id}")
            return True
        except Exception as e:
            logger.warning(f"Failed to delete template {template_id}: {e}")
            return False

    async def increment_download_count(self, template_id: str) -> None:
        """Increment the download count for a template."""
        try:
            await self._convex.increment_template_download_count(template_id)
        except Exception as e:
            logger.warning(f"Failed to increment download count for template {template_id}: {e}")

    async def validate_access(self, template: AgentTemplate, user_id: str) -> None:
        """Validate that a user has access to a template."""
        if template.creator_id != user_id and not template.is_public:
            raise TemplateAccessDeniedError("Access denied to template")

    async def _get_agent_by_id(self, agent_id: str) -> Optional[Dict[str, Any]]:
        """Get agent data by ID from Convex."""
        try:
            return await self._convex.get_agent(agent_id)
        except Exception as e:
            logger.warning(f"Failed to get agent {agent_id}: {e}")
            return None

    async def _get_agent_version_config(self, agent: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Get the version configuration for an agent."""
        # The agent data from Convex should include the current config
        # If stored separately, we'd need a separate query
        return agent.get('config', {})

    def _sanitize_config_for_template(self, config: Dict[str, Any]) -> Dict[str, Any]:
        """Sanitize agent config for use as a template."""
        agentpress_tools = config.get('tools', {}).get('agentpress', {})
        sanitized_agentpress = {}

        for tool_name, tool_config in agentpress_tools.items():
            if isinstance(tool_config, dict):
                sanitized_agentpress[tool_name] = tool_config.get('enabled', False)
            elif isinstance(tool_config, bool):
                sanitized_agentpress[tool_name] = tool_config
            else:
                sanitized_agentpress[tool_name] = False

        triggers = config.get('triggers', [])
        sanitized_triggers = []
        for trigger in triggers:
            if isinstance(trigger, dict):
                trigger_config = trigger.get('config', {})
                provider_id = trigger_config.get('provider_id', '')

                agent_prompt = trigger_config.get('agent_prompt', '')

                sanitized_config = {
                    'provider_id': provider_id,
                    'agent_prompt': agent_prompt,
                }

                # Extract trigger variables if they exist in the prompt
                trigger_variables = trigger_config.get('trigger_variables', [])
                if not trigger_variables and agent_prompt:
                    # Extract variables from the prompt using regex
                    pattern = r'\{\{(\w+)\}\}'
                    matches = re.findall(pattern, agent_prompt)
                    if matches:
                        trigger_variables = list(set(matches))

                if trigger_variables:
                    sanitized_config['trigger_variables'] = trigger_variables

                if provider_id == 'schedule':
                    sanitized_config['cron_expression'] = trigger_config.get('cron_expression', '')
                    sanitized_config['timezone'] = trigger_config.get('timezone', 'UTC')
                elif provider_id == 'composio':
                    sanitized_config['trigger_slug'] = trigger_config.get('trigger_slug', '')
                    if 'qualified_name' in trigger_config:
                        sanitized_config['qualified_name'] = trigger_config['qualified_name']

                    excluded_fields = {
                        'profile_id', 'composio_trigger_id', 'provider_id',
                        'agent_prompt', 'trigger_slug', 'qualified_name', 'trigger_variables'
                    }

                    trigger_fields = {}
                    for key, value in trigger_config.items():
                        if key not in excluded_fields:
                            if isinstance(value, bool):
                                trigger_fields[key] = {'type': 'boolean', 'required': True}
                            elif isinstance(value, (int, float)):
                                trigger_fields[key] = {'type': 'number', 'required': True}
                            elif isinstance(value, list):
                                trigger_fields[key] = {'type': 'array', 'required': True}
                            elif isinstance(value, dict):
                                trigger_fields[key] = {'type': 'object', 'required': True}
                            else:
                                trigger_fields[key] = {'type': 'string', 'required': True}

                    if trigger_fields:
                        sanitized_config['trigger_fields'] = trigger_fields

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

                if mcp_type == 'composio':
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
        """Check if an agent is a Suna default agent."""
        metadata = agent.get('metadata', {})
        return metadata.get('is_suna_default', False)

    def _map_to_template(self, data: Dict[str, Any]) -> AgentTemplate:
        """Map Convex data to AgentTemplate dataclass."""
        usage_examples = data.get('usage_examples', [])
        logger.debug(f"Mapping template {data.get('template_id')}: usage_examples from DB = {usage_examples}")

        return AgentTemplate(
            template_id=data.get('template_id') or data.get('_id'),
            creator_id=data['creator_id'],
            name=data['name'],
            config=data.get('config', {}),
            tags=data.get('tags', []),
            categories=data.get('categories', []),
            is_public=data.get('is_public', False),
            is_kortix_team=data.get('is_kortix_team', False),
            marketplace_published_at=self._parse_datetime(data.get('marketplace_published_at')),
            download_count=data.get('download_count', 0),
            created_at=self._parse_datetime(data.get('created_at')) or datetime.now(timezone.utc),
            updated_at=self._parse_datetime(data.get('updated_at')) or datetime.now(timezone.utc),
            icon_name=data.get('icon_name'),
            icon_color=data.get('icon_color'),
            icon_background=data.get('icon_background'),
            metadata=data.get('metadata', {}),
            creator_name=data.get('creator_name'),
            usage_examples=usage_examples
        )

    def _parse_datetime(self, value: Any) -> Optional[datetime]:
        """Parse a datetime value from various formats."""
        if not value:
            return None
        if isinstance(value, datetime):
            return value
        if isinstance(value, str):
            try:
                return datetime.fromisoformat(value.replace('Z', '+00:00'))
            except ValueError:
                pass
        return None


def get_template_service(convex_client: ConvexClient = None) -> TemplateService:
    """Get a TemplateService instance."""
    return TemplateService(convex_client)
