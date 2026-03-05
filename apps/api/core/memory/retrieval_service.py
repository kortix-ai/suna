from typing import List, Dict, Any, Optional
from core.utils.logger import logger
from core.utils.cache import Cache
from core.services.convex_client import get_convex_client
from core.billing.shared.config import get_memory_config, is_memory_enabled
from core.utils.config import config
from .embedding_service import EmbeddingService
from .models import MemoryItem, MemoryType

class MemoryRetrievalService:
    def __init__(self):
        self.embedding_service = EmbeddingService()
        self.cache_ttl = 60
    
    async def retrieve_memories(
        self,
        account_id: str,
        query_text: str,
        tier_name: str,
        similarity_threshold: float = 0.1
    ) -> List[MemoryItem]:
        try:
            # Check global memory flag first
            if not config.ENABLE_MEMORY:
                logger.debug("Memory retrieval skipped: ENABLE_MEMORY is False")
                return []
            
            if not is_memory_enabled(tier_name):
                logger.debug(f"Memory disabled for tier: {tier_name}")
                return []
            
            memory_config = get_memory_config(tier_name)
            retrieval_limit = memory_config.get('retrieval_limit', 0)
            
            if retrieval_limit == 0:
                logger.debug(f"Memory retrieval limit is 0 for tier: {tier_name}")
                return []
            
            cache_key = f"memories:retrieved:{account_id}:{hash(query_text)}"
            cached = await Cache.get(cache_key)
            if cached:
                logger.debug(f"Retrieved memories from cache for {account_id}")
                return [self._dict_to_memory_item(m) for m in cached]
            
            # Use Convex client
            convex = get_convex_client()
            
            # Count memories first
            existing_memories = await convex.list_memories(
                memory_space_id=account_id,
                account_id=account_id,
                limit=1
            )
            
            # Check if there are any memories (empty list or None means no memories)
            if not existing_memories:
                logger.debug(f"No memories stored for account {account_id}")
                return []
            
            # Get query embedding
            query_embedding = await self.embedding_service.embed_text(query_text)
            
            # Search memories using Convex semantic search
            result = await convex.search_memories(
                memory_space_id=account_id,
                query=query_text,
                embedding=query_embedding,
                limit=retrieval_limit,
                account_id=account_id
            )
            
            logger.debug(f"Memory search returned {len(result) if result else 0} results")
            
            memories = []
            for row in result or []:
                memory = MemoryItem(
                    memory_id=row.get('memoryId') or row.get('memory_id'),
                    account_id=account_id,
                    content=row['content'],
                    memory_type=MemoryType(row.get('metadata', {}).get('memory_type', 'fact')),
                    confidence_score=row.get('metadata', {}).get('confidence_score', 0.8),
                    metadata=row.get('metadata', {}),
                    created_at=row.get('createdAt') or row.get('created_at')
                )
                memories.append(memory)
            
            await Cache.set(cache_key, [self._memory_item_to_dict(m) for m in memories], ttl=self.cache_ttl)
            
            logger.info(f"Retrieved {len(memories)} memories for account {account_id}")
            return memories
        
        except Exception as e:
            logger.error(f"Memory retrieval error for {account_id}: {str(e)}")
            import traceback
            logger.error(traceback.format_exc())
            return []
    
    async def get_all_memories(
        self,
        account_id: str,
        tier_name: str,
        limit: int = 100,
        offset: int = 0,
        memory_type: Optional[MemoryType] = None
    ) -> Dict[str, Any]:
        try:
            # Check global memory flag first
            if not config.ENABLE_MEMORY:
                logger.debug("get_all_memories skipped: ENABLE_MEMORY is False")
                return {"memories": [], "total": 0}
            
            if not is_memory_enabled(tier_name):
                return {"memories": [], "total": 0}
            
            # Use Convex client
            convex = get_convex_client()
            
            # TODO: Convex list_memories doesn't support offset/pagination or type filtering
            # For now, fetch all and filter in memory
            all_memories = await convex.list_memories(
                memory_space_id=account_id,
                account_id=account_id,
                limit=1000
            )
            
            # Filter by type if specified
            if memory_type:
                all_memories = [
                    m for m in (all_memories or [])
                    if m.get('metadata', {}).get('memory_type') == memory_type.value
                ]
            
            # Apply pagination
            total = len(all_memories) if all_memories else 0
            paginated = (all_memories or [])[offset:offset + limit]
            
            memories = []
            for row in paginated:
                memory = MemoryItem(
                    memory_id=row.get('memoryId') or row.get('memory_id'),
                    account_id=account_id,
                    content=row['content'],
                    memory_type=MemoryType(row.get('metadata', {}).get('memory_type', 'fact')),
                    confidence_score=row.get('metadata', {}).get('confidence_score', 0.8),
                    source_thread_id=row.get('metadata', {}).get('source_thread_id'),
                    metadata=row.get('metadata', {}),
                    created_at=row.get('createdAt') or row.get('created_at'),
                    updated_at=row.get('updatedAt') or row.get('updated_at')
                )
                memories.append(memory)
            
            return {
                "memories": memories,
                "total": total
            }
        
        except Exception as e:
            logger.error(f"Error fetching all memories for {account_id}: {str(e)}")
            return {"memories": [], "total": 0}
    
    async def get_memory_stats(self, account_id: str) -> Dict[str, Any]:
        try:
            # Check global memory flag first
            if not config.ENABLE_MEMORY:
                logger.debug("get_memory_stats skipped: ENABLE_MEMORY is False")
                return {
                    "total_memories": 0,
                    "memories_by_type": {},
                    "oldest_memory": None,
                    "newest_memory": None
                }
            
            # Use Convex client to get memories for stats
            convex = get_convex_client()
            
            # TODO: Need to add get_memory_stats endpoint to Convex API
            # For now, calculate stats from list_memories
            memories = await convex.list_memories(
                memory_space_id=account_id,
                account_id=account_id,
                limit=1000
            )
            
            if not memories:
                return {
                    "total_memories": 0,
                    "memories_by_type": {},
                    "oldest_memory": None,
                    "newest_memory": None
                }
            
            total = len(memories)
            memories_by_type: Dict[str, int] = {}
            
            for mem in memories:
                metadata = mem.get('metadata', {})
                mem_type = metadata.get('memory_type', 'fact')
                memories_by_type[mem_type] = memories_by_type.get(mem_type, 0) + 1
            
            # Get oldest and newest (assuming sorted by creation)
            oldest = memories[-1].get('createdAt') if memories else None
            newest = memories[0].get('createdAt') if memories else None
            
            return {
                "total_memories": total,
                "memories_by_type": memories_by_type,
                "oldest_memory": oldest,
                "newest_memory": newest
            }
        
        except Exception as e:
            logger.error(f"Error getting memory stats for {account_id}: {str(e)}")
            return {
                "total_memories": 0,
                "memories_by_type": {},
                "oldest_memory": None,
                "newest_memory": None
            }
    
    async def delete_memory(self, account_id: str, memory_id: str) -> bool:
        try:
            if not config.ENABLE_MEMORY:
                logger.debug("delete_memory skipped: ENABLE_MEMORY is False")
                return False
            
            # Use Convex client
            convex = get_convex_client()
            
            # TODO: Need to add delete_memory endpoint to Convex API
            # For now, use the repo module which still has SQL access
            from core.memory import repo as memory_repo
            success = await memory_repo.delete_memory(account_id, memory_id)
            
            if success:
                await self._invalidate_cache(account_id)
                logger.info(f"Deleted memory {memory_id} for account {account_id}")
                return True
            
            return False
        
        except Exception as e:
            logger.error(f"Error deleting memory {memory_id}: {str(e)}")
            return False
    
    async def delete_all_memories(self, account_id: str) -> int:
        try:
            if not config.ENABLE_MEMORY:
                logger.debug("delete_all_memories skipped: ENABLE_MEMORY is False")
                return 0
            
            # Use Convex client
            convex = get_convex_client()
            
            # TODO: Need to add delete_all_memories endpoint to Convex API
            # For now, use the repo module which still has SQL access
            from core.memory import repo as memory_repo
            deleted_count = await memory_repo.delete_all_memories(account_id)
            
            await self._invalidate_cache(account_id)
            
            logger.info(f"Deleted {deleted_count} memories for account {account_id}")
            return deleted_count
        
        except Exception as e:
            logger.error(f"Error deleting all memories for {account_id}: {str(e)}")
            return 0
    
    def format_memories_for_prompt(self, memories: List[MemoryItem]) -> str:
        if not memories:
            return ""
        
        sections = {
            MemoryType.FACT: [],
            MemoryType.PREFERENCE: [],
            MemoryType.CONTEXT: [],
            MemoryType.CONVERSATION_SUMMARY: []
        }
        
        for memory in memories:
            sections[memory.memory_type].append(memory.content)
        
        formatted_parts = []
        
        if sections[MemoryType.FACT]:
            formatted_parts.append("Personal Facts:\n- " + "\n- ".join(sections[MemoryType.FACT]))
        
        if sections[MemoryType.PREFERENCE]:
            formatted_parts.append("Preferences:\n- " + "\n- ".join(sections[MemoryType.PREFERENCE]))
        
        if sections[MemoryType.CONTEXT]:
            formatted_parts.append("Context:\n- " + "\n- ".join(sections[MemoryType.CONTEXT]))
        
        if sections[MemoryType.CONVERSATION_SUMMARY]:
            formatted_parts.append("Past Conversations:\n- " + "\n- ".join(sections[MemoryType.CONVERSATION_SUMMARY]))
        
        if not formatted_parts:
            return ""
        
        return "# What You Remember About This User\n\n" + "\n\n".join(formatted_parts)
    
    async def _invalidate_cache(self, account_id: str):
        try:
            pattern = f"memories:retrieved:{account_id}:*"
            await Cache.delete_pattern(pattern)
        except Exception as e:
            logger.warning(f"Failed to invalidate cache for {account_id}: {str(e)}")
    
    def _memory_item_to_dict(self, memory: MemoryItem) -> Dict[str, Any]:
        return {
            "memory_id": memory.memory_id,
            "account_id": memory.account_id,
            "content": memory.content,
            "memory_type": memory.memory_type.value,
            "confidence_score": memory.confidence_score,
            "metadata": memory.metadata,
            "created_at": memory.created_at.isoformat() if memory.created_at else None
        }
    
    def _dict_to_memory_item(self, data: Dict[str, Any]) -> MemoryItem:
        return MemoryItem(
            memory_id=data['memory_id'],
            account_id=data['account_id'],
            content=data['content'],
            memory_type=MemoryType(data['memory_type']),
            confidence_score=data['confidence_score'],
            metadata=data.get('metadata', {})
        )

memory_retrieval_service = MemoryRetrievalService()
