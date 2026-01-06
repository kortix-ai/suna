from typing import Optional, TYPE_CHECKING
import uuid
import asyncio

from core.agentpress.tool import Tool

if TYPE_CHECKING:
    from core.agentpress.thread_manager import ThreadManager
from daytona_sdk import AsyncSandbox
from core.sandbox.sandbox import get_or_start_sandbox, create_sandbox, delete_sandbox
from core.utils.logger import logger
from core.utils.files_utils import clean_path
from core.utils.config import config
from core.resources import ResourceService, ResourceType, ResourceStatus

class SandboxToolsBase(Tool):
    """Base class for all sandbox tools that provides project-based sandbox access."""
    
    # Class variable to track if sandbox URLs have been printed
    _urls_printed = False
    
    def __init__(self, project_id: str, thread_manager: Optional['ThreadManager'] = None):
        super().__init__()
        self.project_id = project_id
        self.thread_manager = thread_manager
        self.workspace_path = "/workspace"
        self._sandbox = None
        self._sandbox_id = None
        self._sandbox_pass = None
        self._sandbox_url = None

    async def _ensure_sandbox(self) -> AsyncSandbox:
        """Ensure we have a valid sandbox instance, retrieving it from the project if needed.

        If the project does not yet have a sandbox, create it lazily and persist
        the metadata to the `resources` table so subsequent calls can reuse it.
        """
        if self._sandbox is None:
            try:
                # Get database client
                client = await self.thread_manager.db.client
                resource_service = ResourceService(client)

                # Get project data
                project = await client.table('projects').select('project_id, account_id, sandbox_resource_id').eq('project_id', self.project_id).execute()
                if not project.data or len(project.data) == 0:
                    raise ValueError(f"Project {self.project_id} not found")

                project_data = project.data[0]
                account_id = project_data.get('account_id')
                sandbox_resource_id = project_data.get('sandbox_resource_id')
                
                # Lazy migration: Migrate sandbox JSONB to resources table if needed
                if not sandbox_resource_id:
                    migrated_resource = await resource_service.migrate_project_sandbox_if_needed(self.project_id)
                    if migrated_resource:
                        sandbox_resource_id = migrated_resource['id']
                        # Re-fetch project data to get updated sandbox_resource_id
                        project = await client.table('projects').select('project_id, account_id, sandbox_resource_id').eq('project_id', self.project_id).execute()
                        if project.data:
                            project_data = project.data[0]
                            sandbox_resource_id = project_data.get('sandbox_resource_id')

                # Try to get existing sandbox resource
                sandbox_resource = None
                if sandbox_resource_id:
                    sandbox_resource = await resource_service.get_resource_by_id(sandbox_resource_id)

                # If there is no sandbox resource for this project, create one lazily
                if not sandbox_resource or sandbox_resource.get('status') != ResourceStatus.ACTIVE.value:
                    logger.debug(f"No active sandbox resource for project {self.project_id}; creating lazily")
                    sandbox_pass = str(uuid.uuid4())
                    sandbox_obj = await create_sandbox(sandbox_pass, self.project_id)
                    sandbox_id = sandbox_obj.id
                    
                    logger.info(f"Waiting 2 seconds for sandbox {sandbox_id} services to initialize...")
                    await asyncio.sleep(2)
                    
                    # Gather preview links and token (best-effort parsing)
                    try:
                        vnc_link = await sandbox_obj.get_preview_link(6080)
                        website_link = await sandbox_obj.get_preview_link(8080)
                        vnc_url = vnc_link.url if hasattr(vnc_link, 'url') else str(vnc_link).split("url='")[1].split("'")[0]
                        website_url = website_link.url if hasattr(website_link, 'url') else str(website_link).split("url='")[1].split("'")[0]
                        token = vnc_link.token if hasattr(vnc_link, 'token') else (str(vnc_link).split("token='")[1].split("'")[0] if "token='" in str(vnc_link) else None)
                    except Exception:
                        # If preview link extraction fails, still proceed but leave fields None
                        logger.warning(f"Failed to extract preview links for sandbox {sandbox_id}", exc_info=True)
                        vnc_url = None
                        website_url = None
                        token = None

                    # Create resource record
                    sandbox_config = {
                        'pass': sandbox_pass,
                        'vnc_preview': vnc_url,
                        'sandbox_url': website_url,
                        'token': token
                    }
                    
                    try:
                        resource = await resource_service.create_resource(
                            account_id=account_id,
                            resource_type=ResourceType.SANDBOX,
                            external_id=sandbox_id,
                            config=sandbox_config,
                            status=ResourceStatus.ACTIVE
                        )
                        resource_id = resource['id']
                        
                        # Link resource to project
                        if not await resource_service.link_resource_to_project(self.project_id, resource_id):
                            # Cleanup created sandbox if DB update failed
                            try:
                                await delete_sandbox(sandbox_id)
                                await resource_service.delete_resource(resource_id)
                            except Exception:
                                logger.error(f"Failed to cleanup sandbox {sandbox_id} after DB update failure", exc_info=True)
                            raise Exception("Database update failed when linking sandbox resource to project")
                    except Exception as e:
                        # Cleanup created sandbox if resource creation failed
                        try:
                            await delete_sandbox(sandbox_id)
                        except Exception:
                            logger.error(f"Failed to delete sandbox {sandbox_id} after resource creation failure", exc_info=True)
                        raise Exception(f"Failed to create sandbox resource: {str(e)}")

                    # Update project metadata cache with sandbox data (instead of invalidate)
                    try:
                        from core.cache.runtime_cache import set_cached_project_metadata
                        sandbox_cache_data = {
                            'id': sandbox_id,
                            'pass': sandbox_pass,
                            'vnc_preview': vnc_url,
                            'sandbox_url': website_url,
                            'token': token
                        }
                        await set_cached_project_metadata(self.project_id, sandbox_cache_data)
                        logger.debug(f"✅ Updated project cache with sandbox data: {self.project_id}")
                    except Exception as cache_error:
                        logger.warning(f"Failed to update project cache: {cache_error}")

                    # Store local metadata and ensure sandbox is ready
                    self._sandbox_id = sandbox_id
                    self._sandbox_pass = sandbox_pass
                    self._sandbox_url = website_url
                    self._sandbox = await get_or_start_sandbox(self._sandbox_id)
                    
                    # Update last_used_at timestamp
                    try:
                        await resource_service.update_last_used(resource_id)
                    except Exception:
                        logger.warning(f"Failed to update last_used_at for resource {resource_id}")
                else:
                    # Use existing sandbox resource
                    config = sandbox_resource.get('config', {})
                    self._sandbox_id = sandbox_resource.get('external_id')
                    self._sandbox_pass = config.get('pass')
                    self._sandbox_url = config.get('sandbox_url')
                    self._sandbox = await get_or_start_sandbox(self._sandbox_id)
                    
                    # Update last_used_at timestamp
                    try:
                        await resource_service.update_last_used(sandbox_resource_id)
                    except Exception:
                        logger.warning(f"Failed to update last_used_at for resource {sandbox_resource_id}")

            except Exception as e:
                logger.error(f"Error retrieving/creating sandbox for project {self.project_id}: {str(e)}")
                raise e

        return self._sandbox

    @property
    def sandbox(self) -> AsyncSandbox:
        """Get the sandbox instance, ensuring it exists."""
        if self._sandbox is None:
            raise RuntimeError("Sandbox not initialized. Call _ensure_sandbox() first.")
        return self._sandbox

    @property
    def sandbox_id(self) -> str:
        """Get the sandbox ID, ensuring it exists."""
        if self._sandbox_id is None:
            raise RuntimeError("Sandbox ID not initialized. Call _ensure_sandbox() first.")
        return self._sandbox_id

    @property
    def sandbox_url(self) -> str:
        """Get the sandbox URL, ensuring it exists."""
        if self._sandbox_url is None:
            raise RuntimeError("Sandbox URL not initialized. Call _ensure_sandbox() first.")
        return self._sandbox_url

    def clean_path(self, path: str) -> str:
        """Clean and normalize a path to be relative to /workspace."""
        cleaned_path = clean_path(path, self.workspace_path)
        logger.debug(f"Cleaned path: {path} -> {cleaned_path}")
        return cleaned_path