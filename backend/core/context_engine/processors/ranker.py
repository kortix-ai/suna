import math
from typing import List, Optional
from datetime import datetime, timezone
from ..types import ContextChunk, ImportanceLevel
from .embeddings import cosine_similarity, normalize_similarity
from core.utils.logger import logger


class SemanticRanker:
    def __init__(
        self,
        recency_weight: float = 0.25,
        semantic_weight: float = 0.45,
        priority_weight: float = 0.30,
        stability_hours: float = 24.0,
        decay_exponent: float = 0.5,
    ):
        self.recency_weight = recency_weight
        self.semantic_weight = semantic_weight
        self.priority_weight = priority_weight
        self.stability_hours = stability_hours
        self.decay_exponent = decay_exponent
        self._query_embedding: Optional[List[float]] = None
    
    def set_query_embedding(self, embedding: Optional[List[float]]):
        self._query_embedding = embedding
    
    def rank(
        self,
        chunks: List[ContextChunk],
        top_k: Optional[int] = None,
        min_score: float = 0.0,
    ) -> List[ContextChunk]:
        if not chunks:
            return []
        
        for chunk in chunks:
            chunk.relevance_score = self._score_chunk(chunk)
        
        scored_chunks = [c for c in chunks if c.relevance_score >= min_score]
        scored_chunks.sort(key=lambda c: c.relevance_score, reverse=True)
        
        if top_k:
            scored_chunks = scored_chunks[:top_k]
        
        return scored_chunks
    
    def _score_chunk(self, chunk: ContextChunk) -> float:
        if chunk.is_pinned():
            return 1.0
        
        recency = self._compute_recency_score(chunk)
        semantic = self._compute_semantic_score(chunk)
        priority = chunk.priority
        
        if chunk.is_high_importance():
            priority = min(1.0, priority + 0.3)
        
        total = (
            self.recency_weight * recency +
            self.semantic_weight * semantic +
            self.priority_weight * priority
        )
        
        return min(1.0, max(0.0, total))
    
    def _compute_recency_score(self, chunk: ContextChunk) -> float:
        if not chunk.created_at:
            return 0.5
        
        now = datetime.now(timezone.utc)
        created_at = chunk.created_at
        if created_at.tzinfo is None:
            created_at = created_at.replace(tzinfo=timezone.utc)
        
        age_hours = max(0, (now - created_at).total_seconds() / 3600)
        return math.pow(1 + age_hours / self.stability_hours, -self.decay_exponent)
    
    def _compute_semantic_score(self, chunk: ContextChunk) -> float:
        if not self._query_embedding or not chunk.embedding:
            return 0.5
        
        similarity = cosine_similarity(chunk.embedding, self._query_embedding)
        return normalize_similarity(similarity)
    
    def select_optimal(
        self,
        chunks: List[ContextChunk],
        token_budget: int,
    ) -> List[ContextChunk]:
        if not chunks:
            return []
        
        pinned = [c for c in chunks if c.is_pinned()]
        non_pinned = [c for c in chunks if not c.is_pinned()]
        
        selected = list(pinned)
        used_tokens = sum(c.tokens for c in pinned)
        remaining_budget = token_budget - used_tokens
        
        if remaining_budget <= 0:
            return selected
        
        for chunk in non_pinned:
            if chunk.relevance_score == 0.0:
                chunk.relevance_score = self._score_chunk(chunk)
        
        fitting = [c for c in non_pinned if c.tokens <= remaining_budget]
        
        if not fitting:
            return selected
        
        n = len(fitting)
        
        if remaining_budget > 50000 or n > 300:
            sorted_chunks = sorted(fitting, key=lambda c: c.relevance_score, reverse=True)
            for chunk in sorted_chunks:
                if used_tokens + chunk.tokens <= token_budget:
                    selected.append(chunk)
                    used_tokens += chunk.tokens
            selected.sort(key=lambda c: c.created_at.timestamp() if c.created_at else 0)
            return selected
        
        values = [int(c.relevance_score * 1000) for c in fitting]
        weights = [c.tokens for c in fitting]
        
        dp = [0] * (remaining_budget + 1)
        choice = [[] for _ in range(remaining_budget + 1)]
        
        for i in range(n):
            for w in range(remaining_budget, weights[i] - 1, -1):
                if dp[w - weights[i]] + values[i] > dp[w]:
                    dp[w] = dp[w - weights[i]] + values[i]
                    choice[w] = choice[w - weights[i]] + [i]
        
        selected_indices = choice[remaining_budget]
        selected.extend(fitting[i] for i in selected_indices)
        selected.sort(key=lambda c: c.created_at.timestamp() if c.created_at else 0)
        
        return selected
    
    def rank_by_recency(self, chunks: List[ContextChunk]) -> List[ContextChunk]:
        def get_sort_key(chunk: ContextChunk):
            if chunk.created_at:
                return chunk.created_at
            return datetime.min.replace(tzinfo=timezone.utc)
        
        return sorted(chunks, key=get_sort_key, reverse=True)
    
    def rank_by_priority(self, chunks: List[ContextChunk]) -> List[ContextChunk]:
        return sorted(chunks, key=lambda c: c.priority, reverse=True)
