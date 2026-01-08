"""Memory background job functions."""

import asyncio
from datetime import datetime, timezone
from typing import List, Dict, Any

from core.utils.logger import logger, structlog
from core.services.supabase import DBConnection

_db = DBConnection()


async def run_memory_extraction(
    thread_id: str,
    account_id: str,
    message_ids: List[str],
) -> None:
    """Extract memories from messages - runs as async background task."""
    from core.utils.config import config
    from core.utils.init_helpers import initialize
    
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
        
        client = await _db.client
        
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
    from core.utils.init_helpers import initialize
    
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
        
        client = await _db.client
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


def start_memory_extraction(thread_id: str, account_id: str, message_ids: List[str]) -> None:
    """Start memory extraction as background task."""
    asyncio.create_task(run_memory_extraction(thread_id, account_id, message_ids))
    logger.debug(f"Started memory extraction for thread {thread_id}")


def start_memory_embedding(account_id: str, thread_id: str, extracted_memories: List[Dict[str, Any]]) -> None:
    """Start memory embedding as background task."""
    asyncio.create_task(run_memory_embedding(account_id, thread_id, extracted_memories))
    logger.debug(f"Started memory embedding for thread {thread_id}")


async def extract_memories(thread_id: str, account_id: str, message_ids: List[str]):
    """Start memory extraction task."""
    from core.utils.config import config
    if not config.ENABLE_MEMORY:
        return
    start_memory_extraction(thread_id, account_id, message_ids)


async def embed_memories(account_id: str, thread_id: str, memories: List[Dict[str, Any]]):
    """Start memory embedding task."""
    from core.utils.config import config
    if not config.ENABLE_MEMORY:
        return
    start_memory_embedding(account_id, thread_id, memories)


# Backwards-compatible wrappers with .send() interface
class _DispatchWrapper:
    def __init__(self, dispatch_fn):
        self._dispatch_fn = dispatch_fn
    
    def send(self, **kwargs):
        import asyncio
        try:
            loop = asyncio.get_running_loop()
            asyncio.create_task(self._dispatch_fn(**kwargs))
        except RuntimeError:
            asyncio.run(self._dispatch_fn(**kwargs))


async def _extract_memories_wrapper(thread_id: str, account_id: str, message_ids: List[str]):
    """Wrapper that checks ENABLE_MEMORY before dispatching."""
    from core.utils.config import config
    if config.ENABLE_MEMORY:
        await extract_memories(thread_id, account_id, message_ids)

async def _embed_memories_wrapper(account_id: str, thread_id: str, extracted_memories: List[Dict[str, Any]]):
    """Wrapper that checks ENABLE_MEMORY before dispatching."""
    from core.utils.config import config
    if config.ENABLE_MEMORY:
        await embed_memories(account_id, thread_id, extracted_memories)

extract_memories_from_conversation = _DispatchWrapper(_extract_memories_wrapper)
embed_and_store_memories = _DispatchWrapper(_embed_memories_wrapper)
