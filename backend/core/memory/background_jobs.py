"""Memory background job dispatch functions."""

from typing import List, Dict, Any


async def extract_memories(thread_id: str, account_id: str, message_ids: List[str]):
    """Start memory extraction task."""
    from core.utils.config import config
    if not config.ENABLE_MEMORY:
        return
    from core.worker.background_tasks import start_memory_extraction
    start_memory_extraction(thread_id, account_id, message_ids)


async def embed_memories(account_id: str, thread_id: str, memories: List[Dict[str, Any]]):
    """Start memory embedding task."""
    from core.utils.config import config
    if not config.ENABLE_MEMORY:
        return
    from core.worker.background_tasks import start_memory_embedding
    start_memory_embedding(account_id, thread_id, memories)


async def consolidate_memories(account_id: str):
    """Start memory consolidation task."""
    from core.utils.config import config
    if not config.ENABLE_MEMORY:
        return
    from core.worker.background_tasks import start_memory_consolidation
    start_memory_consolidation(account_id)


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
