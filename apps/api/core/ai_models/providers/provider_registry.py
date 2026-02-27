from typing import Dict, Optional, Type
from .base import ProviderConfig, ProviderCapability
from .anthropic import AnthropicProvider, BedrockProvider
from .minimax import MiniMaxProvider, OpenRouterProvider


class ProviderRegistry:

    def __init__(self):
        self._providers: Dict[str, ProviderConfig] = {}
        self._model_provider_map: Dict[str, str] = {}
        self._initialize_default_providers()
    
    def _initialize_default_providers(self):
        self.register("anthropic", AnthropicProvider(use_bedrock=False))
        self.register("bedrock", BedrockProvider())
        self.register("minimax", MiniMaxProvider(use_openrouter=False))
        self.register("openrouter", OpenRouterProvider())
        self.register("minimax_openrouter", MiniMaxProvider(use_openrouter=True))
    
    def register(self, name: str, provider: ProviderConfig):
        self._providers[name] = provider
    
    def get(self, name: str) -> Optional[ProviderConfig]:
        return self._providers.get(name)
    
    def get_for_model(self, model_id: str) -> Optional[ProviderConfig]:
        if model_id in self._model_provider_map:
            provider_name = self._model_provider_map[model_id]
            return self._providers.get(provider_name)
        
        provider = self._detect_provider_from_model_id(model_id)
        if provider:
            return provider
        
        return None
    
    def _detect_provider_from_model_id(self, model_id: str) -> Optional[ProviderConfig]:
        model_lower = model_id.lower()
        
        if "bedrock" in model_lower or "arn:aws:bedrock" in model_lower:
            return self._providers.get("bedrock")
        
        if model_lower.startswith("openrouter/"):
            if "minimax" in model_lower:
                return self._providers.get("minimax_openrouter")
            return self._providers.get("openrouter")
        
        if model_lower.startswith("anthropic/") or "claude" in model_lower:
            return self._providers.get("anthropic")
        
        if model_lower.startswith("minimax/"):
            return self._providers.get("minimax")
        
        return None
    
    def map_model_to_provider(self, model_id: str, provider_name: str):
        self._model_provider_map[model_id] = provider_name
    
    def get_all(self) -> Dict[str, ProviderConfig]:
        return self._providers.copy()
    
    def supports_capability(self, provider_name: str, capability: ProviderCapability) -> bool:
        provider = self.get(provider_name)
        if not provider:
            return False
        return provider.supports(capability)


provider_registry = ProviderRegistry()


def get_provider_for_model(model_id: str) -> Optional[ProviderConfig]:
    return provider_registry.get_for_model(model_id)
