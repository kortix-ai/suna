import json
from typing import List, Optional
from fastapi import APIRouter, HTTPException, Depends, UploadFile, File, Form, BackgroundTasks
from pydantic import BaseModel, Field, HttpUrl
from core.utils.auth_utils import verify_and_get_user_id_from_jwt, verify_and_get_agent_authorization, require_agent_access, AuthorizedAgentAccess
from core.services.supabase import DBConnection
from core.knowledge_base.file_processor import FileProcessor
from core.utils.logger import logger

# Constants
MAX_TOTAL_FILE_SIZE = 50 * 1024 * 1024  # 50MB total limit per user

db = DBConnection()

router = APIRouter(prefix="/knowledge-base", tags=["knowledge-base"])

# Helper function to check total file size limit
async def check_total_file_size_limit(account_id: str, new_file_size: int):
    """Check if adding a new file would exceed the total file size limit."""
    try:
        client = await db.client
        
        # Get total size of all current entries for this account
        result = await client.from_('knowledge_base_entries').select(
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

# Folder management
class CreateFolderRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    description: Optional[str] = None

class FolderResponse(BaseModel):
    folder_id: str
    name: str
    description: Optional[str]
    entry_count: int
    created_at: str

async def get_user_account_id(client, user_id: str) -> str:
    """Get account_id for a user from the account_user table"""
    account_user_result = await client.schema('basejump').from_('account_user').select('account_id').eq('user_id', user_id).execute()
    
    if not account_user_result.data or len(account_user_result.data) == 0:
        raise HTTPException(status_code=404, detail="User account not found")
    
    return account_user_result.data[0]['account_id']


@router.get("/folders", response_model=List[FolderResponse])
async def get_folders(
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """Get all folders for the current user"""
    try:
        client = await db.client
        
        # Get current account_id from user
        account_id = await get_user_account_id(client, user_id)
        
        # Get folders for this account
        result = await client.from_("knowledge_base_folders").select("*").eq("account_id", account_id).order("created_at", desc=True).execute()
        
        folders = []
        for folder in result.data:
            folders.append(FolderResponse(
                folder_id=folder["folder_id"],
                name=folder["name"],
                description=folder.get("description"),
                entry_count=folder.get("entry_count", 0),
                created_at=folder["created_at"]
            ))
        
        return folders
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting folders: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to retrieve folders")

@router.post("/folders", response_model=FolderResponse)
async def create_folder(
    request: CreateFolderRequest,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """Create a new folder"""
    try:
        client = await db.client
        
        # Get current account_id from user
        account_id = await get_user_account_id(client, user_id)
        
        # Create folder
        result = await client.from_("knowledge_base_folders").insert({
            "name": request.name,
            "description": request.description,
            "account_id": account_id
        }).execute()
        
        if result.data:
            folder = result.data[0]
            return FolderResponse(
                folder_id=folder["folder_id"],
                name=folder["name"],
                description=folder.get("description"),
                entry_count=0,
                created_at=folder["created_at"]
            )
        else:
            raise HTTPException(status_code=500, detail="Failed to create folder")
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error creating folder: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to create folder")

class UpdateFolderRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    description: Optional[str] = None

@router.put("/folders/{folder_id}", response_model=FolderResponse)
async def update_folder(
    folder_id: str,
    request: UpdateFolderRequest,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """Update/rename a folder"""
    try:
        client = await db.client
        
        # Verify folder access
        folder_result = await client.from_("knowledge_base_folders").select("account_id").eq("folder_id", folder_id).single().execute()
        if not folder_result.data:
            raise HTTPException(status_code=404, detail="Folder not found")
        
        # Get current account_id from user
        user_account_id = await get_user_account_id(client, user_id)
        if user_account_id != folder_result.data["account_id"]:
            raise HTTPException(status_code=403, detail="Access denied")
        
        # Update folder
        result = await client.from_("knowledge_base_folders").update({
            "name": request.name,
            "description": request.description
        }).eq("folder_id", folder_id).select().execute()
        
        if result.data:
            folder = result.data[0]
            return FolderResponse(
                folder_id=folder["folder_id"],
                name=folder["name"],
                description=folder.get("description"),
                entry_count=folder.get("entry_count", 0),
                created_at=folder["created_at"]
            )
        else:
            raise HTTPException(status_code=500, detail="Failed to update folder")
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating folder: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to update folder")

@router.get("/folders/{folder_id}/entries")
async def get_folder_entries(
    folder_id: str,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """Get all entries in a folder"""
    try:
        client = await db.client
        
        # Verify folder access
        folder_result = await client.from_("knowledge_base_folders").select("account_id").eq("folder_id", folder_id).single().execute()
        if not folder_result.data:
            raise HTTPException(status_code=404, detail="Folder not found")
        
        # Get current account_id from user
        user_account_id = await get_user_account_id(client, user_id)
        if user_account_id != folder_result.data["account_id"]:
            raise HTTPException(status_code=403, detail="Access denied")
        
        # Get entries
        result = await client.from_("knowledge_base_entries").select("*").eq("folder_id", folder_id).order("created_at", desc=True).execute()
        
        entries = result.data if result.data else []
        return {"entries": entries}
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting folder entries: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to retrieve folder entries")

class KnowledgeBaseEntry(BaseModel):
    entry_id: Optional[str] = None
    name: str = Field(..., min_length=1, max_length=255)
    description: Optional[str] = None
    content: str = Field(..., min_length=1)
    usage_context: str = Field(default="always", pattern="^(always|on_request|contextual)$")
    is_active: bool = True

class KnowledgeBaseEntryResponse(BaseModel):
    entry_id: str
    name: str
    description: Optional[str]
    content: str
    usage_context: str
    is_active: bool
    content_tokens: Optional[int]
    created_at: str
    updated_at: str
    source_type: Optional[str] = None
    source_metadata: Optional[dict] = None
    file_size: Optional[int] = None
    file_mime_type: Optional[str] = None

class KnowledgeBaseListResponse(BaseModel):
    entries: List[KnowledgeBaseEntryResponse]
    total_count: int
    total_tokens: int

class CreateKnowledgeBaseEntryRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    description: Optional[str] = None
    content: str = Field(..., min_length=1)
    usage_context: str = Field(default="always", pattern="^(always|on_request|contextual)$")

class UpdateKnowledgeBaseEntryRequest(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=255)
    description: Optional[str] = None
    content: Optional[str] = Field(None, min_length=1)
    usage_context: Optional[str] = Field(None, pattern="^(always|on_request|contextual)$")
    is_active: Optional[bool] = None

class ProcessingJobResponse(BaseModel):
    job_id: str
    job_type: str
    status: str
    source_info: dict
    result_info: dict
    entries_created: int
    total_files: int
    created_at: str
    completed_at: Optional[str]
    error_message: Optional[str]

db = DBConnection()


@router.get("/agents/{agent_id}", response_model=KnowledgeBaseListResponse)
async def get_agent_knowledge_base(
    agent_id: str,
    include_inactive: bool = False,
    auth: AuthorizedAgentAccess = Depends(require_agent_access)
):
    
    """Get all knowledge base entries for an agent"""
    try:
        client = await db.client
        user_id = auth.user_id        # Already authenticated and authorized!
        agent_data = auth.agent_data  # Agent data already fetched during authorization

        # No need for manual authorization - it's already done in the dependency!

        result = await client.rpc('get_agent_knowledge_base', {
            'p_agent_id': agent_id,
            'p_include_inactive': include_inactive
        }).execute()
        
        entries = []
        total_tokens = 0
        
        for entry_data in result.data or []:
            entry = KnowledgeBaseEntryResponse(
                entry_id=entry_data['entry_id'],
                name=entry_data['name'],
                description=entry_data['description'],
                content=entry_data['content'],
                usage_context=entry_data['usage_context'],
                is_active=entry_data['is_active'],
                content_tokens=entry_data.get('content_tokens'),
                created_at=entry_data['created_at'],
                updated_at=entry_data.get('updated_at', entry_data['created_at']),
                source_type=entry_data.get('source_type'),
                source_metadata=entry_data.get('source_metadata'),
                file_size=entry_data.get('file_size'),
                file_mime_type=entry_data.get('file_mime_type')
            )
            entries.append(entry)
            total_tokens += entry_data.get('content_tokens', 0) or 0
        
        return KnowledgeBaseListResponse(
            entries=entries,
            total_count=len(entries),
            total_tokens=total_tokens
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting knowledge base for agent {agent_id}: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to retrieve agent knowledge base")

@router.post("/agents/{agent_id}", response_model=KnowledgeBaseEntryResponse)
async def create_agent_knowledge_base_entry(
    agent_id: str,
    entry_data: CreateKnowledgeBaseEntryRequest,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    
    """Create a new knowledge base entry for an agent"""
    try:
        client = await db.client
        
        # Verify agent access and get agent data
        agent_data = await verify_and_get_agent_authorization(client, agent_id, user_id)
        account_id = agent_data['account_id']
        
        insert_data = {
            'agent_id': agent_id,
            'account_id': account_id,
            'name': entry_data.name,
            'description': entry_data.description,
            'content': entry_data.content,
            'usage_context': entry_data.usage_context
        }
        
        result = await client.table('agent_knowledge_base_entries').insert(insert_data).execute()
        
        if not result.data:
            raise HTTPException(status_code=500, detail="Failed to create agent knowledge base entry")
        
        created_entry = result.data[0]
        
        return KnowledgeBaseEntryResponse(
            entry_id=created_entry['entry_id'],
            name=created_entry['name'],
            description=created_entry['description'],
            content=created_entry['content'],
            usage_context=created_entry['usage_context'],
            is_active=created_entry['is_active'],
            content_tokens=created_entry.get('content_tokens'),
            created_at=created_entry['created_at'],
            updated_at=created_entry['updated_at']
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error creating knowledge base entry for agent {agent_id}: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to create agent knowledge base entry")

@router.post("/agents/{agent_id}/upload-file")
async def upload_file_to_agent_kb(
    agent_id: str,
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    
    """Upload and process a file for agent knowledge base"""
    try:
        client = await db.client
        
        # Verify agent access and get agent data
        agent_data = await verify_and_get_agent_authorization(client, agent_id, user_id)
        account_id = agent_data['account_id']
        
        file_content = await file.read()
        
        # Check total file size limit before processing
        await check_total_file_size_limit(account_id, len(file_content))
        
        job_id = await client.rpc('create_agent_kb_processing_job', {
            'p_agent_id': agent_id,
            'p_account_id': account_id,
            'p_job_type': 'file_upload',
            'p_source_info': {
                'filename': file.filename,
                'mime_type': file.content_type,
                'file_size': len(file_content)
            }
        }).execute()
        
        if not job_id.data:
            raise HTTPException(status_code=500, detail="Failed to create processing job")
        
        job_id = job_id.data
        background_tasks.add_task(
            process_file_background,
            job_id,
            agent_id,
            account_id,
            file_content,
            file.filename,
            file.content_type or 'application/octet-stream'
        )
        
        return {
            "job_id": job_id,
            "message": "File upload started. Processing in background.",
            "filename": file.filename
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error uploading file to agent {agent_id}: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to upload file")


@router.put("/{entry_id}", response_model=KnowledgeBaseEntryResponse)
async def update_knowledge_base_entry(
    entry_id: str,
    entry_data: UpdateKnowledgeBaseEntryRequest,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    
    """Update an agent knowledge base entry"""
    try:
        client = await db.client
        
        # Get the entry and verify it exists in agent_knowledge_base_entries table
        entry_result = await client.table('agent_knowledge_base_entries').select('*').eq('entry_id', entry_id).execute()
            
        if not entry_result.data:
            raise HTTPException(status_code=404, detail="Knowledge base entry not found")
        
        entry = entry_result.data[0]
        agent_id = entry['agent_id']
        
        # Verify agent access
        await verify_and_get_agent_authorization(client, agent_id, user_id)
        
        update_data = {}
        if entry_data.name is not None:
            update_data['name'] = entry_data.name
        if entry_data.description is not None:
            update_data['description'] = entry_data.description
        if entry_data.content is not None:
            update_data['content'] = entry_data.content
        if entry_data.usage_context is not None:
            update_data['usage_context'] = entry_data.usage_context
        if entry_data.is_active is not None:
            update_data['is_active'] = entry_data.is_active
        
        if not update_data:
            raise HTTPException(status_code=400, detail="No fields to update")
        
        result = await client.table('agent_knowledge_base_entries').update(update_data).eq('entry_id', entry_id).execute()
        
        if not result.data:
            raise HTTPException(status_code=500, detail="Failed to update knowledge base entry")
        
        updated_entry = result.data[0]
        
        logger.debug(f"Updated agent knowledge base entry {entry_id} for agent {agent_id}")
        
        return KnowledgeBaseEntryResponse(
            entry_id=updated_entry['entry_id'],
            name=updated_entry['name'],
            description=updated_entry['description'],
            content=updated_entry['content'],
            usage_context=updated_entry['usage_context'],
            is_active=updated_entry['is_active'],
            content_tokens=updated_entry.get('content_tokens'),
            created_at=updated_entry['created_at'],
            updated_at=updated_entry['updated_at'],
            source_type=updated_entry.get('source_type'),
            source_metadata=updated_entry.get('source_metadata'),
            file_size=updated_entry.get('file_size'),
            file_mime_type=updated_entry.get('file_mime_type')
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating knowledge base entry {entry_id}: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to update knowledge base entry")

@router.delete("/{entry_id}")
async def delete_knowledge_base_entry(
    entry_id: str,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):

    """Delete an agent knowledge base entry"""
    try:
        client = await db.client
        
        # Get the entry and verify it exists in agent_knowledge_base_entries table
        entry_result = await client.table('agent_knowledge_base_entries').select('entry_id, agent_id').eq('entry_id', entry_id).execute()
            
        if not entry_result.data:
            raise HTTPException(status_code=404, detail="Knowledge base entry not found")
        
        entry = entry_result.data[0]
        agent_id = entry['agent_id']
        
        # Verify agent access
        await verify_and_get_agent_authorization(client, agent_id, user_id)
        
        result = await client.table('agent_knowledge_base_entries').delete().eq('entry_id', entry_id).execute()
        
        logger.debug(f"Deleted agent knowledge base entry {entry_id} for agent {agent_id}")
        
        return {"message": "Knowledge base entry deleted successfully"}
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting knowledge base entry {entry_id}: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to delete knowledge base entry")


@router.get("/{entry_id}", response_model=KnowledgeBaseEntryResponse)
async def get_knowledge_base_entry(
    entry_id: str,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """Get a specific agent knowledge base entry"""
    try:
        client = await db.client
        
        # Get the entry from agent_knowledge_base_entries table only
        result = await client.table('agent_knowledge_base_entries').select('*').eq('entry_id', entry_id).execute()
        
        if not result.data:
            raise HTTPException(status_code=404, detail="Knowledge base entry not found")
        
        entry = result.data[0]
        agent_id = entry['agent_id']
        
        # Verify agent access
        await verify_and_get_agent_authorization(client, agent_id, user_id)
        
        logger.debug(f"Retrieved agent knowledge base entry {entry_id} for agent {agent_id}")
        
        return KnowledgeBaseEntryResponse(
            entry_id=entry['entry_id'],
            name=entry['name'],
            description=entry['description'],
            content=entry['content'],
            usage_context=entry['usage_context'],
            is_active=entry['is_active'],
            content_tokens=entry.get('content_tokens'),
            created_at=entry['created_at'],
            updated_at=entry['updated_at'],
            source_type=entry.get('source_type'),
            source_metadata=entry.get('source_metadata'),
            file_size=entry.get('file_size'),
            file_mime_type=entry.get('file_mime_type')
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting knowledge base entry {entry_id}: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to retrieve knowledge base entry")


@router.get("/agents/{agent_id}/processing-jobs", response_model=List[ProcessingJobResponse])
async def get_agent_processing_jobs(
    agent_id: str,
    limit: int = 10,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    
    """Get processing jobs for an agent"""
    try:
        client = await db.client

        # Verify agent access
        await verify_and_get_agent_authorization(client, agent_id, user_id)
        
        result = await client.rpc('get_agent_kb_processing_jobs', {
            'p_agent_id': agent_id,
            'p_limit': limit
        }).execute()
        
        jobs = []
        for job_data in result.data or []:
            job = ProcessingJobResponse(
                job_id=job_data['job_id'],
                job_type=job_data['job_type'],
                status=job_data['status'],
                source_info=job_data['source_info'],
                result_info=job_data['result_info'],
                entries_created=job_data['entries_created'],
                total_files=job_data['total_files'],
                created_at=job_data['created_at'],
                completed_at=job_data.get('completed_at'),
                error_message=job_data.get('error_message')
            )
            jobs.append(job)
        
        return jobs
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting processing jobs for agent {agent_id}: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to get processing jobs")

async def process_file_background(
    job_id: str,
    agent_id: str,
    account_id: str,
    file_content: bytes,
    filename: str,
    mime_type: str
):
    """Background task to process uploaded files"""
    
    processor = FileProcessor()
    client = await processor.db.client
    try:
        await client.rpc('update_agent_kb_job_status', {
            'p_job_id': job_id,
            'p_status': 'processing'
        }).execute()
        
        result = await processor.process_file_upload(
            agent_id, account_id, file_content, filename, mime_type
        )
        
        if result['success']:
            await client.rpc('update_agent_kb_job_status', {
                'p_job_id': job_id,
                'p_status': 'completed',
                'p_result_info': result,
                'p_entries_created': 1,
                'p_total_files': 1
            }).execute()
        else:
            await client.rpc('update_agent_kb_job_status', {
                'p_job_id': job_id,
                'p_status': 'failed',
                'p_error_message': result.get('error', 'Unknown error')
            }).execute()
            
    except Exception as e:
        logger.error(f"Error in background file processing for job {job_id}: {str(e)}")
        try:
            await client.rpc('update_agent_kb_job_status', {
                'p_job_id': job_id,
                'p_status': 'failed',
                'p_error_message': str(e)
            }).execute()
        except:
            pass


@router.get("/agents/{agent_id}/context")
async def get_agent_knowledge_base_context(
    agent_id: str,
    max_tokens: int = 4000,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    
    """Get knowledge base context for agent prompts"""
    try:
        client = await db.client
        
        # Verify agent access
        await verify_and_get_agent_authorization(client, agent_id, user_id)
        
        result = await client.rpc('get_agent_knowledge_base_context', {
            'p_agent_id': agent_id,
            'p_max_tokens': max_tokens
        }).execute()
        
        context = result.data if result.data else None
        
        return {
            "context": context,
            "max_tokens": max_tokens,
            "agent_id": agent_id
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting knowledge base context for agent {agent_id}: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to retrieve agent knowledge base context")


# Agent Assignment Management
class AgentAssignmentRequest(BaseModel):
    assignments: dict = Field(..., description="Dictionary of folder assignments")

class AgentAssignmentResponse(BaseModel):
    folder_id: str
    enabled: bool
    file_assignments: dict

@router.get("/agents/{agent_id}/assignments")
async def get_agent_assignments(
    agent_id: str,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """Get current knowledge base assignments for an agent"""
    try:
        client = await db.client
        
        # Verify agent access
        await verify_and_get_agent_authorization(client, agent_id, user_id)
        
        # Get specific file assignments only
        file_result = await client.from_("agent_knowledge_entry_assignments").select("entry_id, enabled").eq("agent_id", agent_id).execute()
        
        return {row['entry_id']: row['enabled'] for row in file_result.data}
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting agent assignments for {agent_id}: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to retrieve agent assignments")

@router.post("/agents/{agent_id}/assignments")
async def update_agent_assignments(
    agent_id: str,
    request: AgentAssignmentRequest,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """Update knowledge base assignments for an agent"""
    try:
        client = await db.client
        
        # Verify agent access
        agent_auth = await verify_and_get_agent_authorization(client, agent_id, user_id)
        account_id = agent_auth.account_id
        
        # Delete existing assignments for this agent
        await client.from_("agent_knowledge_entry_assignments").delete().eq("agent_id", agent_id).execute()
        
        # Insert new entry assignments - expect entry_ids list
        entry_ids = request.assignments.get('entry_ids', [])
        for entry_id in entry_ids:
            await client.from_("agent_knowledge_entry_assignments").insert({
                "agent_id": agent_id,
                "entry_id": entry_id,
                "account_id": account_id,
                "enabled": True
            }).execute()
        
        return {"message": "Agent assignments updated successfully"}
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating agent assignments for {agent_id}: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to update agent assignments")


@router.get("/entries/{entry_id}/download")
async def download_file(
    entry_id: str,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """Download the actual file content from S3"""
    try:
        client = await db.client
        
        # Get the entry from knowledge_base_entries table
        result = await client.from_("knowledge_base_entries").select("file_path, filename, mime_type, account_id").eq("entry_id", entry_id).single().execute()
        
        if not result.data:
            raise HTTPException(status_code=404, detail="File not found")
        
        entry = result.data
        
        # Verify user has access to this entry (check account_id)
        user_account_id = await get_user_account_id(client, user_id)
        if user_account_id != entry['account_id']:
            raise HTTPException(status_code=403, detail="Access denied")
        
        # Get file content from S3
        file_response = await client.storage.from_('file-uploads').download(entry['file_path'])
        
        if not file_response:
            raise HTTPException(status_code=404, detail="File content not found in storage")
        
        # For text files, return as text
        if entry['mime_type'] and entry['mime_type'].startswith('text/'):
            return {"content": file_response.decode('utf-8'), "is_binary": False}
        else:
            # For binary files (including PDFs), return base64 encoded content
            import base64
            return {"content": base64.b64encode(file_response).decode('utf-8'), "is_binary": True}
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error downloading file {entry_id}: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to download file")

