from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Dict, List, Any, Optional
from uuid import uuid4
import os
import json
import re

from core.services.convex_client import get_convex_client, ConvexClient
from core.services.http_client import get_http_client
from core.utils.logger import logger
from .template_service import AgentTemplate, MCPRequirementValue, ConfigType, ProfileId, QualifiedName

ConfigType = Dict[str, Any]
ProfileId = str
QualifiedName = str


@dataclass(frozen=True)
class AgentInstance:
    instance_id: str
    account_id: str
    name: str
    template_id: Optional[str] = None
    description: Optional[str] = None
    credential_mappings: Dict[QualifiedName, ProfileId] = field(default_factory=dict)
    custom_system_prompt: Optional[str] = None
    is_active: bool = True
    is_default: bool = False
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))


@dataclass
class TemplateInstallationRequest:
    template_id: str
    account_id: str
    instance_name: Optional[str] = None
    custom_system_prompt: Optional[str] = None
    profile_mappings: Optional[Dict[QualifiedName, ProfileId]] = None
    custom_mcp_configs: Optional[Dict[QualifiedName, ConfigType]] = None
    trigger_configs: Optional[Dict[str, Dict[str, Any]]] = None
    trigger_variables: Optional[Dict[str, Dict[str, str]]] = None


@dataclass
class TemplateInstallationResult:
    status: str
    instance_id: Optional[str] = None
    name: Optional[str] = None
    missing_regular_credentials: List[Dict[str, Any]] = field(default_factory=list)
    missing_custom_configs: List[Dict[str, Any]] = field(default_factory=list)
    missing_trigger_variables: Optional[Dict[str, Dict[str, Any]]] = None
    template_info: Optional[Dict[str, Any]] = None


class TemplateInstallationError(Exception):
    pass


class InvalidCredentialError(Exception):
    pass


class InstallationService:
    """Service for installing templates using Convex backend."""

    def __init__(self, convex_client: ConvexClient = None):
        self._convex = convex_client or get_convex_client()

    def _extract_trigger_variables(self, config: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
        """Extract all trigger variables from template config."""
        trigger_variables = {}
        triggers = config.get('triggers', [])

        for i, trigger in enumerate(triggers):
            trigger_config = trigger.get('config', {})
            trigger_name = trigger.get('name', f'Trigger {i+1}')
            agent_prompt = trigger_config.get('agent_prompt', '')
            variables = trigger_config.get('trigger_variables', [])

            # If no variables were stored, try to extract them from the prompt
            if not variables and agent_prompt:
                pattern = r'\{\{(\w+)\}\}'
                matches = re.findall(pattern, agent_prompt)
                variables = list(set(matches))

            if variables:
                trigger_key = f"trigger_{i}"
                trigger_variables[trigger_key] = {
                    'trigger_name': trigger_name,
                    'trigger_index': i,
                    'variables': variables,
                    'agent_prompt': agent_prompt
                }

        return trigger_variables

    def _replace_variables_in_text(self, text: str, variable_values: Dict[str, str]) -> str:
        """Replace {{variable}} patterns in text with actual values."""
        for var_name, var_value in variable_values.items():
            pattern = r'\{\{' + re.escape(var_name) + r'\}\}'
            text = re.sub(pattern, var_value, text)
        return text

    async def install_template(self, request: TemplateInstallationRequest) -> TemplateInstallationResult:
        """Install a template as a new agent instance."""
        logger.debug(f"Installing template {request.template_id} for user {request.account_id}")
        logger.debug(f"Initial profile_mappings from request: {request.profile_mappings}")
        logger.debug(f"Initial custom_mcp_configs from request: {request.custom_mcp_configs}")

        template = await self._get_template(request.template_id)
        if not template:
            raise TemplateInstallationError("Template not found")

        await self._validate_access(template, request.account_id)

        all_requirements = list(template.mcp_requirements or [])

        logger.debug(f"Total requirements from template: {[r.qualified_name for r in all_requirements]}")
        logger.debug(f"Request profile_mappings: {request.profile_mappings}")

        if not request.profile_mappings:
            request.profile_mappings = await self._auto_map_profiles(
                all_requirements,
                request.account_id
            )
            logger.debug(f"Auto-mapped profiles: {request.profile_mappings}")

        missing_profiles, missing_configs = await self._validate_installation_requirements(
            all_requirements,
            request.profile_mappings,
            request.custom_mcp_configs
        )

        logger.debug(f"Missing profiles: {[p['qualified_name'] for p in missing_profiles]}")
        logger.debug(f"Missing configs: {[c['qualified_name'] for c in missing_configs]}")

        # Check for trigger variables
        trigger_variables = self._extract_trigger_variables(template.config)
        missing_trigger_variables = {}

        if trigger_variables and not request.trigger_variables:
            # All trigger variables are missing
            missing_trigger_variables = trigger_variables
        elif trigger_variables and request.trigger_variables:
            # Check which trigger variables are still missing
            for trigger_key, trigger_data in trigger_variables.items():
                if trigger_key not in request.trigger_variables:
                    missing_trigger_variables[trigger_key] = trigger_data
                else:
                    # Check if all required variables for this trigger are provided
                    provided_vars = request.trigger_variables.get(trigger_key, {})
                    missing_vars = []
                    for var in trigger_data['variables']:
                        if var not in provided_vars:
                            missing_vars.append(var)
                    if missing_vars:
                        trigger_data['missing_variables'] = missing_vars
                        missing_trigger_variables[trigger_key] = trigger_data

        if missing_profiles or missing_configs or missing_trigger_variables:
            return TemplateInstallationResult(
                status='configs_required',
                missing_regular_credentials=missing_profiles,
                missing_custom_configs=missing_configs,
                missing_trigger_variables=missing_trigger_variables if missing_trigger_variables else None,
                template_info={
                    'template_id': template.template_id,
                    'name': template.name
                }
            )

        agent_config = await self._build_agent_config(
            template,
            request,
            all_requirements
        )

        agent_id = await self._create_agent(
            template,
            request,
            agent_config
        )

        await self._create_initial_version(
            agent_id,
            request.account_id,
            agent_config,
            request.custom_system_prompt or template.system_prompt
        )

        await self._restore_triggers(
            agent_id,
            request.account_id,
            template.config,
            request.profile_mappings,
            request.trigger_configs,
            request.trigger_variables
        )

        await self._convex.increment_template_download_count(template.template_id)

        agent_name = request.instance_name or f"{template.name} (from marketplace)"
        logger.debug(f"Successfully installed template {template.template_id} as agent {agent_id}")

        return TemplateInstallationResult(
            status='installed',
            instance_id=agent_id,
            name=agent_name
        )

    async def _get_template(self, template_id: str) -> Optional[AgentTemplate]:
        """Get template from Convex."""
        from .template_service import get_template_service
        template_service = get_template_service(self._convex)
        return await template_service.get_template(template_id)

    async def _validate_access(self, template: AgentTemplate, user_id: str) -> None:
        """Validate user has access to install this template."""
        if template.creator_id != user_id and not template.is_public:
            raise TemplateInstallationError("Access denied to template")

    async def _auto_map_profiles(
        self,
        requirements: List[MCPRequirementValue],
        account_id: str
    ) -> Dict[QualifiedName, ProfileId]:
        """Auto-map credential profiles for requirements."""
        profile_mappings = {}

        for req in requirements:
            if req.qualified_name.startswith('composio.'):
                continue

            if not req.is_custom():
                # TODO: Implement profile lookup via Convex
                # For now, return empty - profiles need to be manually mapped
                logger.debug(f"Skipping auto-map for {req.qualified_name} - requires manual mapping")
            else:
                logger.debug(f"Skipping custom requirement: {req.qualified_name}")

        return profile_mappings

    async def _validate_installation_requirements(
        self,
        requirements: List[MCPRequirementValue],
        profile_mappings: Optional[Dict[QualifiedName, ProfileId]],
        custom_configs: Optional[Dict[QualifiedName, ConfigType]]
    ) -> tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
        """Validate that all requirements are met for installation."""
        missing_profiles = []
        missing_configs = []

        profile_mappings = profile_mappings or {}
        custom_configs = custom_configs or {}

        for req in requirements:
            if req.is_custom():
                if req.qualified_name not in custom_configs:
                    field_descriptions = {}
                    for field in req.required_config:
                        if field == 'url':
                            field_descriptions[field] = {
                                'type': 'text',
                                'placeholder': 'https://example.com/mcp/endpoint',
                                'description': f'The endpoint URL for the {req.display_name} MCP server'
                            }
                        else:
                            field_descriptions[field] = {
                                'type': 'text',
                                'placeholder': f'Enter {field}',
                                'description': f'Required configuration for {field}'
                            }

                    missing_configs.append({
                        'qualified_name': req.qualified_name,
                        'display_name': req.display_name,
                        'required_config': req.required_config,
                        'custom_type': req.custom_type,
                        'field_descriptions': field_descriptions,
                        'toolkit_slug': req.toolkit_slug,
                        'app_slug': req.app_slug,
                        'source': req.source,
                        'trigger_index': req.trigger_index
                    })
            else:
                if req.source == 'trigger' and req.trigger_index is not None:
                    profile_key = f"{req.qualified_name}_trigger_{req.trigger_index}"
                else:
                    profile_key = req.qualified_name

                if profile_key not in profile_mappings:
                    missing_profiles.append({
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

        return missing_profiles, missing_configs

    async def _build_agent_config(
        self,
        template: AgentTemplate,
        request: TemplateInstallationRequest,
        requirements: List[MCPRequirementValue]
    ) -> Dict[str, Any]:
        """Build the agent configuration from template and request."""
        agentpress_tools = {}
        template_agentpress = template.agentpress_tools or {}
        for tool_name, tool_config in template_agentpress.items():
            if isinstance(tool_config, dict):
                agentpress_tools[tool_name] = tool_config.get('enabled', True)
            else:
                agentpress_tools[tool_name] = tool_config

        agent_config = {
            'tools': {
                'agentpress': agentpress_tools,
                'mcp': [],
                'custom_mcp': []
            },
            'metadata': template.config.get('metadata', {}),
            'system_prompt': request.custom_system_prompt or template.system_prompt,
            'model': template.config.get('model')
        }

        tool_requirements = [req for req in requirements if req.source != 'trigger']

        for req in tool_requirements:
            if req.is_custom():
                config = request.custom_mcp_configs.get(req.qualified_name, {})

                original_name = req.display_name
                if req.qualified_name.startswith('custom_') and '_' in req.qualified_name[7:]:
                    parts = req.qualified_name.split('_', 2)
                    if len(parts) >= 3:
                        original_name = parts[2].replace('_', ' ').title()

                custom_mcp = {
                    'name': original_name,
                    'type': req.custom_type or 'sse',
                    'config': config,
                    'enabledTools': req.enabled_tools
                }
                agent_config['tools']['custom_mcp'].append(custom_mcp)
            else:
                profile_key = req.qualified_name
                profile_id = request.profile_mappings.get(profile_key)

                if profile_id:
                    # TODO: Fetch profile config from Convex
                    # For now, create basic config
                    if req.qualified_name.startswith('composio.') or 'composio' in req.qualified_name:
                        toolkit_slug = req.toolkit_slug
                        if not toolkit_slug:
                            toolkit_slug = req.qualified_name
                            if toolkit_slug.startswith('composio.'):
                                toolkit_slug = toolkit_slug[9:]
                            elif 'composio_' in toolkit_slug:
                                parts = toolkit_slug.split('composio_')
                                toolkit_slug = parts[-1]

                        composio_config = {
                            'name': req.display_name,
                            'type': 'composio',
                            'qualifiedName': req.qualified_name,
                            'toolkit_slug': toolkit_slug,
                            'config': {
                                'profile_id': profile_id
                            },
                            'enabledTools': req.enabled_tools
                        }
                        agent_config['tools']['custom_mcp'].append(composio_config)
                    else:
                        mcp_config = {
                            'name': req.display_name or req.qualified_name,
                            'type': 'sse',
                            'config': {'profile_id': profile_id},
                            'enabledTools': req.enabled_tools
                        }
                        agent_config['tools']['mcp'].append(mcp_config)

        return agent_config

    async def _create_agent(
        self,
        template: AgentTemplate,
        request: TemplateInstallationRequest,
        agent_config: Dict[str, Any]
    ) -> str:
        """Create a new agent from the template."""
        agent_id = str(uuid4())
        agent_name = request.instance_name or f"{template.name} (from marketplace)"

        metadata = {
            **template.metadata,
            'created_from_template': template.template_id,
            'template_name': template.name
        }

        if template.is_kortix_team:
            metadata['is_kortix_team'] = True
            metadata['kortix_template_id'] = template.template_id

        await self._convex.create_agent(
            agent_id=agent_id,
            account_id=request.account_id,
            name=agent_name,
            icon_name=template.icon_name or 'brain',
            icon_color=template.icon_color or '#000000',
            icon_background=template.icon_background or '#F3F4F6',
            metadata=metadata
        )

        logger.debug(f"Created agent {agent_id} from template {template.template_id}, is_kortix_team: {template.is_kortix_team}")
        return agent_id

    async def _create_initial_version(
        self,
        agent_id: str,
        user_id: str,
        agent_config: Dict[str, Any],
        system_prompt: str
    ) -> None:
        """Create the initial version for the new agent."""
        try:
            tools = agent_config.get('tools', {})
            configured_mcps = tools.get('mcp', [])
            custom_mcps = tools.get('custom_mcp', [])
            agentpress_tools = tools.get('agentpress', {})
            model = agent_config.get('model')

            logger.debug(f"Creating initial version for agent {agent_id} with system_prompt: {system_prompt[:100]}...")
            logger.debug(f"Agent config tools: agentpress={len(agentpress_tools)}, mcp={len(configured_mcps)}, custom_mcp={len(custom_mcps)}")

            # Create version via Convex
            version_id = str(uuid4())
            await self._convex.update_agent(
                agent_id=agent_id,
                system_prompt=system_prompt,
                configured_mcps=configured_mcps,
                custom_mcps=custom_mcps,
                agentpress_tools=list(agentpress_tools.keys()),
                metadata={
                    'version_id': version_id,
                    'version_name': 'v1',
                    'change_description': 'Initial version from template'
                }
            )

            logger.info(f"Successfully created initial version {version_id} for agent {agent_id}")

        except Exception as e:
            logger.error(f"Failed to create initial version for agent {agent_id}: {e}")
            raise

    async def _restore_triggers(
        self,
        agent_id: str,
        account_id: str,
        config: Dict[str, Any],
        profile_mappings: Optional[Dict[str, str]] = None,
        trigger_configs: Optional[Dict[str, Dict[str, Any]]] = None,
        trigger_variables: Optional[Dict[str, Dict[str, str]]] = None
    ) -> None:
        """Restore triggers from template to the new agent."""
        triggers = config.get('triggers', [])
        if not triggers:
            logger.debug(f"No triggers to restore for agent {agent_id}")
            return

        created_count = 0
        failed_count = 0

        for i, trigger in enumerate(triggers):
            trigger_config = trigger.get('config', {})
            provider_id = trigger_config.get('provider_id', '')

            # Handle trigger variables if any
            trigger_key = f"trigger_{i}"
            agent_prompt = trigger_config.get('agent_prompt', '')

            if trigger_variables and trigger_key in trigger_variables and agent_prompt:
                # Replace variables in the agent prompt
                variable_values = trigger_variables[trigger_key]
                agent_prompt = self._replace_variables_in_text(agent_prompt, variable_values)
                trigger_config['agent_prompt'] = agent_prompt
                logger.debug(f"Replaced variables in trigger {i} prompt: {variable_values}")

            if provider_id == 'composio':
                qualified_name = trigger_config.get('qualified_name')

                trigger_profile_key = f"{qualified_name}_trigger_{i}"

                trigger_specific_config = {}
                if trigger_configs and trigger_profile_key in trigger_configs:
                    trigger_specific_config = trigger_configs[trigger_profile_key].copy()
                    logger.info(f"Using user-provided trigger config for {trigger_profile_key}: {trigger_specific_config}")
                else:
                    logger.info(f"No user trigger config found for key {trigger_profile_key}. Available keys: {list(trigger_configs.keys()) if trigger_configs else 'None'}")

                metadata_fields = {
                    'provider_id', 'qualified_name', 'trigger_slug',
                    'agent_prompt', 'profile_id', 'composio_trigger_id',
                    'trigger_fields'
                }

                for key, value in trigger_config.items():
                    if key not in metadata_fields and key not in trigger_specific_config:
                        trigger_specific_config[key] = value

                success = await self._create_composio_trigger(
                    agent_id=agent_id,
                    account_id=account_id,
                    trigger_name=trigger.get('name', 'Unnamed Trigger'),
                    trigger_description=trigger.get('description'),
                    is_active=trigger.get('is_active', True),
                    trigger_slug=trigger_config.get('trigger_slug', ''),
                    qualified_name=qualified_name,
                    agent_prompt=agent_prompt,
                    profile_mappings=profile_mappings,
                    trigger_profile_key=trigger_profile_key,
                    trigger_specific_config=trigger_specific_config
                )

                if success:
                    created_count += 1
                else:
                    failed_count += 1
            else:
                # For schedule triggers, clean up trigger_variables if they exist
                clean_config = trigger_config.copy()
                if 'trigger_variables' in clean_config:
                    del clean_config['trigger_variables']

                trigger_id = str(uuid4())
                try:
                    await self._convex.create_trigger(
                        trigger_id=trigger_id,
                        agent_id=agent_id,
                        trigger_type=trigger.get('trigger_type', 'webhook'),
                        name=trigger.get('name', 'Unnamed Trigger'),
                        description=trigger.get('description'),
                        is_active=trigger.get('is_active', True),
                        config=clean_config
                    )
                    created_count += 1
                    logger.debug(f"Restored trigger '{trigger.get('name')}' for agent {agent_id}")
                except Exception as e:
                    failed_count += 1
                    logger.warning(f"Failed to create trigger '{trigger.get('name')}' for agent {agent_id}: {e}")

        logger.debug(f"Successfully restored {created_count}/{len(triggers)} triggers for agent {agent_id}")

    async def _create_composio_trigger(
        self,
        agent_id: str,
        account_id: str,
        trigger_name: str,
        trigger_description: Optional[str],
        is_active: bool,
        trigger_slug: str,
        qualified_name: Optional[str],
        agent_prompt: Optional[str],
        profile_mappings: Dict[str, str],
        trigger_profile_key: Optional[str] = None,
        trigger_specific_config: Optional[Dict[str, Any]] = None
    ) -> bool:
        """Create a Composio trigger for the agent."""
        try:
            if not trigger_slug:
                return False

            if not qualified_name:
                app_name = trigger_slug.split('_')[0].lower() if '_' in trigger_slug else 'composio'
                qualified_name = f'composio.{app_name}'
            else:
                if qualified_name.startswith('composio.'):
                    app_name = qualified_name.split('.', 1)[1]
                else:
                    app_name = 'composio'

            profile_id = None
            keys_to_check = []

            if trigger_profile_key:
                keys_to_check.append(trigger_profile_key)

            keys_to_check.extend([
                qualified_name,
                f'composio.{app_name}',
                'composio'
            ])

            for key in keys_to_check:
                if key in profile_mappings:
                    profile_id = profile_mappings[key]
                    break

            if not profile_id:
                logger.warning(f"No profile found for {qualified_name} or composio")
                return False

            # Get Composio profile config
            # TODO: Implement profile config lookup via Convex
            composio_user_id = None
            connected_account_id = None

            api_key = os.getenv("COMPOSIO_API_KEY")
            if not api_key:
                logger.warning("COMPOSIO_API_KEY not configured; skipping Composio trigger upsert")
                return False

            api_base = os.getenv("COMPOSIO_API_BASE", "https://backend.composio.dev").rstrip("/")
            url = f"{api_base}/api/v3/trigger_instances/{trigger_slug}/upsert"
            headers = {"x-api-key": api_key, "Content-Type": "application/json"}

            secret = os.getenv("COMPOSIO_WEBHOOK_SECRET", "")
            webhook_headers: Dict[str, Any] = {"X-Composio-Secret": secret} if secret else {}
            vercel_bypass = os.getenv("VERCEL_PROTECTION_BYPASS_KEY", "")
            if vercel_bypass:
                webhook_headers["X-Vercel-Protection-Bypass"] = vercel_bypass

            logger.info(f"Creating trigger {trigger_slug} with config: {trigger_specific_config}")

            body = {
                "user_id": composio_user_id,
                "trigger_config": trigger_specific_config or {},
            }

            if connected_account_id:
                body["connected_account_id"] = connected_account_id
                logger.debug(f"Adding connected_account_id to Composio trigger request: {connected_account_id}")
            else:
                logger.warning("No connected_account_id found - trigger creation may fail for OAuth apps")

            logger.debug(f"Creating Composio trigger with URL: {url}")
            logger.debug(f"Request body: {json.dumps(body, indent=2)}")

            async with get_http_client() as http_client:
                resp = await http_client.post(url, headers=headers, json=body, timeout=20.0)

                if resp.status_code != 200:
                    logger.error(f"Composio API error response: {resp.status_code} - {resp.text}")

                resp.raise_for_status()
                created = resp.json()

            def _extract_id(obj: Dict[str, Any]) -> Optional[str]:
                if not isinstance(obj, dict):
                    return None
                cand = (
                    obj.get("id")
                    or obj.get("trigger_id")
                    or obj.get("triggerId")
                    or obj.get("nano_id")
                    or obj.get("nanoId")
                    or obj.get("triggerNanoId")
                )
                if cand:
                    return cand
                for k in ("trigger", "trigger_instance", "triggerInstance", "data", "result"):
                    nested = obj.get(k)
                    if isinstance(nested, dict):
                        nid = _extract_id(nested)
                        if nid:
                            return nid
                    if isinstance(nested, list) and nested:
                        nid = _extract_id(nested[0])
                        if nid:
                            return nid
                return None

            composio_trigger_id = _extract_id(created) if isinstance(created, dict) else None
            if not composio_trigger_id:
                logger.warning("Failed to extract Composio trigger id; skipping")
                return False

            trigger_id = str(uuid4())
            config: Dict[str, Any] = {
                "composio_trigger_id": composio_trigger_id,
                "trigger_slug": trigger_slug,
                "qualified_name": qualified_name,
                "profile_id": profile_id,
                "provider_id": "composio"
            }

            if trigger_specific_config:
                config.update(trigger_specific_config)

            if agent_prompt:
                config["agent_prompt"] = agent_prompt

            await self._convex.create_trigger(
                trigger_id=trigger_id,
                agent_id=agent_id,
                trigger_type='composio',
                name=trigger_name,
                description=trigger_description,
                is_active=is_active,
                config=config
            )
            return True
        except Exception as e:
            logger.error(f"Failed to create Composio trigger during installation: {e}")
            return False


def get_installation_service(convex_client: ConvexClient = None) -> InstallationService:
    """Get an InstallationService instance."""
    return InstallationService(convex_client)
