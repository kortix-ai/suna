import json
import asyncio
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Dict, List, Any, Optional
from uuid import uuid4, UUID
from enum import Enum

from core.services.supabase import DBConnection
from core.utils.logger import logger

MCP_CONFIG_QUERY_TIMEOUT = 10.0


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
            'model': self.model,
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
            
        from core.versioning import repo as versioning_repo
        
        access_info = await versioning_repo.check_agent_access(agent_id, user_id)
        return access_info["is_owner"], access_info["is_public"]
    
    async def _get_next_version_number(self, agent_id: str) -> int:
        from core.versioning import repo as versioning_repo
        return await versioning_repo.get_next_version_number(agent_id)
    
    async def _count_versions(self, agent_id: str) -> int:
        from core.versioning import repo as versioning_repo
        return await versioning_repo.count_agent_versions(agent_id)
    
    async def _update_agent_current_version(self, agent_id: str, version_id: str, version_count: int):
        from core.versioning import repo as versioning_repo
        from core.agents import repo as agents_repo
        
        # Update agent's current version ID
        await versioning_repo.update_agent_current_version(agent_id, version_id)
        
        # Update version count using agents repo (since it's in agents table)
        await versioning_repo.update_agent_version_stats(agent_id, version_count)
        
        from core.cache.runtime_cache import invalidate_mcp_version_config
        await invalidate_mcp_version_config(agent_id)
        logger.debug(f"Invalidated MCP config cache for agent {agent_id} after version update")
    
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
        
        from core.agents import repo as agents_repo
        from core.versioning import repo as versioning_repo
        
        # Get current agent info
        agent_info = await agents_repo.get_agent_by_id(agent_id)
        if not agent_info:
            raise Exception("Agent not found")

        previous_version_id = agent_info.get('current_version_id')
        
        # Retry logic to handle race conditions in version number generation
        max_retries = 3
        for attempt in range(max_retries):
            try:
                # Get next version number
                version_number = await versioning_repo.get_next_version_number(agent_id)
                
                if not version_name:
                    version_name = f"v{version_number}"
                        
                triggers = await versioning_repo.get_agent_triggers(agent_id)
                for trigger in triggers:
                    if 'config' in trigger and isinstance(trigger['config'], str):
                        try:
                            import json
                            trigger['config'] = json.loads(trigger['config'])
                        except json.JSONDecodeError:
                            logger.warning(f"Failed to parse trigger config for {trigger.get('trigger_id')}")
                            trigger['config'] = {}
                
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
                        'triggers': triggers
                    }
                }
                
                from core.versioning import repo as versioning_repo
                
                await versioning_repo.create_agent_version_with_config(
                    version_id=version.version_id,
                    agent_id=version.agent_id,
                    version_number=version.version_number,
                    version_name=version.version_name,
                    system_prompt=version.system_prompt,
                    model=version.model,
                    configured_mcps=version.configured_mcps,
                    custom_mcps=normalized_custom_mcps,
                    agentpress_tools=version.agentpress_tools,
                    triggers=triggers,
                    created_by=version.created_by,
                    change_description=version.change_description,
                    previous_version_id=version.previous_version_id
                )
                
                version_count = await self._count_versions(agent_id)
                await self._update_agent_current_version(agent_id, version.version_id, version_count)
                
                try:
                    from core.cache.runtime_cache import invalidate_agent_config_cache
                    await invalidate_agent_config_cache(agent_id)
                    logger.debug(f"🗑️ Invalidated cache for agent {agent_id} after version create")
                except Exception as e:
                    logger.warning(f"Failed to invalidate cache for agent {agent_id}: {e}")
                
                logger.debug(f"Created version {version.version_name} for agent {agent_id}")
                return version
                
            except Exception as e:
                error_msg = str(e)
                if "duplicate key value violates unique constraint" in error_msg and "agent_versions_agent_id_version_number_key" in error_msg:
                    if attempt < max_retries - 1:
                        await asyncio.sleep(0.1 * (attempt + 1))
                        logger.warning(f"Version number conflict for agent {agent_id}, attempt {attempt + 1}/{max_retries}, retrying...")
                        continue
                    else:
                        logger.error(f"Failed to create version after {max_retries} attempts due to version conflicts")
                        raise VersionConflictError("Unable to create version due to concurrent modifications. Please try again.")
                else:
                    raise e
    
    async def get_version(self, agent_id: str, version_id: str, user_id: str) -> AgentVersion:
        is_owner, is_public = await self._verify_and_authorize_agent_access(agent_id, user_id)
        if not is_owner and not is_public:
            raise UnauthorizedError("You don't have permission to view this version")
        
        from core.versioning import repo as versioning_repo
        
        result = await versioning_repo.get_agent_version_by_id(agent_id, version_id)
        
        if not result:
            raise VersionNotFoundError(f"Version {version_id} not found")
        
        return self._version_from_db_row(result)
    
    async def get_active_version(self, agent_id: str, user_id: str = "system") -> Optional[AgentVersion]:
        is_owner, is_public = await self._verify_and_authorize_agent_access(agent_id, user_id)
        if not is_owner and not is_public:
            raise UnauthorizedError("You don't have permission to view this agent")
        
        from core.versioning import repo as versioning_repo
        
        result = await versioning_repo.get_agent_current_version(agent_id)
        
        if not result:
            logger.warning(f"No current version found for agent {agent_id}")
            return None
        
        version = self._version_from_db_row(result)
        logger.debug(f"Retrieved active version for agent {agent_id}: model='{version.model}', version_name='{version.version_name}'")
        return version
    
    async def get_all_versions(self, agent_id: str, user_id: str) -> List[AgentVersion]:
        is_owner, is_public = await self._verify_and_authorize_agent_access(agent_id, user_id)
        if not is_owner and not is_public:
            raise UnauthorizedError("You don't have permission to view versions")
        
        from core.versioning import repo as versioning_repo
        
        rows = await versioning_repo.get_agent_versions_list(agent_id)
        versions = [self._version_from_db_row(row) for row in rows]
        return versions
    
    async def activate_version(self, agent_id: str, version_id: str, user_id: str) -> None:
        is_owner, _ = await self._verify_and_authorize_agent_access(agent_id, user_id)
        if not is_owner:
            raise UnauthorizedError("You don't have permission to activate versions")
        
        from core.versioning import repo as versioning_repo
        
        version_data = await versioning_repo.get_agent_version_by_id(agent_id, version_id)
        
        if not version_data:
            raise VersionNotFoundError(f"Version {version_id} not found")
        
        # Deactivate all versions, then activate the target
        await versioning_repo.deactivate_agent_versions(agent_id)
        await versioning_repo.activate_agent_version(version_id)
        
        version_count = await self._count_versions(agent_id)
        await self._update_agent_current_version(agent_id, version_id, version_count)
        
        # Invalidate agent config cache (active version changed)
        try:
            from core.cache.runtime_cache import invalidate_agent_config_cache
            await invalidate_agent_config_cache(agent_id)
            logger.debug(f"🗑️ Invalidated cache for agent {agent_id} after version activate")
        except Exception as e:
            logger.warning(f"Failed to invalidate cache for agent {agent_id}: {e}")
        
        logger.debug(f"Activated version {version_data['version_name']} for agent {agent_id}")
        
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
    
    async def get_current_mcp_config(self, agent_id: str, user_id: str = "system") -> Optional[Dict[str, Any]]:
        import time
        start_time = time.time()
        
        from core.cache.runtime_cache import (
            get_cached_mcp_version_config,
            set_cached_mcp_version_config
        )
        
        t1 = time.time()
        cached = await get_cached_mcp_version_config(agent_id)
        cache_time = (time.time() - t1) * 1000
        
        if cached:
            logger.debug(f"⚡ [MCP CONFIG] Cache HIT for {agent_id} in {cache_time:.1f}ms")
            cached['account_id'] = user_id
            return cached
        
        logger.debug(f"⏱️ [MCP CONFIG] Cache MISS for {agent_id}, fetching from DB (cache check: {cache_time:.1f}ms)")
        
        try:
            t2 = time.time()
            client = await self._get_client()
            client_time = (time.time() - t2) * 1000
            logger.debug(f"⏱️ [MCP CONFIG] DB client acquired in {client_time:.1f}ms")
            
            t3 = time.time()
            rpc_result = await client.rpc('get_agent_mcp_config', {'p_agent_id': agent_id}).execute()
            rpc_time = (time.time() - t3) * 1000
            logger.debug(f"⏱️ [MCP CONFIG] RPC query: {rpc_time:.1f}ms")
            
            if not rpc_result.data:
                logger.warning(f"⚠️ [MCP CONFIG] No config found for agent {agent_id}, using empty")
                empty_config = {'custom_mcp': [], 'configured_mcps': [], 'account_id': user_id}
                await set_cached_mcp_version_config(agent_id, {'custom_mcp': [], 'configured_mcps': []})
                return empty_config
            
            result_data = rpc_result.data
            if isinstance(result_data, list) and len(result_data) > 0:
                result_data = result_data[0]
            
            custom_mcps = result_data.get('custom_mcp', []) if result_data else []
            configured_mcps = result_data.get('configured_mcps', []) if result_data else []
            
            cache_data = {
                'custom_mcp': custom_mcps,
                'configured_mcps': configured_mcps,
            }
            
            t4 = time.time()
            await set_cached_mcp_version_config(agent_id, cache_data)
            cache_set_time = (time.time() - t4) * 1000
            
            total_time = (time.time() - start_time) * 1000
            logger.info(f"✅ [MCP CONFIG] Loaded for {agent_id} in {total_time:.1f}ms (client:{client_time:.0f}ms, rpc:{rpc_time:.0f}ms, cache_set:{cache_set_time:.0f}ms)")
            
            final_config = {
                'custom_mcp': custom_mcps,
                'configured_mcps': configured_mcps,
                'account_id': user_id
            }
            
            return final_config
            
        except Exception as e:
            total_time = (time.time() - start_time) * 1000
            logger.error(f"❌ [MCP CONFIG] Error loading for agent {agent_id} after {total_time:.1f}ms: {e}", exc_info=True)
            return {'custom_mcp': [], 'configured_mcps': [], 'account_id': user_id}

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