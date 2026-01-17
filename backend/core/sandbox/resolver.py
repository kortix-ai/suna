from typing import Optional, Tuple, Dict, Any
from dataclasses import dataclass
import asyncio
import time

from daytona_sdk import AsyncSandbox

from core.utils.logger import logger
from core.sandbox.sandbox import get_or_start_sandbox, create_sandbox
from core.cache.runtime_cache import get_cached_project_metadata, set_cached_project_metadata


@dataclass
class SandboxInfo:
    sandbox_id: str
    sandbox: AsyncSandbox
    password: str
    sandbox_url: Optional[str] = None
    vnc_preview: Optional[str] = None
    token: Optional[str] = None


class SandboxResolver:
    _instance: Optional['SandboxResolver'] = None
    _lock = asyncio.Lock()
    
    def __init__(self):
        self._resolution_locks: Dict[str, asyncio.Lock] = {}
        self._locks_lock = asyncio.Lock()
    
    @classmethod
    def get_instance(cls) -> 'SandboxResolver':
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance
    
    async def _get_project_lock(self, project_id: str) -> asyncio.Lock:
        async with self._locks_lock:
            if project_id not in self._resolution_locks:
                self._resolution_locks[project_id] = asyncio.Lock()
            return self._resolution_locks[project_id]
    
    async def resolve(
        self,
        project_id: str,
        account_id: str,
        db_client=None,
        require_started: bool = True
    ) -> Optional[SandboxInfo]:
        lock = await self._get_project_lock(project_id)
        
        async with lock:
            return await self._resolve_internal(
                project_id, account_id, db_client, require_started
            )
    
    async def _resolve_internal(
        self,
        project_id: str,
        account_id: str,
        db_client,
        require_started: bool
    ) -> Optional[SandboxInfo]:
        start_time = time.time()
        
        cached = await get_cached_project_metadata(project_id)
        sandbox_data = cached.get('sandbox', {}) if cached else {}
        sandbox_id = sandbox_data.get('sandbox_id') or sandbox_data.get('id')
        
        if sandbox_id:
            try:
                sandbox = await get_or_start_sandbox(sandbox_id)
                elapsed = (time.time() - start_time) * 1000
                logger.debug(f"[RESOLVER] Cache hit for {project_id}: {sandbox_id} in {elapsed:.0f}ms")
                return SandboxInfo(
                    sandbox_id=sandbox_id,
                    sandbox=sandbox,
                    password=sandbox_data.get('pass', ''),
                    sandbox_url=sandbox_data.get('sandbox_url'),
                    vnc_preview=sandbox_data.get('vnc_preview'),
                    token=sandbox_data.get('token')
                )
            except Exception as e:
                logger.warning(f"[RESOLVER] Cached sandbox {sandbox_id} failed: {e}")
        
        if db_client:
            sandbox_info = await self._resolve_from_db(project_id, account_id, db_client)
            if sandbox_info:
                elapsed = (time.time() - start_time) * 1000
                logger.debug(f"[RESOLVER] DB hit for {project_id}: {sandbox_info.sandbox_id} in {elapsed:.0f}ms")
                return sandbox_info
        
        sandbox_info = await self._claim_or_create(project_id, account_id, db_client)
        if sandbox_info:
            elapsed = (time.time() - start_time) * 1000
            logger.info(f"[RESOLVER] New sandbox for {project_id}: {sandbox_info.sandbox_id} in {elapsed:.0f}ms")
        
        return sandbox_info
    
    async def _resolve_from_db(
        self,
        project_id: str,
        account_id: str,
        db_client
    ) -> Optional[SandboxInfo]:
        try:
            from core.resources import ResourceService, ResourceStatus
            
            result = await db_client.table('projects').select(
                'sandbox_resource_id'
            ).eq('project_id', project_id).execute()
            
            if not result.data or not result.data[0].get('sandbox_resource_id'):
                return None
            
            resource_id = result.data[0]['sandbox_resource_id']
            resource_service = ResourceService(db_client)
            resource = await resource_service.get_resource_by_id(resource_id)
            
            if not resource or resource.get('status') != ResourceStatus.ACTIVE.value:
                return None
            
            sandbox_id = resource.get('external_id')
            config = resource.get('config', {})
            
            sandbox = await get_or_start_sandbox(sandbox_id)
            
            await self._update_cache(project_id, sandbox_id, config)
            
            return SandboxInfo(
                sandbox_id=sandbox_id,
                sandbox=sandbox,
                password=config.get('pass', ''),
                sandbox_url=config.get('sandbox_url'),
                vnc_preview=config.get('vnc_preview'),
                token=config.get('token')
            )
        except Exception as e:
            logger.error(f"[RESOLVER] DB resolution failed for {project_id}: {e}")
            return None
    
    async def _claim_or_create(
        self,
        project_id: str,
        account_id: str,
        db_client
    ) -> Optional[SandboxInfo]:
        from core.sandbox.pool_service import claim_sandbox_from_pool
        
        try:
            claimed = await claim_sandbox_from_pool(account_id, project_id)
            if claimed:
                sandbox_id, config = claimed
                sandbox = await get_or_start_sandbox(sandbox_id)
                await self._update_cache(project_id, sandbox_id, config)
                logger.info(f"[RESOLVER] Claimed from pool: {sandbox_id} for {project_id}")
                return SandboxInfo(
                    sandbox_id=sandbox_id,
                    sandbox=sandbox,
                    password=config.get('pass', ''),
                    sandbox_url=config.get('sandbox_url'),
                    vnc_preview=config.get('vnc_preview'),
                    token=config.get('token')
                )
        except Exception as e:
            logger.warning(f"[RESOLVER] Pool claim failed: {e}")
        
        return await self._create_new(project_id, account_id, db_client)
    
    async def _create_new(
        self,
        project_id: str,
        account_id: str,
        db_client
    ) -> Optional[SandboxInfo]:
        import uuid
        from core.resources import ResourceService, ResourceType, ResourceStatus
        
        try:
            password = str(uuid.uuid4())
            sandbox = await create_sandbox(password, project_id)
            sandbox_id = sandbox.id
            
            await asyncio.sleep(2)
            
            vnc_url, website_url, token = await self._get_preview_links(sandbox)
            
            config = {
                'pass': password,
                'vnc_preview': vnc_url,
                'sandbox_url': website_url,
                'token': token
            }
            
            if db_client:
                resource_service = ResourceService(db_client)
                resource = await resource_service.create_resource(
                    account_id=account_id,
                    resource_type=ResourceType.SANDBOX,
                    external_id=sandbox_id,
                    config=config,
                    status=ResourceStatus.ACTIVE
                )
                await resource_service.link_resource_to_project(project_id, resource['id'])
            
            await self._update_cache(project_id, sandbox_id, config)
            
            logger.info(f"[RESOLVER] Created new sandbox: {sandbox_id} for {project_id}")
            
            return SandboxInfo(
                sandbox_id=sandbox_id,
                sandbox=sandbox,
                password=password,
                sandbox_url=website_url,
                vnc_preview=vnc_url,
                token=token
            )
        except Exception as e:
            logger.error(f"[RESOLVER] Create failed for {project_id}: {e}")
            return None
    
    async def _get_preview_links(self, sandbox: AsyncSandbox) -> Tuple[Optional[str], Optional[str], Optional[str]]:
        try:
            vnc_link = await sandbox.get_preview_link(6080)
            website_link = await sandbox.get_preview_link(8080)
            
            vnc_url = vnc_link.url if hasattr(vnc_link, 'url') else str(vnc_link).split("url='")[1].split("'")[0]
            website_url = website_link.url if hasattr(website_link, 'url') else str(website_link).split("url='")[1].split("'")[0]
            token = vnc_link.token if hasattr(vnc_link, 'token') else None
            
            return vnc_url, website_url, token
        except Exception:
            return None, None, None
    
    async def _update_cache(self, project_id: str, sandbox_id: str, config: Dict[str, Any]) -> None:
        try:
            sandbox_data = {
                'sandbox_id': sandbox_id,
                'pass': config.get('pass'),
                'vnc_preview': config.get('vnc_preview'),
                'sandbox_url': config.get('sandbox_url'),
                'token': config.get('token')
            }
            await set_cached_project_metadata(project_id, sandbox_data)
        except Exception as e:
            logger.warning(f"[RESOLVER] Cache update failed: {e}")


def get_resolver() -> SandboxResolver:
    return SandboxResolver.get_instance()


async def resolve_sandbox(
    project_id: str,
    account_id: str,
    db_client=None,
    require_started: bool = True
) -> Optional[SandboxInfo]:
    resolver = get_resolver()
    return await resolver.resolve(project_id, account_id, db_client, require_started)
