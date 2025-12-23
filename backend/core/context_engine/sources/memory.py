from typing import List, Optional

from .base import ContextSource
from ..types import ContextChunk, ImportanceLevel
from ..utils.tokens import count_tokens
from core.utils.logger import logger
from core.memory.retrieval_service import MemoryRetrievalService
from core.memory.models import MemoryItem, MemoryType
from core.billing.shared.config import get_memory_config, is_memory_enabled


class MemorySource(ContextSource):
    def __init__(
        self,
        priority: int = 90,
        semantic_retrieval: bool = True,
        similarity_threshold: float = 0.5,
        max_memories: int = 20,
    ):
        super().__init__(name="memory", priority=priority)
        self.retrieval_service = MemoryRetrievalService()
        self.semantic_retrieval = semantic_retrieval
        self.similarity_threshold = similarity_threshold
        self.max_memories = max_memories
        self._tier_name: Optional[str] = None
    
    def get_priority(self) -> int:
        return self._priority
    
    def supports_semantic_search(self) -> bool:
        return self.semantic_retrieval
    
    async def fetch(
        self,
        thread_id: str,
        account_id: str,
        query: Optional[str] = None,
        limit_tokens: Optional[int] = None,
    ) -> List[ContextChunk]:
        try:
            tier_name = await self._get_tier_name(account_id)
            if not is_memory_enabled(tier_name):
                logger.debug(f"Memory disabled for tier: {tier_name}")
                return []
            
            memory_config = get_memory_config(tier_name)
            retrieval_limit = min(
                memory_config.get("retrieval_limit", self.max_memories),
                self.max_memories
            )
            
            if retrieval_limit == 0:
                return []
            
            if self.semantic_retrieval and query:
                memories = await self.retrieval_service.retrieve_memories(
                    account_id=account_id,
                    query_text=query,
                    tier_name=tier_name,
                    similarity_threshold=self.similarity_threshold,
                )
            else:
                result = await self.retrieval_service.get_all_memories(
                    account_id=account_id,
                    tier_name=tier_name,
                    limit=retrieval_limit,
                )
                memories = result.get("memories", [])
            
            chunks = []
            tokens_used = 0
            
            for memory in memories:
                chunk = self._memory_to_chunk(memory)
                
                if limit_tokens and tokens_used + chunk.tokens > limit_tokens:
                    break
                
                chunks.append(chunk)
                tokens_used += chunk.tokens
            
            logger.debug(f"MemorySource fetched {len(chunks)} memories for account {account_id}")
            return chunks
            
        except Exception as e:
            logger.error(f"MemorySource failed to fetch for account {account_id}: {e}")
            return []
    
    async def _get_tier_name(self, account_id: str) -> str:
        if self._tier_name:
            return self._tier_name
        
        try:
            from core.billing import subscription_service
            tier_info = await subscription_service.get_user_subscription_tier(account_id)
            self._tier_name = tier_info.get("name", "free")
            return self._tier_name
        except Exception as e:
            logger.warning(f"Failed to get tier for {account_id}: {e}, using 'free'")
            return "free"
    
    def _memory_to_chunk(self, memory: MemoryItem) -> ContextChunk:
        memory_type_label = self._get_memory_type_label(memory.memory_type)
        content = f"[{memory_type_label}] {memory.content}"
        
        tokens = count_tokens(content)
        priority = self._get_memory_priority(memory)
        
        importance = ImportanceLevel.HIGH
        if memory.memory_type == MemoryType.FACT:
            importance = ImportanceLevel.PINNED
        
        return ContextChunk(
            content=content,
            source="memory",
            tokens=tokens,
            priority=priority,
            created_at=memory.created_at,
            message_id=memory.memory_id,
            embedding=memory.embedding,
            metadata={
                "memory_type": memory.memory_type.value,
                "confidence_score": memory.confidence_score,
                "source_thread_id": memory.source_thread_id,
                "role": "system",
            },
            importance=importance,
        )
    
    def _get_memory_type_label(self, memory_type: MemoryType) -> str:
        labels = {
            MemoryType.FACT: "Fact",
            MemoryType.PREFERENCE: "User Preference",
            MemoryType.CONTEXT: "Context",
            MemoryType.CONVERSATION_SUMMARY: "Previous Conversation",
        }
        return labels.get(memory_type, "Memory")
    
    def _get_memory_priority(self, memory: MemoryItem) -> float:
        base_priority = 0.8
        
        type_weights = {
            MemoryType.FACT: 0.9,
            MemoryType.PREFERENCE: 0.85,
            MemoryType.CONTEXT: 0.7,
            MemoryType.CONVERSATION_SUMMARY: 0.6,
        }
        
        priority = type_weights.get(memory.memory_type, base_priority)
        priority *= memory.confidence_score
        
        return min(1.0, priority)
    
    async def fetch_by_type(
        self,
        account_id: str,
        memory_type: MemoryType,
        limit: int = 10,
    ) -> List[ContextChunk]:
        try:
            tier_name = await self._get_tier_name(account_id)
            if not is_memory_enabled(tier_name):
                return []
            
            result = await self.retrieval_service.get_all_memories(
                account_id=account_id,
                tier_name=tier_name,
                limit=limit,
                memory_type=memory_type,
            )
            
            return [self._memory_to_chunk(m) for m in result.get("memories", [])]
            
        except Exception as e:
            logger.error(f"Failed to fetch memories by type: {e}")
            return []
