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
# Billing checks now handled by billing_integration.check_model_and_billing_access
from core.billing.billing_integration import billing_integration
from core.utils.config import config, EnvMode
from core.services import redis
from core.sandbox.sandbox import create_sandbox, delete_sandbox
from core.utils.sandbox_utils import generate_unique_filename, get_uploads_directory
from run_agent_background import run_agent_background
from core.ai_models import model_manager

from .api_models import AgentStartRequest, AgentVersionResponse, AgentResponse, ThreadAgentResponse, InitiateAgentResponse
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

@router.post("/thread/{thread_id}/agent/start", summary="Start Agent Run", operation_id="start_agent_run")
async def start_agent(
    thread_id: str,
    body: AgentStartRequest = Body(...),
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """Start an agent for a specific thread in the background"""
    structlog.contextvars.bind_contextvars(
        thread_id=thread_id,
    )
    if not utils.instance_id:
        raise HTTPException(status_code=500, detail="Agent API not initialized with instance ID")

    # Use model from config if not specified in the request
    model_name = body.model_name
    logger.debug(f"Original model_name from request: {model_name}")

    # Log the model name after alias resolution using new model manager
    from core.ai_models import model_manager
    resolved_model = model_manager.resolve_model_id(model_name)
    logger.debug(f"Resolved model name: {resolved_model}")

    # Update model_name to use the resolved version
    model_name = resolved_model

    logger.debug(f"Starting new agent for thread: {thread_id} with config: model={model_name} (Instance: {utils.instance_id})")
    client = await utils.db.client


    thread_result = await client.table('threads').select('project_id', 'account_id', 'metadata').eq('thread_id', thread_id).execute()

    if not thread_result.data:
        raise HTTPException(status_code=404, detail="Thread not found")
    thread_data = thread_result.data[0]
    project_id = thread_data.get('project_id')
    account_id = thread_data.get('account_id')
    thread_metadata = thread_data.get('metadata', {})

    if account_id != user_id:
        await verify_and_authorize_thread_access(client, thread_id, user_id)

    structlog.contextvars.bind_contextvars(
        project_id=project_id,
        account_id=account_id,
        thread_metadata=thread_metadata,
    )
    
    # Load agent configuration using unified loader
    from .agent_loader import get_agent_loader
    loader = await get_agent_loader()
    
    agent_data = None
    effective_agent_id = body.agent_id
    
    logger.debug(f"[AGENT LOAD] Loading agent: {effective_agent_id or 'default'}")
    
    # Try to load specified agent
    if effective_agent_id:
        try:
            agent_data = await loader.load_agent(effective_agent_id, user_id, load_config=True)
            logger.debug(f"Using agent {agent_data.name} ({effective_agent_id}) version {agent_data.version_name}")
        except HTTPException as e:
            if body.agent_id:
                raise  # Explicit agent not found - fail
            logger.warning(f"Stored agent_id {effective_agent_id} not found, falling back to default")
    
    # Fall back to default agent
    if not agent_data:
        logger.debug(f"[AGENT LOAD] Loading default agent")
        default_agent = await client.table('agents').select('agent_id').eq('account_id', account_id).eq('is_default', True).maybe_single().execute()
        
        if default_agent.data:
            agent_data = await loader.load_agent(default_agent.data['agent_id'], user_id, load_config=True)
            logger.debug(f"Using default agent: {agent_data.name} ({agent_data.agent_id}) version {agent_data.version_name}")
        else:
            logger.warning(f"[AGENT LOAD] No default agent found for account {account_id}")
    
    # Convert to dict for backward compatibility with rest of function
    agent_config = agent_data.to_dict() if agent_data else None
    
    if agent_config:
        logger.debug(f"Using agent {agent_config['agent_id']} for this agent run (thread remains agent-agnostic)")

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
    
    # Check agent run limits (only if not in local mode)
    if config.ENV_MODE != EnvMode.LOCAL:
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
            "model_name": effective_model
        }
    }).execute()

    agent_run_id = agent_run.data[0]['id']
    structlog.contextvars.bind_contextvars(
        agent_run_id=agent_run_id,
    )
    logger.debug(f"Created new agent run: {agent_run_id}")

    instance_key = f"active_run:{utils.instance_id}:{agent_run_id}"
    try:
        await redis.set(instance_key, "running", ex=redis.REDIS_KEY_TTL)
    except Exception as e:
        logger.warning(f"Failed to register agent run in Redis ({instance_key}): {str(e)}")

    request_id = structlog.contextvars.get_contextvars().get('request_id')

    run_agent_background.send(
        agent_run_id=agent_run_id, thread_id=thread_id, instance_id=utils.instance_id,
        project_id=project_id,
        model_name=model_name,  # Already resolved above
        agent_config=agent_config,  # Pass agent configuration
        request_id=request_id,
    )

    return {"agent_run_id": agent_run_id, "status": "running"}

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



@router.post("/agent/initiate", response_model=InitiateAgentResponse, summary="Initiate Agent Session", operation_id="initiate_agent_session")
async def initiate_agent_with_files(
    prompt: str = Form(...),
    model_name: Optional[str] = Form(None),  # Default to None to use default model
    agent_id: Optional[str] = Form(None),  # Add agent_id parameter
    files: List[UploadFile] = File(default=[]),
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """
    Initiate a new agent session with optional file attachments.

    [WARNING] Keep in sync with create thread endpoint.
    """
    if not utils.instance_id:
        raise HTTPException(status_code=500, detail="Agent API not initialized with instance ID")

    # Use model from config if not specified in the request
    logger.debug(f"Original model_name from request: {model_name}")

    client = await utils.db.client
    account_id = user_id # In Basejump, personal account_id is the same as user_id

    from core.ai_models import model_manager
    
    if model_name is None:
        # Use tier-based default model from registry
        model_name = await model_manager.get_default_model_for_user(client, account_id)
        logger.debug(f"Using tier-based default model: {model_name}")

    # Log the model name after alias resolution using new model manager
    resolved_model = model_manager.resolve_model_id(model_name)
    logger.debug(f"Resolved model name: {resolved_model}")

    # Update model_name to use the resolved version
    model_name = resolved_model

    logger.debug(f"Initiating new agent with prompt and {len(files)} files (Instance: {utils.instance_id}), model: {model_name}")
    
    # Load agent configuration using unified loader
    from .agent_loader import get_agent_loader
    loader = await get_agent_loader()
    
    agent_data = None
    
    logger.debug(f"[AGENT INITIATE] Loading agent: {agent_id or 'default'}")
    
    # Try to load specified agent
    if agent_id:
        agent_data = await loader.load_agent(agent_id, user_id, load_config=True)
        logger.debug(f"Using agent {agent_data.name} ({agent_id}) version {agent_data.version_name}")
    else:
        # Load default agent
        logger.debug(f"[AGENT INITIATE] Loading default agent")
        default_agent = await client.table('agents').select('agent_id').eq('account_id', account_id).eq('is_default', True).maybe_single().execute()
        
        if default_agent.data:
            agent_data = await loader.load_agent(default_agent.data['agent_id'], user_id, load_config=True)
            logger.debug(f"Using default agent: {agent_data.name} ({agent_data.agent_id}) version {agent_data.version_name}")
        else:
            logger.warning(f"[AGENT INITIATE] No default agent found for account {account_id}")
    
    # Convert to dict for backward compatibility with rest of function
    agent_config = agent_data.to_dict() if agent_data else None

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
    
    # Check additional limits (only if not in local mode)
    if config.ENV_MODE != EnvMode.LOCAL:
        # Check agent run limit and project limit concurrently
        limit_check_task = asyncio.create_task(check_agent_run_limit(client, account_id))
        project_limit_check_task = asyncio.create_task(check_project_count_limit(client, account_id))
        
        limit_check, project_limit_check = await asyncio.gather(
            limit_check_task, project_limit_check_task
        )
        
        # Check agent run limit (maximum parallel runs in past 24 hours)
        if not limit_check['can_start']:
            error_detail = {
                "message": f"Maximum of {config.MAX_PARALLEL_AGENT_RUNS} parallel agent runs allowed within 24 hours. You currently have {limit_check['running_count']} running.",
                "running_thread_ids": limit_check['running_thread_ids'],
                "running_count": limit_check['running_count'],
                "limit": config.MAX_PARALLEL_AGENT_RUNS
            }
            logger.warning(f"Agent run limit exceeded for account {account_id}: {limit_check['running_count']} running agents")
            raise HTTPException(status_code=429, detail=error_detail)

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
            uploads_dir = get_uploads_directory()
            
            for file in files:
                if file.filename:
                    try:
                        safe_filename = file.filename.replace('/', '_').replace('\\', '_')
                        
                        # Generate unique filename to avoid conflicts
                        unique_filename = await generate_unique_filename(sandbox, uploads_dir, safe_filename)
                        target_path = f"{uploads_dir}/{unique_filename}"
                        
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
                for file_path in successful_uploads: message_content += f"[Uploaded File: {file_path}]\n"
            if failed_uploads:
                message_content += "\n\nThe following files failed to upload:\n"
                for failed_file in failed_uploads: message_content += f"- {failed_file}\n"

        # 5. Add initial user message to thread
        message_id = str(uuid.uuid4())
        message_payload = {"role": "user", "content": message_content}
        await client.table('messages').insert({
            "message_id": message_id, "thread_id": thread_id, "type": "user",
            "is_llm_message": True, "content": message_payload,  # Store as JSONB object, not JSON string
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
                "model_name": effective_model
            }
        }).execute()
        agent_run_id = agent_run.data[0]['id']
        logger.debug(f"Created new agent run: {agent_run_id}")
        structlog.contextvars.bind_contextvars(
            agent_run_id=agent_run_id,
        )

        # Register run in Redis
        instance_key = f"active_run:{utils.instance_id}:{agent_run_id}"
        try:
            await redis.set(instance_key, "running", ex=redis.REDIS_KEY_TTL)
        except Exception as e:
            logger.warning(f"Failed to register agent run in Redis ({instance_key}): {str(e)}")

        request_id = structlog.contextvars.get_contextvars().get('request_id')

        # Run agent in background
        run_agent_background.send(
            agent_run_id=agent_run_id, thread_id=thread_id, instance_id=utils.instance_id,
            project_id=project_id,
            model_name=model_name,  # Already resolved above
            agent_config=agent_config,  # Pass agent configuration
            request_id=request_id,
        )

        return {"thread_id": thread_id, "agent_run_id": agent_run_id}

    except Exception as e:
        logger.error(f"Error in agent initiation: {str(e)}\n{traceback.format_exc()}")
        # TODO: Clean up created project/thread if initiation fails mid-way
        raise HTTPException(status_code=500, detail=f"Failed to initiate agent session: {str(e)}")

