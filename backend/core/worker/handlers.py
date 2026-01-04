"""
Task handlers for Redis Streams worker.

All handlers for processing background tasks.
"""

import asyncio
import time
import uuid
import gc
from datetime import datetime, timezone, timedelta
from typing import Optional

from core.utils.logger import logger, structlog
from core.utils.tool_discovery import warm_up_tools_cache
from core.services.supabase import DBConnection
from core.services import redis
from core.services.langfuse import langfuse
from .tasks import (
    AgentRunTask,
    ThreadInitTask,
    MemoryExtractionTask,
    MemoryEmbeddingTask,
    MemoryConsolidationTask,
    CategorizationTask,
    StaleProjectsTask,
)
from .dispatcher import dispatch_agent_run, dispatch_memory_extraction, dispatch_memory_embedding, dispatch_categorization
from .helpers import (
    initialize,
    acquire_run_lock,
    create_redis_keys,
    stream_status_message,
    load_agent_config,
    update_agent_run_status,
    process_agent_responses,
    handle_normal_completion,
    send_completion_notification,
    send_failure_notification,
    publish_final_control_signal,
    cleanup_redis_keys,
)
from core.run import run_agent
from core.worker.tool_output_streaming_context import (
    set_tool_output_streaming_context,
    clear_tool_output_streaming_context,
)

db = DBConnection()


async def handle_agent_run(task: AgentRunTask):
    """Handle agent run task (can take hours)."""
    agent_run_id = task.agent_run_id
    thread_id = task.thread_id
    instance_id = task.instance_id
    project_id = task.project_id
    model_name = task.model_name
    agent_id = task.agent_id
    account_id = task.account_id
    
    worker_start = time.time()
    
    structlog.contextvars.clear_contextvars()
    structlog.contextvars.bind_contextvars(
        agent_run_id=agent_run_id,
        thread_id=thread_id,
    )
    
    logger.info(f"🚀 Processing agent run: {agent_run_id}")
    
    await initialize()
    
    client = None
    stop_checker = None
    final_status = "failed"
    redis_keys = None
    trace = None
    
    try:
        client = await db.client
        
        lock_acquired = await acquire_run_lock(agent_run_id, instance_id, client)
        if not lock_acquired:
            logger.warning(f"🔒 Lock not acquired for {agent_run_id}")
            return
        
        start_time = datetime.now(timezone.utc)
        cancellation_event = asyncio.Event()
        redis_keys = create_redis_keys(agent_run_id, instance_id)
        
        await stream_status_message(redis_keys['response_stream'], "initializing", "Worker started...")
        await redis.verify_stream_writable(redis_keys['response_stream'])
        
        from core.ai_models import model_manager
        effective_model = model_manager.resolve_model_id(model_name)
        
        trace = langfuse.trace(
            name="agent_run",
            id=agent_run_id,
            session_id=thread_id,
            metadata={"project_id": project_id, "instance_id": instance_id}
        )
        
        stop_signal_checker_state = {'stop_signal_received': False, 'total_responses': 0, 'stop_reason': None}
        
        async def check_for_stop_signal():
            while not stop_signal_checker_state.get('stop_signal_received'):
                try:
                    if await redis.check_stop_signal(agent_run_id):
                        stop_signal_checker_state['stop_signal_received'] = True
                        stop_signal_checker_state['stop_reason'] = 'stop_signal_key'
                        cancellation_event.set()
                        break
                    await asyncio.sleep(0.5)
                except asyncio.CancelledError:
                    break
                except Exception:
                    await asyncio.sleep(1)
        
        stop_checker = asyncio.create_task(check_for_stop_signal())
        
        try:
            await redis.set(redis_keys['instance_active'], "running", ex=redis.REDIS_KEY_TTL)
        except:
            pass
        
        agent_config = await load_agent_config(agent_id, account_id)
        
        set_tool_output_streaming_context(
            agent_run_id=agent_run_id,
            stream_key=redis_keys['response_stream']
        )
        
        agent_gen = run_agent(
            thread_id=thread_id,
            project_id=project_id,
            model_name=effective_model,
            agent_config=agent_config,
            trace=trace,
            cancellation_event=cancellation_event,
            account_id=account_id
        )
        
        final_status, error_message, complete_tool_called, total_responses = await process_agent_responses(
            agent_gen, agent_run_id, redis_keys, trace, worker_start, stop_signal_checker_state
        )
        
        if final_status == "running":
            final_status = "completed"
            await handle_normal_completion(agent_run_id, start_time, total_responses, redis_keys, trace)
            await send_completion_notification(client, thread_id, agent_config, complete_tool_called)
        
        stop_reason = stop_signal_checker_state.get('stop_reason')
        if stop_reason:
            final_status = "stopped"
        
        await update_agent_run_status(client, agent_run_id, final_status, account_id=account_id)
        await publish_final_control_signal(agent_run_id, final_status, stop_reason=stop_reason)
        
        logger.info(f"✅ Agent run completed: {agent_run_id} | status={final_status}")
        
    except Exception as e:
        logger.error(f"Error in agent run {agent_run_id}: {e}", exc_info=True)
        if client:
            await update_agent_run_status(client, agent_run_id, "failed", error=str(e), account_id=account_id)
        raise
        
    finally:
        clear_tool_output_streaming_context()
        
        if stop_checker and not stop_checker.done():
            stop_checker.cancel()
            try:
                await stop_checker
            except:
                pass
        
        if redis_keys:
            await cleanup_redis_keys(agent_run_id, instance_id)
        
        # Queue memory extraction on success
        if final_status == "completed" and account_id and client:
            try:
                messages_result = await client.table('messages').select('message_id').eq('thread_id', thread_id).execute()
                if messages_result.data:
                    message_ids = [m['message_id'] for m in messages_result.data]
                    await dispatch_memory_extraction(thread_id, account_id, message_ids)
            except Exception as e:
                logger.warning(f"Failed to queue memory extraction: {e}")
        
        # Force GC
        gc.collect()


async def handle_thread_init(task: ThreadInitTask):
    """Handle thread initialization task - optimized for TTFT."""
    import time
    t_start = time.time()
    
    thread_id = task.thread_id
    project_id = task.project_id
    account_id = task.account_id
    agent_id = task.agent_id
    model_name = task.model_name
    
    structlog.contextvars.clear_contextvars()
    structlog.contextvars.bind_contextvars(thread_id=thread_id, project_id=project_id)
    
    logger.info(f"🧵 Initializing thread: {thread_id}")
    
    await initialize()
    
    try:
        client = await db.client
        now_iso = datetime.now(timezone.utc).isoformat()
        
        # Import early to avoid import overhead during parallel execution
        from core.ai_models import model_manager
        from core.agents.runs import _load_agent_config, _get_effective_model, _create_agent_run_record
        
        # Resolve model (usually a quick sync operation)
        effective_model = model_name
        if not effective_model:
            effective_model = await model_manager.get_default_model_for_user(client, account_id)
        else:
            effective_model = model_manager.resolve_model_id(effective_model)
        
        # Load agent config and create agent_run record (can be done before status update)
        t_config = time.time()
        agent_config = await _load_agent_config(client, agent_id, account_id, account_id, is_new_thread=False)
        effective_model = await _get_effective_model(model_name, agent_config, client, account_id)
        agent_run_id = await _create_agent_run_record(client, thread_id, agent_config, effective_model, account_id)
        logger.debug(f"⏱️ [TIMING] Agent config + run record: {(time.time() - t_config) * 1000:.1f}ms")
        
        # Update thread status and dispatch agent run in parallel
        worker_instance_id = str(uuid.uuid4())[:8]
        
        async def update_status():
            await client.table('threads').update({
                "status": "ready",
                "initialization_started_at": now_iso,
                "initialization_completed_at": now_iso
            }).eq('thread_id', thread_id).execute()
        
        async def dispatch():
            await dispatch_agent_run(
                agent_run_id=agent_run_id,
                thread_id=thread_id,
                instance_id=worker_instance_id,
                project_id=project_id,
                model_name=effective_model,
                agent_id=agent_id,
                account_id=account_id,
            )
        
        t_parallel = time.time()
        await asyncio.gather(update_status(), dispatch())
        logger.debug(f"⏱️ [TIMING] Parallel status+dispatch: {(time.time() - t_parallel) * 1000:.1f}ms")
        
        logger.info(f"✅ Thread init complete: {thread_id} → {agent_run_id} ({(time.time() - t_start) * 1000:.1f}ms)")
        
    except Exception as e:
        logger.error(f"Thread init failed for {thread_id}: {e}", exc_info=True)
        try:
            client = await db.client
            await client.table('threads').update({
                "status": "error",
                "initialization_error": str(e)[:1000],
            }).eq('thread_id', thread_id).execute()
        except:
            pass
        raise


async def handle_memory_extraction(task: MemoryExtractionTask):
    """Handle memory extraction task."""
    thread_id = task.thread_id
    account_id = task.account_id
    message_ids = task.message_ids
    
    structlog.contextvars.clear_contextvars()
    structlog.contextvars.bind_contextvars(thread_id=thread_id, account_id=account_id)
    
    logger.info(f"🧠 Extracting memories from thread: {thread_id}")
    
    await initialize()
    
    try:
        from core.memory.extraction_service import MemoryExtractionService
        from core.billing import subscription_service
        from core.billing.shared.config import is_memory_enabled
        
        client = await db.client
        
        # Check if memory is enabled for user
        tier_info = await subscription_service.get_user_subscription_tier(account_id)
        if not is_memory_enabled(tier_info['name']):
            logger.debug(f"Memory disabled for tier {tier_info['name']}")
            return
        
        # Get messages
        messages_result = await client.table('messages').select('*').in_('message_id', message_ids).execute()
        if not messages_result.data:
            return
        
        # Extract
        extraction_service = MemoryExtractionService()
        if not await extraction_service.should_extract(messages_result.data):
            return
        
        extracted = await extraction_service.extract_memories(
            messages=messages_result.data,
            account_id=account_id,
            thread_id=thread_id
        )
        
        if extracted:
            await dispatch_memory_embedding(
                account_id, 
                thread_id, 
                [{'content': m.content, 'memory_type': m.memory_type.value, 'confidence_score': m.confidence_score, 'metadata': m.metadata} for m in extracted]
            )
        
        logger.info(f"✅ Extracted {len(extracted) if extracted else 0} memories")
        
    except Exception as e:
        logger.error(f"Memory extraction failed: {e}", exc_info=True)


async def handle_memory_embedding(task: MemoryEmbeddingTask):
    """Handle memory embedding task."""
    account_id = task.account_id
    thread_id = task.thread_id
    memories = task.extracted_memories
    
    structlog.contextvars.clear_contextvars()
    structlog.contextvars.bind_contextvars(account_id=account_id)
    
    logger.info(f"💾 Embedding {len(memories)} memories")
    
    await initialize()
    
    try:
        from core.memory.embedding_service import EmbeddingService
        from core.billing import subscription_service
        from core.billing.shared.config import get_memory_config
        
        client = await db.client
        embedding_service = EmbeddingService()
        
        tier_info = await subscription_service.get_user_subscription_tier(account_id)
        memory_config = get_memory_config(tier_info['name'])
        max_memories = memory_config.get('max_memories', 0)
        
        # Get current count
        current_count_result = await client.table('user_memories').select('memory_id', count='exact').eq('account_id', account_id).execute()
        current_count = current_count_result.count or 0
        
        # Embed
        texts = [m['content'] for m in memories]
        embeddings = await embedding_service.embed_texts(texts)
        
        # Prepare inserts
        to_insert = []
        for i, mem in enumerate(memories):
            to_insert.append({
                'account_id': account_id,
                'content': mem['content'],
                'memory_type': mem['memory_type'],
                'embedding': embeddings[i],
                'source_thread_id': thread_id,
                'confidence_score': mem.get('confidence_score', 0.8),
                'metadata': mem.get('metadata', {})
            })
        
        # Handle overflow
        if current_count + len(to_insert) > max_memories:
            overflow = (current_count + len(to_insert)) - max_memories
            old = await client.table('user_memories').select('memory_id').eq('account_id', account_id).order('confidence_score', desc=False).limit(overflow).execute()
            if old.data:
                ids_to_delete = [m['memory_id'] for m in old.data]
                await client.table('user_memories').delete().in_('memory_id', ids_to_delete).execute()
        
        await client.table('user_memories').insert(to_insert).execute()
        logger.info(f"✅ Stored {len(to_insert)} memories")
        
    except Exception as e:
        logger.error(f"Memory embedding failed: {e}", exc_info=True)


async def handle_memory_consolidation(task: MemoryConsolidationTask):
    """Handle memory consolidation."""
    logger.info(f"🔄 Consolidating memories for {task.account_id}")
    # Placeholder - implement if needed


async def handle_categorization(task: CategorizationTask):
    """Handle project categorization."""
    project_id = task.project_id
    
    logger.info(f"🏷️ Categorizing project: {project_id}")
    
    await initialize()
    
    try:
        from core.categorization.service import categorize_from_messages
        
        client = await db.client
        
        # Get threads
        threads = await client.table('threads').select('thread_id').eq('project_id', project_id).limit(1).execute()
        if not threads.data:
            await client.table('projects').update({'last_categorized_at': datetime.now(timezone.utc).isoformat()}).eq('project_id', project_id).execute()
            return
        
        thread_id = threads.data[0]['thread_id']
        
        # Get messages
        messages = await client.table('messages').select('type', 'content').eq('thread_id', thread_id).order('created_at').execute()
        
        user_count = sum(1 for m in (messages.data or []) if m.get('type') == 'user')
        if user_count < 1:
            await client.table('projects').update({'last_categorized_at': datetime.now(timezone.utc).isoformat()}).eq('project_id', project_id).execute()
            return
        
        categories = await categorize_from_messages(messages.data) or ["Other"]
        
        await client.table('projects').update({
            'categories': categories,
            'last_categorized_at': datetime.now(timezone.utc).isoformat()
        }).eq('project_id', project_id).execute()
        
        logger.info(f"✅ Categorized project {project_id}: {categories}")
        
    except Exception as e:
        logger.error(f"Categorization failed: {e}", exc_info=True)


async def handle_stale_projects(task: StaleProjectsTask):
    """Handle stale projects processing."""
    logger.info("🕐 Processing stale projects")
    
    await initialize()
    
    try:
        client = await db.client
        
        cutoff = (datetime.now(timezone.utc) - timedelta(minutes=30)).isoformat()
        
        result = await client.rpc(
            'get_stale_projects_for_categorization',
            {'stale_threshold': cutoff, 'max_count': 50}
        ).execute()
        
        for project in result.data or []:
            await dispatch_categorization(project['project_id'])
        
        logger.info(f"✅ Queued {len(result.data or [])} stale projects")
        
    except Exception as e:
        logger.error(f"Stale projects processing failed: {e}", exc_info=True)


def get_handlers():
    """Get all task handlers."""
    return {
        "agent_run": handle_agent_run,
        "thread_init": handle_thread_init,
        "memory_extraction": handle_memory_extraction,
        "memory_embedding": handle_memory_embedding,
        "memory_consolidation": handle_memory_consolidation,
        "categorization": handle_categorization,
        "stale_projects": handle_stale_projects,
    }

