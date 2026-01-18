from typing import Dict, Any, List, Optional
from .base import ProviderConfig, ProviderCapability, CacheConfig, ReasoningConfig


class AnthropicProvider(ProviderConfig):
    
    BETA_FEATURES = "fine-grained-tool-streaming-2025-05-14,token-efficient-tools-2025-02-19"
    
    def __init__(self, use_bedrock: bool = False, bedrock_region: str = "us-west-2"):
        self._use_bedrock = use_bedrock
        self._bedrock_region = bedrock_region
    
    @property
    def name(self) -> str:
        return "bedrock" if self._use_bedrock else "anthropic"
    
    @property
    def capabilities(self) -> List[ProviderCapability]:
        return [
            ProviderCapability.PROMPT_CACHING,
            ProviderCapability.VISION,
            ProviderCapability.FUNCTION_CALLING,
            ProviderCapability.STREAMING,
            ProviderCapability.EXTENDED_THINKING,
        ]
    
    def get_extra_params(self, model_id: str, **kwargs) -> Dict[str, Any]:
        return {}
    
    def get_headers(self, model_id: str) -> Dict[str, str]:
        return {}
    
    def get_extra_headers(self, model_id: str) -> Dict[str, str]:
        return {"anthropic-beta": self.BETA_FEATURES}
    
    def get_cache_config(self) -> CacheConfig:
        return CacheConfig(
            enabled=True,
            max_blocks=4,
            min_cacheable_tokens=1024,
            cache_control_format="anthropic",
        )
    
    def get_reasoning_config(self) -> Optional[ReasoningConfig]:
        return None
    
    def build_bedrock_arn(self, profile_id: str, account_id: str) -> str:
        return f"bedrock/converse/arn:aws:bedrock:{self._bedrock_region}:{account_id}:application-inference-profile/{profile_id}"


class BedrockProvider(AnthropicProvider):
    
    def __init__(self, region: str = "us-west-2", account_id: str = ""):
        super().__init__(use_bedrock=True, bedrock_region=region)
        self._account_id = account_id
    
    @property
    def name(self) -> str:
        return "bedrock"
    
    def get_extra_params(self, model_id: str, **kwargs) -> Dict[str, Any]:
        return {}
    
    def get_model_arn(self, profile_id: str) -> str:
        return self.build_bedrock_arn(profile_id, self._account_id)
