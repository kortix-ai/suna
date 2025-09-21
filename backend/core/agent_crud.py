from typing import Optional
from fastapi import APIRouter, HTTPException, Depends, File, UploadFile, Query

from core.utils.auth_utils import verify_and_get_user_id_from_jwt
from core.utils.logger import logger
from core.utils.config import config, EnvMode
from core.utils.pagination import PaginationParams
from core.ai_models import model_manager

from .api_models import (
    AgentUpdateRequest, AgentResponse, AgentVersionResponse, AgentsResponse, 
    PaginationInfo, AgentCreateRequest
)
from . import core_utils as utils
from .core_utils import _get_version_service, merge_custom_mcps
from .config_helper import build_unified_config

router = APIRouter()

@router.put("/agents/{agent_id}", response_model=AgentResponse)
async def update_agent(
    agent_id: str,
    agent_data: AgentUpdateRequest,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    logger.debug(f"Updating agent {agent_id} for user: {user_id}")
    
    # Debug logging for icon fields
    if config.ENV_MODE == EnvMode.STAGING:
        print(f"[DEBUG] update_agent: Received icon fields - icon_name={agent_data.icon_name}, icon_color={agent_data.icon_color}, icon_background={agent_data.icon_background}")
        print(f"[DEBUG] update_agent: Also received - profile_image_url={agent_data.profile_image_url}")
    
    client = await utils.db.client
    
    try:
        existing_agent = await client.table('agents').select('*').eq("agent_id", agent_id).eq("account_id", user_id).maybe_single().execute()
        
        if not existing_agent.data:
            raise HTTPException(status_code=404, detail="Agent not found")
        
        existing_data = existing_agent.data

        agent_metadata = existing_data.get('metadata', {})
        is_suna_agent = agent_metadata.get('is_suna_default', False)
        restrictions = agent_metadata.get('restrictions', {})
        
        if is_suna_agent:
            logger.warning(f"Update attempt on Suna default agent {agent_id} by user {user_id}")
            
            if (agent_data.name is not None and 
                agent_data.name != existing_data.get('name') and 
                restrictions.get('name_editable') == False):
                logger.error(f"User {user_id} attempted to modify restricted name of Suna agent {agent_id}")
                raise HTTPException(
                    status_code=403, 
                    detail="Suna's name cannot be modified. This restriction is managed centrally."
                )
            
            if (agent_data.description is not None and
                agent_data.description != existing_data.get('description') and 
                restrictions.get('description_editable') == False):
                logger.error(f"User {user_id} attempted to modify restricted description of Suna agent {agent_id}")
                raise HTTPException(
                    status_code=403, 
                    detail="Suna's description cannot be modified."
                )
            
            if (agent_data.system_prompt is not None and 
                restrictions.get('system_prompt_editable') == False):
                logger.error(f"User {user_id} attempted to modify restricted system prompt of Suna agent {agent_id}")
                raise HTTPException(
                    status_code=403, 
                    detail="Suna's system prompt cannot be modified. This is managed centrally to ensure optimal performance."
                )
            
            if (agent_data.agentpress_tools is not None and 
                restrictions.get('tools_editable') == False):
                logger.error(f"User {user_id} attempted to modify restricted tools of Suna agent {agent_id}")
                raise HTTPException(
                    status_code=403, 
                    detail="Suna's default tools cannot be modified. These tools are optimized for Suna's capabilities."
                )
            
            if ((agent_data.configured_mcps is not None or agent_data.custom_mcps is not None) and 
                restrictions.get('mcps_editable') == False):
                logger.error(f"User {user_id} attempted to modify restricted MCPs of Suna agent {agent_id}")
                raise HTTPException(
                    status_code=403, 
                    detail="Suna's integrations cannot be modified."
                )
            
            logger.debug(f"Suna agent update validation passed for agent {agent_id} by user {user_id}")

        current_version_data = None
        if existing_data.get('current_version_id'):
            try:
                version_service = await _get_version_service()
                current_version_obj = await version_service.get_version(
                    agent_id=agent_id,
                    version_id=existing_data['current_version_id'],
                    user_id=user_id
                )
                current_version_data = current_version_obj.to_dict()
            except Exception as e:
                logger.warning(f"Failed to get current version data for agent {agent_id}: {e}")
        
        if current_version_data is None:
            logger.debug(f"Agent {agent_id} has no version data, creating initial version")
            try:
                workflows_result = await client.table('agent_workflows').select('*').eq('agent_id', agent_id).execute()
                workflows = workflows_result.data if workflows_result.data else []
                
                # Fetch triggers for the agent
                triggers_result = await client.table('agent_triggers').select('*').eq('agent_id', agent_id).execute()
                triggers = []
                if triggers_result.data:
                    import json
                    for trigger in triggers_result.data:
                        # Parse the config string if it's a string
                        trigger_copy = trigger.copy()
                        if 'config' in trigger_copy and isinstance(trigger_copy['config'], str):
                            try:
                                trigger_copy['config'] = json.loads(trigger_copy['config'])
                            except json.JSONDecodeError:
                                logger.warning(f"Failed to parse trigger config for {trigger_copy.get('trigger_id')}")
                                trigger_copy['config'] = {}
                        triggers.append(trigger_copy)
                
                initial_version_data = {
                    "agent_id": agent_id,
                    "version_number": 1,
                    "version_name": "v1",
                    "system_prompt": existing_data.get('system_prompt', ''),
                    "configured_mcps": existing_data.get('configured_mcps', []),
                    "custom_mcps": existing_data.get('custom_mcps', []),
                    "agentpress_tools": existing_data.get('agentpress_tools', {}),
                    "is_active": True,
                    "created_by": user_id
                }
                
                initial_config = build_unified_config(
                    system_prompt=initial_version_data["system_prompt"],
                    agentpress_tools=initial_version_data["agentpress_tools"],
                    configured_mcps=initial_version_data["configured_mcps"],
                    custom_mcps=initial_version_data["custom_mcps"],
                    workflows=workflows,
                    triggers=triggers
                )
                initial_version_data["config"] = initial_config
                
                version_result = await client.table('agent_versions').insert(initial_version_data).execute()
                
                if version_result.data:
                    version_id = version_result.data[0]['version_id']
                    
                    await client.table('agents').update({
                        'current_version_id': version_id,
                        'version_count': 1
                    }).eq('agent_id', agent_id).execute()
                    current_version_data = initial_version_data
                    logger.debug(f"Created initial version for agent {agent_id}")
                else:
                    current_version_data = {
                        'system_prompt': existing_data.get('system_prompt', ''),
                        'configured_mcps': existing_data.get('configured_mcps', []),
                        'custom_mcps': existing_data.get('custom_mcps', []),
                        'agentpress_tools': existing_data.get('agentpress_tools', {})
                    }
            except Exception as e:
                logger.warning(f"Failed to create initial version for agent {agent_id}: {e}")
                current_version_data = {
                    'system_prompt': existing_data.get('system_prompt', ''),
                    'configured_mcps': existing_data.get('configured_mcps', []),
                    'custom_mcps': existing_data.get('custom_mcps', []),
                    'agentpress_tools': existing_data.get('agentpress_tools', {})
                }
        
        needs_new_version = False
        version_changes = {}
        
        def values_different(new_val, old_val):
            if new_val is None:
                return False
            import json
            try:
                new_json = json.dumps(new_val, sort_keys=True) if new_val is not None else None
                old_json = json.dumps(old_val, sort_keys=True) if old_val is not None else None
                return new_json != old_json
            except (TypeError, ValueError):
                return new_val != old_val
        
        if values_different(agent_data.system_prompt, current_version_data.get('system_prompt')):
            needs_new_version = True
            version_changes['system_prompt'] = agent_data.system_prompt
        
        if values_different(agent_data.configured_mcps, current_version_data.get('configured_mcps', [])):
            needs_new_version = True
            version_changes['configured_mcps'] = agent_data.configured_mcps
            
        if values_different(agent_data.custom_mcps, current_version_data.get('custom_mcps', [])):
            needs_new_version = True
            if agent_data.custom_mcps is not None:
                merged_custom_mcps = merge_custom_mcps(
                    current_version_data.get('custom_mcps', []),
                    agent_data.custom_mcps
                )
                version_changes['custom_mcps'] = merged_custom_mcps
            else:
                version_changes['custom_mcps'] = current_version_data.get('custom_mcps', [])
            
        if values_different(agent_data.agentpress_tools, current_version_data.get('agentpress_tools', {})):
            needs_new_version = True
            version_changes['agentpress_tools'] = agent_data.agentpress_tools
        
        update_data = {}
        if agent_data.name is not None:
            update_data["name"] = agent_data.name
        if agent_data.description is not None:
            update_data["description"] = agent_data.description
        if agent_data.is_default is not None:
            update_data["is_default"] = agent_data.is_default
            if agent_data.is_default:
                await client.table('agents').update({"is_default": False}).eq("account_id", user_id).eq("is_default", True).neq("agent_id", agent_id).execute()
        # Handle new icon system fields
        if agent_data.icon_name is not None:
            update_data["icon_name"] = agent_data.icon_name
        if agent_data.icon_color is not None:
            update_data["icon_color"] = agent_data.icon_color
        if agent_data.icon_background is not None:
            update_data["icon_background"] = agent_data.icon_background
        
        # Debug logging for update_data
        if config.ENV_MODE == EnvMode.STAGING:
            print(f"[DEBUG] update_agent: Prepared update_data with icon fields - icon_name={update_data.get('icon_name')}, icon_color={update_data.get('icon_color')}, icon_background={update_data.get('icon_background')}")
        
        current_system_prompt = agent_data.system_prompt if agent_data.system_prompt is not None else current_version_data.get('system_prompt', '')

        if agent_data.configured_mcps is not None:
            if agent_data.replace_mcps:
                current_configured_mcps = agent_data.configured_mcps
                logger.debug(f"Replacing configured MCPs for agent {agent_id}: {current_configured_mcps}")
            else:
                current_configured_mcps = agent_data.configured_mcps
        else:
            current_configured_mcps = current_version_data.get('configured_mcps', [])
        
        # Handle custom MCPs - either replace or merge based on the flag
        if agent_data.custom_mcps is not None:
            if agent_data.replace_mcps:
                # Replace mode: use the provided list as-is
                current_custom_mcps = agent_data.custom_mcps
                logger.debug(f"Replacing custom MCPs for agent {agent_id}: {current_custom_mcps}")
            else:
                # Merge mode: merge with existing MCPs (default behavior)
                current_custom_mcps = merge_custom_mcps(
                    current_version_data.get('custom_mcps', []),
                    agent_data.custom_mcps
                )
                logger.debug(f"Merging custom MCPs for agent {agent_id}")
        else:
            current_custom_mcps = current_version_data.get('custom_mcps', [])

        current_agentpress_tools = agent_data.agentpress_tools if agent_data.agentpress_tools is not None else current_version_data.get('agentpress_tools', {})
        new_version_id = None
        if needs_new_version:
            try:
                version_service = await _get_version_service()

                new_version = await version_service.create_version(
                    agent_id=agent_id,
                    user_id=user_id,
                    system_prompt=current_system_prompt,
                    configured_mcps=current_configured_mcps,
                    custom_mcps=current_custom_mcps,
                    agentpress_tools=current_agentpress_tools,
                    change_description="Configuration updated"
                )
                
                new_version_id = new_version.version_id
                update_data['current_version_id'] = new_version_id
                update_data['version_count'] = new_version.version_number
                
                logger.debug(f"Created new version {new_version.version_name} for agent {agent_id}")
                
            except HTTPException:
                raise
            except Exception as e:
                logger.error(f"Error creating new version for agent {agent_id}: {str(e)}")
                raise HTTPException(status_code=500, detail=f"Failed to create new agent version: {str(e)}")
        
        if update_data:
            try:
                print(f"[DEBUG] update_agent DB UPDATE: About to update agent {agent_id} with data: {update_data}")
                
                update_result = await client.table('agents').update(update_data).eq("agent_id", agent_id).eq("account_id", user_id).execute()
                
                # Debug logging after DB update
                if config.ENV_MODE == EnvMode.STAGING:
                    if update_result.data:
                        print(f"[DEBUG] update_agent DB UPDATE SUCCESS: Updated {len(update_result.data)} row(s)")
                        print(f"[DEBUG] update_agent DB UPDATE RESULT: {update_result.data[0] if update_result.data else 'No data'}")
                    else:
                        print(f"[DEBUG] update_agent DB UPDATE FAILED: No rows affected")
                
                if not update_result.data:
                    raise HTTPException(status_code=500, detail="Failed to update agent - no rows affected")
            except Exception as e:
                logger.error(f"Error updating agent {agent_id}: {str(e)}")
                if config.ENV_MODE == EnvMode.STAGING:
                    print(f"[DEBUG] update_agent DB UPDATE ERROR: {str(e)}")
                raise HTTPException(status_code=500, detail=f"Failed to update agent: {str(e)}")
        
        updated_agent = await client.table('agents').select('*').eq("agent_id", agent_id).eq("account_id", user_id).maybe_single().execute()
        
        if not updated_agent.data:
            raise HTTPException(status_code=500, detail="Failed to fetch updated agent")
        
        agent = updated_agent.data
        
        print(f"[DEBUG] update_agent AFTER UPDATE FETCH: agent_id={agent.get('agent_id')}")
        print(f"[DEBUG] update_agent AFTER UPDATE FETCH: icon_name={agent.get('icon_name')}, icon_color={agent.get('icon_color')}, icon_background={agent.get('icon_background')}")
        print(f"[DEBUG] update_agent AFTER UPDATE FETCH: profile_image_url={agent.get('profile_image_url')}")
        print(f"[DEBUG] update_agent AFTER UPDATE FETCH: All keys in agent: {agent.keys()}")
        
        current_version = None
        if agent.get('current_version_id'):
            try:
                version_service = await _get_version_service()
                current_version_obj = await version_service.get_version(
                    agent_id=agent_id,
                    version_id=agent['current_version_id'],
                    user_id=user_id
                )
                current_version_data = current_version_obj.to_dict()
                version_data = current_version_data
                
                current_version = AgentVersionResponse(
                    version_id=current_version_data['version_id'],
                    agent_id=current_version_data['agent_id'],
                    version_number=current_version_data['version_number'],
                    version_name=current_version_data['version_name'],
                    system_prompt=current_version_data['system_prompt'],
                    model=current_version_data.get('model'),
                    configured_mcps=current_version_data.get('configured_mcps', []),
                    custom_mcps=current_version_data.get('custom_mcps', []),
                    agentpress_tools=current_version_data.get('agentpress_tools', {}),
                    is_active=current_version_data.get('is_active', True),
                    created_at=current_version_data['created_at'],
                    updated_at=current_version_data.get('updated_at', current_version_data['created_at']),
                    created_by=current_version_data.get('created_by')
                )
                
                logger.debug(f"Using agent {agent['name']} version {current_version_data.get('version_name', 'v1')}")
            except Exception as e:
                logger.warning(f"Failed to get version data for updated agent {agent_id}: {e}")
        
        version_data = None
        if current_version:
            version_data = {
                'version_id': current_version.version_id,
                'agent_id': current_version.agent_id,
                'version_number': current_version.version_number,
                'version_name': current_version.version_name,
                'system_prompt': current_version.system_prompt,
                'model': current_version.model,
                'configured_mcps': current_version.configured_mcps,
                'custom_mcps': current_version.custom_mcps,
                'agentpress_tools': current_version.agentpress_tools,
                'is_active': current_version.is_active,
            }
        
        from .config_helper import extract_agent_config
        
        # Debug logging before extract_agent_config
        if config.ENV_MODE == EnvMode.STAGING:
            print(f"[DEBUG] update_agent: Before extract_agent_config - agent has icon_name={agent.get('icon_name')}, icon_color={agent.get('icon_color')}, icon_background={agent.get('icon_background')}")
        
        agent_config = extract_agent_config(agent, version_data)
        
        # Debug logging after extract_agent_config
        if config.ENV_MODE == EnvMode.STAGING:
            print(f"[DEBUG] update_agent: After extract_agent_config - agent_config has icon_name={agent_config.get('icon_name')}, icon_color={agent_config.get('icon_color')}, icon_background={agent_config.get('icon_background')}")
        
        system_prompt = agent_config['system_prompt']
        configured_mcps = agent_config['configured_mcps']
        custom_mcps = agent_config['custom_mcps']
        agentpress_tools = agent_config['agentpress_tools']
        
        response = AgentResponse(
            agent_id=agent['agent_id'],
            name=agent['name'],
            description=agent.get('description'),
            system_prompt=system_prompt,
            configured_mcps=configured_mcps,
            custom_mcps=custom_mcps,
            agentpress_tools=agentpress_tools,
            is_default=agent.get('is_default', False),
            is_public=agent.get('is_public', False),
            tags=agent.get('tags', []),
            profile_image_url=agent_config.get('profile_image_url'),
            icon_name=agent_config.get('icon_name'),
            icon_color=agent_config.get('icon_color'),
            icon_background=agent_config.get('icon_background'),
            created_at=agent['created_at'],
            updated_at=agent.get('updated_at', agent['created_at']),
            current_version_id=agent.get('current_version_id'),
            version_count=agent.get('version_count', 1),
            current_version=current_version,
            metadata=agent.get('metadata')
        )
        

        print(f"[DEBUG] update_agent FINAL RESPONSE: agent_id={response.agent_id}")
        print(f"[DEBUG] update_agent FINAL RESPONSE: icon_name={response.icon_name}, icon_color={response.icon_color}, icon_background={response.icon_background}")
        print(f"[DEBUG] update_agent FINAL RESPONSE: profile_image_url={response.profile_image_url}")
        print(f"[DEBUG] update_agent FINAL RESPONSE: Full response dict keys: {response.dict().keys()}")
        
        return response
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating agent {agent_id} for user {user_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to update agent: {str(e)}")

@router.delete("/agents/{agent_id}")
async def delete_agent(agent_id: str, user_id: str = Depends(verify_and_get_user_id_from_jwt)):
    logger.debug(f"Deleting agent: {agent_id}")
    client = await utils.db.client
    
    try:
        agent_result = await client.table('agents').select('*').eq('agent_id', agent_id).execute()
        if not agent_result.data:
            raise HTTPException(status_code=404, detail="Agent not found")
        
        agent = agent_result.data[0]
        if agent['account_id'] != user_id:
            raise HTTPException(status_code=403, detail="Access denied")
        
        if agent['is_default']:
            raise HTTPException(status_code=400, detail="Cannot delete default agent")
        
        if agent.get('metadata', {}).get('is_suna_default', False):
            raise HTTPException(status_code=400, detail="Cannot delete Suna default agent")
        
        # Clean up triggers before deleting agent to ensure proper remote cleanup
        try:
            from core.triggers.trigger_service import get_trigger_service
            trigger_service = get_trigger_service(utils.db)
            
            # Get all triggers for this agent
            triggers_result = await client.table('agent_triggers').select('trigger_id').eq('agent_id', agent_id).execute()
            
            if triggers_result.data:
                logger.debug(f"Cleaning up {len(triggers_result.data)} triggers for agent {agent_id}")
                
                # Delete each trigger properly (this handles remote cleanup)
                for trigger_record in triggers_result.data:
                    trigger_id = trigger_record['trigger_id']
                    try:
                        await trigger_service.delete_trigger(trigger_id)
                        logger.debug(f"Successfully cleaned up trigger {trigger_id}")
                    except Exception as e:
                        logger.warning(f"Failed to clean up trigger {trigger_id}: {str(e)}")
                        # Continue with other triggers even if one fails
        except Exception as e:
            logger.warning(f"Failed to clean up triggers for agent {agent_id}: {str(e)}")
            # Continue with agent deletion even if trigger cleanup fails
        
        delete_result = await client.table('agents').delete().eq('agent_id', agent_id).execute()
        
        if not delete_result.data:
            logger.warning(f"No agent was deleted for agent_id: {agent_id}, user_id: {user_id}")
            raise HTTPException(status_code=403, detail="Unable to delete agent - permission denied or agent not found")
        
        try:
            from core.utils.cache import Cache
            await Cache.invalidate(f"agent_count_limit:{user_id}")
        except Exception as cache_error:
            logger.warning(f"Cache invalidation failed for user {user_id}: {str(cache_error)}")
        
        logger.debug(f"Successfully deleted agent: {agent_id}")
        return {"message": "Agent deleted successfully"}
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting agent {agent_id}: {str(e)}")
        raise HTTPException(status_code=500, detail="Internal server error")

@router.get("/agents", response_model=AgentsResponse)
async def get_agents(
    user_id: str = Depends(verify_and_get_user_id_from_jwt),
    page: Optional[int] = Query(1, ge=1, description="Page number (1-based)"),
    limit: Optional[int] = Query(20, ge=1, le=100, description="Number of items per page"),
    search: Optional[str] = Query(None, description="Search in name and description"),
    sort_by: Optional[str] = Query("created_at", description="Sort field: name, created_at, updated_at, tools_count"),
    sort_order: Optional[str] = Query("desc", description="Sort order: asc, desc"),
    has_default: Optional[bool] = Query(None, description="Filter by default agents"),
    has_mcp_tools: Optional[bool] = Query(None, description="Filter by agents with MCP tools"),
    has_agentpress_tools: Optional[bool] = Query(None, description="Filter by agents with AgentPress tools"),
    tools: Optional[str] = Query(None, description="Comma-separated list of tools to filter by"),
    content_type: Optional[str] = Query(None, description="Content type filter: 'agents', 'templates', or None for agents only")
):
    try:
        from .agent_service import AgentService, AgentFilters
        
        tools_list = []
        if tools:
            if isinstance(tools, str):
                tools_list = [tool.strip() for tool in tools.split(',') if tool.strip()]
            else:
                logger.warning(f"Unexpected tools parameter type: {type(tools)}")
        
        pagination_params = PaginationParams(
            page=page,
            page_size=limit
        )
        
        filters = AgentFilters(
            search=search,
            has_default=has_default,
            has_mcp_tools=has_mcp_tools,
            has_agentpress_tools=has_agentpress_tools,
            tools=tools_list,
            content_type=content_type,
            sort_by=sort_by,
            sort_order=sort_order
        )
        
        client = await utils.db.client
        agent_service = AgentService(client)
        paginated_result = await agent_service.get_agents_paginated(
            user_id=user_id,
            pagination_params=pagination_params,
            filters=filters
        )
        
        agent_responses = []
        for agent_data in paginated_result.data:
            agent_response = AgentResponse(**agent_data)
            agent_responses.append(agent_response)
        
        return AgentsResponse(
            agents=agent_responses,
            pagination=PaginationInfo(
                current_page=paginated_result.pagination.current_page,
                page_size=paginated_result.pagination.page_size,
                total_items=paginated_result.pagination.total_items,
                total_pages=paginated_result.pagination.total_pages,
                has_next=paginated_result.pagination.has_next,
                has_previous=paginated_result.pagination.has_previous
            )
        )
        
    except Exception as e:
        logger.error(f"Error fetching agents for user {user_id}: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to fetch agents: {str(e)}")

@router.get("/agents/{agent_id}", response_model=AgentResponse)
async def get_agent(agent_id: str, user_id: str = Depends(verify_and_get_user_id_from_jwt)):
    
    logger.debug(f"Fetching agent {agent_id} for user: {user_id}")
    
    client = await utils.db.client
    
    try:
        agent = await client.table('agents').select('*').eq("agent_id", agent_id).execute()
        
        if not agent.data:
            raise HTTPException(status_code=404, detail="Agent not found")
        
        agent_data = agent.data[0]
        
        if config.ENV_MODE == EnvMode.STAGING:
            print(f"[DEBUG] get_agent: Fetched agent from DB - icon_name={agent_data.get('icon_name')}, icon_color={agent_data.get('icon_color')}, icon_background={agent_data.get('icon_background')}")
            print(f"[DEBUG] get_agent: Also has - profile_image_url={agent_data.get('profile_image_url')}")
        
        if agent_data['account_id'] != user_id and not agent_data.get('is_public', False):
            raise HTTPException(status_code=403, detail="Access denied")
        
        current_version = None
        if agent_data.get('current_version_id'):
            try:
                version_service = await _get_version_service()
                current_version_obj = await version_service.get_version(
                    agent_id=agent_id,
                    version_id=agent_data['current_version_id'],
                    user_id=user_id
                )
                current_version_data = current_version_obj.to_dict()
                version_data = current_version_data
                
                # Create AgentVersionResponse from version data
                current_version = AgentVersionResponse(
                    version_id=current_version_data['version_id'],
                    agent_id=current_version_data['agent_id'],
                    version_number=current_version_data['version_number'],
                    version_name=current_version_data['version_name'],
                    system_prompt=current_version_data['system_prompt'],
                    model=current_version_data.get('model'),
                    configured_mcps=current_version_data.get('configured_mcps', []),
                    custom_mcps=current_version_data.get('custom_mcps', []),
                    agentpress_tools=current_version_data.get('agentpress_tools', {}),
                    is_active=current_version_data.get('is_active', True),
                    created_at=current_version_data['created_at'],
                    updated_at=current_version_data.get('updated_at', current_version_data['created_at']),
                    created_by=current_version_data.get('created_by')
                )
                
                logger.debug(f"Using agent {agent_data['name']} version {current_version_data.get('version_name', 'v1')}")
            except Exception as e:
                logger.warning(f"Failed to get version data for agent {agent_id}: {e}")
        
        # Extract configuration using the unified config approach
        version_data = None
        if current_version:
            version_data = {
                'version_id': current_version.version_id,
                'agent_id': current_version.agent_id,
                'version_number': current_version.version_number,
                'version_name': current_version.version_name,
                'system_prompt': current_version.system_prompt,
                'model': current_version.model,
                'configured_mcps': current_version.configured_mcps,
                'custom_mcps': current_version.custom_mcps,
                'agentpress_tools': current_version.agentpress_tools,
                'is_active': current_version.is_active,
                'created_at': current_version.created_at,
                'updated_at': current_version.updated_at,
                'created_by': current_version.created_by
            }
        
        from .config_helper import extract_agent_config
        
        # Debug logging before extract_agent_config
        if config.ENV_MODE == EnvMode.STAGING:
            print(f"[DEBUG] get_agent: Before extract_agent_config - agent_data has icon_name={agent_data.get('icon_name')}, icon_color={agent_data.get('icon_color')}, icon_background={agent_data.get('icon_background')}")
        
        agent_config = extract_agent_config(agent_data, version_data)
        
        # Debug logging after extract_agent_config
        if config.ENV_MODE == EnvMode.STAGING:
            print(f"[DEBUG] get_agent: After extract_agent_config - agent_config has icon_name={agent_config.get('icon_name')}, icon_color={agent_config.get('icon_color')}, icon_background={agent_config.get('icon_background')}")
            print(f"[DEBUG] get_agent: Final response will use icon fields from agent_config")
        
        system_prompt = agent_config['system_prompt']
        configured_mcps = agent_config['configured_mcps']
        custom_mcps = agent_config['custom_mcps']
        agentpress_tools = agent_config['agentpress_tools']
        
        response = AgentResponse(
            agent_id=agent_data['agent_id'],
            name=agent_data['name'],
            description=agent_data.get('description'),
            system_prompt=system_prompt,
            configured_mcps=configured_mcps,
            custom_mcps=custom_mcps,
            agentpress_tools=agentpress_tools,
            is_default=agent_data.get('is_default', False),
            is_public=agent_data.get('is_public', False),
            tags=agent_data.get('tags', []),
            profile_image_url=agent_config.get('profile_image_url'),
            icon_name=agent_config.get('icon_name'),
            icon_color=agent_config.get('icon_color'),
            icon_background=agent_config.get('icon_background'),
            created_at=agent_data['created_at'],
            updated_at=agent_data.get('updated_at', agent_data['created_at']),
            current_version_id=agent_data.get('current_version_id'),
            version_count=agent_data.get('version_count', 1),
            current_version=current_version,
            metadata=agent_data.get('metadata')
        )
        
        return response
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching agent {agent_id} for user {user_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to fetch agent: {str(e)}")

@router.post("/agents", response_model=AgentResponse)
async def create_agent(
    agent_data: AgentCreateRequest,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    logger.debug(f"Creating new agent for user: {user_id}")
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
        if agent_data.is_default:
            await client.table('agents').update({"is_default": False}).eq("account_id", user_id).eq("is_default", True).execute()
        
        insert_data = {
            "account_id": user_id,
            "name": agent_data.name,
            "description": agent_data.description,
            "icon_name": agent_data.icon_name or "bot",
            "icon_color": agent_data.icon_color or "#000000",
            "icon_background": agent_data.icon_background or "#F3F4F6",
            "is_default": agent_data.is_default or False,
            "version_count": 1
        }
        
        if config.ENV_MODE == EnvMode.STAGING:
            print(f"[DEBUG] create_agent: Creating with icon_name={insert_data.get('icon_name')}, icon_color={insert_data.get('icon_color')}, icon_background={insert_data.get('icon_background')}")
        
        new_agent = await client.table('agents').insert(insert_data).execute()
        
        if not new_agent.data:
            raise HTTPException(status_code=500, detail="Failed to create agent")
        
        agent = new_agent.data[0]
        
        try:
            version_service = await _get_version_service()
            from .suna_config import SUNA_CONFIG
            from .config_helper import _get_default_agentpress_tools
            from core.ai_models import model_manager
            
            system_prompt = SUNA_CONFIG["system_prompt"]
            
            agentpress_tools = agent_data.agentpress_tools if agent_data.agentpress_tools else _get_default_agentpress_tools()
            
            default_model = await model_manager.get_default_model_for_user(client, user_id)
            
            version = await version_service.create_version(
                agent_id=agent['agent_id'],
                user_id=user_id,
                system_prompt=system_prompt,
                model=default_model,
                configured_mcps=agent_data.configured_mcps or [],
                custom_mcps=agent_data.custom_mcps or [],
                agentpress_tools=agentpress_tools,
                version_name="v1",
                change_description="Initial version"
            )
            
            agent['current_version_id'] = version.version_id
            agent['version_count'] = 1

            current_version = AgentVersionResponse(
                version_id=version.version_id,
                agent_id=version.agent_id,
                version_number=version.version_number,
                version_name=version.version_name,
                system_prompt=version.system_prompt,
                model=version.model,
                configured_mcps=version.configured_mcps,
                custom_mcps=version.custom_mcps,
                agentpress_tools=version.agentpress_tools,
                is_active=version.is_active,
                created_at=version.created_at.isoformat(),
                updated_at=version.updated_at.isoformat(),
                created_by=version.created_by
            )
        except Exception as e:
            logger.error(f"Error creating initial version: {str(e)}")
            await client.table('agents').delete().eq('agent_id', agent['agent_id']).execute()
            raise HTTPException(status_code=500, detail="Failed to create initial version")
        
        from core.utils.cache import Cache
        await Cache.invalidate(f"agent_count_limit:{user_id}")
        
        logger.debug(f"Created agent {agent['agent_id']} with v1 for user: {user_id}")
        
        response = AgentResponse(
            agent_id=agent['agent_id'],
            name=agent['name'],
            description=agent.get('description'),
            system_prompt=version.system_prompt,
            model=version.model,
            configured_mcps=version.configured_mcps,
            custom_mcps=version.custom_mcps,
            agentpress_tools=version.agentpress_tools,
            is_default=agent.get('is_default', False),
            is_public=agent.get('is_public', False),
            tags=agent.get('tags', []),
            profile_image_url=agent.get('profile_image_url'),
            icon_name=agent.get('icon_name'),
            icon_color=agent.get('icon_color'),
            icon_background=agent.get('icon_background'),
            created_at=agent['created_at'],
            updated_at=agent.get('updated_at', agent['created_at']),
            current_version_id=agent.get('current_version_id'),
            version_count=agent.get('version_count', 1),
            current_version=current_version,
            metadata=agent.get('metadata')
        )
        
        if config.ENV_MODE == EnvMode.STAGING:
            print(f"[DEBUG] create_agent RESPONSE: Returning icon_name={response.icon_name}, icon_color={response.icon_color}, icon_background={response.icon_background}")
            print(f"[DEBUG] create_agent RESPONSE: Also returning profile_image_url={response.profile_image_url}")
        
        return response
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error creating agent for user {user_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to create agent: {str(e)}")