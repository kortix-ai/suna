import json
import traceback
import uuid
from datetime import datetime, timezone
from typing import Optional
from fastapi import APIRouter, HTTPException, Depends, Form, Query, Body, Request

from core.utils.auth_utils import verify_and_get_user_id_from_jwt, verify_and_authorize_thread_access, require_thread_access, AuthorizedThreadAccess, get_optional_user_id_from_jwt
from core.utils.logger import logger
from core.sandbox.sandbox import create_sandbox, delete_sandbox
from core.utils.config import config, EnvMode

from .api_models import CreateThreadResponse, MessageCreateRequest
from . import core_utils as utils

router = APIRouter(tags=["threads"])

@router.get("/threads", summary="List User Threads", operation_id="list_user_threads")
async def get_user_threads(
    request: Request,
    user_id: Optional[str] = Depends(get_optional_user_id_from_jwt),
    page: Optional[int] = Query(1, ge=1, description="Page number (1-based)"),
    limit: Optional[int] = Query(100, ge=1, le=1000, description="Number of items per page (max 1000)")
):
    from core.guest_session import guest_session_service
    
    if not user_id:
        guest_session_id = request.headers.get('X-Guest-Session')
        if guest_session_id:
            if isinstance(guest_session_id, list):
                guest_session_id = guest_session_id[0]

            session = await guest_session_service.get_or_create_session(request, guest_session_id)
            user_id = session['session_id']
            logger.info(f"Guest user fetching threads: {user_id}")
        else:
            raise HTTPException(status_code=401, detail="Authentication required")
    
    logger.debug(f"Fetching threads with project data for user: {user_id} (page={page}, limit={limit})")
    client = await utils.db.client
    try:
        offset = (page - 1) * limit
        
        count_result = await client.table('threads').select('*', count='exact').eq('account_id', user_id).execute()
        total_count = count_result.count or 0
        
        if total_count == 0:
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
        
        threads_result = await client.table('threads')\
            .select('*')\
            .eq('account_id', user_id)\
            .order('created_at', desc=True)\
            .range(offset, offset + limit - 1)\
            .execute()
        
        paginated_threads = threads_result.data
        
        project_ids = [
            thread['project_id'] for thread in paginated_threads 
            if thread.get('project_id')
        ]
        unique_project_ids = list(set(project_ids)) if project_ids else []
        
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
            
            projects_by_id = {
                project['project_id']: project 
                for project in projects_data
            }
        
        mapped_threads = []
        for thread in paginated_threads:
            project_data = None
            if thread.get('project_id') and thread['project_id'] in projects_by_id:
                project = projects_by_id[thread['project_id']]
                
                project_data = {
                    "project_id": project['project_id'],
                    "name": project.get('name', ''),
                    "icon_name": project.get('icon_name'),
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

@router.get("/threads/{thread_id}", summary="Get Thread", operation_id="get_thread")
async def get_thread(
    thread_id: str,
    request: Request
):
    logger.debug(f"Fetching thread: {thread_id}")
    client = await utils.db.client
    
    from core.utils.auth_utils import get_optional_user_id
    user_id = await get_optional_user_id(request)
    
    try:
        await verify_and_authorize_thread_access(client, thread_id, user_id)
        
        thread_result = await client.table('threads').select('*').eq('thread_id', thread_id).execute()
        
        if not thread_result.data:
            raise HTTPException(status_code=404, detail="Thread not found")
        
        thread = thread_result.data[0]
        
        project_data = None
        if thread.get('project_id'):
            project_result = await client.table('projects').select('*').eq('project_id', thread['project_id']).execute()
            
            if project_result.data:
                project = project_result.data[0]
                project_data = {
                    "project_id": project['project_id'],
                    "name": project.get('name', ''),
                    "description": project.get('description', ''),
                    "sandbox": project.get('sandbox', {}),
                    "is_public": project.get('is_public', False),
                    "icon_name": project.get('icon_name'),
                    "created_at": project['created_at'],
                    "updated_at": project['updated_at']
                }
        
        message_count_result = await client.table('messages').select('message_id', count='exact').eq('thread_id', thread_id).execute()
        message_count = message_count_result.count if message_count_result.count is not None else 0
        
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
        
        return mapped_thread
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching thread {thread_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to fetch thread: {str(e)}")

@router.post("/threads", response_model=CreateThreadResponse, summary="Create Thread", operation_id="create_thread")
async def create_thread(
    name: Optional[str] = Form(None),
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    if not name:
        name = "New Project"
    logger.debug(f"Creating new thread with name: {name}")
    client = await utils.db.client
    account_id = user_id
    
    try:
        if config.ENV_MODE != EnvMode.LOCAL:
            from core.utils.limits_checker import check_thread_limit, check_project_count_limit
            
            thread_limit_check = await check_thread_limit(client, account_id)
            if not thread_limit_check['can_create']:
                error_detail = {
                    "message": f"Maximum of {thread_limit_check['limit']} threads allowed for your current plan. You have {thread_limit_check['current_count']} threads.",
                    "current_count": thread_limit_check['current_count'],
                    "limit": thread_limit_check['limit'],
                    "tier_name": thread_limit_check['tier_name'],
                    "error_code": "THREAD_LIMIT_EXCEEDED"
                }
                logger.warning(f"Thread limit exceeded for account {account_id}: {thread_limit_check['current_count']}/{thread_limit_check['limit']}")
                raise HTTPException(status_code=402, detail=error_detail)
            
            project_limit_check = await check_project_count_limit(client, account_id)
            if not project_limit_check['can_create']:
                error_detail = {
                    "message": f"Maximum of {project_limit_check['limit']} projects allowed for your current plan. You have {project_limit_check['current_count']} projects.",
                    "current_count": project_limit_check['current_count'],
                    "limit": project_limit_check['limit'],
                    "tier_name": project_limit_check['tier_name'],
                    "error_code": "PROJECT_LIMIT_EXCEEDED"
                }
                logger.warning(f"Project limit exceeded for account {account_id}: {project_limit_check['current_count']}/{project_limit_check['limit']}")
                raise HTTPException(status_code=402, detail=error_detail)
        
        project_name = name or "New Project"
        project = await client.table('projects').insert({
            "project_id": str(uuid.uuid4()), 
            "account_id": account_id, 
            "name": project_name,
            "created_at": datetime.now(timezone.utc).isoformat()
        }).execute()
        project_id = project.data[0]['project_id']
        logger.debug(f"Created new project: {project_id}")

        sandbox_id = None
        try:
            sandbox_pass = str(uuid.uuid4())
            sandbox = await create_sandbox(sandbox_pass, project_id)
            sandbox_id = sandbox.id
            logger.debug(f"Created new sandbox {sandbox_id} for project {project_id}")
            
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
        raise HTTPException(status_code=500, detail=f"Failed to create thread: {str(e)}")

@router.get("/threads/{thread_id}/messages", summary="Get Thread Messages", operation_id="get_thread_messages")
async def get_thread_messages(
    thread_id: str,
    request: Request,
    order: str = Query("desc", description="Order by created_at: 'asc' or 'desc'")
):
    logger.debug(f"Fetching all messages for thread: {thread_id}, order={order}")
    client = await utils.db.client
    
    from core.utils.auth_utils import get_optional_user_id
    user_id = await get_optional_user_id(request)
    
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

@router.post("/threads/{thread_id}/messages/add", summary="Add Message to Thread", operation_id="add_message_to_thread")
async def add_message_to_thread(
    thread_id: str,
    request: Request,
    message: str = Body(..., embed=True),
    user_id: Optional[str] = Depends(get_optional_user_id_from_jwt),
):
    from core.guest_session import guest_session_service
    
    logger.debug(f"Adding message to thread: {thread_id}")
    client = await utils.db.client
    
    if not user_id:
        guest_session_id = request.headers.get('X-Guest-Session')
        if guest_session_id:
            raise HTTPException(
                status_code=403,
                detail={
                    'error': 'guest_chat_disabled',
                    'message': 'Chat is not available in guest mode. Please sign up or log in to continue.',
                    'action': 'signup_required'
                }
            )
        raise HTTPException(status_code=401, detail="Authentication required")
    
    thread_result = await client.table('threads').select('*').eq('thread_id', thread_id).execute()
    if not thread_result.data:
        raise HTTPException(status_code=404, detail="Thread not found")
    
    thread_data = thread_result.data[0]
    
    if thread_data['account_id'] == user_id:
        logger.debug(f"User {user_id} owns thread {thread_id}")
    else:
        agent_runs_result = await client.table('agent_runs').select('metadata').eq('thread_id', thread_id).order('created_at', desc=True).limit(1).execute()
        if agent_runs_result.data:
            metadata = agent_runs_result.data[0].get('metadata', {})
            actual_user_id = metadata.get('actual_user_id')
            if actual_user_id != user_id:
                logger.error(f"Guest {user_id} unauthorized for thread {thread_id} (belongs to {actual_user_id})")
                raise HTTPException(status_code=403, detail="Not authorized to access this thread")
            logger.debug(f"Guest {user_id} authorized for thread {thread_id}")
        else:
            logger.error(f"No agent runs found for thread {thread_id}")
            raise HTTPException(status_code=403, detail="Not authorized to access this thread")
    
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

@router.post("/threads/{thread_id}/messages", summary="Create Thread Message", operation_id="create_thread_message")
async def create_message(
    thread_id: str,
    message_data: MessageCreateRequest,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
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
            "content": message_payload,
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

@router.delete("/threads/{thread_id}/messages/{message_id}", summary="Delete Thread Message", operation_id="delete_thread_message")
async def delete_message(
    thread_id: str,
    message_id: str,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    logger.debug(f"Deleting message from thread: {thread_id}")
    client = await utils.db.client
    await verify_and_authorize_thread_access(client, thread_id, user_id)
    try:
        await client.table('messages').delete().eq('message_id', message_id).eq('is_llm_message', True).eq('thread_id', thread_id).execute()
        return {"message": "Message deleted successfully"}
    except Exception as e:
        logger.error(f"Error deleting message {message_id} from thread {thread_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to delete message: {str(e)}")

@router.patch("/threads/{thread_id}", summary="Update Thread", operation_id="update_thread")
async def update_thread(
    thread_id: str,
    request: Request,
    title: Optional[str] = Body(None, embed=True),
    is_public: Optional[bool] = Body(None, embed=True),
    auth: AuthorizedThreadAccess = Depends(require_thread_access)
):
    logger.debug(f"Updating thread: {thread_id}")
    client = await utils.db.client
    
    try:
        if title is None and is_public is None:
            raise HTTPException(status_code=400, detail="No update data provided")
        
        thread_result = await client.table('threads').select('project_id, metadata').eq('thread_id', thread_id).execute()
        if not thread_result.data:
            raise HTTPException(status_code=404, detail="Thread not found")
        
        thread = thread_result.data[0]
        project_id = thread.get('project_id')
        
        if title is not None and project_id:
            logger.debug(f"Updating project {project_id} name to: {title}")
            project_result = await client.table('projects').update({
                'name': title
            }).eq('project_id', project_id).execute()
            
            if not project_result.data:
                raise HTTPException(status_code=500, detail="Failed to update project name")
        
        thread_update_data = {}
        
        if title is not None:
            current_metadata = thread.get('metadata', {}) or {}
            current_metadata['title'] = title
            thread_update_data['metadata'] = current_metadata
        
        if is_public is not None:
            thread_update_data['is_public'] = is_public
            logger.debug(f"Updating thread {thread_id} is_public to: {is_public}")
            
            if project_id:
                logger.debug(f"Updating project {project_id} is_public to: {is_public}")
                await client.table('projects').update({
                    'is_public': is_public
                }).eq('project_id', project_id).execute()
        
        if thread_update_data:
            thread_update = await client.table('threads').update(thread_update_data).eq('thread_id', thread_id).execute()
            
            if not thread_update.data:
                raise HTTPException(status_code=500, detail="Failed to update thread")
        
        logger.debug(f"Successfully updated thread: {thread_id}")
        
        return await get_thread(thread_id, request)
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating thread {thread_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to update thread: {str(e)}")

@router.delete("/threads/{thread_id}", summary="Delete Thread", operation_id="delete_thread")
async def delete_thread(
    thread_id: str,
    auth: AuthorizedThreadAccess = Depends(require_thread_access)
):
    logger.debug(f"Deleting thread: {thread_id}")
    client = await utils.db.client
    
    try:
        thread_result = await client.table('threads').select('project_id').eq('thread_id', thread_id).execute()
        if not thread_result.data:
            raise HTTPException(status_code=404, detail="Thread not found")
        
        thread = thread_result.data[0]
        project_id = thread.get('project_id')
        sandbox_id = None
        
        if project_id:
            project_result = await client.table('projects').select('sandbox').eq('project_id', project_id).execute()
            if project_result.data and project_result.data[0].get('sandbox'):
                sandbox_data = project_result.data[0]['sandbox']
                sandbox_id = sandbox_data.get('id') if isinstance(sandbox_data, dict) else None
        
        if sandbox_id:
            try:
                logger.debug(f"Deleting sandbox {sandbox_id} for thread {thread_id}")
                await delete_sandbox(sandbox_id)
                logger.debug(f"Successfully deleted sandbox {sandbox_id}")
            except Exception as e:
                logger.error(f"Error deleting sandbox {sandbox_id}: {str(e)}")
        
        logger.debug(f"Deleting agent runs for thread {thread_id}")
        await client.table('agent_runs').delete().eq('thread_id', thread_id).execute()
        
        logger.debug(f"Deleting messages for thread {thread_id}")
        await client.table('messages').delete().eq('thread_id', thread_id).execute()
        
        logger.debug(f"Deleting thread {thread_id}")
        thread_delete_result = await client.table('threads').delete().eq('thread_id', thread_id).execute()
        
        if not thread_delete_result.data:
            raise HTTPException(status_code=500, detail="Failed to delete thread")
        
        if project_id:
            logger.debug(f"Deleting project {project_id}")
            await client.table('projects').delete().eq('project_id', project_id).execute()
        
        logger.debug(f"Successfully deleted thread {thread_id} and all associated data")
        return {"message": "Thread deleted successfully", "thread_id": thread_id}
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting thread {thread_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to delete thread: {str(e)}")