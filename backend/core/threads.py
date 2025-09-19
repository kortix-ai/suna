import json
import traceback
import uuid
from datetime import datetime, timezone
from typing import Optional
from fastapi import APIRouter, HTTPException, Depends, Form, Query

from core.utils.auth_utils import verify_and_get_user_id_from_jwt, verify_and_authorize_thread_access, require_thread_access, AuthorizedThreadAccess
from core.utils.logger import logger
from core.sandbox.sandbox import create_sandbox, delete_sandbox

from .api_models import CreateThreadResponse, MessageCreateRequest
from . import core_utils as utils

router = APIRouter()

@router.get("/threads")
async def get_user_threads(
    user_id: str = Depends(verify_and_get_user_id_from_jwt),
    page: Optional[int] = Query(1, ge=1, description="Page number (1-based)"),
    limit: Optional[int] = Query(1000, ge=1, le=1000, description="Number of items per page (max 1000)")
):
    """Get all threads for the current user with associated project data."""
    logger.debug(f"Fetching threads with project data for user: {user_id} (page={page}, limit={limit})")
    client = await utils.db.client
    try:
        offset = (page - 1) * limit
        
        # First, get threads for the user
        threads_result = await client.table('threads').select('*').eq('account_id', user_id).order('created_at', desc=True).execute()
        
        if not threads_result.data:
            logger.debug(f"No threads found for user: {user_id}")
            return {
                "threads": [],
                "pagination": {
                    "page": page,
                    "limit": limit,
                    "total": 0,
                    "pages": 0
                }
            }
        
        total_count = len(threads_result.data)
        
        # Apply pagination to threads
        paginated_threads = threads_result.data[offset:offset + limit]
        
        # Extract unique project IDs from threads that have them
        project_ids = [
            thread['project_id'] for thread in paginated_threads 
            if thread.get('project_id')
        ]
        unique_project_ids = list(set(project_ids)) if project_ids else []
        
        # Fetch projects if we have project IDs
        projects_by_id = {}
        if unique_project_ids:
            from core.utils.query_utils import batch_query_in
            
            projects_data = await batch_query_in(
                client=client,
                table_name='projects',
                select_fields='*',
                in_field='project_id',
                in_values=unique_project_ids
            )
            
            logger.debug(f"[API] Retrieved {len(projects_data)} projects")
            # Create a lookup map of projects by ID
            projects_by_id = {
                project['project_id']: project 
                for project in projects_data
            }
        
        # Map threads with their associated projects
        mapped_threads = []
        for thread in paginated_threads:
            project_data = None
            if thread.get('project_id') and thread['project_id'] in projects_by_id:
                project = projects_by_id[thread['project_id']]
                project_data = {
                    "project_id": project['project_id'],
                    "name": project.get('name', ''),
                    "description": project.get('description', ''),
                    "sandbox": project.get('sandbox', {}),
                    "is_public": project.get('is_public', False),
                    "created_at": project['created_at'],
                    "updated_at": project['updated_at']
                }
            
            mapped_thread = {
                "thread_id": thread['thread_id'],
                "project_id": thread.get('project_id'),
                "metadata": thread.get('metadata', {}),
                "is_public": thread.get('is_public', False),
                "created_at": thread['created_at'],
                "updated_at": thread['updated_at'],
                "project": project_data
            }
            mapped_threads.append(mapped_thread)
        
        total_pages = (total_count + limit - 1) // limit if total_count else 0
        
        logger.debug(f"[API] Mapped threads for frontend: {len(mapped_threads)} threads, {len(projects_by_id)} unique projects")
        
        return {
            "threads": mapped_threads,
            "pagination": {
                "page": page,
                "limit": limit,
                "total": total_count,
                "pages": total_pages
            }
        }
        
    except Exception as e:
        logger.error(f"Error fetching threads for user {user_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to fetch threads: {str(e)}")

@router.get("/threads/{thread_id}")
async def get_thread(
    thread_id: str,
    auth: AuthorizedThreadAccess = Depends(require_thread_access)
):
    """Get a specific thread by ID with complete related data."""
    logger.debug(f"Fetching thread: {thread_id}")
    client = await utils.db.client
    user_id = auth.user_id  # Already authenticated and authorized!
    
    try:
        # No need for manual authorization - it's already done in the dependency!
        
        # Get the thread data
        thread_result = await client.table('threads').select('*').eq('thread_id', thread_id).execute()
        
        if not thread_result.data:
            raise HTTPException(status_code=404, detail="Thread not found")
        
        thread = thread_result.data[0]
        
        # Get associated project if thread has a project_id
        project_data = None
        if thread.get('project_id'):
            project_result = await client.table('projects').select('*').eq('project_id', thread['project_id']).execute()
            
            if project_result.data:
                project = project_result.data[0]
                logger.debug(f"[API] Raw project from DB for thread {thread_id}")
                project_data = {
                    "project_id": project['project_id'],
                    "name": project.get('name', ''),
                    "description": project.get('description', ''),
                    "sandbox": project.get('sandbox', {}),
                    "is_public": project.get('is_public', False),
                    "created_at": project['created_at'],
                    "updated_at": project['updated_at']
                }
        
        # Get message count for the thread
        message_count_result = await client.table('messages').select('message_id', count='exact').eq('thread_id', thread_id).execute()
        message_count = message_count_result.count if message_count_result.count is not None else 0
        
        # Get recent agent runs for the thread
        agent_runs_result = await client.table('agent_runs').select('*').eq('thread_id', thread_id).order('created_at', desc=True).execute()
        agent_runs_data = []
        if agent_runs_result.data:
            agent_runs_data = [{
                "id": run['id'],
                "status": run.get('status', ''),
                "started_at": run.get('started_at'),
                "completed_at": run.get('completed_at'),
                "error": run.get('error'),
                "agent_id": run.get('agent_id'),
                "agent_version_id": run.get('agent_version_id'),
                "created_at": run['created_at']
            } for run in agent_runs_result.data]
        
        # Map thread data for frontend (matching actual DB structure)
        mapped_thread = {
            "thread_id": thread['thread_id'],
            "project_id": thread.get('project_id'),
            "metadata": thread.get('metadata', {}),
            "is_public": thread.get('is_public', False),
            "created_at": thread['created_at'],
            "updated_at": thread['updated_at'],
            "project": project_data,
            "message_count": message_count,
            "recent_agent_runs": agent_runs_data
        }
        
        logger.debug(f"[API] Mapped thread for frontend: {thread_id} with {message_count} messages and {len(agent_runs_data)} recent runs")
        return mapped_thread
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching thread {thread_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to fetch thread: {str(e)}")

@router.post("/threads", response_model=CreateThreadResponse)
async def create_thread(
    name: Optional[str] = Form(None),
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """
    Create a new thread without starting an agent run.

    [WARNING] Keep in sync with initiate endpoint.
    """
    if not name:
        name = "New Project"
    logger.debug(f"Creating new thread with name: {name}")
    client = await utils.db.client
    account_id = user_id  # In Basejump, personal account_id is the same as user_id
    
    try:
        # 1. Create Project
        project_name = name or "New Project"
        project = await client.table('projects').insert({
            "project_id": str(uuid.uuid4()), 
            "account_id": account_id, 
            "name": project_name,
            "created_at": datetime.now(timezone.utc).isoformat()
        }).execute()
        project_id = project.data[0]['project_id']
        logger.debug(f"Created new project: {project_id}")

        # 2. Create Sandbox
        sandbox_id = None
        try:
            sandbox_pass = str(uuid.uuid4())
            sandbox = await create_sandbox(sandbox_pass, project_id)
            sandbox_id = sandbox.id
            logger.debug(f"Created new sandbox {sandbox_id} for project {project_id}")
            
            # Get preview links
            vnc_link = await sandbox.get_preview_link(6080)
            website_link = await sandbox.get_preview_link(8080)
            vnc_url = vnc_link.url if hasattr(vnc_link, 'url') else str(vnc_link).split("url='")[1].split("'")[0]
            website_url = website_link.url if hasattr(website_link, 'url') else str(website_link).split("url='")[1].split("'")[0]
            token = None
            if hasattr(vnc_link, 'token'):
                token = vnc_link.token
            elif "token='" in str(vnc_link):
                token = str(vnc_link).split("token='")[1].split("'")[0]
        except Exception as e:
            logger.error(f"Error creating sandbox: {str(e)}")
            await client.table('projects').delete().eq('project_id', project_id).execute()
            if sandbox_id:
                try: 
                    await delete_sandbox(sandbox_id)
                except Exception as e: 
                    logger.error(f"Error deleting sandbox: {str(e)}")
            raise Exception("Failed to create sandbox")

        # Update project with sandbox info
        update_result = await client.table('projects').update({
            'sandbox': {
                'id': sandbox_id, 
                'pass': sandbox_pass, 
                'vnc_preview': vnc_url,
                'sandbox_url': website_url, 
                'token': token
            }
        }).eq('project_id', project_id).execute()

        if not update_result.data:
            logger.error(f"Failed to update project {project_id} with new sandbox {sandbox_id}")
            if sandbox_id:
                try: 
                    await delete_sandbox(sandbox_id)
                except Exception as e: 
                    logger.error(f"Error deleting sandbox: {str(e)}")
            raise Exception("Database update failed")

        # 3. Create Thread
        thread_data = {
            "thread_id": str(uuid.uuid4()), 
            "project_id": project_id, 
            "account_id": account_id,
            "created_at": datetime.now(timezone.utc).isoformat()
        }

        from core.utils.logger import structlog
        structlog.contextvars.bind_contextvars(
            thread_id=thread_data["thread_id"],
            project_id=project_id,
            account_id=account_id,
        )
        
        thread = await client.table('threads').insert(thread_data).execute()
        thread_id = thread.data[0]['thread_id']
        logger.debug(f"Created new thread: {thread_id}")

        logger.debug(f"Successfully created thread {thread_id} with project {project_id}")
        return {"thread_id": thread_id, "project_id": project_id}

    except Exception as e:
        logger.error(f"Error creating thread: {str(e)}\n{traceback.format_exc()}")
        # TODO: Clean up created project/thread if creation fails mid-way
        raise HTTPException(status_code=500, detail=f"Failed to create thread: {str(e)}")

@router.get("/threads/{thread_id}/messages")
async def get_thread_messages(
    thread_id: str,
    user_id: str = Depends(verify_and_get_user_id_from_jwt),
    order: str = Query("desc", description="Order by created_at: 'asc' or 'desc'")
):
    """Get all messages for a thread, fetching in batches of 1000 from the DB to avoid large queries."""
    logger.debug(f"Fetching all messages for thread: {thread_id}, order={order}")
    client = await utils.db.client
    await verify_and_authorize_thread_access(client, thread_id, user_id)
    try:
        batch_size = 1000
        offset = 0
        all_messages = []
        while True:
            query = client.table('messages').select('*').eq('thread_id', thread_id)
            query = query.order('created_at', desc=(order == "desc"))
            query = query.range(offset, offset + batch_size - 1)
            messages_result = await query.execute()
            batch = messages_result.data or []
            all_messages.extend(batch)
            logger.debug(f"Fetched batch of {len(batch)} messages (offset {offset})")
            if len(batch) < batch_size:
                break
            offset += batch_size
        return {"messages": all_messages}
    except Exception as e:
        logger.error(f"Error fetching messages for thread {thread_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to fetch messages: {str(e)}")

@router.get("/agent-runs/{agent_run_id}")
async def get_agent_run(
    agent_run_id: str,
    user_id: str = Depends(verify_and_get_user_id_from_jwt),
):
    """
    [DEPRECATED] Get an agent run by ID.

    This endpoint is deprecated and may be removed in future versions.
    """
    logger.warning(f"[DEPRECATED] Fetching agent run: {agent_run_id}")
    client = await utils.db.client
    try:
        agent_run_result = await client.table('agent_runs').select('*').eq('agent_run_id', agent_run_id).eq('account_id', user_id).execute()
        if not agent_run_result.data:
            raise HTTPException(status_code=404, detail="Agent run not found")
        return agent_run_result.data[0]
    except Exception as e:
        logger.error(f"Error fetching agent run {agent_run_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to fetch agent run: {str(e)}")

@router.post("/threads/{thread_id}/messages/add")
async def add_message_to_thread(
    thread_id: str,
    message: str,
    user_id: str = Depends(verify_and_get_user_id_from_jwt),
):
    """Add a message to a thread"""
    logger.debug(f"Adding message to thread: {thread_id}")
    client = await utils.db.client
    await verify_and_authorize_thread_access(client, thread_id, user_id)
    try:
        message_result = await client.table('messages').insert({
            'thread_id': thread_id,
            'type': 'user',
            'is_llm_message': True,
            'content': {
              "role": "user",
              "content": message
            }
        }).execute()
        return message_result.data[0]
    except Exception as e:
        logger.error(f"Error adding message to thread {thread_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to add message: {str(e)}")

@router.post("/threads/{thread_id}/messages")
async def create_message(
    thread_id: str,
    message_data: MessageCreateRequest,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """Create a new message in a thread."""
    logger.debug(f"Creating message in thread: {thread_id}")
    client = await utils.db.client
    
    try:
        await verify_and_authorize_thread_access(client, thread_id, user_id)
        
        message_payload = {
            "role": "user" if message_data.type == "user" else "assistant",
            "content": message_data.content
        }
        
        insert_data = {
            "message_id": str(uuid.uuid4()),
            "thread_id": thread_id,
            "type": message_data.type,
            "is_llm_message": message_data.is_llm_message,
            "content": message_payload,  # Store as JSONB object, not JSON string
            "created_at": datetime.now(timezone.utc).isoformat()
        }
        
        message_result = await client.table('messages').insert(insert_data).execute()
        
        if not message_result.data:
            raise HTTPException(status_code=500, detail="Failed to create message")
        
        logger.debug(f"Created message: {message_result.data[0]['message_id']}")
        return message_result.data[0]
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error creating message in thread {thread_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to create message: {str(e)}")

@router.delete("/threads/{thread_id}/messages/{message_id}")
async def delete_message(
    thread_id: str,
    message_id: str,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """Delete a message from a thread."""
    logger.debug(f"Deleting message from thread: {thread_id}")
    client = await utils.db.client
    await verify_and_authorize_thread_access(client, thread_id, user_id)
    try:
        # Don't allow users to delete the "status" messages
        await client.table('messages').delete().eq('message_id', message_id).eq('is_llm_message', True).eq('thread_id', thread_id).execute()
        return {"message": "Message deleted successfully"}
    except Exception as e:
        logger.error(f"Error deleting message {message_id} from thread {thread_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to delete message: {str(e)}")