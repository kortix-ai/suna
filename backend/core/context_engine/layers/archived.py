from typing import List, Optional, TYPE_CHECKING
from .base import ContextLayer
from ..types import ContextChunk, LayerConfig, LayerType

if TYPE_CHECKING:
    from ..processors.compressor import Compressor
    from ..processors.summarizer import HybridSummarizer


class ArchivedLayer(ContextLayer):
    def __init__(self, config: Optional[LayerConfig] = None):
        if config is None:
            config = LayerConfig(tokens=10000, compression_level="extreme")
        super().__init__(LayerType.ARCHIVED, config)
    
    async def process(
        self,
        chunks: List[ContextChunk],
        compressor: Optional["Compressor"] = None,
        summarizer: Optional["HybridSummarizer"] = None,
    ) -> List[ContextChunk]:
        self.clear()
        
        if not chunks:
            return []
        
        if summarizer:
            summary_chunk = await self._create_summary(chunks, summarizer)
            if summary_chunk and summary_chunk.tokens <= self.max_tokens:
                summary_chunk.layer = self.layer_type
                self._chunks = [summary_chunk]
                self._token_count = summary_chunk.tokens
                return self._chunks
        
        pinned = [c for c in chunks if c.is_pinned()]
        for chunk in pinned:
            if self.can_accept(chunk):
                chunk.layer = self.layer_type
                self._chunks.append(chunk)
                self._token_count += chunk.tokens
        
        return self._chunks
    
    async def _create_summary(
        self,
        chunks: List[ContextChunk],
        summarizer: "HybridSummarizer",
    ) -> Optional[ContextChunk]:
        from ..utils.tokens import count_tokens
        
        messages = [chunk.to_message() for chunk in chunks]
        target_tokens = min(self.max_tokens, 2000)
        
        summary = await summarizer.summarize(messages, target_tokens)
        
        if summary:
            return ContextChunk(
                content=f"[Archived Context Summary]\n{summary}",
                source="archive",
                tokens=count_tokens(summary) + 10,
                priority=0.5,
                metadata={
                    "role": "system",
                    "is_archive": True,
                    "original_chunk_count": len(chunks),
                },
            )
        return None
