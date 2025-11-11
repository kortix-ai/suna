from typing import List, Dict, Any, Optional
from core.utils.pagination import PaginationService, PaginationParams, PaginatedResponse
from core.utils.logger import logger
from .agent_loader import AgentLoader
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
        self.loader = AgentLoader(db_client)

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
        
        # Transform without loading full configs (list operation)
        agent_responses = [
            await self._transform_agent_data(row, load_config=False)
            for row in paginated_result.data
        ]
        
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
        
        # Transform with configs loaded
        agent_responses = await self._load_agents_with_configs(filtered_agents, version_map)
        
        return await PaginationService.paginate_filtered_dataset(
            all_items=agent_responses,
            params=pagination_params
        )

    async def _load_agent_versions_batch(self, agents: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
        version_map = {}
        version_ids = list({agent['current_version_id'] for agent in agents if agent.get('current_version_id')})
        
        if version_ids:
            try:
                # Use versioning service instead of direct config access
                from core.versioning.version_service import get_version_service
                version_service = await get_version_service()
                
                version_map = {}
                for agent in agents:
                    version_id = agent.get('current_version_id')
                    if version_id:
                        try:
                            # Get version data using versioning service
                            version = await version_service.get_version(
                                agent_id=agent['agent_id'],
                                version_id=version_id,
                                user_id=agent['account_id']  # Use account_id as user_id
                            )
                            if version:
                                version_dict = version.to_dict()
                                version_map[agent['agent_id']] = version_dict
                        except Exception as e:
                            logger.warning(f"Failed to load version {version_id} for agent {agent['agent_id']}: {e}")
                            continue
                        
            except Exception as e:
                logger.warning(f"Failed to batch load agent versions: {e}")
                version_map = {}

    async def _passes_complex_filters(
        self, 
        agent_row: Dict[str, Any], 
        version_map: Dict[str, Dict[str, Any]], 
        filters: AgentFilters
    ) -> bool:
        # Load agent with config
        agent = self.loader._row_to_agent_data(agent_row)
        version_data = version_map.get(agent.agent_id)
        
        if version_data:
            self.loader._apply_version_config(agent, version_data)
        elif agent.is_suna_default:
            await self.loader._load_suna_config(agent, agent.account_id)
        else:
            # No config available, use empty defaults for filtering
            agent.configured_mcps = []
            agent.agentpress_tools = {}
        
        configured_mcps = agent.configured_mcps or []
        agentpress_tools = agent.agentpress_tools or {}
        
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
        agent_tool_counts = []
        for agent_row in agents:
            agent = self.loader._row_to_agent_data(agent_row)
            version_data = version_map.get(agent.agent_id)
            
            if version_data:
                self.loader._apply_version_config(agent, version_data)
            elif agent.is_suna_default:
                await self.loader._load_suna_config(agent, agent.account_id)
            
            configured_mcps = agent.configured_mcps or []
            agentpress_tools = agent.agentpress_tools or {}
            
            mcp_count = len(configured_mcps) if configured_mcps else 0
            agentpress_count = sum(
                1 for tool_data in agentpress_tools.values()
                if tool_data and isinstance(tool_data, dict) and tool_data.get('enabled', False)
            ) if agentpress_tools else 0
            
            tools_count = mcp_count + agentpress_count
            agent_tool_counts.append((agent_row, tools_count))
        
        agent_tool_counts.sort(key=lambda x: x[1], reverse=True)
        return [agent_row for agent_row, _ in agent_tool_counts]
    
    async def _load_agents_with_configs(
        self,
        agent_rows: List[Dict[str, Any]],
        version_map: Dict[str, Dict[str, Any]]
    ) -> List[Dict[str, Any]]:
        """
        Load agents and apply their configurations from version_map.
        
        Args:
            agent_rows: List of agent database rows
            version_map: Pre-fetched version data by agent_id
            
        Returns:
            List of API response dictionaries
        """
        agent_datas = []
        for row in agent_rows:
            agent = self.loader._row_to_agent_data(row)
            
            # Apply config if available
            version_data = version_map.get(agent.agent_id)
            if version_data:
                self.loader._apply_version_config(agent, version_data)
                agent.config_loaded = True
            elif agent.is_suna_default:
                await self.loader._load_suna_config(agent, agent.account_id)
                agent.config_loaded = True
            
            agent_datas.append(agent.to_dict())
        
        return agent_datas

    async def _transform_agent_data(
        self, 
        agent_row: Dict[str, Any], 
        load_config: bool = False
    ) -> Dict[str, Any]:
        """
        Transform agent database row to API response.
        
        Args:
            agent_row: Raw agent database row
            load_config: Whether to include full configuration
            
        Returns:
            API response dictionary
        """
        # Use unified loader for consistent transformation
        agent_data = self.loader._row_to_agent_data(agent_row)
        
        # Load config if needed and version exists
        if load_config and agent_data.current_version_id:
            # Note: For list operations, we typically don't load individual configs
            # Instead, use batch loading via _load_agents_with_configs
            pass
        
        return agent_data.to_dict()

    async def _transform_template_to_agent_format(self, template_data: Dict[str, Any]) -> Dict[str, Any]:
        """Transform template to agent format using unified loader."""
        agent_data = await self.loader.load_template(template_data, fetch_creator_name=True)
        result = agent_data.to_dict()
        
        # Add template-specific fields
        result.update({
            "template_id": template_data.get('template_id'),
            "mcp_requirements": template_data.get('mcp_requirements', []),
            "marketplace_published_at": template_data.get('marketplace_published_at'),
            "download_count": template_data.get('download_count', 0),
            "creator_name": agent_data.metadata.get('creator_name'),
            "creator_id": template_data.get('creator_id'),
            "is_kortix_team": template_data.get('is_kortix_team', False)
        })
        
        return result 