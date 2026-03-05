from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Dict, Any, List, Optional
from enum import Enum

class ProviderCapability(Enum):
    PROMPT_CACHING = "prompt_caching"
    REASONING_MODE = "reasoning_mode"
    VISION = "vision"
    FUNCTION_CALLING = "function_calling"
    STREAMING = "streaming"
    EXTENDED_THINKING = "extended_thinking"

@dataclass
class CacheConfig:
    enabled: bool = False
    max_blocks: int = 4
    min_cacheable_tokens: int = 1024
    cache_control_format: str = "anthropic"
    
@dataclass
class ReasoningConfig:
    enabled: bool = False
    param_name: str = "reasoning"
    param_value: Dict[str, Any] = field(default_factory=lambda: {"enabled": True})
    split_reasoning: bool = False
    split_param_name: str = "reasoning_split"


class ProviderConfig(ABC):
    @property
    @abstractmethod
    def name(self) -> str:
        pass
    
    @property
    @abstractmethod
    def capabilities(self) -> List[ProviderCapability]:
        pass
    
    @abstractmethod
    def get_extra_params(self, model_id: str, **kwargs) -> Dict[str, Any]:
        pass
    
    @abstractmethod
    def get_headers(self, model_id: str) -> Dict[str, str]:
        pass
    
    @abstractmethod
    def get_extra_headers(self, model_id: str) -> Dict[str, str]:
        pass
    
    def supports(self, capability: ProviderCapability) -> bool:
        return capability in self.capabilities
    
    def get_cache_config(self) -> Optional[CacheConfig]:
        if not self.supports(ProviderCapability.PROMPT_CACHING):
            return None
        return CacheConfig()
    
    def get_reasoning_config(self) -> Optional[ReasoningConfig]:
        if not self.supports(ProviderCapability.REASONING_MODE):
            return None
        return ReasoningConfig()
    
    def prepare_messages(self, messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        return messages
    
    def process_response_chunk(self, chunk: Any) -> Dict[str, Any]:
        return {"chunk": chunk, "reasoning_content": None}
