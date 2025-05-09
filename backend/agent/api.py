from fastapi import APIRouter, HTTPException, Depends, Request, Body, File, UploadFile, Form
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
from agent.run import run_agent
from utils.auth_utils import get_current_user_id_from_jwt, get_user_id_from_stream_auth, verify_thread_access
from utils.logger import logger
from services.billing import check_billing_status
from utils.config import config
from sandbox.sandbox import create_sandbox, get_or_start_sandbox
from services.llm import make_llm_api_call
from agent.tasks import execute_agent_processing

# Initialize shared resources
router = APIRouter()
thread_manager = None
db = None
instance_id = None # Global instance ID for this backend instance

# TTL for Redis response lists (24 hours)
REDIS_RESPONSE_LIST_TTL = 3600 * 24

MODEL_NAME_ALIASES = {
    # Short names to full names
    "sonnet-3.7": "anthropic/claude-3-7-sonnet-latest",
    "gpt-4.1": "openai/gpt-4.1-2025-04-14",
    "gpt-4o": "openai/gpt-4o",
    "gpt-4-turbo": "openai/gpt-4-turbo",
    "gpt-4": "openai/gpt-4",
    "gemini-flash-2.5": "openrouter/google/gemini-2.5-flash-preview",
    "gemini-2.5-pro": "gemini/gemini-2.5-pro",
    "grok-3": "xai/grok-3-fast-latest",
    "deepseek": "openrouter/deepseek/deepseek-chat",
    "grok-3-mini": "xai/grok-3-mini-fast-beta",
    "qwen3": "openrouter/qwen/qwen3-235b-a22b", 

    # Also include full names as keys to ensure they map to themselves
    "anthropic/claude-3-7-sonnet-latest": "anthropic/claude-3-7-sonnet-latest",
    "openai/gpt-4.1-2025-04-14": "openai/gpt-4.1-2025-04-14",
    "openai/gpt-4o": "openai/gpt-4o",
    "openai/gpt-4-turbo": "openai/gpt-4-turbo",
    "openai/gpt-4": "openai/gpt-4",
    "openrouter/google/gemini-2.5-flash-preview": "openrouter/google/gemini-2.5-flash-preview",
    "xai/grok-3-fast-latest": "xai/grok-3-fast-latest",
    "deepseek/deepseek-chat": "openrouter/deepseek/deepseek-chat",
    "xai/grok-3-mini-fast-beta": "xai/grok-3-mini-fast-beta",
    "gemini/gemini-2.5-pro": "gemini/gemini-2.5-pro",
}

class AgentStartRequest(BaseModel):
    model_name: Optional[str] = None  # Will be set from config.MODEL_TO_USE in the endpoint
    enable_thinking: Optional[bool] = False
    reasoning_effort: Optional[str] = 'low'
    stream: Optional[bool] = True
    enable_context_manager: Optional[bool] = False

class InitiateAgentResponse(BaseModel):
    thread_id: str
    agent_run_id: Optional[str] = None

def initialize(
    _thread_manager: ThreadManager,
    _db: DBConnection,
    _instance_id: str = None
):
    """Initialize the agent API with resources from the main API."""
    global thread_manager, db, instance_id
    thread_manager = _thread_manager
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

async def update_agent_run_status(
    client,
    agent_run_id: str,
    status: str,
    error: Optional[str] = None,
    responses: Optional[List[Any]] = None # Expects parsed list of dicts
) -> bool:
    """
    Centralized function to update agent run status.
    Returns True if update was successful.
    """
    try:
        update_data = {
            "status": status,
            "completed_at": datetime.now(timezone.utc).isoformat()
        }

        if error:
            update_data["error"] = error

        if responses:
            # Ensure responses are stored correctly as JSONB
            update_data["responses"] = responses

        # Retry up to 3 times
        for retry in range(3):
            try:
                update_result = await client.table('agent_runs').update(update_data).eq("id", agent_run_id).execute()

                if hasattr(update_result, 'data') and update_result.data:
                    logger.info(f"Successfully updated agent run {agent_run_id} status to '{status}' (retry {retry})")

                    # Verify the update
                    verify_result = await client.table('agent_runs').select('status', 'completed_at').eq("id", agent_run_id).execute()
                    if verify_result.data:
                        actual_status = verify_result.data[0].get('status')
                        completed_at = verify_result.data[0].get('completed_at')
                        logger.info(f"Verified agent run update: status={actual_status}, completed_at={completed_at}")
                    return True
                else:
                    logger.warning(f"Database update returned no data for agent run {agent_run_id} on retry {retry}: {update_result}")
                    if retry == 2:  # Last retry
                        logger.error(f"Failed to update agent run status after all retries: {agent_run_id}")
                        return False
            except Exception as db_error:
                logger.error(f"Database error on retry {retry} updating status for {agent_run_id}: {str(db_error)}")
                if retry < 2:  # Not the last retry yet
                    await asyncio.sleep(0.5 * (2 ** retry))  # Exponential backoff
                else:
                    logger.error(f"Failed to update agent run status after all retries: {agent_run_id}", exc_info=True)
                    return False
    except Exception as e:
        logger.error(f"Unexpected error updating agent run status for {agent_run_id}: {str(e)}", exc_info=True)
        return False

    return False

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


async def _cleanup_redis_response_list(agent_run_id: str):
    """Set TTL on the Redis response list."""
    response_list_key = f"agent_run:{agent_run_id}:responses"
    try:
        await redis.expire(response_list_key, REDIS_RESPONSE_LIST_TTL)
        logger.debug(f"Set TTL ({REDIS_RESPONSE_LIST_TTL}s) on response list: {response_list_key}")
    except Exception as e:
        logger.warning(f"Failed to set TTL on response list {response_list_key}: {str(e)}")

async def restore_running_agent_runs():
    """Mark agent runs that were still 'running' in the database as failed and clean up Redis resources."""
    logger.info("Restoring running agent runs after server restart")
    client = await db.client
    running_agent_runs = await client.table('agent_runs').select('id').eq("status", "running").execute()

    for run in running_agent_runs.data:
        agent_run_id = run['id']
        logger.warning(f"Found running agent run {agent_run_id} from before server restart")

        # Clean up Redis resources for this run
        try:
            # Clean up active run key
            active_run_key = f"active_run:{instance_id}:{agent_run_id}"
            await redis.delete(active_run_key)

            # Clean up response list
            response_list_key = f"agent_run:{agent_run_id}:responses"
            await redis.delete(response_list_key)

            # Clean up control channels
            control_channel = f"agent_run:{agent_run_id}:control"
            instance_control_channel = f"agent_run:{agent_run_id}:control:{instance_id}"
            await redis.delete(control_channel)
            await redis.delete(instance_control_channel)

            logger.info(f"Cleaned up Redis resources for agent run {agent_run_id}")
        except Exception as e:
            logger.error(f"Error cleaning up Redis resources for agent run {agent_run_id}: {e}")

        # Call stop_agent_run to handle status update and cleanup
        await stop_agent_run(agent_run_id, error_message="Server restarted while agent was running")

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

async def _cleanup_redis_instance_key(agent_run_id: str):
    """Clean up the instance-specific Redis key for an agent run."""
    if not instance_id:
        logger.warning("Instance ID not set, cannot clean up instance key.")
        return
    key = f"active_run:{instance_id}:{agent_run_id}"
    logger.debug(f"Cleaning up Redis instance key: {key}")
    try:
        await redis.delete(key)
        logger.debug(f"Successfully cleaned up Redis key: {key}")
    except Exception as e:
        logger.warning(f"Failed to clean up Redis key {key}: {str(e)}")


async def get_or_create_project_sandbox(client, project_id: str):
    """Get or create a sandbox for a project."""
    project = await client.table('projects').select('*').eq('project_id', project_id).execute()
    if not project.data:
        raise ValueError(f"Project {project_id} not found")
    project_data = project.data[0]

    if project_data.get('sandbox', {}).get('id'):
        sandbox_id = project_data['sandbox']['id']
        sandbox_pass = project_data['sandbox']['pass']
        logger.info(f"Project {project_id} already has sandbox {sandbox_id}, retrieving it")
        try:
            sandbox = await get_or_start_sandbox(sandbox_id)
            return sandbox, sandbox_id, sandbox_pass
        except Exception as e:
            logger.error(f"Failed to retrieve existing sandbox {sandbox_id}: {str(e)}. Creating a new one.")

    logger.info(f"Creating new sandbox for project {project_id}")
    sandbox_pass = str(uuid.uuid4())
    sandbox = create_sandbox(sandbox_pass, project_id)
    sandbox_id = sandbox.id
    logger.info(f"Created new sandbox {sandbox_id}")

    vnc_link = sandbox.get_preview_link(6080)
    website_link = sandbox.get_preview_link(8080)
    vnc_url = vnc_link.url if hasattr(vnc_link, 'url') else str(vnc_link).split("url='")[1].split("'")[0]
    website_url = website_link.url if hasattr(website_link, 'url') else str(website_link).split("url='")[1].split("'")[0]
    token = None
    if hasattr(vnc_link, 'token'):
        token = vnc_link.token
    elif "token='" in str(vnc_link):
        token = str(vnc_link).split("token='")[1].split("'")[0]

    update_result = await client.table('projects').update({
        'sandbox': {
            'id': sandbox_id, 'pass': sandbox_pass, 'vnc_preview': vnc_url,
            'sandbox_url': website_url, 'token': token
        }
    }).eq('project_id', project_id).execute()

    if not update_result.data:
        logger.error(f"Failed to update project {project_id} with new sandbox {sandbox_id}")
        raise Exception("Database update failed")

    return sandbox, sandbox_id, sandbox_pass

@router.post("/thread/{thread_id}/agent/start")
async def start_agent(
    thread_id: str,
    body: AgentStartRequest = Body(...),
    user_id: str = Depends(get_current_user_id_from_jwt)
):
    """Start an agent for a specific thread in the background via Celery."""
    global instance_id 
    if not instance_id:
        raise HTTPException(status_code=500, detail="Agent API not initialized with instance ID")

    model_name = body.model_name
    logger.info(f"Original model_name from request: {model_name}")

    if model_name is None:
        model_name = config.MODEL_TO_USE
        logger.info(f"Using model from config: {model_name}")
    
    resolved_model = MODEL_NAME_ALIASES.get(model_name, model_name)
    logger.info(f"Resolved model name: {resolved_model}")
    model_name = resolved_model

    logger.info(f"Queueing agent task for thread: {thread_id} with config: model={model_name}, thinking={body.enable_thinking}, effort={body.reasoning_effort}, stream={body.stream}, context_manager={body.enable_context_manager} (Instance: {instance_id})")
    client = await db.client

    await verify_thread_access(client, thread_id, user_id)
    thread_result = await client.table('threads').select('project_id', 'account_id').eq('thread_id', thread_id).execute()
    if not thread_result.data:
        raise HTTPException(status_code=404, detail="Thread not found")
    thread_data = thread_result.data[0]
    project_id = thread_data.get('project_id')
    account_id = thread_data.get('account_id')

    can_run, message, subscription = await check_billing_status(client, account_id)
    if not can_run:
        raise HTTPException(status_code=402, detail={"message": message, "subscription": subscription})

    active_run_id = await check_for_active_project_agent_run(client, project_id)
    if active_run_id:
        logger.info(f"Stopping existing agent run {active_run_id} for project {project_id} before queueing new one.")
        await stop_agent_run(active_run_id) 

    try:
        sandbox, sandbox_id, sandbox_pass = await get_or_create_project_sandbox(client, project_id)
        logger.info(f"Ensured sandbox {sandbox_id} for project {project_id} for agent run.")
    except Exception as e:
        logger.error(f"Failed to get/create sandbox for project {project_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to initialize sandbox: {str(e)}")

    agent_run = await client.table('agent_runs').insert({
        "thread_id": thread_id, 
        "status": "queued",
        "started_at": datetime.now(timezone.utc).isoformat(),
        "model_name": model_name,
        "parameters": {
            "enable_thinking": body.enable_thinking,
            "reasoning_effort": body.reasoning_effort,
            "stream": body.stream,
            "enable_context_manager": body.enable_context_manager
        }
    }).execute()
    agent_run_id = agent_run.data[0]['id']
    logger.info(f"Created new agent run entry: {agent_run_id} with status 'queued'")

    celery_task_params = {
        "agent_run_id": agent_run_id,
        "thread_id": thread_id,
        "model_name": model_name,
        "enable_thinking": body.enable_thinking,
        "reasoning_effort": body.reasoning_effort,
        "stream": body.stream,
        "enable_context_manager": body.enable_context_manager,
        "user_id": user_id,
        "instance_id": instance_id,
        "initial_prompt_message": None
    }
    
    execute_agent_processing.delay(**celery_task_params)
    logger.info(f"Queued agent task {agent_run_id} to Celery with params: {celery_task_params}")

    return {"agent_run_id": agent_run_id, "status": "queued"}

@router.post("/agent-run/{agent_run_id}/stop")
async def stop_agent(agent_run_id: str, user_id: str = Depends(get_current_user_id_from_jwt)):
    """Stop a running agent."""
    logger.info(f"Received request to stop agent run: {agent_run_id}")
    client = await db.client
    await get_agent_run_with_access_check(client, agent_run_id, user_id)
    await stop_agent_run(agent_run_id)
    return {"status": "stopped"}

@router.get("/thread/{thread_id}/agent-runs")
async def get_agent_runs(thread_id: str, user_id: str = Depends(get_current_user_id_from_jwt)):
    """Get all agent runs for a thread."""
    logger.info(f"Fetching agent runs for thread: {thread_id}")
    client = await db.client
    await verify_thread_access(client, thread_id, user_id)
    agent_runs = await client.table('agent_runs').select('*').eq("thread_id", thread_id).order('created_at', desc=True).execute()
    logger.debug(f"Found {len(agent_runs.data)} agent runs for thread: {thread_id}")
    return {"agent_runs": agent_runs.data}

@router.get("/agent-run/{agent_run_id}")
async def get_agent_run(agent_run_id: str, user_id: str = Depends(get_current_user_id_from_jwt)):
    """Get agent run status and responses."""
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
            run_status = await client.table('agent_runs').select('status').eq("id", agent_run_id).maybe_single().execute()
            current_status = run_status.data.get('status') if run_status.data else None

            if current_status != 'running':
                logger.info(f"Agent run {agent_run_id} is not running (status: {current_status}). Ending stream.")
                yield f"data: {json.dumps({'type': 'status', 'status': 'completed'})}\n\n"
                return

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
                            logger.debug(f"Received {num_new} new responses for {agent_run_id} (index {new_start_index} onwards)")
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

async def run_agent_background(
    agent_run_id: str,
    thread_id: str,
    instance_id: str, # Use the global instance ID passed during initialization
    project_id: str,
    sandbox,
    model_name: str,
    enable_thinking: Optional[bool],
    reasoning_effort: Optional[str],
    stream: bool,
    enable_context_manager: bool
):
    """Run the agent in the background using Redis for state."""
    logger.info(f"Starting background agent run: {agent_run_id} for thread: {thread_id} (Instance: {instance_id})")
    logger.info(f"🚀 Using model: {model_name} (thinking: {enable_thinking}, reasoning_effort: {reasoning_effort})")

    client = await db.client
    start_time = datetime.now(timezone.utc)
    total_responses = 0
    pubsub = None
    stop_checker = None
    stop_signal_received = False

    # Define Redis keys and channels
    response_list_key = f"agent_run:{agent_run_id}:responses"
    response_channel = f"agent_run:{agent_run_id}:new_response"
    instance_control_channel = f"agent_run:{agent_run_id}:control:{instance_id}"
    global_control_channel = f"agent_run:{agent_run_id}:control"
    instance_active_key = f"active_run:{instance_id}:{agent_run_id}"

    async def check_for_stop_signal():
        nonlocal stop_signal_received
        if not pubsub: return
        try:
            while not stop_signal_received:
                message = await pubsub.get_message(ignore_subscribe_messages=True, timeout=0.5)
                if message and message.get("type") == "message":
                    data = message.get("data")
                    if isinstance(data, bytes): data = data.decode('utf-8')
                    if data == "STOP":
                        logger.info(f"Received STOP signal for agent run {agent_run_id} (Instance: {instance_id})")
                        stop_signal_received = True
                        break
                # Periodically refresh the active run key TTL
                if total_responses % 50 == 0: # Refresh every 50 responses or so
                    try: await redis.expire(instance_active_key, redis.REDIS_KEY_TTL)
                    except Exception as ttl_err: logger.warning(f"Failed to refresh TTL for {instance_active_key}: {ttl_err}")
                await asyncio.sleep(0.1) # Short sleep to prevent tight loop
        except asyncio.CancelledError:
            logger.info(f"Stop signal checker cancelled for {agent_run_id} (Instance: {instance_id})")
        except Exception as e:
            logger.error(f"Error in stop signal checker for {agent_run_id}: {e}", exc_info=True)
            stop_signal_received = True # Stop the run if the checker fails

    try:
        # Setup Pub/Sub listener for control signals
        pubsub = await redis.create_pubsub()
        await pubsub.subscribe(instance_control_channel, global_control_channel)
        logger.debug(f"Subscribed to control channels: {instance_control_channel}, {global_control_channel}")
        stop_checker = asyncio.create_task(check_for_stop_signal())

        # Ensure active run key exists and has TTL
        await redis.set(instance_active_key, "running", ex=redis.REDIS_KEY_TTL)

        # Initialize agent generator
        agent_gen = run_agent(
            thread_id=thread_id, project_id=project_id, stream=stream,
            thread_manager=thread_manager, model_name=model_name,
            enable_thinking=enable_thinking, reasoning_effort=reasoning_effort,
            enable_context_manager=enable_context_manager
        )

        final_status = "running"
        error_message = None

        async for response in agent_gen:
            if stop_signal_received:
                logger.info(f"Agent run {agent_run_id} stopped by signal.")
                final_status = "stopped"
                break

            # Store response in Redis list and publish notification
            response_json = json.dumps(response)
            await redis.rpush(response_list_key, response_json)
            await redis.publish(response_channel, "new")
            total_responses += 1

            # Check for agent-signaled completion or error
            if response.get('type') == 'status':
                 status_val = response.get('status')
                 if status_val in ['completed', 'failed', 'stopped']:
                     logger.info(f"Agent run {agent_run_id} finished via status message: {status_val}")
                     final_status = status_val
                     if status_val == 'failed' or status_val == 'stopped':
                         error_message = response.get('message', f"Run ended with status: {status_val}")
                     break

        # If loop finished without explicit completion/error/stop signal, mark as completed
        if final_status == "running":
             final_status = "completed"
             duration = (datetime.now(timezone.utc) - start_time).total_seconds()
             logger.info(f"Agent run {agent_run_id} completed normally (duration: {duration:.2f}s, responses: {total_responses})")
             completion_message = {"type": "status", "status": "completed", "message": "Agent run completed successfully"}
             await redis.rpush(response_list_key, json.dumps(completion_message))
             await redis.publish(response_channel, "new") # Notify about the completion message

        # Fetch final responses from Redis for DB update
        all_responses_json = await redis.lrange(response_list_key, 0, -1)
        all_responses = [json.loads(r) for r in all_responses_json]

        # Update DB status
        await update_agent_run_status(client, agent_run_id, final_status, error=error_message, responses=all_responses)

        # Publish final control signal (END_STREAM or ERROR)
        control_signal = "END_STREAM" if final_status == "completed" else "ERROR" if final_status == "failed" else "STOP"
        try:
            await redis.publish(global_control_channel, control_signal)
            # No need to publish to instance channel as the run is ending on this instance
            logger.debug(f"Published final control signal '{control_signal}' to {global_control_channel}")
        except Exception as e:
            logger.warning(f"Failed to publish final control signal {control_signal}: {str(e)}")

    except Exception as e:
        error_message = str(e)
        traceback_str = traceback.format_exc()
        duration = (datetime.now(timezone.utc) - start_time).total_seconds()
        logger.error(f"Error in agent run {agent_run_id} after {duration:.2f}s: {error_message}\n{traceback_str} (Instance: {instance_id})")
        final_status = "failed"

        # Push error message to Redis list
        error_response = {"type": "status", "status": "error", "message": error_message}
        try:
            await redis.rpush(response_list_key, json.dumps(error_response))
            await redis.publish(response_channel, "new")
        except Exception as redis_err:
             logger.error(f"Failed to push error response to Redis for {agent_run_id}: {redis_err}")

        # Fetch final responses (including the error)
        all_responses = []
        try:
             all_responses_json = await redis.lrange(response_list_key, 0, -1)
             all_responses = [json.loads(r) for r in all_responses_json]
        except Exception as fetch_err:
             logger.error(f"Failed to fetch responses from Redis after error for {agent_run_id}: {fetch_err}")
             all_responses = [error_response] # Use the error message we tried to push

        # Update DB status
        await update_agent_run_status(client, agent_run_id, "failed", error=f"{error_message}\n{traceback_str}", responses=all_responses)

        # Publish ERROR signal
        try:
            await redis.publish(global_control_channel, "ERROR")
            logger.debug(f"Published ERROR signal to {global_control_channel}")
        except Exception as e:
            logger.warning(f"Failed to publish ERROR signal: {str(e)}")

    finally:
        # Cleanup stop checker task
        if stop_checker and not stop_checker.done():
            stop_checker.cancel()
            try: await stop_checker
            except asyncio.CancelledError: pass
            except Exception as e: logger.warning(f"Error during stop_checker cancellation: {e}")

        # Close pubsub connection
        if pubsub:
            try:
                await pubsub.unsubscribe()
                await pubsub.close()
                logger.debug(f"Closed pubsub connection for {agent_run_id}")
            except Exception as e:
                logger.warning(f"Error closing pubsub for {agent_run_id}: {str(e)}")

        # Set TTL on the response list in Redis
        await _cleanup_redis_response_list(agent_run_id)

        # Remove the instance-specific active run key
        await _cleanup_redis_instance_key(agent_run_id)

        logger.info(f"Agent run background task fully completed for: {agent_run_id} (Instance: {instance_id}) with final status: {final_status}")

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
    model_name_form: Optional[str] = Form(None, alias="model_name"), # Added alias for clarity
    enable_thinking_form: Optional[bool] = Form(False, alias="enable_thinking"),
    reasoning_effort_form: Optional[str] = Form("low", alias="reasoning_effort"),
    stream_form: Optional[bool] = Form(True, alias="stream"),
    enable_context_manager_form: Optional[bool] = Form(False, alias="enable_context_manager"),
    files: List[UploadFile] = File(default=[]),
    user_id: str = Depends(get_current_user_id_from_jwt)
):
    """Initiate a new agent session with optional file attachments via Celery.""" # Docstring updated
    global instance_id 
    if not instance_id:
        raise HTTPException(status_code=500, detail="Agent API not initialized with instance ID")

    # Use model from config if not specified in the request
    model_name_to_use = model_name_form
    logger.info(f"Original model_name from request form: {model_name_to_use}")
    if model_name_to_use is None:
        model_name_to_use = config.MODEL_TO_USE
        logger.info(f"Using model from config: {model_name_to_use}")
    
    resolved_model = MODEL_NAME_ALIASES.get(model_name_to_use, model_name_to_use)
    logger.info(f"Resolved model name: {resolved_model}")
    model_name_to_use = resolved_model

    logger.info(f"[\033[91mDEBUG\033[0m] Queueing agent initiation with prompt and {len(files)} files (Instance: {instance_id}), model: {model_name_to_use}, enable_thinking: {enable_thinking_form}")
    client = await db.client
    account_id = user_id 

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

        # 2. Create Thread
        thread = await client.table('threads').insert({
            "thread_id": str(uuid.uuid4()), "project_id": project_id, "account_id": account_id,
            "created_at": datetime.now(timezone.utc).isoformat()
        }).execute()
        thread_id = thread.data[0]['thread_id']
        logger.info(f"Created new thread: {thread_id}")

        # Trigger Background Naming Task
        asyncio.create_task(generate_and_update_project_name(project_id=project_id, prompt=prompt))

        # 3. Create Sandbox
        sandbox, sandbox_id, sandbox_pass = await get_or_create_project_sandbox(client, project_id)
        logger.info(f"Using sandbox {sandbox_id} for new project {project_id}")

        # 4. Upload Files to Sandbox (if any)
        # This part is complex and sandbox-dependent. If run_agent needs these files
        # and the sandbox object cannot be passed to Celery, this pre-upload step is crucial.
        # The `initial_prompt_message` sent to Celery will contain references to these uploaded files.
        message_content_parts = [prompt]
        uploaded_file_paths_for_message = []
        if files:
            # ... (file upload logic as it was, ensure it completes before Celery task)
            # For brevity, assuming the existing file upload logic from the original function is here
            # It populates `uploaded_file_paths_for_message` and potentially `failed_uploads`
            # For demonstration, let's mock this part slightly:
            logger.info(f"Processing {len(files)} files for upload (actual upload logic skipped in this diff for brevity)")
            # Assume `message_content_parts` and `failed_uploads` are populated by the original logic block
            # Example from original: successful_uploads = [], failed_uploads = []
            # ... file processing loop ...
            # if successful_uploads: message_content_parts.append("\n\nUploaded Files:") ...
            # This logic for constructing message_content needs to be preserved.
            # For the sake of this diff, we will just use the prompt as message_content and assume
            # the run_agent/ThreadManager will handle file discovery if needed from the sandbox.
            # Ideally, the file paths/references are explicitly part of `initial_prompt_message`.
            
            # --- BEGINNING OF COPIED/ADAPTED FILE UPLOAD LOGIC --- 
            successful_uploads_info = [] # Store dicts like {"path": path, "name": name}
            failed_uploads_names = []
            for file_obj in files: # Renamed from `file` to `file_obj` to avoid conflict
                if file_obj.filename:
                    try:
                        safe_filename = file_obj.filename.replace('/', '_').replace('\\', '_')
                        target_path = f"/workspace/{safe_filename}"
                        logger.info(f"Attempting to upload {safe_filename} to {target_path} in sandbox {sandbox_id}")
                        content = await file_obj.read()
                        upload_successful = False
                        try:
                            if hasattr(sandbox, 'fs') and hasattr(sandbox.fs, 'upload_file'):
                                import inspect
                                if inspect.iscoroutinefunction(sandbox.fs.upload_file):
                                    await sandbox.fs.upload_file(target_path, content)
                                else:
                                    sandbox.fs.upload_file(target_path, content)
                                logger.debug(f"Called sandbox.fs.upload_file for {target_path}")
                                upload_successful = True
                            else:
                                raise NotImplementedError("Suitable upload method not found on sandbox object.")
                        except Exception as upload_error:
                            logger.error(f"Error during sandbox upload call for {safe_filename}: {str(upload_error)}", exc_info=True)

                        if upload_successful:
                            try:
                                # Introduce a short delay to allow for file system propagation if necessary
                                await asyncio.sleep(0.25) # Slightly increased delay from original 0.2
                                parent_dir = os.path.dirname(target_path)
                                # Ensure parent_dir is not empty and is a valid path, default to /workspace if root
                                if not parent_dir or parent_dir == '.': 
                                    parent_dir = "/workspace" 
                                    if not target_path.startswith("/"): # ensure target_path is absolute for consistency
                                        target_path = f"/workspace/{safe_filename}"

                                files_in_dir_objects = sandbox.fs.list_files(parent_dir)
                                file_names_in_dir = [f.name for f in files_in_dir_objects]
                                
                                # Check if the specific filename (not the full path) is in the listed names
                                if safe_filename in file_names_in_dir:
                                    successful_uploads_info.append({"path": target_path, "name": safe_filename})
                                    logger.info(f"Successfully uploaded and verified file {safe_filename} to sandbox path {target_path} in directory {parent_dir}")
                                else:
                                    logger.error(f"Verification failed for {safe_filename}: File not found in {parent_dir} after upload attempt. Files found: {file_names_in_dir}")
                                    failed_uploads_names.append(safe_filename)
                            except Exception as verify_error:
                                logger.error(f"Error verifying file {safe_filename} after upload to {target_path} in dir {parent_dir}: {str(verify_error)}", exc_info=True)
                                failed_uploads_names.append(safe_filename)
                        else:
                            failed_uploads_names.append(safe_filename)
                    except Exception as file_error:
                        logger.error(f"Error processing file {file_obj.filename}: {str(file_error)}", exc_info=True)
                        failed_uploads_names.append(file_obj.filename)
                    finally:
                        await file_obj.close()
            
            # Construct message_content based on uploads
            final_message_content = prompt
            if successful_uploads_info:
                final_message_content += "\n\n" if final_message_content else ""
                final_message_content += "The following files were uploaded and are available in the /workspace/ directory:\n"
                for up_file in successful_uploads_info:
                    final_message_content += f"- {up_file['name']} (at {up_file['path']})\n"
            if failed_uploads_names:
                final_message_content += "\n\nThe following files failed to upload:\n"
                for failed_file in failed_uploads_names:
                    final_message_content += f"- {failed_file}\n"
            # --- END OF COPIED/ADAPTED FILE UPLOAD LOGIC --- 
        else:
            final_message_content = prompt

        # 5. Add initial user message to thread (using final_message_content)
        message_id = str(uuid.uuid4())
        # The `initial_prompt_message` for Celery task should be this payload
        initial_celery_prompt_payload = {"role": "user", "content": final_message_content}
        
        await client.table('messages').insert({
            "message_id": message_id, "thread_id": thread_id, "type": "user",
            "is_llm_message": False, # User messages are not from LLM
            "content": json.dumps(initial_celery_prompt_payload), # Store the full content
            "created_at": datetime.now(timezone.utc).isoformat()
        }).execute()
        logger.info(f"Added initial user message {message_id} to thread {thread_id}")

        # 6. Start Agent Run (Status: queued)
        agent_run = await client.table('agent_runs').insert({
            "thread_id": thread_id, 
            "status": "queued", # Changed status
            "started_at": datetime.now(timezone.utc).isoformat(), # Queued_at
            "model_name": model_name_to_use,
            "parameters": { 
                "enable_thinking": enable_thinking_form,
                "reasoning_effort": reasoning_effort_form,
                "stream": stream_form,
                "enable_context_manager": enable_context_manager_form,
                "num_files": len(files)
            }
        }).execute()
        agent_run_id = agent_run.data[0]['id']
        logger.info(f"Created new agent run entry: {agent_run_id} with status 'queued'")

        # Removed Redis set for active_run key here, Celery task will handle it.

        celery_task_params = {
            "agent_run_id": agent_run_id,
            "thread_id": thread_id,
            "model_name": model_name_to_use,
            "enable_thinking": enable_thinking_form,
            "reasoning_effort": reasoning_effort_form,
            "stream": stream_form,
            "enable_context_manager": enable_context_manager_form,
            "user_id": user_id,
            "instance_id": instance_id,
            "initial_prompt_message": initial_celery_prompt_payload # Pass the constructed message
        }

        execute_agent_processing.delay(**celery_task_params)
        logger.info(f"Queued agent task {agent_run_id} to Celery with params: {celery_task_params}")
        
        # Callback for _cleanup_redis_instance_key is removed.

        return {"thread_id": thread_id, "agent_run_id": agent_run_id, "status": "queued"}

    except Exception as e:
        logger.error(f"Error in agent initiation: {str(e)}\n{traceback.format_exc()}")
        # Attempt to clean up created project/thread if initiation fails mid-way
        if 'project_id' in locals() and project_id:
            try:
                logger.warning(f"Attempting to clean up project {project_id} due to initiation failure.")
                await client.table('projects').delete().eq('project_id', project_id).execute()
                logger.info(f"Successfully cleaned up project {project_id}.")
            except Exception as cleanup_project_error:
                logger.error(f"Failed to clean up project {project_id}: {str(cleanup_project_error)}")
        
        if 'thread_id' in locals() and thread_id:
            try:
                logger.warning(f"Attempting to clean up thread {thread_id} due to initiation failure.")
                await client.table('threads').delete().eq('thread_id', thread_id).execute()
                logger.info(f"Successfully cleaned up thread {thread_id}.")
            except Exception as cleanup_thread_error:
                logger.error(f"Failed to clean up thread {thread_id}: {str(cleanup_thread_error)}")

        raise HTTPException(status_code=500, detail=f"Failed to initiate agent session: {str(e)}")