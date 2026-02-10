import os
import asyncio
import tempfile
import mimetypes
from pathlib import Path
from core.agentpress.tool import ToolResult, openapi_schema, tool_metadata
from core.sandbox.tool_base import SandboxToolsBase
from core.agentpress.thread_manager import ThreadManager
from core.utils.logger import logger


@tool_metadata(
    display_name="Composio File Upload",
    description="Upload files to Composio storage for use as email attachments",
    icon="Paperclip",
    color="bg-indigo-100 dark:bg-indigo-800/50",
    weight=231,
    visible=True,
    usage_guide="""### COMPOSIO FILE UPLOAD (for email attachments)
**PURPOSE:** Upload files from sandbox to Composio S3 storage for attachment with Gmail/email tools.
**WHEN TO USE:** Before sending emails with attachments via Composio Gmail tools (GMAIL_SEND_EMAIL, GMAIL_CREATE_EMAIL_DRAFT, GMAIL_REPLY_TO_THREAD).
**WORKFLOW:** 1. Create/prepare file in sandbox. Preferably export file as pptx when sending presentations over email. -> 2. Call composio_upload -> 3. Use returned {s3key, mimetype, name} in the email tool's attachment parameter."""
)
class ComposioUploadTool(SandboxToolsBase):
    """Uploads files from the agent sandbox to Composio's S3 storage.

    This enables email attachments via Composio Gmail tools which require
    files to be in Composio's own S3 bucket (not external URLs).
    """

    def __init__(self, project_id: str, thread_manager: ThreadManager):
        super().__init__(project_id, thread_manager)

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "composio_upload",
            "description": (
                "Upload a file from the sandbox to Composio storage for use as an email attachment. "
                "Returns s3key, mimetype, and name to pass to email tools like GMAIL_SEND_EMAIL."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "file_path": {
                        "type": "string",
                        "description": "Path to the file in the sandbox, relative to /workspace."
                    },
                    "tool_slug": {
                        "type": "string",
                        "description": "Target Composio tool slug. Default: GMAIL_SEND_EMAIL"
                    },
                    "toolkit_slug": {
                        "type": "string",
                        "description": "Target Composio toolkit slug. Default: gmail"
                    }
                },
                "required": ["file_path"],
                "additionalProperties": False
            }
        }
    })
    async def composio_upload(
        self,
        file_path: str,
        tool_slug: str = "GMAIL_SEND_EMAIL",
        toolkit_slug: str = "gmail",
    ) -> ToolResult:
        """Upload a sandbox file to Composio S3 for email attachment use."""
        try:
            await self._ensure_sandbox()
            file_path = self.clean_path(file_path)
            full_path = f"{self.workspace_path}/{file_path}"

            # Validate file exists and check size
            try:
                file_info = await self.sandbox.fs.get_file_info(full_path)
                if file_info.size > 50 * 1024 * 1024:
                    return self.fail_response(
                        "File too large (>50MB). Please reduce file size before uploading."
                    )
            except Exception:
                return self.fail_response(f"File '{file_path}' not found in workspace.")

            # Download file content from sandbox
            try:
                file_content = await self.sandbox.fs.download_file(full_path)
            except Exception as e:
                return self.fail_response(f"Failed to read file '{file_path}': {e}")

            original_filename = os.path.basename(file_path)
            suffix = Path(original_filename).suffix

            # Write to temp file — FileUploadable.from_path() needs a local path
            tmp = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
            try:
                tmp.write(file_content)
                tmp.close()

                from composio.core.models._files import FileUploadable
                from core.composio_integration.client import get_composio_client

                composio_client = get_composio_client()

                # FileUploadable.from_path is synchronous (uses requests.put),
                # so wrap in asyncio.to_thread to avoid blocking the event loop.
                file_obj = await asyncio.to_thread(
                    FileUploadable.from_path,
                    client=composio_client,
                    file=tmp.name,
                    tool=tool_slug,
                    toolkit=toolkit_slug,
                )

                content_type = file_obj.mimetype
                if not content_type:
                    content_type, _ = mimetypes.guess_type(original_filename)
                    if not content_type:
                        content_type = "application/octet-stream"

                return self.success_response(
                    f"File '{original_filename}' uploaded to Composio storage.\n\n"
                    f"Attachment data (use with email tool's attachment parameter):\n"
                    f'{{"s3key": "{file_obj.s3key}", '
                    f'"mimetype": "{content_type}", '
                    f'"name": "{file_obj.name}"}}'
                )
            finally:
                if os.path.exists(tmp.name):
                    os.unlink(tmp.name)

        except Exception as e:
            logger.error(f"Composio upload failed: {e}")
            return self.fail_response(f"Failed to upload to Composio: {e}")
