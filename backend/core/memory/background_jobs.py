"""Memory background job dispatch functions."""

from typing import List, Dict, Any


async def extract_memories(thread_id: str, account_id: str, message_ids: List[str]):
    """Dispatch memory extraction task."""
    from core.worker import dispatch_memory_extraction
    await dispatch_memory_extraction(thread_id, account_id, message_ids)


async def embed_memories(account_id: str, thread_id: str, memories: List[Dict[str, Any]]):
    """Dispatch memory embedding task."""
    from core.worker import dispatch_memory_embedding
    await dispatch_memory_embedding(account_id, thread_id, memories)


async def consolidate_memories(account_id: str):
    """Dispatch memory consolidation task."""
    from core.worker import dispatch_memory_consolidation
    await dispatch_memory_consolidation(account_id)


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


extract_memories_from_conversation = _DispatchWrapper(
    lambda thread_id, account_id, message_ids: 
        __import__('core.worker', fromlist=['dispatch_memory_extraction']).dispatch_memory_extraction(thread_id, account_id, message_ids)
)

embed_and_store_memories = _DispatchWrapper(
    lambda account_id, thread_id, extracted_memories:
        __import__('core.worker', fromlist=['dispatch_memory_embedding']).dispatch_memory_embedding(account_id, thread_id, extracted_memories)
)
