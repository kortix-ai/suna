from typing import List, Optional, TYPE_CHECKING
from .base import ContextLayer
from ..types import ContextChunk, LayerConfig, LayerType

if TYPE_CHECKING:
    from ..processors.compressor import Compressor
    from ..processors.summarizer import HybridSummarizer


class RecentLayer(ContextLayer):
    def __init__(self, config: Optional[LayerConfig] = None):
        if config is None:
            config = LayerConfig(messages=40, tokens=50000, compression_level="light")
        super().__init__(LayerType.RECENT, config)
    
    async def process(
        self,
        chunks: List[ContextChunk],
        compressor: Optional["Compressor"] = None,
        summarizer: Optional["HybridSummarizer"] = None,
    ) -> List[ContextChunk]:
        self.clear()
        
        for chunk in chunks:
            if not self.can_accept(chunk):
                if compressor:
                    compressed = await compressor.compress_light(chunk)
                    if self.can_accept(compressed):
                        compressed.layer = self.layer_type
                        self._chunks.append(compressed)
                        self._token_count += compressed.tokens
                continue
            
            role = chunk.metadata.get("role", "")
            
            if role == "user":
                chunk.layer = self.layer_type
                self._chunks.append(chunk)
                self._token_count += chunk.tokens
            elif role == "tool" and compressor and chunk.tokens > 1000:
                compressed = await compressor.compress_light(chunk)
                compressed.layer = self.layer_type
                self._chunks.append(compressed)
                self._token_count += compressed.tokens
            elif role == "assistant" and compressor and chunk.tokens > 1500:
                compressed = await compressor.compress_light(chunk)
                compressed.layer = self.layer_type
                self._chunks.append(compressed)
                self._token_count += compressed.tokens
            else:
                chunk.layer = self.layer_type
                self._chunks.append(chunk)
                self._token_count += chunk.tokens
        
        return self._chunks
