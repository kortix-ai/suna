"""
Temporal activities for background processing.

Activities are the actual work units in Temporal workflows. They can be retried
and support heartbeating for long-running operations.
"""
import asyncio
import json
import time
import traceback
import uuid
from datetime import datetime, timezone
from typing import Optional, Dict, Any, List

from temporalio import activity
from temporalio.exceptions import ActivityError

import sentry
from core.utils.logger import logger, structlog
from core.services.supabase import DBConnection
from core.services import redis
from core.services.langfuse import langfuse
from core.run import run_agent
from core.tool_output_streaming_context import set_tool_output_streaming_context, clear_tool_output_streaming_context

# Import functions from run_agent_background that we'll reuse
from run_agent_background import (
    initialize,
    acquire_run_lock,
    load_agent_config,
    create_redis_keys,
    process_agent_responses,
    handle_normal_completion,
    send_completion_notification,
    send_failure_notification,
    update_agent_run_status,
    cleanup_redis_keys_for_agent_run,
)

db = DBConnection()

# TTL for Redis stream keys
REDIS_STREAM_TTL_SECONDS = 600  # 10 minutes


@activity.defn(name="run_agent")
async def run_agent_activity(
    agent_run_id: str,
    thread_id: str,
    instance_id: str,
    project_id: str,
    model_name: str = "openai/gpt-5-mini",
    agent_id: Optional[str] = None,
    account_id: Optional[str] = None,
    request_id: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Execute an agent run - main activity for agent execution.
    
    This activity wraps the core agent execution logic from run_agent_background.
    It supports heartbeating for long-running operations and handles cancellation
    via Temporal's cancellation mechanism.
    """
    worker_start = time.time()
    timings = {}
    
    structlog.contextvars.clear_contextvars()
    structlog.contextvars.bind_contextvars(
        agent_run_id=agent_run_id,
        thread_id=thread_id,
        request_id=request_id,
    )
    
    logger.info(f"⏱️ [TIMING] Activity received job at {worker_start}")
    
    # Initialize worker resources
    t = time.time()
    try:
        await initialize()
    except Exception as e:
        logger.critical(f"Failed to initialize worker resources (Redis/DB): {e}")
        raise ActivityError(f"Worker setup failed: {str(e)}")
    timings['initialize'] = (time.time() - t) * 1000
    
    client = None
    final_status = "failed"
    
    try:
        client = await db.client
        lock_acquired = await acquire_run_lock(agent_run_id, instance_id, client)
        if not lock_acquired:
            logger.info(f"Agent run {agent_run_id} already being processed by another instance")
            return {"status": "skipped", "reason": "lock_not_acquired"}
        
        sentry.sentry.set_tag("thread_id", thread_id)
        
        timings['lock_acquisition'] = (time.time() - worker_start) * 1000 - timings['initialize']
        logger.info(f"⏱️ [TIMING] Worker init: {timings['initialize']:.1f}ms | Lock: {timings['lock_acquisition']:.1f}ms")
        logger.info(f"Starting agent run: {agent_run_id} for thread: {thread_id} (Instance: {instance_id})")
        
        from core.ai_models import model_manager
        effective_model = model_manager.resolve_model_id(model_name)
        logger.info(f"🚀 Using model: {effective_model}")
        
        start_time = datetime.now(timezone.utc)
        cancellation_event = asyncio.Event()
        
        redis_keys = create_redis_keys(agent_run_id, instance_id)
        
        await redis.verify_stream_writable(redis_keys['response_stream'])
        logger.info(f"✅ Verified Redis stream {redis_keys['response_stream']} is writable")
        
        trace = langfuse.trace(
            name="agent_run",
            id=agent_run_id,
            session_id=thread_id,
            metadata={"project_id": project_id, "instance_id": instance_id}
        )
        
        # Set instance active key
        try:
            await asyncio.wait_for(
                redis.set(redis_keys['instance_active'], "running", ex=redis.REDIS_KEY_TTL),
                timeout=5.0
            )
        except (asyncio.TimeoutError, Exception) as e:
            logger.warning(f"Redis error setting instance_active key: {e} - continuing")
        
        agent_config = await load_agent_config(agent_id, account_id)
        
        # Set tool output streaming context
        set_tool_output_streaming_context(
            agent_run_id=agent_run_id,
            stream_key=redis_keys['response_stream']
        )
        
        # Check for cancellation periodically and send heartbeats with progress data
        stop_signal_checker_state = {
            'stop_signal_received': False, 
            'total_responses': 0, 
            'stop_reason': None,
            'last_response_type': None,
            'started_at': datetime.now(timezone.utc).isoformat(),
        }
        
        async def check_cancellation_and_heartbeat():
            """
            Check for Temporal cancellation and send heartbeats with progress data.
            
            Heartbeats include:
            - Total responses processed
            - Last response type
            - Running duration
            - Agent run ID for tracking
            """
            heartbeat_count = 0
            while not stop_signal_checker_state.get('stop_signal_received'):
                try:
                    heartbeat_count += 1
                    
                    # Build progress data for heartbeat
                    progress_data = {
                        "agent_run_id": agent_run_id,
                        "thread_id": thread_id,
                        "responses_processed": stop_signal_checker_state.get('total_responses', 0),
                        "last_response_type": stop_signal_checker_state.get('last_response_type'),
                        "heartbeat_count": heartbeat_count,
                        "running_seconds": (datetime.now(timezone.utc) - start_time).total_seconds(),
                    }
                    
                    # Send heartbeat with progress data to Temporal
                    # This allows monitoring and detecting stuck activities
                    activity.heartbeat(progress_data)
                    
                    # Also check if Temporal requested cancellation
                    if activity.is_cancelled():
                        logger.warning(f"🛑 Temporal cancellation detected for agent run {agent_run_id}")
                        stop_signal_checker_state['stop_signal_received'] = True
                        stop_signal_checker_state['stop_reason'] = 'temporal_cancellation'
                        cancellation_event.set()
                        break
                    
                    # Refresh instance_active TTL every 25 heartbeats (~12.5 seconds)
                    if heartbeat_count % 25 == 0:
                        try:
                            await asyncio.wait_for(
                                redis.expire(redis_keys['instance_active'], redis.REDIS_KEY_TTL),
                                timeout=3.0
                            )
                        except (asyncio.TimeoutError, Exception):
                            pass
                    
                    await asyncio.sleep(0.5)  # Heartbeat every 500ms
                    
                except asyncio.CancelledError:
                    logger.warning(f"🛑 Activity cancelled for agent run {agent_run_id}")
                    stop_signal_checker_state['stop_signal_received'] = True
                    stop_signal_checker_state['stop_reason'] = 'temporal_cancellation'
                    cancellation_event.set()
                    break
                except Exception as e:
                    logger.error(f"Error in heartbeat/cancellation checker: {e}", exc_info=True)
                    await asyncio.sleep(1)
        
        cancellation_checker = asyncio.create_task(check_cancellation_and_heartbeat())
        
        try:
            agent_gen = run_agent(
                thread_id=thread_id,
                project_id=project_id,
                model_name=effective_model,
                agent_config=agent_config,
                trace=trace,
                cancellation_event=cancellation_event,
                account_id=account_id,
            )
            
            total_to_ready = (time.time() - worker_start) * 1000
            logger.info(f"⏱️ [TIMING] 🏁 Worker ready for first LLM call: {total_to_ready:.1f}ms from job start")
            
            final_status, error_message, complete_tool_called, total_responses = await process_agent_responses(
                agent_gen, agent_run_id, redis_keys, trace, worker_start, stop_signal_checker_state
            )
            
            if final_status == "running":
                final_status = "completed"
                await handle_normal_completion(agent_run_id, start_time, total_responses, redis_keys, trace)
                await send_completion_notification(client, thread_id, agent_config, complete_tool_called)
                if not complete_tool_called:
                    logger.info(f"Agent run {agent_run_id} completed without explicit complete tool call")
            
            await update_agent_run_status(client, agent_run_id, final_status, error=error_message, account_id=account_id)
            
            if final_status == "failed" and error_message:
                await send_failure_notification(client, thread_id, error_message)
            
            return {
                "status": final_status,
                "error": error_message,
                "total_responses": total_responses,
                "complete_tool_called": complete_tool_called,
            }
            
        except Exception as e:
            error_message = str(e)
            traceback_str = traceback.format_exc()
            duration = (datetime.now(timezone.utc) - start_time).total_seconds()
            logger.error(f"Error in agent run {agent_run_id} after {duration:.2f}s: {error_message}\n{traceback_str}")
            final_status = "failed"
            trace.span(name="agent_run_failed").end(status_message=error_message, level="ERROR")
            
            await send_failure_notification(client, thread_id, error_message)
            
            error_response = {"type": "status", "status": "error", "message": error_message}
            try:
                error_json = json.dumps(error_response)
                await asyncio.wait_for(
                    redis.stream_add(
                        redis_keys['response_stream'],
                        {'data': error_json},
                        maxlen=200,
                        approximate=True
                    ),
                    timeout=5.0
                )
            except (asyncio.TimeoutError, Exception) as redis_err:
                logger.error(f"Failed to write error response to stream: {redis_err}")
            
            await update_agent_run_status(client, agent_run_id, "failed", error=f"{error_message}\n{traceback_str}", account_id=account_id)
            
            raise ActivityError(f"Agent run failed: {error_message}")
        
        finally:
            if cancellation_checker and not cancellation_checker.done():
                cancellation_checker.cancel()
                try:
                    await cancellation_checker
                except asyncio.CancelledError:
                    pass
            
            clear_tool_output_streaming_context()
            await cleanup_redis_keys_for_agent_run(agent_run_id, instance_id)
            
            # Memory cleanup
            try:
                import gc
                collected = gc.collect()
                if collected > 0:
                    logger.debug(f"Garbage collected {collected} objects after agent run {agent_run_id}")
            except Exception:
                pass
    
    except Exception as e:
        logger.error(f"Critical error during activity setup for {agent_run_id}: {e}", exc_info=True)
        try:
            if not client:
                client = await db.client
            await update_agent_run_status(client, agent_run_id, "failed", error=f"Activity setup failed: {str(e)}", account_id=account_id)
        except Exception:
            pass
        try:
            await cleanup_redis_keys_for_agent_run(agent_run_id, instance_id)
        except Exception:
            pass
        raise ActivityError(f"Activity setup failed: {str(e)}")


@activity.defn(name="extract_memories")
async def extract_memories_activity(
    thread_id: str,
    account_id: str,
    message_ids: List[str]
) -> Optional[List[Dict[str, Any]]]:
    """
    Extract memories from conversation messages.
    
    Returns:
        List of extracted memories (dict format) or None if extraction skipped
    """
    structlog.contextvars.clear_contextvars()
    structlog.contextvars.bind_contextvars(
        thread_id=thread_id,
        account_id=account_id,
        job_type="memory_extraction"
    )
    
    logger.info(f"Starting memory extraction for thread {thread_id}")
    
    await db.initialize()
    client = await db.client
    
    try:
        from core.billing import subscription_service
        from core.billing.shared.config import get_memory_config, is_memory_enabled
        from core.memory.extraction_service import MemoryExtractionService
        from core.memory.models import ExtractionQueueStatus
        
        tier_info = await subscription_service.get_user_subscription_tier(account_id)
        tier_name = tier_info['name']
        
        if not is_memory_enabled(tier_name):
            logger.debug(f"Memory disabled for tier {tier_name}, skipping extraction")
            return None
        
        user_memory_result = await client.rpc('get_user_memory_enabled', {'p_account_id': account_id}).execute()
        user_memory_enabled = user_memory_result.data if user_memory_result.data is not None else True
        if not user_memory_enabled:
            logger.debug(f"Memory disabled by user {account_id}, skipping extraction")
            return None
        
        recent_extraction = await client.table('memory_extraction_queue').select('created_at').eq('thread_id', thread_id).eq('status', 'completed').order('created_at', desc=True).limit(1).execute()
        
        if recent_extraction.data:
            from datetime import timedelta
            last_extraction = datetime.fromisoformat(recent_extraction.data[0]['created_at'].replace('Z', '+00:00'))
            if datetime.now(timezone.utc) - last_extraction < timedelta(hours=1):
                logger.debug(f"Recent extraction found for thread {thread_id}, skipping")
                return None
        
        messages_result = await client.table('messages').select('*').in_('message_id', message_ids).execute()
        messages = messages_result.data or []
        
        extraction_service = MemoryExtractionService()
        if not await extraction_service.should_extract(messages):
            logger.debug(f"Not enough content for extraction in thread {thread_id}")
            return None
        
        queue_entry = await client.table('memory_extraction_queue').insert({
            'thread_id': thread_id,
            'account_id': account_id,
            'message_ids': message_ids,
            'status': ExtractionQueueStatus.PROCESSING.value
        }).execute()
        
        queue_id = queue_entry.data[0]['queue_id']
        
        extracted_memories = await extraction_service.extract_memories(
            messages=messages,
            account_id=account_id,
            thread_id=thread_id
        )
        
        if not extracted_memories:
            logger.info(f"No memories extracted from thread {thread_id}")
            await client.table('memory_extraction_queue').update({
                'status': ExtractionQueueStatus.COMPLETED.value,
                'processed_at': datetime.now(timezone.utc).isoformat()
            }).eq('queue_id', queue_id).execute()
            return None
        
        await client.table('memory_extraction_queue').update({
            'status': ExtractionQueueStatus.COMPLETED.value,
            'processed_at': datetime.now(timezone.utc).isoformat()
        }).eq('queue_id', queue_id).execute()
        
        logger.info(f"Successfully extracted {len(extracted_memories)} memories from thread {thread_id}")
        
        # Return memories in dict format for next activity
        return [
            {
                'content': mem.content,
                'memory_type': mem.memory_type.value,
                'confidence_score': mem.confidence_score,
                'metadata': mem.metadata
            }
            for mem in extracted_memories
        ]
    
    except Exception as e:
        logger.error(f"Memory extraction failed for thread {thread_id}: {str(e)}")
        try:
            from core.memory.models import ExtractionQueueStatus
            await client.table('memory_extraction_queue').update({
                'status': ExtractionQueueStatus.FAILED.value,
                'error_message': str(e),
                'processed_at': datetime.now(timezone.utc).isoformat()
            }).eq('thread_id', thread_id).eq('status', ExtractionQueueStatus.PROCESSING.value).execute()
        except Exception:
            pass
        raise ActivityError(f"Memory extraction failed: {str(e)}")


@activity.defn(name="embed_and_store_memories")
async def embed_and_store_memories_activity(
    account_id: str,
    thread_id: str,
    extracted_memories: List[Dict[str, Any]]
) -> Dict[str, Any]:
    """
    Embed and store extracted memories.
    
    Returns:
        Dict with count of stored memories
    """
    structlog.contextvars.clear_contextvars()
    structlog.contextvars.bind_contextvars(
        thread_id=thread_id,
        account_id=account_id,
        job_type="memory_embedding"
    )
    
    logger.info(f"Starting embedding and storage for {len(extracted_memories)} memories")
    
    await db.initialize()
    client = await db.client
    
    try:
        from core.billing import subscription_service
        from core.billing.shared.config import get_memory_config
        from core.memory.embedding_service import EmbeddingService
        
        tier_info = await subscription_service.get_user_subscription_tier(account_id)
        tier_name = tier_info['name']
        memory_config = get_memory_config(tier_name)
        max_memories = memory_config.get('max_memories', 0)
        
        current_count_result = await client.table('user_memories').select('memory_id', count='exact').eq('account_id', account_id).execute()
        current_count = current_count_result.count or 0
        
        embedding_service = EmbeddingService()
        texts_to_embed = [mem['content'] for mem in extracted_memories]
        embeddings = await embedding_service.embed_texts(texts_to_embed)
        
        memories_to_insert = []
        for i, mem in enumerate(extracted_memories):
            memories_to_insert.append({
                'account_id': account_id,
                'content': mem['content'],
                'memory_type': mem['memory_type'],
                'embedding': embeddings[i],
                'source_thread_id': thread_id,
                'confidence_score': mem.get('confidence_score', 0.8),
                'metadata': mem.get('metadata', {})
            })
        
        if current_count + len(memories_to_insert) > max_memories:
            overflow = (current_count + len(memories_to_insert)) - max_memories
            
            old_memories = await client.table('user_memories').select('memory_id').eq('account_id', account_id).order('confidence_score', desc=False).order('created_at', desc=False).limit(overflow).execute()
            
            if old_memories.data:
                memory_ids_to_delete = [m['memory_id'] for m in old_memories.data]
                await client.table('user_memories').delete().in_('memory_id', memory_ids_to_delete).execute()
                logger.info(f"Deleted {len(memory_ids_to_delete)} old memories to stay within limit")
        
        result = await client.table('user_memories').insert(memories_to_insert).execute()
        
        logger.info(f"Successfully stored {len(result.data)} memories for account {account_id}")
        
        return {"stored_count": len(result.data)}
    
    except Exception as e:
        logger.error(f"Memory embedding and storage failed: {str(e)}")
        raise ActivityError(f"Memory embedding failed: {str(e)}")


@activity.defn(name="consolidate_memories")
async def consolidate_memories_activity(account_id: str) -> Dict[str, Any]:
    """
    Consolidate duplicate memories for an account.
    
    Returns:
        Dict with count of consolidated memories
    """
    structlog.contextvars.clear_contextvars()
    structlog.contextvars.bind_contextvars(
        account_id=account_id,
        job_type="memory_consolidation"
    )
    
    logger.info(f"Starting memory consolidation for account {account_id}")
    
    await db.initialize()
    client = await db.client
    
    try:
        memories_result = await client.table('user_memories').select('*').eq('account_id', account_id).order('created_at', desc=True).limit(500).execute()
        
        memories = memories_result.data or []
        
        if len(memories) < 10:
            logger.debug(f"Not enough memories to consolidate for {account_id}")
            return {"consolidated_count": 0}
        
        import numpy as np
        similarity_threshold = 0.95
        consolidated_count = 0
        
        for i, mem1 in enumerate(memories):
            if not mem1.get('embedding'):
                continue
            
            for mem2 in memories[i+1:]:
                if not mem2.get('embedding'):
                    continue
                
                embedding1 = np.array(mem1['embedding'])
                embedding2 = np.array(mem2['embedding'])
                
                similarity = np.dot(embedding1, embedding2) / (np.linalg.norm(embedding1) * np.linalg.norm(embedding2))
                
                if similarity >= similarity_threshold:
                    if mem1.get('confidence_score', 0) >= mem2.get('confidence_score', 0):
                        await client.table('user_memories').delete().eq('memory_id', mem2['memory_id']).execute()
                    else:
                        await client.table('user_memories').delete().eq('memory_id', mem1['memory_id']).execute()
                        break
                    
                    consolidated_count += 1
        
        logger.info(f"Consolidated {consolidated_count} duplicate memories for account {account_id}")
        
        return {"consolidated_count": consolidated_count}
    
    except Exception as e:
        logger.error(f"Memory consolidation failed for {account_id}: {str(e)}")
        raise ActivityError(f"Memory consolidation failed: {str(e)}")


@activity.defn(name="initialize_thread")
async def initialize_thread_activity(
    thread_id: str,
    project_id: str,
    account_id: str,
    prompt: str,
    agent_id: Optional[str] = None,
    model_name: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Initialize a thread and create agent run record.
    
    This activity performs all the thread initialization work.
    
    Returns:
        Dict with agent_run_id, effective_model, and agent_config
    """
    structlog.contextvars.clear_contextvars()
    structlog.contextvars.bind_contextvars(
        thread_id=thread_id,
        project_id=project_id,
        account_id=account_id,
    )
    
    logger.info(f"Starting thread initialization for thread {thread_id}")
    
    await db.initialize()
    client = await db.client
    
    try:
        from datetime import datetime, timezone
        from core.utils.retry import retry_db_operation
        from core.ai_models import model_manager
        from core.agent_runs import (
            _load_agent_config,
            _get_effective_model,
            _create_agent_run_record,
        )
        
        # Update thread status to initializing
        async def update_thread_initializing():
            client = await db.client
            return await client.table('threads').update({
                "status": "initializing",
                "initialization_started_at": datetime.now(timezone.utc).isoformat()
            }).eq('thread_id', thread_id).execute()
        
        await retry_db_operation(
            update_thread_initializing,
            f"Update thread {thread_id} to initializing",
            max_retries=3,
            initial_delay=1.0,
            reset_connection_on_error=True,
        )
        
        logger.debug(f"Thread {thread_id} marked as initializing")
        
        await asyncio.sleep(0.1)
        
        # Get default model if not provided
        if model_name is None:
            async def get_default_model():
                client = await db.client
                return await model_manager.get_default_model_for_user(client, account_id)
            
            model_name = await retry_db_operation(
                get_default_model,
                f"Get default model for user {account_id}",
                max_retries=3,
                initial_delay=1.0,
            )
        else:
            model_name = model_manager.resolve_model_id(model_name)
        
        # Load agent config
        async def load_agent_config():
            client = await db.client
            return await _load_agent_config(client, agent_id, account_id, account_id, is_new_thread=False)
        
        agent_config = await retry_db_operation(
            load_agent_config,
            f"Load agent config for thread {thread_id}",
            max_retries=3,
            initial_delay=1.0,
        )
        
        # Get effective model
        async def get_effective_model(agent_config):
            client = await db.client
            return await _get_effective_model(model_name, agent_config, client, account_id)
        
        effective_model = await retry_db_operation(
            lambda: get_effective_model(agent_config),
            f"Get effective model for thread {thread_id}",
            max_retries=3,
            initial_delay=1.0,
        )
        
        # Create agent run record
        async def create_agent_run_record(agent_config, effective_model):
            client = await db.client
            return await _create_agent_run_record(client, thread_id, agent_config, effective_model, account_id)
        
        agent_run_id = await retry_db_operation(
            lambda: create_agent_run_record(agent_config, effective_model),
            f"Create agent run record for thread {thread_id}",
            max_retries=3,
            initial_delay=1.0,
        )
        
        # Update thread status to ready
        async def update_thread_ready():
            client = await db.client
            return await client.table('threads').update({
                "status": "ready",
                "initialization_completed_at": datetime.now(timezone.utc).isoformat()
            }).eq('thread_id', thread_id).execute()
        
        await retry_db_operation(
            update_thread_ready,
            f"Update thread {thread_id} to ready",
            max_retries=3,
            initial_delay=1.0,
            reset_connection_on_error=True,
        )
        
        logger.info(f"Thread {thread_id} initialized successfully, agent_run_id: {agent_run_id}")
        
        return {
            "agent_run_id": agent_run_id,
            "effective_model": effective_model,
            "agent_config": agent_config,
        }
        
    except Exception as e:
        error_msg = str(e)
        logger.error(f"Thread initialization failed for thread {thread_id}: {error_msg}")
        
        # Try to update thread status to error
        try:
            from datetime import datetime, timezone
            from core.utils.retry import retry_db_operation
            
            async def update_thread_error():
                client = await db.client
                return await client.table('threads').update({
                    "status": "error",
                    "initialization_error": error_msg[:1000],
                    "initialization_completed_at": datetime.now(timezone.utc).isoformat()
                }).eq('thread_id', thread_id).execute()
            
            await retry_db_operation(
                update_thread_error,
                f"Update thread {thread_id} to error status",
                max_retries=2,
                initial_delay=0.5,
            )
        except Exception as update_error:
            logger.error(f"Failed to update thread status to error: {update_error}")
        
        raise ActivityError(f"Thread initialization failed: {error_msg}")


@activity.defn(name="find_stale_projects")
async def find_stale_projects_activity() -> List[Dict[str, str]]:
    """
    Find stale projects that need categorization.
    
    Returns:
        List of project dicts with project_id
    """
    await db.initialize()
    client = await db.client
    
    try:
        from datetime import datetime, timezone, timedelta
        
        STALE_THRESHOLD_MINUTES = 30
        MAX_PROJECTS_PER_RUN = 50
        
        stale_threshold = datetime.now(timezone.utc) - timedelta(minutes=STALE_THRESHOLD_MINUTES)
        
        # Find projects: inactive 30+ mins AND (never categorized OR has new activity)
        result = await client.rpc(
            'get_stale_projects_for_categorization',
            {
                'stale_threshold': stale_threshold.isoformat(),
                'max_count': MAX_PROJECTS_PER_RUN
            }
        ).execute()
        
        projects = result.data or []
        
        logger.info(f"Found {len(projects)} stale projects for categorization")
        
        return [{"project_id": p["project_id"]} for p in projects]
    
    except Exception as e:
        logger.error(f"Failed to find stale projects: {str(e)}")
        raise ActivityError(f"Failed to find stale projects: {str(e)}")


@activity.defn(name="categorize_project")
async def categorize_project_activity(project_id: str) -> Dict[str, Any]:
    """
    Categorize a project based on its thread messages.
    
    Returns:
        Dict with categories assigned
    """
    logger.info(f"Categorizing project {project_id}")
    
    await db.initialize()
    client = await db.client
    
    try:
        from core.categorization.service import categorize_from_messages
        
        MIN_USER_MESSAGES = 1
        
        # Get the thread for this project
        thread_result = await client.table('threads').select(
            'thread_id'
        ).eq('project_id', project_id).limit(1).execute()
        
        if not thread_result.data:
            logger.debug(f"No thread for project {project_id}")
            # Mark as categorized to avoid re-processing
            await client.table('projects').update({
                'last_categorized_at': datetime.now(timezone.utc).isoformat()
            }).eq('project_id', project_id).execute()
            return {"categories": [], "skipped": True}
        
        thread_id = thread_result.data[0]['thread_id']
        
        # Get messages (type = role, content is JSONB)
        messages_result = await client.table('messages').select(
            'type', 'content'
        ).eq('thread_id', thread_id).order('created_at').execute()
        
        messages = messages_result.data or []
        
        # Check minimum user messages
        user_count = sum(1 for m in messages if m.get('type') == 'user')
        if user_count < MIN_USER_MESSAGES:
            logger.debug(f"Project {project_id} has only {user_count} user messages")
            await client.table('projects').update({
                'last_categorized_at': datetime.now(timezone.utc).isoformat()
            }).eq('project_id', project_id).execute()
            return {"categories": [], "skipped": True}
        
        # Categorize
        categories = await categorize_from_messages(messages)
        if not categories:
            categories = ["Other"]
        
        # Update project
        await client.table('projects').update({
            'categories': categories,
            'last_categorized_at': datetime.now(timezone.utc).isoformat()
        }).eq('project_id', project_id).execute()
        
        logger.info(f"Categorized project {project_id}: {categories}")
        
        return {"categories": categories}
    
    except Exception as e:
        logger.error(f"Categorization failed for project {project_id}: {e}")
        raise ActivityError(f"Categorization failed: {str(e)}")

