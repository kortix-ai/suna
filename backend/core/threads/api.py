import asyncio
import json
import traceback
import uuid
from datetime import datetime, timezone
from typing import Optional
from fastapi import APIRouter, HTTPException, Depends, Form, Query, Body, Request
from core.utils.auth_utils import verify_and_get_user_id_from_jwt, verify_and_authorize_thread_access, require_thread_access, AuthorizedThreadAccess, get_optional_user_id
from core.utils.logger import logger
from core.sandbox.sandbox import create_sandbox, delete_sandbox
from core.utils.config import config, EnvMode

from core.api_models import CreateThreadResponse, MessageCreateRequest
from core.services.supabase import DBConnection

db = DBConnection()

router = APIRouter(tags=["threads"])

@router.get("/threads", summary="List User Threads", operation_id="list_user_threads")
async def get_user_threads(
    request: Request,
    user_id: str = Depends(verify_and_get_user_id_from_jwt),
    page: Optional[int] = Query(1, ge=1, description="Page number (1-based)"),
    limit: Optional[int] = Query(100, ge=1, le=1000, description="Number of items per page (max 1000)")
):
    from core.threads.repo import list_user_threads as repo_list_threads
    
    logger.debug(f"Fetching threads for user: {user_id} (page={page}, limit={limit})")
    try:
        offset = (page - 1) * limit
        threads, total_count = await repo_list_threads(user_id, limit, offset)
        
        if total_count == 0:
            logger.debug(f"No threads found for user: {user_id}")
        
        total_pages = (total_count + limit - 1) // limit if total_count else 0
        
        return {
            "threads": threads,
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

@router.get("/projects/{project_id}", summary="Get Project", operation_id="get_project")
async def get_project(
    project_id: str,
    request: Request
):
    """Get a specific project by ID with complete data.
    Supports both authenticated and anonymous access (for public projects)."""
    logger.debug(f"Fetching project: {project_id}")
    client = await db.client
    
    # Try to get user_id from JWT (optional for public projects)
    user_id = await get_optional_user_id(request)
    
    try:
        # Get the project data
        project_result = await client.table('projects').select('*').eq('project_id', project_id).execute()
        
        if not project_result.data or len(project_result.data) == 0:
            raise HTTPException(status_code=404, detail="Project not found")
        
        project = project_result.data[0]
        
        # Check if project is public - allow anonymous access
        is_public = project.get('is_public', False)
        
        if not is_public:
            # For private projects, user must be authenticated
            if not user_id:
                raise HTTPException(status_code=401, detail="Authentication required for private projects")
            
            # Check if user is an admin (admins have access to all projects)
            admin_result = await client.table('user_roles').select('role').eq('user_id', user_id).execute()
            is_admin = False
            if admin_result.data and len(admin_result.data) > 0:
                role = admin_result.data[0].get('role')
                if role in ('admin', 'super_admin'):
                    is_admin = True
                    logger.debug(f"Admin access granted for project {project_id}", user_role=role)
            
            if not is_admin:
                # Verify account membership for private projects
                account_id = project.get('account_id')
                if not account_id:
                    logger.error(f"Project {project_id} has no associated account")
                    raise HTTPException(status_code=500, detail="Project has no associated account")
                
                account_user_result = await client.schema('basejump').from_('account_user').select('account_role').eq('user_id', user_id).eq('account_id', account_id).execute()
                if not (account_user_result.data and len(account_user_result.data) > 0):
                    logger.error(f"User {user_id} not authorized to access project {project_id}")
                    raise HTTPException(status_code=403, detail="Not authorized to access this project")
        
        # Map project data for frontend
        # Get sandbox info from resource if it exists
        sandbox_info = {}
        sandbox_resource_id = project.get('sandbox_resource_id')
        if sandbox_resource_id:
            from core.resources import ResourceService
            resource_service = ResourceService(client)
            resource = await resource_service.get_resource_by_id(sandbox_resource_id)
            if resource:
                sandbox_info = {
                    'id': resource.get('external_id'),
                    **resource.get('config', {})
                }
        
        project_data = {
            "project_id": project['project_id'],
            "name": project.get('name', ''),
            "description": project.get('description', ''),
            "sandbox": sandbox_info,
            "is_public": project.get('is_public', False),
            "icon_name": project.get('icon_name'),
            "created_at": project['created_at'],
            "updated_at": project.get('updated_at')
        }
        
        logger.debug(f"Successfully fetched project {project_id}")
        return project_data
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching project {project_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to fetch project: {str(e)}")

@router.get("/projects/{project_id}/threads", summary="List Project Threads", operation_id="list_project_threads")
async def get_project_threads(
    project_id: str,
    request: Request,
    user_id: Optional[str] = Depends(verify_and_get_user_id_from_jwt),
    page: Optional[int] = Query(1, ge=1, description="Page number (1-based)"),
    limit: Optional[int] = Query(100, ge=1, le=1000, description="Number of items per page (max 1000)")
):
    """List all threads for a specific project."""
    logger.debug(f"Fetching threads for project: {project_id} (page={page}, limit={limit})")
    client = await db.client
    
    try:
        # Verify project access
        project_result = await client.table('projects').select('account_id, is_public').eq('project_id', project_id).execute()
        if not project_result.data or len(project_result.data) == 0:
            raise HTTPException(status_code=404, detail="Project not found")
        
        project = project_result.data[0]
        is_public = project.get('is_public', False)
        
        if not is_public:
            if not user_id:
                raise HTTPException(status_code=401, detail="Authentication required for private projects")
            
            account_id = project.get('account_id')
            if account_id:
                account_user_result = await client.schema('basejump').from_('account_user').select('account_role').eq('user_id', user_id).eq('account_id', account_id).execute()
                if not (account_user_result.data and len(account_user_result.data) > 0):
                    raise HTTPException(status_code=403, detail="Not authorized to access this project")
        
        offset = (page - 1) * limit
        
        # Count threads for this project
        count_result = await client.table('threads').select('thread_id', count='exact').eq('project_id', project_id).execute()
        total_count = count_result.count or 0
        
        if total_count == 0:
            return {
                "threads": [],
                "pagination": {
                    "page": page,
                    "limit": limit,
                    "total": 0,
                    "pages": 0
                }
            }
        
        # Get threads for this project
        threads_result = await client.table('threads')\
            .select('thread_id,project_id,name,metadata,is_public,created_at,updated_at')\
            .eq('project_id', project_id)\
            .order('created_at', desc=True)\
            .range(offset, offset + limit - 1)\
            .execute()
        
        threads = threads_result.data or []
        
        # Get message counts for each thread
        thread_ids = [t['thread_id'] for t in threads]
        mapped_threads = []
        
        for thread in threads:
            message_count_result = await client.table('messages').select('message_id', count='exact').eq('thread_id', thread['thread_id']).execute()
            message_count = message_count_result.count if message_count_result.count is not None else 0
            
            mapped_thread = {
                "thread_id": thread['thread_id'],
                "project_id": thread.get('project_id'),
                "name": thread.get('name', 'New Chat'),
                "metadata": thread.get('metadata', {}),
                "is_public": thread.get('is_public', False),
                "created_at": thread['created_at'],
                "updated_at": thread['updated_at'],
                "message_count": message_count
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
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching threads for project {project_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to fetch project threads: {str(e)}")

@router.post("/projects/{project_id}/threads", response_model=CreateThreadResponse, summary="Create Thread in Project", operation_id="create_thread_in_project")
async def create_thread_in_project(
    project_id: str,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """Create a new thread within an existing project. Shares the project's sandbox resource."""
    from core.threads.repo import get_project_access, create_thread as repo_create_thread
    
    logger.debug(f"Creating new thread in project: {project_id}")
    client = await db.client
    account_id = user_id
    
    try:
        # Verify project exists and user has access (single query with JOIN)
        project = await get_project_access(project_id, account_id)
        if not project:
            raise HTTPException(status_code=404, detail="Project not found or access denied")
        
        # Check thread limit
        if config.ENV_MODE != EnvMode.LOCAL:
            from core.utils.limits_checker import check_thread_limit
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
        
        # Create thread linked to existing project
        thread_id = str(uuid.uuid4())
        
        from core.utils.logger import structlog
        structlog.contextvars.bind_contextvars(
            thread_id=thread_id,
            project_id=project_id,
            account_id=account_id,
        )
        
        thread_result = await repo_create_thread(
            thread_id=thread_id,
            project_id=project_id,
            account_id=account_id,
            name="New Chat"
        )
        
        if not thread_result:
            raise HTTPException(status_code=500, detail="Failed to create thread")
        
        logger.debug(f"Created new thread: {thread_id} in project: {project_id}")
        
        # Increment thread count cache (fire-and-forget)
        try:
            from core.cache.runtime_cache import increment_thread_count_cache
            asyncio.create_task(increment_thread_count_cache(account_id))
        except Exception:
            pass
        
        logger.debug(f"Successfully created thread {thread_id} in project {project_id}")
        return {"thread_id": thread_id, "project_id": project_id}
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error creating thread in project {project_id}: {str(e)}\n{traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=f"Failed to create thread: {str(e)}")

@router.delete("/projects/{project_id}", summary="Delete Project", operation_id="delete_project")
async def delete_project(
    project_id: str,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """Delete a project and all its threads, messages, agent runs, and associated resources."""
    logger.debug(f"Deleting project: {project_id}")
    client = await db.client
    
    try:
        # Verify project exists and user has access
        project_result = await client.table('projects').select('account_id').eq('project_id', project_id).execute()
        if not project_result.data or len(project_result.data) == 0:
            raise HTTPException(status_code=404, detail="Project not found")
        
        project = project_result.data[0]
        project_account_id = project.get('account_id')
        
        # Verify user has access to this project
        if project_account_id != user_id:
            account_user_result = await client.schema('basejump').from_('account_user').select('account_role').eq('user_id', user_id).eq('account_id', project_account_id).execute()
            if not (account_user_result.data and len(account_user_result.data) > 0):
                raise HTTPException(status_code=403, detail="Not authorized to delete this project")
        
        # Get all threads for this project
        threads_result = await client.table('threads').select('thread_id').eq('project_id', project_id).execute()
        thread_ids = [t['thread_id'] for t in (threads_result.data or [])]
        
        # Delete sandbox resource if it exists
        from core.resources import ResourceService
        resource_service = ResourceService(client)
        sandbox_resource = await resource_service.get_project_sandbox_resource(project_id)
        if sandbox_resource:
            sandbox_id = sandbox_resource.get('external_id')
            if sandbox_id:
                try:
                    logger.debug(f"Deleting sandbox {sandbox_id} for project {project_id}")
                    await delete_sandbox(sandbox_id)
                    logger.debug(f"Successfully deleted sandbox {sandbox_id}")
                except Exception as e:
                    logger.error(f"Error deleting sandbox {sandbox_id}: {str(e)}")
        
        # Delete all agent runs for all threads
        if thread_ids:
            logger.debug(f"Deleting agent runs for {len(thread_ids)} threads")
            for thread_id in thread_ids:
                await client.table('agent_runs').delete().eq('thread_id', thread_id).execute()
        
        # Delete all messages for all threads
        if thread_ids:
            logger.debug(f"Deleting messages for {len(thread_ids)} threads")
            for thread_id in thread_ids:
                await client.table('messages').delete().eq('thread_id', thread_id).execute()
        
        # Delete all threads
        if thread_ids:
            logger.debug(f"Deleting {len(thread_ids)} threads")
            await client.table('threads').delete().eq('project_id', project_id).execute()
        
        # Delete the project
        logger.debug(f"Deleting project {project_id}")
        project_delete_result = await client.table('projects').delete().eq('project_id', project_id).execute()
        
        if not project_delete_result.data:
            raise HTTPException(status_code=500, detail="Failed to delete project")
        
        # Invalidate caches
        try:
            from core.cache.runtime_cache import invalidate_thread_count_cache, invalidate_project_cache
            await invalidate_thread_count_cache(user_id)
            await invalidate_project_cache(project_id)
        except Exception:
            pass
        
        logger.debug(f"Successfully deleted project {project_id} and all associated data")
        return {"message": "Project deleted successfully", "project_id": project_id, "threads_deleted": len(thread_ids)}
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting project {project_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to delete project: {str(e)}")

@router.get("/threads/{thread_id}", summary="Get Thread", operation_id="get_thread")
async def get_thread(
    thread_id: str,
    request: Request
):
    logger.debug(f"Fetching thread: {thread_id}")
    client = await db.client
    
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
                
                # Get sandbox info from resource if it exists
                sandbox_info = {}
                sandbox_resource_id = project.get('sandbox_resource_id')
                if sandbox_resource_id:
                    from core.resources import ResourceService
                    resource_service = ResourceService(client)
                    resource = await resource_service.get_resource_by_id(sandbox_resource_id)
                    if resource:
                        sandbox_info = {
                            'id': resource.get('external_id'),
                            **resource.get('config', {})
                        }
                
                project_data = {
                    "project_id": project['project_id'],
                    "name": project.get('name', ''),
                    "description": project.get('description', ''),
                    "sandbox": sandbox_info,
                    "is_public": project.get('is_public', False),
                    "icon_name": project.get('icon_name'),
                    "created_at": project['created_at'],
                    "updated_at": project['updated_at']
                }
                
                # If thread has an existing sandbox, start it proactively in background
                if sandbox_info and sandbox_info.get('id'):
                    sandbox_id = sandbox_info.get('id')
                    logger.info(f"Thread {thread_id} has existing sandbox {sandbox_id}, starting it in background...")
                    
                    async def start_sandbox_background():
                        try:
                            from core.sandbox.sandbox import get_or_start_sandbox
                            await get_or_start_sandbox(sandbox_id)
                            logger.info(f"Successfully started sandbox {sandbox_id} for thread {thread_id}")
                        except Exception as e:
                            # Don't fail thread loading if sandbox start fails, just log it
                            logger.warning(f"Failed to start sandbox {sandbox_id} for thread {thread_id}: {str(e)}")
                    
                    asyncio.create_task(start_sandbox_background())
        
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
            "name": thread.get('name', 'New Chat'),
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
    client = await db.client
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

        # Create resource record and link to project using ResourceService
        try:
            from core.resources import ResourceService, ResourceType, ResourceStatus
            resource_service = ResourceService(client)
            
            sandbox_config = {
                'pass': sandbox_pass,
                'vnc_preview': vnc_url,
                'sandbox_url': website_url,
                'token': token
            }
            
            resource = await resource_service.create_resource(
                account_id=account_id,
                resource_type=ResourceType.SANDBOX,
                external_id=sandbox_id,
                config=sandbox_config,
                status=ResourceStatus.ACTIVE
            )
            resource_id = resource['id']
            
            # Link resource to project
            if not await resource_service.link_resource_to_project(project_id, resource_id):
                logger.error(f"Failed to link resource {resource_id} to project {project_id}")
                if sandbox_id:
                    try: 
                        await delete_sandbox(sandbox_id)
                        await resource_service.delete_resource(resource_id)
                    except Exception as e: 
                        logger.error(f"Error deleting sandbox: {str(e)}")
                raise Exception("Database update failed")
        except Exception as e:
            logger.error(f"Failed to create resource for sandbox {sandbox_id}: {str(e)}")
            if sandbox_id:
                try: 
                    await delete_sandbox(sandbox_id)
                except Exception as e: 
                    logger.error(f"Error deleting sandbox: {str(e)}")
            raise Exception(f"Failed to create sandbox resource: {str(e)}")

        # Update project metadata cache with sandbox data (instead of invalidate)
        try:
            from core.cache.runtime_cache import set_cached_project_metadata
            sandbox_cache_data = {
                'id': sandbox_id,
                'pass': sandbox_pass,
                'vnc_preview': vnc_url,
                'sandbox_url': website_url,
                'token': token
            }
            await set_cached_project_metadata(project_id, sandbox_cache_data)
            logger.debug(f"✅ Updated project cache with sandbox data: {project_id}")
        except Exception as cache_error:
            logger.warning(f"Failed to update project cache: {cache_error}")

        thread_data = {
            "thread_id": str(uuid.uuid4()), 
            "project_id": project_id, 
            "account_id": account_id,
            "name": "New Chat",  # Default name for empty threads
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

        # Increment thread count cache (fire-and-forget)
        try:
            from core.cache.runtime_cache import increment_thread_count_cache
            asyncio.create_task(increment_thread_count_cache(account_id))
        except Exception:
            pass

        logger.debug(f"Successfully created thread {thread_id} with project {project_id}")
        return {"thread_id": thread_id, "project_id": project_id}

    except Exception as e:
        logger.error(f"Error creating thread: {str(e)}\n{traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=f"Failed to create thread: {str(e)}")

@router.get("/threads/{thread_id}/messages", summary="Get Thread Messages", operation_id="get_thread_messages")
async def get_thread_messages(
    thread_id: str,
    request: Request,
    order: str = Query("desc", description="Order by created_at: 'asc' or 'desc'"),
    optimized: bool = Query(True, description="Return optimized messages (filtered types, minimal fields) or full messages (all types, all fields)"),
):
    from core.threads import repo as threads_repo
    
    logger.debug(f"Fetching all messages for thread: {thread_id}, order={order}")
    client = await db.client
    
    from core.utils.auth_utils import get_optional_user_id
    user_id = await get_optional_user_id(request)
    
    await verify_and_authorize_thread_access(client, thread_id, user_id)
    try:
        from core.utils.message_migration import migrate_thread_messages, needs_migration

        raw_messages = await threads_repo.get_thread_messages(
            thread_id=thread_id,
            order=order,
            optimized=optimized
        )
        def optimize_messages(raw_messages):
            if not optimized:
                return raw_messages
            optimized_list = []
            for msg in raw_messages:
                msg_type = msg.get('type')
                optimized_msg = {
                    'message_id': msg.get('message_id'),
                    'thread_id': msg.get('thread_id'),
                    'type': msg_type,
                    'is_llm_message': msg.get('is_llm_message'),
                    'metadata': msg.get('metadata', {}),
                    'created_at': msg.get('created_at'),
                    'updated_at': msg.get('updated_at'),
                    'agent_id': msg.get('agent_id'),
                }
                if msg_type == 'user':
                    optimized_msg['content'] = msg.get('content')
                optimized_list.append(optimized_msg)
            return optimized_list
        
        migration_needed = any(
            needs_migration(msg) 
            for msg in raw_messages 
            if msg.get('type') in ['assistant', 'tool']
        )
        
        if migration_needed:
            stats = await migrate_thread_messages(client, thread_id, save=True)
            if stats['migrated'] > 0:
                logger.info(f"Migrated {stats['migrated']} messages for thread {thread_id}")
                raw_messages = await threads_repo.get_thread_messages(
                    thread_id=thread_id,
                    order=order,
                    optimized=optimized
                )
        
        all_messages = optimize_messages(raw_messages)
        
        return {"messages": all_messages}
    except Exception as e:
        logger.error(f"Error fetching messages for thread {thread_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to fetch messages: {str(e)}")

@router.post("/threads/{thread_id}/messages/add", summary="Add Message to Thread", operation_id="add_message_to_thread")
async def add_message_to_thread(
    thread_id: str,
    request: Request,
    message: str = Body(..., embed=True),
    user_id: str = Depends(verify_and_get_user_id_from_jwt),
):
    from core.threads import repo as threads_repo
    
    logger.debug(f"Adding message to thread: {thread_id}")
    
    if not message or not message.strip():
        raise HTTPException(status_code=400, detail="Message content cannot be empty")
    
    thread_account_id = await threads_repo.get_thread_account_id(thread_id)
    if not thread_account_id:
        raise HTTPException(status_code=404, detail="Thread not found")
    
    if thread_account_id != user_id:
        client = await db.client
        from core.utils.auth_utils import verify_and_authorize_thread_access
        await verify_and_authorize_thread_access(client, thread_id, user_id)
    
    try:
        thread_name = await threads_repo.get_thread_name(thread_id)
        if thread_name in ('New Chat', None):
            from core.utils.thread_name_generator import generate_and_update_thread_name
            asyncio.create_task(generate_and_update_thread_name(thread_id=thread_id, prompt=message))
        
        new_message = await threads_repo.create_message(
            thread_id=thread_id,
            message_type='user',
            content={"role": "user", "content": message},
            is_llm_message=True
        )
        
        return new_message
    except Exception as e:
        logger.error(f"Error adding message to thread {thread_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to add message: {str(e)}")

@router.post("/threads/{thread_id}/messages", summary="Create Thread Message", operation_id="create_thread_message")
async def create_message_endpoint(
    thread_id: str,
    message_data: MessageCreateRequest,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    from core.threads import repo as threads_repo
    
    logger.debug(f"Creating message in thread: {thread_id}")
    
    if message_data.type == "user" and (not message_data.content or not message_data.content.strip()):
        raise HTTPException(status_code=400, detail="Message content cannot be empty")
    
    client = await db.client
    
    try:
        await verify_and_authorize_thread_access(client, thread_id, user_id)
        
        message_payload = {
            "role": "user" if message_data.type == "user" else "assistant",
            "content": message_data.content
        }
        
        new_message = await threads_repo.create_message(
            thread_id=thread_id,
            message_type=message_data.type,
            content=message_payload,
            is_llm_message=message_data.is_llm_message
        )
        
        if not new_message:
            raise HTTPException(status_code=500, detail="Failed to create message")
        
        logger.debug(f"Created message: {new_message['message_id']}")
        return new_message
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error creating message in thread {thread_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to create message: {str(e)}")

@router.delete("/threads/{thread_id}/messages/{message_id}", summary="Delete Thread Message", operation_id="delete_thread_message")
async def delete_message_endpoint(
    thread_id: str,
    message_id: str,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    from core.threads import repo as threads_repo
    
    logger.debug(f"Deleting message from thread: {thread_id}")
    client = await db.client
    await verify_and_authorize_thread_access(client, thread_id, user_id)
    try:
        await threads_repo.delete_message(thread_id, message_id, is_llm_message=True)
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
    from core.threads import repo as threads_repo
    
    logger.debug(f"Updating thread: {thread_id}")
    client = await db.client
    
    try:
        if title is None and is_public is None:
            raise HTTPException(status_code=400, detail="No update data provided")
        
        thread = await threads_repo.get_thread_with_project(thread_id)
        if not thread:
            raise HTTPException(status_code=404, detail="Thread not found")
        
        project_id = thread.get('project_id')
        
        # Update project name if title provided
        if title is not None and project_id:
            logger.debug(f"Updating project {project_id} name to: {title}")
            await threads_repo.update_project_name(project_id, title)
        
        # Build thread update
        thread_metadata = None
        if title is not None:
            current_metadata = thread.get('metadata', {}) or {}
            current_metadata['title'] = title
            thread_metadata = current_metadata
        
        # Update project visibility if is_public provided
        if is_public is not None and project_id:
            logger.debug(f"Updating project {project_id} is_public to: {is_public}")
            await threads_repo.update_project_visibility(project_id, is_public)
        
        # Update thread
        updated_thread = await threads_repo.update_thread(
            thread_id=thread_id,
            metadata=thread_metadata,
            is_public=is_public
        )
        
        if not updated_thread:
            raise HTTPException(status_code=500, detail="Failed to update thread")
        
        logger.debug(f"Successfully updated thread: {thread_id}")

        project_data = None
        if project_id:
            project = await threads_repo.get_project_by_id(project_id)
            if project:
                sandbox_info = {}
                sandbox_resource_id = project.get('sandbox_resource_id')
                if sandbox_resource_id:
                    from core.resources import ResourceService
                    resource_service = ResourceService(client)
                    resource = await resource_service.get_resource_by_id(sandbox_resource_id)
                    if resource:
                        sandbox_info = {
                            'id': resource.get('external_id'),
                            **resource.get('config', {})
                        }
                
                project_data = {
                    "project_id": project['project_id'],
                    "name": project.get('name', ''),
                    "description": project.get('description', ''),
                    "sandbox": sandbox_info,
                    "is_public": project.get('is_public', False),
                    "icon_name": project.get('icon_name'),
                    "created_at": project.get('created_at'),
                    "updated_at": project.get('updated_at')
                }
        
        return {
            "thread_id": updated_thread['thread_id'],
            "project_id": updated_thread.get('project_id'),
            "metadata": updated_thread.get('metadata', {}),
            "is_public": updated_thread.get('is_public', False),
            "created_at": updated_thread.get('created_at'),
            "updated_at": updated_thread.get('updated_at'),
            "project": project_data,
            "message_count": 0,
            "recent_agent_runs": []
        }
        
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
    """Delete a thread. Only deletes the project if this is the last thread in the project."""
    from core.threads.repo import (
        get_thread_project_id,
        delete_thread_data,
        count_project_threads,
        delete_project as repo_delete_project
    )
    
    logger.debug(f"Deleting thread: {thread_id}")
    client = await db.client
    
    try:
        # Get project_id before deleting
        project_id = await get_thread_project_id(thread_id)
        if project_id is None:
            raise HTTPException(status_code=404, detail="Thread not found")
        
        # Delete thread and related data (agent_runs, messages)
        logger.debug(f"Deleting thread data for {thread_id}")
        deleted = await delete_thread_data(thread_id)
        
        if not deleted:
            raise HTTPException(status_code=500, detail="Failed to delete thread")
        
        # Invalidate thread count cache for this user
        try:
            from core.cache.runtime_cache import invalidate_thread_count_cache
            await invalidate_thread_count_cache(auth.user_id)
        except Exception:
            pass
        
        # Check if this was the last thread in the project
        if project_id:
            remaining_thread_count = await count_project_threads(project_id)
            
            # Only delete project and sandbox if this was the last thread
            if remaining_thread_count == 0:
                logger.debug(f"Last thread deleted, cleaning up project {project_id}")
                
                # Delete sandbox resource if it exists
                from core.resources import ResourceService
                resource_service = ResourceService(client)
                sandbox_resource = await resource_service.get_project_sandbox_resource(project_id)
                if sandbox_resource:
                    sandbox_id = sandbox_resource.get('external_id')
                    if sandbox_id:
                        try:
                            logger.debug(f"Deleting sandbox {sandbox_id} for project {project_id}")
                            await delete_sandbox(sandbox_id)
                            logger.debug(f"Successfully deleted sandbox {sandbox_id}")
                        except Exception as e:
                            logger.error(f"Error deleting sandbox {sandbox_id}: {str(e)}")
                
                # Delete the project
                logger.debug(f"Deleting project {project_id}")
                await repo_delete_project(project_id)
                
                # Invalidate project cache
                try:
                    from core.cache.runtime_cache import invalidate_project_cache
                    await invalidate_project_cache(project_id)
                except Exception:
                    pass
            else:
                logger.debug(f"Project {project_id} has {remaining_thread_count} remaining threads, keeping project")
        
        logger.debug(f"Successfully deleted thread {thread_id}")
        return {"message": "Thread deleted successfully", "thread_id": thread_id}
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting thread {thread_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to delete thread: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to delete thread: {str(e)}")