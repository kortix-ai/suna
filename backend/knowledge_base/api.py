import json
from typing import List, Optional
from fastapi import APIRouter, HTTPException, Depends, UploadFile, File, Form, BackgroundTasks
from pydantic import BaseModel, Field, HttpUrl
from utils.auth_utils import verify_and_get_user_id_from_jwt, verify_and_get_agent_authorization, require_agent_access, AuthorizedAgentAccess
from services.supabase import DBConnection
from knowledge_base.file_processor import FileProcessor
from utils.logger import logger

router = APIRouter(prefix="/knowledge-base", tags=["knowledge-base"])

# LlamaCloud Knowledge Base Models
class LlamaCloudKnowledgeBase(BaseModel):
    id: Optional[str] = None
    name: str = Field(..., min_length=1, max_length=255, description="Tool function name (auto-formatted)")
    index_name: str = Field(..., min_length=1, max_length=255, description="LlamaCloud index identifier")
    description: Optional[str] = Field(None, description="What this knowledge base contains")
    is_active: bool = True

class LlamaCloudKnowledgeBaseResponse(BaseModel):
    id: str
    name: str
    index_name: str
    description: Optional[str]
    is_active: bool
    created_at: str
    updated_at: str

class LlamaCloudKnowledgeBaseListResponse(BaseModel):
    knowledge_bases: List[LlamaCloudKnowledgeBaseResponse]
    total_count: int

class CreateLlamaCloudKnowledgeBaseRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=255, description="Tool function name")
    index_name: str = Field(..., min_length=1, max_length=255, description="LlamaCloud index identifier")
    description: Optional[str] = Field(None, description="What this knowledge base contains")

class UpdateLlamaCloudKnowledgeBaseRequest(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=255)
    index_name: Optional[str] = Field(None, min_length=1, max_length=255)
    description: Optional[str] = None
    is_active: Optional[bool] = None

def format_knowledge_base_name(name: str) -> str:
    """Format knowledge base name for tool function generation."""
    return (name.lower()
            .replace(' ', '-')
            .replace('_', '-')
            .strip('-')
            .replace('--', '-'))

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


# =============================================================================
# LLAMACLOUD KNOWLEDGE BASE ENDPOINTS
# =============================================================================

@router.get("/llamacloud/agents/{agent_id}", response_model=LlamaCloudKnowledgeBaseListResponse)
async def get_agent_llamacloud_knowledge_bases(
    agent_id: str,
    include_inactive: bool = False,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """Get all LlamaCloud knowledge bases for an agent"""
    try:
        client = await db.client

        # Verify agent access
        await verify_and_get_agent_authorization(client, agent_id, user_id)

        result = await client.rpc('get_agent_llamacloud_knowledge_bases', {
            'p_agent_id': agent_id,
            'p_include_inactive': include_inactive
        }).execute()
        
        knowledge_bases = []
        
        for kb_data in result.data or []:
            kb = LlamaCloudKnowledgeBaseResponse(
                id=kb_data['id'],
                name=kb_data['name'],
                index_name=kb_data['index_name'],
                description=kb_data['description'],
                is_active=kb_data['is_active'],
                created_at=kb_data['created_at'],
                updated_at=kb_data['updated_at']
            )
            knowledge_bases.append(kb)
        
        return LlamaCloudKnowledgeBaseListResponse(
            knowledge_bases=knowledge_bases,
            total_count=len(knowledge_bases)
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting LlamaCloud knowledge bases for agent {agent_id}: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to retrieve agent LlamaCloud knowledge bases")

@router.post("/llamacloud/agents/{agent_id}", response_model=LlamaCloudKnowledgeBaseResponse)
async def create_agent_llamacloud_knowledge_base(
    agent_id: str,
    kb_data: CreateLlamaCloudKnowledgeBaseRequest,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """Create a new LlamaCloud knowledge base for an agent"""
    try:
        client = await db.client
        
        # Verify agent access and get agent data
        agent_data = await verify_and_get_agent_authorization(client, agent_id, user_id)
        account_id = agent_data['account_id']
        
        # Format the name for tool function generation
        formatted_name = format_knowledge_base_name(kb_data.name)
        
        insert_data = {
            'agent_id': agent_id,
            'account_id': account_id,
            'name': formatted_name,
            'index_name': kb_data.index_name,
            'description': kb_data.description
        }
        
        result = await client.table('agent_llamacloud_knowledge_bases').insert(insert_data).execute()
        
        if not result.data:
            raise HTTPException(status_code=500, detail="Failed to create LlamaCloud knowledge base")
        
        created_kb = result.data[0]
        
        logger.info(f"Created LlamaCloud knowledge base {created_kb['id']} for agent {agent_id}")
        
        return LlamaCloudKnowledgeBaseResponse(
            id=created_kb['id'],
            name=created_kb['name'],
            index_name=created_kb['index_name'],
            description=created_kb['description'],
            is_active=created_kb['is_active'],
            created_at=created_kb['created_at'],
            updated_at=created_kb['updated_at']
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error creating LlamaCloud knowledge base for agent {agent_id}: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to create LlamaCloud knowledge base")

@router.put("/llamacloud/{kb_id}", response_model=LlamaCloudKnowledgeBaseResponse)
async def update_llamacloud_knowledge_base(
    kb_id: str,
    kb_data: UpdateLlamaCloudKnowledgeBaseRequest,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """Update a LlamaCloud knowledge base"""
    try:
        client = await db.client
        
        # Get the knowledge base and verify it exists
        kb_result = await client.table('agent_llamacloud_knowledge_bases').select('*').eq('id', kb_id).execute()
            
        if not kb_result.data:
            raise HTTPException(status_code=404, detail="LlamaCloud knowledge base not found")
        
        kb = kb_result.data[0]
        agent_id = kb['agent_id']
        
        # Verify agent access
        await verify_and_get_agent_authorization(client, agent_id, user_id)
        
        update_data = {}
        if kb_data.name is not None:
            update_data['name'] = format_knowledge_base_name(kb_data.name)
        if kb_data.index_name is not None:
            update_data['index_name'] = kb_data.index_name
        if kb_data.description is not None:
            update_data['description'] = kb_data.description
        if kb_data.is_active is not None:
            update_data['is_active'] = kb_data.is_active
        
        if not update_data:
            raise HTTPException(status_code=400, detail="No fields to update")
        
        result = await client.table('agent_llamacloud_knowledge_bases').update(update_data).eq('id', kb_id).execute()
        
        if not result.data:
            raise HTTPException(status_code=500, detail="Failed to update LlamaCloud knowledge base")
        
        updated_kb = result.data[0]
        
        logger.info(f"Updated LlamaCloud knowledge base {kb_id} for agent {agent_id}")
        
        return LlamaCloudKnowledgeBaseResponse(
            id=updated_kb['id'],
            name=updated_kb['name'],
            index_name=updated_kb['index_name'],
            description=updated_kb['description'],
            is_active=updated_kb['is_active'],
            created_at=updated_kb['created_at'],
            updated_at=updated_kb['updated_at']
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating LlamaCloud knowledge base {kb_id}: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to update LlamaCloud knowledge base")

@router.delete("/llamacloud/{kb_id}")
async def delete_llamacloud_knowledge_base(
    kb_id: str,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """Delete a LlamaCloud knowledge base"""
    try:
        client = await db.client
        
        # Get the knowledge base and verify it exists
        kb_result = await client.table('agent_llamacloud_knowledge_bases').select('id, agent_id').eq('id', kb_id).execute()
            
        if not kb_result.data:
            raise HTTPException(status_code=404, detail="LlamaCloud knowledge base not found")
        
        kb = kb_result.data[0]
        agent_id = kb['agent_id']
        
        # Verify agent access
        await verify_and_get_agent_authorization(client, agent_id, user_id)
        
        result = await client.table('agent_llamacloud_knowledge_bases').delete().eq('id', kb_id).execute()
        
        logger.info(f"Deleted LlamaCloud knowledge base {kb_id} for agent {agent_id}")
        
        return {"message": "LlamaCloud knowledge base deleted successfully"}
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting LlamaCloud knowledge base {kb_id}: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to delete LlamaCloud knowledge base")

@router.post("/llamacloud/agents/{agent_id}/test-search")
async def test_llamacloud_search(
    agent_id: str,
    test_data: dict,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """Test search functionality for a LlamaCloud index"""
    try:
        client = await db.client
        
        # Verify agent access
        await verify_and_get_agent_authorization(client, agent_id, user_id)
        
        index_name = test_data.get('index_name')
        query = test_data.get('query')
        
        if not index_name or not query:
            raise HTTPException(status_code=400, detail="Both index_name and query are required")
        
        # Check if required environment variables are set
        import os
        if not os.getenv("LLAMA_CLOUD_API_KEY"):
            raise HTTPException(
                status_code=400, 
                detail="LLAMA_CLOUD_API_KEY environment variable not configured"
            )
        
        # Import LlamaCloud client
        try:
            from llama_index.indices.managed.llama_cloud import LlamaCloudIndex
        except ImportError:
            raise HTTPException(
                status_code=400,
                detail="LlamaCloud client not installed. Please install llama-index-indices-managed-llama-cloud"
            )
        
        # Set the API key
        os.environ["LLAMA_CLOUD_API_KEY"] = os.getenv("LLAMA_CLOUD_API_KEY")
        
        project_name = os.getenv("LLAMA_CLOUD_PROJECT_NAME", "Default")
        
        logger.info(f"Testing search on index '{index_name}' with query: {query}")
        
        # Connect to the index
        index = LlamaCloudIndex(index_name, project_name=project_name)
        
        # Configure retriever
        retriever = index.as_retriever(
            dense_similarity_top_k=3,
            sparse_similarity_top_k=3,
            alpha=0.5,
            enable_reranking=True,
            rerank_top_n=3,
            retrieval_mode="chunks"
        )
        
        # Perform the search
        nodes = retriever.retrieve(query)
        
        if not nodes:
            return {
                "success": True,
                "message": f"No results found in '{index_name}' for query: {query}",
                "results": [],
                "index_name": index_name,
                "query": query
            }
        
        # Format the results
        results = []
        for i, node in enumerate(nodes):
            result = {
                "rank": i + 1,
                "score": node.score,
                "text": node.text[:500] + "..." if len(node.text) > 500 else node.text,  # Truncate for testing
                "metadata": node.metadata if hasattr(node, 'metadata') else {}
            }
            results.append(result)
        
        return {
            "success": True,
            "message": f"Found {len(results)} results in '{index_name}'",
            "results": results,
            "index_name": index_name,
            "query": query
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error testing LlamaCloud search: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to test search: {str(e)}")

