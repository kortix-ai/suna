"""
Unified agent loading and transformation.

This module consolidates all agent data loading logic into one place,
eliminating duplication across agent_crud, agent_service, and agent_runs.
"""
from typing import Dict, Any, Optional
from dataclasses import dataclass
from core.utils.logger import logger
from core.services.supabase import DBConnection


@dataclass
class AgentData:
    """
    Complete agent data including configuration.
    
    This is the single source of truth for agent representation.
    """
    # Core fields from agents table
    agent_id: str
    name: str
    description: Optional[str]
    account_id: str
    is_default: bool
    is_public: bool
    tags: list
    icon_name: Optional[str]
    icon_color: Optional[str]
    icon_background: Optional[str]
    created_at: str
    updated_at: str
    current_version_id: Optional[str]
    version_count: int
    metadata: Optional[Dict[str, Any]]
    
    # Configuration fields (from version or fallback)
    system_prompt: Optional[str] = None
    model: Optional[str] = None
    configured_mcps: Optional[list] = None
    custom_mcps: Optional[list] = None
    agentpress_tools: Optional[Dict[str, Any]] = None
    triggers: Optional[list] = None
    
    # Version info
    version_name: Optional[str] = None
    version_number: Optional[int] = None
    version_created_at: Optional[str] = None
    version_updated_at: Optional[str] = None
    version_created_by: Optional[str] = None
    
    # Metadata flags
    is_suna_default: bool = False
    centrally_managed: bool = False
    config_loaded: bool = False
    restrictions: Optional[Dict[str, Any]] = None
    
    def to_pydantic_model(self):
        """Convert to AgentResponse Pydantic model."""
        from core.api_models.agents import AgentResponse, AgentVersionResponse
        
        current_version = None
        if self.config_loaded and self.version_number is not None:
            current_version = AgentVersionResponse(
                version_id=self.current_version_id,
                agent_id=self.agent_id,
                version_number=self.version_number,
                version_name=self.version_name or 'v1',
                system_prompt=self.system_prompt or '',
                model=self.model,
                configured_mcps=self.configured_mcps or [],
                custom_mcps=self.custom_mcps or [],
                agentpress_tools=self.agentpress_tools or {},
                is_active=True,
                created_at=self.version_created_at or self.created_at,
                updated_at=self.version_updated_at or self.updated_at,
                created_by=self.version_created_by
            )
        
        return AgentResponse(
            agent_id=self.agent_id,
            name=self.name,
            description=self.description,
            system_prompt=self.system_prompt,
            model=self.model,
            configured_mcps=self.configured_mcps,
            custom_mcps=self.custom_mcps,
            agentpress_tools=self.agentpress_tools,
            is_default=self.is_default,
            is_public=self.is_public,
            tags=self.tags,
            icon_name=self.icon_name,
            icon_color=self.icon_color,
            icon_background=self.icon_background,
            created_at=self.created_at,
            updated_at=self.updated_at,
            current_version_id=self.current_version_id,
            version_count=self.version_count,
            current_version=current_version,
            metadata=self.metadata
        )
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for API responses."""
        result = {
            "agent_id": self.agent_id,
            "name": self.name,
            "description": self.description,
            "account_id": self.account_id,
            "is_default": self.is_default,
            "is_public": self.is_public,
            "tags": self.tags,
            "icon_name": self.icon_name,
            "icon_color": self.icon_color,
            "icon_background": self.icon_background,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "current_version_id": self.current_version_id,
            "version_count": self.version_count,
            "metadata": self.metadata,
        }
        
        # Only include config if loaded
        if self.config_loaded:
            result.update({
                "system_prompt": self.system_prompt,
                "model": self.model,
                "configured_mcps": self.configured_mcps,
                "custom_mcps": self.custom_mcps,
                "agentpress_tools": self.agentpress_tools,
                "triggers": self.triggers,
                "version_name": self.version_name,
                "is_suna_default": self.is_suna_default,
                "centrally_managed": self.centrally_managed,
                "restrictions": self.restrictions,
            })
            
            # Include version details if available
            if self.version_number is not None:
                result["current_version"] = {
                    "version_id": self.current_version_id,
                    "version_number": self.version_number,
                    "version_name": self.version_name,
                    "created_at": self.version_created_at,
                    "updated_at": self.version_updated_at,
                    "created_by": self.version_created_by,
                }
        else:
            # Indicate config not loaded
            result.update({
                "system_prompt": None,
                "configured_mcps": [],  # Must be list, not None for Pydantic
                "custom_mcps": [],      # Must be list, not None for Pydantic  
                "agentpress_tools": {}, # Must be dict, not None for Pydantic
            })
        
        return result


class AgentLoader:
    """
    Unified agent loading service.
    
    Handles all agent data loading with consistent behavior:
    - Single agent: loads full config
    - List operations: loads metadata only (fast)
    - Batch loading: efficient version fetching
    """
    
    def __init__(self, db: Optional[DBConnection] = None):
        self.db = db or DBConnection()
    
    async def load_agent(
        self, 
        agent_id: str, 
        user_id: str,
        load_config: bool = True
    ) -> AgentData:
        """
        Load a single agent with full configuration.
        
        Args:
            agent_id: Agent ID to load
            user_id: User ID for authorization
            load_config: Whether to load full version configuration
            
        Returns:
            AgentData with complete information
            
        Raises:
            ValueError: If agent not found or access denied
        """
        client = await self.db.client
        
        # Fetch agent metadata
        result = await client.table('agents').select('*').eq('agent_id', agent_id).execute()
        
        if not result.data:
            raise ValueError(f"Agent {agent_id} not found")
        
        agent_row = result.data[0]
        
        # Check access
        if agent_row['account_id'] != user_id and not agent_row.get('is_public', False):
            raise ValueError(f"Access denied to agent {agent_id}")
        
        # Create base AgentData
        agent_data = self._row_to_agent_data(agent_row)
        
        # Load configuration if requested
        if load_config and agent_row.get('current_version_id'):
            await self._load_agent_config(agent_data, user_id)
        
        return agent_data
    
    async def load_agents_list(
        self,
        agent_rows: list,
        load_config: bool = False
    ) -> list[AgentData]:
        """
        Load multiple agents efficiently.
        
        Args:
            agent_rows: List of agent database rows
            load_config: Whether to batch-load configurations
            
        Returns:
            List of AgentData objects
        """
        agents = [self._row_to_agent_data(row) for row in agent_rows]
        
        if load_config:
            await self._batch_load_configs(agents)
        
        return agents
    
    async def load_template(
        self,
        template_row: Dict[str, Any],
        fetch_creator_name: bool = False
    ) -> AgentData:
        """
        Load a template as AgentData.
        
        Templates are basically agents with pre-configured settings.
        
        Args:
            template_row: Template database row
            fetch_creator_name: Whether to fetch creator name
            
        Returns:
            AgentData representing the template
        """
        metadata = template_row.get('metadata', {}) or {}
        
        # Fetch creator name if requested
        creator_name = None
        if fetch_creator_name and template_row.get('creator_id'):
            try:
                client = await self.db.client
                creator_result = await client.schema('basejump').from_('accounts').select(
                    'name, slug'
                ).eq('id', template_row['creator_id']).single().execute()
                if creator_result.data:
                    creator_name = creator_result.data.get('name') or creator_result.data.get('slug')
            except Exception as e:
                logger.warning(f"Failed to fetch creator name: {e}")
        
        # Update metadata
        metadata['is_template'] = True
        if creator_name:
            metadata['creator_name'] = creator_name
        
        # Create AgentData from template
        agent_data = AgentData(
            agent_id=template_row.get('template_id', ''),
            name=template_row.get('name', ''),
            description=template_row.get('description'),
            account_id=template_row.get('creator_id', ''),
            is_default=False,
            is_public=template_row.get('is_public', False),
            tags=template_row.get('tags', []),
            icon_name=template_row.get('icon_name'),
            icon_color=template_row.get('icon_color'),
            icon_background=template_row.get('icon_background'),
            created_at=template_row.get('created_at', ''),
            updated_at=template_row.get('updated_at'),
            current_version_id=None,
            version_count=0,
            metadata=metadata,
            # Template config is directly available
            system_prompt=template_row.get('system_prompt', ''),
            model=metadata.get('model'),
            configured_mcps=template_row.get('mcp_requirements', []),
            custom_mcps=[],
            agentpress_tools=template_row.get('agentpress_tools', {}),
            triggers=[],
            version_name='template',
            is_suna_default=False,
            centrally_managed=False,
            config_loaded=True,  # Templates have config built-in
            restrictions={}
        )
        
        return agent_data
    
    def _row_to_agent_data(self, row: Dict[str, Any]) -> AgentData:
        """Convert database row to AgentData."""
        metadata = row.get('metadata', {}) or {}
        
        return AgentData(
            agent_id=row['agent_id'],
            name=row['name'],
            description=row.get('description'),
            account_id=row['account_id'],
            is_default=row.get('is_default', False),
            is_public=row.get('is_public', False),
            tags=row.get('tags', []),
            icon_name=row.get('icon_name'),
            icon_color=row.get('icon_color'),
            icon_background=row.get('icon_background'),
            created_at=row['created_at'],
            updated_at=row.get('updated_at', row['created_at']),
            current_version_id=row.get('current_version_id'),
            version_count=row.get('version_count', 1),
            metadata=metadata,
            is_suna_default=metadata.get('is_suna_default', False),
            config_loaded=False
        )
    
    async def _load_agent_config(self, agent: AgentData, user_id: str):
        """Load full configuration for a single agent."""
        if agent.is_suna_default:
            await self._load_suna_config(agent, user_id)
        else:
            await self._load_custom_config(agent, user_id)
        
        agent.config_loaded = True
    
    async def _load_suna_config(self, agent: AgentData, user_id: Optional[str] = None):
        from core.suna_config import SUNA_CONFIG
        from core.config_helper import _extract_agentpress_tools_for_run
        
        agent.system_prompt = SUNA_CONFIG['system_prompt']
        agent.model = SUNA_CONFIG['model']
        agent.agentpress_tools = _extract_agentpress_tools_for_run(SUNA_CONFIG['agentpress_tools'])
        agent.centrally_managed = True
        agent.restrictions = {
            'system_prompt_editable': False,
            'tools_editable': False,
            'name_editable': False,
            'description_editable': False,
            'mcps_editable': True
        }
        
        if agent.current_version_id and user_id:
            try:
                from core.versioning.version_service import get_version_service
                version_service = await get_version_service()
                
                version = await version_service.get_version(
                    agent_id=agent.agent_id,
                    version_id=agent.current_version_id,
                    user_id=user_id
                )
                
                version_dict = version.to_dict()
                
                if 'config' in version_dict and version_dict['config']:
                    config = version_dict['config']
                    tools = config.get('tools', {})
                    
                    agent.configured_mcps = tools.get('mcp', [])
                    agent.custom_mcps = tools.get('custom_mcp', [])
                    agent.triggers = config.get('triggers', [])
                else:
                    agent.configured_mcps = version_dict.get('configured_mcps', [])
                    agent.custom_mcps = version_dict.get('custom_mcps', [])
                    agent.triggers = []
                    
                logger.debug(f"Loaded Suna config with {len(agent.configured_mcps)} configured MCPs and {len(agent.custom_mcps)} custom MCPs")
            except Exception as e:
                logger.warning(f"Failed to load MCPs from version for Suna agent {agent.agent_id}: {e}")
                agent.configured_mcps = []
                agent.custom_mcps = []
                agent.triggers = []
        else:
            agent.configured_mcps = []
            agent.custom_mcps = []
            agent.triggers = []
    
    async def _load_custom_config(self, agent: AgentData, user_id: str):
        """Load custom agent configuration from version."""
        if not agent.current_version_id:
            self._load_fallback_config(agent)
            return
        
        try:
            from core.versioning.version_service import get_version_service
            version_service = await get_version_service()
            
            version = await version_service.get_version(
                agent_id=agent.agent_id,
                version_id=agent.current_version_id,
                user_id=user_id
            )
            
            version_dict = version.to_dict()
            
            # Extract from new config format
            if 'config' in version_dict and version_dict['config']:
                config = version_dict['config']
                tools = config.get('tools', {})
                
                agent.system_prompt = config.get('system_prompt', '')
                agent.model = config.get('model')
                agent.configured_mcps = tools.get('mcp', [])
                agent.custom_mcps = tools.get('custom_mcp', [])
                
                from core.config_helper import _extract_agentpress_tools_for_run
                agent.agentpress_tools = _extract_agentpress_tools_for_run(tools.get('agentpress', {}))
                
                agent.triggers = config.get('triggers', [])
            else:
                # Old format compatibility
                agent.system_prompt = version_dict.get('system_prompt', '')
                agent.model = version_dict.get('model')
                agent.configured_mcps = version_dict.get('configured_mcps', [])
                agent.custom_mcps = version_dict.get('custom_mcps', [])
                
                from core.config_helper import _extract_agentpress_tools_for_run
                agent.agentpress_tools = _extract_agentpress_tools_for_run(
                    version_dict.get('agentpress_tools', {})
                )
                
                agent.triggers = []
            
            agent.version_name = version_dict.get('version_name', 'v1')
            agent.version_number = version_dict.get('version_number')
            agent.version_created_at = version_dict.get('created_at')
            agent.version_updated_at = version_dict.get('updated_at')
            agent.version_created_by = version_dict.get('created_by')
            agent.restrictions = {}
            
        except Exception as e:
            logger.warning(f"Failed to load version for agent {agent.agent_id}: {e}")
            self._load_fallback_config(agent)
    
    def _load_fallback_config(self, agent: AgentData):
        """Load safe fallback configuration."""
        from core.config_helper import _get_default_agentpress_tools, _extract_agentpress_tools_for_run
        
        agent.system_prompt = 'You are a helpful AI assistant.'
        agent.model = None
        agent.configured_mcps = []
        agent.custom_mcps = []
        agent.agentpress_tools = _extract_agentpress_tools_for_run(_get_default_agentpress_tools())
        agent.triggers = []
        agent.version_name = 'v1'
        agent.restrictions = {}
    
    async def _batch_load_configs(self, agents: list[AgentData]):
        """Batch load configurations for multiple agents."""
        
        # Get all version IDs for non-Suna agents
        version_ids = [a.current_version_id for a in agents if a.current_version_id and not a.is_suna_default]
        
        if not version_ids:
            # Only Suna agents, load their configs
            for agent in agents:
                if agent.is_suna_default:
                    await self._load_suna_config(agent, agent.account_id)
                    agent.config_loaded = True
            return
        
        try:
            # Use versioning service instead of direct config access
            from core.versioning.version_service import get_version_service
            version_service = await get_version_service()
            
            # Create version map using versioning service
            version_map = {}
            for agent in agents:
                if agent.current_version_id and not agent.is_suna_default:
                    try:
                        version = await version_service.get_version(
                            agent_id=agent.agent_id,
                            version_id=agent.current_version_id,
                            user_id=agent.account_id
                        )
                        if version:
                            version_map[agent.agent_id] = version.to_dict()
                    except Exception as e:
                        logger.warning(f"Failed to load version {agent.current_version_id} for agent {agent.agent_id}: {e}")
                        continue
            
            # Apply configs
            for agent in agents:
                if agent.is_suna_default:
                    await self._load_suna_config(agent, agent.account_id)
                    agent.config_loaded = True
                elif agent.agent_id in version_map:
                    self._apply_version_config(agent, version_map[agent.agent_id])
                    agent.config_loaded = True
                # else: leave config_loaded = False
                
        except Exception as e:
            logger.warning(f"Failed to batch load agent configs: {e}")
            # Fallback: load Suna configs only
            for agent in agents:
                if agent.is_suna_default:
                    await self._load_suna_config(agent, agent.account_id)
                    agent.config_loaded = True
    
    def _apply_version_config(self, agent: AgentData, version_row: Dict[str, Any]):
        """Apply version configuration to agent."""
        config = version_row.get('config') or {}
        tools = config.get('tools', {})
        
        from core.config_helper import _extract_agentpress_tools_for_run
        
        agent.system_prompt = config.get('system_prompt', '')
        agent.model = config.get('model')
        agent.configured_mcps = tools.get('mcp', [])
        agent.custom_mcps = tools.get('custom_mcp', [])
        agent.agentpress_tools = _extract_agentpress_tools_for_run(tools.get('agentpress', {}))
        agent.triggers = config.get('triggers', [])
        agent.version_name = version_row.get('version_name', 'v1')
        agent.version_number = version_row.get('version_number')
        agent.restrictions = {}


# Singleton instance
_loader = None

async def get_agent_loader() -> AgentLoader:
    """Get the global agent loader instance."""
    global _loader
    if _loader is None:
        _loader = AgentLoader()
    return _loader

