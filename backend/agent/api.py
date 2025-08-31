from fastapi import APIRouter, HTTPException, Depends, Request, Body, File, UploadFile, Form, Query
from fastapi.responses import StreamingResponse
import asyncio
import json
import traceback
import base64
from datetime import datetime, timezone
import uuid
from typing import Optional, List, Dict, Any
import jwt
from pydantic import BaseModel
import tempfile
import os

from agentpress.thread_manager import ThreadManager
from services.supabase import DBConnection
from services import redis
from utils.auth_utils import get_current_user_id_from_jwt, get_user_id_from_stream_auth, verify_thread_access, verify_admin_api_key
from utils.logger import logger, structlog
from services.billing import check_billing_status, can_use_model
from utils.config import config, EnvMode
from sandbox.sandbox import create_sandbox, delete_sandbox, get_or_start_sandbox
from services.llm import make_llm_api_call
from run_agent_background import run_agent_background, _cleanup_redis_response_list, update_agent_run_status
from models import model_manager
from flags.flags import is_enabled

from .config_helper import extract_agent_config, build_unified_config
from .utils import check_agent_run_limit
from .versioning.version_service import get_version_service
from .versioning.api import router as version_router, initialize as initialize_versioning
from .tools.sb_presentation_tool import SandboxPresentationTool

# Helper for version service
async def _get_version_service():
    return await get_version_service()
from utils.omni_default_agent_service import OmniDefaultAgentService



router = APIRouter()
router.include_router(version_router)

db = None
instance_id = None # Global instance ID for this backend instance

# TTL for Redis response lists (24 hours)
REDIS_RESPONSE_LIST_TTL = 3600 * 24



class AgentStartRequest(BaseModel):
    model_name: Optional[str] = None  # Will be set to default model in the endpoint
    enable_thinking: Optional[bool] = False
    reasoning_effort: Optional[str] = 'low'
    stream: Optional[bool] = True
    enable_context_manager: Optional[bool] = False
    agent_id: Optional[str] = None  # Custom agent to use

class InitiateAgentResponse(BaseModel):
    thread_id: str
    agent_run_id: Optional[str] = None

class CreateThreadResponse(BaseModel):
    thread_id: str
    project_id: str

class MessageCreateRequest(BaseModel):
    type: str
    content: str
    is_llm_message: bool = True

class AgentCreateRequest(BaseModel):
    name: str
    description: Optional[str] = None
    system_prompt: Optional[str] = None
    configured_mcps: Optional[List[Dict[str, Any]]] = []
    custom_mcps: Optional[List[Dict[str, Any]]] = []
    agentpress_tools: Optional[Dict[str, Any]] = {}
    is_default: Optional[bool] = False
    avatar: Optional[str] = None
    avatar_color: Optional[str] = None
    profile_image_url: Optional[str] = None
    icon_name: Optional[str] = None
    icon_color: Optional[str] = None
    icon_background: Optional[str] = None

class AgentVersionResponse(BaseModel):
    version_id: str
    agent_id: str
    version_number: int
    version_name: str
    system_prompt: str
    model: Optional[str] = None
    configured_mcps: List[Dict[str, Any]]
    custom_mcps: List[Dict[str, Any]]
    agentpress_tools: Dict[str, Any]
    is_active: bool
    created_at: str
    updated_at: str
    created_by: Optional[str] = None

class AgentVersionCreateRequest(BaseModel):
    system_prompt: str
    configured_mcps: Optional[List[Dict[str, Any]]] = []
    custom_mcps: Optional[List[Dict[str, Any]]] = []
    agentpress_tools: Optional[Dict[str, Any]] = {}
    version_name: Optional[str] = None
    description: Optional[str] = None

class AgentUpdateRequest(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    system_prompt: Optional[str] = None
    configured_mcps: Optional[List[Dict[str, Any]]] = None
    custom_mcps: Optional[List[Dict[str, Any]]] = None
    agentpress_tools: Optional[Dict[str, Any]] = None
    is_default: Optional[bool] = None
    avatar: Optional[str] = None
    avatar_color: Optional[str] = None
    profile_image_url: Optional[str] = None
    icon_name: Optional[str] = None
    icon_color: Optional[str] = None
    icon_background: Optional[str] = None
    replace_mcps: Optional[bool] = None

class AgentResponse(BaseModel):
    agent_id: str
    name: str
    description: Optional[str] = None
    system_prompt: str
    configured_mcps: List[Dict[str, Any]]
    custom_mcps: List[Dict[str, Any]]
    agentpress_tools: Dict[str, Any]
    is_default: bool
    avatar: Optional[str] = None
    avatar_color: Optional[str] = None
    profile_image_url: Optional[str] = None
    icon_name: Optional[str] = None
    icon_color: Optional[str] = None
    icon_background: Optional[str] = None
    created_at: str
    updated_at: Optional[str] = None
    is_public: Optional[bool] = False
    tags: Optional[List[str]] = []
    current_version_id: Optional[str] = None
    version_count: Optional[int] = 1
    current_version: Optional[AgentVersionResponse] = None
    metadata: Optional[Dict[str, Any]] = None

from utils.pagination import PaginationParams

class PaginationInfo(BaseModel):
    current_page: int
    page_size: int
    total_items: int
    total_pages: int
    has_next: bool
    has_previous: bool

class AgentsResponse(BaseModel):
    agents: List[AgentResponse]
    pagination: PaginationInfo

class ThreadAgentResponse(BaseModel):
    agent: Optional[AgentResponse]
    source: str
    message: str

class AgentExportData(BaseModel):
    name: str
    description: Optional[str] = None
    system_prompt: str
    agentpress_tools: Dict[str, Any]
    configured_mcps: List[Dict[str, Any]]
    custom_mcps: List[Dict[str, Any]]
    # Deprecated
    avatar: Optional[str] = None
    avatar_color: Optional[str] = None
    # New
    profile_image_url: Optional[str] = None
    tags: Optional[List[str]] = []
    metadata: Optional[Dict[str, Any]] = None
    export_version: str = "1.1"
    exported_at: str
    exported_by: Optional[str] = None

class AgentImportRequest(BaseModel):
    """Request to import an agent from JSON"""
    import_data: AgentExportData
    import_as_new: bool = True  # Always true, only creating new agents is supported

def initialize(
    _db: DBConnection,
    _instance_id: Optional[str] = None
):
    """Initialize the agent API with resources from the main API."""
    global db, instance_id
    db = _db
    
    # Initialize the versioning module with the same database connection
    initialize_versioning(_db)

    # Use provided instance_id or generate a new one
    if _instance_id:
        instance_id = _instance_id
    else:
        # Generate instance ID
        instance_id = str(uuid.uuid4())[:8]

    logger.debug(f"Initialized agent API with instance ID: {instance_id}")

async def cleanup():
    """Clean up resources and stop running agents on shutdown."""
    logger.debug("Starting cleanup of agent API resources")

    # Use the instance_id to find and clean up this instance's keys
    try:
        if instance_id: # Ensure instance_id is set
            running_keys = await redis.keys(f"active_run:{instance_id}:*")
            logger.debug(f"Found {len(running_keys)} running agent runs for instance {instance_id} to clean up")

            for key in running_keys:
                # Key format: active_run:{instance_id}:{agent_run_id}
                parts = key.split(":")
                if len(parts) == 3:
                    agent_run_id = parts[2]
                    await stop_agent_run(agent_run_id, error_message=f"Instance {instance_id} shutting down")
                else:
                    logger.warning(f"Unexpected key format found: {key}")
        else:
            logger.warning("Instance ID not set, cannot clean up instance-specific agent runs.")

    except Exception as e:
        logger.error(f"Failed to clean up running agent runs: {str(e)}")

    # Close Redis connection
    await redis.close()
    logger.debug("Completed cleanup of agent API resources")

async def stop_agent_run(agent_run_id: str, error_message: Optional[str] = None):
    """Update database and publish stop signal to Redis."""
    logger.debug(f"Stopping agent run: {agent_run_id}")
    client = await db.client
    final_status = "failed" if error_message else "stopped"

    # Attempt to fetch final responses from Redis
    response_list_key = f"agent_run:{agent_run_id}:responses"
    all_responses = []
    try:
        all_responses_json = await redis.lrange(response_list_key, 0, -1)
        all_responses = [json.loads(r) for r in all_responses_json]
        logger.debug(f"Fetched {len(all_responses)} responses from Redis for DB update on stop/fail: {agent_run_id}")
    except Exception as e:
        logger.error(f"Failed to fetch responses from Redis for {agent_run_id} during stop/fail: {e}")
        # Try fetching from DB as a fallback? Or proceed without responses? Proceeding without for now.

    # Update the agent run status in the database
    update_success = await update_agent_run_status(
        client, agent_run_id, final_status, error=error_message
    )

    if not update_success:
        logger.error(f"Failed to update database status for stopped/failed run {agent_run_id}")
        raise HTTPException(status_code=500, detail="Failed to update agent run status in database")

    # Send STOP signal to the global control channel
    global_control_channel = f"agent_run:{agent_run_id}:control"
    try:
        await redis.publish(global_control_channel, "STOP")
        logger.debug(f"Published STOP signal to global channel {global_control_channel}")
    except Exception as e:
        logger.error(f"Failed to publish STOP signal to global channel {global_control_channel}: {str(e)}")

    # Find all instances handling this agent run and send STOP to instance-specific channels
    try:
        instance_keys = await redis.keys(f"active_run:*:{agent_run_id}")
        logger.debug(f"Found {len(instance_keys)} active instance keys for agent run {agent_run_id}")

        for key in instance_keys:
            # Key format: active_run:{instance_id}:{agent_run_id}
            parts = key.split(":")
            if len(parts) == 3:
                instance_id_from_key = parts[1]
                instance_control_channel = f"agent_run:{agent_run_id}:control:{instance_id_from_key}"
                try:
                    await redis.publish(instance_control_channel, "STOP")
                    logger.debug(f"Published STOP signal to instance channel {instance_control_channel}")
                except Exception as e:
                    logger.warning(f"Failed to publish STOP signal to instance channel {instance_control_channel}: {str(e)}")
            else:
                 logger.warning(f"Unexpected key format found: {key}")

        # Clean up the response list immediately on stop/fail
        await _cleanup_redis_response_list(agent_run_id)

    except Exception as e:
        logger.error(f"Failed to find or signal active instances for {agent_run_id}: {str(e)}")

    logger.debug(f"Successfully initiated stop process for agent run: {agent_run_id}")

async def get_agent_run_with_access_check(client, agent_run_id: str, user_id: str):
    agent_run = await client.table('agent_runs').select('*, threads(account_id)').eq('id', agent_run_id).execute()
    if not agent_run.data:
        raise HTTPException(status_code=404, detail="Agent run not found")

    agent_run_data = agent_run.data[0]
    thread_id = agent_run_data['thread_id']
    account_id = agent_run_data['threads']['account_id']
    if account_id == user_id:
        return agent_run_data
    await verify_thread_access(client, thread_id, user_id)
    return agent_run_data


@router.post("/thread/{thread_id}/agent/start")
async def start_agent(
    thread_id: str,
    body: AgentStartRequest = Body(...),
    user_id: str = Depends(get_current_user_id_from_jwt)
):
    """Start an agent for a specific thread in the background"""
    structlog.contextvars.bind_contextvars(
        thread_id=thread_id,
    )
    global instance_id # Ensure instance_id is accessible
    if not instance_id:
        raise HTTPException(status_code=500, detail="Agent API not initialized with instance ID")

    # Use model from config if not specified in the request
    model_name = body.model_name
    logger.debug(f"Original model_name from request: {model_name}")

    # Log the model name after alias resolution using new model manager
    from models import model_manager
    resolved_model = model_manager.resolve_model_id(model_name)
    logger.debug(f"Resolved model name: {resolved_model}")

    # Update model_name to use the resolved version
    model_name = resolved_model

    logger.debug(f"Starting new agent for thread: {thread_id} with config: model={model_name}, thinking={body.enable_thinking}, effort={body.reasoning_effort}, stream={body.stream}, context_manager={body.enable_context_manager} (Instance: {instance_id})")
    client = await db.client


    thread_result = await client.table('threads').select('project_id', 'account_id', 'metadata').eq('thread_id', thread_id).execute()

    if not thread_result.data:
        raise HTTPException(status_code=404, detail="Thread not found")
    thread_data = thread_result.data[0]
    project_id = thread_data.get('project_id')
    account_id = thread_data.get('account_id')
    thread_metadata = thread_data.get('metadata', {})

    if account_id != user_id:
        await verify_thread_access(client, thread_id, user_id)

    structlog.contextvars.bind_contextvars(
        project_id=project_id,
        account_id=account_id,
        thread_metadata=thread_metadata,
    )
    
    # Load agent configuration with version support
    agent_config = None
    effective_agent_id = body.agent_id  # Optional agent ID from request
    
    logger.debug(f"[AGENT LOAD] Agent loading flow:")
    logger.debug(f"  - body.agent_id: {body.agent_id}")
    logger.debug(f"  - effective_agent_id: {effective_agent_id}")

    if effective_agent_id:
        logger.debug(f"[AGENT LOAD] Querying for agent: {effective_agent_id}")
        # Get agent
        agent_result = await client.table('agents').select('*').eq('agent_id', effective_agent_id).eq('account_id', account_id).execute()
        logger.debug(f"[AGENT LOAD] Query result: found {len(agent_result.data) if agent_result.data else 0} agents")
        
        if not agent_result.data:
            if body.agent_id:
                raise HTTPException(status_code=404, detail="Agent not found or access denied")
            else:
                logger.warning(f"Stored agent_id {effective_agent_id} not found, falling back to default")
                effective_agent_id = None
        else:
            agent_data = agent_result.data[0]
            version_data = None
            if agent_data.get('current_version_id'):
                try:
                    version_service = await _get_version_service()
                    version_obj = await version_service.get_version(
                        agent_id=effective_agent_id,
                        version_id=agent_data['current_version_id'],
                        user_id=user_id
                    )
                    version_data = version_obj.to_dict()
                    logger.debug(f"[AGENT LOAD] Got version data from version manager: {version_data.get('version_name')}")
                except Exception as e:
                    logger.warning(f"[AGENT LOAD] Failed to get version data: {e}")
            
            logger.debug(f"[AGENT LOAD] About to call extract_agent_config with agent_data keys: {list(agent_data.keys())}")
            logger.debug(f"[AGENT LOAD] version_data type: {type(version_data)}, has data: {version_data is not None}")
            
            agent_config = extract_agent_config(agent_data, version_data)
            
            if version_data:
                logger.debug(f"Using agent {agent_config['name']} ({effective_agent_id}) version {agent_config.get('version_name', 'v1')}")
            else:
                logger.debug(f"Using agent {agent_config['name']} ({effective_agent_id}) - no version data")
            source = "request" if body.agent_id else "fallback"
    else:
        logger.debug(f"[AGENT LOAD] No effective_agent_id, will try default agent")

    if not agent_config:
        logger.debug(f"[AGENT LOAD] No agent config yet, querying for default agent")
        default_agent_result = await client.table('agents').select('*').eq('account_id', account_id).eq('is_default', True).execute()
        logger.debug(f"[AGENT LOAD] Default agent query result: found {len(default_agent_result.data) if default_agent_result.data else 0} default agents")
        
        if default_agent_result.data:
            agent_data = default_agent_result.data[0]
            
            # Use versioning system to get current version
            version_data = None
            if agent_data.get('current_version_id'):
                try:
                    version_service = await _get_version_service()
                    version_obj = await version_service.get_version(
                        agent_id=agent_data['agent_id'],
                        version_id=agent_data['current_version_id'],
                        user_id=user_id
                    )
                    version_data = version_obj.to_dict()
                    logger.debug(f"[AGENT LOAD] Got default agent version from version manager: {version_data.get('version_name')}")
                except Exception as e:
                    logger.warning(f"[AGENT LOAD] Failed to get default agent version data: {e}")
            
            logger.debug(f"[AGENT LOAD] About to call extract_agent_config for DEFAULT agent with version data: {version_data is not None}")
            
            agent_config = extract_agent_config(agent_data, version_data)
            
            if version_data:
                logger.debug(f"Using default agent: {agent_config['name']} ({agent_config['agent_id']}) version {agent_config.get('version_name', 'v1')}")
            else:
                logger.debug(f"Using default agent: {agent_config['name']} ({agent_config['agent_id']}) - no version data")
        else:
            logger.warning(f"[AGENT LOAD] No default agent found for account {account_id}")

    logger.debug(f"[AGENT LOAD] Final agent_config: {agent_config is not None}")
    if agent_config:
        logger.debug(f"[AGENT LOAD] Agent config keys: {list(agent_config.keys())}")
        logger.debug(f"Using agent {agent_config['agent_id']} for this agent run (thread remains agent-agnostic)")

    # Run all checks concurrently
    model_check_task = asyncio.create_task(can_use_model(client, account_id, model_name))
    billing_check_task = asyncio.create_task(check_billing_status(client, account_id))
    limit_check_task = asyncio.create_task(check_agent_run_limit(client, account_id))

    # Wait for all checks to complete
    (can_use, model_message, allowed_models), (can_run, message, subscription), limit_check = await asyncio.gather(
        model_check_task, billing_check_task, limit_check_task
    )

    # Check results and raise appropriate errors
    if not can_use:
        raise HTTPException(status_code=403, detail={"message": model_message, "allowed_models": allowed_models})

    if not can_run:
        raise HTTPException(status_code=402, detail={"message": message, "subscription": subscription})

    if not limit_check['can_start']:
        error_detail = {
            "message": f"Maximum of {config.MAX_PARALLEL_AGENT_RUNS} parallel agent runs allowed within 24 hours. You currently have {limit_check['running_count']} running.",
            "running_thread_ids": limit_check['running_thread_ids'],
            "running_count": limit_check['running_count'],
            "limit": config.MAX_PARALLEL_AGENT_RUNS
        }
        logger.warning(f"Agent run limit exceeded for account {account_id}: {limit_check['running_count']} running agents")
        raise HTTPException(status_code=429, detail=error_detail)

    effective_model = model_name
    if not model_name and agent_config and agent_config.get('model'):
        effective_model = agent_config['model']
        logger.debug(f"No model specified by user, using agent's configured model: {effective_model}")
    elif model_name:
        logger.debug(f"Using user-selected model: {effective_model}")
    else:
        logger.debug(f"Using default model: {effective_model}")
    
    agent_run = await client.table('agent_runs').insert({
        "thread_id": thread_id,
        "status": "running",
        "started_at": datetime.now(timezone.utc).isoformat(),
        "agent_id": agent_config.get('agent_id') if agent_config else None,
        "agent_version_id": agent_config.get('current_version_id') if agent_config else None,
        "metadata": {
            "model_name": effective_model,
            "requested_model": model_name,
            "enable_thinking": body.enable_thinking,
            "reasoning_effort": body.reasoning_effort,
            "enable_context_manager": body.enable_context_manager
        }
    }).execute()

    agent_run_id = agent_run.data[0]['id']
    structlog.contextvars.bind_contextvars(
        agent_run_id=agent_run_id,
    )
    logger.debug(f"Created new agent run: {agent_run_id}")

    instance_key = f"active_run:{instance_id}:{agent_run_id}"
    try:
        await redis.set(instance_key, "running", ex=redis.REDIS_KEY_TTL)
    except Exception as e:
        logger.warning(f"Failed to register agent run in Redis ({instance_key}): {str(e)}")

    request_id = structlog.contextvars.get_contextvars().get('request_id')

    run_agent_background.send(
        agent_run_id=agent_run_id, thread_id=thread_id, instance_id=instance_id,
        project_id=project_id,
        model_name=model_name,  # Already resolved above
        enable_thinking=body.enable_thinking, reasoning_effort=body.reasoning_effort,
        stream=body.stream, enable_context_manager=body.enable_context_manager,
        agent_config=agent_config,  # Pass agent configuration
        request_id=request_id,
    )

    return {"agent_run_id": agent_run_id, "status": "running"}

@router.post("/agent-run/{agent_run_id}/stop")
async def stop_agent(agent_run_id: str, user_id: str = Depends(get_current_user_id_from_jwt)):
    """Stop a running agent."""
    structlog.contextvars.bind_contextvars(
        agent_run_id=agent_run_id,
    )
    logger.debug(f"Received request to stop agent run: {agent_run_id}")
    client = await db.client
    await get_agent_run_with_access_check(client, agent_run_id, user_id)
    await stop_agent_run(agent_run_id)
    return {"status": "stopped"}

@router.get("/thread/{thread_id}/agent-runs")
async def get_agent_runs(thread_id: str, user_id: str = Depends(get_current_user_id_from_jwt)):
    """Get all agent runs for a thread."""
    structlog.contextvars.bind_contextvars(
        thread_id=thread_id,
    )
    logger.debug(f"Fetching agent runs for thread: {thread_id}")
    client = await db.client
    await verify_thread_access(client, thread_id, user_id)
    agent_runs = await client.table('agent_runs').select('id, thread_id, status, started_at, completed_at, error, created_at, updated_at').eq("thread_id", thread_id).order('created_at', desc=True).execute()
    logger.debug(f"Found {len(agent_runs.data)} agent runs for thread: {thread_id}")
    return {"agent_runs": agent_runs.data}

@router.get("/agent-run/{agent_run_id}")
async def get_agent_run(agent_run_id: str, user_id: str = Depends(get_current_user_id_from_jwt)):
    """Get agent run status and responses."""
    structlog.contextvars.bind_contextvars(
        agent_run_id=agent_run_id,
    )
    logger.debug(f"Fetching agent run details: {agent_run_id}")
    client = await db.client
    agent_run_data = await get_agent_run_with_access_check(client, agent_run_id, user_id)
    # Note: Responses are not included here by default, they are in the stream or DB
    return {
        "id": agent_run_data['id'],
        "threadId": agent_run_data['thread_id'],
        "status": agent_run_data['status'],
        "startedAt": agent_run_data['started_at'],
        "completedAt": agent_run_data['completed_at'],
        "error": agent_run_data['error']
    }

@router.get("/thread/{thread_id}/agent", response_model=ThreadAgentResponse)
async def get_thread_agent(thread_id: str, user_id: str = Depends(get_current_user_id_from_jwt)):
    """Get the agent details for a specific thread. Since threads are fully agent-agnostic, 
    this returns the most recently used agent from agent_runs only."""
    structlog.contextvars.bind_contextvars(
        thread_id=thread_id,
    )
    logger.debug(f"Fetching agent details for thread: {thread_id}")
    client = await db.client
    
    try:
        # Verify thread access and get thread data
        await verify_thread_access(client, thread_id, user_id)
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
        
        from agent.config_helper import extract_agent_config
        agent_config = extract_agent_config(agent_data, version_data)
        
        system_prompt = agent_config['system_prompt']
        configured_mcps = agent_config['configured_mcps']
        custom_mcps = agent_config['custom_mcps']
        agentpress_tools = agent_config['agentpress_tools']
        
        return {
            "agent": AgentResponse(
                agent_id=agent_data['agent_id'],
                name=agent_data['name'],
                description=agent_data.get('description'),
                system_prompt=system_prompt,
                configured_mcps=configured_mcps,
                custom_mcps=custom_mcps,
                agentpress_tools=agentpress_tools,
                is_default=agent_data.get('is_default', False),
                is_public=agent_data.get('is_public', False),
                tags=agent_data.get('tags', []),
                avatar=agent_config.get('avatar'),
                avatar_color=agent_config.get('avatar_color'),
                profile_image_url=agent_config.get('profile_image_url'),
                created_at=agent_data['created_at'],
                updated_at=agent_data.get('updated_at', agent_data['created_at']),
                current_version_id=agent_data.get('current_version_id'),
                version_count=agent_data.get('version_count', 1),
                current_version=current_version,
                metadata=agent_data.get('metadata')
            ),
            "source": agent_source,
            "message": f"Using {agent_source} agent: {agent_data['name']}. Threads are agent-agnostic - you can change agents anytime."
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching agent for thread {thread_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to fetch thread agent: {str(e)}")

@router.get("/agent-run/{agent_run_id}/stream")
async def stream_agent_run(
    agent_run_id: str,
    token: Optional[str] = None,
    request: Request = None
):
    """Stream the responses of an agent run using Redis Lists and Pub/Sub."""
    logger.debug(f"Starting stream for agent run: {agent_run_id}")
    client = await db.client

    user_id = await get_user_id_from_stream_auth(request, token) # practically instant
    agent_run_data = await get_agent_run_with_access_check(client, agent_run_id, user_id) # 1 db query

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
        pubsub_response = None
        pubsub_control = None
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

            # 3. Set up Pub/Sub listeners for new responses and control signals concurrently
            pubsub_response_task = asyncio.create_task(redis.create_pubsub())
            pubsub_control_task = asyncio.create_task(redis.create_pubsub())
            
            pubsub_response, pubsub_control = await asyncio.gather(pubsub_response_task, pubsub_control_task)
            
            # Subscribe to channels concurrently
            response_subscribe_task = asyncio.create_task(pubsub_response.subscribe(response_channel))
            control_subscribe_task = asyncio.create_task(pubsub_control.subscribe(control_channel))
            
            await asyncio.gather(response_subscribe_task, control_subscribe_task)
            
            logger.debug(f"Subscribed to response channel: {response_channel}")
            logger.debug(f"Subscribed to control channel: {control_channel}")

            # Queue to communicate between listeners and the main generator loop
            message_queue = asyncio.Queue()

            async def listen_messages():
                response_reader = pubsub_response.listen()
                control_reader = pubsub_control.listen()
                tasks = [asyncio.create_task(response_reader.__anext__()), asyncio.create_task(control_reader.__anext__())]

                while not terminate_stream:
                    done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                    for task in done:
                        try:
                            message = task.result()
                            if message and isinstance(message, dict) and message.get("type") == "message":
                                channel = message.get("channel")
                                data = message.get("data")
                                if isinstance(data, bytes): data = data.decode('utf-8')

                                if channel == response_channel and data == "new":
                                    await message_queue.put({"type": "new_response"})
                                elif channel == control_channel and data in ["STOP", "END_STREAM", "ERROR"]:
                                    logger.debug(f"Received control signal '{data}' for {agent_run_id}")
                                    await message_queue.put({"type": "control", "data": data})
                                    return # Stop listening on control signal

                        except StopAsyncIteration:
                            logger.warning(f"Listener {task} stopped.")
                            # Decide how to handle listener stopping, maybe terminate?
                            await message_queue.put({"type": "error", "data": "Listener stopped unexpectedly"})
                            return
                        except Exception as e:
                            logger.error(f"Error in listener for {agent_run_id}: {e}")
                            await message_queue.put({"type": "error", "data": "Listener failed"})
                            return
                        finally:
                            # Reschedule the completed listener task
                            if task in tasks:
                                tasks.remove(task)
                                if message and isinstance(message, dict) and message.get("channel") == response_channel:
                                     tasks.append(asyncio.create_task(response_reader.__anext__()))
                                elif message and isinstance(message, dict) and message.get("channel") == control_channel:
                                     tasks.append(asyncio.create_task(control_reader.__anext__()))

                # Cancel pending listener tasks on exit
                for p_task in pending: p_task.cancel()
                for task in tasks: task.cancel()


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
            # Enhanced graceful shutdown with proper error handling
            cleanup_tasks = []
            
            # Unsubscribe operations
            if pubsub_response:
                try:
                    cleanup_tasks.append(asyncio.create_task(pubsub_response.unsubscribe(response_channel)))
                except Exception as e:
                    logger.warning(f"Error unsubscribing from response channel: {e}")
            
            if pubsub_control:
                try:
                    cleanup_tasks.append(asyncio.create_task(pubsub_control.unsubscribe(control_channel)))
                except Exception as e:
                    logger.warning(f"Error unsubscribing from control channel: {e}")
            
            # Wait for unsubscribe operations to complete
            if cleanup_tasks:
                try:
                    await asyncio.wait_for(asyncio.gather(*cleanup_tasks, return_exceptions=True), timeout=5.0)
                except asyncio.TimeoutError:
                    logger.warning("Pubsub unsubscribe operations timed out")
                except Exception as e:
                    logger.warning(f"Error during unsubscribe operations: {e}")
            
            # Close pubsub connections
            if pubsub_response:
                try:
                    await asyncio.wait_for(pubsub_response.close(), timeout=5.0)
                except Exception as e:
                    logger.warning(f"Error closing response pubsub: {e}")
            
            if pubsub_control:
                try:
                    await asyncio.wait_for(pubsub_control.close(), timeout=5.0)
                except Exception as e:
                    logger.warning(f"Error closing control pubsub: {e}")

            # Cancel and cleanup listener task
            if listener_task:
                listener_task.cancel()
                try:
                    await asyncio.wait_for(listener_task, timeout=3.0)
                except asyncio.CancelledError:
                    pass
                except asyncio.TimeoutError:
                    logger.warning("Listener task cancellation timed out")
                except Exception as e:
                    logger.debug(f"listener_task ended with: {e}")
            
            # Brief wait for cleanup to complete
            await asyncio.sleep(0.1)
            logger.debug(f"Streaming cleanup complete for agent run: {agent_run_id}")

    return StreamingResponse(stream_generator(agent_run_data), media_type="text/event-stream", headers={
        "Cache-Control": "no-cache, no-transform", "Connection": "keep-alive",
        "X-Accel-Buffering": "no", "Content-Type": "text/event-stream",
        "Access-Control-Allow-Origin": "*"
    })

async def generate_and_update_project_name(project_id: str, prompt: str):
    """Generates a project name using an LLM and updates the database."""
    logger.debug(f"Starting background task to generate name for project: {project_id}")
    try:
        db_conn = DBConnection()
        client = await db_conn.client

        model_name = "openai/gpt-4o-mini"
        system_prompt = "You are a helpful assistant that generates extremely concise titles (2-4 words maximum) for chat threads based on the user's message. Respond with only the title, no other text or punctuation."
        user_message = f"Generate an extremely brief title (2-4 words only) for a chat thread that starts with this message: \"{prompt}\""
        messages = [{"role": "system", "content": system_prompt}, {"role": "user", "content": user_message}]

        logger.debug(f"Calling LLM ({model_name}) for project {project_id} naming.")
        response = await make_llm_api_call(messages=messages, model_name=model_name, max_tokens=20, temperature=0.7)

        generated_name = None
        if response and response.get('choices') and response['choices'][0].get('message'):
            raw_name = response['choices'][0]['message'].get('content', '').strip()
            cleaned_name = raw_name.strip('\'" \n\t')
            if cleaned_name:
                generated_name = cleaned_name
                logger.debug(f"LLM generated name for project {project_id}: '{generated_name}'")
            else:
                logger.warning(f"LLM returned an empty name for project {project_id}.")
        else:
            logger.warning(f"Failed to get valid response from LLM for project {project_id} naming. Response: {response}")

        if generated_name:
            update_result = await client.table('projects').update({"name": generated_name}).eq("project_id", project_id).execute()
            if hasattr(update_result, 'data') and update_result.data:
                logger.debug(f"Successfully updated project {project_id} name to '{generated_name}'")
            else:
                logger.error(f"Failed to update project {project_id} name in database. Update result: {update_result}")
        else:
            logger.warning(f"No generated name, skipping database update for project {project_id}.")

    except Exception as e:
        logger.error(f"Error in background naming task for project {project_id}: {str(e)}\n{traceback.format_exc()}")
    finally:
        # No need to disconnect DBConnection singleton instance here
        logger.debug(f"Finished background naming task for project: {project_id}")

@router.post("/agent/initiate", response_model=InitiateAgentResponse)
async def initiate_agent_with_files(
    prompt: str = Form(...),
    model_name: Optional[str] = Form(None),  # Default to None to use default model
    enable_thinking: Optional[bool] = Form(False),
    reasoning_effort: Optional[str] = Form("low"),
    stream: Optional[bool] = Form(True),
    enable_context_manager: Optional[bool] = Form(False),
    agent_id: Optional[str] = Form(None),  # Add agent_id parameter
    files: List[UploadFile] = File(default=[]),
    user_id: str = Depends(get_current_user_id_from_jwt)
):
    """
    Initiate a new agent session with optional file attachments.

    [WARNING] Keep in sync with create thread endpoint.
    """
    global instance_id # Ensure instance_id is accessible
    if not instance_id:
        raise HTTPException(status_code=500, detail="Agent API not initialized with instance ID")

    # Use model from config if not specified in the request
    logger.debug(f"Original model_name from request: {model_name}")

    if model_name is None:
        model_name = "openai/gpt-5-mini"
        logger.debug(f"Using default model: {model_name}")

    from models import model_manager
    # Log the model name after alias resolution using new model manager
    resolved_model = model_manager.resolve_model_id(model_name)
    logger.debug(f"Resolved model name: {resolved_model}")

    # Update model_name to use the resolved version
    model_name = resolved_model

    logger.debug(f"[\033[91mDEBUG\033[0m] Initiating new agent with prompt and {len(files)} files (Instance: {instance_id}), model: {model_name}, enable_thinking: {enable_thinking}")
    client = await db.client
    account_id = user_id # In Basejump, personal account_id is the same as user_id
    
    # Load agent configuration with version support (same as start_agent endpoint)
    agent_config = None
    
    logger.debug(f"[AGENT INITIATE] Agent loading flow:")
    logger.debug(f"  - agent_id param: {agent_id}")
    
    if agent_id:
        logger.debug(f"[AGENT INITIATE] Querying for specific agent: {agent_id}")
        # Get agent
        agent_result = await client.table('agents').select('*').eq('agent_id', agent_id).eq('account_id', account_id).execute()
        logger.debug(f"[AGENT INITIATE] Query result: found {len(agent_result.data) if agent_result.data else 0} agents")
        
        if not agent_result.data:
            raise HTTPException(status_code=404, detail="Agent not found or access denied")
        
        agent_data = agent_result.data[0]
        
        # Use versioning system to get current version
        version_data = None
        if agent_data.get('current_version_id'):
            try:
                version_service = await _get_version_service()
                version_obj = await version_service.get_version(
                    agent_id=agent_id,
                    version_id=agent_data['current_version_id'],
                    user_id=user_id
                )
                version_data = version_obj.to_dict()
                logger.debug(f"[AGENT INITIATE] Got version data from version manager: {version_data.get('version_name')}")
                logger.debug(f"[AGENT INITIATE] Version data: {version_data}")
            except Exception as e:
                logger.warning(f"[AGENT INITIATE] Failed to get version data: {e}")
        
        logger.debug(f"[AGENT INITIATE] About to call extract_agent_config with version data: {version_data is not None}")
        
        agent_config = extract_agent_config(agent_data, version_data)
        
        if version_data:
            logger.debug(f"Using custom agent: {agent_config['name']} ({agent_id}) version {agent_config.get('version_name', 'v1')}")
        else:
            logger.debug(f"Using custom agent: {agent_config['name']} ({agent_id}) - no version data")
    else:
        logger.debug(f"[AGENT INITIATE] No agent_id provided, querying for default agent")
        # Try to get default agent for the account
        default_agent_result = await client.table('agents').select('*').eq('account_id', account_id).eq('is_default', True).execute()
        logger.debug(f"[AGENT INITIATE] Default agent query result: found {len(default_agent_result.data) if default_agent_result.data else 0} default agents")
        
        if default_agent_result.data:
            agent_data = default_agent_result.data[0]
            
            # Use versioning system to get current version
            version_data = None
            if agent_data.get('current_version_id'):
                try:
                    version_service = await _get_version_service()
                    version_obj = await version_service.get_version(
                        agent_id=agent_data['agent_id'],
                        version_id=agent_data['current_version_id'],
                        user_id=user_id
                    )
                    version_data = version_obj.to_dict()
                    logger.debug(f"[AGENT INITIATE] Got default agent version from version manager: {version_data.get('version_name')}")
                except Exception as e:
                    logger.warning(f"[AGENT INITIATE] Failed to get default agent version data: {e}")
            
            logger.debug(f"[AGENT INITIATE] About to call extract_agent_config for DEFAULT agent with version data: {version_data is not None}")
            
            agent_config = extract_agent_config(agent_data, version_data)
            
            if version_data:
                logger.debug(f"Using default agent: {agent_config['name']} ({agent_config['agent_id']}) version {agent_config.get('version_name', 'v1')}")
            else:
                logger.debug(f"Using default agent: {agent_config['name']} ({agent_config['agent_id']}) - no version data")
        else:
            logger.warning(f"[AGENT INITIATE] No default agent found for account {account_id}")
    
    logger.debug(f"[AGENT INITIATE] Final agent_config: {agent_config is not None}")
    if agent_config:
        logger.debug(f"[AGENT INITIATE] Agent config keys: {list(agent_config.keys())}")

    # Run all checks concurrently
    model_check_task = asyncio.create_task(can_use_model(client, account_id, model_name))
    billing_check_task = asyncio.create_task(check_billing_status(client, account_id))
    limit_check_task = asyncio.create_task(check_agent_run_limit(client, account_id))

    # Wait for all checks to complete
    (can_use, model_message, allowed_models), (can_run, message, subscription), limit_check = await asyncio.gather(
        model_check_task, billing_check_task, limit_check_task
    )

    # Check results and raise appropriate errors
    if not can_use:
        raise HTTPException(status_code=403, detail={"message": model_message, "allowed_models": allowed_models})

    can_run, message, subscription = await check_billing_status(client, account_id)
    if not can_run:
        raise HTTPException(status_code=402, detail={"message": message, "subscription": subscription})

    # Check agent run limit (maximum parallel runs in past 24 hours)
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

    try:
        # 1. Create Project
        placeholder_name = f"{prompt[:30]}..." if len(prompt) > 30 else prompt
        project = await client.table('projects').insert({
            "project_id": str(uuid.uuid4()), "account_id": account_id, "name": placeholder_name,
            "created_at": datetime.now(timezone.utc).isoformat()
        }).execute()
        project_id = project.data[0]['project_id']
        logger.info(f"Created new project: {project_id}")

        # 2. Create Sandbox (lazy): only create now if files were uploaded and need the
        # sandbox immediately. Otherwise leave sandbox creation to `_ensure_sandbox()`
        # which will create it lazily when tools require it.
        sandbox_id = None
        sandbox = None
        sandbox_pass = None
        vnc_url = None
        website_url = None
        token = None

        if files:
            # 3. Create Sandbox (lazy): only create now if files were uploaded and need the
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
                        'id': sandbox_id, 'pass': sandbox_pass, 'vnc_preview': vnc_url,
                        'sandbox_url': website_url, 'token': token
                    }
                }).eq('project_id', project_id).execute()

                if not update_result.data:
                    logger.error(f"Failed to update project {project_id} with new sandbox {sandbox_id}")
                    if sandbox_id:
                        try: await delete_sandbox(sandbox_id)
                        except Exception as e: logger.error(f"Error deleting sandbox: {str(e)}")
                    raise Exception("Database update failed")
            except Exception as e:
                logger.error(f"Error creating sandbox: {str(e)}")
                await client.table('projects').delete().eq('project_id', project_id).execute()
                if sandbox_id:
                    try: await delete_sandbox(sandbox_id)
                    except Exception:
                        pass
                raise Exception("Failed to create sandbox")

        # 3. Create Thread
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
        
        # Don't store agent_id in thread since threads are now agent-agnostic
        # The agent selection will be handled per message/agent run
        if agent_config:
            logger.debug(f"Using agent {agent_config['agent_id']} for this conversation (thread remains agent-agnostic)")
            structlog.contextvars.bind_contextvars(
                agent_id=agent_config['agent_id'],
            )
        
        thread = await client.table('threads').insert(thread_data).execute()
        thread_id = thread.data[0]['thread_id']
        logger.debug(f"Created new thread: {thread_id}")

        # Trigger Background Naming Task
        asyncio.create_task(generate_and_update_project_name(project_id=project_id, prompt=prompt))

        # 4. Upload Files to Sandbox (if any)
        message_content = prompt
        if files:
            successful_uploads = []
            failed_uploads = []
            for file in files:
                if file.filename:
                    try:
                        safe_filename = file.filename.replace('/', '_').replace('\\', '_')
                        target_path = f"/workspace/{safe_filename}"
                        logger.debug(f"Attempting to upload {safe_filename} to {target_path} in sandbox {sandbox_id}")
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
                                parent_dir = os.path.dirname(target_path)
                                files_in_dir = await sandbox.fs.list_files(parent_dir)
                                file_names_in_dir = [f.name for f in files_in_dir]
                                if safe_filename in file_names_in_dir:
                                    successful_uploads.append(target_path)
                                    logger.debug(f"Successfully uploaded and verified file {safe_filename} to sandbox path {target_path}")
                                else:
                                    logger.error(f"Verification failed for {safe_filename}: File not found in {parent_dir} after upload attempt.")
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
                for file_path in successful_uploads: message_content += f"[Uploaded File: {file_path}]\n"
            if failed_uploads:
                message_content += "\n\nThe following files failed to upload:\n"
                for failed_file in failed_uploads: message_content += f"- {failed_file}\n"

        # 5. Add initial user message to thread
        message_id = str(uuid.uuid4())
        message_payload = {"role": "user", "content": message_content}
        await client.table('messages').insert({
            "message_id": message_id, "thread_id": thread_id, "type": "user",
            "is_llm_message": True, "content": json.dumps(message_payload),
            "created_at": datetime.now(timezone.utc).isoformat()
        }).execute()


        effective_model = model_name
        if not model_name and agent_config and agent_config.get('model'):
            effective_model = agent_config['model']
            logger.debug(f"No model specified by user, using agent's configured model: {effective_model}")
        elif model_name:
            logger.debug(f"Using user-selected model: {effective_model}")
        else:
            logger.debug(f"Using default model: {effective_model}")

        agent_run = await client.table('agent_runs').insert({
            "thread_id": thread_id, "status": "running",
            "started_at": datetime.now(timezone.utc).isoformat(),
            "agent_id": agent_config.get('agent_id') if agent_config else None,
            "agent_version_id": agent_config.get('current_version_id') if agent_config else None,
            "metadata": {
                "model_name": effective_model,
                "requested_model": model_name,
                "enable_thinking": enable_thinking,
                "reasoning_effort": reasoning_effort,
                "enable_context_manager": enable_context_manager
            }
        }).execute()
        agent_run_id = agent_run.data[0]['id']
        logger.debug(f"Created new agent run: {agent_run_id}")
        structlog.contextvars.bind_contextvars(
            agent_run_id=agent_run_id,
        )

        # Register run in Redis
        instance_key = f"active_run:{instance_id}:{agent_run_id}"
        try:
            await redis.set(instance_key, "running", ex=redis.REDIS_KEY_TTL)
        except Exception as e:
            logger.warning(f"Failed to register agent run in Redis ({instance_key}): {str(e)}")

        request_id = structlog.contextvars.get_contextvars().get('request_id')

        # Run agent in background
        run_agent_background.send(
            agent_run_id=agent_run_id, thread_id=thread_id, instance_id=instance_id,
            project_id=project_id,
            model_name=model_name,  # Already resolved above
            enable_thinking=enable_thinking, reasoning_effort=reasoning_effort,
            stream=stream, enable_context_manager=enable_context_manager,
            agent_config=agent_config,  # Pass agent configuration
            request_id=request_id,
        )

        return {"thread_id": thread_id, "agent_run_id": agent_run_id}

    except Exception as e:
        logger.error(f"Error in agent initiation: {str(e)}\n{traceback.format_exc()}")
        # TODO: Clean up created project/thread if initiation fails mid-way
        raise HTTPException(status_code=500, detail=f"Failed to initiate agent session: {str(e)}")

# Custom agents

@router.get("/agents", response_model=AgentsResponse)
async def get_agents(
    user_id: str = Depends(get_current_user_id_from_jwt),
    page: Optional[int] = Query(1, ge=1, description="Page number (1-based)"),
    limit: Optional[int] = Query(20, ge=1, le=100, description="Number of items per page"),
    search: Optional[str] = Query(None, description="Search in name and description"),
    sort_by: Optional[str] = Query("created_at", description="Sort field: name, created_at, updated_at, tools_count"),
    sort_order: Optional[str] = Query("desc", description="Sort order: asc, desc"),
    has_default: Optional[bool] = Query(None, description="Filter by default agents"),
    has_mcp_tools: Optional[bool] = Query(None, description="Filter by agents with MCP tools"),
    has_agentpress_tools: Optional[bool] = Query(None, description="Filter by agents with AgentPress tools"),
    tools: Optional[str] = Query(None, description="Comma-separated list of tools to filter by"),
    content_type: Optional[str] = Query(None, description="Content type filter: 'agents', 'templates', or None for agents only")
):
    if not await is_enabled("custom_agents"):
        raise HTTPException(
            status_code=403, 
            detail="Custom agents currently disabled. This feature is not available at the moment."
        )
    try:
        from agent.services.agent_service import AgentService, AgentFilters
        
        tools_list = []
        if tools:
            if isinstance(tools, str):
                tools_list = [tool.strip() for tool in tools.split(',') if tool.strip()]
            else:
                logger.warning(f"Unexpected tools parameter type: {type(tools)}")
        
        pagination_params = PaginationParams(
            page=page,
            page_size=limit
        )
        
        filters = AgentFilters(
            search=search,
            has_default=has_default,
            has_mcp_tools=has_mcp_tools,
            has_agentpress_tools=has_agentpress_tools,
            tools=tools_list,
            content_type=content_type,
            sort_by=sort_by,
            sort_order=sort_order
        )
        
        client = await db.client
        agent_service = AgentService(client)
        paginated_result = await agent_service.get_agents_paginated(
            user_id=user_id,
            pagination_params=pagination_params,
            filters=filters
        )
        
        agent_responses = []
        for agent_data in paginated_result.data:
            agent_response = AgentResponse(**agent_data)
            agent_responses.append(agent_response)
        
        return AgentsResponse(
            agents=agent_responses,
            pagination=PaginationInfo(
                current_page=paginated_result.pagination.current_page,
                page_size=paginated_result.pagination.page_size,
                total_items=paginated_result.pagination.total_items,
                total_pages=paginated_result.pagination.total_pages,
                has_next=paginated_result.pagination.has_next,
                has_previous=paginated_result.pagination.has_previous
            )
        )
        
    except Exception as e:
        logger.error(f"Error fetching agents for user {user_id}: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to fetch agents: {str(e)}")

@router.get("/agents/{agent_id}", response_model=AgentResponse)
async def get_agent(agent_id: str, user_id: str = Depends(get_current_user_id_from_jwt)):
    if not await is_enabled("custom_agents"):
        raise HTTPException(
            status_code=403, 
            detail="Custom agents currently disabled. This feature is not available at the moment."
        )
    
    logger.debug(f"Fetching agent {agent_id} for user: {user_id}")
    
    client = await db.client
    
    try:
        agent = await client.table('agents').select('*').eq("agent_id", agent_id).execute()
        
        if not agent.data:
            raise HTTPException(status_code=404, detail="Agent not found")
        
        agent_data = agent.data[0]
        
        if config.ENV_MODE == EnvMode.STAGING:
            print(f"[DEBUG] get_agent: Fetched agent from DB - icon_name={agent_data.get('icon_name')}, icon_color={agent_data.get('icon_color')}, icon_background={agent_data.get('icon_background')}")
            print(f"[DEBUG] get_agent: Also has - profile_image_url={agent_data.get('profile_image_url')}, avatar={agent_data.get('avatar')}, avatar_color={agent_data.get('avatar_color')}")
        
        if agent_data['account_id'] != user_id and not agent_data.get('is_public', False):
            logger.warning(f"Access denied for agent {agent_id}: user={user_id}, agent_account={agent_data['account_id']}, is_public={agent_data.get('is_public', False)}")
            raise HTTPException(status_code=403, detail="Access denied")
        
        current_version = None
        if agent_data.get('current_version_id'):
            try:
                version_service = await _get_version_service()
                current_version_obj = await version_service.get_version(
                    agent_id=agent_id,
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
                logger.warning(f"Failed to get version data for agent {agent_id}: {e}")
        
        # Extract configuration using the unified config approach
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
        
        from agent.config_helper import extract_agent_config
        
        # Debug logging before extract_agent_config
        if config.ENV_MODE == EnvMode.STAGING:
            print(f"[DEBUG] get_agent: Before extract_agent_config - agent_data has icon_name={agent_data.get('icon_name')}, icon_color={agent_data.get('icon_color')}, icon_background={agent_data.get('icon_background')}")
        
        agent_config = extract_agent_config(agent_data, version_data)
        
        # Debug logging after extract_agent_config
        if config.ENV_MODE == EnvMode.STAGING:
            print(f"[DEBUG] get_agent: After extract_agent_config - agent_config has icon_name={agent_config.get('icon_name')}, icon_color={agent_config.get('icon_color')}, icon_background={agent_config.get('icon_background')}")
            print(f"[DEBUG] get_agent: Final response will use icon fields from agent_config")
        
        system_prompt = agent_config['system_prompt']
        configured_mcps = agent_config['configured_mcps']
        custom_mcps = agent_config['custom_mcps']
        agentpress_tools = agent_config['agentpress_tools']
        
        response = AgentResponse(
            agent_id=agent_data['agent_id'],
            name=agent_data['name'],
            description=agent_data.get('description'),
            system_prompt=system_prompt,
            configured_mcps=configured_mcps,
            custom_mcps=custom_mcps,
            agentpress_tools=agentpress_tools,
            is_default=agent_data.get('is_default', False),
            is_public=agent_data.get('is_public', False),
            tags=agent_data.get('tags', []),
            avatar=agent_config.get('avatar'),
            avatar_color=agent_config.get('avatar_color'),
            profile_image_url=agent_config.get('profile_image_url'),
            icon_name=agent_config.get('icon_name'),
            icon_color=agent_config.get('icon_color'),
            icon_background=agent_config.get('icon_background'),
            created_at=agent_data['created_at'],
            updated_at=agent_data.get('updated_at', agent_data['created_at']),
            current_version_id=agent_data.get('current_version_id'),
            version_count=agent_data.get('version_count', 1),
            current_version=current_version,
            metadata=agent_data.get('metadata')
        )
        
        return response
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching agent {agent_id} for user {user_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to fetch agent: {str(e)}")

@router.get("/agents/{agent_id}/export")
async def export_agent(agent_id: str, user_id: str = Depends(get_current_user_id_from_jwt)):
    """Export an agent configuration as JSON"""
    logger.debug(f"Exporting agent {agent_id} for user: {user_id}")
    
    try:
        client = await db.client
        
        # Get agent data
        agent_result = await client.table('agents').select('*').eq('agent_id', agent_id).eq('account_id', user_id).execute()
        if not agent_result.data:
            raise HTTPException(status_code=404, detail="Agent not found")
        
        agent = agent_result.data[0]
        
        # Get current version data if available
        current_version = None
        if agent.get('current_version_id'):
            version_result = await client.table('agent_versions').select('*').eq('version_id', agent['current_version_id']).execute()
            if version_result.data:
                current_version = version_result.data[0]

        from agent.config_helper import extract_agent_config
        config = extract_agent_config(agent, current_version)
        
        from templates.template_service import TemplateService
        template_service = TemplateService(db)
        
        full_config = {
            'system_prompt': config.get('system_prompt', ''),
            'tools': {
                'agentpress': config.get('agentpress_tools', {}),
                'mcp': config.get('configured_mcps', []),
                'custom_mcp': config.get('custom_mcps', [])
            },
            'metadata': {
                # keep backward compat metadata
                'avatar': config.get('avatar'),
                'avatar_color': config.get('avatar_color'),
                # include profile image url in metadata for completeness
                'profile_image_url': agent.get('profile_image_url')
            }
        }
        
        sanitized_config = template_service._fallback_sanitize_config(full_config)
        
        export_metadata = {}
        if agent.get('metadata'):
            export_metadata = {k: v for k, v in agent['metadata'].items() 
                             if k not in ['is_suna_default', 'is_omni_default', 'centrally_managed', 'installation_date', 'last_central_update']}
        
        export_data = {
            "tools": sanitized_config['tools'],
            "metadata": sanitized_config['metadata'],
            "system_prompt": sanitized_config['system_prompt'],
            "name": config.get('name', ''),
            "description": config.get('description', ''),
            # Deprecated
            "avatar": config.get('avatar'),
            "avatar_color": config.get('avatar_color'),
            # New
            "profile_image_url": agent.get('profile_image_url'),
            "tags": agent.get('tags', []),
            "export_metadata": export_metadata,
            "exported_at": datetime.now(timezone.utc).isoformat()
        }
        
        logger.debug(f"Successfully exported agent {agent_id}")
        return export_data
        
    except Exception as e:
        logger.error(f"Error exporting agent {agent_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to export agent: {str(e)}")

# JSON Import endpoints - similar to template installation flow

class JsonAnalysisRequest(BaseModel):
    """Request to analyze JSON for import requirements"""
    json_data: Dict[str, Any]

class JsonAnalysisResponse(BaseModel):
    """Response from JSON analysis"""
    requires_setup: bool
    missing_regular_credentials: List[Dict[str, Any]] = []
    missing_custom_configs: List[Dict[str, Any]] = []
    agent_info: Dict[str, Any] = {}

class JsonImportRequestModel(BaseModel):
    """Request to import agent from JSON"""
    json_data: Dict[str, Any]
    instance_name: Optional[str] = None
    custom_system_prompt: Optional[str] = None
    profile_mappings: Optional[Dict[str, str]] = None
    custom_mcp_configs: Optional[Dict[str, Dict[str, Any]]] = None

class JsonImportResponse(BaseModel):
    """Response from JSON import"""
    status: str
    instance_id: Optional[str] = None
    name: Optional[str] = None
    missing_regular_credentials: List[Dict[str, Any]] = []
    missing_custom_configs: List[Dict[str, Any]] = []
    agent_info: Dict[str, Any] = {}

@router.post("/agents/json/analyze", response_model=JsonAnalysisResponse)
async def analyze_json_for_import(
    request: JsonAnalysisRequest,
    user_id: str = Depends(get_current_user_id_from_jwt)
):
    """Analyze imported JSON to determine required credentials and configurations"""
    logger.debug(f"Analyzing JSON for import - user: {user_id}")
    
    if not await is_enabled("custom_agents"):
        raise HTTPException(
            status_code=403, 
            detail="Custom agents currently disabled. This feature is not available at the moment."
        )
    
    try:
        from agent.json_import_service import JsonImportService
        import_service = JsonImportService(db)
        
        analysis = await import_service.analyze_json(request.json_data, user_id)
        
        return JsonAnalysisResponse(
            requires_setup=analysis.requires_setup,
            missing_regular_credentials=analysis.missing_regular_credentials,
            missing_custom_configs=analysis.missing_custom_configs,
            agent_info=analysis.agent_info
        )
        
    except Exception as e:
        logger.error(f"Error analyzing JSON: {str(e)}")
        raise HTTPException(status_code=400, detail=f"Failed to analyze JSON: {str(e)}")

@router.post("/agents/json/import", response_model=JsonImportResponse)
async def import_agent_from_json(
    request: JsonImportRequestModel,
    user_id: str = Depends(get_current_user_id_from_jwt)
):
    logger.debug(f"Importing agent from JSON - user: {user_id}")
    
    if not await is_enabled("custom_agents"):
        raise HTTPException(
            status_code=403, 
            detail="Custom agents currently disabled. This feature is not available at the moment."
        )
    
    client = await db.client
    from .utils import check_agent_count_limit
    limit_check = await check_agent_count_limit(client, user_id)
    
    if not limit_check['can_create']:
        error_detail = {
            "message": f"Maximum of {limit_check['limit']} agents allowed for your current plan. You have {limit_check['current_count']} agents.",
            "current_count": limit_check['current_count'],
            "limit": limit_check['limit'],
            "tier_name": limit_check['tier_name'],
            "error_code": "AGENT_LIMIT_EXCEEDED"
        }
        logger.warning(f"Agent limit exceeded for account {user_id}: {limit_check['current_count']}/{limit_check['limit']} agents")
        raise HTTPException(status_code=402, detail=error_detail)
    
    try:
        from agent.json_import_service import JsonImportService, JsonImportRequest
        import_service = JsonImportService(db)
        
        import_request = JsonImportRequest(
            json_data=request.json_data,
            account_id=user_id,
            instance_name=request.instance_name,
            custom_system_prompt=request.custom_system_prompt,
            profile_mappings=request.profile_mappings,
            custom_mcp_configs=request.custom_mcp_configs
        )
        
        result = await import_service.import_json(import_request)
        
        return JsonImportResponse(
            status=result.status,
            instance_id=result.instance_id,
            name=result.name,
            missing_regular_credentials=result.missing_regular_credentials,
            missing_custom_configs=result.missing_custom_configs,
            agent_info=result.agent_info
        )
        
    except Exception as e:
        logger.error(f"Error importing agent from JSON: {str(e)}")
        raise HTTPException(status_code=400, detail=f"Failed to import agent: {str(e)}")

@router.post("/agents", response_model=AgentResponse)
async def create_agent(
    agent_data: AgentCreateRequest,
    user_id: str = Depends(get_current_user_id_from_jwt)
):
    logger.debug(f"Creating new agent for user: {user_id}")
    if not await is_enabled("custom_agents"):
        raise HTTPException(
            status_code=403, 
            detail="Custom agents currently disabled. This feature is not available at the moment."
        )
    client = await db.client
    
    from .utils import check_agent_count_limit
    limit_check = await check_agent_count_limit(client, user_id)
    
    if not limit_check['can_create']:
        error_detail = {
            "message": f"Maximum of {limit_check['limit']} agents allowed for your current plan. You have {limit_check['current_count']} agents.",
            "current_count": limit_check['current_count'],
            "limit": limit_check['limit'],
            "tier_name": limit_check['tier_name'],
            "error_code": "AGENT_LIMIT_EXCEEDED"
        }
        logger.warning(f"Agent limit exceeded for account {user_id}: {limit_check['current_count']}/{limit_check['limit']} agents")
        raise HTTPException(status_code=402, detail=error_detail)
    
    try:
        if agent_data.is_default:
            await client.table('agents').update({"is_default": False}).eq("account_id", user_id).eq("is_default", True).execute()
        
        insert_data = {
            "account_id": user_id,
            "name": agent_data.name,
            "description": agent_data.description,
            "avatar": agent_data.avatar,
            "avatar_color": agent_data.avatar_color,
            "profile_image_url": agent_data.profile_image_url,
            "icon_name": agent_data.icon_name or "bot",
            "icon_color": agent_data.icon_color or "#000000",
            "icon_background": agent_data.icon_background or "#F3F4F6",
            "is_default": agent_data.is_default or False,
            "version_count": 1
        }
        
        if config.ENV_MODE == EnvMode.STAGING:
            print(f"[DEBUG] create_agent: Creating with icon_name={insert_data.get('icon_name')}, icon_color={insert_data.get('icon_color')}, icon_background={insert_data.get('icon_background')}")
        
        new_agent = await client.table('agents').insert(insert_data).execute()
        
        if not new_agent.data:
            raise HTTPException(status_code=500, detail="Failed to create agent")
        
        agent = new_agent.data[0]
        
        try:
            version_service = await _get_version_service()
            from agent.suna_config import SUNA_CONFIG
            from agent.config_helper import _get_default_agentpress_tools
            from models import model_manager
            
            system_prompt = SUNA_CONFIG["system_prompt"]
            
            agentpress_tools = agent_data.agentpress_tools if agent_data.agentpress_tools else _get_default_agentpress_tools()
            
            default_model = await model_manager.get_default_model_for_user(client, user_id)
            
            version = await version_service.create_version(
                agent_id=agent['agent_id'],
                user_id=user_id,
                system_prompt=system_prompt,
                model=default_model,
                configured_mcps=agent_data.configured_mcps or [],
                custom_mcps=agent_data.custom_mcps or [],
                agentpress_tools=agentpress_tools,
                version_name="v1",
                change_description="Initial version"
            )
            
            agent['current_version_id'] = version.version_id
            agent['version_count'] = 1

            current_version = AgentVersionResponse(
                version_id=version.version_id,
                agent_id=version.agent_id,
                version_number=version.version_number,
                version_name=version.version_name,
                system_prompt=version.system_prompt,
                model=version.model,
                configured_mcps=version.configured_mcps,
                custom_mcps=version.custom_mcps,
                agentpress_tools=version.agentpress_tools,
                is_active=version.is_active,
                created_at=version.created_at.isoformat(),
                updated_at=version.updated_at.isoformat(),
                created_by=version.created_by
            )
        except Exception as e:
            logger.error(f"Error creating initial version: {str(e)}")
            await client.table('agents').delete().eq('agent_id', agent['agent_id']).execute()
            raise HTTPException(status_code=500, detail="Failed to create initial version")
        
        from utils.cache import Cache
        await Cache.invalidate(f"agent_count_limit:{user_id}")
        
        logger.debug(f"Created agent {agent['agent_id']} with v1 for user: {user_id}")
        
        response = AgentResponse(
            agent_id=agent['agent_id'],
            name=agent['name'],
            description=agent.get('description'),
            system_prompt=version.system_prompt,
            model=version.model,
            configured_mcps=version.configured_mcps,
            custom_mcps=version.custom_mcps,
            agentpress_tools=version.agentpress_tools,
            is_default=agent.get('is_default', False),
            is_public=agent.get('is_public', False),
            tags=agent.get('tags', []),
            avatar=agent.get('avatar'),
            avatar_color=agent.get('avatar_color'),
            profile_image_url=agent.get('profile_image_url'),
            icon_name=agent.get('icon_name'),
            icon_color=agent.get('icon_color'),
            icon_background=agent.get('icon_background'),
            created_at=agent['created_at'],
            updated_at=agent.get('updated_at', agent['created_at']),
            current_version_id=agent.get('current_version_id'),
            version_count=agent.get('version_count', 1),
            current_version=current_version,
            metadata=agent.get('metadata')
        )
        
        if config.ENV_MODE == EnvMode.STAGING:
            print(f"[DEBUG] create_agent RESPONSE: Returning icon_name={response.icon_name}, icon_color={response.icon_color}, icon_background={response.icon_background}")
            print(f"[DEBUG] create_agent RESPONSE: Also returning profile_image_url={response.profile_image_url}, avatar={response.avatar}, avatar_color={response.avatar_color}")
        
        return response
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error creating agent for user {user_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to create agent: {str(e)}")

def merge_custom_mcps(existing_mcps: List[Dict[str, Any]], new_mcps: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    if not new_mcps:
        return existing_mcps
    
    merged_mcps = existing_mcps.copy()
    
    for new_mcp in new_mcps:
        new_mcp_name = new_mcp.get('name')
        existing_index = None
        
        for i, existing_mcp in enumerate(merged_mcps):
            if existing_mcp.get('name') == new_mcp_name:
                existing_index = i
                break
        
        if existing_index is not None:
            merged_mcps[existing_index] = new_mcp
        else:
            merged_mcps.append(new_mcp)
    
    return merged_mcps

@router.put("/agents/{agent_id}", response_model=AgentResponse)
async def update_agent(
    agent_id: str,
    agent_data: AgentUpdateRequest,
    user_id: str = Depends(get_current_user_id_from_jwt)
):
    if not await is_enabled("custom_agents"):
        raise HTTPException(
            status_code=403, 
            detail="Custom agent currently disabled. This feature is not available at the moment."
        )
    logger.debug(f"Updating agent {agent_id} for user: {user_id}")
    
    # Debug logging for icon fields
    if config.ENV_MODE == EnvMode.STAGING:
        print(f"[DEBUG] update_agent: Received icon fields - icon_name={agent_data.icon_name}, icon_color={agent_data.icon_color}, icon_background={agent_data.icon_background}")
        print(f"[DEBUG] update_agent: Also received - profile_image_url={agent_data.profile_image_url}, avatar={agent_data.avatar}, avatar_color={agent_data.avatar_color}")
    
    client = await db.client
    
    try:
        existing_agent = await client.table('agents').select('*').eq("agent_id", agent_id).eq("account_id", user_id).maybe_single().execute()
        
        if not existing_agent.data:
            raise HTTPException(status_code=404, detail="Agent not found")
        
        existing_data = existing_agent.data

        agent_metadata = existing_data.get('metadata', {})
        is_suna_agent = agent_metadata.get('is_suna_default', False) or agent_metadata.get('is_omni_default', False)
        restrictions = agent_metadata.get('restrictions', {})
        
        if is_suna_agent:
            logger.warning(f"Update attempt on Suna default agent {agent_id} by user {user_id}")
            
            if (agent_data.name is not None and 
                agent_data.name != existing_data.get('name') and 
                restrictions.get('name_editable') == False):
                logger.error(f"User {user_id} attempted to modify restricted name of Suna agent {agent_id}")
                raise HTTPException(
                    status_code=403, 
                    detail="Suna's name cannot be modified. This restriction is managed centrally."
                )
            
            if (agent_data.description is not None and
                agent_data.description != existing_data.get('description') and 
                restrictions.get('description_editable') == False):
                logger.error(f"User {user_id} attempted to modify restricted description of Suna agent {agent_id}")
                raise HTTPException(
                    status_code=403, 
                    detail="Suna's description cannot be modified."
                )
            
            if (agent_data.system_prompt is not None and 
                restrictions.get('system_prompt_editable') == False):
                logger.error(f"User {user_id} attempted to modify restricted system prompt of Suna agent {agent_id}")
                raise HTTPException(
                    status_code=403, 
                    detail="Suna's system prompt cannot be modified. This is managed centrally to ensure optimal performance."
                )
            
            if (agent_data.agentpress_tools is not None and 
                restrictions.get('tools_editable') == False):
                logger.error(f"User {user_id} attempted to modify restricted tools of Suna agent {agent_id}")
                raise HTTPException(
                    status_code=403, 
                    detail="Suna's default tools cannot be modified. These tools are optimized for Suna's capabilities."
                )
            
            if ((agent_data.configured_mcps is not None or agent_data.custom_mcps is not None) and 
                restrictions.get('mcps_editable') == False):
                logger.error(f"User {user_id} attempted to modify restricted MCPs of Suna agent {agent_id}")
                raise HTTPException(
                    status_code=403, 
                    detail="Suna's integrations cannot be modified."
                )
            
            logger.debug(f"Suna agent update validation passed for agent {agent_id} by user {user_id}")

        current_version_data = None
        if existing_data.get('current_version_id'):
            try:
                version_service = await _get_version_service()
                current_version_obj = await version_service.get_version(
                    agent_id=agent_id,
                    version_id=existing_data['current_version_id'],
                    user_id=user_id
                )
                current_version_data = current_version_obj.to_dict()
            except Exception as e:
                logger.warning(f"Failed to get current version data for agent {agent_id}: {e}")
        
        if current_version_data is None:
            logger.debug(f"Agent {agent_id} has no version data, creating initial version")
            try:
                workflows_result = await client.table('agent_workflows').select('*').eq('agent_id', agent_id).execute()
                workflows = workflows_result.data if workflows_result.data else []
                
                # Fetch triggers for the agent
                triggers_result = await client.table('agent_triggers').select('*').eq('agent_id', agent_id).execute()
                triggers = []
                if triggers_result.data:
                    import json
                    for trigger in triggers_result.data:
                        # Parse the config string if it's a string
                        trigger_copy = trigger.copy()
                        if 'config' in trigger_copy and isinstance(trigger_copy['config'], str):
                            try:
                                trigger_copy['config'] = json.loads(trigger_copy['config'])
                            except json.JSONDecodeError:
                                logger.warning(f"Failed to parse trigger config for {trigger_copy.get('trigger_id')}")
                                trigger_copy['config'] = {}
                        triggers.append(trigger_copy)
                
                initial_version_data = {
                    "agent_id": agent_id,
                    "version_number": 1,
                    "version_name": "v1",
                    "system_prompt": existing_data.get('system_prompt', ''),
                    "configured_mcps": existing_data.get('configured_mcps', []),
                    "custom_mcps": existing_data.get('custom_mcps', []),
                    "agentpress_tools": existing_data.get('agentpress_tools', {}),
                    "is_active": True,
                    "created_by": user_id
                }
                
                initial_config = build_unified_config(
                    system_prompt=initial_version_data["system_prompt"],
                    agentpress_tools=initial_version_data["agentpress_tools"],
                    configured_mcps=initial_version_data["configured_mcps"],
                    custom_mcps=initial_version_data["custom_mcps"],
                    avatar=None,
                    avatar_color=None,
                    workflows=workflows,
                    triggers=triggers
                )
                initial_version_data["config"] = initial_config
                
                version_result = await client.table('agent_versions').insert(initial_version_data).execute()
                
                if version_result.data:
                    version_id = version_result.data[0]['version_id']
                    
                    await client.table('agents').update({
                        'current_version_id': version_id,
                        'version_count': 1
                    }).eq('agent_id', agent_id).execute()
                    current_version_data = initial_version_data
                    logger.debug(f"Created initial version for agent {agent_id}")
                else:
                    current_version_data = {
                        'system_prompt': existing_data.get('system_prompt', ''),
                        'configured_mcps': existing_data.get('configured_mcps', []),
                        'custom_mcps': existing_data.get('custom_mcps', []),
                        'agentpress_tools': existing_data.get('agentpress_tools', {})
                    }
            except Exception as e:
                logger.warning(f"Failed to create initial version for agent {agent_id}: {e}")
                current_version_data = {
                    'system_prompt': existing_data.get('system_prompt', ''),
                    'configured_mcps': existing_data.get('configured_mcps', []),
                    'custom_mcps': existing_data.get('custom_mcps', []),
                    'agentpress_tools': existing_data.get('agentpress_tools', {})
                }
        
        needs_new_version = False
        version_changes = {}
        
        def values_different(new_val, old_val):
            if new_val is None:
                return False
            import json
            try:
                new_json = json.dumps(new_val, sort_keys=True) if new_val is not None else None
                old_json = json.dumps(old_val, sort_keys=True) if old_val is not None else None
                return new_json != old_json
            except (TypeError, ValueError):
                return new_val != old_val
        
        if values_different(agent_data.system_prompt, current_version_data.get('system_prompt')):
            needs_new_version = True
            version_changes['system_prompt'] = agent_data.system_prompt
        
        if values_different(agent_data.configured_mcps, current_version_data.get('configured_mcps', [])):
            needs_new_version = True
            version_changes['configured_mcps'] = agent_data.configured_mcps
            
        if values_different(agent_data.custom_mcps, current_version_data.get('custom_mcps', [])):
            needs_new_version = True
            if agent_data.custom_mcps is not None:
                merged_custom_mcps = merge_custom_mcps(
                    current_version_data.get('custom_mcps', []),
                    agent_data.custom_mcps
                )
                version_changes['custom_mcps'] = merged_custom_mcps
            else:
                version_changes['custom_mcps'] = current_version_data.get('custom_mcps', [])
            
        if values_different(agent_data.agentpress_tools, current_version_data.get('agentpress_tools', {})):
            needs_new_version = True
            version_changes['agentpress_tools'] = agent_data.agentpress_tools
        
        update_data = {}
        if agent_data.name is not None:
            update_data["name"] = agent_data.name
        if agent_data.description is not None:
            update_data["description"] = agent_data.description
        if agent_data.is_default is not None:
            update_data["is_default"] = agent_data.is_default
            if agent_data.is_default:
                await client.table('agents').update({"is_default": False}).eq("account_id", user_id).eq("is_default", True).neq("agent_id", agent_id).execute()
        if agent_data.avatar is not None:
            update_data["avatar"] = agent_data.avatar
        if agent_data.avatar_color is not None:
            update_data["avatar_color"] = agent_data.avatar_color
        if agent_data.profile_image_url is not None:
            update_data["profile_image_url"] = agent_data.profile_image_url
        # Handle new icon system fields
        if agent_data.icon_name is not None:
            update_data["icon_name"] = agent_data.icon_name
        if agent_data.icon_color is not None:
            update_data["icon_color"] = agent_data.icon_color
        if agent_data.icon_background is not None:
            update_data["icon_background"] = agent_data.icon_background
        
        # Debug logging for update_data
        if config.ENV_MODE == EnvMode.STAGING:
            print(f"[DEBUG] update_agent: Prepared update_data with icon fields - icon_name={update_data.get('icon_name')}, icon_color={update_data.get('icon_color')}, icon_background={update_data.get('icon_background')}")
        
        current_system_prompt = agent_data.system_prompt if agent_data.system_prompt is not None else current_version_data.get('system_prompt', '')

        if agent_data.configured_mcps is not None:
            if agent_data.replace_mcps:
                current_configured_mcps = agent_data.configured_mcps
                logger.debug(f"Replacing configured MCPs for agent {agent_id}: {current_configured_mcps}")
            else:
                current_configured_mcps = agent_data.configured_mcps
        else:
            current_configured_mcps = current_version_data.get('configured_mcps', [])
        
        # Handle custom MCPs - either replace or merge based on the flag
        if agent_data.custom_mcps is not None:
            if agent_data.replace_mcps:
                # Replace mode: use the provided list as-is
                current_custom_mcps = agent_data.custom_mcps
                logger.debug(f"Replacing custom MCPs for agent {agent_id}: {current_custom_mcps}")
            else:
                # Merge mode: merge with existing MCPs (default behavior)
                current_custom_mcps = merge_custom_mcps(
                    current_version_data.get('custom_mcps', []),
                    agent_data.custom_mcps
                )
                logger.debug(f"Merging custom MCPs for agent {agent_id}")
        else:
            current_custom_mcps = current_version_data.get('custom_mcps', [])

        current_agentpress_tools = agent_data.agentpress_tools if agent_data.agentpress_tools is not None else current_version_data.get('agentpress_tools', {})
        current_avatar = agent_data.avatar if agent_data.avatar is not None else existing_data.get('avatar')
        current_avatar_color = agent_data.avatar_color if agent_data.avatar_color is not None else existing_data.get('avatar_color')
        new_version_id = None
        if needs_new_version:
            try:
                version_service = await _get_version_service()

                new_version = await version_service.create_version(
                    agent_id=agent_id,
                    user_id=user_id,
                    system_prompt=current_system_prompt,
                    configured_mcps=current_configured_mcps,
                    custom_mcps=current_custom_mcps,
                    agentpress_tools=current_agentpress_tools,
                    change_description="Configuration updated"
                )
                
                new_version_id = new_version.version_id
                update_data['current_version_id'] = new_version_id
                update_data['version_count'] = new_version.version_number
                
                logger.debug(f"Created new version {new_version.version_name} for agent {agent_id}")
                
            except HTTPException:
                raise
            except Exception as e:
                logger.error(f"Error creating new version for agent {agent_id}: {str(e)}")
                raise HTTPException(status_code=500, detail=f"Failed to create new agent version: {str(e)}")
        
        if update_data:
            try:
                print(f"[DEBUG] update_agent DB UPDATE: About to update agent {agent_id} with data: {update_data}")
                
                update_result = await client.table('agents').update(update_data).eq("agent_id", agent_id).eq("account_id", user_id).execute()
                
                # Debug logging after DB update
                if config.ENV_MODE == EnvMode.STAGING:
                    if update_result.data:
                        print(f"[DEBUG] update_agent DB UPDATE SUCCESS: Updated {len(update_result.data)} row(s)")
                        print(f"[DEBUG] update_agent DB UPDATE RESULT: {update_result.data[0] if update_result.data else 'No data'}")
                    else:
                        print(f"[DEBUG] update_agent DB UPDATE FAILED: No rows affected")
                
                if not update_result.data:
                    raise HTTPException(status_code=500, detail="Failed to update agent - no rows affected")
            except Exception as e:
                logger.error(f"Error updating agent {agent_id}: {str(e)}")
                if config.ENV_MODE == EnvMode.STAGING:
                    print(f"[DEBUG] update_agent DB UPDATE ERROR: {str(e)}")
                raise HTTPException(status_code=500, detail=f"Failed to update agent: {str(e)}")
        
        updated_agent = await client.table('agents').select('*').eq("agent_id", agent_id).eq("account_id", user_id).maybe_single().execute()
        
        if not updated_agent.data:
            raise HTTPException(status_code=500, detail="Failed to fetch updated agent")
        
        agent = updated_agent.data
        
        print(f"[DEBUG] update_agent AFTER UPDATE FETCH: agent_id={agent.get('agent_id')}")
        print(f"[DEBUG] update_agent AFTER UPDATE FETCH: icon_name={agent.get('icon_name')}, icon_color={agent.get('icon_color')}, icon_background={agent.get('icon_background')}")
        print(f"[DEBUG] update_agent AFTER UPDATE FETCH: profile_image_url={agent.get('profile_image_url')}, avatar={agent.get('avatar')}, avatar_color={agent.get('avatar_color')}")
        print(f"[DEBUG] update_agent AFTER UPDATE FETCH: All keys in agent: {agent.keys()}")
        
        current_version = None
        if agent.get('current_version_id'):
            try:
                version_service = await _get_version_service()
                current_version_obj = await version_service.get_version(
                    agent_id=agent_id,
                    version_id=agent['current_version_id'],
                    user_id=user_id
                )
                current_version_data = current_version_obj.to_dict()
                version_data = current_version_data
                
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
                
                logger.debug(f"Using agent {agent['name']} version {current_version_data.get('version_name', 'v1')}")
            except Exception as e:
                logger.warning(f"Failed to get version data for updated agent {agent_id}: {e}")
        
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
            }
        
        from agent.config_helper import extract_agent_config
        
        # Debug logging before extract_agent_config
        if config.ENV_MODE == EnvMode.STAGING:
            print(f"[DEBUG] update_agent: Before extract_agent_config - agent has icon_name={agent.get('icon_name')}, icon_color={agent.get('icon_color')}, icon_background={agent.get('icon_background')}")
        
        agent_config = extract_agent_config(agent, version_data)
        
        # Debug logging after extract_agent_config
        if config.ENV_MODE == EnvMode.STAGING:
            print(f"[DEBUG] update_agent: After extract_agent_config - agent_config has icon_name={agent_config.get('icon_name')}, icon_color={agent_config.get('icon_color')}, icon_background={agent_config.get('icon_background')}")
        
        system_prompt = agent_config['system_prompt']
        configured_mcps = agent_config['configured_mcps']
        custom_mcps = agent_config['custom_mcps']
        agentpress_tools = agent_config['agentpress_tools']
        
        response = AgentResponse(
            agent_id=agent['agent_id'],
            name=agent['name'],
            description=agent.get('description'),
            system_prompt=system_prompt,
            configured_mcps=configured_mcps,
            custom_mcps=custom_mcps,
            agentpress_tools=agentpress_tools,
            is_default=agent.get('is_default', False),
            is_public=agent.get('is_public', False),
            tags=agent.get('tags', []),
            avatar=agent_config.get('avatar'),
            avatar_color=agent_config.get('avatar_color'),
            profile_image_url=agent_config.get('profile_image_url'),
            icon_name=agent_config.get('icon_name'),
            icon_color=agent_config.get('icon_color'),
            icon_background=agent_config.get('icon_background'),
            created_at=agent['created_at'],
            updated_at=agent.get('updated_at', agent['created_at']),
            current_version_id=agent.get('current_version_id'),
            version_count=agent.get('version_count', 1),
            current_version=current_version,
            metadata=agent.get('metadata')
        )
        

        print(f"[DEBUG] update_agent FINAL RESPONSE: agent_id={response.agent_id}")
        print(f"[DEBUG] update_agent FINAL RESPONSE: icon_name={response.icon_name}, icon_color={response.icon_color}, icon_background={response.icon_background}")
        print(f"[DEBUG] update_agent FINAL RESPONSE: profile_image_url={response.profile_image_url}, avatar={response.avatar}, avatar_color={response.avatar_color}")
        print(f"[DEBUG] update_agent FINAL RESPONSE: Full response dict keys: {response.dict().keys()}")
        
        return response
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating agent {agent_id} for user {user_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to update agent: {str(e)}")

@router.delete("/agents/{agent_id}")
async def delete_agent(agent_id: str, user_id: str = Depends(get_current_user_id_from_jwt)):
    if not await is_enabled("custom_agents"):
        raise HTTPException(
            status_code=403, 
            detail="Custom agent currently disabled. This feature is not available at the moment."
        )
    logger.debug(f"Deleting agent: {agent_id}")
    client = await db.client
    
    try:
        agent_result = await client.table('agents').select('*').eq('agent_id', agent_id).execute()
        if not agent_result.data:
            raise HTTPException(status_code=404, detail="Agent not found")
        
        agent = agent_result.data[0]
        if agent['account_id'] != user_id:
            raise HTTPException(status_code=403, detail="Access denied")
        
        if agent['is_default']:
            raise HTTPException(status_code=400, detail="Cannot delete default agent")
        
        if agent.get('metadata', {}).get('is_suna_default', False) or agent.get('metadata', {}).get('is_omni_default', False):
            raise HTTPException(status_code=400, detail="Cannot delete Suna default agent")
        
        # Clean up triggers before deleting agent to ensure proper remote cleanup
        try:
            from triggers.trigger_service import get_trigger_service
            trigger_service = get_trigger_service(db)
            
            # Get all triggers for this agent
            triggers_result = await client.table('agent_triggers').select('trigger_id').eq('agent_id', agent_id).execute()
            
            if triggers_result.data:
                logger.debug(f"Cleaning up {len(triggers_result.data)} triggers for agent {agent_id}")
                
                # Delete each trigger properly (this handles remote cleanup)
                for trigger_record in triggers_result.data:
                    trigger_id = trigger_record['trigger_id']
                    try:
                        await trigger_service.delete_trigger(trigger_id)
                        logger.debug(f"Successfully cleaned up trigger {trigger_id}")
                    except Exception as e:
                        logger.warning(f"Failed to clean up trigger {trigger_id}: {str(e)}")
                        # Continue with other triggers even if one fails
        except Exception as e:
            logger.warning(f"Failed to clean up triggers for agent {agent_id}: {str(e)}")
            # Continue with agent deletion even if trigger cleanup fails
        
        delete_result = await client.table('agents').delete().eq('agent_id', agent_id).execute()
        
        if not delete_result.data:
            logger.warning(f"No agent was deleted for agent_id: {agent_id}, user_id: {user_id}")
            raise HTTPException(status_code=403, detail="Unable to delete agent - permission denied or agent not found")
        
        try:
            from utils.cache import Cache
            await Cache.invalidate(f"agent_count_limit:{user_id}")
        except Exception as cache_error:
            logger.warning(f"Cache invalidation failed for user {user_id}: {str(cache_error)}")
        
        logger.debug(f"Successfully deleted agent: {agent_id}")
        return {"message": "Agent deleted successfully"}
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting agent {agent_id}: {str(e)}")
        raise HTTPException(status_code=500, detail="Internal server error")


@router.get("/agents/{agent_id}/pipedream-tools/{profile_id}")
async def get_pipedream_tools_for_agent(
    agent_id: str,
    profile_id: str,
    user_id: str = Depends(get_current_user_id_from_jwt),
    version: Optional[str] = Query(None, description="Version ID to get tools from specific version")
):
    logger.debug(f"Getting tools for agent {agent_id}, profile {profile_id}, user {user_id}, version {version}")

    try:
        from pipedream import profile_service, mcp_service
        from uuid import UUID

        profile = await profile_service.get_profile(UUID(user_id), UUID(profile_id))
        
        if not profile:
            logger.error(f"Profile {profile_id} not found for user {user_id}")
            try:
                all_profiles = await profile_service.get_profiles(UUID(user_id))
                pipedream_profiles = [p for p in all_profiles if 'pipedream' in p.mcp_qualified_name]
                logger.debug(f"User {user_id} has {len(pipedream_profiles)} pipedream profiles: {[p.profile_id for p in pipedream_profiles]}")
            except Exception as debug_e:
                logger.warning(f"Could not check user's profiles: {str(debug_e)}")
            
            raise HTTPException(status_code=404, detail=f"Profile {profile_id} not found or access denied")
        
        if not profile.is_connected:
            raise HTTPException(status_code=400, detail="Profile is not connected")

        enabled_tools = []
        try:
            client = await db.client
            agent_row = await client.table('agents')\
                .select('current_version_id')\
                .eq('agent_id', agent_id)\
                .eq('account_id', user_id)\
                .maybe_single()\
                .execute()
            
            if agent_row.data and agent_row.data.get('current_version_id'):
                if version:
                    version_result = await client.table('agent_versions')\
                        .select('config')\
                        .eq('version_id', version)\
                        .maybe_single()\
                        .execute()
                else:
                    version_result = await client.table('agent_versions')\
                        .select('config')\
                        .eq('version_id', agent_row.data['current_version_id'])\
                        .maybe_single()\
                        .execute()
                
                if version_result.data and version_result.data.get('config'):
                    agent_config = version_result.data['config']
                    tools = agent_config.get('tools', {})
                    custom_mcps = tools.get('custom_mcp', []) or []
                    
                    for mcp in custom_mcps:
                        mcp_profile_id = mcp.get('config', {}).get('profile_id')
                        if mcp_profile_id == profile_id:
                            enabled_tools = mcp.get('enabledTools', mcp.get('enabled_tools', []))
                            logger.debug(f"Found enabled tools for profile {profile_id}: {enabled_tools}")
                            break
                    
                    if not enabled_tools:
                        logger.debug(f"No enabled tools found for profile {profile_id} in agent {agent_id}")
            
        except Exception as e:
            logger.error(f"Error retrieving enabled tools for profile {profile_id}: {str(e)}")
        
        logger.debug(f"Using {len(enabled_tools)} enabled tools for profile {profile_id}: {enabled_tools}")
        
        try:
            from pipedream.mcp_service import ExternalUserId, AppSlug
            external_user_id = ExternalUserId(profile.external_user_id)
            app_slug_obj = AppSlug(profile.app_slug)
            
            logger.debug(f"Discovering servers for user {external_user_id.value} and app {app_slug_obj.value}")
            servers = await mcp_service.discover_servers_for_user(external_user_id, app_slug_obj)
            logger.debug(f"Found {len(servers)} servers: {[s.app_slug for s in servers]}")
            
            server = servers[0] if servers else None
            logger.debug(f"Selected server: {server.app_slug if server else 'None'} with {len(server.available_tools) if server else 0} tools")
            
            if not server:
                return {
                    'profile_id': profile_id,
                    'app_name': profile.app_name,
                    'profile_name': profile.profile_name,
                    'tools': [],
                    'has_mcp_config': len(enabled_tools) > 0
                }
            
            available_tools = server.available_tools
            
            formatted_tools = []
            def tools_match(api_tool_name, stored_tool_name):
                api_normalized = api_tool_name.lower().replace('-', '_')
                stored_normalized = stored_tool_name.lower().replace('-', '_')
                return api_normalized == stored_normalized
            
            for tool in available_tools:
                is_enabled = any(tools_match(tool.name, stored_tool) for stored_tool in enabled_tools)
                formatted_tools.append({
                    'name': tool.name,
                    'description': tool.description or f"Tool from {profile.app_name}",
                    'enabled': is_enabled
                })
            
            return {
                'profile_id': profile_id,
                'app_name': profile.app_name,
                'profile_name': profile.profile_name,
                'tools': formatted_tools,
                'has_mcp_config': len(enabled_tools) > 0
            }
            
        except Exception as e:
            logger.error(f"Error discovering tools: {e}", exc_info=True)
            return {
                'profile_id': profile_id,
                'app_name': getattr(profile, 'app_name', 'Unknown'),
                'profile_name': getattr(profile, 'profile_name', 'Unknown'),
                'tools': [],
                'has_mcp_config': len(enabled_tools) > 0,
                'error': str(e)
            }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting Pipedream tools for agent {agent_id}: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")


@router.put("/agents/{agent_id}/pipedream-tools/{profile_id}")
async def update_pipedream_tools_for_agent(
    agent_id: str,
    profile_id: str,
    request: dict,
    user_id: str = Depends(get_current_user_id_from_jwt)
):
    try:
        client = await db.client
        agent_row = await client.table('agents')\
            .select('current_version_id')\
            .eq('agent_id', agent_id)\
            .eq('account_id', user_id)\
            .maybe_single()\
            .execute()
        if not agent_row.data:
            raise HTTPException(status_code=404, detail="Agent not found")

        agent_config = {}
        if agent_row.data.get('current_version_id'):
            version_result = await client.table('agent_versions')\
                .select('config')\
                .eq('version_id', agent_row.data['current_version_id'])\
                .maybe_single()\
                .execute()
            if version_result.data and version_result.data.get('config'):
                agent_config = version_result.data['config']

        tools = agent_config.get('tools', {})
        custom_mcps = tools.get('custom_mcp', []) or []

        if any(mcp.get('config', {}).get('profile_id') == profile_id for mcp in custom_mcps):
            raise HTTPException(status_code=400, detail="This profile is already added to this agent")

        enabled_tools = request.get('enabled_tools', [])
        
        updated = False
        for mcp in custom_mcps:
            mcp_profile_id = mcp.get('config', {}).get('profile_id')
            if mcp_profile_id == profile_id:
                mcp['enabledTools'] = enabled_tools
                mcp['enabled_tools'] = enabled_tools
                updated = True
                logger.debug(f"Updated enabled tools for profile {profile_id}: {enabled_tools}")
                break
        
        if not updated:
            logger.warning(f"Profile {profile_id} not found in agent {agent_id} custom_mcps configuration")
            
        if updated:
            agent_config['tools']['custom_mcp'] = custom_mcps
            
            await client.table('agent_versions')\
                .update({'config': agent_config})\
                .eq('version_id', agent_row.data['current_version_id'])\
                .execute()
            
            logger.debug(f"Successfully updated agent configuration for {agent_id}")
        
        result = {
            'success': updated,
            'enabled_tools': enabled_tools,
            'total_tools': len(enabled_tools),
            'profile_id': profile_id
        }
        logger.debug(f"Successfully updated Pipedream tools for agent {agent_id}, profile {profile_id}")
        return result
        
    except ValueError as e:
        logger.error(f"Validation error updating Pipedream tools: {e}")
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        logger.error(f"Error updating Pipedream tools for agent {agent_id}: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")


@router.get("/agents/{agent_id}/custom-mcp-tools")
async def get_custom_mcp_tools_for_agent(
    agent_id: str,
    request: Request,
    user_id: str = Depends(get_current_user_id_from_jwt)
):
    logger.debug(f"Getting custom MCP tools for agent {agent_id}, user {user_id}")
    try:
        client = await db.client
        agent_result = await client.table('agents').select('current_version_id').eq('agent_id', agent_id).eq('account_id', user_id).execute()
        if not agent_result.data:
            raise HTTPException(status_code=404, detail="Agent not found")
        
        agent = agent_result.data[0]
 
        agent_config = {}
        if agent.get('current_version_id'):
            version_result = await client.table('agent_versions')\
                .select('config')\
                .eq('version_id', agent['current_version_id'])\
                .maybe_single()\
                .execute()
            if version_result.data and version_result.data.get('config'):
                agent_config = version_result.data['config']
        
        tools = agent_config.get('tools', {})
        custom_mcps = tools.get('custom_mcp', [])
        
        mcp_url = request.headers.get('X-MCP-URL')
        mcp_type = request.headers.get('X-MCP-Type', 'sse')
        
        if not mcp_url:
            raise HTTPException(status_code=400, detail="X-MCP-URL header is required")
        
        mcp_config = {
            'url': mcp_url,
            'type': mcp_type
        }
        
        if 'X-MCP-Headers' in request.headers:
            import json
            try:
                mcp_config['headers'] = json.loads(request.headers['X-MCP-Headers'])
            except json.JSONDecodeError:
                logger.warning("Failed to parse X-MCP-Headers as JSON")
        
        from mcp_module import mcp_service
        discovery_result = await mcp_service.discover_custom_tools(mcp_type, mcp_config)
        
        existing_mcp = None
        for mcp in custom_mcps:
            if (mcp.get('type') == mcp_type and 
                mcp.get('config', {}).get('url') == mcp_url):
                existing_mcp = mcp
                break
        
        tools = []
        enabled_tools = existing_mcp.get('enabledTools', []) if existing_mcp else []
        
        for tool in discovery_result.tools:
            tools.append({
                'name': tool['name'],
                'description': tool.get('description', f'Tool from {mcp_type.upper()} MCP server'),
                'enabled': tool['name'] in enabled_tools
            })
        
        return {
            'tools': tools,
            'has_mcp_config': existing_mcp is not None,
            'server_type': mcp_type,
            'server_url': mcp_url
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting custom MCP tools for agent {agent_id}: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")


@router.post("/agents/{agent_id}/custom-mcp-tools")
async def update_custom_mcp_tools_for_agent(
    agent_id: str,
    request: dict,
    user_id: str = Depends(get_current_user_id_from_jwt)
):
    logger.debug(f"Updating custom MCP tools for agent {agent_id}, user {user_id}")
    
    try:
        client = await db.client
        
        agent_result = await client.table('agents').select('current_version_id').eq('agent_id', agent_id).eq('account_id', user_id).execute()
        if not agent_result.data:
            raise HTTPException(status_code=404, detail="Agent not found")
        
        agent = agent_result.data[0]
        
        agent_config = {}
        if agent.get('current_version_id'):
            version_result = await client.table('agent_versions')\
                .select('config')\
                .eq('version_id', agent['current_version_id'])\
                .maybe_single()\
                .execute()
            if version_result.data and version_result.data.get('config'):
                agent_config = version_result.data['config']
        
        tools = agent_config.get('tools', {})
        custom_mcps = tools.get('custom_mcp', [])
        
        mcp_url = request.get('url')
        mcp_type = request.get('type', 'sse')
        enabled_tools = request.get('enabled_tools', [])
        
        if not mcp_url:
            raise HTTPException(status_code=400, detail="MCP URL is required")
        
        updated = False
        for i, mcp in enumerate(custom_mcps):
            if mcp_type == 'composio':
                # For Composio, match by profile_id
                if (mcp.get('type') == 'composio' and 
                    mcp.get('config', {}).get('profile_id') == mcp_url):
                    custom_mcps[i]['enabledTools'] = enabled_tools
                    updated = True
                    break
            else:
                if (mcp.get('customType') == mcp_type and 
                    mcp.get('config', {}).get('url') == mcp_url):
                    custom_mcps[i]['enabledTools'] = enabled_tools
                    updated = True
                    break
        
        if not updated:
            if mcp_type == 'composio':
                try:
                    from composio_integration.composio_profile_service import ComposioProfileService
                    from services.supabase import DBConnection
                    profile_service = ComposioProfileService(DBConnection())
 
                    profile_id = mcp_url
                    mcp_config = await profile_service.get_mcp_config_for_agent(profile_id)
                    mcp_config['enabledTools'] = enabled_tools
                    custom_mcps.append(mcp_config)
                except Exception as e:
                    logger.error(f"Failed to get Composio profile config: {e}")
                    raise HTTPException(status_code=400, detail=f"Failed to get Composio profile: {str(e)}")
            else:
                new_mcp_config = {
                    "name": f"Custom MCP ({mcp_type.upper()})",
                    "customType": mcp_type,
                    "type": mcp_type,
                    "config": {
                        "url": mcp_url
                    },
                    "enabledTools": enabled_tools
                }
                custom_mcps.append(new_mcp_config)
        
        tools['custom_mcp'] = custom_mcps
        agent_config['tools'] = tools
        
        from agent.versioning.version_service import get_version_service
        try:
            version_service = await get_version_service() 
            new_version = await version_service.create_version(
                agent_id=agent_id,
                user_id=user_id,
                system_prompt=agent_config.get('system_prompt', ''),
                configured_mcps=agent_config.get('tools', {}).get('mcp', []),
                custom_mcps=custom_mcps,
                agentpress_tools=agent_config.get('tools', {}).get('agentpress', {}),
                change_description=f"Updated custom MCP tools for {mcp_type}"
            )
            logger.debug(f"Created version {new_version.version_id} for custom MCP tools update on agent {agent_id}")
        except Exception as e:
            logger.error(f"Failed to create version for custom MCP tools update: {e}")
            raise HTTPException(status_code=500, detail="Failed to save changes")
        
        return {
            'success': True,
            'enabled_tools': enabled_tools,
            'total_tools': len(enabled_tools)
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating custom MCP tools for agent {agent_id}: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")

@router.get("/agents/{agent_id}/tools")
async def get_agent_tools(
    agent_id: str,
    user_id: str = Depends(get_current_user_id_from_jwt)
):
    if not await is_enabled("custom_agents"):
        raise HTTPException(status_code=403, detail="Custom agents currently disabled")
        
    logger.debug(f"Fetching enabled tools for agent: {agent_id} by user: {user_id}")
    client = await db.client

    agent_result = await client.table('agents').select('*').eq('agent_id', agent_id).execute()
    if not agent_result.data:
        raise HTTPException(status_code=404, detail="Agent not found")
    agent = agent_result.data[0]
    if agent['account_id'] != user_id and not agent.get('is_public', False):
        raise HTTPException(status_code=403, detail="Access denied")


    version_data = None
    if agent.get('current_version_id'):
        try:
            version_service = await _get_version_service()

            version_obj = await version_service.get_version(
                agent_id=agent_id,
                version_id=agent['current_version_id'],
                user_id=user_id
            )
            version_data = version_obj.to_dict()
        except Exception as e:
            logger.warning(f"Failed to fetch version data for tools endpoint: {e}")
    
    from agent.config_helper import extract_agent_config
    agent_config = extract_agent_config(agent, version_data)
    
    agentpress_tools_config = agent_config['agentpress_tools']
    configured_mcps = agent_config['configured_mcps'] 
    custom_mcps = agent_config['custom_mcps']

    agentpress_tools = []
    for name, enabled in agentpress_tools_config.items():
        is_enabled_tool = bool(enabled.get('enabled', False)) if isinstance(enabled, dict) else bool(enabled)
        agentpress_tools.append({"name": name, "enabled": is_enabled_tool})


    mcp_tools = []
    for mcp in configured_mcps + custom_mcps:
        server = mcp.get('name')
        enabled_tools = mcp.get('enabledTools') or mcp.get('enabled_tools') or []
        for tool_name in enabled_tools:
            mcp_tools.append({"name": tool_name, "server": server, "enabled": True})
    return {"agentpress_tools": agentpress_tools, "mcp_tools": mcp_tools}



@router.get("/threads")
async def get_user_threads(
    user_id: str = Depends(get_current_user_id_from_jwt),
    page: Optional[int] = Query(1, ge=1, description="Page number (1-based)"),
    limit: Optional[int] = Query(1000, ge=1, le=1000, description="Number of items per page (max 1000)")
):
    """Get all threads for the current user with associated project data."""
    logger.debug(f"Fetching threads with project data for user: {user_id} (page={page}, limit={limit})")
    client = await db.client
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
            from utils.query_utils import batch_query_in
            
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
    user_id: str = Depends(get_current_user_id_from_jwt)
):
    """Get a specific thread by ID with complete related data."""
    logger.debug(f"Fetching thread: {thread_id}")
    client = await db.client
    
    try:
        await verify_thread_access(client, thread_id, user_id)
        
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
    user_id: str = Depends(get_current_user_id_from_jwt)
):
    """
    Create a new thread without starting an agent run.

    [WARNING] Keep in sync with initiate endpoint.
    """
    if not name:
        name = "New Project"
    logger.debug(f"Creating new thread with name: {name}")
    client = await db.client
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
    user_id: str = Depends(get_current_user_id_from_jwt),
    order: str = Query("desc", description="Order by created_at: 'asc' or 'desc'")
):
    """Get all messages for a thread, fetching in batches of 1000 from the DB to avoid large queries."""
    logger.debug(f"Fetching all messages for thread: {thread_id}, order={order}")
    client = await db.client
    await verify_thread_access(client, thread_id, user_id)
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
    user_id: str = Depends(get_current_user_id_from_jwt),
):
    """
    [DEPRECATED] Get an agent run by ID.

    This endpoint is deprecated and may be removed in future versions.
    """
    logger.warning(f"[DEPRECATED] Fetching agent run: {agent_run_id}")
    client = await db.client
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
    user_id: str = Depends(get_current_user_id_from_jwt),
):
    """Add a message to a thread"""
    logger.debug(f"Adding message to thread: {thread_id}")
    client = await db.client
    await verify_thread_access(client, thread_id, user_id)
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
    user_id: str = Depends(get_current_user_id_from_jwt)
):
    """Create a new message in a thread."""
    logger.debug(f"Creating message in thread: {thread_id}")
    client = await db.client
    
    try:
        await verify_thread_access(client, thread_id, user_id)
        
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
    user_id: str = Depends(get_current_user_id_from_jwt)
):
    """Delete a message from a thread."""
    logger.debug(f"Deleting message from thread: {thread_id}")
    client = await db.client
    await verify_thread_access(client, thread_id, user_id)
    try:
        # Don't allow users to delete the "status" messages
        await client.table('messages').delete().eq('message_id', message_id).eq('is_llm_message', True).eq('thread_id', thread_id).execute()
        return {"message": "Message deleted successfully"}
    except Exception as e:
        logger.error(f"Error deleting message {message_id} from thread {thread_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to delete message: {str(e)}")

@router.put("/agents/{agent_id}/custom-mcp-tools")
async def update_agent_custom_mcps(
    agent_id: str,
    request: dict,
    user_id: str = Depends(get_current_user_id_from_jwt)
):
    logger.debug(f"Updating agent {agent_id} custom MCPs for user {user_id}")
    
    try:
        client = await db.client
        agent_result = await client.table('agents').select('current_version_id').eq('agent_id', agent_id).eq('account_id', user_id).execute()
        if not agent_result.data:
            raise HTTPException(status_code=404, detail="Agent not found")
        
        agent = agent_result.data[0]
        
        agent_config = {}
        if agent.get('current_version_id'):
            version_result = await client.table('agent_versions')\
                .select('config')\
                .eq('version_id', agent['current_version_id'])\
                .maybe_single()\
                .execute()
            if version_result.data and version_result.data.get('config'):
                agent_config = version_result.data['config']
        
        new_custom_mcps = request.get('custom_mcps', [])
        if not new_custom_mcps:
            raise HTTPException(status_code=400, detail="custom_mcps array is required")
        
        tools = agent_config.get('tools', {})
        existing_custom_mcps = tools.get('custom_mcp', [])
        
        updated = False
        for new_mcp in new_custom_mcps:
            mcp_type = new_mcp.get('type', '')
            
            if mcp_type == 'composio':
                profile_id = new_mcp.get('config', {}).get('profile_id')
                if not profile_id:
                    continue
                    
                for i, existing_mcp in enumerate(existing_custom_mcps):
                    if (existing_mcp.get('type') == 'composio' and 
                        existing_mcp.get('config', {}).get('profile_id') == profile_id):
                        existing_custom_mcps[i] = new_mcp
                        updated = True
                        break
                
                if not updated:
                    existing_custom_mcps.append(new_mcp)
                    updated = True
            else:
                mcp_url = new_mcp.get('config', {}).get('url')
                mcp_name = new_mcp.get('name', '')
                
                for i, existing_mcp in enumerate(existing_custom_mcps):
                    if (existing_mcp.get('config', {}).get('url') == mcp_url or 
                        (mcp_name and existing_mcp.get('name') == mcp_name)):
                        existing_custom_mcps[i] = new_mcp
                        updated = True
                        break
                
                if not updated:
                    existing_custom_mcps.append(new_mcp)
                    updated = True
        
        tools['custom_mcp'] = existing_custom_mcps
        agent_config['tools'] = tools
        
        from agent.versioning.version_service import get_version_service
        import datetime
        
        try:
            version_service = await get_version_service()
            timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
            change_description = f"MCP tools update {timestamp}"
            
            new_version = await version_service.create_version(
                agent_id=agent_id,
                user_id=user_id,
                system_prompt=agent_config.get('system_prompt', ''),
                configured_mcps=agent_config.get('tools', {}).get('mcp', []),
                custom_mcps=existing_custom_mcps,
                agentpress_tools=agent_config.get('tools', {}).get('agentpress', {}),
                change_description=change_description
            )
            logger.debug(f"Created version {new_version.version_id} for agent {agent_id}")
            
            total_enabled_tools = sum(len(mcp.get('enabledTools', [])) for mcp in new_custom_mcps)
        except Exception as e:
            logger.error(f"Failed to create version for custom MCP tools update: {e}")
            raise HTTPException(status_code=500, detail="Failed to save changes")
        
        return {
            'success': True,
            'data': {
                'custom_mcps': existing_custom_mcps,
                'total_enabled_tools': total_enabled_tools
            }
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating agent custom MCPs: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")

@router.post("/tools/export-presentation")
async def export_presentation(
    request: Dict[str, Any] = Body(...),
    user_id: str = Depends(get_current_user_id_from_jwt)
):
    try:
        presentation_name = request.get("presentation_name")
        export_format = request.get("format", "pptx")
        project_id = request.get("project_id")
        
        if not presentation_name:
            raise HTTPException(status_code=400, detail="presentation_name is required")
        
        if not project_id:
            raise HTTPException(status_code=400, detail="project_id is required")
        
        if db is None:
            db_conn = DBConnection()
            client = await db_conn.client
        else:
            client = await db.client
            
        project_result = await client.table('projects').select('sandbox').eq('project_id', project_id).execute()
        if not project_result.data:
            raise HTTPException(status_code=404, detail="Project not found")
        
        sandbox_data = project_result.data[0].get('sandbox', {})
        sandbox_id = sandbox_data.get('id')
        
        if not sandbox_id:
            raise HTTPException(status_code=400, detail="No sandbox found for this project")
        
        thread_manager = ThreadManager()
        
        presentation_tool = SandboxPresentationTool(
            project_id=project_id,
            thread_manager=thread_manager
        )
        
        result = await presentation_tool.export_presentation(
            presentation_name=presentation_name,
            format=export_format
        )
        
        if result.success:
            import json
            import urllib.parse
            data = json.loads(result.output)
            
            export_file = data.get("export_file")
            logger.debug(f"Export file from tool: {export_file}")
            logger.debug(f"Sandbox ID: {sandbox_id}")
            
            if export_file:
                from fastapi.responses import Response
                from sandbox.api import get_sandbox_by_id_safely, verify_sandbox_access
                
                try:
                    file_path = export_file.replace("/workspace/", "").lstrip("/")
                    full_path = f"/workspace/{file_path}"
                    
                    sandbox = await get_sandbox_by_id_safely(client, sandbox_id)
                    file_content = await sandbox.fs.download_file(full_path)
                    
                    return {
                        "success": True,
                        "message": data.get("message"),
                        "file_content": base64.b64encode(file_content).decode('utf-8'),
                        "filename": export_file.split('/')[-1],
                        "export_file": data.get("export_file"),
                        "format": data.get("format"),
                        "file_size": data.get("file_size")
                    }
                except Exception as e:
                    logger.error(f"Failed to read exported file: {str(e)}")
                    return {
                        "success": False,
                        "error": f"Failed to read exported file: {str(e)}"
                    }
            else:
                return {
                    "success": True,
                    "message": data.get("message"),
                    "download_url": data.get("download_url"),
                    "export_file": data.get("export_file"),
                    "format": data.get("format"),
                    "file_size": data.get("file_size")
                }
        else:
            raise HTTPException(status_code=400, detail=result.output or "Export failed")
            
    except Exception as e:
        logger.error(f"Export presentation error: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to export presentation: {str(e)}")

        
@router.post("/agents/profile-image/upload")
async def upload_agent_profile_image(
    file: UploadFile = File(...),
    user_id: str = Depends(get_current_user_id_from_jwt)
):
    try:
        content_type = file.content_type or "image/png"
        image_bytes = await file.read()
        from utils.s3_upload_utils import upload_image_bytes
        public_url = await upload_image_bytes(image_bytes=image_bytes, content_type=content_type, bucket_name="agent-profile-images")
        return {"url": public_url}
    except Exception as e:
        logger.error(f"Failed to upload agent profile image for user {user_id}: {e}")
        raise HTTPException(status_code=500, detail="Failed to upload profile image")
