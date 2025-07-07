from fastapi import APIRouter, HTTPException, Depends, Request, Body, File, UploadFile, Form, Query
from fastapi.responses import StreamingResponse
import asyncio
import json
import traceback
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
from utils.auth_utils import get_current_user_id_from_jwt, get_user_id_from_stream_auth, verify_thread_access
from utils.logger import logger, structlog
from services.billing import check_billing_status, can_use_model
from utils.config import config
from sandbox.sandbox import create_sandbox, delete_sandbox, get_or_start_sandbox
from services.llm import make_llm_api_call
from run_agent_background import run_agent_background, _cleanup_redis_response_list, update_agent_run_status
from utils.constants import MODEL_NAME_ALIASES
from flags.flags import is_enabled

# Initialize shared resources
router = APIRouter()
db = None
instance_id = None # Global instance ID for this backend instance

# TTL for Redis response lists (24 hours)
REDIS_RESPONSE_LIST_TTL = 3600 * 24

class AgentStartRequest(BaseModel):
    model_name: Optional[str] = None  # Will be set from config.MODEL_TO_USE in the endpoint
    enable_thinking: Optional[bool] = False
    reasoning_effort: Optional[str] = 'low'
    stream: Optional[bool] = True
    enable_context_manager: Optional[bool] = False
    agent_id: Optional[str] = None  # Custom agent to use

class InitiateAgentResponse(BaseModel):
    thread_id: str
    agent_run_id: Optional[str] = None

class AgentCreateRequest(BaseModel):
    name: str
    description: Optional[str] = None
    system_prompt: str
    configured_mcps: Optional[List[Dict[str, Any]]] = []
    custom_mcps: Optional[List[Dict[str, Any]]] = []
    agentpress_tools: Optional[Dict[str, Any]] = {}
    is_default: Optional[bool] = False
    avatar: Optional[str] = None
    avatar_color: Optional[str] = None

class AgentVersionResponse(BaseModel):
    version_id: str
    agent_id: str
    version_number: int
    version_name: str
    system_prompt: str
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

class AgentResponse(BaseModel):
    agent_id: str
    account_id: str
    name: str
    description: Optional[str] = None
    system_prompt: str
    configured_mcps: List[Dict[str, Any]]
    custom_mcps: List[Dict[str, Any]]
    agentpress_tools: Dict[str, Any]
    is_default: bool
    avatar: Optional[str] = None
    avatar_color: Optional[str] = None
    created_at: str
    updated_at: Optional[str] = None
    is_public: Optional[bool] = False
    marketplace_published_at: Optional[str] = None
    download_count: Optional[int] = 0
    tags: Optional[List[str]] = []
    current_version_id: Optional[str] = None
    version_count: Optional[int] = 1
    current_version: Optional[AgentVersionResponse] = None

class PaginationInfo(BaseModel):
    page: int
    limit: int
    total: int
    pages: int

class AgentsResponse(BaseModel):
    agents: List[AgentResponse]
    pagination: PaginationInfo

class ThreadAgentResponse(BaseModel):
    agent: Optional[AgentResponse]
    source: str  # "thread", "default", "none", "missing"
    message: str

def initialize(
    _db: DBConnection,
    _instance_id: Optional[str] = None
):
    """Initialize the agent API with resources from the main API."""
    global db, instance_id
    db = _db

    # Use provided instance_id or generate a new one
    if _instance_id:
        instance_id = _instance_id
    else:
        # Generate instance ID
        instance_id = str(uuid.uuid4())[:8]

    logger.info(f"Initialized agent API with instance ID: {instance_id}")

    # Note: Redis will be initialized in the lifespan function in api.py

async def cleanup():
    """Clean up resources and stop running agents on shutdown."""
    logger.info("Starting cleanup of agent API resources")

    # Use the instance_id to find and clean up this instance's keys
    try:
        if instance_id: # Ensure instance_id is set
            running_keys = await redis.keys(f"active_run:{instance_id}:*")
            logger.info(f"Found {len(running_keys)} running agent runs for instance {instance_id} to clean up")

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
    logger.info("Completed cleanup of agent API resources")

async def stop_agent_run(agent_run_id: str, error_message: Optional[str] = None):
    """Update database and publish stop signal to Redis."""
    logger.info(f"Stopping agent run: {agent_run_id}")
    client = await db.client
    final_status = "failed" if error_message else "stopped"

    # Attempt to fetch final responses from Redis
    response_list_key = f"agent_run:{agent_run_id}:responses"
    all_responses = []
    try:
        all_responses_json = await redis.lrange(response_list_key, 0, -1)
        all_responses = [json.loads(r) for r in all_responses_json]
        logger.info(f"Fetched {len(all_responses)} responses from Redis for DB update on stop/fail: {agent_run_id}")
    except Exception as e:
        logger.error(f"Failed to fetch responses from Redis for {agent_run_id} during stop/fail: {e}")
        # Try fetching from DB as a fallback? Or proceed without responses? Proceeding without for now.

    # Update the agent run status in the database
    update_success = await update_agent_run_status(
        client, agent_run_id, final_status, error=error_message, responses=all_responses
    )

    if not update_success:
        logger.error(f"Failed to update database status for stopped/failed run {agent_run_id}")

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

    logger.info(f"Successfully initiated stop process for agent run: {agent_run_id}")

async def check_for_active_project_agent_run(client, project_id: str):
    """
    Check if there is an active agent run for any thread in the given project.
    If found, returns the ID of the active run, otherwise returns None.
    """
    project_threads = await client.table('threads').select('thread_id').eq('project_id', project_id).execute()
    project_thread_ids = [t['thread_id'] for t in project_threads.data]

    if project_thread_ids:
        active_runs = await client.table('agent_runs').select('id').in_('thread_id', project_thread_ids).eq('status', 'running').execute()
        if active_runs.data and len(active_runs.data) > 0:
            return active_runs.data[0]['id']
    return None

async def get_agent_run_with_access_check(client, agent_run_id: str, user_id: str):
    """Get agent run data after verifying user access."""
    agent_run = await client.table('agent_runs').select('*').eq('id', agent_run_id).execute()
    if not agent_run.data:
        raise HTTPException(status_code=404, detail="Agent run not found")

    agent_run_data = agent_run.data[0]
    thread_id = agent_run_data['thread_id']
    await verify_thread_access(client, thread_id, user_id)
    return agent_run_data

@router.post("/thread/{thread_id}/agent/start")
async def start_agent(
    thread_id: str,
    body: AgentStartRequest = Body(...),
    user_id: str = Depends(get_current_user_id_from_jwt)
):
    """Start an agent for a specific thread in the background."""
    structlog.contextvars.bind_contextvars(
        thread_id=thread_id,
    )
    global instance_id # Ensure instance_id is accessible
    if not instance_id:
        raise HTTPException(status_code=500, detail="Agent API not initialized with instance ID")

    # Use model from config if not specified in the request
    model_name = body.model_name
    logger.info(f"Original model_name from request: {model_name}")

    if model_name is None:
        model_name = config.MODEL_TO_USE
        logger.info(f"Using model from config: {model_name}")

    # Log the model name after alias resolution
    resolved_model = MODEL_NAME_ALIASES.get(model_name, model_name)
    logger.info(f"Resolved model name: {resolved_model}")

    # Update model_name to use the resolved version
    model_name = resolved_model

    logger.info(f"Starting new agent for thread: {thread_id} with config: model={model_name}, thinking={body.enable_thinking}, effort={body.reasoning_effort}, stream={body.stream}, context_manager={body.enable_context_manager} (Instance: {instance_id})")
    client = await db.client

    await verify_thread_access(client, thread_id, user_id)
    thread_result = await client.table('threads').select('project_id', 'account_id', 'agent_id', 'metadata').eq('thread_id', thread_id).execute()
    if not thread_result.data:
        raise HTTPException(status_code=404, detail="Thread not found")
    thread_data = thread_result.data[0]
    project_id = thread_data.get('project_id')
    account_id = thread_data.get('account_id')
    thread_agent_id = thread_data.get('agent_id')
    thread_metadata = thread_data.get('metadata', {})

    structlog.contextvars.bind_contextvars(
        project_id=project_id,
        account_id=account_id,
        thread_agent_id=thread_agent_id,
        thread_metadata=thread_metadata,
    )
    
    # Check if this is an agent builder thread
    is_agent_builder = thread_metadata.get('is_agent_builder', False)
    target_agent_id = thread_metadata.get('target_agent_id')
    
    if is_agent_builder:
        logger.info(f"Thread {thread_id} is in agent builder mode, target_agent_id: {target_agent_id}")
    
    # Load agent configuration with version support
    agent_config = None
    effective_agent_id = body.agent_id or thread_agent_id  # Use provided agent_id or the one stored in thread
    
    if effective_agent_id:
        # Get agent with current version
        agent_result = await client.table('agents').select('*, agent_versions!current_version_id(*)').eq('agent_id', effective_agent_id).eq('account_id', account_id).execute()
        if not agent_result.data:
            if body.agent_id:
                raise HTTPException(status_code=404, detail="Agent not found or access denied")
            else:
                logger.warning(f"Stored agent_id {effective_agent_id} not found, falling back to default")
                effective_agent_id = None
        else:
            agent_data = agent_result.data[0]
            # Use version data if available, otherwise fall back to agent data (for backward compatibility)
            if agent_data.get('agent_versions'):
                version_data = agent_data['agent_versions']
                agent_config = {
                    'agent_id': agent_data['agent_id'],
                    'name': agent_data['name'],
                    'description': agent_data.get('description'),
                    'system_prompt': version_data['system_prompt'],
                    'configured_mcps': version_data.get('configured_mcps', []),
                    'custom_mcps': version_data.get('custom_mcps', []),
                    'agentpress_tools': version_data.get('agentpress_tools', {}),
                    'is_default': agent_data.get('is_default', False),
                    'current_version_id': agent_data.get('current_version_id'),
                    'version_name': version_data.get('version_name', 'v1')
                }
                logger.info(f"Using agent {agent_config['name']} ({effective_agent_id}) version {agent_config['version_name']}")
            else:
                # Backward compatibility - use agent data directly
                agent_config = agent_data
                logger.info(f"Using agent {agent_config['name']} ({effective_agent_id}) - no version data")
            source = "request" if body.agent_id else "thread"
    
    # If no agent found yet, try to get default agent for the account
    if not agent_config:
        default_agent_result = await client.table('agents').select('*, agent_versions!current_version_id(*)').eq('account_id', account_id).eq('is_default', True).execute()
        if default_agent_result.data:
            agent_data = default_agent_result.data[0]
            # Use version data if available
            if agent_data.get('agent_versions'):
                version_data = agent_data['agent_versions']
                agent_config = {
                    'agent_id': agent_data['agent_id'],
                    'name': agent_data['name'],
                    'description': agent_data.get('description'),
                    'system_prompt': version_data['system_prompt'],
                    'configured_mcps': version_data.get('configured_mcps', []),
                    'custom_mcps': version_data.get('custom_mcps', []),
                    'agentpress_tools': version_data.get('agentpress_tools', {}),
                    'is_default': agent_data.get('is_default', False),
                    'current_version_id': agent_data.get('current_version_id'),
                    'version_name': version_data.get('version_name', 'v1')
                }
                logger.info(f"Using default agent: {agent_config['name']} ({agent_config['agent_id']}) version {agent_config['version_name']}")
            else:
                agent_config = agent_data
                logger.info(f"Using default agent: {agent_config['name']} ({agent_config['agent_id']}) - no version data")
    

    # Don't update thread's agent_id since threads are now agent-agnostic
    # The agent selection is handled per message/agent run
    if body.agent_id and body.agent_id != thread_agent_id and agent_config:
        logger.info(f"Using agent {agent_config['agent_id']} for this agent run (thread remains agent-agnostic)")

    can_use, model_message, allowed_models = await can_use_model(client, account_id, model_name)
    if not can_use:
        raise HTTPException(status_code=403, detail={"message": model_message, "allowed_models": allowed_models})

    can_run, message, subscription = await check_billing_status(client, account_id)
    if not can_run:
        raise HTTPException(status_code=402, detail={"message": message, "subscription": subscription})

    active_run_id = await check_for_active_project_agent_run(client, project_id)
    if active_run_id:
        logger.info(f"Stopping existing agent run {active_run_id} for project {project_id}")
        await stop_agent_run(active_run_id)

    try:
        # Get project data to find sandbox ID
        project_result = await client.table('projects').select('*').eq('project_id', project_id).execute()
        if not project_result.data:
            raise HTTPException(status_code=404, detail="Project not found")
        
        project_data = project_result.data[0]
        sandbox_info = project_data.get('sandbox', {})
        if not sandbox_info.get('id'):
            raise HTTPException(status_code=404, detail="No sandbox found for this project")
            
        sandbox_id = sandbox_info['id']
        sandbox = await get_or_start_sandbox(sandbox_id)
        logger.info(f"Successfully started sandbox {sandbox_id} for project {project_id}")
    except Exception as e:
        logger.error(f"Failed to start sandbox for project {project_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to initialize sandbox: {str(e)}")

    agent_run = await client.table('agent_runs').insert({
        "thread_id": thread_id, "status": "running",
        "started_at": datetime.now(timezone.utc).isoformat(),
        "agent_id": agent_config.get('agent_id') if agent_config else None,
        "agent_version_id": agent_config.get('current_version_id') if agent_config else None
    }).execute()
    agent_run_id = agent_run.data[0]['id']
    structlog.contextvars.bind_contextvars(
        agent_run_id=agent_run_id,
    )
    logger.info(f"Created new agent run: {agent_run_id}")

    # Register this run in Redis with TTL using instance ID
    instance_key = f"active_run:{instance_id}:{agent_run_id}"
    try:
        await redis.set(instance_key, "running", ex=redis.REDIS_KEY_TTL)
    except Exception as e:
        logger.warning(f"Failed to register agent run in Redis ({instance_key}): {str(e)}")

    request_id = structlog.contextvars.get_contextvars().get('request_id')

    # Run the agent in the background
    run_agent_background.send(
        agent_run_id=agent_run_id, thread_id=thread_id, instance_id=instance_id,
        project_id=project_id,
        model_name=model_name,  # Already resolved above
        enable_thinking=body.enable_thinking, reasoning_effort=body.reasoning_effort,
        stream=body.stream, enable_context_manager=body.enable_context_manager,
        agent_config=agent_config,  # Pass agent configuration
        is_agent_builder=is_agent_builder,
        target_agent_id=target_agent_id,
        request_id=request_id,
    )

    return {"agent_run_id": agent_run_id, "status": "running"}

@router.post("/agent-run/{agent_run_id}/stop")
async def stop_agent(agent_run_id: str, user_id: str = Depends(get_current_user_id_from_jwt)):
    """Stop a running agent."""
    structlog.contextvars.bind_contextvars(
        agent_run_id=agent_run_id,
    )
    logger.info(f"Received request to stop agent run: {agent_run_id}")
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
    logger.info(f"Fetching agent runs for thread: {thread_id}")
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
    logger.info(f"Fetching agent run details: {agent_run_id}")
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
    """Get the agent details for a specific thread. Since threads are now agent-agnostic, 
    this returns the most recently used agent or the default agent."""
    structlog.contextvars.bind_contextvars(
        thread_id=thread_id,
    )
    logger.info(f"Fetching agent details for thread: {thread_id}")
    client = await db.client
    
    try:
        # Verify thread access and get thread data including agent_id
        await verify_thread_access(client, thread_id, user_id)
        thread_result = await client.table('threads').select('agent_id', 'account_id').eq('thread_id', thread_id).execute()
        
        if not thread_result.data:
            raise HTTPException(status_code=404, detail="Thread not found")
        
        thread_data = thread_result.data[0]
        thread_agent_id = thread_data.get('agent_id')
        account_id = thread_data.get('account_id')
        
        effective_agent_id = None
        agent_source = "none"
        
        # First, try to get the most recently used agent from agent_runs
        recent_agent_result = await client.table('agent_runs').select('agent_id', 'agent_version_id').eq('thread_id', thread_id).not_.is_('agent_id', 'null').order('created_at', desc=True).limit(1).execute()
        if recent_agent_result.data:
            effective_agent_id = recent_agent_result.data[0]['agent_id']
            recent_version_id = recent_agent_result.data[0].get('agent_version_id')
            agent_source = "recent"
            logger.info(f"Found most recently used agent: {effective_agent_id} (version: {recent_version_id})")
        
        # If no recent agent, fall back to thread default agent
        elif thread_agent_id:
            effective_agent_id = thread_agent_id
            agent_source = "thread"
            logger.info(f"Using thread default agent: {effective_agent_id}")
        
        # If no thread agent, try to get the default agent for the account
        else:
            default_agent_result = await client.table('agents').select('agent_id').eq('account_id', account_id).eq('is_default', True).execute()
            if default_agent_result.data:
                effective_agent_id = default_agent_result.data[0]['agent_id']
                agent_source = "default"
                logger.info(f"Using account default agent: {effective_agent_id}")
        
        # If still no agent found
        if not effective_agent_id:
            return {
                "agent": None,
                "source": "none",
                "message": "No agent configured for this thread. Threads are agent-agnostic - you can select any agent."
            }
        
        # Fetch the agent details with version information
        agent_result = await client.table('agents').select('*, agent_versions!current_version_id(*)').eq('agent_id', effective_agent_id).eq('account_id', account_id).execute()
        
        if not agent_result.data:
            # Agent was deleted or doesn't exist
            return {
                "agent": None,
                "source": "missing",
                "message": f"Agent {effective_agent_id} not found or was deleted. You can select a different agent."
            }
        
        agent_data = agent_result.data[0]
        
        # Use version data if available, otherwise fall back to agent data (for backward compatibility)
        if agent_data.get('agent_versions'):
            version_data = agent_data['agent_versions']
            # Use the version data for the response
            system_prompt = version_data['system_prompt']
            configured_mcps = version_data.get('configured_mcps', [])
            custom_mcps = version_data.get('custom_mcps', [])
            agentpress_tools = version_data.get('agentpress_tools', {})
            logger.info(f"Using agent {agent_data['name']} version {version_data.get('version_name', 'v1')}")
        else:
            # Backward compatibility - use agent data directly
            system_prompt = agent_data['system_prompt']
            configured_mcps = agent_data.get('configured_mcps', [])
            custom_mcps = agent_data.get('custom_mcps', [])
            agentpress_tools = agent_data.get('agentpress_tools', {})
            logger.info(f"Using agent {agent_data['name']} - no version data (backward compatibility)")
        
        return {
            "agent": AgentResponse(
                agent_id=agent_data['agent_id'],
                account_id=agent_data['account_id'],
                name=agent_data['name'],
                description=agent_data.get('description'),
                system_prompt=system_prompt,
                configured_mcps=configured_mcps,
                custom_mcps=custom_mcps,
                agentpress_tools=agentpress_tools,
                is_default=agent_data.get('is_default', False),
                is_public=agent_data.get('is_public', False),
                marketplace_published_at=agent_data.get('marketplace_published_at'),
                download_count=agent_data.get('download_count', 0),
                tags=agent_data.get('tags', []),
                avatar=agent_data.get('avatar'),
                avatar_color=agent_data.get('avatar_color'),
                created_at=agent_data['created_at'],
                updated_at=agent_data['updated_at'],
                current_version_id=agent_data.get('current_version_id'),
                version_count=agent_data.get('version_count', 1)
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
    logger.info(f"Starting stream for agent run: {agent_run_id}")
    client = await db.client

    user_id = await get_user_id_from_stream_auth(request, token)
    agent_run_data = await get_agent_run_with_access_check(client, agent_run_id, user_id)

    structlog.contextvars.bind_contextvars(
        agent_run_id=agent_run_id,
        user_id=user_id,
    )

    response_list_key = f"agent_run:{agent_run_id}:responses"
    response_channel = f"agent_run:{agent_run_id}:new_response"
    control_channel = f"agent_run:{agent_run_id}:control" # Global control channel

    async def stream_generator():
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

            # 2. Check run status *after* yielding initial data
            run_status = await client.table('agent_runs').select('status', 'thread_id').eq("id", agent_run_id).maybe_single().execute()
            current_status = run_status.data.get('status') if run_status.data else None

            if current_status != 'running':
                logger.info(f"Agent run {agent_run_id} is not running (status: {current_status}). Ending stream.")
                yield f"data: {json.dumps({'type': 'status', 'status': 'completed'})}\n\n"
                return
          
            structlog.contextvars.bind_contextvars(
                thread_id=run_status.data.get('thread_id'),
            )

            # 3. Set up Pub/Sub listeners for new responses and control signals
            pubsub_response = await redis.create_pubsub()
            await pubsub_response.subscribe(response_channel)
            logger.debug(f"Subscribed to response channel: {response_channel}")

            pubsub_control = await redis.create_pubsub()
            await pubsub_control.subscribe(control_channel)
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
                                    logger.info(f"Received control signal '{data}' for {agent_run_id}")
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
                                    logger.info(f"Detected run completion via status message in stream: {response.get('status')}")
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
                     logger.info(f"Stream generator main loop cancelled for {agent_run_id}")
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
            if pubsub_response: await pubsub_response.unsubscribe(response_channel)
            if pubsub_control: await pubsub_control.unsubscribe(control_channel)
            if pubsub_response: await pubsub_response.close()
            if pubsub_control: await pubsub_control.close()

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

    return StreamingResponse(stream_generator(), media_type="text/event-stream", headers={
        "Cache-Control": "no-cache, no-transform", "Connection": "keep-alive",
        "X-Accel-Buffering": "no", "Content-Type": "text/event-stream",
        "Access-Control-Allow-Origin": "*"
    })

async def generate_and_update_project_name(project_id: str, prompt: str):
    """Generates a project name using an LLM and updates the database."""
    logger.info(f"Starting background task to generate name for project: {project_id}")
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
                logger.info(f"LLM generated name for project {project_id}: '{generated_name}'")
            else:
                logger.warning(f"LLM returned an empty name for project {project_id}.")
        else:
            logger.warning(f"Failed to get valid response from LLM for project {project_id} naming. Response: {response}")

        if generated_name:
            update_result = await client.table('projects').update({"name": generated_name}).eq("project_id", project_id).execute()
            if hasattr(update_result, 'data') and update_result.data:
                logger.info(f"Successfully updated project {project_id} name to '{generated_name}'")
            else:
                logger.error(f"Failed to update project {project_id} name in database. Update result: {update_result}")
        else:
            logger.warning(f"No generated name, skipping database update for project {project_id}.")

    except Exception as e:
        logger.error(f"Error in background naming task for project {project_id}: {str(e)}\n{traceback.format_exc()}")
    finally:
        # No need to disconnect DBConnection singleton instance here
        logger.info(f"Finished background naming task for project: {project_id}")

@router.post("/agent/initiate", response_model=InitiateAgentResponse)
async def initiate_agent_with_files(
    prompt: str = Form(...),
    model_name: Optional[str] = Form(None),  # Default to None to use config.MODEL_TO_USE
    enable_thinking: Optional[bool] = Form(False),
    reasoning_effort: Optional[str] = Form("low"),
    stream: Optional[bool] = Form(True),
    enable_context_manager: Optional[bool] = Form(False),
    agent_id: Optional[str] = Form(None),  # Add agent_id parameter
    files: List[UploadFile] = File(default=[]),
    is_agent_builder: Optional[bool] = Form(False),
    target_agent_id: Optional[str] = Form(None),
    user_id: str = Depends(get_current_user_id_from_jwt)
):
    """Initiate a new agent session with optional file attachments."""
    global instance_id # Ensure instance_id is accessible
    if not instance_id:
        raise HTTPException(status_code=500, detail="Agent API not initialized with instance ID")

    # Use model from config if not specified in the request
    logger.info(f"Original model_name from request: {model_name}")

    if model_name is None:
        model_name = config.MODEL_TO_USE
        logger.info(f"Using model from config: {model_name}")

    # Log the model name after alias resolution
    resolved_model = MODEL_NAME_ALIASES.get(model_name, model_name)
    logger.info(f"Resolved model name: {resolved_model}")

    # Update model_name to use the resolved version
    model_name = resolved_model

    logger.info(f"Starting new agent in agent builder mode: {is_agent_builder}, target_agent_id: {target_agent_id}")

    logger.info(f"[\033[91mDEBUG\033[0m] Initiating new agent with prompt and {len(files)} files (Instance: {instance_id}), model: {model_name}, enable_thinking: {enable_thinking}")
    client = await db.client
    account_id = user_id # In Basejump, personal account_id is the same as user_id
    
    # Load agent configuration if agent_id is provided
    agent_config = None
    if agent_id:
        agent_result = await client.table('agents').select('*').eq('agent_id', agent_id).eq('account_id', account_id).execute()
        if not agent_result.data:
            raise HTTPException(status_code=404, detail="Agent not found or access denied")
        agent_config = agent_result.data[0]
        logger.info(f"Using custom agent: {agent_config['name']} ({agent_id})")
    else:
        # Try to get default agent for the account
        default_agent_result = await client.table('agents').select('*').eq('account_id', account_id).eq('is_default', True).execute()
        if default_agent_result.data:
            agent_config = default_agent_result.data[0]
            logger.info(f"Using default agent: {agent_config['name']} ({agent_config['agent_id']})")
    
    can_use, model_message, allowed_models = await can_use_model(client, account_id, model_name)
    if not can_use:
        raise HTTPException(status_code=403, detail={"message": model_message, "allowed_models": allowed_models})

    can_run, message, subscription = await check_billing_status(client, account_id)
    if not can_run:
        raise HTTPException(status_code=402, detail={"message": message, "subscription": subscription})

    try:
        # 1. Create Project
        placeholder_name = f"{prompt[:30]}..." if len(prompt) > 30 else prompt
        project = await client.table('projects').insert({
            "project_id": str(uuid.uuid4()), "account_id": account_id, "name": placeholder_name,
            "created_at": datetime.now(timezone.utc).isoformat()
        }).execute()
        project_id = project.data[0]['project_id']
        logger.info(f"Created new project: {project_id}")

        # 2. Create Sandbox
        sandbox_id = None
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
        except Exception as e:
            logger.error(f"Error creating sandbox: {str(e)}")
            await client.table('projects').delete().eq('project_id', project_id).execute()
            if sandbox_id:
              try: await delete_sandbox(sandbox_id)
              except Exception as e: pass
            raise Exception("Failed to create sandbox")


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
            logger.info(f"Using agent {agent_config['agent_id']} for this conversation (thread remains agent-agnostic)")
            structlog.contextvars.bind_contextvars(
                agent_id=agent_config['agent_id'],
            )
        
        # Store agent builder metadata if this is an agent builder session
        if is_agent_builder:
            thread_data["metadata"] = {
                "is_agent_builder": True,
                "target_agent_id": target_agent_id
            }
            logger.info(f"Storing agent builder metadata in thread: target_agent_id={target_agent_id}")
            structlog.contextvars.bind_contextvars(
                target_agent_id=target_agent_id,
            )
        
        thread = await client.table('threads').insert(thread_data).execute()
        thread_id = thread.data[0]['thread_id']
        logger.info(f"Created new thread: {thread_id}")

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
                        logger.info(f"Attempting to upload {safe_filename} to {target_path} in sandbox {sandbox_id}")
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
                                    logger.info(f"Successfully uploaded and verified file {safe_filename} to sandbox path {target_path}")
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

        # 6. Start Agent Run
        agent_run = await client.table('agent_runs').insert({
            "thread_id": thread_id, "status": "running",
            "started_at": datetime.now(timezone.utc).isoformat(),
            "agent_id": agent_config.get('agent_id') if agent_config else None,
            "agent_version_id": agent_config.get('current_version_id') if agent_config else None
        }).execute()
        agent_run_id = agent_run.data[0]['id']
        logger.info(f"Created new agent run: {agent_run_id}")
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
            is_agent_builder=is_agent_builder,
            target_agent_id=target_agent_id,
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
    tools: Optional[str] = Query(None, description="Comma-separated list of tools to filter by")
):
    """Get agents for the current user with pagination, search, sort, and filter support."""
    if not await is_enabled("custom_agents"):
        raise HTTPException(
            status_code=403, 
            detail="Custom agents currently disabled. This feature is not available at the moment."
        )
    logger.info(f"Fetching agents for user: {user_id} with page={page}, limit={limit}, search='{search}', sort_by={sort_by}, sort_order={sort_order}")
    client = await db.client
    
    try:
        # Calculate offset
        offset = (page - 1) * limit
        
        # Start building the query - include version data
        query = client.table('agents').select('*, agent_versions!current_version_id(*)', count='exact').eq("account_id", user_id)
        
        # Apply search filter
        if search:
            search_term = f"%{search}%"
            query = query.or_(f"name.ilike.{search_term},description.ilike.{search_term}")
        
        # Apply filters
        if has_default is not None:
            query = query.eq("is_default", has_default)
        
        # For MCP and AgentPress tools filtering, we'll need to do post-processing
        # since Supabase doesn't have great JSON array/object filtering
        
        # Apply sorting
        if sort_by == "name":
            query = query.order("name", desc=(sort_order == "desc"))
        elif sort_by == "updated_at":
            query = query.order("updated_at", desc=(sort_order == "desc"))
        elif sort_by == "created_at":
            query = query.order("created_at", desc=(sort_order == "desc"))
        else:
            # Default to created_at
            query = query.order("created_at", desc=(sort_order == "desc"))
        
        # Execute query to get total count first
        count_result = await query.execute()
        total_count = count_result.count
        
        # Now get the actual data with pagination
        query = query.range(offset, offset + limit - 1)
        agents_result = await query.execute()
        
        if not agents_result.data:
            logger.info(f"No agents found for user: {user_id}")
            return {
                "agents": [],
                "pagination": {
                    "page": page,
                    "limit": limit,
                    "total": 0,
                    "pages": 0
                }
            }
        
        # Post-process for tool filtering and tools_count sorting
        agents_data = agents_result.data
        
        # Apply tool-based filters
        if has_mcp_tools is not None or has_agentpress_tools is not None or tools:
            filtered_agents = []
            tools_filter = []
            if tools:
                tools_filter = [tool.strip() for tool in tools.split(',') if tool.strip()]
            
            for agent in agents_data:
                # Check MCP tools filter
                if has_mcp_tools is not None:
                    has_mcp = bool(agent.get('configured_mcps') and len(agent.get('configured_mcps', [])) > 0)
                    if has_mcp_tools != has_mcp:
                        continue
                
                # Check AgentPress tools filter
                if has_agentpress_tools is not None:
                    agentpress_tools = agent.get('agentpress_tools', {})
                    has_enabled_tools = any(
                        tool_data and isinstance(tool_data, dict) and tool_data.get('enabled', False)
                        for tool_data in agentpress_tools.values()
                    )
                    if has_agentpress_tools != has_enabled_tools:
                        continue
                
                # Check specific tools filter
                if tools_filter:
                    agent_tools = set()
                    # Add MCP tools
                    for mcp in agent.get('configured_mcps', []):
                        if isinstance(mcp, dict) and 'name' in mcp:
                            agent_tools.add(f"mcp:{mcp['name']}")
                    
                    # Add enabled AgentPress tools
                    for tool_name, tool_data in agent.get('agentpress_tools', {}).items():
                        if tool_data and isinstance(tool_data, dict) and tool_data.get('enabled', False):
                            agent_tools.add(f"agentpress:{tool_name}")
                    
                    # Check if any of the requested tools are present
                    if not any(tool in agent_tools for tool in tools_filter):
                        continue
                
                filtered_agents.append(agent)
            
            agents_data = filtered_agents
        
        # Handle tools_count sorting (post-processing required)
        if sort_by == "tools_count":
            def get_tools_count(agent):
                mcp_count = len(agent.get('configured_mcps', []))
                agentpress_count = sum(
                    1 for tool_data in agent.get('agentpress_tools', {}).values()
                    if tool_data and isinstance(tool_data, dict) and tool_data.get('enabled', False)
                )
                return mcp_count + agentpress_count
            
            agents_data.sort(key=get_tools_count, reverse=(sort_order == "desc"))
        
        # Apply pagination to filtered results if we did post-processing
        if has_mcp_tools is not None or has_agentpress_tools is not None or tools or sort_by == "tools_count":
            total_count = len(agents_data)
            agents_data = agents_data[offset:offset + limit]
        
        # Format the response
        agent_list = []
        for agent in agents_data:
            current_version = None
            if agent.get('agent_versions'):
                version_data = agent['agent_versions']
                current_version = AgentVersionResponse(
                    version_id=version_data['version_id'],
                    agent_id=version_data['agent_id'],
                    version_number=version_data['version_number'],
                    version_name=version_data['version_name'],
                    system_prompt=version_data['system_prompt'],
                    configured_mcps=version_data.get('configured_mcps', []),
                    custom_mcps=version_data.get('custom_mcps', []),
                    agentpress_tools=version_data.get('agentpress_tools', {}),
                    is_active=version_data.get('is_active', True),
                    created_at=version_data['created_at'],
                    updated_at=version_data.get('updated_at', version_data['created_at']),
                    created_by=version_data.get('created_by')
                )
            
            agent_list.append(AgentResponse(
                agent_id=agent['agent_id'],
                account_id=agent['account_id'],
                name=agent['name'],
                description=agent.get('description'),
                system_prompt=agent['system_prompt'],
                configured_mcps=agent.get('configured_mcps', []),
                custom_mcps=agent.get('custom_mcps', []),
                agentpress_tools=agent.get('agentpress_tools', {}),
                is_default=agent.get('is_default', False),
                is_public=agent.get('is_public', False),
                marketplace_published_at=agent.get('marketplace_published_at'),
                download_count=agent.get('download_count', 0),
                tags=agent.get('tags', []),
                avatar=agent.get('avatar'),
                avatar_color=agent.get('avatar_color'),
                created_at=agent['created_at'],
                updated_at=agent['updated_at'],
                current_version_id=agent.get('current_version_id'),
                version_count=agent.get('version_count', 1),
                current_version=current_version
            ))
        
        total_pages = (total_count + limit - 1) // limit
        
        logger.info(f"Found {len(agent_list)} agents for user: {user_id} (page {page}/{total_pages})")
        return {
            "agents": agent_list,
            "pagination": {
                "page": page,
                "limit": limit,
                "total": total_count,
                "pages": total_pages
            }
        }
        
    except Exception as e:
        logger.error(f"Error fetching agents for user {user_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to fetch agents: {str(e)}")

@router.get("/agents/{agent_id}", response_model=AgentResponse)
async def get_agent(agent_id: str, user_id: str = Depends(get_current_user_id_from_jwt)):
    """Get a specific agent by ID with current version information. Only the owner can access non-public agents."""
    if not await is_enabled("custom_agents"):
        raise HTTPException(
            status_code=403, 
            detail="Custom agents currently disabled. This feature is not available at the moment."
        )
    
    logger.info(f"Fetching agent {agent_id} for user: {user_id}")
    client = await db.client
    
    try:
        # Get agent with current version data
        agent = await client.table('agents').select('*, agent_versions!current_version_id(*)').eq("agent_id", agent_id).execute()
        
        if not agent.data:
            raise HTTPException(status_code=404, detail="Agent not found")
        
        agent_data = agent.data[0]
        
        # Check ownership - only owner can access non-public agents
        if agent_data['account_id'] != user_id and not agent_data.get('is_public', False):
            raise HTTPException(status_code=403, detail="Access denied")
        
        # Prepare current version data
        current_version = None
        if agent_data.get('agent_versions'):
            version_data = agent_data['agent_versions']
            current_version = AgentVersionResponse(
                version_id=version_data['version_id'],
                agent_id=version_data['agent_id'],
                version_number=version_data['version_number'],
                version_name=version_data['version_name'],
                system_prompt=version_data['system_prompt'],
                configured_mcps=version_data.get('configured_mcps', []),
                custom_mcps=version_data.get('custom_mcps', []),
                agentpress_tools=version_data.get('agentpress_tools', {}),
                is_active=version_data.get('is_active', True),
                created_at=version_data['created_at'],
                updated_at=version_data.get('updated_at', version_data['created_at']),
                created_by=version_data.get('created_by')
            )
        
        return AgentResponse(
            agent_id=agent_data['agent_id'],
            account_id=agent_data['account_id'],
            name=agent_data['name'],
            description=agent_data.get('description'),
            system_prompt=agent_data['system_prompt'],
            configured_mcps=agent_data.get('configured_mcps', []),
            custom_mcps=agent_data.get('custom_mcps', []),
            agentpress_tools=agent_data.get('agentpress_tools', {}),
            is_default=agent_data.get('is_default', False),
            is_public=agent_data.get('is_public', False),
            marketplace_published_at=agent_data.get('marketplace_published_at'),
            download_count=agent_data.get('download_count', 0),
            tags=agent_data.get('tags', []),
            avatar=agent_data.get('avatar'),
            avatar_color=agent_data.get('avatar_color'),
            created_at=agent_data['created_at'],
            updated_at=agent_data.get('updated_at', agent_data['created_at']),
            current_version_id=agent_data.get('current_version_id'),
            version_count=agent_data.get('version_count', 1),
            current_version=current_version
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching agent {agent_id} for user {user_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to fetch agent: {str(e)}")

@router.post("/agents", response_model=AgentResponse)
async def create_agent(
    agent_data: AgentCreateRequest,
    user_id: str = Depends(get_current_user_id_from_jwt)
):
    """Create a new agent with automatic v1 version."""
    logger.info(f"Creating new agent for user: {user_id}")
    if not await is_enabled("custom_agents"):
        raise HTTPException(
            status_code=403, 
            detail="Custom agents currently disabled. This feature is not available at the moment."
        )
    client = await db.client
    
    try:
        # If this is set as default, we need to unset other defaults first
        if agent_data.is_default:
            await client.table('agents').update({"is_default": False}).eq("account_id", user_id).eq("is_default", True).execute()
        
        # Create the agent
        insert_data = {
            "account_id": user_id,
            "name": agent_data.name,
            "description": agent_data.description,
            "system_prompt": agent_data.system_prompt, 
            "configured_mcps": agent_data.configured_mcps or [],
            "custom_mcps": agent_data.custom_mcps or [],
            "agentpress_tools": agent_data.agentpress_tools or {},
            "is_default": agent_data.is_default or False,
            "avatar": agent_data.avatar,
            "avatar_color": agent_data.avatar_color,
            "version_count": 1
        }
        
        new_agent = await client.table('agents').insert(insert_data).execute()
        
        if not new_agent.data:
            raise HTTPException(status_code=500, detail="Failed to create agent")
        
        agent = new_agent.data[0]
        
        # Create v1 version automatically
        version_data = {
            "agent_id": agent['agent_id'],
            "version_number": 1,
            "version_name": "v1",
            "system_prompt": agent_data.system_prompt,
            "configured_mcps": agent_data.configured_mcps or [],
            "custom_mcps": agent_data.custom_mcps or [],
            "agentpress_tools": agent_data.agentpress_tools or {},
            "is_active": True,
            "created_by": user_id
        }
        
        new_version = await client.table('agent_versions').insert(version_data).execute()
        
        if new_version.data:
            version = new_version.data[0]
            # Update agent with current version
            await client.table('agents').update({
                "current_version_id": version['version_id']
            }).eq("agent_id", agent['agent_id']).execute()
            
            # Add version history entry
            await client.table('agent_version_history').insert({
                "agent_id": agent['agent_id'],
                "version_id": version['version_id'],
                "action": "created",
                "changed_by": user_id,
                "change_description": "Initial version v1 created"
            }).execute()
            
            agent['current_version_id'] = version['version_id']
            agent['current_version'] = version
        
        logger.info(f"Created agent {agent['agent_id']} with v1 for user: {user_id}")
        
        return AgentResponse(
            agent_id=agent['agent_id'],
            account_id=agent['account_id'],
            name=agent['name'],
            description=agent.get('description'),
            system_prompt=agent['system_prompt'],
            configured_mcps=agent.get('configured_mcps', []),
            custom_mcps=agent.get('custom_mcps', []),
            agentpress_tools=agent.get('agentpress_tools', {}),
            is_default=agent.get('is_default', False),
            is_public=agent.get('is_public', False),
            marketplace_published_at=agent.get('marketplace_published_at'),
            download_count=agent.get('download_count', 0),
            tags=agent.get('tags', []),
            avatar=agent.get('avatar'),
            avatar_color=agent.get('avatar_color'),
            created_at=agent['created_at'],
            updated_at=agent.get('updated_at', agent['created_at']),
            current_version_id=agent.get('current_version_id'),
            version_count=agent.get('version_count', 1),
            current_version=agent.get('current_version')
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error creating agent for user {user_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to create agent: {str(e)}")

@router.put("/agents/{agent_id}", response_model=AgentResponse)
async def update_agent(
    agent_id: str,
    agent_data: AgentUpdateRequest,
    user_id: str = Depends(get_current_user_id_from_jwt)
):
    """Update an existing agent. Creates a new version if system prompt, tools, or MCPs are changed."""
    if not await is_enabled("custom_agents"):
        raise HTTPException(
            status_code=403, 
            detail="Custom agent currently disabled. This feature is not available at the moment."
        )
    logger.info(f"Updating agent {agent_id} for user: {user_id}")
    client = await db.client
    
    try:
        existing_agent = await client.table('agents').select('*, agent_versions!current_version_id(*)').eq("agent_id", agent_id).eq("account_id", user_id).maybe_single().execute()
        
        if not existing_agent.data:
            raise HTTPException(status_code=404, detail="Agent not found")
        
        existing_data = existing_agent.data
        current_version_data = existing_data.get('agent_versions')
        
        if current_version_data is None:
            logger.info(f"Agent {agent_id} has no version data, creating initial version")
            try:
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
                
                version_result = await client.table('agent_versions').insert(initial_version_data).execute()
                
                if version_result.data:
                    version_id = version_result.data[0]['version_id']
                    
                    await client.table('agents').update({
                        'current_version_id': version_id,
                        'version_count': 1
                    }).eq('agent_id', agent_id).execute()
                    current_version_data = initial_version_data
                    logger.info(f"Created initial version for agent {agent_id}")
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
            version_changes['custom_mcps'] = agent_data.custom_mcps
            
        if values_different(agent_data.agentpress_tools, current_version_data.get('agentpress_tools', {})):
            needs_new_version = True
            version_changes['agentpress_tools'] = agent_data.agentpress_tools
        
        # Prepare update data for agent metadata (non-versioned fields)
        update_data = {}
        if agent_data.name is not None:
            update_data["name"] = agent_data.name
        if agent_data.description is not None:
            update_data["description"] = agent_data.description
        if agent_data.is_default is not None:
            update_data["is_default"] = agent_data.is_default
            # If setting as default, unset other defaults first
            if agent_data.is_default:
                await client.table('agents').update({"is_default": False}).eq("account_id", user_id).eq("is_default", True).neq("agent_id", agent_id).execute()
        if agent_data.avatar is not None:
            update_data["avatar"] = agent_data.avatar
        if agent_data.avatar_color is not None:
            update_data["avatar_color"] = agent_data.avatar_color
        
        # Also update the agent table with the latest values (for backward compatibility)
        if agent_data.system_prompt is not None:
            update_data["system_prompt"] = agent_data.system_prompt
        if agent_data.configured_mcps is not None:
            update_data["configured_mcps"] = agent_data.configured_mcps
        if agent_data.custom_mcps is not None:
            update_data["custom_mcps"] = agent_data.custom_mcps
        if agent_data.agentpress_tools is not None:
            update_data["agentpress_tools"] = agent_data.agentpress_tools
        
        # Create new version if needed
        new_version_id = None
        if needs_new_version:
            try:
                # Get next version number
                versions_result = await client.table('agent_versions').select('version_number').eq('agent_id', agent_id).order('version_number', desc=True).limit(1).execute()
                next_version_number = 1
                if versions_result.data:
                    next_version_number = versions_result.data[0]['version_number'] + 1
                
                # Validate version data before creating
                new_version_data = {
                    "agent_id": agent_id,
                    "version_number": next_version_number,
                    "version_name": f"v{next_version_number}",
                    "system_prompt": version_changes.get('system_prompt', current_version_data.get('system_prompt', '')),
                    "configured_mcps": version_changes.get('configured_mcps', current_version_data.get('configured_mcps', [])),
                    "custom_mcps": version_changes.get('custom_mcps', current_version_data.get('custom_mcps', [])),
                    "agentpress_tools": version_changes.get('agentpress_tools', current_version_data.get('agentpress_tools', {})),
                    "is_active": True,
                    "created_by": user_id
                }
                
                # Validate system prompt is not empty
                if not new_version_data["system_prompt"] or new_version_data["system_prompt"].strip() == '':
                    raise HTTPException(status_code=400, detail="System prompt cannot be empty")
                
                new_version = await client.table('agent_versions').insert(new_version_data).execute()
                
                if not new_version.data:
                    raise HTTPException(status_code=500, detail="Failed to create new agent version")
                
                new_version_id = new_version.data[0]['version_id']
                update_data['current_version_id'] = new_version_id
                update_data['version_count'] = next_version_number
                
                # Add version history entry
                try:
                    await client.table('agent_version_history').insert({
                        "agent_id": agent_id,
                        "version_id": new_version_id,
                        "action": "created",
                        "changed_by": user_id,
                        "change_description": f"New version v{next_version_number} created from update"
                    }).execute()
                except Exception as e:
                    logger.warning(f"Failed to create version history entry: {e}")
                
                logger.info(f"Created new version v{next_version_number} for agent {agent_id}")
                
            except HTTPException:
                raise
            except Exception as e:
                logger.error(f"Error creating new version for agent {agent_id}: {str(e)}")
                raise HTTPException(status_code=500, detail=f"Failed to create new agent version: {str(e)}")
        
        # Update the agent if there are changes
        if update_data:
            try:
                update_result = await client.table('agents').update(update_data).eq("agent_id", agent_id).eq("account_id", user_id).execute()
                
                if not update_result.data:
                    raise HTTPException(status_code=500, detail="Failed to update agent - no rows affected")
            except Exception as e:
                logger.error(f"Error updating agent {agent_id}: {str(e)}")
                raise HTTPException(status_code=500, detail=f"Failed to update agent: {str(e)}")
        
        # Fetch the updated agent data with version info
        updated_agent = await client.table('agents').select('*, agent_versions!current_version_id(*)').eq("agent_id", agent_id).eq("account_id", user_id).maybe_single().execute()
        
        if not updated_agent.data:
            raise HTTPException(status_code=500, detail="Failed to fetch updated agent")
        
        agent = updated_agent.data
        
        # Prepare current version response
        current_version = None
        if agent.get('agent_versions'):
            version_data = agent['agent_versions']
            current_version = AgentVersionResponse(
                version_id=version_data['version_id'],
                agent_id=version_data['agent_id'],
                version_number=version_data['version_number'],
                version_name=version_data['version_name'],
                system_prompt=version_data['system_prompt'],
                configured_mcps=version_data.get('configured_mcps', []),
                custom_mcps=version_data.get('custom_mcps', []),
                agentpress_tools=version_data.get('agentpress_tools', {}),
                is_active=version_data.get('is_active', True),
                created_at=version_data['created_at'],
                updated_at=version_data.get('updated_at', version_data['created_at']),
                created_by=version_data.get('created_by')
            )
        
        logger.info(f"Updated agent {agent_id} for user: {user_id}")
        
        return AgentResponse(
            agent_id=agent['agent_id'],
            account_id=agent['account_id'],
            name=agent['name'],
            description=agent.get('description'),
            system_prompt=agent['system_prompt'],
            configured_mcps=agent.get('configured_mcps', []),
            custom_mcps=agent.get('custom_mcps', []),
            agentpress_tools=agent.get('agentpress_tools', {}),
            is_default=agent.get('is_default', False),
            is_public=agent.get('is_public', False),
            marketplace_published_at=agent.get('marketplace_published_at'),
            download_count=agent.get('download_count', 0),
            tags=agent.get('tags', []),
            avatar=agent.get('avatar'),
            avatar_color=agent.get('avatar_color'),
            created_at=agent['created_at'],
            updated_at=agent.get('updated_at', agent['created_at']),
            current_version_id=agent.get('current_version_id'),
            version_count=agent.get('version_count', 1),
            current_version=current_version
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating agent {agent_id} for user {user_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to update agent: {str(e)}")

@router.delete("/agents/{agent_id}")
async def delete_agent(agent_id: str, user_id: str = Depends(get_current_user_id_from_jwt)):
    """Delete an agent."""
    if not await is_enabled("custom_agents"):
        raise HTTPException(
            status_code=403, 
            detail="Custom agent currently disabled. This feature is not available at the moment."
        )
    logger.info(f"Deleting agent: {agent_id}")
    client = await db.client
    
    try:
        # Verify agent ownership
        agent_result = await client.table('agents').select('*').eq('agent_id', agent_id).execute()
        if not agent_result.data:
            raise HTTPException(status_code=404, detail="Agent not found")
        
        agent = agent_result.data[0]
        if agent['account_id'] != user_id:
            raise HTTPException(status_code=403, detail="Access denied")
        
        # Check if agent is default
        if agent['is_default']:
            raise HTTPException(status_code=400, detail="Cannot delete default agent")
        
        # Delete the agent
        await client.table('agents').delete().eq('agent_id', agent_id).execute()
        
        logger.info(f"Successfully deleted agent: {agent_id}")
        return {"message": "Agent deleted successfully"}
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting agent {agent_id}: {str(e)}")
        raise HTTPException(status_code=500, detail="Internal server error")

@router.get("/agents/{agent_id}/builder-chat-history")
async def get_agent_builder_chat_history(
    agent_id: str,
    user_id: str = Depends(get_current_user_id_from_jwt)
):
    """Get chat history for agent builder sessions for a specific agent."""
    if not await is_enabled("custom_agents"):
        raise HTTPException(
            status_code=403, 
            detail="Custom agents currently disabled. This feature is not available at the moment."
        )
    
    logger.info(f"Fetching agent builder chat history for agent: {agent_id}")
    client = await db.client
    
    try:
        # First verify the agent exists and belongs to the user
        agent_result = await client.table('agents').select('*').eq('agent_id', agent_id).eq('account_id', user_id).execute()
        if not agent_result.data:
            raise HTTPException(status_code=404, detail="Agent not found or access denied")
        
        # Get all threads for this user with metadata field included
        threads_result = await client.table('threads').select('thread_id, created_at, metadata').eq('account_id', user_id).order('created_at', desc=True).execute()
        
        agent_builder_threads = []
        for thread in threads_result.data:
            metadata = thread.get('metadata', {})
            # Check if this is an agent builder thread for the specific agent
            if (metadata.get('is_agent_builder') and 
                metadata.get('target_agent_id') == agent_id):
                agent_builder_threads.append({
                    'thread_id': thread['thread_id'],
                    'created_at': thread['created_at']
                })
        
        if not agent_builder_threads:
            logger.info(f"No agent builder threads found for agent {agent_id}")
            return {"messages": [], "thread_id": None}
        
        # Get the most recent thread (already ordered by created_at desc)
        latest_thread_id = agent_builder_threads[0]['thread_id']
        logger.info(f"Found {len(agent_builder_threads)} agent builder threads, using latest: {latest_thread_id}")
        
        # Get messages from the latest thread, excluding status and summary messages
        messages_result = await client.table('messages').select('*').eq('thread_id', latest_thread_id).neq('type', 'status').neq('type', 'summary').order('created_at', desc=False).execute()
        
        logger.info(f"Found {len(messages_result.data)} messages for agent builder chat history")
        return {
            "messages": messages_result.data,
            "thread_id": latest_thread_id
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching agent builder chat history for agent {agent_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to fetch chat history: {str(e)}")

# agent versioning

@router.get("/agents/{agent_id}/versions", response_model=List[AgentVersionResponse])
async def get_agent_versions(
    agent_id: str,
    user_id: str = Depends(get_current_user_id_from_jwt)
):
    """Get all versions of an agent."""
    client = await db.client
    
    # Check if user has access to this agent
    agent_result = await client.table('agents').select("*").eq("agent_id", agent_id).execute()
    if not agent_result.data:
        raise HTTPException(status_code=404, detail="Agent not found")
    
    agent = agent_result.data[0]
    if agent['account_id'] != user_id and not agent.get('is_public', False):
        raise HTTPException(status_code=403, detail="Access denied")
    
    # Get all versions
    versions_result = await client.table('agent_versions').select("*").eq("agent_id", agent_id).order("version_number", desc=True).execute()
    
    return versions_result.data

@router.post("/agents/{agent_id}/versions", response_model=AgentVersionResponse)
async def create_agent_version(
    agent_id: str,
    version_data: AgentVersionCreateRequest,
    user_id: str = Depends(get_current_user_id_from_jwt)
):
    """Create a new version of an agent."""
    client = await db.client
    
    # Check if user owns this agent
    agent_result = await client.table('agents').select("*").eq("agent_id", agent_id).eq("account_id", user_id).execute()
    if not agent_result.data:
        raise HTTPException(status_code=404, detail="Agent not found or access denied")
    
    agent = agent_result.data[0]
    
    # Get next version number
    versions_result = await client.table('agent_versions').select("version_number").eq("agent_id", agent_id).order("version_number", desc=True).limit(1).execute()
    next_version_number = 1
    if versions_result.data:
        next_version_number = versions_result.data[0]['version_number'] + 1
    
    # Create new version
    new_version_data = {
        "agent_id": agent_id,
        "version_number": next_version_number,
        "version_name": f"v{next_version_number}",
        "system_prompt": version_data.system_prompt,
        "configured_mcps": version_data.configured_mcps or [],
        "custom_mcps": version_data.custom_mcps or [],
        "agentpress_tools": version_data.agentpress_tools or {},
        "is_active": True,
        "created_by": user_id
    }
    
    new_version = await client.table('agent_versions').insert(new_version_data).execute()
    
    if not new_version.data:
        raise HTTPException(status_code=500, detail="Failed to create version")
    
    version = new_version.data[0]
    
    # Update agent with new version
    await client.table('agents').update({
        "current_version_id": version['version_id'],
        "version_count": next_version_number
    }).eq("agent_id", agent_id).execute()
    
    # Add version history entry
    await client.table('agent_version_history').insert({
        "agent_id": agent_id,
        "version_id": version['version_id'],
        "action": "created",
        "changed_by": user_id,
        "change_description": f"New version v{next_version_number} created"
    }).execute()
    
    logger.info(f"Created version v{next_version_number} for agent {agent_id}")
    
    return version

@router.put("/agents/{agent_id}/versions/{version_id}/activate")
async def activate_agent_version(
    agent_id: str,
    version_id: str,
    user_id: str = Depends(get_current_user_id_from_jwt)
):
    """Switch agent to use a specific version."""
    client = await db.client
    
    # Check if user owns this agent
    agent_result = await client.table('agents').select("*").eq("agent_id", agent_id).eq("account_id", user_id).execute()
    if not agent_result.data:
        raise HTTPException(status_code=404, detail="Agent not found or access denied")
    
    # Check if version exists
    version_result = await client.table('agent_versions').select("*").eq("version_id", version_id).eq("agent_id", agent_id).execute()
    if not version_result.data:
        raise HTTPException(status_code=404, detail="Version not found")
    
    # Update agent's current version
    await client.table('agents').update({
        "current_version_id": version_id
    }).eq("agent_id", agent_id).execute()
    
    # Add version history entry
    await client.table('agent_version_history').insert({
        "agent_id": agent_id,
        "version_id": version_id,
        "action": "activated",
        "changed_by": user_id,
        "change_description": f"Switched to version {version_result.data[0]['version_name']}"
    }).execute()
    
    return {"message": "Version activated successfully"}

@router.get("/agents/{agent_id}/versions/{version_id}", response_model=AgentVersionResponse)
async def get_agent_version(
    agent_id: str,
    version_id: str,
    user_id: str = Depends(get_current_user_id_from_jwt)
):
    """Get a specific version of an agent."""
    client = await db.client
    
    # Check if user has access to this agent
    agent_result = await client.table('agents').select("*").eq("agent_id", agent_id).execute()
    if not agent_result.data:
        raise HTTPException(status_code=404, detail="Agent not found")
    
    agent = agent_result.data[0]
    if agent['account_id'] != user_id and not agent.get('is_public', False):
        raise HTTPException(status_code=403, detail="Access denied")
    
    # Get the specific version
    version_result = await client.table('agent_versions').select("*").eq("version_id", version_id).eq("agent_id", agent_id).execute()
    
    if not version_result.data:
        raise HTTPException(status_code=404, detail="Version not found")
    
    return version_result.data[0]