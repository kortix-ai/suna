from abc import ABC, abstractmethod
from typing import List, Dict, Any, Optional
from ..types import ContextChunk


class ContextSource(ABC):
    def __init__(self, name: str, priority: int = 50):
        self._name = name
        self._priority = priority
    
    @property
    def name(self) -> str:
        return self._name
    
    @abstractmethod
    async def fetch(
        self,
        thread_id: str,
        account_id: str,
        query: Optional[str] = None,
        limit_tokens: Optional[int] = None,
    ) -> List[ContextChunk]:
        pass
    
    @abstractmethod
    def get_priority(self) -> int:
        pass
    
    async def initialize(self) -> None:
        pass
    
    async def cleanup(self) -> None:
        pass
    
    def supports_semantic_search(self) -> bool:
        return False
    
    def supports_entity_enrichment(self) -> bool:
        return False
    
    def get_supported_entities(self) -> List[str]:
        return []
