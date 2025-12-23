from typing import List, Optional, TYPE_CHECKING
from .base import ContextLayer
from ..types import ContextChunk, LayerConfig, LayerType

if TYPE_CHECKING:
    from ..processors.compressor import Compressor
    from ..processors.summarizer import HybridSummarizer


class HistoricalLayer(ContextLayer):
    def __init__(self, config: Optional[LayerConfig] = None):
        if config is None:
            config = LayerConfig(messages=150, tokens=30000, compression_level="heavy")
        super().__init__(LayerType.HISTORICAL, config)
    
    async def process(
        self,
        chunks: List[ContextChunk],
        compressor: Optional["Compressor"] = None,
        summarizer: Optional["HybridSummarizer"] = None,
    ) -> List[ContextChunk]:
        self.clear()
        
        for chunk in chunks:
            role = chunk.metadata.get("role", "")
            
            if role == "user":
                if self.can_accept(chunk):
                    chunk.layer = self.layer_type
                    self._chunks.append(chunk)
                    self._token_count += chunk.tokens
            elif compressor:
                compressed = await compressor.compress_heavy(chunk)
                if self.can_accept(compressed):
                    compressed.layer = self.layer_type
                    self._chunks.append(compressed)
                    self._token_count += compressed.tokens
            elif self.can_accept(chunk):
                chunk.layer = self.layer_type
                self._chunks.append(chunk)
                self._token_count += chunk.tokens
        
        return self._chunks
    
    async def summarize_group(
        self,
        chunks: List[ContextChunk],
        summarizer: "HybridSummarizer",
        target_tokens: int = 500,
    ) -> Optional[ContextChunk]:
        if not chunks or not summarizer:
            return None
        
        from ..utils.tokens import count_tokens
        
        messages = [chunk.to_message() for chunk in chunks]
        summary = await summarizer.summarize(messages, target_tokens)
        
        if summary:
            return ContextChunk(
                content=summary,
                source="summary",
                tokens=count_tokens(summary),
                priority=0.7,
                layer=self.layer_type,
                metadata={
                    "role": "system",
                    "is_summary": True,
                    "original_chunk_count": len(chunks),
                },
            )
        return None
