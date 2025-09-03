"""
Utility functions for handling agent default files in Supabase Storage.
"""

import uuid
from datetime import datetime, timezone
from typing import List, Dict, Any, Optional
from fastapi import UploadFile
from utils.logger import logger
from services.supabase import DBConnection


class AgentDefaultFilesManager:
    def __init__(self):
        self.bucket_name = "agent-default-files"
    
    def _get_file_path(self, account_id: str, agent_id: str, filename: str) -> str:
        """Generate storage path for agent default file."""
        return f"{account_id}/{agent_id}/{filename}"
    
    async def upload_file(self, account_id: str, agent_id: str, file: UploadFile, user_id: Optional[str] = None) -> Dict[str, Any]:
        """Upload a default file for an agent."""
        try:
            # Read file content
            content = await file.read()
            file_path = self._get_file_path(account_id, agent_id, file.filename)
            
            # Upload to Supabase storage
            db = DBConnection()
            client = await db.client
            
            # First try to upload the file
            storage_response = await client.storage.from_(self.bucket_name).upload(
                file_path,
                content,
                {"content-type": file.content_type or "application/octet-stream"}
            )
            
            # Check if upload succeeded or failed
            upload_successful = False
            
            # Handle different response types from Supabase storage
            if hasattr(storage_response, 'path'):
                # UploadResponse object - upload was successful
                upload_successful = True
            elif storage_response and hasattr(storage_response, 'get') and storage_response.get('error'):
                error = storage_response['error']
                logger.error(f"Storage upload error details: {error}")
                if 'Duplicate' in str(error) or '409' in str(error):
                    # File exists, delete it first
                    try:
                        delete_response = await client.storage.from_(self.bucket_name).remove([file_path])
                    except Exception as delete_error:
                        logger.warning(f"Could not delete existing file {file_path}: {delete_error}")
                    
                    # Try uploading again
                    storage_response = await client.storage.from_(self.bucket_name).upload(
                        file_path,
                        content,
                        {"content-type": file.content_type or "application/octet-stream"}
                    )
                    
                    # Check if second upload also failed
                    if storage_response.get('error'):
                        logger.error(f"Second upload also failed: {storage_response['error']}")
                        raise RuntimeError(f"Document '{file.filename}' already exists")
                    else:
                        upload_successful = True
                else:
                    # Different error, not a duplicate
                    logger.error(f"Non-duplicate upload error: {storage_response['error']}")
                    error_str = str(storage_response['error']).lower()
                    if 'already exists' in error_str or 'duplicate' in error_str or '409' in error_str:
                        raise RuntimeError(f"Document '{file.filename}' already exists")
                    else:
                        raise RuntimeError(f"Upload failed: {storage_response['error']}")
            else:
                # No error and no UploadResponse - unexpected case
                logger.warning(f"Unexpected storage response format: {type(storage_response)} - {storage_response}")
                upload_successful = False
            
            # Only proceed if upload was successful
            if not upload_successful:
                raise RuntimeError(f"Upload failed for unknown reason")
            
            # Get public URL (for internal use)
            try:
                public_url = await client.storage.from_(self.bucket_name).get_public_url(file_path)
            except Exception as url_error:
                logger.error(f"Failed to get public URL: {url_error}")
                public_url = f"/{self.bucket_name}/{file_path}"  # Fallback URL
            
            # Save metadata to database
            db = DBConnection()
            client = await db.client
            
            # Insert file metadata
            file_record = await client.table('agent_default_files').insert({
                'agent_id': agent_id,
                'account_id': account_id,
                'name': file.filename,
                'storage_path': file_path,
                'size': len(content),
                'mime_type': file.content_type,
                'uploaded_by': user_id
            }).execute()
            
            if not file_record.data:
                # Try to clean up the uploaded file
                try:
                    await client.storage.from_(self.bucket_name).remove([file_path])
                except:
                    pass
                raise RuntimeError("Failed to save file metadata")
            
            # Return file metadata
            file_data = file_record.data[0]
            file_metadata = {
                "id": str(file_data["id"]),
                "name": file_data["name"],
                "storage_path": file_data["storage_path"],
                "size": file_data["size"],
                "mime_type": file_data["mime_type"],
                "uploaded_at": file_data["uploaded_at"],
                "public_url": public_url
            }
            
            return file_metadata
            
        except Exception as e:
            logger.error(f"Error uploading agent default file: {e}")
            error_msg = str(e)
            if "already exists" in error_msg.lower():
                raise RuntimeError(error_msg)
            else:
                raise RuntimeError(f"Failed to upload file: {error_msg}")
    
    async def delete_file(self, account_id: str, agent_id: str, filename: str) -> bool:
        """Delete a default file for an agent."""
        try:
            file_path = self._get_file_path(account_id, agent_id, filename)
            
            db = DBConnection()
            client = await db.client
            
            # Delete from database first
            deleted = await client.table('agent_default_files').delete().eq(
                'agent_id', agent_id
            ).eq('name', filename).execute()
            
            if not deleted.data:
                logger.warning(f"File metadata not found in database: {filename}")
                return False
            
            # Delete from storage
            try:
                response = await client.storage.from_(self.bucket_name).remove([file_path])
                return True
            except Exception as storage_error:
                logger.error(f"Failed to delete file {file_path} from storage: {storage_error}")
                # File metadata already deleted, so return True
                return True
            
        except Exception as e:
            logger.error(f"Error deleting agent default file: {e}")
            return False
    
    async def list_files(self, agent_id: str) -> List[Dict[str, Any]]:
        """List all default files for an agent."""
        try:
            db = DBConnection()
            client = await db.client
            
            files = await client.table('agent_default_files').select(
                'id, name, storage_path, size, mime_type, uploaded_at'
            ).eq('agent_id', agent_id).order('uploaded_at', desc=True).execute()
            
            if not files.data:
                return []
            
            # Format the response
            return [{
                "id": str(f["id"]),
                "name": f["name"],
                "storage_path": f["storage_path"],
                "size": f["size"],
                "mime_type": f["mime_type"],
                "uploaded_at": f["uploaded_at"]
            } for f in files.data]
            
        except Exception as e:
            logger.error(f"Error listing agent default files: {e}")
            return []
    
    async def copy_files_for_agent_copy(self, source_agent_id: str, dest_account_id: str, 
                                       dest_agent_id: str) -> List[Dict[str, Any]]:
        """Copy default files when creating agent copy (unmanaged sharing)."""
        try:
            db = DBConnection()
            client = await db.client
            
            # Get source files from database
            source_files = await client.from_('agent_default_files').select(
                '*, agents!inner(account_id)'
            ).eq('agent_id', source_agent_id).execute()
            
            copied_files = []
            
            if not source_files.data:
                return []
                
            for file_info in source_files.data:
                source_path = file_info['storage_path']
                dest_path = self._get_file_path(dest_account_id, dest_agent_id, file_info['name'])
                
                # Download from source
                try:
                    file_content = await client.storage.from_(self.bucket_name).download(source_path)
                except Exception as e:
                    logger.warning(f"Failed to download source file {source_path}: {e}")
                    continue
                
                # Upload to destination
                try:
                    upload_response = await client.storage.from_(self.bucket_name).upload(
                        dest_path,
                        file_content,
                        {"content-type": file_info.get('mime_type', 'application/octet-stream')}
                    )
                    
                    # Save metadata for copied file
                    copied_record = await client.table('agent_default_files').insert({
                        'agent_id': dest_agent_id,
                        'account_id': dest_account_id,
                        'name': file_info['name'],
                        'storage_path': dest_path,
                        'size': file_info['size'],
                        'mime_type': file_info['mime_type'],
                        'uploaded_by': None  # No user context
                    }).execute()
                    
                    if copied_record.data:
                        copied_files.append({
                            "id": str(copied_record.data[0]["id"]),
                            "name": copied_record.data[0]["name"],
                            "storage_path": copied_record.data[0]["storage_path"],
                            "size": copied_record.data[0]["size"],
                            "mime_type": copied_record.data[0]["mime_type"],
                            "uploaded_at": copied_record.data[0]["uploaded_at"]
                        })
                    
                except Exception as upload_error:
                    logger.warning(f"Failed to copy file to {dest_path}: {upload_error}")
                    continue
            
            return copied_files
            
        except Exception as e:
            logger.error(f"Error copying agent default files: {e}")
            return []
    
    async def download_files_to_sandbox(self, agent_id: str, sandbox) -> List[str]:
        """Download default files to sandbox /workspace/agent-defaults/ directory."""
        try:
            db = DBConnection()
            client = await db.client
            
            # Get files from database
            files = await self.list_files(agent_id)
            downloaded_files = []
            
            # Create agent-defaults directory in sandbox
            try:
                sandbox.fs.mkdir("/workspace/agent-defaults")
            except:
                # Directory might already exist
                pass
            
            for file_info in files:
                storage_path = file_info['storage_path']
                workspace_path = f"/workspace/agent-defaults/{file_info['name']}"
                
                # Download from Supabase storage
                try:
                    file_content = await client.storage.from_(self.bucket_name).download(storage_path)
                except Exception as e:
                    logger.warning(f"Failed to download file {storage_path}: {e}")
                    continue
                
                # Upload to sandbox
                try:
                    sandbox.fs.upload_file(file_content, workspace_path)
                    downloaded_files.append(workspace_path)
                    logger.info(f"Downloaded default file to sandbox: {workspace_path}")
                except Exception as e:
                    logger.warning(f"Failed to upload file to sandbox {workspace_path}: {e}")
            
            return downloaded_files
            
        except Exception as e:
            logger.error(f"Error downloading agent default files to sandbox: {e}")
            return []
