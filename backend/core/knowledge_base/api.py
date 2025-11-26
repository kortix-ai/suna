from typing import List, Optional
from fastapi import APIRouter, HTTPException, Depends, UploadFile, File, BackgroundTasks
from pydantic import BaseModel, Field, validator
from core.utils.auth_utils import verify_and_get_user_id_from_jwt, require_agent_access, AuthorizedAgentAccess
from core.services.supabase import DBConnection
from .file_processor import FileProcessor
from core.utils.logger import logger
from .validation import FileNameValidator, ValidationError, validate_folder_name_unique, validate_file_name_unique_in_folder

# Constants
MAX_TOTAL_FILE_SIZE = 50 * 1024 * 1024  # 50MB total limit per user

router = APIRouter(prefix="/knowledge-base", tags=["knowledge-base"])


# Helper function to check total file size limit
async def check_total_file_size_limit(account_id: str, new_file_size: int):
    """Check if adding a new file would exceed the total file size limit."""
    try:
        client = await DBConnection().client
        
        # Get total size of all current entries for this account
        result = await client.table('knowledge_base_entries').select(
            'file_size'
        ).eq('account_id', account_id).eq('is_active', True).execute()
        
        current_total_size = sum(entry['file_size'] for entry in result.data)
        new_total_size = current_total_size + new_file_size
        
        if new_total_size > MAX_TOTAL_FILE_SIZE:
            current_mb = current_total_size / (1024 * 1024)
            new_mb = new_file_size / (1024 * 1024)
            limit_mb = MAX_TOTAL_FILE_SIZE / (1024 * 1024)
            
            raise HTTPException(
                status_code=413,
                detail=f"File size limit exceeded. Current total: {current_mb:.1f}MB, New file: {new_mb:.1f}MB, Limit: {limit_mb}MB"
            )
            
        return True
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error checking file size limit: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to check file size limit")

# Models
class FolderRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    description: Optional[str] = None
    
    @validator('name')
    def validate_folder_name(cls, v):
        is_valid, error_message = FileNameValidator.validate_name(v, "folder")
        if not is_valid:
            raise ValueError(error_message)
        return FileNameValidator.sanitize_name(v)

class UpdateFolderRequest(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=255)
    description: Optional[str] = None
    
    @validator('name')
    def validate_folder_name(cls, v):
        if v is not None:
            is_valid, error_message = FileNameValidator.validate_name(v, "folder")
            if not is_valid:
                raise ValueError(error_message)
            return FileNameValidator.sanitize_name(v)
        return v

class FolderResponse(BaseModel):
    folder_id: str
    name: str
    description: Optional[str]
    entry_count: int
    created_at: str

class EntryResponse(BaseModel):
    entry_id: str
    filename: str
    summary: str
    file_size: int
    created_at: str

class UpdateEntryRequest(BaseModel):
    summary: str = Field(..., min_length=1, max_length=1000)

class AgentAssignmentRequest(BaseModel):
    folder_ids: List[str]

db = DBConnection()
file_processor = FileProcessor()

# Folder management
@router.get("/folders", response_model=List[FolderResponse])
async def get_folders(user_id: str = Depends(verify_and_get_user_id_from_jwt)):
    """Get all knowledge base folders for user."""
    try:
        client = await db.client
        account_id = user_id
        
        result = await client.table('knowledge_base_folders').select(
            'folder_id, name, description, created_at'
        ).eq('account_id', account_id).order('created_at', desc=True).execute()
        
        folders = []
        for folder_data in result.data:
            # Count entries in folder
            count_result = await client.table('knowledge_base_entries').select(
                'entry_id', count='exact'
            ).eq('folder_id', folder_data['folder_id']).execute()
            
            folders.append(FolderResponse(
                folder_id=folder_data['folder_id'],
                name=folder_data['name'],
                description=folder_data['description'],
                entry_count=count_result.count or 0,
                created_at=folder_data['created_at']
            ))
        
        return folders
        
    except Exception as e:
        logger.error(f"Error getting folders: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to retrieve folders")

@router.post("/folders", response_model=FolderResponse)
async def create_folder(
    folder_data: FolderRequest,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """Create a new knowledge base folder."""
    try:
        client = await db.client
        account_id = user_id
        
        # Get existing folder names to check for conflicts
        existing_result = await client.table('knowledge_base_folders').select('name').eq('account_id', account_id).execute()
        existing_names = [folder['name'] for folder in existing_result.data]
        
        # Generate unique name if there's a conflict
        final_name = FileNameValidator.generate_unique_name(folder_data.name, existing_names, "folder")
        
        insert_data = {
            'account_id': account_id,
            'name': final_name,
            'description': folder_data.description
        }
        
        result = await client.table('knowledge_base_folders').insert(insert_data).execute()
        
        if not result.data:
            raise HTTPException(status_code=500, detail="Failed to create folder")
        
        created_folder = result.data[0]
        
        return FolderResponse(
            folder_id=created_folder['folder_id'],
            name=created_folder['name'],
            description=created_folder['description'],
            entry_count=0,
            created_at=created_folder['created_at']
        )
        
    except ValidationError:
        raise
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error creating folder: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to create folder")

@router.put("/folders/{folder_id}", response_model=FolderResponse)
async def update_folder(
    folder_id: str,
    folder_data: UpdateFolderRequest,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """Update a knowledge base folder."""
    try:
        client = await db.client
        account_id = user_id
        
        # Verify ownership and get current folder
        folder_result = await client.table('knowledge_base_folders').select(
            'folder_id, name, description, created_at'
        ).eq('folder_id', folder_id).eq('account_id', account_id).execute()
        
        if not folder_result.data:
            raise HTTPException(status_code=404, detail="Folder not found")
        
        current_folder = folder_result.data[0]
        
        # Build update data with only provided fields
        update_data = {}
        if folder_data.name is not None:
            # Validate name uniqueness (excluding current folder)
            await validate_folder_name_unique(folder_data.name, account_id, folder_id)
            update_data['name'] = folder_data.name
        if folder_data.description is not None:
            update_data['description'] = folder_data.description
            
        # If no fields to update, return current folder
        if not update_data:
            # Count entries in folder
            count_result = await client.table('knowledge_base_entries').select(
                'entry_id', count='exact'
            ).eq('folder_id', folder_id).execute()
            
            return FolderResponse(
                folder_id=current_folder['folder_id'],
                name=current_folder['name'],
                description=current_folder['description'],
                entry_count=count_result.count or 0,
                created_at=current_folder['created_at']
            )
        
        # Update folder
        result = await client.table('knowledge_base_folders').update(
            update_data
        ).eq('folder_id', folder_id).execute()
        
        if not result.data:
            raise HTTPException(status_code=500, detail="Failed to update folder")
        
        updated_folder = result.data[0]
        
        # Count entries in folder
        count_result = await client.table('knowledge_base_entries').select(
            'entry_id', count='exact'
        ).eq('folder_id', folder_id).execute()
        
        return FolderResponse(
            folder_id=updated_folder['folder_id'],
            name=updated_folder['name'],
            description=updated_folder['description'],
            entry_count=count_result.count or 0,
            created_at=updated_folder['created_at']
        )
        
    except ValidationError:
        raise
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating folder: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to update folder")

@router.delete("/folders/{folder_id}")
async def delete_folder(
    folder_id: str,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """Delete a knowledge base folder and all its entries."""
    try:
        client = await db.client
        account_id = user_id
        
        # Verify ownership
        folder_result = await client.table('knowledge_base_folders').select(
            'folder_id'
        ).eq('folder_id', folder_id).eq('account_id', account_id).execute()
        
        if not folder_result.data:
            raise HTTPException(status_code=404, detail="Folder not found")
        
        # Get all entries in the folder to delete their files from S3
        entries_result = await client.table('knowledge_base_entries').select(
            'entry_id, file_path'
        ).eq('folder_id', folder_id).execute()
        
        # Delete all files from S3 storage
        if entries_result.data:
            file_paths = [entry['file_path'] for entry in entries_result.data]
            try:
                await client.storage.from_('file-uploads').remove(file_paths)
                logger.info(f"Deleted {len(file_paths)} files from S3 for folder {folder_id}")
            except Exception as e:
                logger.warning(f"Failed to delete some files from S3: {str(e)}")
        
        # Delete folder (cascade will handle entries and assignments in DB)
        await client.table('knowledge_base_folders').delete().eq('folder_id', folder_id).execute()
        
        return {"success": True}
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting folder: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to delete folder")

# File upload
@router.post("/folders/{folder_id}/upload")
async def upload_file(
    folder_id: str,
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """Upload a file to a knowledge base folder."""
    import time
    start_time = time.time()
    logger.info(f"[UPLOAD] Starting upload for file: {file.filename}")
    
    try:
        client = await db.client
        account_id = user_id
        
        # Verify folder ownership
        t1 = time.time()
        folder_result = await client.table('knowledge_base_folders').select(
            'folder_id'
        ).eq('folder_id', folder_id).eq('account_id', account_id).execute()
        logger.info(f"[UPLOAD] Folder verification took: {time.time() - t1:.2f}s")
        
        if not folder_result.data:
            raise HTTPException(status_code=404, detail="Folder not found")
        
        # Validate and sanitize filename
        if not file.filename:
            raise ValidationError("Filename is required")
        
        t2 = time.time()
        is_valid, error_message = FileNameValidator.validate_name(file.filename, "file")
        if not is_valid:
            raise ValidationError(error_message)
        logger.info(f"[UPLOAD] Filename validation took: {time.time() - t2:.2f}s")
        
        # Read file content
        t3 = time.time()
        file_content = await file.read()
        logger.info(f"[UPLOAD] File read ({len(file_content)} bytes) took: {time.time() - t3:.2f}s")
        
        # Check total file size limit before processing
        t4 = time.time()
        await check_total_file_size_limit(account_id, len(file_content))
        logger.info(f"[UPLOAD] Size limit check took: {time.time() - t4:.2f}s")
        
        # Generate unique filename if there's a conflict
        t5 = time.time()
        final_filename = await validate_file_name_unique_in_folder(file.filename, folder_id)
        logger.info(f"[UPLOAD] Filename uniqueness check took: {time.time() - t5:.2f}s")
        
        # Process file in background
        t6 = time.time()
        result = await file_processor.process_file_fast(
            account_id=account_id,
            folder_id=folder_id,
            file_content=file_content,
            filename=final_filename,
            mime_type=file.content_type or 'application/octet-stream',
            background_tasks=background_tasks
        )
        logger.info(f"[UPLOAD] File processing took: {time.time() - t6:.2f}s")
        
        if not result['success']:
            raise HTTPException(status_code=400, detail=result['error'])
        
        # Add info about filename changes
        if final_filename != file.filename:
            result['filename_changed'] = True
            result['original_filename'] = file.filename
            result['final_filename'] = final_filename
        
        logger.info(f"[UPLOAD] Total upload time: {time.time() - start_time:.2f}s")
        return result
        
    except ValidationError:
        raise
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error uploading file: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to upload file")

# Entries
@router.get("/folders/{folder_id}/entries", response_model=List[EntryResponse])
async def get_folder_entries(
    folder_id: str,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """Get all entries in a folder."""
    try:
        client = await db.client
        account_id = user_id
        
        # Verify folder ownership
        folder_result = await client.table('knowledge_base_folders').select(
            'folder_id'
        ).eq('folder_id', folder_id).eq('account_id', account_id).execute()
        
        if not folder_result.data:
            raise HTTPException(status_code=404, detail="Folder not found")
        
        result = await client.table('knowledge_base_entries').select(
            'entry_id, filename, summary, file_size, created_at'
        ).eq('folder_id', folder_id).eq('is_active', True).order('created_at', desc=True).execute()
        
        return [
            EntryResponse(
                entry_id=entry['entry_id'],
                filename=entry['filename'],
                summary=entry['summary'],
                file_size=entry['file_size'],
                created_at=entry['created_at']
            )
            for entry in result.data
        ]
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting folder entries: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to retrieve entries")

@router.delete("/entries/{entry_id}")
async def delete_entry(
    entry_id: str,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """Delete a knowledge base entry."""
    try:
        client = await db.client
        account_id = user_id
        
        # Verify ownership
        entry_result = await client.table('knowledge_base_entries').select(
            'entry_id, file_path'
        ).eq('entry_id', entry_id).eq('account_id', account_id).execute()
        
        if not entry_result.data:
            raise HTTPException(status_code=404, detail="Entry not found")
        
        entry = entry_result.data[0]
        
        # Delete from S3
        try:
            await client.storage.from_('file-uploads').remove([entry['file_path']])
        except Exception as e:
            logger.warning(f"Failed to delete file from S3: {str(e)}")
        
        # Delete from database
        await client.table('knowledge_base_entries').delete().eq('entry_id', entry_id).execute()
        
        return {"success": True}
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting entry: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to delete entry")

@router.patch("/entries/{entry_id}", response_model=EntryResponse)
async def update_entry(
    entry_id: str,
    request: UpdateEntryRequest,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """Update a knowledge base entry summary."""
    try:
        client = await db.client
        account_id = user_id
        
        # Verify ownership and get current entry
        entry_result = await client.table('knowledge_base_entries').select(
            'entry_id, filename, summary, file_size, created_at, account_id'
        ).eq('entry_id', entry_id).eq('account_id', account_id).execute()
        
        if not entry_result.data:
            raise HTTPException(status_code=404, detail="Entry not found")
        
        # Update the summary
        update_result = await client.table('knowledge_base_entries').update({
            'summary': request.summary
        }).eq('entry_id', entry_id).execute()
        
        if not update_result.data:
            raise HTTPException(status_code=500, detail="Failed to update entry")
        
        # Return the updated entry
        updated_entry = update_result.data[0]
        return EntryResponse(
            entry_id=updated_entry['entry_id'],
            filename=updated_entry['filename'],
            summary=updated_entry['summary'],
            file_size=updated_entry['file_size'],
            created_at=updated_entry['created_at']
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating entry: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to update entry")

# Agent assignments
@router.get("/agents/{agent_id}/assignments")
async def get_agent_assignments(
    agent_id: str,
    auth: AuthorizedAgentAccess = Depends(require_agent_access)
):
    """Get entry assignments for an agent."""
    try:
        client = await DBConnection().client
        
        # Get file-level assignments only
        file_result = await client.table('agent_knowledge_entry_assignments').select(
            'entry_id, enabled'
        ).eq('agent_id', agent_id).execute()
        
        return {row['entry_id']: row['enabled'] for row in file_result.data}
        
    except Exception as e:
        logger.error(f"Error getting agent assignments: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to retrieve agent assignments")

@router.post("/agents/{agent_id}/assignments")
async def update_agent_assignments(
    agent_id: str,
    assignment_data: dict,
    auth: AuthorizedAgentAccess = Depends(require_agent_access)
):
    """Update agent entry assignments."""
    try:
        client = await db.client
        account_id = auth.user_id
        entry_ids = assignment_data.get('entry_ids', [])
        
        # Clear existing assignments
        await client.table('agent_knowledge_entry_assignments').delete().eq('agent_id', agent_id).execute()
        
        # Insert new entry assignments
        for entry_id in entry_ids:
            await client.table('agent_knowledge_entry_assignments').insert({
                'agent_id': agent_id,
                'entry_id': entry_id,
                'account_id': account_id,
                'enabled': True
            }).execute()
        
        # Invalidate agent config cache (knowledge base assignments changed)
        try:
            from core.runtime_cache import invalidate_agent_config_cache
            await invalidate_agent_config_cache(agent_id)
            logger.debug(f"🗑️ Invalidated cache for agent {agent_id} after knowledge base update")
        except Exception as e:
            logger.warning(f"Failed to invalidate cache for agent {agent_id}: {e}")
        
        return {"success": True, "message": "Assignments updated successfully"}
        
    except Exception as e:
        logger.error(f"Error updating agent assignments: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to update assignments")

class FolderMoveRequest(BaseModel):
    folder_id: str

# File operations
@router.put("/entries/{entry_id}/move")
async def move_file(
    entry_id: str,
    request: FolderMoveRequest,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """Move a file to a different folder."""
    try:
        client = await db.client
        account_id = user_id
        
        # Get current entry details including file path and filename
        entry_result = await client.table('knowledge_base_entries').select(
            'entry_id, folder_id, file_path, filename'
        ).eq('entry_id', entry_id).execute()
        
        if not entry_result.data:
            raise HTTPException(status_code=404, detail="File not found")
        
        entry = entry_result.data[0]
        current_folder_id = entry['folder_id']
        current_file_path = entry['file_path']
        filename = entry['filename']
        
        # If already in the target folder, no need to move
        if current_folder_id == request.folder_id:
            return {"success": True, "message": "File is already in the target folder"}
        
        # Verify target folder belongs to user
        folder_result = await client.table('knowledge_base_folders').select(
            'folder_id'
        ).eq('folder_id', request.folder_id).eq('account_id', account_id).execute()
        
        if not folder_result.data:
            raise HTTPException(status_code=404, detail="Target folder not found")
        
        # Sanitize filename for storage (same logic as file processor)
        sanitized_filename = file_processor.sanitize_filename(filename)
        
        # Create new file path
        new_file_path = f"knowledge-base/{request.folder_id}/{entry_id}/{sanitized_filename}"
        
        # Move file in storage
        try:
            # Copy file to new location
            copy_result = await client.storage.from_('file-uploads').copy(
                current_file_path, new_file_path
            )
            
            # Remove old file
            await client.storage.from_('file-uploads').remove([current_file_path])
            
        except Exception as storage_error:
            logger.error(f"Error moving file in storage: {str(storage_error)}")
            raise HTTPException(status_code=500, detail="Failed to move file in storage")
        
        # Update the database with new folder and file path
        await client.table('knowledge_base_entries').update({
            'folder_id': request.folder_id,
            'file_path': new_file_path
        }).eq('entry_id', entry_id).execute()
        
        return {"success": True, "message": "File moved successfully"}
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error moving file: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to move file")