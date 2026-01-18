from typing import Optional, TYPE_CHECKING

from core.agentpress.tool import Tool

if TYPE_CHECKING:
    from core.agentpress.thread_manager import ThreadManager
from daytona_sdk import AsyncSandbox
from core.sandbox.resolver import resolve_sandbox, SandboxInfo
from core.utils.logger import logger
from core.utils.files_utils import clean_path


class SandboxToolsBase(Tool):
    _urls_printed = False
    
    def __init__(self, project_id: str, thread_manager: Optional['ThreadManager'] = None):
        super().__init__()
        self.project_id = project_id
        self.thread_manager = thread_manager
        self.workspace_path = "/workspace"
        self._sandbox_info: Optional[SandboxInfo] = None

    async def _ensure_sandbox(self) -> AsyncSandbox:
        if self._sandbox_info is None:
            try:
                client = await self.thread_manager.db.client
                
                project = await client.table('projects').select(
                    'project_id, account_id'
                ).eq('project_id', self.project_id).execute()
                
                if not project.data or len(project.data) == 0:
                    raise ValueError(f"Project {self.project_id} not found")

                account_id = project.data[0].get('account_id')
                
                sandbox_info = await resolve_sandbox(
                    project_id=self.project_id,
                    account_id=str(account_id) if account_id else None,
                    db_client=client,
                    require_started=True
                )
                
                if not sandbox_info:
                    raise RuntimeError(f"Failed to resolve sandbox for project {self.project_id}")
                
                self._sandbox_info = sandbox_info
                logger.debug(f"[TOOL_BASE] Resolved sandbox {sandbox_info.sandbox_id} for project {self.project_id}")

            except Exception as e:
                logger.error(f"Error resolving sandbox for project {self.project_id}: {str(e)}")
                raise e

        return self._sandbox_info.sandbox

    @property
    def sandbox(self) -> AsyncSandbox:
        if self._sandbox_info is None:
            raise RuntimeError("Sandbox not initialized. Call _ensure_sandbox() first.")
        return self._sandbox_info.sandbox

    @property
    def sandbox_id(self) -> str:
        if self._sandbox_info is None:
            raise RuntimeError("Sandbox ID not initialized. Call _ensure_sandbox() first.")
        return self._sandbox_info.sandbox_id

    @property
    def sandbox_url(self) -> str:
        if self._sandbox_info is None:
            raise RuntimeError("Sandbox URL not initialized. Call _ensure_sandbox() first.")
        return self._sandbox_info.sandbox_url or ""

    @property
    def _sandbox_pass(self) -> str:
        if self._sandbox_info is None:
            return ""
        return self._sandbox_info.password

    def clean_path(self, path: str) -> str:
        cleaned_path = clean_path(path, self.workspace_path)
        logger.debug(f"Cleaned path: {path} -> {cleaned_path}")
        return cleaned_path
