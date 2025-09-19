from typing import Optional
import uuid
import asyncio

from core.agentpress.thread_manager import ThreadManager
from core.agentpress.tool import Tool
from daytona_sdk import AsyncSandbox
from core.sandbox.sandbox import get_or_start_sandbox, create_sandbox, delete_sandbox
from core.utils.logger import logger
from core.utils.files_utils import clean_path
from core.utils.config import config

class SandboxToolsBase(Tool):
    """Base class for all sandbox tools that provides project-based sandbox access."""
    
    # Class variable to track if sandbox URLs have been printed
    _urls_printed = False
    
    def __init__(self, project_id: str, thread_manager: Optional[ThreadManager] = None):
        super().__init__()
        self.project_id = project_id
        self.thread_manager = thread_manager
        self.workspace_path = "/workspace"
        self._sandbox = None
        self._sandbox_id = None
        self._sandbox_pass = None

    async def _ensure_sandbox(self) -> AsyncSandbox:
        """Ensure we have a valid sandbox instance, retrieving it from the project if needed.

        If the project does not yet have a sandbox, create it lazily and persist
        the metadata to the `projects` table so subsequent calls can reuse it.
        """
        if self._sandbox is None:
            try:
                # Get database client
                client = await self.thread_manager.db.client

                # Get project data
                project = await client.table('projects').select('*').eq('project_id', self.project_id).execute()
                if not project.data or len(project.data) == 0:
                    raise ValueError(f"Project {self.project_id} not found")

                project_data = project.data[0]
                sandbox_info = project_data.get('sandbox') or {}

                # If there is no sandbox recorded for this project, create one lazily
                if not sandbox_info.get('id'):
                    logger.debug(f"No sandbox recorded for project {self.project_id}; creating lazily")
                    sandbox_pass = str(uuid.uuid4())
                    sandbox_obj = await create_sandbox(sandbox_pass, self.project_id)
                    sandbox_id = sandbox_obj.id
                    
                    # Wait 5 seconds for services to start up
                    logger.info(f"Waiting 5 seconds for sandbox {sandbox_id} services to initialize...")
                    await asyncio.sleep(5)
                    
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

                    # Persist sandbox metadata to project record
                    update_result = await client.table('projects').update({
                        'sandbox': {
                            'id': sandbox_id,
                            'pass': sandbox_pass,
                            'vnc_preview': vnc_url,
                            'sandbox_url': website_url,
                            'token': token
                        }
                    }).eq('project_id', self.project_id).execute()

                    if not update_result.data:
                        # Cleanup created sandbox if DB update failed
                        try:
                            await delete_sandbox(sandbox_id)
                        except Exception:
                            logger.error(f"Failed to delete sandbox {sandbox_id} after DB update failure", exc_info=True)
                        raise Exception("Database update failed when storing sandbox metadata")

                    # Store local metadata and ensure sandbox is ready
                    self._sandbox_id = sandbox_id
                    self._sandbox_pass = sandbox_pass
                    self._sandbox = await get_or_start_sandbox(self._sandbox_id)
                else:
                    # Use existing sandbox metadata
                    self._sandbox_id = sandbox_info['id']
                    self._sandbox_pass = sandbox_info.get('pass')
                    self._sandbox = await get_or_start_sandbox(self._sandbox_id)

            except Exception as e:
                logger.error(f"Error retrieving/creating sandbox for project {self.project_id}: {str(e)}", exc_info=True)
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

    def clean_path(self, path: str) -> str:
        """Clean and normalize a path to be relative to /workspace."""
        cleaned_path = clean_path(path, self.workspace_path)
        logger.debug(f"Cleaned path: {path} -> {cleaned_path}")
        return cleaned_path