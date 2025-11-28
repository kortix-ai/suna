import asyncio
import json
import traceback
import uuid
import os
from datetime import datetime, timezone
from typing import Optional, List, Tuple, Dict, Any
from fastapi import APIRouter, HTTPException, Depends, Query, Request, Body, File, UploadFile, Form
from fastapi.responses import StreamingResponse
from core.utils.auth_utils import verify_and_get_user_id_from_jwt, get_user_id_from_stream_auth, verify_and_authorize_thread_access
from core.utils.logger import logger, structlog
from core.billing.credits.integration import billing_integration
from core.utils.config import config, EnvMode
from core.services import redis
from core.sandbox.sandbox import create_sandbox, delete_sandbox, get_or_start_sandbox
from core.utils.sandbox_utils import generate_unique_filename, get_uploads_directory
from run_agent_background import run_agent_background
import dramatiq

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
    
    # Check metadata for actual_user_id (used for team members who share an account_id)
    metadata = agent_run_data.get('metadata', {})
    actual_user_id = metadata.get('actual_user_id')
    
    # If metadata has actual_user_id, use that for access check (handles team members)
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
    """Find a shared Suna agent to use as fallback when user has no agents."""
    from .agent_loader import get_agent_loader
    from core.utils.config import config
    
    admin_user_id = config.SYSTEM_ADMIN_USER_ID
    
    if admin_user_id:
        admin_suna = await client.table('agents').select('agent_id').eq('account_id', admin_user_id).eq('metadata->>is_suna_default', 'true').maybe_single().execute()
        
        if admin_suna and admin_suna.data:
            loader = await get_agent_loader()
            agent_data = await loader.load_agent(admin_suna.data['agent_id'], admin_user_id, load_config=True)
            logger.info(f"✅ Using system Suna agent from admin user: {agent_data.name} ({agent_data.agent_id})")
            return agent_data
        else:
            logger.warning(f"⚠️ SYSTEM_ADMIN_USER_ID configured but no Suna agent found for user {admin_user_id}")
    
    # Fallback: search for any Suna agent
    any_suna = await client.table('agents').select('agent_id, account_id').eq('metadata->>is_suna_default', 'true').limit(1).maybe_single().execute()
    
    if any_suna and any_suna.data:
        loader = await get_agent_loader()
        agent_data = await loader.load_agent(any_suna.data['agent_id'], any_suna.data['account_id'], load_config=True)
        logger.info(f"Using shared Suna agent: {agent_data.name} ({agent_data.agent_id})")
        return agent_data
    
    logger.error("❌ No Suna agent found! Set SYSTEM_ADMIN_USER_ID in .env")
    return None


async def _load_agent_config(client, agent_id: Optional[str], account_id: str, user_id: str, is_new_thread: bool = False):
    import time
    t_start = time.time()
    
    from .agent_loader import get_agent_loader
    loader = await get_agent_loader()
    
    agent_data = None
    
    logger.debug(f"[AGENT LOAD] Loading agent: {agent_id or 'default'}")

    if agent_id:
        # OPTIMIZED: For Suna agents, use fast path (static config + cached MCPs)
        # This avoids DB queries entirely when cache is warm
        from core.runtime_cache import get_static_suna_config, get_cached_user_mcps
        
        static_config = get_static_suna_config()
        cached_mcps = await get_cached_user_mcps(agent_id)
        
        # Fast path: If we have static config AND cached MCPs, assume it's Suna
        # (cached MCPs only exist for Suna agents)
        if static_config and cached_mcps is not None:
            # Fast path: Use static config + cached MCPs (zero DB calls!)
            from core.agent_loader import AgentData
            agent_data = AgentData(
                agent_id=agent_id,
                name="Suna",
                description=None,
                account_id=account_id,
                is_default=True,
                is_public=False,
                tags=[],
                icon_name=None,
                icon_color=None,
                icon_background=None,
                created_at="",
                updated_at="",
                current_version_id=None,
                version_count=1,
                metadata={'is_suna_default': True},
                system_prompt=static_config['system_prompt'],
                model=static_config['model'],
                agentpress_tools=static_config['agentpress_tools'],
                configured_mcps=cached_mcps.get('configured_mcps', []),
                custom_mcps=cached_mcps.get('custom_mcps', []),
                triggers=cached_mcps.get('triggers', []),
                is_suna_default=True,
                centrally_managed=True,
                config_loaded=True,
                restrictions=static_config['restrictions']
            )
            logger.info(f"⚡ [FAST PATH] Suna config from memory + Redis MCPs: {(time.time() - t_start)*1000:.1f}ms (zero DB calls)")
        else:
            # Fall back to normal loader (handles cache misses and custom agents)
            t_loader = time.time()
            agent_data = await loader.load_agent(agent_id, user_id, load_config=True)
            logger.info(f"⏱️ [TIMING] Agent loader (DB path): {(time.time() - t_loader)*1000:.1f}ms | Total: {(time.time() - t_start)*1000:.1f}ms")
            logger.debug(f"Using agent {agent_data.name} ({agent_id}) version {agent_data.version_name}")
    else:
        logger.debug(f"[AGENT LOAD] Loading default agent")
        
        if is_new_thread:
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
    
    OPTIMIZED: Runs all checks in parallel to minimize latency.
    
    Args:
        client: Database client
        account_id: Account ID to check
        model_name: Model name to check access for
        check_project_limit: Whether to check project count limit (for new threads)
    
    Raises:
        HTTPException: If billing/limits checks fail
    """
    import time
    t_start = time.time()
    
    # Run billing check and limit checks IN PARALLEL
    async def check_billing():
        return await billing_integration.check_model_and_billing_access(
            account_id, model_name, client
        )
    
    async def check_agent_runs():
        if config.ENV_MODE == EnvMode.LOCAL:
            return {'can_start': True}
        return await check_agent_run_limit(client, account_id)
    
    async def check_projects():
        if config.ENV_MODE == EnvMode.LOCAL or not check_project_limit:
            return {'can_create': True}
        return await check_project_count_limit(client, account_id)
    
    # Execute all checks in parallel
    billing_result, agent_run_result, project_result = await asyncio.gather(
        check_billing(),
        check_agent_runs(),
        check_projects()
    )
    
    logger.debug(f"⏱️ [TIMING] Parallel billing/limit checks: {(time.time() - t_start) * 1000:.1f}ms")
    
    # Process billing result
    can_proceed, error_message, context = billing_result
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
    
    # Process agent run limit result
    if not agent_run_result.get('can_start', True):
        error_detail = {
            "message": f"Maximum of {agent_run_result['limit']} concurrent agent runs allowed. You currently have {agent_run_result['running_count']} running.",
            "running_thread_ids": agent_run_result.get('running_thread_ids', []),
            "running_count": agent_run_result['running_count'],
            "limit": agent_run_result['limit'],
            "error_code": "AGENT_RUN_LIMIT_EXCEEDED"
        }
        logger.warning(f"Agent run limit exceeded for account {account_id}: {agent_run_result['running_count']}/{agent_run_result['limit']} running agents")
        raise HTTPException(status_code=402, detail=error_detail)

    # Process project limit result
    if check_project_limit and not project_result.get('can_create', True):
        error_detail = {
            "message": f"Maximum of {project_result['limit']} projects allowed for your current plan. You have {project_result['current_count']} projects.",
            "current_count": project_result['current_count'],
            "limit": project_result['limit'],
            "tier_name": project_result['tier_name'],
            "error_code": "PROJECT_LIMIT_EXCEEDED"
        }
        logger.warning(f"Project limit exceeded for account {account_id}: {project_result['current_count']}/{project_result['limit']} projects")
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


async def _create_agent_run_record(
    client, 
    thread_id: str, 
    agent_config: Optional[dict], 
    effective_model: str, 
    actual_user_id: str,
    extra_metadata: Optional[Dict[str, Any]] = None
) -> str:
    """
    Create an agent run record in the database.
    
    Args:
        client: Database client
        thread_id: Thread ID to associate with
        agent_config: Agent configuration dict
        effective_model: Model name to use
        actual_user_id: The actual user ID who initiated the run
        extra_metadata: Additional metadata to merge into the run record
    
    Returns:
        agent_run_id: The created agent run ID
    """
    run_metadata = {
        "model_name": effective_model,
        "actual_user_id": actual_user_id
    }
    
    # Merge extra metadata if provided
    if extra_metadata:
        run_metadata.update(extra_metadata)
    
    agent_run = await client.table('agent_runs').insert({
        "thread_id": thread_id,
        "status": "running",
        "started_at": datetime.now(timezone.utc).isoformat(),
        "agent_id": agent_config.get('agent_id') if agent_config else None,
        "agent_version_id": agent_config.get('current_version_id') if agent_config else None,
        "metadata": run_metadata
    }).execute()

    agent_run_id = agent_run.data[0]['id']
    structlog.contextvars.bind_contextvars(agent_run_id=agent_run_id)
    logger.debug(f"Created new agent run: {agent_run_id}")

    # Invalidate running runs cache so next check gets fresh data
    try:
        from core.runtime_cache import invalidate_running_runs_cache
        await invalidate_running_runs_cache(actual_user_id)
    except Exception as cache_error:
        logger.warning(f"Failed to invalidate running runs cache: {cache_error}")
    
    # Invalidate account-state cache to refresh concurrent runs limit
    try:
        from core.billing.shared.cache_utils import invalidate_account_state_cache
        await invalidate_account_state_cache(actual_user_id)
    except Exception as cache_error:
        logger.warning(f"Failed to invalidate account-state cache: {cache_error}")

    # Register run in Redis
    instance_key = f"active_run:{utils.instance_id}:{agent_run_id}"
    try:
        await redis.set(instance_key, "running", ex=redis.REDIS_KEY_TTL)
    except Exception as e:
        logger.warning(f"Failed to register agent run in Redis ({instance_key}): {str(e)}")

    return agent_run_id


async def _trigger_agent_background(
    agent_run_id: str, 
    thread_id: str, 
    project_id: str, 
    effective_model: str, 
    agent_id: Optional[str],
    account_id: Optional[str] = None
):
    """
    Trigger the background agent execution.
    
    Args:
        agent_run_id: Agent run ID
        thread_id: Thread ID
        project_id: Project ID
        effective_model: Model name to use
        agent_id: Agent ID (instead of full config to reduce log spam)
        account_id: Account ID for authorization in worker
    """
    request_id = structlog.contextvars.get_contextvars().get('request_id')

    logger.info(f"🚀 Sending agent run {agent_run_id} to Dramatiq queue (thread: {thread_id}, model: {effective_model})")
    
    try:
        message = run_agent_background.send(
            agent_run_id=agent_run_id,
            thread_id=thread_id,
            instance_id=utils.instance_id,
            project_id=project_id,
            model_name=effective_model,
            agent_id=agent_id,  # Pass agent_id instead of full agent_config
            account_id=account_id,  # Pass account_id for worker authorization
            request_id=request_id,
        )
        message_id = message.message_id if hasattr(message, 'message_id') else 'N/A'
        logger.info(f"✅ Successfully enqueued agent run {agent_run_id} to Dramatiq (message_id: {message_id})")
    except Exception as e:
        logger.error(f"❌ Failed to enqueue agent run {agent_run_id} to Dramatiq: {e}", exc_info=True)
        raise


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
        
        # Update project metadata cache with sandbox data (instead of invalidate)
        try:
            from core.runtime_cache import set_cached_project_metadata
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
        
        return sandbox, sandbox_id
    except Exception as e:
        logger.error(f"Error creating sandbox: {str(e)}")
        raise Exception(f"Failed to create sandbox: {str(e)}")


# ============================================================================
# Core Agent Start Function (used by HTTP endpoint and triggers)
# ============================================================================

async def start_agent_run(
    account_id: str,
    prompt: str,
    agent_id: Optional[str] = None,
    model_name: Optional[str] = None,
    thread_id: Optional[str] = None,
    project_id: Optional[str] = None,
    message_content: Optional[str] = None,  # Pre-processed content (with file refs)
    metadata: Optional[Dict[str, Any]] = None,
    skip_limits_check: bool = False,  # For triggers that have their own limits
) -> Dict[str, Any]:
    """
    Core function to start an agent run.
    
    Used by:
    - HTTP endpoint (unified_agent_start)
    - Trigger execution service
    - Any other internal callers
    
    Message Creation Behavior:
    - NEW thread (thread_id=None): Creates user message with prompt (required)
    - EXISTING thread + prompt provided: Creates user message with prompt
    - EXISTING thread + NO prompt: Does NOT create a message (assumes message 
      was already added via /threads/{id}/messages/add)
    
    This supports two client patterns:
    1. Single-call: POST /agent/start with prompt → creates thread + message + starts agent
    2. Two-call: POST /threads/{id}/messages/add, then POST /agent/start (no prompt)
    
    Args:
        account_id: User account ID (required)
        prompt: User prompt/message (required for new threads, optional for existing)
        agent_id: Agent ID to use (optional, uses default)
        model_name: Model to use (optional, uses agent/tier default)
        thread_id: Existing thread ID (None to create new)
        project_id: Existing project ID (required if thread_id provided)
        message_content: Pre-processed message content (if files were handled externally)
        metadata: Additional metadata for the agent run
        skip_limits_check: Skip billing/limits check (for pre-validated callers)
    
    Returns:
        Dict with thread_id, agent_run_id, project_id, status
    """
    import time
    t_start = time.time()
    
    client = await utils.db.client
    is_new_thread = thread_id is None
    
    # Use message_content if provided, otherwise use prompt
    final_message_content = message_content or prompt
    
    # Load config and check limits in parallel
    t_parallel = time.time()
    
    async def load_config():
        return await _load_agent_config(client, agent_id, account_id, account_id, is_new_thread=is_new_thread)
    
    async def check_limits():
        if skip_limits_check:
            return {'can_create': True}
        await _check_billing_and_limits(client, account_id, model_name or "default", check_project_limit=is_new_thread)
        if is_new_thread and config.ENV_MODE != EnvMode.LOCAL:
            from core.utils.limits_checker import check_thread_limit
            return await check_thread_limit(client, account_id)
        return {'can_create': True}
    
    agent_config, limit_result = await asyncio.gather(load_config(), check_limits())
    logger.debug(f"⏱️ [TIMING] Parallel config+limits: {(time.time() - t_parallel) * 1000:.1f}ms")
    
    # Check thread limit result
    if limit_result and not limit_result.get('can_create', True):
        raise ValueError(f"Thread limit exceeded: {limit_result.get('current_count', 0)}/{limit_result.get('limit', 0)}")
    
    # Resolve effective model
    effective_model = await _get_effective_model(model_name, agent_config, client, account_id)
    
    if is_new_thread:
        # ================================================================
        # NEW THREAD PATH
        # ================================================================
        
        # Create project only if not already provided (e.g., pre-created for file uploads)
        if not project_id:
            t_project = time.time()
            project_id = str(uuid.uuid4())
            placeholder_name = f"{prompt[:30]}..." if len(prompt) > 30 else prompt
            
            await client.table('projects').insert({
                "project_id": project_id,
                "account_id": account_id,
                "name": placeholder_name,
                "created_at": datetime.now(timezone.utc).isoformat()
            }).execute()
            logger.debug(f"⏱️ [TIMING] Project created: {(time.time() - t_project) * 1000:.1f}ms")
            
            # Pre-cache project metadata
            try:
                from core.runtime_cache import set_cached_project_metadata
                await set_cached_project_metadata(project_id, {})
            except Exception:
                pass
            
            # Background naming task
            asyncio.create_task(generate_and_update_project_name(project_id=project_id, prompt=prompt))
        
        # Create Thread
        t_thread = time.time()
        thread_id = str(uuid.uuid4())
        await client.table('threads').insert({
            "thread_id": thread_id,
            "project_id": project_id,
            "account_id": account_id,
            "created_at": datetime.now(timezone.utc).isoformat()
        }).execute()
        logger.debug(f"⏱️ [TIMING] Thread created: {(time.time() - t_thread) * 1000:.1f}ms")
        
        structlog.contextvars.bind_contextvars(thread_id=thread_id, project_id=project_id, account_id=account_id)
        
        # Update thread count cache
        try:
            from core.runtime_cache import increment_thread_count_cache
            asyncio.create_task(increment_thread_count_cache(account_id))
        except Exception:
            pass
    
    # Create agent run (and conditionally create message)
    t_parallel2 = time.time()
    
    async def create_message():
        """
        Message creation logic:
        - NEW thread: Always create message (prompt is required at endpoint validation)
        - EXISTING thread + prompt provided: Create message (user wants to add message + start agent)
        - EXISTING thread + NO prompt: Skip (user already added message via /threads/{id}/messages/add)
        
        This prevents duplicate/empty messages when clients use the two-step flow:
        1. /threads/{id}/messages/add (with message)
        2. /agent/start (without prompt, just to start the agent)
        """
        # Skip if no content to add
        if not final_message_content or not final_message_content.strip():
            if is_new_thread:
                logger.warning(f"Attempted to create empty message for new thread - this shouldn't happen (validation should catch this)")
            else:
                logger.debug(f"No prompt provided for existing thread {thread_id} - assuming message already exists")
            return
            
        await client.table('messages').insert({
            "message_id": str(uuid.uuid4()),
            "thread_id": thread_id,
            "type": "user",
            "is_llm_message": True,
            "content": {"role": "user", "content": final_message_content},
            "created_at": datetime.now(timezone.utc).isoformat()
        }).execute()
        logger.debug(f"Created user message for thread {thread_id}")
    
    async def create_agent_run():
        return await _create_agent_run_record(client, thread_id, agent_config, effective_model, account_id, metadata)
    
    _, agent_run_id = await asyncio.gather(create_message(), create_agent_run())
    logger.debug(f"⏱️ [TIMING] Parallel message+agent_run: {(time.time() - t_parallel2) * 1000:.1f}ms")
    
    # Trigger background execution
    t_dispatch = time.time()
    await _trigger_agent_background(agent_run_id, thread_id, project_id, effective_model, agent_id, account_id)
    logger.debug(f"⏱️ [TIMING] Worker dispatch: {(time.time() - t_dispatch) * 1000:.1f}ms")
    
    logger.info(f"⏱️ [TIMING] start_agent_run total: {(time.time() - t_start) * 1000:.1f}ms")
    
    return {
        "thread_id": thread_id,
        "agent_run_id": agent_run_id,
        "project_id": project_id,
        "status": "running"
    }


# ============================================================================
# Unified Agent Start Endpoint (HTTP wrapper around start_agent_run)
# ============================================================================

@router.post("/agent/start", response_model=UnifiedAgentStartResponse, summary="Start Agent (Unified)", operation_id="unified_agent_start")
async def unified_agent_start(
    request: Request,
    thread_id: Optional[str] = Form(None),
    prompt: Optional[str] = Form(None),
    model_name: Optional[str] = Form(None),
    agent_id: Optional[str] = Form(None),
    files: List[UploadFile] = File(default=[]),
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """
    Unified HTTP endpoint to start an agent run.
    
    Handles:
    - Authentication (via JWT)
    - File uploads (preprocessing before calling internal function)
    - HTTP-specific validation and error responses
    - Thread access authorization
    
    Delegates core logic to start_agent_run().
    """
    import time
    api_request_start = time.time()
    
    if not utils.instance_id:
        raise HTTPException(status_code=500, detail="Agent API not initialized with instance ID")
    
    client = await utils.db.client
    account_id = user_id
    
    logger.debug(f"Received agent start request: thread_id={thread_id!r}, prompt={prompt[:100] if prompt else None!r}, model_name={model_name!r}, agent_id={agent_id!r}, files_count={len(files)}")
    
    # Validation
    if not thread_id and (not prompt or not prompt.strip()):
        raise HTTPException(status_code=400, detail="prompt is required when creating a new thread")
    
    # Resolve model name
    if model_name is None:
        model_name = await model_manager.get_default_model_for_user(client, account_id)
    else:
        model_name = model_manager.resolve_model_id(model_name)
    
    try:
        project_id = None
        message_content = prompt or ""
        
        if thread_id:
            # ================================================================
            # EXISTING THREAD: Verify access and handle files
            # ================================================================
            structlog.contextvars.bind_contextvars(thread_id=thread_id)
            
            thread_result = await client.table('threads').select('project_id, account_id').eq('thread_id', thread_id).execute()
            if not thread_result.data:
                raise HTTPException(status_code=404, detail="Thread not found")
            
            thread_data = thread_result.data[0]
            project_id = thread_data['project_id']
            
            # Authorization check
            if thread_data['account_id'] != user_id:
                await verify_and_authorize_thread_access(client, thread_id, user_id)
            
            structlog.contextvars.bind_contextvars(project_id=project_id, account_id=account_id)
            
            # Handle file uploads for existing thread
            if files and len(files) > 0:
                sandbox, _ = await _ensure_sandbox_for_thread(client, project_id, files)
                if sandbox:
                    message_content = await _handle_file_uploads(files, sandbox, project_id, prompt or "")
        
        else:
            # ================================================================
            # NEW THREAD: Handle sandbox/files before calling internal
            # ================================================================
            # For new threads with files, we need to create sandbox first
            if files and len(files) > 0:
                # Create project early to attach sandbox
                project_id = str(uuid.uuid4())
                placeholder_name = f"{prompt[:30]}..." if len(prompt) > 30 else prompt
                await client.table('projects').insert({
                    "project_id": project_id,
                    "account_id": account_id,
                    "name": placeholder_name,
                    "created_at": datetime.now(timezone.utc).isoformat()
                }).execute()
                
                # Pre-cache and start naming task
                try:
                    from core.runtime_cache import set_cached_project_metadata
                    await set_cached_project_metadata(project_id, {})
                except Exception:
                    pass
                asyncio.create_task(generate_and_update_project_name(project_id=project_id, prompt=prompt))
                
                try:
                    sandbox, _ = await _ensure_sandbox_for_thread(client, project_id, files)
                    if sandbox:
                        message_content = await _handle_file_uploads(files, sandbox, project_id, prompt)
                except Exception as e:
                    # Cleanup project on sandbox failure
                    await client.table('projects').delete().eq('project_id', project_id).execute()
                    raise HTTPException(status_code=500, detail=f"Failed to create sandbox: {str(e)}")
        
        # Call the internal function
        result = await start_agent_run(
            account_id=account_id,
            prompt=prompt or "",
            agent_id=agent_id,
            model_name=model_name,
            thread_id=thread_id,
            project_id=project_id,  # Pre-created if files were uploaded
            message_content=message_content,  # Includes file references if any
        )
        
        logger.info(f"⏱️ [TIMING] 🎯 API Request Total: {(time.time() - api_request_start) * 1000:.1f}ms")
        
        return {"thread_id": result["thread_id"], "agent_run_id": result["agent_run_id"], "status": "running"}
    
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
    """Get all active (running) agent runs for the current user across all threads.
    
    Efficiently queries DB by first filtering to user's threads, then querying agent_runs.
    This avoids querying all running runs and filtering in memory.
    """
    try:
        logger.debug(f"Fetching all active agent runs for user: {user_id}")
        client = await utils.db.client
        
        try:
            user_threads = await client.table('threads').select('thread_id').eq('account_id', user_id).execute()
        except Exception as db_error:
            logger.error(f"Database error fetching threads for user {user_id}: {str(db_error)}")
            # Return empty list instead of failing - this is a non-critical endpoint
            return {"active_runs": []}
        
        if not user_threads.data:
            return {"active_runs": []}
        
        # Filter out None/empty thread_ids and ensure they're strings
        thread_ids = [
            str(thread['thread_id']) 
            for thread in user_threads.data 
            if thread.get('thread_id') and str(thread['thread_id']).strip()
        ]
        
        logger.debug(f"Found {len(thread_ids)} valid thread_ids for user {user_id} (from {len(user_threads.data)} total threads)")
        
        # PostgREST's .in_() filter doesn't handle empty arrays gracefully
        if not thread_ids:
            logger.debug(f"No valid thread_ids found for user: {user_id}")
            return {"active_runs": []}
        
        # Use batch_query_in utility which handles empty lists and batching
        from core.utils.query_utils import batch_query_in
        
        try:
            agent_runs_data = await batch_query_in(
                client=client,
                table_name='agent_runs',
                select_fields='id, thread_id, status, started_at',
                in_field='thread_id',
                in_values=thread_ids,
                additional_filters={'status': 'running'}
            )
        except Exception as query_error:
            logger.error(f"Query error fetching agent runs for user {user_id}: {str(query_error)}")
            # Return empty list instead of failing - this is a non-critical endpoint
            return {"active_runs": []}
        
        # Format response - handle None or empty results
        if not agent_runs_data:
            return {"active_runs": []}
        
        accessible_runs = [
            {
                'id': run.get('id'),
                'thread_id': run.get('thread_id'),
                'status': run.get('status'),
                'started_at': run.get('started_at')
            }
            for run in agent_runs_data
            if run and run.get('id')  # Ensure run exists and has required fields
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
    logger.debug(f"🔐 Stream auth check - agent_run: {agent_run_id}, has_token: {bool(token)}")
    client = await utils.db.client

    user_id = await get_user_id_from_stream_auth(request, token)
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
            # Ensure cleanup happens even on cancellation
            pubsub_cleaned = False
            try:
                if 'pubsub' in locals() and pubsub:
                    await pubsub.unsubscribe(response_channel, control_channel)
                    await pubsub.close()
                    pubsub_cleaned = True
                    logger.debug(f"PubSub cleaned up for {agent_run_id}")
            except asyncio.CancelledError:
                # Still try to cleanup on cancellation
                if 'pubsub' in locals() and pubsub and not pubsub_cleaned:
                    try:
                        await pubsub.unsubscribe(response_channel, control_channel)
                        await pubsub.close()
                        logger.debug(f"PubSub cleaned up after cancellation for {agent_run_id}")
                    except Exception:
                        pass  # Ignore errors during cancellation cleanup
            except Exception as e:
                logger.warning(f"Error during pubsub cleanup for {agent_run_id}: {e}")

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
