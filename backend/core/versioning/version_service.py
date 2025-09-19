import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Dict, List, Any, Optional
from uuid import uuid4, UUID
from enum import Enum

from core.services.supabase import DBConnection
from core.utils.logger import logger


class VersionStatus(Enum):
    ACTIVE = "active"
    INACTIVE = "inactive"
    ARCHIVED = "archived"


@dataclass
class AgentVersion:
    version_id: str
    agent_id: str
    version_number: int
    version_name: str
    system_prompt: str
    model: Optional[str] = None  # Add model field
    configured_mcps: List[Dict[str, Any]] = field(default_factory=list)
    custom_mcps: List[Dict[str, Any]] = field(default_factory=list)
    agentpress_tools: Dict[str, Any] = field(default_factory=dict)
    is_active: bool = True
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    created_by: str = ""
    change_description: Optional[str] = None
    previous_version_id: Optional[str] = None
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            'version_id': self.version_id,
            'agent_id': self.agent_id,
            'version_number': self.version_number,
            'version_name': self.version_name,
            'system_prompt': self.system_prompt,
            'model': self.model,  # Add model to dict output
            'configured_mcps': self.configured_mcps,
            'custom_mcps': self.custom_mcps,
            'agentpress_tools': self.agentpress_tools,
            'is_active': self.is_active,
            'status': VersionStatus.ACTIVE.value if self.is_active else VersionStatus.INACTIVE.value,
            'created_at': self.created_at.isoformat(),
            'updated_at': self.updated_at.isoformat(),
            'created_by': self.created_by,
            'change_description': self.change_description,
            'previous_version_id': self.previous_version_id
        }


class VersionServiceError(Exception):
    pass

class VersionNotFoundError(VersionServiceError):
    pass

class AgentNotFoundError(VersionServiceError):
    pass

class UnauthorizedError(VersionServiceError):
    pass

class InvalidVersionError(VersionServiceError):
    pass

class VersionConflictError(VersionServiceError):
    pass


class VersionService:
    def __init__(self):
        self.db = DBConnection()
    
    async def _get_client(self):
        return await self.db.client
    
    async def _verify_and_authorize_agent_access(self, agent_id: str, user_id: str) -> tuple[bool, bool]:
        if user_id == "system":
            return True, True
            
        client = await self._get_client()
        
        owner_result = await client.table('agents').select('account_id').eq(
            'agent_id', agent_id
        ).eq('account_id', user_id).execute()
        
        is_owner = bool(owner_result.data)
        
        public_result = await client.table('agents').select('is_public').eq(
            'agent_id', agent_id
        ).execute()
        
        is_public = bool(public_result.data and public_result.data[0].get('is_public', False))
        
        return is_owner, is_public
    
    async def _get_next_version_number(self, agent_id: str) -> int:
        client = await self._get_client()
        
        result = await client.table('agent_versions').select(
            'version_number'
        ).eq('agent_id', agent_id).order(
            'version_number', desc=True
        ).limit(1).execute()
        
        if not result.data:
            return 1
        
        return result.data[0]['version_number'] + 1
    
    async def _count_versions(self, agent_id: str) -> int:
        client = await self._get_client()
        
        result = await client.table('agent_versions').select(
            'version_id', count='exact'
        ).eq('agent_id', agent_id).execute()
        
        return result.count or 0
    
    async def _update_agent_current_version(self, agent_id: str, version_id: str, version_count: int):
        client = await self._get_client()
        
        data = {
            'current_version_id': version_id,
            'version_count': version_count
        }
        
        result = await client.table('agents').update(data).eq(
            'agent_id', agent_id
        ).execute()
        
        if not result.data:
            raise Exception("Failed to update agent current version")
    
    def _version_from_db_row(self, row: Dict[str, Any]) -> AgentVersion:
        config = row.get('config', {})
        tools = config.get('tools', {})
        
        return AgentVersion(
            version_id=row['version_id'],
            agent_id=row['agent_id'],
            version_number=row['version_number'],
            version_name=row['version_name'],
            system_prompt=config.get('system_prompt', ''),
            model=config.get('model'),  # Extract model from config
            configured_mcps=tools.get('mcp', []),
            custom_mcps=tools.get('custom_mcp', []),
            agentpress_tools=tools.get('agentpress', {}),
            is_active=row.get('is_active', False),
            created_at=datetime.fromisoformat(row['created_at'].replace('Z', '+00:00')),
            updated_at=datetime.fromisoformat(row['updated_at'].replace('Z', '+00:00')),
            created_by=row['created_by'],
            change_description=row.get('change_description'),
            previous_version_id=row.get('previous_version_id')
        )
    
    def _normalize_custom_mcps(self, custom_mcps: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        normalized = []
        for mcp in custom_mcps:
            if not isinstance(mcp, dict):
                continue
                
            mcp_copy = mcp.copy()
            config = mcp_copy.get('config', {})
            mcp_type = mcp_copy.get('type', 'sse')
            mcp_name = mcp_copy.get('name', '')
            
            if mcp_type == 'composio':
                if 'mcp_qualified_name' not in mcp_copy:
                    mcp_copy['mcp_qualified_name'] = config.get('mcp_qualified_name') or config.get('qualifiedName') or f"composio.{mcp_name.lower().replace(' ', '_')}"
                if 'toolkit_slug' not in mcp_copy:
                    mcp_copy['toolkit_slug'] = config.get('toolkit_slug') or mcp_name.lower().replace(' ', '_')
                
                mcp_copy['config'] = {k: v for k, v in config.items() if k == 'profile_id'}
                
            elif mcp_type == 'pipedream':
                if 'qualifiedName' not in mcp_copy:
                    app_slug = config.get('headers', {}).get('x-pd-app-slug') or mcp_name.lower().replace(' ', '')
                    mcp_copy['qualifiedName'] = f"pipedream:{app_slug}"
                if 'app_slug' not in mcp_copy:
                    mcp_copy['app_slug'] = config.get('headers', {}).get('x-pd-app-slug') or mcp_name.lower().replace(' ', '')
            
            normalized.append(mcp_copy)
        return normalized

    async def create_version(
        self,
        agent_id: str,
        user_id: str,
        system_prompt: str,
        configured_mcps: List[Dict[str, Any]],
        custom_mcps: List[Dict[str, Any]],
        agentpress_tools: Dict[str, Any],
        model: Optional[str] = None,
        version_name: Optional[str] = None,
        change_description: Optional[str] = None
    ) -> AgentVersion:
        
        logger.debug(f"Creating version for agent {agent_id}")
        client = await self.db.client
        
        is_owner, _ = await self._verify_and_authorize_agent_access(agent_id, user_id)
        if not is_owner:
            raise UnauthorizedError("Unauthorized to create version for this agent")
        
        current_result = await client.table('agents').select('current_version_id, version_count').eq('agent_id', agent_id).single().execute()
        
        if not current_result.data:
            raise Exception("Agent not found")
        
        previous_version_id = current_result.data.get('current_version_id')
        
        max_version_result = await client.table('agent_versions').select('version_number').eq('agent_id', agent_id).order('version_number', desc=True).limit(1).execute()
        max_version_number = 0
        if max_version_result.data and max_version_result.data[0].get('version_number'):
            max_version_number = max_version_result.data[0]['version_number']
        version_number = max_version_number + 1
        
        if not version_name:
            version_name = f"v{version_number}"
        
        workflows_result = await client.table('agent_workflows').select('*').eq('agent_id', agent_id).execute()
        workflows = workflows_result.data if workflows_result.data else []
        
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
        
        normalized_custom_mcps = self._normalize_custom_mcps(custom_mcps)
        
        version = AgentVersion(
            version_id=str(uuid4()),
            agent_id=agent_id,
            version_number=version_number,
            version_name=version_name,
            system_prompt=system_prompt,
            model=model,
            configured_mcps=configured_mcps,
            custom_mcps=normalized_custom_mcps,
            agentpress_tools=agentpress_tools,
            is_active=True,
            created_at=datetime.now(timezone.utc),
            updated_at=datetime.now(timezone.utc),
            created_by=user_id,
            change_description=change_description,
            previous_version_id=previous_version_id
        )
        
        data = {
            'version_id': version.version_id,
            'agent_id': version.agent_id,
            'version_number': version.version_number,
            'version_name': version.version_name,
            'is_active': version.is_active,
            'created_at': version.created_at.isoformat(),
            'updated_at': version.updated_at.isoformat(),
            'created_by': version.created_by,
            'change_description': version.change_description,
            'previous_version_id': version.previous_version_id,
            'config': {
                'system_prompt': version.system_prompt,
                'model': version.model,
                'tools': {
                    'agentpress': version.agentpress_tools,
                    'mcp': version.configured_mcps,
                    'custom_mcp': normalized_custom_mcps
                },
                'workflows': workflows,
                'triggers': triggers
            }
        }
        
        result = await client.table('agent_versions').insert(data).execute()
        
        if not result.data:
            raise Exception("Failed to create version")
        
        version_count = await self._count_versions(agent_id)
        await self._update_agent_current_version(agent_id, version.version_id, version_count)
        
        logger.debug(f"Created version {version.version_name} for agent {agent_id}")
        return version
    
    async def get_version(self, agent_id: str, version_id: str, user_id: str) -> AgentVersion:
        is_owner, is_public = await self._verify_and_authorize_agent_access(agent_id, user_id)
        if not is_owner and not is_public:
            raise UnauthorizedError("You don't have permission to view this version")
        
        client = await self._get_client()
        
        result = await client.table('agent_versions').select('*').eq(
            'version_id', version_id
        ).eq('agent_id', agent_id).execute()
        
        if not result.data:
            raise VersionNotFoundError(f"Version {version_id} not found")
        
        return self._version_from_db_row(result.data[0])
    
    async def get_active_version(self, agent_id: str, user_id: str = "system") -> Optional[AgentVersion]:
        is_owner, is_public = await self._verify_and_authorize_agent_access(agent_id, user_id)
        if not is_owner and not is_public:
            raise UnauthorizedError("You don't have permission to view this agent")
        
        client = await self._get_client()
        
        agent_result = await client.table('agents').select('current_version_id').eq('agent_id', agent_id).execute()
        if not agent_result.data or not agent_result.data[0].get('current_version_id'):
            logger.warning(f"No current_version_id found for agent {agent_id}")
            return None
        
        current_version_id = agent_result.data[0]['current_version_id']
        logger.debug(f"Agent {agent_id} current_version_id: {current_version_id}")
        
        result = await client.table('agent_versions').select('*').eq(
            'version_id', current_version_id
        ).eq('agent_id', agent_id).execute()
        
        if not result.data:
            logger.warning(f"Current version {current_version_id} not found for agent {agent_id}")
            return None
        
        version = self._version_from_db_row(result.data[0])
        logger.debug(f"Retrieved active version for agent {agent_id}: model='{version.model}', version_name='{version.version_name}'")
        return version
    
    async def get_all_versions(self, agent_id: str, user_id: str) -> List[AgentVersion]:
        is_owner, is_public = await self._verify_and_authorize_agent_access(agent_id, user_id)
        if not is_owner and not is_public:
            raise UnauthorizedError("You don't have permission to view versions")
        
        client = await self._get_client()
        
        result = await client.table('agent_versions').select('*').eq(
            'agent_id', agent_id
        ).order('version_number', desc=True).execute()
        
        versions = [self._version_from_db_row(row) for row in result.data]
        return versions
    
    async def activate_version(self, agent_id: str, version_id: str, user_id: str) -> None:
        is_owner, _ = await self._verify_and_authorize_agent_access(agent_id, user_id)
        if not is_owner:
            raise UnauthorizedError("You don't have permission to activate versions")
        
        client = await self._get_client()
        
        version_result = await client.table('agent_versions').select('*').eq(
            'version_id', version_id
        ).eq('agent_id', agent_id).execute()
        
        if not version_result.data:
            raise VersionNotFoundError(f"Version {version_id} not found")
        
        version = version_result.data[0]
        
        await client.table('agent_versions').update({
            'is_active': False,
            'updated_at': datetime.now(timezone.utc).isoformat()
        }).eq('agent_id', agent_id).eq('is_active', True).execute()
        
        await client.table('agent_versions').update({
            'is_active': True,
            'updated_at': datetime.now(timezone.utc).isoformat()
        }).eq('version_id', version_id).execute()
        
        version_count = await self._count_versions(agent_id)
        await self._update_agent_current_version(agent_id, version_id, version_count)
        
        logger.debug(f"Activated version {version['version_name']} for agent {agent_id}")
    
    async def compare_versions(
        self,
        agent_id: str,
        version1_id: str,
        version2_id: str,
        user_id: str
    ) -> Dict[str, Any]:
        version1 = await self.get_version(agent_id, version1_id, user_id)
        version2 = await self.get_version(agent_id, version2_id, user_id)
        
        differences = self._calculate_differences(version1, version2)
        
        return {
            'version1': version1.to_dict(),
            'version2': version2.to_dict(),
            'differences': differences
        }
    
    def _calculate_differences(self, v1: AgentVersion, v2: AgentVersion) -> List[Dict[str, Any]]:
        differences = []
        
        if v1.system_prompt != v2.system_prompt:
            differences.append({
                'field': 'system_prompt',
                'type': 'modified',
                'old_value': v1.system_prompt,
                'new_value': v2.system_prompt
            })
        
        if v1.model != v2.model:
            differences.append({
                'field': 'model',
                'type': 'modified',
                'old_value': v1.model,
                'new_value': v2.model
            })
        
        v1_tools = set(v1.agentpress_tools.keys())
        v2_tools = set(v2.agentpress_tools.keys())
        
        for tool in v2_tools - v1_tools:
            differences.append({
                'field': f'tool.{tool}',
                'type': 'added',
                'new_value': v2.agentpress_tools[tool]
            })
        
        for tool in v1_tools - v2_tools:
            differences.append({
                'field': f'tool.{tool}',
                'type': 'removed',
                'old_value': v1.agentpress_tools[tool]
            })
        
        for tool in v1_tools & v2_tools:
            if v1.agentpress_tools[tool] != v2.agentpress_tools[tool]:
                differences.append({
                    'field': f'tool.{tool}',
                    'type': 'modified',
                    'old_value': v1.agentpress_tools[tool],
                    'new_value': v2.agentpress_tools[tool]
                })
        
        return differences
    
    async def rollback_to_version(
        self,
        agent_id: str,
        version_id: str,
        user_id: str
    ) -> AgentVersion:
        version_to_restore = await self.get_version(agent_id, version_id, user_id)
        
        is_owner, _ = await self._verify_and_authorize_agent_access(agent_id, user_id)
        if not is_owner:
            raise UnauthorizedError("You don't have permission to rollback versions")
        
        new_version = await self.create_version(
            agent_id=agent_id,
            user_id=user_id,
            system_prompt=version_to_restore.system_prompt,
            configured_mcps=version_to_restore.configured_mcps,
            custom_mcps=version_to_restore.custom_mcps,
            agentpress_tools=version_to_restore.agentpress_tools,
            model=version_to_restore.model,
            change_description=f"Rolled back to version {version_to_restore.version_name}"
        )
        
        return new_version
    
    async def update_version_details(
        self,
        agent_id: str,
        version_id: str,
        user_id: str,
        version_name: Optional[str] = None,
        change_description: Optional[str] = None
    ) -> AgentVersion:
        is_owner, _ = await self._verify_and_authorize_agent_access(agent_id, user_id)
        if not is_owner:
            raise UnauthorizedError("You don't have permission to update this version")
        
        client = await self._get_client()
        
        version_result = await client.table('agent_versions').select('*').eq(
            'version_id', version_id
        ).eq('agent_id', agent_id).execute()
        
        if not version_result.data:
            raise VersionNotFoundError(f"Version {version_id} not found")
        
        update_data = {
            'updated_at': datetime.now(timezone.utc).isoformat()
        }
        
        if version_name is not None:
            update_data['version_name'] = version_name
        if change_description is not None:
            update_data['change_description'] = change_description
        
        result = await client.table('agent_versions').update(update_data).eq(
            'version_id', version_id
        ).execute()
        
        if not result.data:
            raise Exception("Failed to update version")
        
        return self._version_from_db_row(result.data[0])


_version_service_instance = None

async def get_version_service() -> VersionService:
    global _version_service_instance
    if _version_service_instance is None:
        _version_service_instance = VersionService()
    return _version_service_instance 