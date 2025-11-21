import asyncio
import json
import traceback
import uuid
import os
from datetime import datetime, timezone
from typing import Optional, List, Tuple, Dict
from fastapi import APIRouter, HTTPException, Depends, Request, Body, File, UploadFile, Form
from fastapi.responses import StreamingResponse
from core.utils.auth_utils import verify_and_get_user_id_from_jwt, get_user_id_from_stream_auth, verify_and_authorize_thread_access, get_optional_user_id_from_jwt
from core.utils.logger import logger, structlog
from core.billing.billing_integration import billing_integration
from core.utils.config import config, EnvMode
from core.services import redis
from core.sandbox.sandbox import create_sandbox, delete_sandbox, get_or_start_sandbox
from core.utils.sandbox_utils import generate_unique_filename, get_uploads_directory
from run_agent_background import run_agent_background

from core.ai_models import model_manager

from .api_models import AgentVersionResponse, AgentResponse, ThreadAgentResponse, UnifiedAgentStartResponse
from . import core_utils as utils

from .core_utils import (
    stop_agent_run_with_helpers as stop_agent_run,
    _get_version_service, generate_and_update_project_name,
    check_agent_run_limit, check_project_count_limit
)

router = APIRouter(tags=["agent-runs"])

async def _get_agent_run_with_access_check(client, agent_run_id: str, user_id: str):
    """
    Get an agent run and verify the user has access to it.
    
    Internal helper for this module only.
    """
    from core.utils.auth_utils import verify_and_authorize_thread_access
    
    agent_run = await client.table('agent_runs').select('*, threads(account_id)').eq('id', agent_run_id).execute()
    if not agent_run.data:
        raise HTTPException(status_code=404, detail="Agent run not found")

    agent_run_data = agent_run.data[0]
    thread_id = agent_run_data['thread_id']
    account_id = agent_run_data['threads']['account_id']
    
    # Check metadata for actual_user_id (used for guests who share admin's account_id)
    metadata = agent_run_data.get('metadata', {})
    actual_user_id = metadata.get('actual_user_id')
    
    # If metadata has actual_user_id, use that for access check (handles guests)
    if actual_user_id and actual_user_id == user_id:
        return agent_run_data
    
    # Otherwise, use traditional account_id check
    if account_id == user_id:
        return agent_run_data
        
    await verify_and_authorize_thread_access(client, thread_id, user_id)
    return agent_run_data


# ============================================================================
# Helper Functions for Unified Agent Start
# ============================================================================

async def _find_shared_suna_agent(client):
    from .agent_loader import get_agent_loader
    from core.utils.config import config
    
    admin_user_id = config.GUEST_MODE_ADMIN_USER_ID
    
    if admin_user_id:
        admin_suna = await client.table('agents').select('agent_id').eq('account_id', admin_user_id).eq('metadata->>is_suna_default', 'true').maybe_single().execute()
        
        if admin_suna and admin_suna.data:
            loader = await get_agent_loader()
            agent_data = await loader.load_agent(admin_suna.data['agent_id'], admin_user_id, load_config=True)
            logger.info(f"✅ Using system Suna agent from admin user: {agent_data.name} ({agent_data.agent_id})")
            return agent_data
        else:
            logger.warning(f"⚠️ GUEST_MODE_ADMIN_USER_ID configured but no Suna agent found for user {admin_user_id}")
    
    # Fallback: search for any Suna agent
    any_suna = await client.table('agents').select('agent_id, account_id').eq('metadata->>is_suna_default', 'true').limit(1).maybe_single().execute()
    
    if any_suna and any_suna.data:
        loader = await get_agent_loader()
        agent_data = await loader.load_agent(any_suna.data['agent_id'], any_suna.data['account_id'], load_config=True)
        logger.info(f"Using shared Suna agent: {agent_data.name} ({agent_data.agent_id})")
        return agent_data
    
    logger.error("❌ No Suna agent found! Set GUEST_MODE_ADMIN_USER_ID in .env")
    return None


async def _load_agent_config(client, agent_id: Optional[str], account_id: str, user_id: str, is_new_thread: bool = False):
    from .agent_loader import get_agent_loader
    loader = await get_agent_loader()
    
    agent_data = None
    
    logger.debug(f"[AGENT LOAD] Loading agent: {agent_id or 'default'}")

    if agent_id:
        agent_data = await loader.load_agent(agent_id, user_id, load_config=True)
        logger.debug(f"Using agent {agent_data.name} ({agent_id}) version {agent_data.version_name}")
    else:
        logger.debug(f"[AGENT LOAD] Loading default agent")
        
        from core.guest_session import guest_session_service
        is_guest = await guest_session_service.is_guest_session(account_id)
        
        if is_new_thread and not is_guest:
            from core.utils.ensure_suna import ensure_suna_installed
            await ensure_suna_installed(account_id)
        
        default_agent = await client.table('agents').select('agent_id').eq('account_id', account_id).eq('metadata->>is_suna_default', 'true').maybe_single().execute()
        
        if default_agent and default_agent.data:
            agent_data = await loader.load_agent(default_agent.data['agent_id'], user_id, load_config=True)
            logger.debug(f"Using default agent: {agent_data.name} ({agent_data.agent_id}) version {agent_data.version_name}")
        else:
            logger.warning(f"[AGENT LOAD] No default agent found for account {account_id}, searching for shared Suna")
            agent_data = await _find_shared_suna_agent(client)
            
            if not agent_data:
                any_agent = await client.table('agents').select('agent_id').eq('account_id', account_id).limit(1).maybe_single().execute()
                
                if any_agent and any_agent.data:
                    agent_data = await loader.load_agent(any_agent.data['agent_id'], user_id, load_config=True)
                    logger.info(f"[AGENT LOAD] Using fallback agent: {agent_data.name} ({agent_data.agent_id})")
                else:
                    logger.error(f"[AGENT LOAD] No agents found for account {account_id}")
                    raise HTTPException(status_code=404, detail="No agents available. Please create an agent first.")
    
    agent_config = agent_data.to_dict() if agent_data else None
    
    if agent_config:
        logger.debug(f"Using agent {agent_config['agent_id']} for this agent run")
    
    return agent_config


async def _check_billing_and_limits(client, account_id: str, model_name: Optional[str], check_project_limit: bool = False):
    """
    Check billing, model access, and rate limits.
    
    Args:
        client: Database client
        account_id: Account ID to check
        model_name: Model name to check access for
        check_project_limit: Whether to check project count limit (for new threads)
    
    Raises:
        HTTPException: If billing/limits checks fail
    """
    # Skip billing checks for guest users (they have message limits instead)
    from core.guest_session import guest_session_service
    if await guest_session_service.is_guest_session(account_id):
        logger.info(f"✅ Guest user - skipping billing checks, using free tier models")
        return  # Guest users bypass billing checks
    
    # Unified billing and model access check
    can_proceed, error_message, context = await billing_integration.check_model_and_billing_access(
        account_id, model_name, client
    )
    
    if not can_proceed:
        if context.get("error_type") == "model_access_denied":
            raise HTTPException(status_code=402, detail={
                "message": error_message, 
                "tier_name": context.get("tier_name"),
                "error_code": "MODEL_ACCESS_DENIED"
            })
        elif context.get("error_type") == "insufficient_credits":
            raise HTTPException(status_code=402, detail={"message": error_message})
        else:
            raise HTTPException(status_code=500, detail={"message": error_message})
    
    # Check limits (only if not in local mode)
    if config.ENV_MODE != EnvMode.LOCAL:
        # Always check agent run limit
        limit_check = await check_agent_run_limit(client, account_id)
        if not limit_check['can_start']:
            error_detail = {
                "message": f"Maximum of {limit_check['limit']} concurrent agent runs allowed. You currently have {limit_check['running_count']} running.",
                "running_thread_ids": limit_check['running_thread_ids'],
                "running_count": limit_check['running_count'],
                "limit": limit_check['limit'],
                "error_code": "AGENT_RUN_LIMIT_EXCEEDED"
            }
            logger.warning(f"Agent run limit exceeded for account {account_id}: {limit_check['running_count']}/{limit_check['limit']} running agents")
            raise HTTPException(status_code=402, detail=error_detail)

        # Check project limit if creating new thread
        if check_project_limit:
            project_limit_check = await check_project_count_limit(client, account_id)
            if not project_limit_check['can_create']:
                error_detail = {
                    "message": f"Maximum of {project_limit_check['limit']} projects allowed for your current plan. You have {project_limit_check['current_count']} projects.",
                    "current_count": project_limit_check['current_count'],
                    "limit": project_limit_check['limit'],
                    "tier_name": project_limit_check['tier_name'],
                    "error_code": "PROJECT_LIMIT_EXCEEDED"
                }
                logger.warning(f"Project limit exceeded for account {account_id}: {project_limit_check['current_count']}/{project_limit_check['limit']} projects")
                raise HTTPException(status_code=402, detail=error_detail)


async def _get_effective_model(model_name: Optional[str], agent_config: Optional[dict], client, account_id: str) -> str:
    """
    Get the effective model to use, considering user input, agent config, and defaults.
    
    Args:
        model_name: Model name from request (may be None)
        agent_config: Agent configuration dict
        client: Database client
        account_id: Account ID for tier-based defaults
    
    Returns:
        Effective model name to use
    """
    if model_name:
        logger.debug(f"Using user-selected model: {model_name}")
        return model_name
    elif agent_config and agent_config.get('model'):
        effective_model = agent_config['model']
        logger.debug(f"No model specified by user, using agent's configured model: {effective_model}")
        return effective_model
    else:
        # No model from user or agent, use default for user's tier
        effective_model = await model_manager.get_default_model_for_user(client, account_id)
        logger.debug(f"Using default model for user: {effective_model}")
        return effective_model


async def _create_agent_run_record(client, thread_id: str, agent_config: Optional[dict], effective_model: str, actual_user_id: str) -> str:
    """
    Create an agent run record in the database.
    
    Args:
        client: Database client
        thread_id: Thread ID to associate with
        agent_config: Agent configuration dict
        effective_model: Model name to use
        actual_user_id: The actual user or guest session ID (not project_owner_id)
    
    Returns:
        agent_run_id: The created agent run ID
    """
    agent_run = await client.table('agent_runs').insert({
        "thread_id": thread_id,
        "status": "running",
        "started_at": datetime.now(timezone.utc).isoformat(),
        "agent_id": agent_config.get('agent_id') if agent_config else None,
        "agent_version_id": agent_config.get('current_version_id') if agent_config else None,
        "metadata": {
            "model_name": effective_model,
            "actual_user_id": actual_user_id
        }
    }).execute()

    agent_run_id = agent_run.data[0]['id']
    structlog.contextvars.bind_contextvars(agent_run_id=agent_run_id)
    logger.debug(f"Created new agent run: {agent_run_id}")

    # Register run in Redis
    instance_key = f"active_run:{utils.instance_id}:{agent_run_id}"
    try:
        await redis.set(instance_key, "running", ex=redis.REDIS_KEY_TTL)
    except Exception as e:
        logger.warning(f"Failed to register agent run in Redis ({instance_key}): {str(e)}")

    return agent_run_id


async def _trigger_agent_background(agent_run_id: str, thread_id: str, project_id: str, effective_model: str, agent_config: Optional[dict]):
    """
    Trigger the background agent execution.
    
    Args:
        agent_run_id: Agent run ID
        thread_id: Thread ID
        project_id: Project ID
        effective_model: Model name to use
        agent_config: Agent configuration dict
    """
    request_id = structlog.contextvars.get_contextvars().get('request_id')

    run_agent_background.send(
        agent_run_id=agent_run_id,
        thread_id=thread_id,
        instance_id=utils.instance_id,
        project_id=project_id,
        model_name=effective_model,
        agent_config=agent_config,
        request_id=request_id,
    )


async def _handle_file_uploads(files: List[UploadFile], sandbox, project_id: str, prompt: str = "") -> str:
    """
    Handle file uploads to sandbox and return message content with file references.
    
    Args:
        files: List of uploaded files
        sandbox: Sandbox object to upload files to
        project_id: Project ID for logging
        prompt: Optional prompt text to prepend to file references
    
    Returns:
        Message content with file references
    """
    message_content = prompt
    
    if not files:
        return message_content
    
    successful_uploads = []
    failed_uploads = []
    uploads_dir = get_uploads_directory()
    
    for file in files:
        if file.filename:
            try:
                safe_filename = file.filename.replace('/', '_').replace('\\', '_')
                
                # Generate unique filename to avoid conflicts
                unique_filename = await generate_unique_filename(sandbox, uploads_dir, safe_filename)
                target_path = f"{uploads_dir}/{unique_filename}"
                
                logger.debug(f"Attempting to upload {safe_filename} to {target_path} in sandbox {sandbox.id}")
                content = await file.read()
                upload_successful = False
                try:
                    if hasattr(sandbox, 'fs') and hasattr(sandbox.fs, 'upload_file'):
                        await sandbox.fs.upload_file(content, target_path)
                        logger.debug(f"Called sandbox.fs.upload_file for {target_path}")
                        upload_successful = True
                    else:
                        raise NotImplementedError("Suitable upload method not found on sandbox object.")
                except Exception as upload_error:
                    logger.error(f"Error during sandbox upload call for {safe_filename}: {str(upload_error)}", exc_info=True)

                if upload_successful:
                    try:
                        await asyncio.sleep(0.2)
                        files_in_dir = await sandbox.fs.list_files(uploads_dir)
                        file_names_in_dir = [f.name for f in files_in_dir]
                        if unique_filename in file_names_in_dir:
                            successful_uploads.append(target_path)
                            logger.debug(f"Successfully uploaded and verified file {safe_filename} as {unique_filename} to sandbox path {target_path}")
                        else:
                            logger.error(f"Verification failed for {safe_filename}: File not found in {uploads_dir} after upload attempt.")
                            failed_uploads.append(safe_filename)
                    except Exception as verify_error:
                        logger.error(f"Error verifying file {safe_filename} after upload: {str(verify_error)}", exc_info=True)
                        failed_uploads.append(safe_filename)
                else:
                    failed_uploads.append(safe_filename)
            except Exception as file_error:
                logger.error(f"Error processing file {file.filename}: {str(file_error)}", exc_info=True)
                failed_uploads.append(file.filename)
            finally:
                await file.close()

    if successful_uploads:
        message_content += "\n\n" if message_content else ""
        for file_path in successful_uploads:
            message_content += f"[Uploaded File: {file_path}]\n"
    if failed_uploads:
        message_content += "\n\nThe following files failed to upload:\n"
        for failed_file in failed_uploads:
            message_content += f"- {failed_file}\n"
    
    return message_content


async def _ensure_sandbox_for_thread(client, project_id: str, files: List[UploadFile]):
    """
    Ensure sandbox exists for a project. Retrieves existing or creates new if files are provided.
    
    Args:
        client: Database client
        project_id: Project ID
        files: List of files (if any)
    
    Returns:
        Tuple of (sandbox, sandbox_id) or (None, None) if no sandbox needed
    """
    # First check if project already has a sandbox
    project_result = await client.table('projects').select('sandbox').eq('project_id', project_id).execute()
    
    if not project_result.data:
        logger.warning(f"Project {project_id} not found when checking for sandbox")
        return None, None
    
    existing_sandbox_data = project_result.data[0].get('sandbox')
    
    # If sandbox already exists, retrieve it
    if existing_sandbox_data and existing_sandbox_data.get('id'):
        sandbox_id = existing_sandbox_data.get('id')
        logger.debug(f"Project {project_id} already has sandbox {sandbox_id}, retrieving it...")
        
        try:
            # Retrieve the existing sandbox object so we can upload files to it
            sandbox = await get_or_start_sandbox(sandbox_id)
            logger.debug(f"Successfully retrieved existing sandbox {sandbox_id}")
            return sandbox, sandbox_id
        except Exception as e:
            logger.error(f"Error retrieving existing sandbox {sandbox_id}: {str(e)}")
            # If we can't retrieve the sandbox, we can't upload files
            raise HTTPException(status_code=500, detail=f"Failed to retrieve sandbox for file upload: {str(e)}")
    
    # Only create sandbox if files are provided
    if not files or len(files) == 0:
        logger.debug(f"No files to upload and no sandbox exists for project {project_id}")
        return None, None
    
    # Create new sandbox
    try:
        sandbox_pass = str(uuid.uuid4())
        sandbox = await create_sandbox(sandbox_pass, project_id)
        sandbox_id = sandbox.id
        logger.info(f"Created new sandbox {sandbox_id} for project {project_id}")

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
        
        return sandbox, sandbox_id
    except Exception as e:
        logger.error(f"Error creating sandbox: {str(e)}")
        raise Exception(f"Failed to create sandbox: {str(e)}")


# ============================================================================
# Unified Agent Start Endpoint
# ============================================================================

@router.post("/agent/start", response_model=UnifiedAgentStartResponse, summary="Start Agent (Unified)", operation_id="unified_agent_start")
async def unified_agent_start(
    request: Request,
    thread_id: Optional[str] = Form(None),
    prompt: Optional[str] = Form(None),
    model_name: Optional[str] = Form(None),
    agent_id: Optional[str] = Form(None),
    files: List[UploadFile] = File(default=[]),
    user_id: Optional[str] = Depends(get_optional_user_id_from_jwt)
):
    """
    Unified endpoint to start an agent run.
    
    - If thread_id is provided: Starts agent on existing thread (with optional prompt and files)
    - If thread_id is NOT provided: Creates new project/thread and starts agent
    
    Supports file uploads for both new and existing threads.
    Supports guest mode with limited message count.
    """
    from core.guest_session import guest_session_service
    
    guest_session = None
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
    
    if not utils.instance_id:
        raise HTTPException(status_code=500, detail="Agent API not initialized with instance ID")
    
    client = await utils.db.client
    account_id = user_id  # In Basejump, personal account_id is the same as user_id (or guest session_id)
    
    # Debug logging - log what we received
    logger.debug(f"Received agent start request: thread_id={thread_id!r}, prompt={prompt[:100] if prompt else None!r}, model_name={model_name!r}, agent_id={agent_id!r}, files_count={len(files)}")
    logger.debug(f"Parameter types: thread_id={type(thread_id)}, prompt={type(prompt)}, model_name={type(model_name)}, agent_id={type(agent_id)}")
    
    # Additional validation logging
    if not thread_id and (not prompt or (isinstance(prompt, str) and not prompt.strip())):
        error_msg = f"VALIDATION ERROR: New thread requires prompt. Received: prompt={prompt!r} (type={type(prompt)}), thread_id={thread_id!r}"
        logger.error(error_msg)
        raise HTTPException(status_code=400, detail="prompt is required when creating a new thread")
    
    # Resolve and validate model name
    if model_name is None:
        model_name = await model_manager.get_default_model_for_user(client, account_id)
        logger.debug(f"Using tier-based default model: {model_name}")
    else:
        model_name = model_manager.resolve_model_id(model_name)
        logger.debug(f"Resolved model name: {model_name}")
    
    try:
        if thread_id:
            logger.debug(f"Starting agent on existing thread: {thread_id}")
            structlog.contextvars.bind_contextvars(thread_id=thread_id)
            
            thread_result = await client.table('threads').select('project_id', 'account_id', 'metadata').eq('thread_id', thread_id).execute()
            
            if not thread_result.data:
                raise HTTPException(status_code=404, detail="Thread not found")
            
            thread_data = thread_result.data[0]
            project_id = thread_data.get('project_id')
            thread_account_id = thread_data.get('account_id')
            thread_metadata = thread_data.get('metadata', {})
            
            if thread_account_id != user_id:
                agent_runs_result = await client.table('agent_runs').select('metadata').eq('thread_id', thread_id).order('created_at', desc=True).limit(1).execute()
                if agent_runs_result.data:
                    metadata = agent_runs_result.data[0].get('metadata', {})
                    actual_user_id = metadata.get('actual_user_id')
                    if actual_user_id != user_id:
                        logger.error(f"User {user_id} unauthorized for thread {thread_id} (belongs to {actual_user_id})")
                        await verify_and_authorize_thread_access(client, thread_id, user_id)
                    else:
                        logger.debug(f"Guest {user_id} authorized for thread {thread_id} via actual_user_id")
                else:
                    logger.debug(f"No agent runs found, falling back to standard auth check")
                    await verify_and_authorize_thread_access(client, thread_id, user_id)
            
            structlog.contextvars.bind_contextvars(
                project_id=project_id,
                account_id=thread_account_id,
                thread_metadata=thread_metadata,
            )
            
            # Load agent configuration
            # For agent loading, use thread_account_id as the user_id (this is the actual owner of the agents)
            # Guest sessions use admin's agents, so we need to load with admin's permissions
            agent_config = await _load_agent_config(client, agent_id, thread_account_id, thread_account_id, is_new_thread=False)
            
            # Check billing and limits (skip for guest users)
            from core.guest_session import guest_session_service
            if not await guest_session_service.is_guest_session(thread_account_id):
                await _check_billing_and_limits(client, thread_account_id, model_name, check_project_limit=False)
            
            # Get effective model
            effective_model = await _get_effective_model(model_name, agent_config, client, thread_account_id)
            
            # Handle files if provided (for existing threads)
            if files and len(files) > 0:
                # Ensure sandbox exists or create one (will retrieve existing or create new)
                sandbox, sandbox_id = await _ensure_sandbox_for_thread(client, project_id, files)
                
                if sandbox:
                    # Upload files and create user message
                    message_content = await _handle_file_uploads(files, sandbox, project_id, prompt or "")
                    
                    # Create user message with files
                    message_id = str(uuid.uuid4())
                    message_payload = {"role": "user", "content": message_content}
                    await client.table('messages').insert({
                        "message_id": message_id,
                        "thread_id": thread_id,
                        "type": "user",
                        "is_llm_message": True,
                        "content": message_payload,
                        "created_at": datetime.now(timezone.utc).isoformat()
                    }).execute()
                    logger.debug(f"Created user message with files for thread {thread_id}")
                else:
                    logger.warning(f"No sandbox available for file upload")
            elif prompt:
                # No files, but prompt provided - create user message
                message_id = str(uuid.uuid4())
                message_payload = {"role": "user", "content": prompt}
                await client.table('messages').insert({
                    "message_id": message_id,
                    "thread_id": thread_id,
                    "type": "user",
                    "is_llm_message": True,
                    "content": message_payload,
                    "created_at": datetime.now(timezone.utc).isoformat()
                }).execute()
                logger.debug(f"Created user message for thread {thread_id}")
            
            # Create agent run (use actual account_id, not thread_account_id)
            agent_run_id = await _create_agent_run_record(client, thread_id, agent_config, effective_model, account_id)
            
            # Trigger background execution
            await _trigger_agent_background(agent_run_id, thread_id, project_id, effective_model, agent_config)
            
            # Increment guest message count if guest user
            response = {
                "thread_id": thread_id,
                "agent_run_id": agent_run_id,
                "status": "running"
            }
            
            if guest_session:
                from core.guest_session import guest_session_service
                updated_session = await guest_session_service.increment_message_count(guest_session['session_id'])
                await guest_session_service.add_thread_to_session(guest_session['session_id'], thread_id)
                response['guest_session'] = await guest_session_service.get_session_info(guest_session['session_id'])
            
            return response
        
        else:
            # ================================================================
            # NEW THREAD PATH
            # ================================================================
            
            # Validate that prompt is provided for new threads
            if not prompt or (isinstance(prompt, str) and not prompt.strip()):
                logger.error(f"Validation failed: prompt is required for new threads. Received prompt={prompt!r}, type={type(prompt)}")
                raise HTTPException(status_code=400, detail="prompt is required when creating a new thread")
            
            logger.debug(f"Creating new thread with prompt and {len(files)} files")
            
            # Load agent configuration
            # For agent loading, use account_id as the user_id (this is the actual owner of the agents)
            # Guest sessions use admin's agents, so we need to load with admin's permissions
            agent_config = await _load_agent_config(client, agent_id, account_id, account_id, is_new_thread=True)
            
            # Check billing and limits (including project and thread limits)
            # Skip for guest users
            from core.guest_session import guest_session_service
            is_guest = await guest_session_service.is_guest_session(account_id)
            
            if not is_guest:
                await _check_billing_and_limits(client, account_id, model_name, check_project_limit=True)
                
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
            else:
                logger.info(f"✅ Guest user - skipping thread limit checks")

            effective_model = await _get_effective_model(model_name, agent_config, client, account_id)
            
            from core.utils.config import config as app_config
            project_owner_id = account_id
            if is_guest and app_config.GUEST_MODE_ADMIN_USER_ID:
                project_owner_id = app_config.GUEST_MODE_ADMIN_USER_ID
                logger.info(f"Guest user - using admin account {project_owner_id} as project owner")
            
            # Create Project
            placeholder_name = f"{prompt[:30]}..." if len(prompt) > 30 else prompt
            project = await client.table('projects').insert({
                "project_id": str(uuid.uuid4()),
                "account_id": project_owner_id,
                "name": placeholder_name,
                "created_at": datetime.now(timezone.utc).isoformat()
            }).execute()
            project_id = project.data[0]['project_id']
            logger.info(f"Created new project: {project_id}")
            
            # Create sandbox if files provided
            sandbox = None
            sandbox_id = None
            if files and len(files) > 0:
                try:
                    sandbox, sandbox_id = await _ensure_sandbox_for_thread(client, project_id, files)
                    if not sandbox:
                        raise Exception("Failed to create sandbox for file uploads")
                except Exception as e:
                    logger.error(f"Error creating sandbox: {str(e)}")
                    # Clean up project
                    await client.table('projects').delete().eq('project_id', project_id).execute()
                    raise HTTPException(status_code=500, detail=f"Failed to create sandbox: {str(e)}")
            
            # Create Thread (use project_owner_id for guests to avoid FK constraint)
            thread_data = {
                "thread_id": str(uuid.uuid4()),
                "project_id": project_id,
                "account_id": project_owner_id,  # Use admin account for guests
                "created_at": datetime.now(timezone.utc).isoformat()
            }
            
            structlog.contextvars.bind_contextvars(
                thread_id=thread_data["thread_id"],
                project_id=project_id,
                account_id=account_id,
            )
            
            if agent_config:
                logger.debug(f"Using agent {agent_config['agent_id']} for this conversation")
                structlog.contextvars.bind_contextvars(agent_id=agent_config['agent_id'])
            
            thread = await client.table('threads').insert(thread_data).execute()
            thread_id = thread.data[0]['thread_id']
            logger.debug(f"Created new thread: {thread_id}")
            
            # Trigger background naming task
            asyncio.create_task(generate_and_update_project_name(project_id=project_id, prompt=prompt))
            
            # Handle file uploads and create user message
            message_content = prompt
            if sandbox and files:
                message_content = await _handle_file_uploads(files, sandbox, project_id, prompt)
            
            # Create initial user message
            message_id = str(uuid.uuid4())
            message_payload = {"role": "user", "content": message_content}
            await client.table('messages').insert({
                "message_id": message_id,
                "thread_id": thread_id,
                "type": "user",
                "is_llm_message": True,
                "content": message_payload,
                "created_at": datetime.now(timezone.utc).isoformat()
            }).execute()
            
            # Create agent run (use actual account_id for access tracking)
            agent_run_id = await _create_agent_run_record(client, thread_id, agent_config, effective_model, account_id)
            
            # Trigger background execution
            await _trigger_agent_background(agent_run_id, thread_id, project_id, effective_model, agent_config)
            
            # Increment guest message count if guest user
            response = {
                "thread_id": thread_id,
                "agent_run_id": agent_run_id,
                "status": "running"
            }
            
            if guest_session:
                from core.guest_session import guest_session_service
                updated_session = await guest_session_service.increment_message_count(guest_session['session_id'])
                await guest_session_service.add_thread_to_session(guest_session['session_id'], thread_id)
                response['guest_session'] = await guest_session_service.get_session_info(guest_session['session_id'])
            
            return response
    
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error in unified agent start: {str(e)}\n{traceback.format_exc()}")
        # Log the actual error details for debugging
        error_details = {
            "error": str(e),
            "error_type": type(e).__name__,
            "traceback": traceback.format_exc()
        }
        logger.error(f"Full error details: {error_details}")
        raise HTTPException(status_code=500, detail=f"Failed to start agent: {str(e)}")

@router.post("/agent-run/{agent_run_id}/stop", summary="Stop Agent Run", operation_id="stop_agent_run")
async def stop_agent(agent_run_id: str, user_id: str = Depends(verify_and_get_user_id_from_jwt)):
    """Stop a running agent."""
    structlog.contextvars.bind_contextvars(
        agent_run_id=agent_run_id,
    )
    logger.debug(f"Received request to stop agent run: {agent_run_id}")
    client = await utils.db.client
    await _get_agent_run_with_access_check(client, agent_run_id, user_id)
    await stop_agent_run(agent_run_id)
    return {"status": "stopped"}

@router.get("/agent-runs/active", summary="List All Active Agent Runs", operation_id="list_active_agent_runs")
async def get_active_agent_runs(user_id: str = Depends(verify_and_get_user_id_from_jwt)):
    """Get all active (running) agent runs for the current user across all threads."""
    try:
        logger.debug(f"Fetching all active agent runs for user: {user_id}")
        client = await utils.db.client
        
        # Query all running agent runs where the thread belongs to the user
        # Join with threads table to filter by account_id
        agent_runs = await client.table('agent_runs').select('id, thread_id, status, started_at').eq('status', 'running').execute()
        
        if not agent_runs.data:
            return {"active_runs": []}
        
        # Filter agent runs to only include those from threads the user has access to
        # Get thread_ids and check access
        thread_ids = [run['thread_id'] for run in agent_runs.data]
        
        # Get threads that belong to the user
        threads = await client.table('threads').select('thread_id, account_id').in_('thread_id', thread_ids).eq('account_id', user_id).execute()
        
        # Create a set of accessible thread IDs
        accessible_thread_ids = {thread['thread_id'] for thread in threads.data}
        
        # Filter agent runs to only include accessible ones
        accessible_runs = [
            {
                'id': run['id'],
                'thread_id': run['thread_id'],
                'status': run['status'],
                'started_at': run['started_at']
            }
            for run in agent_runs.data
            if run['thread_id'] in accessible_thread_ids
        ]
        
        logger.debug(f"Found {len(accessible_runs)} active agent runs for user: {user_id}")
        return {"active_runs": accessible_runs}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching active agent runs for user {user_id}: {str(e)}\n{traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=f"Failed to fetch active agent runs: {str(e)}")

@router.get("/thread/{thread_id}/agent-runs", summary="List Thread Agent Runs", operation_id="list_thread_agent_runs")
async def get_agent_runs(thread_id: str, user_id: str = Depends(verify_and_get_user_id_from_jwt)):
    """Get all agent runs for a thread."""
    structlog.contextvars.bind_contextvars(
        thread_id=thread_id,
    )
    logger.debug(f"Fetching agent runs for thread: {thread_id}")
    client = await utils.db.client
    await verify_and_authorize_thread_access(client, thread_id, user_id)
    agent_runs = await client.table('agent_runs').select('id, thread_id, status, started_at, completed_at, error, created_at, updated_at').eq("thread_id", thread_id).order('created_at', desc=True).execute()
    logger.debug(f"Found {len(agent_runs.data)} agent runs for thread: {thread_id}")
    return {"agent_runs": agent_runs.data}

@router.get("/agent-run/{agent_run_id}", summary="Get Agent Run", operation_id="get_agent_run")
async def get_agent_run(agent_run_id: str, user_id: str = Depends(verify_and_get_user_id_from_jwt)):
    """Get agent run status and responses."""
    structlog.contextvars.bind_contextvars(
        agent_run_id=agent_run_id,
    )
    logger.debug(f"Fetching agent run details: {agent_run_id}")
    client = await utils.db.client
    agent_run_data = await _get_agent_run_with_access_check(client, agent_run_id, user_id)
    # Note: Responses are not included here by default, they are in the stream or DB
    return {
        "id": agent_run_data['id'],
        "threadId": agent_run_data['thread_id'],
        "status": agent_run_data['status'],
        "startedAt": agent_run_data['started_at'],
        "completedAt": agent_run_data['completed_at'],
        "error": agent_run_data['error']
    }

@router.get("/thread/{thread_id}/agent", response_model=ThreadAgentResponse, summary="Get Thread Agent", operation_id="get_thread_agent")
async def get_thread_agent(thread_id: str, user_id: str = Depends(verify_and_get_user_id_from_jwt)):
    """Get the agent details for a specific thread. Since threads are fully agent-agnostic, 
    this returns the most recently used agent from agent_runs only."""
    structlog.contextvars.bind_contextvars(
        thread_id=thread_id,
    )
    logger.debug(f"Fetching agent details for thread: {thread_id}")
    client = await utils.db.client
    
    try:
        # Verify thread access and get thread data
        await verify_and_authorize_thread_access(client, thread_id, user_id)
        thread_result = await client.table('threads').select('account_id').eq('thread_id', thread_id).execute()
        
        if not thread_result.data:
            raise HTTPException(status_code=404, detail="Thread not found")
        
        thread_data = thread_result.data[0]
        account_id = thread_data.get('account_id')
        
        effective_agent_id = None
        agent_source = "none"
        
        # Get the most recently used agent from agent_runs
        recent_agent_result = await client.table('agent_runs').select('agent_id', 'agent_version_id').eq('thread_id', thread_id).not_.is_('agent_id', 'null').order('created_at', desc=True).limit(1).execute()
        if recent_agent_result.data:
            effective_agent_id = recent_agent_result.data[0]['agent_id']
            recent_version_id = recent_agent_result.data[0].get('agent_version_id')
            agent_source = "recent"
            logger.debug(f"Found most recently used agent: {effective_agent_id} (version: {recent_version_id})")
        
        # If no agent found in agent_runs
        if not effective_agent_id:
            return {
                "agent": None,
                "source": "none",
                "message": "No agent has been used in this thread yet. Threads are agent-agnostic - use /agent/start to select an agent."
            }
        
        # Fetch the agent details
        agent_result = await client.table('agents').select('*').eq('agent_id', effective_agent_id).eq('account_id', account_id).execute()
        
        if not agent_result.data:
            # Agent was deleted or doesn't exist
            return {
                "agent": None,
                "source": "missing",
                "message": f"Agent {effective_agent_id} not found or was deleted. You can select a different agent."
            }
        
        agent_data = agent_result.data[0]
        
        # Use versioning system to get current version data
        version_data = None
        current_version = None
        if agent_data.get('current_version_id'):
            try:
                version_service = await _get_version_service()
                current_version_obj = await version_service.get_version(
                    agent_id=effective_agent_id,
                    version_id=agent_data['current_version_id'],
                    user_id=user_id
                )
                current_version_data = current_version_obj.to_dict()
                version_data = current_version_data
                
                # Create AgentVersionResponse from version data
                current_version = AgentVersionResponse(
                    version_id=current_version_data['version_id'],
                    agent_id=current_version_data['agent_id'],
                    version_number=current_version_data['version_number'],
                    version_name=current_version_data['version_name'],
                    system_prompt=current_version_data['system_prompt'],
                    model=current_version_data.get('model'),
                    configured_mcps=current_version_data.get('configured_mcps', []),
                    custom_mcps=current_version_data.get('custom_mcps', []),
                    agentpress_tools=current_version_data.get('agentpress_tools', {}),
                    is_active=current_version_data.get('is_active', True),
                    created_at=current_version_data['created_at'],
                    updated_at=current_version_data.get('updated_at', current_version_data['created_at']),
                    created_by=current_version_data.get('created_by')
                )
                
                logger.debug(f"Using agent {agent_data['name']} version {current_version_data.get('version_name', 'v1')}")
            except Exception as e:
                logger.warning(f"Failed to get version data for agent {effective_agent_id}: {e}")
        
        version_data = None
        if current_version:
            version_data = {
                'version_id': current_version.version_id,
                'agent_id': current_version.agent_id,
                'version_number': current_version.version_number,
                'version_name': current_version.version_name,
                'system_prompt': current_version.system_prompt,
                'model': current_version.model,
                'configured_mcps': current_version.configured_mcps,
                'custom_mcps': current_version.custom_mcps,
                'agentpress_tools': current_version.agentpress_tools,
                'is_active': current_version.is_active,
                'created_at': current_version.created_at,
                'updated_at': current_version.updated_at,
                'created_by': current_version.created_by
            }
        
        # Load agent using unified loader
        from .agent_loader import get_agent_loader
        loader = await get_agent_loader()
        agent_obj = await loader.load_agent(agent_data['agent_id'], user_id, load_config=True)
        
        return {
            "agent": agent_obj.to_pydantic_model(),
            "source": agent_source,
            "message": f"Using {agent_source} agent: {agent_data['name']}. Threads are agent-agnostic - you can change agents anytime."
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching agent for thread {thread_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to fetch thread agent: {str(e)}")

@router.get("/agent-run/{agent_run_id}/stream", summary="Stream Agent Run", operation_id="stream_agent_run")
async def stream_agent_run(
    agent_run_id: str,
    token: Optional[str] = None,
    guest_session: Optional[str] = None,
    request: Request = None
):
    logger.debug(f"🔐 Stream auth check - agent_run: {agent_run_id}, has_token: {bool(token)}, has_guest_session: {bool(guest_session)}, guest_session_id: {guest_session[:8] + '...' if guest_session else None}")
    client = await utils.db.client

    user_id = await get_user_id_from_stream_auth(request, token, guest_session) # practically instant
    agent_run_data = await _get_agent_run_with_access_check(client, agent_run_id, user_id) # 1 db query

    structlog.contextvars.bind_contextvars(
        agent_run_id=agent_run_id,
        user_id=user_id,
    )

    response_list_key = f"agent_run:{agent_run_id}:responses"
    response_channel = f"agent_run:{agent_run_id}:new_response"
    control_channel = f"agent_run:{agent_run_id}:control" # Global control channel

    async def stream_generator(agent_run_data):
        logger.debug(f"Streaming responses for {agent_run_id} using Redis list {response_list_key} and channel {response_channel}")
        last_processed_index = -1
        # Single pubsub used for response + control
        listener_task = None
        terminate_stream = False
        initial_yield_complete = False

        try:
            # 1. Fetch and yield initial responses from Redis list
            initial_responses_json = await redis.lrange(response_list_key, 0, -1)
            initial_responses = []
            if initial_responses_json:
                initial_responses = [json.loads(r) for r in initial_responses_json]
                logger.debug(f"Sending {len(initial_responses)} initial responses for {agent_run_id}")
                for response in initial_responses:
                    yield f"data: {json.dumps(response)}\n\n"
                last_processed_index = len(initial_responses) - 1
            initial_yield_complete = True

            # 2. Check run status
            current_status = agent_run_data.get('status') if agent_run_data else None

            if current_status != 'running':
                logger.debug(f"Agent run {agent_run_id} is not running (status: {current_status}). Ending stream.")
                yield f"data: {json.dumps({'type': 'status', 'status': 'completed'})}\n\n"
                return
          
            structlog.contextvars.bind_contextvars(
                thread_id=agent_run_data.get('thread_id'),
            )

            # 3. Use a single Pub/Sub connection subscribed to both channels
            pubsub = await redis.create_pubsub()
            await pubsub.subscribe(response_channel, control_channel)
            logger.debug(f"Subscribed to channels: {response_channel}, {control_channel}")

            # Queue to communicate between listeners and the main generator loop
            message_queue = asyncio.Queue()

            async def listen_messages():
                listener = pubsub.listen()
                task = asyncio.create_task(listener.__anext__())

                while not terminate_stream:
                    done, _ = await asyncio.wait([task], return_when=asyncio.FIRST_COMPLETED)
                    for finished in done:
                        try:
                            message = finished.result()
                            if message and isinstance(message, dict) and message.get("type") == "message":
                                channel = message.get("channel")
                                data = message.get("data")
                                if isinstance(data, bytes):
                                    data = data.decode('utf-8')

                                if channel == response_channel and data == "new":
                                    await message_queue.put({"type": "new_response"})
                                elif channel == control_channel and data in ["STOP", "END_STREAM", "ERROR"]:
                                    logger.debug(f"Received control signal '{data}' for {agent_run_id}")
                                    await message_queue.put({"type": "control", "data": data})
                                    return  # Stop listening on control signal

                        except StopAsyncIteration:
                            logger.warning(f"Listener stopped for {agent_run_id}.")
                            await message_queue.put({"type": "error", "data": "Listener stopped unexpectedly"})
                            return
                        except Exception as e:
                            logger.error(f"Error in listener for {agent_run_id}: {e}")
                            await message_queue.put({"type": "error", "data": "Listener failed"})
                            return
                        finally:
                            # Resubscribe to the next message if continuing
                            if not terminate_stream:
                                task = asyncio.create_task(listener.__anext__())


            listener_task = asyncio.create_task(listen_messages())

            # 4. Main loop to process messages from the queue
            while not terminate_stream:
                try:
                    queue_item = await message_queue.get()

                    if queue_item["type"] == "new_response":
                        # Fetch new responses from Redis list starting after the last processed index
                        new_start_index = last_processed_index + 1
                        new_responses_json = await redis.lrange(response_list_key, new_start_index, -1)

                        if new_responses_json:
                            new_responses = [json.loads(r) for r in new_responses_json]
                            num_new = len(new_responses)
                            # logger.debug(f"Received {num_new} new responses for {agent_run_id} (index {new_start_index} onwards)")
                            for response in new_responses:
                                yield f"data: {json.dumps(response)}\n\n"
                                # Check if this response signals completion
                                if response.get('type') == 'status' and response.get('status') in ['completed', 'failed', 'stopped']:
                                    logger.debug(f"Detected run completion via status message in stream: {response.get('status')}")
                                    terminate_stream = True
                                    break # Stop processing further new responses
                            last_processed_index += num_new
                        if terminate_stream: break

                    elif queue_item["type"] == "control":
                        control_signal = queue_item["data"]
                        terminate_stream = True # Stop the stream on any control signal
                        yield f"data: {json.dumps({'type': 'status', 'status': control_signal})}\n\n"
                        break

                    elif queue_item["type"] == "error":
                        logger.error(f"Listener error for {agent_run_id}: {queue_item['data']}")
                        terminate_stream = True
                        yield f"data: {json.dumps({'type': 'status', 'status': 'error'})}\n\n"
                        break

                except asyncio.CancelledError:
                     logger.debug(f"Stream generator main loop cancelled for {agent_run_id}")
                     terminate_stream = True
                     break
                except Exception as loop_err:
                    logger.error(f"Error in stream generator main loop for {agent_run_id}: {loop_err}", exc_info=True)
                    terminate_stream = True
                    yield f"data: {json.dumps({'type': 'status', 'status': 'error', 'message': f'Stream failed: {loop_err}'})}\n\n"
                    break

        except Exception as e:
            logger.error(f"Error setting up stream for agent run {agent_run_id}: {e}", exc_info=True)
            # Only yield error if initial yield didn't happen
            if not initial_yield_complete:
                 yield f"data: {json.dumps({'type': 'status', 'status': 'error', 'message': f'Failed to start stream: {e}'})}\n\n"
        finally:
            terminate_stream = True
            # Graceful shutdown order: unsubscribe → close → cancel
            try:
                if 'pubsub' in locals() and pubsub:
                    await pubsub.unsubscribe(response_channel, control_channel)
                    await pubsub.close()
            except Exception as e:
                logger.debug(f"Error during pubsub cleanup for {agent_run_id}: {e}")

            if listener_task:
                listener_task.cancel()
                try:
                    await listener_task  # Reap inner tasks & swallow their errors
                except asyncio.CancelledError:
                    pass
                except Exception as e:
                    logger.debug(f"listener_task ended with: {e}")
            # Wait briefly for tasks to cancel
            await asyncio.sleep(0.1)
            logger.debug(f"Streaming cleanup complete for agent run: {agent_run_id}")

    return StreamingResponse(stream_generator(agent_run_data), media_type="text/event-stream", headers={
        "Cache-Control": "no-cache, no-transform", "Connection": "keep-alive",
        "X-Accel-Buffering": "no", "Content-Type": "text/event-stream",
        "Access-Control-Allow-Origin": "*"
    })
