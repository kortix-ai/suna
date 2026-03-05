import os
import uuid
import mimetypes
import structlog
from datetime import datetime, timedelta
from typing import Optional, Dict, Any
from pathlib import Path

from core.agentpress.tool import ToolResult, openapi_schema, tool_metadata
from core.sandbox.tool_base import SandboxToolsBase
from core.agentpress.thread_manager import ThreadManager
from core.utils.logger import logger
from core.utils.config import config
from core.services.convex_client import get_convex_client

@tool_metadata(
    display_name="File Upload",
    description="Upload files to cloud storage and share them with secure links",
    icon="Upload",
    color="bg-teal-100 dark:bg-teal-800/50",
    weight=230,
    visible=True,
    usage_guide="""
### FILE UPLOAD & CLOUD STORAGE

**PURPOSE:** Upload files from sandbox workspace to private cloud storage (Supabase S3) with secure signed URLs

**WHEN TO USE:**
- **ONLY when user explicitly requests file sharing** or asks for permanent URLs
- **ONLY when user asks for files to be accessible externally** or beyond sandbox session
- **ASK USER FIRST** in most cases: "Would you like me to upload this file to secure cloud storage for sharing?"
- User specifically requests file sharing or external access
- User asks for permanent or persistent file access
- **DO NOT automatically upload** unless explicitly requested

**UPLOAD PARAMETERS:**
- `file_path`: Path relative to /workspace (e.g., "report.pdf", "data/results.csv")
- `custom_filename`: Optional custom name for the uploaded file

**STORAGE:**
- Files stored in secure private storage with user isolation
- Signed URL access with 24-hour expiration
- Each user can only access their own files

**UPLOAD WORKFLOW:**
1. Ask before uploading: "Would you like me to upload this file to secure cloud storage for sharing?"
2. If user says yes: Use upload_file with file_path parameter
3. Share the secure URL (note: expires in 24 hours)

**INTEGRATED WORKFLOW:**
- Create file → Ask user if upload needed → Upload only if requested → Share secure URL
- Generate image → Ask about cloud storage → Upload only if requested
- Browser screenshots: Continue automatic upload (no changes)
"""
)
class SandboxUploadFileTool(SandboxToolsBase):
    def __init__(self, project_id: str, thread_manager: ThreadManager):
        super().__init__(project_id, thread_manager)
        # MIGRATED: Using Convex client instead of Supabase
        # Old: from core.utils.db_helpers import get_initialized_db; self.db = get_initialized_db()
        self.convex = get_convex_client()

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "upload_file",
            "description": "Securely upload a file from the sandbox workspace to private cloud storage (Supabase S3). Returns a secure signed URL that expires after 24 hours for access control and security. **🚨 PARAMETER NAMES**: Use EXACTLY these parameter names: `file_path` (REQUIRED), `custom_filename` (optional).",
            "parameters": {
                "type": "object",
                "properties": {
                    "file_path": {
                        "type": "string",
                        "description": "**REQUIRED** - Path to the file in the sandbox, relative to /workspace. Example: 'output.pdf', 'data/results.csv'"
                    },
                    "custom_filename": {
                        "type": "string",
                        "description": "**OPTIONAL** - Custom filename for the uploaded file. If not provided, uses original filename with timestamp."
                    }
                },
                "required": ["file_path"],
                "additionalProperties": False
            }
        }
    })
    async def upload_file(
        self,
        file_path: str,
        custom_filename: Optional[str] = None
    ) -> ToolResult:
        try:
            await self._ensure_sandbox()

            file_path = self.clean_path(file_path)
            full_path = f"{self.workspace_path}/{file_path}"

            try:
                file_info = await self.sandbox.fs.get_file_info(full_path)
                if file_info.size > 50 * 1024 * 1024:  # 50MB limit
                    return self.fail_response(f"File '{file_path}' is too large (>50MB). Please reduce file size before uploading.")
            except Exception:
                return self.fail_response(f"File '{file_path}' not found in workspace.")

            try:
                file_content = await self.sandbox.fs.download_file(full_path)
            except Exception as e:
                return self.fail_response(f"Failed to read file '{file_path}': {str(e)}")

            account_id = await self._get_current_account_id()

            original_filename = os.path.basename(file_path)
            file_extension = Path(original_filename).suffix.lower()
            content_type, _ = mimetypes.guess_type(original_filename)
            if not content_type:
                content_type = "application/octet-stream"

            if custom_filename:
                storage_filename = custom_filename
            else:
                timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
                unique_id = str(uuid.uuid4())[:8]
                name_base = Path(original_filename).stem
                storage_filename = f"{name_base}_{timestamp}_{unique_id}{file_extension}"

            storage_path = f"{account_id}/{storage_filename}"
            bucket_name = "file-uploads"  # Always use file-uploads bucket

            # NOTE: File storage requires external S3-compatible storage (Supabase Storage, S3, R2, etc.)
            # Convex does not have native file storage. The database tracking is handled via Convex.
            # To fully migrate file uploads:
            # 1. Configure external storage (Supabase Storage, AWS S3, Cloudflare R2)
            # 2. Use this client for storage operations
            # 3. Database tracking uses self.convex.create_file_upload()
            #
            # Current status: Storage layer not yet migrated, database tracking migrated to Convex.
            # The _track_upload method now uses Convex for metadata tracking.

            logger.warning(f"File upload tool not yet migrated to Convex - storage endpoints needed")
            return self.fail_response(
                "File upload to cloud storage is temporarily unavailable during backend migration. "
                "Please try again later or use alternative file sharing methods."
            )

        except Exception as e:
            logger.error(f"Unexpected error in upload_file: {str(e)}")
            return self.fail_response(f"Unexpected error during secure file upload: {str(e)}")

    async def _get_current_account_id(self) -> str:
        """Get account_id from current thread context."""
        context_vars = structlog.contextvars.get_contextvars()
        thread_id = context_vars.get('thread_id')

        if not thread_id:
            raise ValueError("No thread_id available from execution context")

        from core.utils.auth_utils import get_account_id_from_thread
        # MIGRATED: get_account_id_from_thread now uses Convex directly
        return await get_account_id_from_thread(thread_id)

    async def _track_upload(
        self,
        account_id: str,
        storage_path: str,
        bucket_name: str,
        original_filename: str,
        file_size: int,
        content_type: str,
        signed_url: str,
        url_expires_at: datetime
    ):
        """Track file upload in Convex database."""
        try:
            thread_id = None
            agent_id = None

            try:
                context_vars = structlog.contextvars.get_contextvars()
                thread_id = context_vars.get('thread_id')
            except Exception:
                pass

            if thread_id:
                try:
                    thread_data = await self.convex.get_thread(thread_id, account_id)
                    if thread_data:
                        agent_id = thread_data.get('agentId')
                except Exception:
                    pass

            upload_id = str(uuid.uuid4())
            
            await self.convex.create_file_upload(
                upload_id=upload_id,
                account_id=account_id,
                storage_path=storage_path,
                bucket_name=bucket_name,
                original_filename=original_filename,
                file_size=file_size,
                content_type=content_type,
                signed_url=signed_url,
                url_expires_at=url_expires_at.isoformat(),
                project_id=self.project_id,
                thread_id=thread_id,
                agent_id=agent_id,
                metadata={
                    'uploaded_from': 'sandbox',
                    'tool': 'upload_file',
                    'secure_upload': True
                }
            )

            return upload_id

        except Exception as e:
            logger.warning(f"Failed to track file upload in database: {str(e)}")
            return None

    def _format_file_size(self, size_bytes: int) -> str:
        for unit in ['B', 'KB', 'MB', 'GB']:
            if size_bytes < 1024.0:
                return f"{size_bytes:.1f} {unit}"
            size_bytes /= 1024.0
        return f"{size_bytes:.1f} TB"
