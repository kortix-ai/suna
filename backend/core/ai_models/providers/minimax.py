from typing import Dict, Any, List, Optional
from .base import ProviderConfig, ProviderCapability, CacheConfig, ReasoningConfig


class MiniMaxProvider(ProviderConfig):
    def __init__(self, use_openrouter: bool = True):
        self._use_openrouter = use_openrouter
    
    @property
    def name(self) -> str:
        return "openrouter" if self._use_openrouter else "minimax"
    
    @property
    def capabilities(self) -> List[ProviderCapability]:
        return [
            ProviderCapability.REASONING_MODE,
            ProviderCapability.FUNCTION_CALLING,
            ProviderCapability.STREAMING,
            ProviderCapability.PROMPT_CACHING,
        ]
    
    def get_extra_params(self, model_id: str, **kwargs) -> Dict[str, Any]:
        params = {}
        
        reasoning_config = self.get_reasoning_config()
        if reasoning_config and reasoning_config.enabled:
            params[reasoning_config.param_name] = reasoning_config.param_value
            if reasoning_config.split_reasoning:
                params[reasoning_config.split_param_name] = True
        
        if self._use_openrouter:
            extra_body = kwargs.get("extra_body", {})
            extra_body["app"] = kwargs.get("app_name", "Kortix.com")
            params["extra_body"] = extra_body
        
        return params
    
    def get_headers(self, model_id: str) -> Dict[str, str]:
        return {}
    
    def get_extra_headers(self, model_id: str) -> Dict[str, str]:
        return {}
    
    def get_cache_config(self) -> CacheConfig:
        return CacheConfig(
            enabled=True,
            max_blocks=4,
            min_cacheable_tokens=1024,
            cache_control_format="anthropic",
        )
    
    def get_reasoning_config(self) -> ReasoningConfig:
        return ReasoningConfig(
            enabled=True,
            param_name="reasoning",
            param_value={"enabled": True},
            split_reasoning=True,
            split_param_name="reasoning_split",
        )
    
    def get_model_id(self, model_name: str = "minimax-m2.1") -> str:
        if self._use_openrouter:
            return f"openrouter/minimax/{model_name}"
        return f"minimax/{model_name}"


class OpenRouterProvider(ProviderConfig):
    
    def __init__(self, app_name: str = "Kortix.com", site_url: str = "https://www.kortix.com"):
        self._app_name = app_name
        self._site_url = site_url
    
    @property
    def name(self) -> str:
        return "openrouter"
    
    @property
    def capabilities(self) -> List[ProviderCapability]:
        return [
            ProviderCapability.FUNCTION_CALLING,
            ProviderCapability.STREAMING,
        ]
    
    def get_extra_params(self, model_id: str, **kwargs) -> Dict[str, Any]:
        extra_body = kwargs.get("extra_body", {})
        extra_body["app"] = self._app_name
        return {"extra_body": extra_body}
    
    def get_headers(self, model_id: str) -> Dict[str, str]:
        return {}
    
    def get_extra_headers(self, model_id: str) -> Dict[str, str]:
        return {}
