"""
Temporal activities - work units that can be retried and heartbeated.
"""
import asyncio
import json
import time
import traceback
from datetime import datetime, timezone, timedelta
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

from run_agent_background import (
    initialize, acquire_run_lock, load_agent_config, create_redis_keys,
    process_agent_responses, handle_normal_completion, send_completion_notification,
    send_failure_notification, update_agent_run_status, cleanup_redis_keys_for_agent_run,
)

db = DBConnection()


def bind_context(**kwargs):
    """Helper to set structured logging context."""
    structlog.contextvars.clear_contextvars()
    structlog.contextvars.bind_contextvars(**kwargs)


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
    """Execute an agent run with heartbeating and cancellation support."""
    bind_context(agent_run_id=agent_run_id, thread_id=thread_id, request_id=request_id)
    worker_start = time.time()
    # #region agent log
    try:
        import urllib.request as _ur; _ur.urlopen(_ur.Request('http://host.docker.internal:7242/ingest/8574b837-03d2-4ece-8422-988bb17343e8',data=__import__('json').dumps({"location":"activities.py:run_agent:start","message":"run_agent STARTED","data":{"agent_run_id":agent_run_id,"thread_id":thread_id,"instance_id":instance_id},"timestamp":time.time()*1000,"sessionId":"debug-session","hypothesisId":"A,C,E"}).encode(),headers={'Content-Type':'application/json'}),timeout=1)
    except: pass
    # #endregion
    
    try:
        await initialize()
    except Exception as e:
        raise ActivityError(f"Worker init failed: {e}")
    
    client = await db.client
    
    # Acquire lock
    if not await acquire_run_lock(agent_run_id, instance_id, client):
        return {"status": "skipped", "reason": "lock_not_acquired"}
    
    sentry.sentry.set_tag("thread_id", thread_id)
    logger.info(f"Starting agent run: {agent_run_id} (thread: {thread_id})")
    
    from core.ai_models import model_manager
    effective_model = model_manager.resolve_model_id(model_name)
    
    start_time = datetime.now(timezone.utc)
    cancellation_event = asyncio.Event()
    redis_keys = create_redis_keys(agent_run_id, instance_id)
    
    # #region agent log
    try:
        import urllib.request as _ur; _ur.urlopen(_ur.Request('http://host.docker.internal:7242/ingest/8574b837-03d2-4ece-8422-988bb17343e8',data=__import__('json').dumps({"location":"activities.py:run_agent:redis_keys","message":"Redis keys created","data":{"agent_run_id":agent_run_id,"stream_key":redis_keys['response_stream']},"timestamp":time.time()*1000,"sessionId":"debug-session","hypothesisId":"B"}).encode(),headers={'Content-Type':'application/json'}),timeout=1)
    except: pass
    # #endregion
    
    await redis.verify_stream_writable(redis_keys['response_stream'])
    
    trace = langfuse.trace(
        name="agent_run", id=agent_run_id, session_id=thread_id,
        metadata={"project_id": project_id, "instance_id": instance_id}
    )
    
    await redis.set(redis_keys['instance_active'], "running", ex=redis.REDIS_KEY_TTL)
    agent_config = await load_agent_config(agent_id, account_id)
    set_tool_output_streaming_context(agent_run_id=agent_run_id, stream_key=redis_keys['response_stream'])
    
    # State for heartbeat checker
    state = {'stop': False, 'total_responses': 0, 'last_type': None}
    
    async def heartbeat_loop():
        """Send heartbeats and check for cancellation."""
        count = 0
        while not state['stop']:
            count += 1
            activity.heartbeat({
                "agent_run_id": agent_run_id,
                "responses": state['total_responses'],
                "running_seconds": (datetime.now(timezone.utc) - start_time).total_seconds(),
            })
            
            if activity.is_cancelled():
                logger.warning(f"🛑 Cancellation detected: {agent_run_id}")
                state['stop'] = True
                cancellation_event.set()
                break
            
            if count % 25 == 0:
                await redis.expire(redis_keys['instance_active'], redis.REDIS_KEY_TTL)
            
            await asyncio.sleep(0.5)
    
    heartbeat_task = asyncio.create_task(heartbeat_loop())
    final_status = "failed"
    error_message = None
    
    try:
        agent_gen = run_agent(
            thread_id=thread_id, project_id=project_id, model_name=effective_model,
            agent_config=agent_config, trace=trace, cancellation_event=cancellation_event,
            account_id=account_id,
        )
        
        logger.info(f"⏱️ Ready for LLM: {(time.time() - worker_start) * 1000:.0f}ms")
        
        final_status, error_message, complete_tool_called, total_responses = await process_agent_responses(
            agent_gen, agent_run_id, redis_keys, trace, worker_start, state
        )
        
        if final_status == "running":
            final_status = "completed"
            await handle_normal_completion(agent_run_id, start_time, total_responses, redis_keys, trace)
            await send_completion_notification(client, thread_id, agent_config, complete_tool_called)
        
        await update_agent_run_status(client, agent_run_id, final_status, error=error_message, account_id=account_id)
        
        if final_status == "failed" and error_message:
            await send_failure_notification(client, thread_id, error_message)
        
        return {"status": final_status, "error": error_message, "total_responses": total_responses}
        
    except Exception as e:
        error_message = str(e)
        logger.error(f"Agent run {agent_run_id} failed: {error_message}")
        trace.span(name="agent_run_failed").end(status_message=error_message, level="ERROR")
        await send_failure_notification(client, thread_id, error_message)
        
        try:
            await redis.stream_add(redis_keys['response_stream'], {'data': json.dumps({"type": "status", "status": "error", "message": error_message})}, maxlen=200)
        except Exception:
            pass
        
        await update_agent_run_status(client, agent_run_id, "failed", error=f"{error_message}\n{traceback.format_exc()}", account_id=account_id)
        raise ActivityError(f"Agent run failed: {error_message}")
        
    finally:
        state['stop'] = True
        heartbeat_task.cancel()
        try:
            await heartbeat_task
        except asyncio.CancelledError:
            pass
        
        clear_tool_output_streaming_context()
        await cleanup_redis_keys_for_agent_run(agent_run_id, instance_id)


@activity.defn(name="initialize_thread")
async def initialize_thread_activity(
    thread_id: str,
    project_id: str,
    account_id: str,
    prompt: str,
    agent_id: Optional[str] = None,
    model_name: Optional[str] = None,
) -> Dict[str, Any]:
    """Initialize thread and create agent run record."""
    bind_context(thread_id=thread_id, project_id=project_id, account_id=account_id)
    logger.info(f"Initializing thread {thread_id}")
    # #region agent log
    try:
        import urllib.request as _ur; _ur.urlopen(_ur.Request('http://host.docker.internal:7242/ingest/8574b837-03d2-4ece-8422-988bb17343e8',data=__import__('json').dumps({"location":"activities.py:initialize_thread:start","message":"initialize_thread STARTED","data":{"thread_id":thread_id},"timestamp":time.time()*1000,"sessionId":"debug-session","hypothesisId":"A,D"}).encode(),headers={'Content-Type':'application/json'}),timeout=1)
    except: pass
    # #endregion
    
    await db.initialize()
    client = await db.client
    
    try:
        from core.utils.retry import retry_db_operation
        from core.ai_models import model_manager
        from core.agent_runs import _load_agent_config, _get_effective_model, _create_agent_run_record
        
        # Mark thread initializing
        await client.table('threads').update({
            "status": "initializing",
            "initialization_started_at": datetime.now(timezone.utc).isoformat()
        }).eq('thread_id', thread_id).execute()
        
        # Get model
        if model_name is None:
            model_name = await model_manager.get_default_model_for_user(client, account_id)
        else:
            model_name = model_manager.resolve_model_id(model_name)
        
        # Load config and create run
        agent_config = await _load_agent_config(client, agent_id, account_id, account_id, is_new_thread=False)
        effective_model = await _get_effective_model(model_name, agent_config, client, account_id)
        agent_run_id = await _create_agent_run_record(client, thread_id, agent_config, effective_model, account_id)
        
        # Mark ready
        await client.table('threads').update({
            "status": "ready",
            "initialization_completed_at": datetime.now(timezone.utc).isoformat()
        }).eq('thread_id', thread_id).execute()
        
        # Pre-create the stream so frontend can subscribe immediately
        stream_key = f"agent_run:{agent_run_id}:stream"
        await redis.verify_stream_writable(stream_key)
        
        # #region agent log
        try:
            import urllib.request as _ur; _ur.urlopen(_ur.Request('http://host.docker.internal:7242/ingest/8574b837-03d2-4ece-8422-988bb17343e8',data=__import__('json').dumps({"location":"activities.py:initialize_thread:stream_created","message":"Stream pre-created","data":{"thread_id":thread_id,"agent_run_id":agent_run_id,"stream_key":stream_key},"timestamp":time.time()*1000,"sessionId":"debug-session","hypothesisId":"B,D"}).encode(),headers={'Content-Type':'application/json'}),timeout=1)
        except: pass
        # #endregion
        
        logger.info(f"Thread {thread_id} ready, agent_run_id: {agent_run_id}")
        return {"agent_run_id": agent_run_id, "effective_model": effective_model, "agent_config": agent_config}
        
    except Exception as e:
        logger.error(f"Thread init failed: {e}")
        try:
            await client.table('threads').update({
                "status": "error",
                "initialization_error": str(e)[:1000],
            }).eq('thread_id', thread_id).execute()
        except Exception:
            pass
        raise ActivityError(f"Thread init failed: {e}")


@activity.defn(name="extract_memories")
async def extract_memories_activity(thread_id: str, account_id: str, message_ids: List[str]) -> Optional[List[Dict[str, Any]]]:
    """Extract memories from conversation messages."""
    bind_context(thread_id=thread_id, account_id=account_id, job_type="memory_extraction")
    logger.info(f"Extracting memories from {thread_id}")
    
    await db.initialize()
    client = await db.client
    
    try:
        from core.billing import subscription_service
        from core.billing.shared.config import is_memory_enabled
        from core.memory.extraction_service import MemoryExtractionService
        from core.memory.models import ExtractionQueueStatus
        
        # Check if memory enabled
        tier = (await subscription_service.get_user_subscription_tier(account_id))['name']
        if not is_memory_enabled(tier):
            return None
        
        user_enabled = (await client.rpc('get_user_memory_enabled', {'p_account_id': account_id}).execute()).data
        if user_enabled is False:
            return None
        
        # Check recent extraction
        recent = await client.table('memory_extraction_queue').select('created_at').eq('thread_id', thread_id).eq('status', 'completed').order('created_at', desc=True).limit(1).execute()
        if recent.data:
            last = datetime.fromisoformat(recent.data[0]['created_at'].replace('Z', '+00:00'))
            if datetime.now(timezone.utc) - last < timedelta(hours=1):
                return None
        
        # Get messages and check if enough content
        messages = (await client.table('messages').select('*').in_('message_id', message_ids).execute()).data or []
        service = MemoryExtractionService()
        if not await service.should_extract(messages):
            return None
        
        # Create queue entry
        queue = await client.table('memory_extraction_queue').insert({
            'thread_id': thread_id, 'account_id': account_id, 'message_ids': message_ids,
            'status': ExtractionQueueStatus.PROCESSING.value
        }).execute()
        queue_id = queue.data[0]['queue_id']
        
        # Extract
        memories = await service.extract_memories(messages=messages, account_id=account_id, thread_id=thread_id)
        
        await client.table('memory_extraction_queue').update({
            'status': ExtractionQueueStatus.COMPLETED.value,
            'processed_at': datetime.now(timezone.utc).isoformat()
        }).eq('queue_id', queue_id).execute()
        
        if not memories:
            return None
        
        logger.info(f"Extracted {len(memories)} memories from {thread_id}")
        return [{'content': m.content, 'memory_type': m.memory_type.value, 'confidence_score': m.confidence_score, 'metadata': m.metadata} for m in memories]
        
    except Exception as e:
        logger.error(f"Memory extraction failed: {e}")
        raise ActivityError(f"Memory extraction failed: {e}")


@activity.defn(name="embed_and_store_memories")
async def embed_and_store_memories_activity(account_id: str, thread_id: str, extracted_memories: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Embed and store extracted memories."""
    bind_context(thread_id=thread_id, account_id=account_id, job_type="memory_embedding")
    logger.info(f"Storing {len(extracted_memories)} memories")
    
    await db.initialize()
    client = await db.client
    
    try:
        from core.billing import subscription_service
        from core.billing.shared.config import get_memory_config
        from core.memory.embedding_service import EmbeddingService
        
        tier = (await subscription_service.get_user_subscription_tier(account_id))['name']
        max_memories = get_memory_config(tier).get('max_memories', 0)
        current_count = (await client.table('user_memories').select('memory_id', count='exact').eq('account_id', account_id).execute()).count or 0
        
        # Embed
        embeddings = await EmbeddingService().embed_texts([m['content'] for m in extracted_memories])
        
        # Prepare inserts
        to_insert = [{
            'account_id': account_id, 'content': m['content'], 'memory_type': m['memory_type'],
            'embedding': embeddings[i], 'source_thread_id': thread_id,
            'confidence_score': m.get('confidence_score', 0.8), 'metadata': m.get('metadata', {})
        } for i, m in enumerate(extracted_memories)]
        
        # Delete old if over limit
        if current_count + len(to_insert) > max_memories:
            overflow = (current_count + len(to_insert)) - max_memories
            old = await client.table('user_memories').select('memory_id').eq('account_id', account_id).order('confidence_score').order('created_at').limit(overflow).execute()
            if old.data:
                await client.table('user_memories').delete().in_('memory_id', [m['memory_id'] for m in old.data]).execute()
        
        result = await client.table('user_memories').insert(to_insert).execute()
        logger.info(f"Stored {len(result.data)} memories")
        return {"stored_count": len(result.data)}
        
    except Exception as e:
        raise ActivityError(f"Memory storage failed: {e}")


@activity.defn(name="consolidate_memories")
async def consolidate_memories_activity(account_id: str) -> Dict[str, Any]:
    """Consolidate duplicate memories."""
    bind_context(account_id=account_id, job_type="memory_consolidation")
    
    await db.initialize()
    client = await db.client
    
    try:
        import numpy as np
        
        memories = (await client.table('user_memories').select('*').eq('account_id', account_id).order('created_at', desc=True).limit(500).execute()).data or []
        if len(memories) < 10:
            return {"consolidated_count": 0}
        
        consolidated = 0
        threshold = 0.95
        
        for i, m1 in enumerate(memories):
            if not m1.get('embedding'):
                continue
            for m2 in memories[i+1:]:
                if not m2.get('embedding'):
                    continue
                
                e1, e2 = np.array(m1['embedding']), np.array(m2['embedding'])
                sim = np.dot(e1, e2) / (np.linalg.norm(e1) * np.linalg.norm(e2))
                
                if sim >= threshold:
                    to_delete = m2 if m1.get('confidence_score', 0) >= m2.get('confidence_score', 0) else m1
                    await client.table('user_memories').delete().eq('memory_id', to_delete['memory_id']).execute()
                    consolidated += 1
                    if to_delete == m1:
                        break
        
        logger.info(f"Consolidated {consolidated} memories")
        return {"consolidated_count": consolidated}
        
    except Exception as e:
        raise ActivityError(f"Consolidation failed: {e}")


@activity.defn(name="find_stale_projects")
async def find_stale_projects_activity() -> List[Dict[str, str]]:
    """Find stale projects needing categorization."""
    await db.initialize()
    client = await db.client
    
    try:
        threshold = datetime.now(timezone.utc) - timedelta(minutes=30)
        result = await client.rpc('get_stale_projects_for_categorization', {
            'stale_threshold': threshold.isoformat(), 'max_count': 50
        }).execute()
        
        projects = result.data or []
        logger.info(f"Found {len(projects)} stale projects")
        return [{"project_id": p["project_id"]} for p in projects]
        
    except Exception as e:
        raise ActivityError(f"Find stale projects failed: {e}")


@activity.defn(name="categorize_project")
async def categorize_project_activity(project_id: str) -> Dict[str, Any]:
    """Categorize a project based on messages."""
    logger.info(f"Categorizing {project_id}")
    
    await db.initialize()
    client = await db.client
    
    try:
        from core.categorization.service import categorize_from_messages
        
        # Get thread
        thread = await client.table('threads').select('thread_id').eq('project_id', project_id).limit(1).execute()
        if not thread.data:
            await client.table('projects').update({'last_categorized_at': datetime.now(timezone.utc).isoformat()}).eq('project_id', project_id).execute()
            return {"categories": [], "skipped": True}
        
        # Get messages
        messages = (await client.table('messages').select('type', 'content').eq('thread_id', thread.data[0]['thread_id']).order('created_at').execute()).data or []
        
        if sum(1 for m in messages if m.get('type') == 'user') < 1:
            await client.table('projects').update({'last_categorized_at': datetime.now(timezone.utc).isoformat()}).eq('project_id', project_id).execute()
            return {"categories": [], "skipped": True}
        
        categories = await categorize_from_messages(messages) or ["Other"]
        
        await client.table('projects').update({
            'categories': categories, 'last_categorized_at': datetime.now(timezone.utc).isoformat()
        }).eq('project_id', project_id).execute()
        
        logger.info(f"Categorized {project_id}: {categories}")
        return {"categories": categories}
        
    except Exception as e:
        raise ActivityError(f"Categorization failed: {e}")
