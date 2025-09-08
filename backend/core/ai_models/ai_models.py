from dataclasses import dataclass, field
from typing import List, Optional, Dict, Any
from enum import Enum


class ModelProvider(Enum):
    OPENAI = "openai"
    ANTHROPIC = "anthropic"
    OPENROUTER = "openrouter"
    GOOGLE = "google"
    XAI = "xai"
    MOONSHOTAI = "moonshotai"

class ModelCapability(Enum):
    CHAT = "chat"
    FUNCTION_CALLING = "function_calling"
    VISION = "vision"
    CODE_INTERPRETER = "code_interpreter"
    WEB_SEARCH = "web_search"
    THINKING = "thinking"
    STRUCTURED_OUTPUT = "structured_output"


@dataclass
class ModelPricing:
    input_cost_per_million_tokens: float
    output_cost_per_million_tokens: float
    
    @property
    def input_cost_per_token(self) -> float:
        return self.input_cost_per_million_tokens / 1_000_000
    
    @property
    def output_cost_per_token(self) -> float:
        return self.output_cost_per_million_tokens / 1_000_000


@dataclass
class Model:
    id: str
    name: str
    provider: ModelProvider
    aliases: List[str] = field(default_factory=list)
    context_window: int = 128_000
    max_output_tokens: Optional[int] = None
    capabilities: List[ModelCapability] = field(default_factory=list)
    pricing: Optional[ModelPricing] = None
    enabled: bool = True
    beta: bool = False
    tier_availability: List[str] = field(default_factory=lambda: ["paid"])
    metadata: Dict[str, Any] = field(default_factory=dict)
    priority: int = 0
    recommended: bool = False
    
    def __post_init__(self):
        if self.max_output_tokens is None:
            self.max_output_tokens = min(self.context_window // 4, 32_000)
        
        if ModelCapability.CHAT not in self.capabilities:
            self.capabilities.insert(0, ModelCapability.CHAT)
    
    @property
    def full_id(self) -> str:
        if "/" in self.id:
            return self.id
        return f"{self.provider.value}/{self.id}"
    
    @property
    def supports_thinking(self) -> bool:
        return ModelCapability.THINKING in self.capabilities
    
    @property
    def supports_functions(self) -> bool:
        return ModelCapability.FUNCTION_CALLING in self.capabilities
    
    @property
    def supports_vision(self) -> bool:
        return ModelCapability.VISION in self.capabilities
    
    @property
    def is_free_tier(self) -> bool:
        return "free" in self.tier_availability
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "provider": self.provider.value,
            "aliases": self.aliases,
            "context_window": self.context_window,
            "max_output_tokens": self.max_output_tokens,
            "capabilities": [cap.value for cap in self.capabilities],
            "pricing": {
                "input_cost_per_million_tokens": self.pricing.input_cost_per_million_tokens,
                "output_cost_per_million_tokens": self.pricing.output_cost_per_million_tokens,
            } if self.pricing else None,
            "enabled": self.enabled,
            "beta": self.beta,
            "tier_availability": self.tier_availability,
            "metadata": self.metadata,
            "priority": self.priority,
            "recommended": self.recommended,
        } 