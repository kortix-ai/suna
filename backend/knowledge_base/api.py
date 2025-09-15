from typing import List, Optional
from fastapi import APIRouter, HTTPException, Depends, UploadFile, File
from pydantic import BaseModel, Field
from core.utils.auth_utils import verify_and_get_user_id_from_jwt, require_agent_access, AuthorizedAgentAccess
from core.services.supabase import DBConnection
from core.knowledge_base.file_processor import FileProcessor
from core.utils.logger import logger

router = APIRouter(prefix="/knowledge-base", tags=["knowledge-base"])

# Models
class FolderRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    description: Optional[str] = None

class UpdateFolderRequest(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=255)
    description: Optional[str] = None

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
        
        insert_data = {
            'account_id': account_id,
            'name': folder_data.name,
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
    file: UploadFile = File(...),
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """Upload a file to a knowledge base folder."""
    try:
        client = await db.client
        account_id = user_id
        
        # Verify folder ownership
        folder_result = await client.table('knowledge_base_folders').select(
            'folder_id'
        ).eq('folder_id', folder_id).eq('account_id', account_id).execute()
        
        if not folder_result.data:
            raise HTTPException(status_code=404, detail="Folder not found")
        
        # Read file content
        file_content = await file.read()
        
        # Process file
        result = await file_processor.process_file(
            account_id=account_id,
            folder_id=folder_id,
            file_content=file_content,
            filename=file.filename,
            mime_type=file.content_type or 'application/octet-stream'
        )
        
        if not result['success']:
            raise HTTPException(status_code=400, detail=result['error'])
        
        return result
        
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

# Agent assignments
@router.get("/agents/{agent_id}/assignments")
async def get_agent_assignments(
    agent_id: str,
    auth: AuthorizedAgentAccess = Depends(require_agent_access)
):
    """Get detailed assignments (folders and files) for an agent."""
    try:
        client = await db.client
        
        # Get folder assignments
        folder_result = await client.table('agent_knowledge_assignments').select(
            'folder_id'
        ).eq('agent_id', agent_id).execute()
        
        assigned_folder_ids = [row['folder_id'] for row in folder_result.data]
        
        # Get file-level assignments
        if assigned_folder_ids:
            file_result = await client.table('agent_knowledge_entry_assignments').select(
                'entry_id, enabled'
            ).eq('agent_id', agent_id).execute()
            
            file_assignments = {row['entry_id']: row['enabled'] for row in file_result.data}
        else:
            file_assignments = {}
        
        # Build response structure
        assignments = {}
        for folder_id in assigned_folder_ids:
            # Get entries for this folder to build file assignments
            entries_result = await client.table('knowledge_base_entries').select(
                'entry_id'
            ).eq('folder_id', folder_id).execute()
            
            folder_file_assignments = {}
            for entry in entries_result.data:
                entry_id = entry['entry_id']
                # Default to enabled if no specific assignment
                folder_file_assignments[entry_id] = file_assignments.get(entry_id, True)
            
            assignments[folder_id] = {
                'folder_id': folder_id,
                'enabled': True,
                'file_assignments': folder_file_assignments
            }
        
        return assignments
        
    except Exception as e:
        logger.error(f"Error getting agent assignments: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to retrieve agent assignments")

@router.post("/agents/{agent_id}/assignments")
async def update_agent_assignments(
    agent_id: str,
    assignment_data: dict,
    auth: AuthorizedAgentAccess = Depends(require_agent_access)
):
    """Update agent assignments with folder and file-level control."""
    try:
        client = await db.client
        account_id = auth.user_id
        assignments = assignment_data.get('assignments', {})
        
        # Clear existing assignments
        await client.table('agent_knowledge_assignments').delete().eq('agent_id', agent_id).execute()
        await client.table('agent_knowledge_entry_assignments').delete().eq('agent_id', agent_id).execute()
        
        # Process new assignments
        for folder_id, assignment in assignments.items():
            if assignment.get('enabled'):
                # Create folder assignment
                await client.table('agent_knowledge_assignments').insert({
                    'agent_id': agent_id,
                    'folder_id': folder_id,
                    'account_id': account_id
                }).execute()
                
                # Create file-level assignments
                file_assignments = assignment.get('file_assignments', {})
                for entry_id, enabled in file_assignments.items():
                    await client.table('agent_knowledge_entry_assignments').insert({
                        'agent_id': agent_id,
                        'entry_id': entry_id,
                        'account_id': account_id,
                        'enabled': enabled
                    }).execute()
        
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
        
        # Verify both entry and target folder belong to user
        entry_result = await client.table('knowledge_base_entries').select(
            'entry_id, folder_id'
        ).eq('entry_id', entry_id).execute()
        
        if not entry_result.data:
            raise HTTPException(status_code=404, detail="File not found")
        
        folder_result = await client.table('knowledge_base_folders').select(
            'folder_id'
        ).eq('folder_id', request.folder_id).eq('account_id', account_id).execute()
        
        if not folder_result.data:
            raise HTTPException(status_code=404, detail="Target folder not found")
        
        # Update the file's folder
        await client.table('knowledge_base_entries').update({
            'folder_id': request.folder_id
        }).eq('entry_id', entry_id).execute()
        
        return {"success": True, "message": "File moved successfully"}
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error moving file: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to move file")