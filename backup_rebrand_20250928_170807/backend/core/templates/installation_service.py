from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Dict, List, Any, Optional
from uuid import uuid4
import os
import httpx

from core.services.supabase import DBConnection
from core.utils.logger import logger
from .template_service import AgentTemplate, MCPRequirementValue, ConfigType, ProfileId, QualifiedName
from core.triggers.api import sync_triggers_to_version_config

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

@dataclass
class TemplateInstallationResult:
    status: str
    instance_id: Optional[str] = None
    name: Optional[str] = None
    missing_regular_credentials: List[Dict[str, Any]] = field(default_factory=list)
    missing_custom_configs: List[Dict[str, Any]] = field(default_factory=list)
    template_info: Optional[Dict[str, Any]] = None

class TemplateInstallationError(Exception):
    pass

class InvalidCredentialError(Exception):
    pass

class InstallationService:
    def __init__(self, db_connection: DBConnection):
        self._db = db_connection
    
    async def install_template(self, request: TemplateInstallationRequest) -> TemplateInstallationResult:
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
        
        if missing_profiles or missing_configs:
            return TemplateInstallationResult(
                status='configs_required',
                missing_regular_credentials=missing_profiles,
                missing_custom_configs=missing_configs,
                template_info={
                    'template_id': template.template_id,
                    'name': template.name,
                    'description': template.description
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
        
        await self._restore_workflows(agent_id, template.config) 
        await self._restore_triggers(agent_id, request.account_id, template.config, request.profile_mappings)
        
        await self._increment_download_count(template.template_id)
        
        agent_name = request.instance_name or f"{template.name} (from marketplace)"
        logger.debug(f"Successfully installed template {template.template_id} as agent {agent_id}")
        
        return TemplateInstallationResult(
            status='installed',
            instance_id=agent_id,
            name=agent_name
        )
    
    async def _get_template(self, template_id: str) -> Optional[AgentTemplate]:
        from .template_service import get_template_service
        template_service = get_template_service(self._db)
        return await template_service.get_template(template_id)
    
    async def _validate_access(self, template: AgentTemplate, user_id: str) -> None:
        if template.creator_id != user_id and not template.is_public:
            raise TemplateInstallationError("Access denied to template")
    
    async def _auto_map_profiles(
        self,
        requirements: List[MCPRequirementValue],
        account_id: str
    ) -> Dict[QualifiedName, ProfileId]:
        profile_mappings = {}
        
        for req in requirements:
            if req.qualified_name.startswith('composio.'):
                continue
                
            if not req.is_custom():
                from core.credentials import get_profile_service
                profile_service = get_profile_service(self._db)
                default_profile = await profile_service.get_default_profile(
                    account_id, req.qualified_name
                )
                
                if default_profile:
                    if req.source == 'trigger' and req.trigger_index is not None:
                        trigger_key = f"{req.qualified_name}_trigger_{req.trigger_index}"
                        profile_mappings[trigger_key] = default_profile.profile_id
                        logger.debug(f"Auto-mapped {trigger_key} to profile {default_profile.profile_id} (trigger)")
                    else:
                        profile_mappings[req.qualified_name] = default_profile.profile_id
                        logger.debug(f"Auto-mapped {req.qualified_name} to profile {default_profile.profile_id}")
            else:
                logger.debug(f"Skipping custom requirement: {req.qualified_name}")
        
        return profile_mappings
    
    async def _validate_installation_requirements(
        self,
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
        
        from core.credentials import get_profile_service
        profile_service = get_profile_service(self._db)
        
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
                    profile = await profile_service.get_profile(request.account_id, profile_id)
                    if profile:
                        if req.qualified_name.startswith('pipedream:'):
                            app_slug = req.app_slug or profile.config.get('app_slug')
                            if not app_slug:
                                app_slug = req.qualified_name.split(':')[1] if ':' in req.qualified_name else req.display_name.lower()
                            
                            pipedream_config = {
                                'url': 'https://remote.mcp.pipedream.net',
                                'headers': {
                                    'x-pd-app-slug': app_slug
                                },
                                'profile_id': profile_id
                            }
                            
                            mcp_config = {
                                'name': req.display_name,
                                'type': 'pipedream',
                                'config': pipedream_config,
                                'enabledTools': req.enabled_tools
                            }
                            agent_config['tools']['custom_mcp'].append(mcp_config)
                            
                        elif req.qualified_name.startswith('composio.') or 'composio' in req.qualified_name:
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
                                'config': profile.config,
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
        agent_id = str(uuid4())
        agent_name = request.instance_name or f"{template.name} (from marketplace)"
        
        client = await self._db.client
        
        metadata = {
            **template.metadata,
            'created_from_template': template.template_id,
            'template_name': template.name
        }
        
        if template.is_kortix_team:
            metadata['is_kortix_team'] = True
            metadata['kortix_template_id'] = template.template_id
        
        agent_data = {
            'agent_id': agent_id,
            'account_id': request.account_id,
            'name': agent_name,
            'description': template.description,
            'icon_name': template.icon_name or 'brain',
            'icon_color': template.icon_color or '#000000',
            'icon_background': template.icon_background or '#F3F4F6',
            'metadata': metadata,
            'created_at': datetime.now(timezone.utc).isoformat(),
            'updated_at': datetime.now(timezone.utc).isoformat()
        }
        
        await client.table('agents').insert(agent_data).execute()
        
        logger.debug(f"Created agent {agent_id} from template {template.template_id}, is_kortix_team: {template.is_kortix_team}")
        return agent_id
    
    async def _create_initial_version(
        self,
        agent_id: str,
        user_id: str,
        agent_config: Dict[str, Any],
        system_prompt: str
    ) -> None:
        try:
            tools = agent_config.get('tools', {})
            configured_mcps = tools.get('mcp', [])
            custom_mcps = tools.get('custom_mcp', [])
            agentpress_tools = tools.get('agentpress', {})
            model = agent_config.get('model')
            
            logger.debug(f"Creating initial version for agent {agent_id} with system_prompt: {system_prompt[:100]}...")
            logger.debug(f"Agent config tools: agentpress={len(agentpress_tools)}, mcp={len(configured_mcps)}, custom_mcp={len(custom_mcps)}")
            
            from core.versioning.version_service import get_version_service
            version_service = await get_version_service()
            version = await version_service.create_version(
                agent_id=agent_id,
                user_id=user_id,
                system_prompt=system_prompt,
                model=model,
                configured_mcps=configured_mcps,
                custom_mcps=custom_mcps,
                agentpress_tools=agentpress_tools,
                version_name="v1",
                change_description="Initial version from template"
            )
            
            logger.info(f"Successfully created initial version {version.version_id} for agent {agent_id}")
            
            # Verify the agent was updated with current_version_id
            client = await self._db.client
            agent_check = await client.table('agents').select('current_version_id').eq('agent_id', agent_id).execute()
            if agent_check.data and agent_check.data[0].get('current_version_id'):
                logger.debug(f"Agent {agent_id} current_version_id updated to: {agent_check.data[0]['current_version_id']}")
            else:
                logger.error(f"Agent {agent_id} current_version_id was not updated after version creation!")
            
        except Exception as e:
            logger.error(f"Failed to create initial version for agent {agent_id}: {e}", exc_info=True)
            raise  # Re-raise the exception to ensure installation fails if version creation fails
    
    async def _restore_workflows(self, agent_id: str, template_config: Dict[str, Any]) -> None:
        workflows = template_config.get('workflows', [])
        if not workflows:
            logger.debug(f"No workflows to restore for agent {agent_id}")
            return
            
        client = await self._db.client
        restored_count = 0
        
        for workflow in workflows:
            try:
                steps = workflow.get('steps', [])
                if steps:
                    steps = self._regenerate_step_ids(steps)

                workflow_data = {
                    'id': str(uuid4()),
                    'agent_id': agent_id,
                    'name': workflow.get('name', 'Untitled Workflow'),
                    'description': workflow.get('description'),
                    'status': workflow.get('status', 'draft'),
                    'trigger_phrase': workflow.get('trigger_phrase'),
                    'is_default': workflow.get('is_default', False),
                    'steps': steps,
                    'created_at': datetime.now(timezone.utc).isoformat(),
                    'updated_at': datetime.now(timezone.utc).isoformat()
                }
                
                result = await client.table('agent_workflows').insert(workflow_data).execute()
                if result.data:
                    restored_count += 1
                    logger.debug(f"Restored workflow '{workflow_data['name']}' for agent {agent_id}")
                else:
                    logger.warning(f"Failed to insert workflow '{workflow_data['name']}' for agent {agent_id}")
                    
            except Exception as e:
                logger.error(f"Failed to restore workflow '{workflow.get('name', 'Unknown')}' for agent {agent_id}: {e}")
        
        logger.debug(f"Successfully restored {restored_count}/{len(workflows)} workflows for agent {agent_id}")

        if restored_count > 0:
            await self._sync_workflows_to_version_config(agent_id)
    
    async def _sync_workflows_to_version_config(self, agent_id: str) -> None:
        try:
            client = await self._db.client
            
            agent_result = await client.table('agents').select('current_version_id').eq('agent_id', agent_id).single().execute()
            if not agent_result.data or not agent_result.data.get('current_version_id'):
                logger.warning(f"No current version found for agent {agent_id}")
                return
            
            current_version_id = agent_result.data['current_version_id']
            
            workflows_result = await client.table('agent_workflows').select('*').eq('agent_id', agent_id).execute()
            workflows = workflows_result.data if workflows_result.data else []
            
            version_result = await client.table('agent_versions').select('config').eq('version_id', current_version_id).single().execute()
            if not version_result.data:
                logger.warning(f"Version {current_version_id} not found")
                return
            
            config = version_result.data.get('config', {})
            
            config['workflows'] = workflows
            
            await client.table('agent_versions').update({'config': config}).eq('version_id', current_version_id).execute()
            logger.debug(f"Synced {len(workflows)} workflows to version config for agent {agent_id}")
            
        except Exception as e:
            logger.error(f"Failed to sync workflows to version config for agent {agent_id}: {e}")
    
    def _regenerate_step_ids(self, steps: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        if not steps:
            return []
        
        new_steps = []
        id_mapping = {}
        
        for step in steps:
            if not isinstance(step, dict):
                continue
                
            old_id = step.get('id')
            if old_id:
                if old_id not in id_mapping:
                    id_mapping[old_id] = f"step-{str(uuid4())[:8]}"
                new_id = id_mapping[old_id]
            else:
                new_id = f"step-{str(uuid4())[:8]}"
            
            new_step = {
                'id': new_id,
                'name': step.get('name', ''),
                'description': step.get('description', ''),
                'type': step.get('type', 'instruction'),
                'config': step.get('config', {}),
                'order': step.get('order', 0)
            }
            
            if 'conditions' in step:
                new_step['conditions'] = step['conditions']
            
            if 'children' in step and isinstance(step['children'], list):
                new_step['children'] = self._regenerate_step_ids(step['children'])
            else:
                new_step['children'] = []
            
            new_steps.append(new_step)
        
        return new_steps
    
    async def _restore_triggers(
        self,
        agent_id: str,
        account_id: str,
        config: Dict[str, Any],
        profile_mappings: Optional[Dict[str, str]] = None
    ) -> None:
        triggers = config.get('triggers', [])
        if not triggers:
            logger.debug(f"No triggers to restore for agent {agent_id}")
            return
        
        client = await self._db.client
        workflow_name_to_id = {}
        workflows_result = await client.table('agent_workflows').select('id, name').eq('agent_id', agent_id).execute()
        if workflows_result.data:
            for workflow in workflows_result.data:
                workflow_name_to_id[workflow['name']] = workflow['id']
        
        created_count = 0
        failed_count = 0
        
        for i, trigger in enumerate(triggers):
            trigger_config = trigger.get('config', {})
            provider_id = trigger_config.get('provider_id', '')
            
            workflow_id = None
            if trigger_config.get('execution_type') == 'workflow':
                existing_workflow_id = trigger_config.get('workflow_id')
                if existing_workflow_id:
                    workflow_id = existing_workflow_id
                    logger.debug(f"Using existing workflow_id {workflow_id} for trigger '{trigger.get('name')}'")
                else:
                    workflow_name = trigger_config.get('workflow_name')
                    if workflow_name and workflow_name in workflow_name_to_id:
                        workflow_id = workflow_name_to_id[workflow_name]
                        logger.debug(f"Resolved workflow_name '{workflow_name}' to workflow_id {workflow_id} for trigger '{trigger.get('name')}'")
                    elif workflow_name:
                        logger.warning(f"Workflow '{workflow_name}' not found for trigger '{trigger.get('name')}'")
                    else:
                        logger.warning(f"No workflow_name or workflow_id specified for workflow execution trigger '{trigger.get('name')}'")
            
            if provider_id == 'composio':
                qualified_name = trigger_config.get('qualified_name')
                
                trigger_profile_key = f"{qualified_name}_trigger_{i}"
                
                success = await self._create_composio_trigger(
                    agent_id=agent_id,
                    account_id=account_id,
                    trigger_name=trigger.get('name', 'Unnamed Trigger'),
                    trigger_description=trigger.get('description'),
                    is_active=trigger.get('is_active', True),
                    trigger_slug=trigger_config.get('trigger_slug', ''),
                    qualified_name=qualified_name,
                    execution_type=trigger_config.get('execution_type', 'agent'),
                    agent_prompt=trigger_config.get('agent_prompt'),
                    workflow_id=workflow_id,
                    workflow_input=trigger_config.get('workflow_input'),
                    profile_mappings=profile_mappings,
                    trigger_profile_key=trigger_profile_key
                )
                
                if success:
                    created_count += 1
                else:
                    failed_count += 1
            else:
                updated_trigger_config = trigger_config.copy()
                if workflow_id:
                    updated_trigger_config['workflow_id'] = workflow_id
                
                execution_type = trigger_config.get('execution_type', 'agent')
                trigger_workflow_id = workflow_id if execution_type == 'workflow' else None
                
                trigger_data = {
                    'trigger_id': str(uuid4()),
                    'agent_id': agent_id,
                    'trigger_type': trigger.get('trigger_type', 'webhook'),
                    'name': trigger.get('name', 'Unnamed Trigger'),
                    'description': trigger.get('description'),
                    'is_active': trigger.get('is_active', True),
                    'config': updated_trigger_config,
                    'workflow_id': trigger_workflow_id,
                    'execution_type': execution_type,
                    'created_at': datetime.now(timezone.utc).isoformat(),
                    'updated_at': datetime.now(timezone.utc).isoformat()
                }
                result = await client.table('agent_triggers').insert(trigger_data).execute()
                if result.data:
                    created_count += 1
                    logger.debug(f"Restored trigger '{trigger_data['name']}' with workflow_id {trigger_workflow_id} for agent {agent_id}")
                else:
                    failed_count += 1
                    logger.warning(f"Failed to insert trigger '{trigger.get('name')}' for agent {agent_id}")
        
        logger.debug(f"Successfully restored {created_count}/{len(triggers)} triggers for agent {agent_id}")
        
        if created_count > 0:
            await self._sync_triggers_to_version_config(agent_id)
    
    async def _sync_triggers_to_version_config(self, agent_id: str) -> None:
        try:
            client = await self._db.client
            
            agent_result = await client.table('agents').select('current_version_id').eq('agent_id', agent_id).single().execute()
            if not agent_result.data or not agent_result.data.get('current_version_id'):
                logger.warning(f"No current version found for agent {agent_id}")
                return
            
            current_version_id = agent_result.data['current_version_id']
            
            triggers_result = await client.table('agent_triggers').select('*').eq('agent_id', agent_id).execute()
            triggers = []
            if triggers_result.data:
                import json
                for trigger in triggers_result.data:
                    trigger_copy = trigger.copy()
                    if 'config' in trigger_copy and isinstance(trigger_copy['config'], str):
                        try:
                            trigger_copy['config'] = json.loads(trigger_copy['config'])
                        except json.JSONDecodeError:
                            logger.warning(f"Failed to parse trigger config for {trigger_copy.get('trigger_id')}")
                            trigger_copy['config'] = {}
                    triggers.append(trigger_copy)
            
            version_result = await client.table('agent_versions').select('config').eq('version_id', current_version_id).single().execute()
            if not version_result.data:
                logger.warning(f"Version {current_version_id} not found")
                return
            
            config = version_result.data.get('config', {})
            
            config['triggers'] = triggers
            
            await client.table('agent_versions').update({'config': config}).eq('version_id', current_version_id).execute()
            
            logger.debug(f"Synced {len(triggers)} triggers to version config for agent {agent_id}")
            
        except Exception as e:
            logger.error(f"Failed to sync triggers to version config for agent {agent_id}: {e}")

    async def _create_composio_trigger(
        self,
        agent_id: str,
        account_id: str,
        trigger_name: str,
        trigger_description: Optional[str],
        is_active: bool,
        trigger_slug: str,
        qualified_name: Optional[str],
        execution_type: str,
        agent_prompt: Optional[str],
        workflow_id: Optional[str],
        workflow_input: Optional[Dict[str, Any]],
        profile_mappings: Dict[str, str],
        trigger_profile_key: Optional[str] = None
    ) -> bool:
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
                from core.credentials import get_profile_service
                profile_service = get_profile_service(self._db)
                default_profile = await profile_service.get_default_profile(account_id, qualified_name)
                if not default_profile:
                    default_profile = await profile_service.get_default_profile(account_id, 'composio')
                if default_profile:
                    profile_id = default_profile.profile_id
                else:
                    logger.warning(f"No default profile found for {qualified_name} or composio")
            
            if not profile_id:
                return False

            from core.composio_integration.composio_profile_service import ComposioProfileService
            profile_service = ComposioProfileService(self._db)
            profile_config = await profile_service.get_profile_config(profile_id)
            composio_user_id = profile_config.get('user_id')
            if not composio_user_id:
                return False
            
            connected_account_id = profile_config.get('connected_account_id')

            api_key = os.getenv("COMPOSIO_API_KEY")
            if not api_key:
                logger.warning("COMPOSIO_API_KEY not configured; skipping Composio trigger upsert")
                return False

            api_base = os.getenv("COMPOSIO_API_BASE", "https://backend.composio.dev").rstrip("/")
            url = f"{api_base}/api/v3/trigger_instances/{trigger_slug}/upsert"
            headers = {"x-api-key": api_key, "Content-Type": "application/json"}

            base_url = os.getenv("WEBHOOK_BASE_URL", "http://localhost:8000")
            secret = os.getenv("COMPOSIO_WEBHOOK_SECRET", "")
            webhook_headers: Dict[str, Any] = {"X-Composio-Secret": secret} if secret else {}
            vercel_bypass = os.getenv("VERCEL_PROTECTION_BYPASS_KEY", "")
            if vercel_bypass:
                webhook_headers["X-Vercel-Protection-Bypass"] = vercel_bypass

            body = {
                "user_id": composio_user_id,
                "userId": composio_user_id,
                "trigger_config": {},
                "triggerConfig": {},
                "webhook": {
                    "url": f"{base_url}/api/composio/webhook",
                    "headers": webhook_headers,
                    "method": "POST",
                },
            }

            if connected_account_id:
                body["connectedAccountId"] = connected_account_id
                body["connected_account_id"] = connected_account_id
                body["connectedAccountIds"] = [connected_account_id]
                body["connected_account_ids"] = [connected_account_id]
                logger.debug(f"Adding connected_account_id to Composio trigger request: {connected_account_id}")
            else:
                logger.warning("No connected_account_id found - trigger creation may fail for OAuth apps")
            
            logger.debug(f"Creating Composio trigger with URL: {url}")
            async with httpx.AsyncClient(timeout=20) as http_client:
                resp = await http_client.post(url, headers=headers, json=body)
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

            from core.triggers.trigger_service import get_trigger_service
            trigger_service = get_trigger_service(self._db)
            config: Dict[str, Any] = {
                "composio_trigger_id": composio_trigger_id,
                "trigger_slug": trigger_slug,
                "execution_type": execution_type,
                "qualified_name": qualified_name,
                "profile_id": profile_id,
                "provider_id": "composio"
            }
            if execution_type == "agent" and agent_prompt:
                config["agent_prompt"] = agent_prompt
            if execution_type == "workflow" and workflow_id:
                config["workflow_id"] = workflow_id
                if workflow_input:
                    config["workflow_input"] = workflow_input

            await trigger_service.create_trigger(
                agent_id=agent_id,
                provider_id="composio",
                name=trigger_name,
                config=config,
                description=trigger_description,
            )
            return True
        except httpx.HTTPError as e:
            logger.error(f"Composio trigger upsert failed during installation: {e}")
            return False
        except Exception as e:
            logger.error(f"Failed to create Composio trigger during installation: {e}")
            return False
    
    async def _increment_download_count(self, template_id: str) -> None:
        client = await self._db.client
        try:
            await client.rpc('increment_template_download_count', {
                'template_id_param': template_id
            }).execute()
        except Exception as e:
            logger.warning(f"Failed to increment download count for template {template_id}: {e}")

def get_installation_service(db_connection: DBConnection) -> InstallationService:
    return InstallationService(db_connection) 