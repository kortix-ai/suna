from datetime import datetime, timezone
from typing import Optional, Dict, List, Any
from fastapi import APIRouter, HTTPException, Depends
from uuid import uuid4

from core.utils.auth_utils import verify_and_get_user_id_from_jwt
from core.utils.logger import logger
from core.templates.template_service import MCPRequirementValue, ConfigType, ProfileId, QualifiedName

from .api_models import JsonAnalysisRequest, JsonAnalysisResponse, JsonImportRequestModel, JsonImportResponse
from . import core_utils as utils

router = APIRouter()

class JsonImportError(Exception):
    pass

class JsonImportService:
    def __init__(self, db_connection):
        self._db = db_connection
    
    async def analyze_json(self, json_data: Dict[str, Any], account_id: str) -> JsonAnalysisResponse:
        logger.debug(f"Analyzing imported JSON for user {account_id}")
        
        mcp_requirements = self._extract_mcp_requirements_from_json(json_data)
        
        missing_profiles, missing_configs = await self._validate_requirements(
            mcp_requirements, 
            account_id,
            profile_mappings=None,
            custom_configs=None
        )
        
        agent_info = {
            'name': json_data.get('name', 'Imported Agent'),
            'description': json_data.get('description', ''),
            'profile_image_url': json_data.get('profile_image_url') or json_data.get('metadata', {}).get('profile_image_url'),
            'icon_name': json_data.get('icon_name', 'brain'),
            'icon_color': json_data.get('icon_color', '#000000'),
            'icon_background': json_data.get('icon_background', '#F3F4F6')
        }
        
        return JsonAnalysisResponse(
            requires_setup=bool(missing_profiles or missing_configs),
            missing_regular_credentials=missing_profiles,
            missing_custom_configs=missing_configs,
            agent_info=agent_info
        )
    
    async def import_json(self, request: JsonImportRequestModel, account_id: str) -> JsonImportResponse:
        logger.debug(f"Importing agent from JSON for user {account_id}")
        
        json_data = request.json_data
        
        if not self._validate_json_structure(json_data):
            raise JsonImportError("Invalid JSON structure")
        
        mcp_requirements = self._extract_mcp_requirements_from_json(json_data)
        
        missing_profiles, missing_configs = await self._validate_requirements(
            mcp_requirements,
            account_id,
            request.profile_mappings,
            request.custom_mcp_configs
        )
        
        if missing_profiles or missing_configs:
            return JsonImportResponse(
                status='configs_required',
                missing_regular_credentials=missing_profiles,
                missing_custom_configs=missing_configs,
                agent_info={
                    'name': json_data.get('name', 'Imported Agent'),
                    'description': json_data.get('description', ''),
                    'profile_image_url': json_data.get('profile_image_url') or json_data.get('metadata', {}).get('profile_image_url'),
                    'icon_name': json_data.get('icon_name', 'brain'),
                    'icon_color': json_data.get('icon_color', '#000000'),
                    'icon_background': json_data.get('icon_background', '#F3F4F6')
                }
            )
        
        agent_config = await self._build_agent_config_from_json(
            json_data,
            request,
            account_id,
            mcp_requirements
        )
        
        agent_id = await self._create_agent_from_json(
            json_data,
            request,
            account_id,
            agent_config
        )
        
        await self._create_initial_version(
            agent_id,
            account_id,
            agent_config,
            request.custom_system_prompt or json_data.get('system_prompt', '')
        )
        
        from core.utils.cache import Cache
        await Cache.invalidate(f"agent_count_limit:{account_id}")
        
        logger.debug(f"Successfully imported agent {agent_id} from JSON")
        
        return JsonImportResponse(
            status='success',
            instance_id=agent_id,
            name=request.instance_name or json_data.get('name', 'Imported Agent')
        )
    
    def _validate_json_structure(self, json_data: Dict[str, Any]) -> bool:
        required_fields = ['tools', 'system_prompt']
        for field in required_fields:
            if field not in json_data:
                logger.error(f"Missing required field: {field}")
                return False
        
        tools = json_data.get('tools', {})
        if not isinstance(tools, dict):
            logger.error("tools field must be a dictionary")
            return False
        
        return True
    
    def _extract_mcp_requirements_from_json(self, json_data: Dict[str, Any]) -> List[MCPRequirementValue]:
        requirements = []
        
        tools = json_data.get('tools', {})

        mcps = tools.get('mcp', [])
        for mcp in mcps:
            if isinstance(mcp, dict):
                req = MCPRequirementValue(
                    qualified_name=mcp.get('qualifiedName', ''),
                    display_name=mcp.get('name', ''),
                    enabled_tools=mcp.get('enabledTools', []),
                    custom_type=None,
                    toolkit_slug=None,
                    app_slug=None
                )
                requirements.append(req)
        
        custom_mcps = tools.get('custom_mcp', [])
        for mcp in custom_mcps:
            if isinstance(mcp, dict):
                mcp_type = mcp.get('type', 'sse')
                
                if mcp_type == 'composio':
                    req = MCPRequirementValue(
                        qualified_name=mcp.get('mcp_qualified_name', ''),
                        display_name=mcp.get('display_name') or mcp.get('name', ''),
                        enabled_tools=mcp.get('enabledTools', []),
                        custom_type='composio',
                        toolkit_slug=mcp.get('toolkit_slug'),
                        app_slug=mcp.get('toolkit_slug')
                    )
                    requirements.append(req)
                
                else:
                    req = MCPRequirementValue(
                        qualified_name=mcp.get('qualifiedName', ''),
                        display_name=mcp.get('display_name') or mcp.get('name', ''),
                        enabled_tools=mcp.get('enabledTools', []),
                        custom_type=mcp_type,
                        toolkit_slug=None,
                        app_slug=None
                    )
                    requirements.append(req)
        
        return requirements
    
    async def _validate_requirements(
        self,
        requirements: List[MCPRequirementValue],
        account_id: str,
        profile_mappings: Optional[Dict[str, str]],
        custom_configs: Optional[Dict[str, Dict[str, Any]]]
    ) -> tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
        
        missing_profiles = []
        missing_configs = []
        
        from core.templates.installation_service import InstallationService
        installation_service = InstallationService(self._db)
        
        return await installation_service._validate_installation_requirements(
            requirements,
            profile_mappings,
            custom_configs
        )
    
    async def _build_agent_config_from_json(
        self,
        json_data: Dict[str, Any],
        request: JsonImportRequestModel,
        account_id: str,
        requirements: List[MCPRequirementValue]
    ) -> Dict[str, Any]:
        
        tools = json_data.get('tools', {})
        
        agentpress_tools = {}
        json_agentpress = tools.get('agentpress', {})
        for tool_name, tool_config in json_agentpress.items():
            if isinstance(tool_config, dict):
                agentpress_tools[tool_name] = tool_config.get('enabled', True)
            else:
                agentpress_tools[tool_name] = bool(tool_config)
        
        agent_config = {
            'tools': {
                'agentpress': agentpress_tools,
                'mcp': [],
                'custom_mcp': []
            },
            'metadata': json_data.get('metadata', {}),
            'system_prompt': request.custom_system_prompt or json_data.get('system_prompt', '')
        }
        
        from core.credentials import get_profile_service
        profile_service = get_profile_service(self._db)
        
        for req in requirements:
            if req.custom_type == 'composio':
                profile_id = request.profile_mappings.get(req.qualified_name) if request.profile_mappings else None
                if profile_id:
                    from core.composio_integration.composio_profile_service import ComposioProfileService
                    composio_service = ComposioProfileService(self._db)
                    mcp_config = await composio_service.get_mcp_config_for_agent(profile_id)
                    if mcp_config:
                        mcp_config['enabledTools'] = req.enabled_tools
                        agent_config['tools']['custom_mcp'].append(mcp_config)
            
            elif not req.custom_type:
                profile_id = request.profile_mappings.get(req.qualified_name) if request.profile_mappings else None
                if profile_id:
                    profile = await profile_service.get_profile_by_id(profile_id)
                    if profile:
                        mcp_config = {
                            'name': req.display_name,
                            'qualifiedName': req.qualified_name,
                            'config': profile.config,
                            'enabledTools': req.enabled_tools,
                            'selectedProfileId': profile_id
                        }
                        agent_config['tools']['mcp'].append(mcp_config)
            
            else:
                custom_config = request.custom_mcp_configs.get(req.qualified_name) if request.custom_mcp_configs else None
                if custom_config:
                    mcp_config = {
                        'name': req.display_name,
                        'type': req.custom_type,
                        'customType': req.custom_type,
                        'qualifiedName': req.qualified_name,
                        'config': custom_config,
                        'enabledTools': req.enabled_tools
                    }
                    agent_config['tools']['custom_mcp'].append(mcp_config)
        
        return agent_config
    
    async def _create_agent_from_json(
        self,
        json_data: Dict[str, Any],
        request: JsonImportRequestModel,
        account_id: str,
        agent_config: Dict[str, Any]
    ) -> str:
        
        client = await self._db.client
        
        agent_name = request.instance_name or json_data.get('name', 'Imported Agent')
        
        insert_data = {
            "account_id": account_id,
            "name": agent_name,
            "description": json_data.get('description', ''),
            "icon_name": json_data.get('icon_name', 'brain'),
            "icon_color": json_data.get('icon_color', '#000000'),
            "icon_background": json_data.get('icon_background', '#F3F4F6'),
            "is_default": False,
            "tags": json_data.get('tags', []),
            "version_count": 1,
            "metadata": {
                "imported_from_json": True,
                "import_date": datetime.now(timezone.utc).isoformat()
            }
        }
        
        result = await client.table('agents').insert(insert_data).execute()
        
        if not result.data:
            raise JsonImportError("Failed to create agent from JSON")
        
        return result.data[0]['agent_id']
    
    async def _create_initial_version(
        self,
        agent_id: str,
        account_id: str,
        agent_config: Dict[str, Any],
        system_prompt: str
    ) -> None:
        try:
            logger.debug(f"Creating initial version for JSON imported agent {agent_id} with system_prompt: {system_prompt[:100]}...")
            
            from .versioning.version_service import VersionService
            version_service = VersionService()
            
            version = await version_service.create_version(
                agent_id=agent_id,
                user_id=account_id,
                system_prompt=system_prompt,
                agentpress_tools=agent_config['tools']['agentpress'],
                configured_mcps=agent_config['tools']['mcp'],
                custom_mcps=agent_config['tools']['custom_mcp'],
                change_description="Initial version from JSON import"
            )
            
            logger.info(f"Successfully created initial version {version.version_id} for JSON imported agent {agent_id}")
            
            # Verify the agent was updated with current_version_id
            client = await self._db.client
            agent_check = await client.table('agents').select('current_version_id').eq('agent_id', agent_id).execute()
            if agent_check.data and agent_check.data[0].get('current_version_id'):
                logger.debug(f"Agent {agent_id} current_version_id updated to: {agent_check.data[0]['current_version_id']}")
            else:
                logger.error(f"Agent {agent_id} current_version_id was not updated after version creation!")
                
        except Exception as e:
            logger.error(f"Failed to create initial version for JSON imported agent {agent_id}: {e}", exc_info=True)
            raise  # Re-raise the exception to ensure import fails if version creation fails

@router.get("/agents/{agent_id}/export")
async def export_agent(agent_id: str, user_id: str = Depends(verify_and_get_user_id_from_jwt)):
    """Export an agent configuration as JSON"""
    logger.debug(f"Exporting agent {agent_id} for user: {user_id}")
    
    try:
        client = await utils.db.client
        
        # Get agent data
        agent_result = await client.table('agents').select('*').eq('agent_id', agent_id).eq('account_id', user_id).execute()
        if not agent_result.data:
            raise HTTPException(status_code=404, detail="Agent not found")
        
        agent = agent_result.data[0]
        
        # Get current version data if available
        current_version = None
        if agent.get('current_version_id'):
            version_result = await client.table('agent_versions').select('*').eq('version_id', agent['current_version_id']).execute()
            if version_result.data:
                current_version = version_result.data[0]

        from .config_helper import extract_agent_config
        config = extract_agent_config(agent, current_version)
        
        from core.templates.template_service import TemplateService
        template_service = TemplateService(utils.db)
        
        full_config = {
            'system_prompt': config.get('system_prompt', ''),
            'tools': {
                'agentpress': config.get('agentpress_tools', {}),
                'mcp': config.get('configured_mcps', []),
                'custom_mcp': config.get('custom_mcps', [])
            },
            'metadata': {
                # include profile image url in metadata for completeness
                'profile_image_url': agent.get('profile_image_url')
            }
        }
        
        sanitized_config = template_service._fallback_sanitize_config(full_config)
        
        export_metadata = {}
        if agent.get('metadata'):
            export_metadata = {k: v for k, v in agent['metadata'].items() 
                             if k not in ['is_suna_default', 'centrally_managed', 'installation_date', 'last_central_update']}
        
        export_data = {
            "tools": sanitized_config['tools'],
            "metadata": sanitized_config['metadata'],
            "system_prompt": sanitized_config['system_prompt'],
            "name": config.get('name', ''),
            "description": config.get('description', ''),
            "profile_image_url": agent.get('profile_image_url'),
            "tags": agent.get('tags', []),
            "export_metadata": export_metadata,
            "exported_at": datetime.now(timezone.utc).isoformat()
        }
        
        logger.debug(f"Successfully exported agent {agent_id}")
        return export_data
        
    except Exception as e:
        logger.error(f"Error exporting agent {agent_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to export agent: {str(e)}")

@router.post("/agents/json/analyze", response_model=JsonAnalysisResponse)
async def analyze_json_for_import(
    request: JsonAnalysisRequest,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """Analyze imported JSON to determine required credentials and configurations"""
    logger.debug(f"Analyzing JSON for import - user: {user_id}")
    
    
    try:
        import_service = JsonImportService(utils.db)
        
        analysis = await import_service.analyze_json(request.json_data, user_id)
        
        return analysis
        
    except Exception as e:
        logger.error(f"Error analyzing JSON: {str(e)}")
        raise HTTPException(status_code=400, detail=f"Failed to analyze JSON: {str(e)}")

@router.post("/agents/json/import", response_model=JsonImportResponse)
async def import_agent_from_json(
    request: JsonImportRequestModel,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    logger.debug(f"Importing agent from JSON - user: {user_id}")
    
    
    client = await utils.db.client
    from .core_utils import check_agent_count_limit
    limit_check = await check_agent_count_limit(client, user_id)
    
    if not limit_check['can_create']:
        error_detail = {
            "message": f"Maximum of {limit_check['limit']} agents allowed for your current plan. You have {limit_check['current_count']} agents.",
            "current_count": limit_check['current_count'],
            "limit": limit_check['limit'],
            "tier_name": limit_check['tier_name'],
            "error_code": "AGENT_LIMIT_EXCEEDED"
        }
        logger.warning(f"Agent limit exceeded for account {user_id}: {limit_check['current_count']}/{limit_check['limit']} agents")
        raise HTTPException(status_code=402, detail=error_detail)
    
    try:
        import_service = JsonImportService(utils.db)
        
        result = await import_service.import_json(request, user_id)
        
        return result
        
    except Exception as e:
        logger.error(f"Error importing agent from JSON: {str(e)}")
        raise HTTPException(status_code=400, detail=f"Failed to import agent: {str(e)}")