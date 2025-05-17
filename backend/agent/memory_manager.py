import os
import logging
from typing import List, Dict, Optional, Literal, Any
from datetime import datetime, timezone
import uuid
import json
import re
from pydantic import BaseModel, Field
from services.supabase import DBConnection
from utils.logger import logger
from services.embedding import get_embedding

DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small"

class MemoryBlock(BaseModel):
    """Represents a single memory block in the system."""
    memory_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    thread_id: str
    memory_type: Literal["episodic", "semantic", "procedural"]
    content: str
    embedding: Optional[List[float]] = None
    metadata: Dict[str, Any] = Field(default_factory=dict)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    last_accessed: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    importance_score: float = Field(default=0.0, ge=0.0, le=1.0)
    tags: List[str] = Field(default_factory=list)

class MemoryManager:
    """Manages long-term memory storage and retrieval for the agent."""

    def __init__(self, db: DBConnection):
        self.db = db

    @classmethod
    async def create(cls, db: DBConnection) -> 'MemoryManager':
        return cls(db)

    async def save_memory(
        self,
        thread_id: str,
        content: str,
        memory_type: Literal["episodic", "semantic", "procedural"],
        metadata: Optional[Dict[str, Any]] = None,
        tags: Optional[List[str]] = None,
        importance_score: Optional[float] = None
    ) -> MemoryBlock:
        """
        Save a new memory block, generating an embedding for semantic search.
        """
        client = await self.db.client
        try:
            embedding = await self._generate_embedding(content)
        except Exception as e:
            logger.error(f"Failed to generate embedding: {e}")
            embedding = None

        memory = MemoryBlock(
            thread_id=thread_id,
            memory_type=memory_type,
            content=content,
            embedding=embedding,
            metadata=metadata or {},
            tags=tags or [],
            importance_score=importance_score or 0.5
        )

        data = memory.model_dump(mode="json")
        await client.table('memories').insert(data).execute()
        return memory

    async def retrieve_memories(
        self,
        thread_id: str,
        query: Optional[str] = None,
        memory_types: Optional[List[Literal["episodic", "semantic", "procedural"]]] = None,
        tags: Optional[List[str]] = None,
        limit: int = 5,
        min_importance: float = 0.0
    ) -> List[Dict[str, Any]]:
        """
        Retrieve relevant memories via semantic RPC when available, otherwise fallback to text/recency filter.
        Returns a list of JSON-serializable memory dicts.
        """
        client = await self.db.client
        data_rows: List[Dict[str, Any]] = []

        # Semantic search via RPC (match_count, match_threshold, query_embedding)
        if query:
            try:
                q_emb = await self._generate_embedding(query)
                rpc_params = {
                    'match_count': limit,
                    'match_threshold': 0.7,
                    'query_embedding': q_emb
                }
                result = await client.rpc('match_memories', rpc_params).execute()
                data_rows = result.data or []
                logger.debug(f"RPC match_memories returned {len(data_rows)} rows")
                data_rows = [row for row in data_rows if row.get('thread_id') == thread_id]
            except Exception as e:
                logger.error(f"Semantic search failed: {e}")
                data_rows = []

        # Fallback select when no query or RPC yielded none
        if not query or not data_rows:
            qb = client.table('memories').select('*').eq('thread_id', thread_id)
            if memory_types:
                qb = qb.in_('memory_type', memory_types)
            if tags:
                qb = qb.contains('tags', tags)
            if min_importance > 0:
                qb = qb.gte('importance_score', min_importance)
            if query:
                qb = qb.ilike('content', f"%{query}%")
            else:
                qb = qb.order('created_at', desc=True)

            resp = await qb.limit(limit).execute()
            data_rows = resp.data or []
            logger.debug(f"Fallback select returned {len(data_rows)} rows")

        # Update last_accessed timestamp for returned memories
        if data_rows:
            ids = [row['memory_id'] for row in data_rows]
            await client.table('memories') \
                .update({'last_accessed': datetime.now(timezone.utc).isoformat()}) \
                .in_('memory_id', ids).execute()

        # Serialize rows to JSON-ready dicts
        serialized: List[Dict[str, Any]] = []
        for row in data_rows:
            # Create a copy of the row without the embedding field
            row_copy = {k: v for k, v in row.items() if k != 'embedding'}
            # Convert datetime fields
            for dt in ['created_at', 'last_accessed']:
                if isinstance(row_copy.get(dt), datetime):
                    row_copy[dt] = row_copy[dt].isoformat()
            serialized.append(row_copy)
        return serialized

    async def update_memory(
        self,
        memory_id: str,
        content: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
        tags: Optional[List[str]] = None,
        importance_score: Optional[float] = None
    ) -> Optional[MemoryBlock]:
        """Update fields of an existing memory block."""
        client = await self.db.client
        res = await client.table('memories').select('*').eq('memory_id', memory_id).execute()
        if not res.data:
            return None

        data = res.data[0]
        if data.get('embedding') is not None:
            data['embedding'] = self._parse_vector_to_list(data['embedding'])

        memory = MemoryBlock(**data)
        updates: Dict[str, Any] = {}
        if content is not None:
            updates['content'] = content
            try:
                updates['embedding'] = await self._generate_embedding(content)
            except Exception as e:
                logger.error(f"Re-embedding failed: {e}")
        if metadata is not None:
            updates['metadata'] = metadata
        if tags is not None:
            updates['tags'] = tags
        if importance_score is not None:
            updates['importance_score'] = importance_score

        if updates:
            await client.table('memories').update(updates).eq('memory_id', memory_id).execute()
            for k, v in updates.items():
                setattr(memory, k, v)
        return memory

    async def delete_memory(self, memory_id: str) -> bool:
        """Delete a memory block by its ID."""
        client = await self.db.client
        res = await client.table('memories').delete().eq('memory_id', memory_id).execute()
        return bool(res.data)

    async def _generate_embedding(self, text: str) -> List[float]:
        """Generate embedding for text using shared service."""
        resp = await get_embedding(text=text, model=DEFAULT_EMBEDDING_MODEL)
        emb = resp.data[0].embedding if resp and resp.data else None
        if emb is None:
            raise ValueError("Invalid embedding response")
        if isinstance(emb, str):
            return self._parse_vector_to_list(emb)
        if not isinstance(emb, list):
            raise ValueError(f"Unexpected embedding type: {type(emb)}")
        return emb

    def _parse_vector_to_list(self, value: Any) -> List[float]:
        """Convert various vector formats into a list of floats."""
        if isinstance(value, list):
            return value
        if isinstance(value, str):
            try:
                return json.loads(value)
            except Exception:
                cleaned = re.sub(r'::.*$', '', value)
                cleaned = cleaned.strip('[]()')
                return [float(x) for x in cleaned.split(',') if x.strip()]
        logger.error(f"Cannot parse vector: {value}")
        return []
