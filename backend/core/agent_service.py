from typing import List, Dict, Any, Optional
from core.utils.pagination import PaginationService, PaginationParams, PaginatedResponse
from core.utils.logger import logger
from .config_helper import extract_agent_config
from core.utils.query_utils import batch_query_in


class AgentFilters:
    def __init__(
        self,
        search: Optional[str] = None,
        has_default: Optional[bool] = None,
        has_mcp_tools: Optional[bool] = None,
        has_agentpress_tools: Optional[bool] = None,
        tools: Optional[List[str]] = None,
        content_type: Optional[str] = None,
        sort_by: str = "created_at",
        sort_order: str = "desc"
    ):
        self.search = search
        self.has_default = has_default
        self.has_mcp_tools = has_mcp_tools
        self.has_agentpress_tools = has_agentpress_tools
        self.tools = tools or []
        self.content_type = content_type
        self.sort_by = sort_by
        self.sort_order = sort_order


class AgentService:
    def __init__(self, db_client):
        self.db = db_client

    async def get_agents_paginated(
        self,
        user_id: str,
        pagination_params: PaginationParams,
        filters: AgentFilters
    ) -> PaginatedResponse[Dict[str, Any]]:
        try:
            logger.debug(f"Fetching content for user {user_id} with filters: {filters.__dict__}")
            
            # Handle unified agent/template content types
            if filters.content_type == "templates":
                return await self._get_user_templates_paginated(user_id, pagination_params, filters)
            else:
                # Default behavior: show only agents (content_type == "agents" or None)
                return await self._get_only_agents_paginated(user_id, pagination_params, filters)
                
        except Exception as e:
            logger.error(f"Error fetching content for user {user_id}: {e}", exc_info=True)
            raise

    async def _get_only_agents_paginated(
        self,
        user_id: str,
        pagination_params: PaginationParams,
        filters: AgentFilters
    ) -> PaginatedResponse[Dict[str, Any]]:
        """Get only agents (not templates) with pagination"""
        base_query = self._build_base_query(user_id, filters)
        count_query = self._build_count_query(user_id, filters)
        
        needs_post_processing = (
            filters.has_mcp_tools is not None or 
            filters.has_agentpress_tools is not None or 
            len(filters.tools) > 0 or
            filters.sort_by == "tools_count"
        )
        
        if needs_post_processing:
            return await self._get_agents_with_complex_filtering(
                user_id, pagination_params, filters, base_query
            )
        else:
            return await self._get_agents_database_paginated(
                base_query, count_query, pagination_params, filters
            )

    async def _get_user_templates_paginated(
        self,
        user_id: str,
        pagination_params: PaginationParams,
        filters: AgentFilters
    ) -> PaginatedResponse[Dict[str, Any]]:
        """Get user's templates with pagination (both public and private)"""
        try:
            # Build template queries
            base_query = self.db.table('agent_templates').select('*').eq('creator_id', user_id)
            count_query = self.db.table('agent_templates').select('*', count='exact').eq('creator_id', user_id)
            
            # Apply search filter
            if filters.search:
                search_term = f"%{filters.search}%"
                base_query = base_query.or_(f"name.ilike.{search_term},description.ilike.{search_term}")
                count_query = count_query.or_(f"name.ilike.{search_term},description.ilike.{search_term}")
            
            # Apply sorting for templates
            if filters.sort_by == "name":
                base_query = base_query.order('name', desc=(filters.sort_order == "desc"))
            elif filters.sort_by == "download_count":
                base_query = base_query.order('download_count', desc=(filters.sort_order == "desc"))
                base_query = base_query.order('created_at', desc=True)  # Secondary sort
            else:
                # Default to created_at
                base_query = base_query.order('created_at', desc=(filters.sort_order == "desc"))
            
            # Use pagination service
            paginated_result = await PaginationService.paginate_database_query(
                base_query=base_query,
                params=pagination_params,
                count_query=count_query
            )
            
            # Transform template data to match agent response format
            template_responses = []
            for template_data in paginated_result.data:
                transformed_template = await self._transform_template_to_agent_format(template_data)
                template_responses.append(transformed_template)
            
            return PaginatedResponse(
                data=template_responses,
                pagination=paginated_result.pagination
            )
                
        except Exception as e:
            logger.error(f"Error fetching templates for user {user_id}: {e}", exc_info=True)
            raise

    def _build_base_query(self, user_id: str, filters: AgentFilters):
        query = self.db.table('agents').select('*').eq("account_id", user_id)
        
        if filters.search:
            search_term = f"%{filters.search}%"
            query = query.or_(f"name.ilike.{search_term},description.ilike.{search_term}")
        
        if filters.has_default is not None:
            query = query.eq("is_default", filters.has_default)
        
        if filters.sort_by != "tools_count":
            sort_column = filters.sort_by if filters.sort_by in ["name", "created_at", "updated_at"] else "created_at"
            query = query.order(sort_column, desc=(filters.sort_order == "desc"))
        
        return query

    def _build_count_query(self, user_id: str, filters: AgentFilters):
        query = self.db.table('agents').select('*', count='exact').eq("account_id", user_id)
        
        if filters.search:
            search_term = f"%{filters.search}%"
            query = query.or_(f"name.ilike.{search_term},description.ilike.{search_term}")
        
        if filters.has_default is not None:
            query = query.eq("is_default", filters.has_default)
            
        return query

    async def _get_agents_database_paginated(
        self, 
        base_query, 
        count_query, 
        pagination_params: PaginationParams,
        filters: AgentFilters
    ) -> PaginatedResponse[Dict[str, Any]]:
        paginated_result = await PaginationService.paginate_database_query(
            base_query=base_query,
            params=pagination_params,
            count_query=count_query
        )
        
        agent_responses = []
        for agent_data in paginated_result.data:
            agent_response = await self._transform_agent_data(agent_data)
            agent_responses.append(agent_response)
        
        return PaginatedResponse(
            data=agent_responses,
            pagination=paginated_result.pagination
        )

    async def _get_agents_with_complex_filtering(
        self,
        user_id: str,
        pagination_params: PaginationParams, 
        filters: AgentFilters,
        base_query
    ) -> PaginatedResponse[Dict[str, Any]]:
        all_agents_result = await base_query.execute()
        all_agents = all_agents_result.data or []
        
        if not all_agents:
            return PaginatedResponse(
                data=[],
                pagination=PaginationService.PaginationMeta(
                    current_page=pagination_params.page,
                    page_size=pagination_params.page_size,
                    total_items=0,
                    total_pages=0,
                    has_next=False,
                    has_previous=False
                )
            )
        
        version_map = await self._load_agent_versions_batch(all_agents)
        
        filtered_agents = []
        for agent_data in all_agents:
            if await self._passes_complex_filters(agent_data, version_map, filters):
                filtered_agents.append(agent_data)
        
        if filters.sort_by == "tools_count":
            filtered_agents = await self._sort_by_tools_count(filtered_agents, version_map)
        elif filters.sort_order == "desc":
            filtered_agents.reverse()
        
        # Transform to proper response format
        agent_responses = []
        for agent_data in filtered_agents:
            agent_response = await self._transform_agent_data(agent_data, version_map.get(agent_data['agent_id']))
            agent_responses.append(agent_response)
        
        return await PaginationService.paginate_filtered_dataset(
            all_items=agent_responses,
            params=pagination_params
        )

    async def _load_agent_versions_batch(self, agents: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
        version_map = {}
        version_ids = list({agent['current_version_id'] for agent in agents if agent.get('current_version_id')})
        
        if version_ids:
            try:
                versions_data = await batch_query_in(
                    client=self.db,
                    table_name='agent_versions',
                    select_fields='version_id, agent_id, version_number, version_name, is_active, created_at, updated_at, created_by, config',
                    in_field='version_id',
                    in_values=version_ids
                )
                
                for row in versions_data:
                    config = row.get('config') or {}
                    tools = config.get('tools') or {}
                    version_dict = {
                        'version_id': row['version_id'],
                        'agent_id': row['agent_id'],
                        'version_number': row['version_number'],
                        'version_name': row['version_name'],
                        'system_prompt': config.get('system_prompt', ''),
                        'model': config.get('model'),
                        'configured_mcps': tools.get('mcp', []),
                        'custom_mcps': tools.get('custom_mcp', []),
                        'agentpress_tools': tools.get('agentpress', {}),
                        'is_active': row.get('is_active', False),
                        'created_at': row.get('created_at'),
                        'updated_at': row.get('updated_at') or row.get('created_at'),
                        'created_by': row.get('created_by'),
                        'config': config  # Include the full config for compatibility
                    }
                    version_map[row['agent_id']] = version_dict
            except Exception as e:
                logger.warning(f"Failed to batch load agent versions: {e}")
        
        return version_map

    async def _passes_complex_filters(
        self, 
        agent_data: Dict[str, Any], 
        version_map: Dict[str, Dict[str, Any]], 
        filters: AgentFilters
    ) -> bool:
        version_data = version_map.get(agent_data['agent_id'])
        agent_config = extract_agent_config(agent_data, version_data)
        
        configured_mcps = agent_config['configured_mcps']
        agentpress_tools = agent_config['agentpress_tools']
        
        if filters.has_mcp_tools is not None:
            has_mcp = bool(configured_mcps and len(configured_mcps) > 0)
            if filters.has_mcp_tools != has_mcp:
                return False
        
        if filters.has_agentpress_tools is not None:
            has_enabled_tools = any(
                tool_data and isinstance(tool_data, dict) and tool_data.get('enabled', False)
                for tool_data in agentpress_tools.values()
            )
            if filters.has_agentpress_tools != has_enabled_tools:
                return False
        
        if filters.tools:
            agent_tools = set()

            for mcp in configured_mcps:
                if isinstance(mcp, dict) and 'name' in mcp:
                    agent_tools.add(f"mcp:{mcp['name']}")
            
            for tool_name, tool_data in agentpress_tools.items():
                if tool_data and isinstance(tool_data, dict) and tool_data.get('enabled', False):
                    agent_tools.add(f"agentpress:{tool_name}")
            
            if not any(tool in agent_tools for tool in filters.tools):
                return False
        
        return True

    async def _sort_by_tools_count(
        self, 
        agents: List[Dict[str, Any]], 
        version_map: Dict[str, Dict[str, Any]]
    ) -> List[Dict[str, Any]]:
        def get_tools_count(agent_data):
            version_data = version_map.get(agent_data['agent_id'])
            agent_config = extract_agent_config(agent_data, version_data)
            
            configured_mcps = agent_config['configured_mcps']
            agentpress_tools = agent_config['agentpress_tools']
            
            mcp_count = len(configured_mcps) if configured_mcps else 0
            agentpress_count = sum(
                1 for tool_data in agentpress_tools.values()
                if tool_data and isinstance(tool_data, dict) and tool_data.get('enabled', False)
            ) if agentpress_tools else 0
            
            return mcp_count + agentpress_count
        
        return sorted(agents, key=get_tools_count, reverse=True)

    async def _transform_agent_data(
        self, 
        agent_data: Dict[str, Any], 
        version_data: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        agent_config = extract_agent_config(agent_data, version_data)
        
        system_prompt = agent_config['system_prompt']
        configured_mcps = agent_config['configured_mcps']
        custom_mcps = agent_config['custom_mcps']
        agentpress_tools = agent_config['agentpress_tools']
        current_version = agent_config.get('current_version')
        
        return {
            "agent_id": agent_data['agent_id'],
            "name": agent_data['name'],
            "description": agent_data.get('description'),
            "system_prompt": system_prompt,
            "configured_mcps": configured_mcps,
            "custom_mcps": custom_mcps,
            "agentpress_tools": agentpress_tools,
            "is_default": agent_data.get('is_default', False),
            "is_public": agent_data.get('is_public', False),
            "tags": agent_data.get('tags', []),
            "icon_name": agent_config.get('icon_name'),
            "icon_color": agent_config.get('icon_color'),
            "icon_background": agent_config.get('icon_background'),
            "created_at": agent_data['created_at'],
            "updated_at": agent_data['updated_at'],
            "current_version_id": agent_data.get('current_version_id'),
            "version_count": agent_data.get('version_count', 1),
            "current_version": current_version,
            "metadata": agent_data.get('metadata')
        }

    async def _transform_template_to_agent_format(self, template_data: Dict[str, Any]) -> Dict[str, Any]:
        try:
            creator_name = None
            if template_data.get('creator_id'):
                try:
                    creator_result = await self.db.schema('basejump').from_('accounts').select('name, slug').eq('id', template_data['creator_id']).single().execute()
                    if creator_result.data:
                        creator_name = creator_result.data.get('name') or creator_result.data.get('slug')
                except Exception as e:
                    logger.warning(f"Failed to fetch creator name for template {template_data.get('template_id')}: {e}")

            return {
                "agent_id": template_data.get('template_id', ''),
                "name": template_data.get('name', ''),
                "description": template_data.get('description', ''),
                "system_prompt": template_data.get('system_prompt', ''),
                "configured_mcps": template_data.get('mcp_requirements', []),
                "custom_mcps": [],
                "agentpress_tools": template_data.get('agentpress_tools', {}),
                "is_default": False,
                "icon_name": template_data.get('icon_name'),
                "icon_color": template_data.get('icon_color'),
                "icon_background": template_data.get('icon_background'),
                "created_at": template_data.get('created_at', ''),
                "updated_at": template_data.get('updated_at'),
                "is_public": template_data.get('is_public', False),
                "tags": template_data.get('tags', []),
                "current_version_id": None,
                "version_count": 0,
                "current_version": None,
                "metadata": {
                    **(template_data.get('metadata', {})),
                    "is_template": True,
                    "creator_name": creator_name
                },
                
                "template_id": template_data.get('template_id'),
                "mcp_requirements": template_data.get('mcp_requirements', []),
                "model": template_data.get('metadata', {}).get('model'),
                "marketplace_published_at": template_data.get('marketplace_published_at'),
                "download_count": template_data.get('download_count', 0),
                "creator_name": creator_name,
                "creator_id": template_data.get('creator_id'),
                "is_kortix_team": template_data.get('is_kortix_team', False)
            }
        except Exception as e:
            logger.error(f"Error transforming template data: {e}", exc_info=True)
            return {
                "agent_id": template_data.get('template_id', 'unknown'),
                "name": template_data.get('name', 'Unknown Template'),
                "description": template_data.get('description', ''),
                "system_prompt": template_data.get('system_prompt', ''),
                "configured_mcps": [],
                "custom_mcps": [],
                "agentpress_tools": {},
                "is_default": False,
                "icon_name": None,
                "icon_color": None,
                "icon_background": None,
                "created_at": template_data.get('created_at', ''),
                "updated_at": template_data.get('updated_at'),
                "is_public": template_data.get('is_public', False),
                "tags": [],
                "current_version_id": None,
                "version_count": 0,
                "current_version": None,
                "metadata": {"is_template": True, "transform_error": True},
                
                "template_id": template_data.get('template_id', 'unknown'),
                "mcp_requirements": [],
                "model": None,
                "marketplace_published_at": template_data.get('marketplace_published_at'),
                "download_count": 0,
                "creator_name": None,
                "creator_id": template_data.get('creator_id'),
                "is_kortix_team": False
            } 