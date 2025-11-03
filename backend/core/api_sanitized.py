"""
Sanitized API endpoints for formatted/frontend-ready messages.

These endpoints return messages in a clean, parsed format ready for rendering,
with all XML parsing and tool call matching done on the backend.
"""

import json
from typing import Optional
from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import StreamingResponse
from core.utils.auth_utils import verify_and_get_user_id_from_jwt, verify_and_authorize_thread_access
from core.utils.logger import logger
from core.utils.message_sanitizer import sanitize_messages_batch, sanitize_streaming_message
from core import core_utils as utils
from core.agent_runs import get_user_id_from_stream_auth, _get_agent_run_with_access_check
from core.services import redis

router = APIRouter(tags=["sanitized-messages"])


@router.get(
    "/threads/{thread_id}/messages/formatted",
    summary="Get Formatted Thread Messages",
    operation_id="get_formatted_thread_messages"
)
async def get_formatted_thread_messages(
    thread_id: str,
    user_id: str = Depends(verify_and_get_user_id_from_jwt),
    order: str = Query("desc", description="Order by created_at: 'asc' or 'desc'")
):
    """
    Get all messages for a thread in sanitized, frontend-ready format.
    
    This endpoint:
    - Parses XML tool calls into structured format
    - Strips XML tags from assistant text
    - Matches tool results to tool calls
    - Returns consistent message structure across all types
    
    Use this instead of the raw /threads/{thread_id}/messages endpoint for
    frontend consumption.
    """
    logger.debug(f"Fetching formatted messages for thread: {thread_id}, order={order}")
    client = await utils.db.client
    
    # Verify user has access to this thread
    await verify_and_authorize_thread_access(client, thread_id, user_id)
    
    try:
        # Fetch messages in batches (same as raw endpoint)
        batch_size = 1000
        offset = 0
        all_messages = []
        
        while True:
            query = client.table('messages').select('*, agents(name)').eq('thread_id', thread_id)
            query = query.order('created_at', desc=(order == "desc"))
            query = query.range(offset, offset + batch_size - 1)
            messages_result = await query.execute()
            batch = messages_result.data or []
            all_messages.extend(batch)
            logger.debug(f"Fetched batch of {len(batch)} messages (offset {offset})")
            if len(batch) < batch_size:
                break
            offset += batch_size
        
        # Sanitize all messages
        sanitized_messages = sanitize_messages_batch(all_messages)
        
        logger.info(f"Returning {len(sanitized_messages)} formatted messages for thread {thread_id}")
        
        return {
            "messages": sanitized_messages,
            "metadata": {
                "total_count": len(sanitized_messages),
                "has_more": False,
                "order": order
            }
        }
    
    except Exception as e:
        logger.error(f"Error fetching formatted messages for thread {thread_id}: {str(e)}", exc_info=True)
        raise


@router.get(
    "/agent-run/{agent_run_id}/stream/formatted",
    summary="Stream Formatted Agent Run",
    operation_id="stream_formatted_agent_run"
)
async def stream_formatted_agent_run(
    agent_run_id: str,
    token: Optional[str] = None,
    request: Request = None
):
    """
    Stream agent run responses in sanitized, frontend-ready format.
    
    This endpoint:
    - Parses streaming chunks and complete messages
    - Returns consistent message structure
    - Handles tool calls and results
    - Provides status updates
    
    Use this instead of the raw /agent-run/{agent_run_id}/stream endpoint for
    frontend consumption.
    
    Returns Server-Sent Events (SSE) with 'data: ' prefix for each message.
    """
    logger.debug(f"Starting formatted stream for agent run: {agent_run_id}")
    client = await utils.db.client
    
    # Authenticate and authorize
    user_id = await get_user_id_from_stream_auth(request, token)
    agent_run_data = await _get_agent_run_with_access_check(client, agent_run_id, user_id)
    
    response_list_key = f"agent_run:{agent_run_id}:responses"
    response_channel = f"agent_run:{agent_run_id}:stream"
    control_channel = f"agent_run:{agent_run_id}:control"
    
    async def formatted_stream_generator():
        """Generate formatted streaming responses."""
        logger.debug(f"Starting formatted stream generator for {agent_run_id}")
        last_processed_index = -1
        listener_task = None
        terminate_stream = False
        
        try:
            # 1. Fetch and yield initial responses from Redis
            initial_responses_json = await redis.lrange(response_list_key, 0, -1)
            initial_responses = []
            
            if initial_responses_json:
                initial_responses = [json.loads(r) for r in initial_responses_json]
                logger.debug(f"Processing {len(initial_responses)} initial responses")
                
                for response in initial_responses:
                    # Sanitize each message before yielding
                    sanitized = sanitize_streaming_message(response)
                    yield f"data: {json.dumps(sanitized)}\n\n"
                
                last_processed_index = len(initial_responses) - 1
            
            # 2. Check run status
            current_status = agent_run_data.get('status') if agent_run_data else None
            
            if current_status != 'running':
                logger.debug(f"Agent run {agent_run_id} is not running (status: {current_status})")
                yield f"data: {json.dumps({'type': 'status', 'content': {'status_type': 'completed', 'message': 'Agent run completed'}})}\n\n"
                return
            
            # 3. Subscribe to real-time updates
            import asyncio
            pubsub = await redis.create_pubsub()
            await pubsub.subscribe(response_channel, control_channel)
            logger.debug(f"Subscribed to channels: {response_channel}, {control_channel}")
            
            message_queue = asyncio.Queue()
            
            async def listen_messages():
                """Listen for new messages on subscribed channels."""
                listener = pubsub.listen()
                async for raw_message in listener:
                    if raw_message and raw_message.get('type') == 'message':
                        await message_queue.put(raw_message)
            
            # Start listener task
            listener_task = asyncio.create_task(listen_messages())
            
            # 4. Process messages from queue
            while not terminate_stream:
                try:
                    # Wait for message with timeout
                    raw_message = await asyncio.wait_for(message_queue.get(), timeout=30.0)
                    
                    channel = raw_message.get('channel')
                    data = raw_message.get('data')
                    
                    if not data:
                        continue
                    
                    # Handle control channel
                    if channel == control_channel:
                        if data == b'STREAM_COMPLETE':
                            logger.debug(f"Stream complete signal received for {agent_run_id}")
                            yield f"data: {json.dumps({'type': 'status', 'content': {'status_type': 'completed', 'message': 'Stream completed'}})}\n\n"
                            terminate_stream = True
                            break
                        continue
                    
                    # Handle response channel
                    if channel == response_channel:
                        try:
                            message = json.loads(data)
                            # Sanitize the streaming message
                            sanitized = sanitize_streaming_message(message)
                            yield f"data: {json.dumps(sanitized)}\n\n"
                        except json.JSONDecodeError:
                            logger.warning(f"Failed to decode message: {data}")
                            continue
                
                except asyncio.TimeoutError:
                    # Send keepalive
                    yield f": keepalive\n\n"
                    continue
                except Exception as e:
                    logger.error(f"Error processing message: {str(e)}", exc_info=True)
                    continue
        
        except Exception as e:
            logger.error(f"Error in formatted stream generator: {str(e)}", exc_info=True)
            yield f"data: {json.dumps({'type': 'error', 'content': {'message': str(e)}})}\n\n"
        
        finally:
            # Cleanup
            if listener_task:
                listener_task.cancel()
                try:
                    await listener_task
                except asyncio.CancelledError:
                    pass
            
            try:
                await pubsub.unsubscribe(response_channel, control_channel)
                await pubsub.close()
            except Exception as e:
                logger.warning(f"Error closing pubsub: {str(e)}")
    
    return StreamingResponse(
        formatted_stream_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no"
        }
    )

