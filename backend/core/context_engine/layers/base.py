from abc import ABC, abstractmethod
from typing import List, Dict, Any, Optional, TYPE_CHECKING
from ..types import ContextChunk, LayerConfig, LayerType, LayerStats

if TYPE_CHECKING:
    from ..processors.compressor import Compressor
    from ..processors.summarizer import HybridSummarizer


class ContextLayer(ABC):
    def __init__(
        self,
        layer_type: LayerType,
        config: LayerConfig,
    ):
        self.layer_type = layer_type
        self.config = config
        self._chunks: List[ContextChunk] = []
        self._token_count: int = 0
    
    @property
    def max_messages(self) -> Optional[int]:
        return self.config.messages
    
    @property
    def max_tokens(self) -> int:
        return self.config.tokens
    
    @property
    def compression_level(self) -> str:
        return self.config.compression_level
    
    @property
    def chunks(self) -> List[ContextChunk]:
        return self._chunks
    
    @property
    def token_count(self) -> int:
        return self._token_count
    
    @property
    def message_count(self) -> int:
        return len(self._chunks)
    
    @abstractmethod
    async def process(
        self,
        chunks: List[ContextChunk],
        compressor: Optional["Compressor"] = None,
        summarizer: Optional["HybridSummarizer"] = None,
    ) -> List[ContextChunk]:
        pass
    
    def can_accept(self, chunk: ContextChunk) -> bool:
        if self.max_messages and len(self._chunks) >= self.max_messages:
            return False
        if self._token_count + chunk.tokens > self.max_tokens:
            return False
        return True
    
    def add_chunk(self, chunk: ContextChunk) -> bool:
        if not self.can_accept(chunk):
            return False
        
        chunk.layer = self.layer_type
        self._chunks.append(chunk)
        self._token_count += chunk.tokens
        return True
    
    def clear(self):
        self._chunks = []
        self._token_count = 0
    
    def get_stats(self) -> LayerStats:
        return LayerStats(
            layer=self.layer_type,
            messages=len(self._chunks),
            tokens=self._token_count,
            chunks=len(self._chunks),
            compression_applied=self.compression_level != "none",
        )
    
    def get_messages(self) -> List[Dict[str, Any]]:
        return [chunk.to_message() for chunk in self._chunks]
    
    def remaining_tokens(self) -> int:
        return max(0, self.max_tokens - self._token_count)
    
    def remaining_messages(self) -> Optional[int]:
        if self.max_messages is None:
            return None
        return max(0, self.max_messages - len(self._chunks))
    
    def is_full(self) -> bool:
        if self.max_messages and len(self._chunks) >= self.max_messages:
            return True
        if self._token_count >= self.max_tokens:
            return True
        return False
