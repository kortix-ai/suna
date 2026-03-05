"""Memory background job functions."""

import asyncio
from datetime import datetime, timezone
from typing import List, Dict, Any

from core.utils.logger import logger, structlog
from core.services.convex_client import get_convex_client


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
        
        # Use Convex client
        convex = get_convex_client()
        
        tier_info = await subscription_service.get_user_subscription_tier(account_id)
        if not is_memory_enabled(tier_info['name']):
            logger.debug(f"Memory disabled for tier {tier_info['name']}")
            return
        
        # TODO: Need to add message retrieval endpoint to Convex API
        # For now, we'll need to fetch messages from Convex
        # messages_result = await convex.get_messages(thread_id, account_id)
        # if not messages_result:
        #     return
        
        # Temporary: Skip message fetching for now, the extraction service
        # will need to be updated to work with Convex message format
        logger.warning("Memory extraction temporarily disabled during Convex migration - needs message endpoint")
        return
        
        extraction_service = MemoryExtractionService()
        # if not await extraction_service.should_extract(messages_result):
        #     return
        
        # extracted = await extraction_service.extract_memories(
        #     messages=messages_result,
        #     account_id=account_id,
        #     thread_id=thread_id
        # )
        
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
        
        # Use Convex client
        convex = get_convex_client()
        embedding_service = EmbeddingService()
        
        tier_info = await subscription_service.get_user_subscription_tier(account_id)
        memory_config = get_memory_config(tier_info['name'])
        max_memories = memory_config.get('max_memories', 0)
        
        # Count existing memories via Convex
        existing_memories = await convex.list_memories(
            memory_space_id=account_id,
            account_id=account_id,
            limit=1000
        )
        current_count = len(existing_memories) if existing_memories else 0
        
        texts = [m['content'] for m in extracted_memories]
        embeddings = await embedding_service.embed_texts(texts)
        
        # Handle memory limit - delete oldest/lowest confidence if needed
        if current_count + len(extracted_memories) > max_memories:
            overflow = (current_count + len(extracted_memories)) - max_memories
            # TODO: Need to add delete_memories_by_confidence endpoint to Convex API
            # For now, skip overflow deletion and log warning
            logger.warning(f"Memory limit overflow: {overflow} memories over limit. Need delete endpoint in Convex.")
        
        # Store memories in Convex
        stored_count = 0
        for i, mem in enumerate(extracted_memories):
            try:
                await convex.store_memory(
                    memory_space_id=account_id,
                    content=mem['content'],
                    source_type="conversation",
                    embedding=embeddings[i],
                    metadata={
                        'memory_type': mem['memory_type'],
                        'confidence_score': mem.get('confidence_score', 0.8),
                        'source_thread_id': thread_id,
                        **mem.get('metadata', {})
                    },
                    account_id=account_id
                )
                stored_count += 1
            except Exception as e:
                logger.error(f"Failed to store memory: {e}")
        
        logger.info(f"✅ Stored {stored_count} memories")
        
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
