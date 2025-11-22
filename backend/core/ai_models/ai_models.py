from dataclasses import dataclass, field
from typing import List, Optional, Dict, Any, Union
from enum import Enum


class ModelProvider(Enum):
    OPENAI = "openai"
    ANTHROPIC = "anthropic"
    BEDROCK = "bedrock"
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
    cached_read_cost_per_million_tokens: Optional[float] = None  # Cache hits & refreshes
    cache_write_5m_cost_per_million_tokens: Optional[float] = None  # 5-minute cache writes
    cache_write_1h_cost_per_million_tokens: Optional[float] = None  # 1-hour cache writes
    
    @property
    def input_cost_per_token(self) -> float:
        return self.input_cost_per_million_tokens / 1_000_000
    
    @property
    def output_cost_per_token(self) -> float:
        return self.output_cost_per_million_tokens / 1_000_000
    
    @property
    def cached_read_cost_per_token(self) -> float:
        if self.cached_read_cost_per_million_tokens is None:
            return self.input_cost_per_token  # Fallback to regular input price if not specified
        return self.cached_read_cost_per_million_tokens / 1_000_000
    
    @property
    def cache_write_5m_cost_per_token(self) -> float:
        if self.cache_write_5m_cost_per_million_tokens is None:
            return self.input_cost_per_token  # Fallback to regular input price if not specified
        return self.cache_write_5m_cost_per_million_tokens / 1_000_000
    
    @property
    def cache_write_1h_cost_per_token(self) -> float:
        if self.cache_write_1h_cost_per_million_tokens is None:
            return self.input_cost_per_token  # Fallback to regular input price if not specified
        return self.cache_write_1h_cost_per_million_tokens / 1_000_000


@dataclass
class ModelConfig:
    """Essential model configuration - provider settings and API configuration only."""
    
    # === Provider & API Configuration ===
    api_base: Optional[str] = None
    api_version: Optional[str] = None
    base_url: Optional[str] = None  # Alternative to api_base
    deployment_id: Optional[str] = None  # Azure
    timeout: Optional[Union[float, int]] = None
    num_retries: Optional[int] = None
    
    # === Headers (Provider-Specific) ===
    headers: Optional[Dict[str, str]] = None
    extra_headers: Optional[Dict[str, str]] = None
    
    # === Bedrock-Specific Configuration ===
    performanceConfig: Optional[Dict[str, str]] = None  # e.g., {"latency": "optimized"}
    


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
    
    # NEW: Centralized model configuration
    config: Optional[ModelConfig] = None
    
    def __post_init__(self):        
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
    
    def get_litellm_params(self, **override_params) -> Dict[str, Any]:
        """Get complete LiteLLM parameters for this model, including all configuration."""
        # Start with intelligent defaults
        params = {
            "model": self.id,
            "num_retries": 5,
        }
        
    
        # Apply model-specific configuration if available
        if self.config:
            # Provider & API configuration parameters
            api_params = [
                'api_base', 'api_version', 'base_url', 'deployment_id', 
                'timeout', 'num_retries'
            ]
            
            # Apply configured parameters
            for param_name in api_params:
                param_value = getattr(self.config, param_name, None)
                if param_value is not None:
                    params[param_name] = param_value
            
            if self.config.headers:
                params["headers"] = self.config.headers.copy()
            if self.config.extra_headers:
                params["extra_headers"] = self.config.extra_headers.copy()
            if self.config.performanceConfig:
                params["performanceConfig"] = self.config.performanceConfig.copy()
        
        
        # Apply any runtime overrides
        for key, value in override_params.items():
            if value is not None:
                # Handle headers and extra_headers merging separately
                if key == "headers" and "headers" in params:
                    if isinstance(params["headers"], dict) and isinstance(value, dict):
                        params["headers"].update(value)
                    else:
                        params[key] = value
                elif key == "extra_headers" and "extra_headers" in params:
                    if isinstance(params["extra_headers"], dict) and isinstance(value, dict):
                        params["extra_headers"].update(value)
                    else:
                        params[key] = value
                else:
                    params[key] = value
        
        return params
    
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
                "cached_read_cost_per_million_tokens": self.pricing.cached_read_cost_per_million_tokens,
                "cache_write_5m_cost_per_million_tokens": self.pricing.cache_write_5m_cost_per_million_tokens,
                "cache_write_1h_cost_per_million_tokens": self.pricing.cache_write_1h_cost_per_million_tokens,
            } if self.pricing else None,
            "enabled": self.enabled,
            "beta": self.beta,
            "tier_availability": self.tier_availability,
            "metadata": self.metadata,
            "priority": self.priority,
            "recommended": self.recommended,
        } 