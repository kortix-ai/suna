from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
import asyncio
import json
import traceback
from datetime import datetime, timezone
import uuid

from agentpress.framework.thread_manager import ThreadManager
from agentpress.framework.state_manager import StateManager
from agentpress.framework.db_connection import DBConnection
from agentpress.framework import redis_manager
from agentpress.agent.run import run_agent

# Initialize shared resources
router = APIRouter()
thread_manager = None
state_manager = None
store_id = None
db = None 
instance_id = None

def initialize(
    _thread_manager: ThreadManager, 
    _state_manager: StateManager, 
    _store_id: str,
    _db: DBConnection
):
    """Initialize the agent API with resources from the main API."""
    global thread_manager, state_manager, store_id, db, instance_id
    thread_manager = _thread_manager
    state_manager = _state_manager
    store_id = _store_id
    db = _db
    
    # Generate instance ID
    instance_id = str(uuid.uuid4())[:8]
    
    # Initialize Redis
    redis_manager.initialize()

async def cleanup():
    """Clean up resources and stop running agents on shutdown."""
    # Get Redis client
    redis_client = await redis_manager.get_client()
    
    # Use the instance_id to find and clean up this instance's keys
    running_keys = await redis_client.keys(f"active_run:{instance_id}:*")
    
    for key in running_keys:
        agent_run_id = key.split(":")[-1]
        await stop_agent_run(agent_run_id)
    
    # Close Redis connection
    await redis_manager.close()

async def stop_agent_run(agent_run_id: str):
    """Update database and publish stop signal to Redis."""
    prisma = await db.prisma
    redis_client = await redis_manager.get_client()
    
    # Update the agent run status to stopped
    await prisma.agentrun.update(
        where={"id": agent_run_id},
        data={
            "status": "stopped",
            "completedAt": datetime.now(timezone.utc).isoformat()
        }
    )
    
    # Publish stop signal to the agent run channel
    await redis_client.publish(f"agent_run:{agent_run_id}:control", "STOP")

async def restore_running_agent_runs():
    """Restore any agent runs that were still marked as running in the database."""
    prisma = await db.prisma
    running_agent_runs = await prisma.agentrun.find_many(
        where={"status": "running"}
    )

    for run in running_agent_runs:
        await prisma.agentrun.update(
            where={"id": run.id},
            data={
                "status": "failed", 
                "error": "Server restarted while agent was running",
                "completedAt": datetime.now(timezone.utc).isoformat()
            }
        )

@router.post("/thread/{thread_id}/agent/start")
async def start_agent(thread_id: str):
    """Start an agent for a specific thread in the background."""
    prisma = await db.prisma
    redis_client = await redis_manager.get_client()
    
    # Create a new agent run
    agent_run = await prisma.agentrun.create(
        data={
            "threadId": thread_id,
            "status": "running",
            "startedAt": datetime.now(timezone.utc).isoformat(),
            "responses": "[]"  # Initialize with empty array
        }
    )
    
    # Register this run in Redis with TTL
    await redis_client.set(
        f"active_run:{instance_id}:{agent_run.id}", 
        "running", 
        ex=redis_manager.REDIS_KEY_TTL
    )
    
    # Run the agent in the background
    task = asyncio.create_task(
        run_agent_background(agent_run.id, thread_id, instance_id)
    )
    
    # Set a callback to clean up when task is done
    task.add_done_callback(
        lambda _: asyncio.create_task(
            _cleanup_agent_run(agent_run.id)
        )
    )
    
    return {"agent_run_id": agent_run.id, "status": "running"}

async def _cleanup_agent_run(agent_run_id: str):
    """Clean up Redis keys when an agent run is done."""
    redis_client = await redis_manager.get_client()
    await redis_client.delete(f"active_run:{instance_id}:{agent_run_id}")

@router.post("/agent-run/{agent_run_id}/stop")
async def stop_agent(agent_run_id: str):
    """Stop a running agent."""
    prisma = await db.prisma
    
    # Check if agent run exists
    agent_run = await prisma.agentrun.find_unique(
        where={"id": agent_run_id}
    )
    
    if not agent_run:
        raise HTTPException(status_code=404, detail="Agent run not found")
    
    # Stop the agent run
    await stop_agent_run(agent_run_id)
    
    return {"status": "stopped"}

@router.get("/agent-run/{agent_run_id}/stream")
async def stream_agent_run(agent_run_id: str):
    """Stream the responses of an agent run from where they left off."""
    prisma = await db.prisma
    redis_client = await redis_manager.get_client()
    
    agent_run = await prisma.agentrun.find_unique(
        where={"id": agent_run_id}
    )
    
    if not agent_run:
        raise HTTPException(status_code=404, detail="Agent run not found")
    
    # Return the existing responses as a stream
    async def stream_existing_responses():
        # First, send all existing responses
        responses = agent_run.responses
        if isinstance(responses, str):
            try:
                responses = json.loads(responses)
            except json.JSONDecodeError:
                responses = []
        
        for response in responses:
            yield f"data: {json.dumps(response)}\n\n"
        
        # If the agent is still running, subscribe to the Redis channel
        if agent_run.status == "running":
            # Create a Redis subscription
            pubsub = redis_client.pubsub()
            await pubsub.subscribe(f"agent_run:{agent_run_id}:responses")
            
            try:
                # Wait for new responses from the Redis channel
                while True:
                    # Use a timeout to allow for checking status
                    message = await pubsub.get_message(timeout=30.0)
                    
                    if message and message["type"] == "message":
                        data = message["data"]
                        if data == "END_STREAM":
                            break
                        yield f"data: {data}\n\n"
                    else:
                        # Check if agent is still running
                        current_agent_run = await prisma.agentrun.find_unique(
                            where={"id": agent_run_id}
                        )
                        
                        if current_agent_run and current_agent_run.status != "running":
                            break
                            
                        # Send a ping to keep connection alive
                        yield f"data: {json.dumps({'type': 'ping'})}\n\n"
            finally:
                await pubsub.unsubscribe(f"agent_run:{agent_run_id}:responses")
    
    return StreamingResponse(
        stream_existing_responses(),
        media_type="text/event-stream"
    )

@router.get("/thread/{thread_id}/agent-runs")
async def get_agent_runs(thread_id: str):
    """Get all agent runs for a thread."""
    prisma = await db.prisma
    agent_runs = await prisma.agentrun.find_many(
        where={"threadId": thread_id}
    )
    return {"agent_runs": agent_runs}

@router.get("/agent-run/{agent_run_id}")
async def get_agent_run(agent_run_id: str):
    """Get agent run status and responses."""
    prisma = await db.prisma
    agent_run = await prisma.agentrun.find_unique(
        where={"id": agent_run_id}
    )
    
    if not agent_run:
        raise HTTPException(status_code=404, detail="Agent run not found")
     
    responses = agent_run.responses
    if isinstance(responses, str):
        try:
            responses = json.loads(responses)
        except json.JSONDecodeError:
            responses = []
    
    return {
        "id": agent_run.id,
        "threadId": agent_run.threadId,
        "status": agent_run.status,
        "startedAt": agent_run.startedAt,
        "completedAt": agent_run.completedAt,
        "responses": responses,
        "error": agent_run.error
    }

async def run_agent_background(agent_run_id: str, thread_id: str, instance_id: str):
    """Run the agent in the background and store responses."""
    prisma = await db.prisma
    redis_client = await redis_manager.get_client()
    
    # Create a buffer to store response chunks
    responses = []
    batch = []
    last_db_update = datetime.now(timezone.utc)
    
    # Create a pubsub to listen for control messages
    pubsub = redis_client.pubsub()
    await pubsub.subscribe(f"agent_run:{agent_run_id}:control")
    
    # Start a background task to check for stop signals
    stop_signal_received = False
    
    async def check_for_stop_signal():
        nonlocal stop_signal_received
        while True:
            message = await pubsub.get_message(timeout=1.0)
            if message and message["type"] == "message" and message["data"] == "STOP":
                stop_signal_received = True
                break
            await asyncio.sleep(0.1)  # Small delay to prevent CPU spinning
            if stop_signal_received:  # Check if we should exit
                break
    
    # Start the stop signal checker
    stop_checker = asyncio.create_task(check_for_stop_signal())
    
    try:
        # Run the agent and collect responses
        agent_gen = run_agent(thread_id, stream=True, 
                      thread_manager=thread_manager, state_manager=state_manager, store_id=store_id)
        
        # Process the agent responses directly here (no separate task)
        async for chunk in agent_gen:
            # Check if we've received a stop signal
            if stop_signal_received:
                break
                
            if chunk.startswith("data: "):
                data = json.loads(chunk[6:])
                responses.append(data)
                batch.append(data)
                
                # Publish to Redis for live streaming
                await redis_client.publish(
                    f"agent_run:{agent_run_id}:responses", 
                    json.dumps(data)
                )
                
                # Refresh the TTL on the active_run key to prevent expiration during long runs
                await redis_client.expire(
                    f"active_run:{instance_id}:{agent_run_id}", 
                    redis_manager.REDIS_KEY_TTL
                )
                
                # Batch update to the database every 10 items or every 5 seconds
                now = datetime.now(timezone.utc)
                if len(batch) >= 10 or (now - last_db_update).total_seconds() >= 5:
                    await prisma.agentrun.update(
                        where={"id": agent_run_id},
                        data={"responses": json.dumps(responses)}
                    )
                    batch = []
                    last_db_update = now
        
        # Final update with any remaining responses
        if batch:
            await prisma.agentrun.update(
                where={"id": agent_run_id},
                data={"responses": json.dumps(responses)}
            )
        
        # Mark the agent run as completed
        await prisma.agentrun.update(
            where={"id": agent_run_id},
            data={
                "status": "completed", 
                "completedAt": datetime.now(timezone.utc).isoformat()
            }
        )
        
        # Send end of stream signal
        await redis_client.publish(f"agent_run:{agent_run_id}:responses", "END_STREAM")
        
    except asyncio.CancelledError:
        # This is an expected cancellation, mark as stopped
        await prisma.agentrun.update(
            where={"id": agent_run_id},
            data={
                "status": "stopped",
                "completedAt": datetime.now(timezone.utc).isoformat(),
                "responses": json.dumps(responses)
            }
        )
        
        # Send end of stream signal
        await redis_client.publish(f"agent_run:{agent_run_id}:responses", "END_STREAM")
        
    except Exception as e:
        # Capture the full traceback for better debugging
        error_details = traceback.format_exc()
        
        # Mark the agent run as failed with detailed error information
        await prisma.agentrun.update(
            where={"id": agent_run_id},
            data={
                "status": "failed", 
                "error": f"{str(e)}\n\n{error_details}",
                "completedAt": datetime.now(timezone.utc).isoformat(),
                "responses": json.dumps(responses)
            }
        )
        
        # Send end of stream signal
        await redis_client.publish(f"agent_run:{agent_run_id}:responses", "END_STREAM")
    finally:
        # Cancel the stop checker if it's still running
        if not stop_checker.done():
            stop_checker.cancel()
        
        # Clean up pubsub
        await pubsub.unsubscribe(f"agent_run:{agent_run_id}:control")
        
        # Remove active run marker from Redis
        try:
            await redis_client.delete(f"active_run:{instance_id}:{agent_run_id}")
        except Exception as e:
            # Log the error but don't let it propagate
            print(f"Error deleting Redis key: {str(e)}")
