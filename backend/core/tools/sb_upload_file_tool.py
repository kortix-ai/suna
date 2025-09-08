import os
import uuid
import mimetypes
import structlog
from datetime import datetime, timedelta
from typing import Optional, Dict, Any
from pathlib import Path

from core.agentpress.tool import ToolResult, openapi_schema, usage_example
from core.sandbox.tool_base import SandboxToolsBase
from core.agentpress.thread_manager import ThreadManager
from core.services.supabase import DBConnection
from core.utils.logger import logger
from core.utils.config import config


class SandboxUploadFileTool(SandboxToolsBase):
    def __init__(self, project_id: str, thread_manager: ThreadManager):
        super().__init__(project_id, thread_manager)
        self.workspace_path = "/workspace"
        self.db = DBConnection()
        
    @openapi_schema({
        "type": "function",
        "function": {
            "name": "upload_file",
            "description": "Securely upload a file from the sandbox workspace to private cloud storage (Supabase S3). Returns a secure signed URL that expires after 24 hours for access control and security.",
            "parameters": {
                "type": "object",
                "properties": {
                    "file_path": {
                        "type": "string",
                        "description": "Path to the file in the sandbox, relative to /workspace (e.g., 'output.pdf', 'data/results.csv')"
                    },
                    "bucket_name": {
                        "type": "string",
                        "description": "Target storage bucket. Options: 'file-uploads' (default - secure private storage), 'browser-screenshots' (browser automation only). Default: 'file-uploads'",
                        "default": "file-uploads"
                    },
                    "custom_filename": {
                        "type": "string",
                        "description": "Optional custom filename for the uploaded file. If not provided, uses original filename with timestamp"
                    },
                },
                "required": ["file_path"]
            }
        }
    })
    @usage_example('''
        <function_calls>
        <invoke name="upload_file">
        <parameter name="file_path">report.pdf</parameter>
        </invoke>
        </function_calls>
        ''')
    async def upload_file(
        self,
        file_path: str,
        bucket_name: str = "file-uploads",
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

            try:
                client = await self.db.client
                storage_response = await client.storage.from_(bucket_name).upload(
                    storage_path,
                    file_content,
                    {"content-type": content_type}
                )

                expires_in = 24 * 60 * 60
                signed_url_response = await client.storage.from_(bucket_name).create_signed_url(
                    storage_path,
                    expires_in
                )
                
                signed_url = signed_url_response.get('signedURL')
                if not signed_url:
                    return self.fail_response("Failed to generate secure access URL.")
                
                url_expires_at = datetime.now() + timedelta(seconds=expires_in)
                
                await self._track_upload(
                    client,
                    account_id,
                    storage_path,
                    bucket_name,
                    original_filename,
                    file_info.size,
                    content_type,
                    signed_url,
                    url_expires_at
                )
                
                message = f"🔒 File '{original_filename}' uploaded securely!\n"
                message += f"📁 Storage: {bucket_name}/{storage_path}\n"
                message += f"📏 Size: {self._format_file_size(file_info.size)}\n"
                message += f"🔗 Secure Access URL: {signed_url}\n"
                message += f"⏰ URL expires: {url_expires_at.strftime('%Y-%m-%d %H:%M:%S UTC')}\n"
                message += f"\n🔐 This file is stored in private, secure storage with account isolation."
                
                return self.success_response(message)
                
            except Exception as e:
                logger.error(f"Failed to upload file to Supabase: {str(e)}")
                return self.fail_response(f"Failed to upload file to secure storage: {str(e)}")
                
        except Exception as e:
            logger.error(f"Unexpected error in upload_file: {str(e)}")
            return self.fail_response(f"Unexpected error during secure file upload: {str(e)}")
    
    async def _get_current_account_id(self) -> str:
        try:
            context_vars = structlog.contextvars.get_contextvars()
            thread_id = context_vars.get('thread_id')
            
            if not thread_id:
                raise ValueError("No thread_id available from execution context")
            
            client = await self.db.client
            
            thread_result = await client.table('threads').select('account_id').eq('thread_id', thread_id).limit(1).execute()
            if not thread_result.data:
                raise ValueError(f"Could not find thread with ID: {thread_id}")
            
            account_id = thread_result.data[0]['account_id']
            if not account_id:
                raise ValueError("Thread has no associated account_id")
            
            return account_id
            
        except Exception as e:
            logger.error(f"Error getting current account_id: {e}")
            raise
    
    async def _track_upload(
        self,
        client,
        account_id: str,
        storage_path: str,
        bucket_name: str,
        original_filename: str,
        file_size: int,
        content_type: str,
        signed_url: str,
        url_expires_at: datetime
    ):
        try:
            thread_id = None
            agent_id = None
            
            try:
                context_vars = structlog.contextvars.get_contextvars()
                thread_id = context_vars.get('thread_id')
            except Exception:
                pass
            
            if thread_id:
                thread_result = await client.table('threads').select('agent_id').eq('thread_id', thread_id).execute()
                if thread_result.data:
                    thread_data = thread_result.data[0]
                    agent_id = thread_data.get('agent_id')
            
            user_id = None
            try:
                account_result = await client.table('basejump.account_user').select('user_id').eq('account_id', account_id).limit(1).execute()
                if account_result.data:
                    user_id = account_result.data[0].get('user_id')
            except Exception:
                pass
            
            upload_data = {
                'project_id': self.project_id,
                'thread_id': thread_id,
                'agent_id': agent_id,
                'account_id': account_id,
                'user_id': user_id,
                'bucket_name': bucket_name,
                'storage_path': storage_path,
                'original_filename': original_filename,
                'file_size': file_size,
                'content_type': content_type,
                'signed_url': signed_url,
                'url_expires_at': url_expires_at.isoformat(),
                'metadata': {
                    'uploaded_from': 'sandbox',
                    'tool': 'upload_file',
                    'secure_upload': True
                }
            }
            
            await client.table('file_uploads').insert(upload_data).execute()
            
        except Exception as e:
            logger.warning(f"Failed to track file upload in database: {str(e)}")
    
    def _format_file_size(self, size_bytes: int) -> str:
        for unit in ['B', 'KB', 'MB', 'GB']:
            if size_bytes < 1024.0:
                return f"{size_bytes:.1f} {unit}"
            size_bytes /= 1024.0
        return f"{size_bytes:.1f} TB" 