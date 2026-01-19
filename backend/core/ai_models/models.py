from dataclasses import dataclass, field
from typing import List, Optional, Dict, Any, Union, TYPE_CHECKING
from enum import Enum

if TYPE_CHECKING:
    from .providers.base import ProviderConfig

class ModelProvider(Enum):
    OPENAI = "openai"
    ANTHROPIC = "anthropic"
    BEDROCK = "bedrock"
    OPENROUTER = "openrouter"
    GOOGLE = "google"
    XAI = "xai"
    MOONSHOTAI = "moonshotai"
    MINIMAX = "minimax"

class ModelCapability(Enum):
    CHAT = "chat"
    FUNCTION_CALLING = "function_calling"
    VISION = "vision"
    THINKING = "thinking"
    PROMPT_CACHING = "prompt_caching"

@dataclass
class ModelPricing:
    input_cost_per_million_tokens: float
    output_cost_per_million_tokens: float
    cached_read_cost_per_million_tokens: Optional[float] = None
    cache_write_5m_cost_per_million_tokens: Optional[float] = None
    cache_write_1h_cost_per_million_tokens: Optional[float] = None
    
    @property
    def input_cost_per_token(self) -> float:
        return self.input_cost_per_million_tokens / 1_000_000
    
    @property
    def output_cost_per_token(self) -> float:
        return self.output_cost_per_million_tokens / 1_000_000
    
    @property
    def cached_read_cost_per_token(self) -> float:
        if self.cached_read_cost_per_million_tokens is None:
            return self.input_cost_per_token
        return self.cached_read_cost_per_million_tokens / 1_000_000
    
    @property
    def cache_write_5m_cost_per_token(self) -> float:
        if self.cache_write_5m_cost_per_million_tokens is None:
            return self.input_cost_per_token
        return self.cache_write_5m_cost_per_million_tokens / 1_000_000
    
    @property
    def cache_write_1h_cost_per_token(self) -> float:
        if self.cache_write_1h_cost_per_million_tokens is None:
            return self.input_cost_per_token
        return self.cache_write_1h_cost_per_million_tokens / 1_000_000

@dataclass
class ReasoningSettings:
    enabled: bool = False
    split_output: bool = False

@dataclass
class ModelConfig:
    api_base: Optional[str] = None
    api_version: Optional[str] = None
    base_url: Optional[str] = None
    deployment_id: Optional[str] = None
    timeout: Optional[Union[float, int]] = None
    num_retries: Optional[int] = None
    headers: Optional[Dict[str, str]] = None
    extra_headers: Optional[Dict[str, str]] = None
    performance_config: Optional[Dict[str, str]] = None
    reasoning: Optional[ReasoningSettings] = None
    extra_body: Optional[Dict[str, Any]] = None


@dataclass
class Model:
    id: str
    name: str
    provider: ModelProvider
    litellm_model_id: Optional[str] = None
    aliases: List[str] = field(default_factory=list)
    context_window: int = 128_000
    capabilities: List[ModelCapability] = field(default_factory=list)
    pricing: Optional[ModelPricing] = None
    enabled: bool = True
    tier_availability: List[str] = field(default_factory=lambda: ["paid"])
    priority: int = 0
    recommended: bool = False
    config: Optional[ModelConfig] = None
    
    def __post_init__(self):
        if self.litellm_model_id is None:
            self.litellm_model_id = self.id
        
        if ModelCapability.CHAT not in self.capabilities:
            self.capabilities.insert(0, ModelCapability.CHAT)
    
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
    def supports_caching(self) -> bool:
        return ModelCapability.PROMPT_CACHING in self.capabilities
    
    @property
    def is_free_tier(self) -> bool:
        return "free" in self.tier_availability
    
    def get_provider_config(self) -> Optional['ProviderConfig']:
        from .providers import get_provider_for_model
        return get_provider_for_model(self.litellm_model_id or self.id)
    
    def get_litellm_params(self, **override_params) -> Dict[str, Any]:
        params = {
            "model": self.litellm_model_id,
            "num_retries": 1,
            "timeout": 120,
        }
        
        if self.config:
            self._apply_model_config(params)
        
        provider = self.get_provider_config()
        if provider:
            self._apply_provider_config(params, provider)
        
        self._apply_overrides(params, override_params)
        
        return params
    
    def _apply_model_config(self, params: Dict[str, Any]):
        api_params = ['api_base', 'api_version', 'base_url', 'deployment_id', 'timeout', 'num_retries']
        
        for param_name in api_params:
            param_value = getattr(self.config, param_name, None)
            if param_value is not None:
                params[param_name] = param_value
        
        if self.config.headers:
            params["headers"] = self.config.headers.copy()
        
        if self.config.extra_headers:
            params["extra_headers"] = self.config.extra_headers.copy()
        
        if self.config.performance_config:
            params["performanceConfig"] = self.config.performance_config.copy()
        
        if self.config.reasoning and self.config.reasoning.enabled:
            params["reasoning"] = {"enabled": True}
            if self.config.reasoning.split_output:
                params["reasoning_split"] = True
        
        if self.config.extra_body:
            params["extra_body"] = self.config.extra_body.copy()
    
    def _apply_provider_config(self, params: Dict[str, Any], provider: 'ProviderConfig'):
        extra_params = provider.get_extra_params(self.litellm_model_id or self.id)
        for key, value in extra_params.items():
            if key == "extra_body" and "extra_body" in params:
                params["extra_body"].update(value)
            elif key not in params:
                params[key] = value
        
        provider_headers = provider.get_headers(self.litellm_model_id or self.id)
        if provider_headers:
            if "headers" not in params:
                params["headers"] = {}
            params["headers"].update(provider_headers)
        
        provider_extra_headers = provider.get_extra_headers(self.litellm_model_id or self.id)
        if provider_extra_headers:
            if "extra_headers" not in params:
                params["extra_headers"] = {}
            params["extra_headers"].update(provider_extra_headers)
    
    def _apply_overrides(self, params: Dict[str, Any], override_params: Dict[str, Any]):
        for key, value in override_params.items():
            if value is None:
                continue
            
            if key == "headers" and "headers" in params and isinstance(params["headers"], dict) and isinstance(value, dict):
                params["headers"].update(value)
            elif key == "extra_headers" and "extra_headers" in params and isinstance(params["extra_headers"], dict) and isinstance(value, dict):
                params["extra_headers"].update(value)
            elif key == "extra_body" and "extra_body" in params and isinstance(params["extra_body"], dict) and isinstance(value, dict):
                params["extra_body"].update(value)
            else:
                params[key] = value
