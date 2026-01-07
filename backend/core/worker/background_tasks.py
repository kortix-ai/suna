"""
Background tasks for memory and categorization.

Simple async task functions that run directly - no dispatch overhead.
"""

import asyncio
from datetime import datetime, timezone, timedelta
from typing import List, Dict, Any

from core.utils.logger import logger, structlog
from core.services.supabase import DBConnection
from core.worker.helpers import initialize
from core.worker.tasks import (
    MemoryExtractionTask,
    MemoryEmbeddingTask,
    MemoryConsolidationTask,
    CategorizationTask,
    StaleProjectsTask,
)

db = DBConnection()


async def run_memory_extraction(
    thread_id: str,
    account_id: str,
    message_ids: List[str],
) -> None:
    """Extract memories from messages - runs as async background task."""
    from core.utils.config import config
    
    if not config.ENABLE_MEMORY:
        logger.debug("Memory extraction skipped: ENABLE_MEMORY is False")
        return
    
    structlog.contextvars.clear_contextvars()
    structlog.contextvars.bind_contextvars(thread_id=thread_id, account_id=account_id)
    
    logger.info(f"🧠 Extracting memories from thread: {thread_id}")
    
    await initialize()
    
    try:
        from core.memory.extraction_service import MemoryExtractionService
        from core.billing import subscription_service
        from core.billing.shared.config import is_memory_enabled
        
        client = await db.client
        
        tier_info = await subscription_service.get_user_subscription_tier(account_id)
        if not is_memory_enabled(tier_info['name']):
            logger.debug(f"Memory disabled for tier {tier_info['name']}")
            return
        
        messages_result = await client.table('messages').select('*').in_('message_id', message_ids).execute()
        if not messages_result.data:
            return
        
        extraction_service = MemoryExtractionService()
        if not await extraction_service.should_extract(messages_result.data):
            return
        
        extracted = await extraction_service.extract_memories(
            messages=messages_result.data,
            account_id=account_id,
            thread_id=thread_id
        )
        
        if extracted:
            asyncio.create_task(run_memory_embedding(
                account_id, 
                thread_id, 
                [{'content': m.content, 'memory_type': m.memory_type.value, 'confidence_score': m.confidence_score, 'metadata': m.metadata} for m in extracted]
            ))
        
        logger.info(f"✅ Extracted {len(extracted) if extracted else 0} memories")
        
    except Exception as e:
        logger.error(f"Memory extraction failed: {e}", exc_info=True)


async def run_memory_embedding(
    account_id: str,
    thread_id: str,
    extracted_memories: List[Dict[str, Any]],
) -> None:
    """Embed and store memories - runs as async background task."""
    from core.utils.config import config
    
    if not config.ENABLE_MEMORY:
        logger.debug("Memory embedding skipped: ENABLE_MEMORY is False")
        return
    
    structlog.contextvars.clear_contextvars()
    structlog.contextvars.bind_contextvars(account_id=account_id)
    
    logger.info(f"💾 Embedding {len(extracted_memories)} memories")
    
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
        
        current_count_result = await client.table('user_memories').select('memory_id', count='exact').eq('account_id', account_id).execute()
        current_count = current_count_result.count or 0
        
        texts = [m['content'] for m in extracted_memories]
        embeddings = await embedding_service.embed_texts(texts)
        
        to_insert = []
        for i, mem in enumerate(extracted_memories):
            to_insert.append({
                'account_id': account_id,
                'content': mem['content'],
                'memory_type': mem['memory_type'],
                'embedding': embeddings[i],
                'source_thread_id': thread_id,
                'confidence_score': mem.get('confidence_score', 0.8),
                'metadata': mem.get('metadata', {})
            })
        
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


async def run_memory_consolidation(account_id: str) -> None:
    """Consolidate memories - runs as async background task."""
    from core.utils.config import config
    
    if not config.ENABLE_MEMORY:
        logger.debug("Memory consolidation skipped: ENABLE_MEMORY is False")
        return
    
    logger.info(f"🔄 Consolidating memories for {account_id}")
    # Placeholder - implement if needed


async def run_categorization(project_id: str) -> None:
    """Categorize project - runs as async background task."""
    logger.info(f"🏷️ Categorizing project: {project_id}")
    
    await initialize()
    
    try:
        from core.categorization.service import categorize_from_messages
        
        client = await db.client
        
        threads = await client.table('threads').select('thread_id').eq('project_id', project_id).limit(1).execute()
        if not threads.data:
            await client.table('projects').update({'last_categorized_at': datetime.now(timezone.utc).isoformat()}).eq('project_id', project_id).execute()
            return
        
        thread_id = threads.data[0]['thread_id']
        
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


async def run_stale_projects() -> None:
    """Process stale projects - runs as async background task."""
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
            asyncio.create_task(run_categorization(project['project_id']))
        
        logger.info(f"✅ Queued {len(result.data or [])} stale projects")
        
    except Exception as e:
        logger.error(f"Stale projects processing failed: {e}", exc_info=True)


# Convenience functions that start tasks asynchronously
def start_memory_extraction(thread_id: str, account_id: str, message_ids: List[str]) -> None:
    """Start memory extraction as background task."""
    asyncio.create_task(run_memory_extraction(thread_id, account_id, message_ids))
    logger.debug(f"Started memory extraction for thread {thread_id}")


def start_memory_embedding(account_id: str, thread_id: str, extracted_memories: List[Dict[str, Any]]) -> None:
    """Start memory embedding as background task."""
    asyncio.create_task(run_memory_embedding(account_id, thread_id, extracted_memories))
    logger.debug(f"Started memory embedding for thread {thread_id}")


def start_memory_consolidation(account_id: str) -> None:
    """Start memory consolidation as background task."""
    asyncio.create_task(run_memory_consolidation(account_id))
    logger.debug(f"Started memory consolidation for account {account_id}")


def start_categorization(project_id: str) -> None:
    """Start categorization as background task."""
    asyncio.create_task(run_categorization(project_id))
    logger.debug(f"Started categorization for project {project_id}")


def start_stale_projects() -> None:
    """Start stale projects processing as background task."""
    asyncio.create_task(run_stale_projects())
    logger.debug("Started stale projects processing")

