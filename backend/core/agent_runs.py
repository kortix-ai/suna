import asyncio
import json
import traceback
import uuid
import os
from datetime import datetime, timezone
from typing import Optional, List, Tuple, Dict
from fastapi import APIRouter, HTTPException, Depends, Request, Body, File, UploadFile, Form
from fastapi.responses import StreamingResponse
from core.utils.auth_utils import verify_and_get_user_id_from_jwt, get_user_id_from_stream_auth, verify_and_authorize_thread_access
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
    
    if account_id == user_id:
        return agent_run_data
        
    await verify_and_authorize_thread_access(client, thread_id, user_id)
    return agent_run_data


# ============================================================================
# Helper Functions for Unified Agent Start
# ============================================================================

async def _load_agent_config(client, agent_id: Optional[str], account_id: str, user_id: str, is_new_thread: bool = False):
    """
    Load agent configuration. Returns agent_config dict or None.
    
    Args:
        client: Database client
        agent_id: Optional agent ID to load
        account_id: Account ID for default agent lookup
        user_id: User ID for authorization
        is_new_thread: If True, ensures Suna is installed for new threads
    """
    from .agent_loader import get_agent_loader
    loader = await get_agent_loader()
    
    agent_data = None
    
    logger.debug(f"[AGENT LOAD] Loading agent: {agent_id or 'default'}")
    
    # Try to load specified agent
    if agent_id:
        agent_data = await loader.load_agent(agent_id, user_id, load_config=True)
        logger.debug(f"Using agent {agent_data.name} ({agent_id}) version {agent_data.version_name}")
    else:
        # Load default agent
        logger.debug(f"[AGENT LOAD] Loading default agent")
        
        # For new threads, ensure Suna is installed
        if is_new_thread:
            from core.utils.ensure_suna import ensure_suna_installed
            await ensure_suna_installed(account_id)
            
            # Try to find the default agent (Suna)
            default_agent = await client.table('agents').select('agent_id').eq('account_id', account_id).eq('metadata->>is_suna_default', 'true').maybe_single().execute()
            
            if default_agent and default_agent.data:
                agent_data = await loader.load_agent(default_agent.data['agent_id'], user_id, load_config=True)
                logger.debug(f"Using default agent: {agent_data.name} ({agent_data.agent_id}) version {agent_data.version_name}")
            else:
                logger.warning(f"[AGENT LOAD] No default agent found for account {account_id}")
                raise HTTPException(status_code=404, detail="No default agent available. Please contact support.")
        else:
            # For existing threads, try to load default agent (is_default flag)
            default_agent = await client.table('agents').select('agent_id').eq('account_id', account_id).eq('is_default', True).maybe_single().execute()
            
            if default_agent and default_agent.data:
                agent_data = await loader.load_agent(default_agent.data['agent_id'], user_id, load_config=True)
                logger.debug(f"Using default agent: {agent_data.name} ({agent_data.agent_id}) version {agent_data.version_name}")
            else:
                logger.warning(f"[AGENT LOAD] No default agent found for account {account_id}")
    
    # Convert to dict for backward compatibility
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
    # Unified billing and model access check
    can_proceed, error_message, context = await billing_integration.check_model_and_billing_access(
        account_id, model_name, client
    )
    
    if not can_proceed:
        if context.get("error_type") == "model_access_denied":
            raise HTTPException(status_code=403, detail={
                "message": error_message, 
                "allowed_models": context.get("allowed_models", [])
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
                "message": f"Maximum of {config.MAX_PARALLEL_AGENT_RUNS} parallel agent runs allowed within 24 hours. You currently have {limit_check['running_count']} running.",
                "running_thread_ids": limit_check['running_thread_ids'],
                "running_count": limit_check['running_count'],
                "limit": config.MAX_PARALLEL_AGENT_RUNS
            }
            logger.warning(f"Agent run limit exceeded for account {account_id}: {limit_check['running_count']} running agents")
            raise HTTPException(status_code=429, detail=error_detail)

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


async def _create_agent_run_record(client, thread_id: str, agent_config: Optional[dict], effective_model: str) -> str:
    """
    Create an agent run record in the database.
    
    Args:
        client: Database client
        thread_id: Thread ID to associate with
        agent_config: Agent configuration dict
        effective_model: Model name to use
    
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
            "model_name": effective_model
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
    thread_id: Optional[str] = Form(None),
    prompt: Optional[str] = Form(None),
    model_name: Optional[str] = Form(None),
    agent_id: Optional[str] = Form(None),
    files: List[UploadFile] = File(default=[]),
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """
    Unified endpoint to start an agent run.
    
    - If thread_id is provided: Starts agent on existing thread (with optional prompt and files)
    - If thread_id is NOT provided: Creates new project/thread and starts agent
    
    Supports file uploads for both new and existing threads.
    """
    if not utils.instance_id:
        raise HTTPException(status_code=500, detail="Agent API not initialized with instance ID")
    
    client = await utils.db.client
    account_id = user_id  # In Basejump, personal account_id is the same as user_id
    
    # Resolve and validate model name
    if model_name is None:
        model_name = await model_manager.get_default_model_for_user(client, account_id)
        logger.debug(f"Using tier-based default model: {model_name}")
    else:
        model_name = model_manager.resolve_model_id(model_name)
        logger.debug(f"Resolved model name: {model_name}")
    
    try:
        # ====================================================================
        # Branch: Existing Thread vs New Thread
        # ====================================================================
        
        if thread_id:
            # ================================================================
            # EXISTING THREAD PATH
            # ================================================================
            logger.debug(f"Starting agent on existing thread: {thread_id}")
            structlog.contextvars.bind_contextvars(thread_id=thread_id)
            
            # Validate thread exists and get metadata
            thread_result = await client.table('threads').select('project_id', 'account_id', 'metadata').eq('thread_id', thread_id).execute()
            
            if not thread_result.data:
                raise HTTPException(status_code=404, detail="Thread not found")
            
            thread_data = thread_result.data[0]
            project_id = thread_data.get('project_id')
            thread_account_id = thread_data.get('account_id')
            thread_metadata = thread_data.get('metadata', {})
            
            # Verify access
            if thread_account_id != user_id:
                await verify_and_authorize_thread_access(client, thread_id, user_id)
            
            structlog.contextvars.bind_contextvars(
                project_id=project_id,
                account_id=thread_account_id,
                thread_metadata=thread_metadata,
            )
            
            # Load agent configuration
            agent_config = await _load_agent_config(client, agent_id, thread_account_id, user_id, is_new_thread=False)
            
            # Check billing and limits
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
            
            # Create agent run
            agent_run_id = await _create_agent_run_record(client, thread_id, agent_config, effective_model)
            
            # Trigger background execution
            await _trigger_agent_background(agent_run_id, thread_id, project_id, effective_model, agent_config)
            
            return {
                "thread_id": thread_id,
                "agent_run_id": agent_run_id,
                "status": "running"
            }
        
        else:
            # ================================================================
            # NEW THREAD PATH
            # ================================================================
            
            # Validate that prompt is provided for new threads
            if not prompt:
                raise HTTPException(status_code=400, detail="prompt is required when creating a new thread")
            
            logger.debug(f"Creating new thread with prompt and {len(files)} files")
            
            # Load agent configuration
            agent_config = await _load_agent_config(client, agent_id, account_id, user_id, is_new_thread=True)
            
            # Check billing and limits (including project limit)
            await _check_billing_and_limits(client, account_id, model_name, check_project_limit=True)
            
            # Get effective model
            effective_model = await _get_effective_model(model_name, agent_config, client, account_id)
            
            # Create Project
            placeholder_name = f"{prompt[:30]}..." if len(prompt) > 30 else prompt
            project = await client.table('projects').insert({
                "project_id": str(uuid.uuid4()),
                "account_id": account_id,
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
            
            # Create Thread
            thread_data = {
                "thread_id": str(uuid.uuid4()),
                "project_id": project_id,
                "account_id": account_id,
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
            
            # Create agent run
            agent_run_id = await _create_agent_run_record(client, thread_id, agent_config, effective_model)
            
            # Trigger background execution
            await _trigger_agent_background(agent_run_id, thread_id, project_id, effective_model, agent_config)
            
            return {
                "thread_id": thread_id,
                "agent_run_id": agent_run_id,
                "status": "running"
            }
    
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error in unified agent start: {str(e)}\n{traceback.format_exc()}")
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
    request: Request = None
):
    """Stream the responses of an agent run using Redis Lists and Pub/Sub."""
    logger.debug(f"Starting stream for agent run: {agent_run_id}")
    client = await utils.db.client

    user_id = await get_user_id_from_stream_auth(request, token) # practically instant
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
