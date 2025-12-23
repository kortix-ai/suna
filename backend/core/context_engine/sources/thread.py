import json
from typing import List, Dict, Any, Optional
from datetime import datetime

from .base import ContextSource
from ..types import ContextChunk, ImportanceLevel
from ..utils.tokens import count_message_tokens
from core.services.supabase import DBConnection
from core.utils.logger import logger


class ThreadSource(ContextSource):
    def __init__(self, priority: int = 100):
        super().__init__(name="thread", priority=priority)
        self.db = DBConnection()
    
    def get_priority(self) -> int:
        return self._priority
    
    async def fetch(
        self,
        thread_id: str,
        account_id: str,
        query: Optional[str] = None,
        limit_tokens: Optional[int] = None,
    ) -> List[ContextChunk]:
        logger.debug(f"[CONTEXT_ENGINE] ThreadSource fetching from thread={thread_id}, limit={limit_tokens}")
        client = await self.db.client
        
        try:
            all_messages = []
            batch_size = 1000
            offset = 0
            
            while True:
                result = await client.table("messages")\
                    .select("message_id, type, content, metadata, created_at")\
                    .eq("thread_id", thread_id)\
                    .eq("is_llm_message", True)\
                    .order("created_at")\
                    .range(offset, offset + batch_size - 1)\
                    .execute()
                
                if not result.data:
                    break
                
                all_messages.extend(result.data)
                if len(result.data) < batch_size:
                    break
                offset += batch_size
            
            if not all_messages:
                logger.debug(f"[CONTEXT_ENGINE] ThreadSource: No messages found for thread {thread_id}")
                return []
            
            chunks = []
            for item in all_messages:
                chunk = self._parse_message_to_chunk(item)
                if chunk:
                    chunks.append(chunk)
            
            total_tokens = sum(c.tokens for c in chunks)
            logger.info(f"[CONTEXT_ENGINE] ThreadSource fetched {len(chunks)} chunks ({total_tokens} tokens) from {len(all_messages)} messages")
            return chunks
            
        except Exception as e:
            logger.error(f"ThreadSource failed to fetch from thread {thread_id}: {e}")
            return []
    
    def _parse_message_to_chunk(self, item: Dict[str, Any]) -> Optional[ContextChunk]:
        content = item["content"]
        metadata = item.get("metadata", {}) or {}
        message_id = item["message_id"]
        created_at = item.get("created_at")
        
        is_compressed = metadata.get("compressed", False)
        if is_compressed:
            compressed_content = metadata.get("compressed_content")
            if compressed_content:
                content = compressed_content
        
        if isinstance(content, str):
            try:
                parsed = json.loads(content)
            except json.JSONDecodeError:
                if is_compressed:
                    parsed = {"role": "user", "content": content}
                else:
                    logger.warning(f"Failed to parse message content: {content[:100]}")
                    return None
        elif isinstance(content, dict):
            parsed = content
        else:
            parsed = {"role": "user", "content": str(content)}
        
        if parsed.get("role") == "user":
            msg_content = parsed.get("content", "")
            if isinstance(msg_content, str) and not msg_content.strip():
                return None
        
        role = parsed.get("role", "user")
        text_content = parsed.get("content", "")
        if isinstance(text_content, list):
            text_parts = []
            for block in text_content:
                if isinstance(block, dict) and block.get("type") == "text":
                    text_parts.append(block.get("text", ""))
            text_content = "\n".join(text_parts)
        
        tokens = count_message_tokens([{"role": role, "content": text_content}])
        
        importance = ImportanceLevel.NORMAL
        if metadata.get("pinned"):
            importance = ImportanceLevel.PINNED
        elif metadata.get("important"):
            importance = ImportanceLevel.HIGH
        
        chunk_metadata = {
            "role": role,
            "original_type": item.get("type"),
        }
        if "tool_call_id" in parsed:
            chunk_metadata["tool_call_id"] = parsed["tool_call_id"]
        if "tool_calls" in parsed:
            chunk_metadata["tool_calls"] = parsed["tool_calls"]
        if "name" in parsed:
            chunk_metadata["name"] = parsed["name"]
        
        if created_at and isinstance(created_at, str):
            try:
                created_at = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
            except (ValueError, TypeError):
                created_at = None
        
        return ContextChunk(
            content=text_content if isinstance(text_content, str) else str(text_content),
            source="thread",
            tokens=tokens,
            priority=self._get_message_priority(role, parsed),
            created_at=created_at,
            message_id=message_id,
            metadata=chunk_metadata,
            importance=importance,
        )
    
    def _get_message_priority(self, role: str, parsed: Dict[str, Any]) -> float:
        if role == "system":
            return 1.0
        elif role == "user":
            return 0.8
        elif role == "assistant":
            if parsed.get("tool_calls"):
                return 0.7
            return 0.6
        elif role == "tool":
            return 0.5
        return 0.5
