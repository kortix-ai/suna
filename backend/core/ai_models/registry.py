from typing import Dict, List, Optional
from .ai_models import Model, ModelProvider, ModelCapability, ModelPricing, ModelConfig
from core.utils.config import config, EnvMode
from core.utils.logger import logger

# Use Bedrock for STAGING and PRODUCTION, LOCAL uses native APIs (Anthropic API, etc.)
SHOULD_USE_BEDROCK = config.ENV_MODE in (EnvMode.STAGING, EnvMode.PRODUCTION)

AWS_BEDROCK_REGION = "us-west-2"
AWS_BEDROCK_ACCOUNT_ID = "935064898258"

KIMI_K2_PROFILE_ID = "hfgufmm5fgcq"
SONNET_4_5_PROFILE_ID = "few7z4l830xh"
HAIKU_4_5_PROFILE_ID = "heol2zyy5v48"
MINIMAX_M2_PROFILE_ID = "zix3khptbyoe"

def build_bedrock_profile_arn(profile_id: str) -> str:
    """Build Bedrock inference profile ARN."""
    return f"bedrock/converse/arn:aws:bedrock:{AWS_BEDROCK_REGION}:{AWS_BEDROCK_ACCOUNT_ID}:application-inference-profile/{profile_id}"

# Default model IDs
FREE_MODEL_ID = "kortix/basic"
PREMIUM_MODEL_ID = "kortix/power"

class ModelRegistry:
    def __init__(self):
        self._models: Dict[str, Model] = {}
        self._aliases: Dict[str, str] = {}
        self._initialize_models()
    
    def _initialize_models(self):
        # Kortix Basic - uses Haiku 4.5 under the hood
        basic_litellm_id = build_bedrock_profile_arn(HAIKU_4_5_PROFILE_ID) if SHOULD_USE_BEDROCK else "anthropic/claude-haiku-4-5-20251001"
        
        self.register(Model(
            id="kortix/basic",
            name="Kortix Basic",
            litellm_model_id=basic_litellm_id,
            provider=ModelProvider.ANTHROPIC,
            aliases=["kortix-basic", "Kortix Basic"],
            context_window=200_000,
            capabilities=[
                ModelCapability.CHAT,
                ModelCapability.FUNCTION_CALLING,
                ModelCapability.VISION,
                ModelCapability.PROMPT_CACHING,
            ],
            pricing=ModelPricing(
                input_cost_per_million_tokens=1.00,
                output_cost_per_million_tokens=5.00,
                cached_read_cost_per_million_tokens=0.10,
                cache_write_5m_cost_per_million_tokens=1.25,
                cache_write_1h_cost_per_million_tokens=2.00
            ),
            tier_availability=["free", "paid"],
            priority=102,
            recommended=True,
            enabled=True,
            config=ModelConfig(
                extra_headers={
                    "anthropic-beta": "fine-grained-tool-streaming-2025-05-14,token-efficient-tools-2025-02-19" 
                },
            )
        ))
        
        # TEMPORARY: Using Haiku 4.5 instead of Sonnet 4.5 for kortix/power
        power_litellm_id = build_bedrock_profile_arn(HAIKU_4_5_PROFILE_ID) if SHOULD_USE_BEDROCK else "anthropic/claude-haiku-4-5-20251001"
        
        self.register(Model(
            id="kortix/power",
            name="Kortix Advanced Mode",
            litellm_model_id=power_litellm_id,
            provider=ModelProvider.ANTHROPIC,
            aliases=["kortix-power", "Kortix POWER Mode", "Kortix Power", "Kortix Advanced Mode"],
            context_window=200_000,
            capabilities=[
                ModelCapability.CHAT,
                ModelCapability.FUNCTION_CALLING,
                ModelCapability.VISION,
                ModelCapability.THINKING,
                ModelCapability.PROMPT_CACHING,
            ],
            pricing=ModelPricing(
                input_cost_per_million_tokens=1.00,
                output_cost_per_million_tokens=5.00,
                cached_read_cost_per_million_tokens=0.10,
                cache_write_5m_cost_per_million_tokens=1.25,
                cache_write_1h_cost_per_million_tokens=2.00
            ),
            tier_availability=["paid"],
            priority=101,
            recommended=True,
            enabled=True,
            config=ModelConfig(
                extra_headers={
                    "anthropic-beta": "context-1m-2025-08-07,fine-grained-tool-streaming-2025-05-14,token-efficient-tools-2025-02-19" 
                },
            )
        ))
        
        # Kortix Test - uses MiniMax M2 via Bedrock (only in LOCAL and STAGING, not PRODUCTION)
        if config.ENV_MODE != EnvMode.PRODUCTION:
            # test_litellm_id = build_bedrock_profile_arn(MINIMAX_M2_PROFILE_ID)
            test_litellm_id ="openrouter/minimax/minimax-m2" #  205K context $0.255/M input tokens $1.02/M output tokens
            # test_litellm_id = "openrouter/z-ai/glm-4.7" # 203K context $0.44/M input tokens $1.74/M output tokens
            # test_litellm_id = "openrouter/z-ai/glm-4.6v" # 131K context $0.30/M input tokens $0.90/M output tokens 
            # test_litellm_id = "openrouter/google/gemini-3-flash-preview" #  1.05M context $0.50/M input tokens $3/M output tokens $1/M audio tokens
            # test_litellm_id = "openrouter/x-ai/grok-4.1-fast" #2M context $0.20/M input tokens $0.50/M output tokens
            # test_litellm_id = "openrouter/deepseek/deepseek-v3.2-speciale" 164K context $0.27/M input tokens $0.41/M output tokens
            # test_litellm_id = "openrouter/deepseek/deepseek-v3.2" 164K context $0.26/M input tokens $0.38/M output tokens

            self.register(Model(
                id="kortix/test",
                name="Kortix Test",
                litellm_model_id=test_litellm_id,
                provider=ModelProvider.BEDROCK,
                aliases=["kortix-test", "Kortix Test"],
                context_window=200_000,
                capabilities=[
                    ModelCapability.CHAT,
                    ModelCapability.FUNCTION_CALLING,
                    ModelCapability.VISION,
                    ModelCapability.PROMPT_CACHING,
                ],
                pricing=ModelPricing(
                    input_cost_per_million_tokens=0.30,
                    output_cost_per_million_tokens=1.20,
                    cached_read_cost_per_million_tokens=0.03,
                    cache_write_5m_cost_per_million_tokens=0.375,
                    cache_write_1h_cost_per_million_tokens=0.50,
                ),
                tier_availability=["free", "paid"],
                priority=100,
                recommended=False,
                enabled=True,
                config=ModelConfig()
            ))
    
    def register(self, model: Model) -> None:
        self._models[model.id] = model
        for alias in model.aliases:
            self._aliases[alias] = model.id
    
    def get(self, model_id: str) -> Optional[Model]:
        if not model_id:
            return None
            
        if model_id in self._models:
            return self._models[model_id]
        
        if model_id in self._aliases:
            actual_id = self._aliases[model_id]
            return self._models.get(actual_id)
        
        return None
    
    def get_all(self, enabled_only: bool = True) -> List[Model]:
        models = list(self._models.values())
        if enabled_only:
            models = [m for m in models if m.enabled]
        return models
    
    def get_by_tier(self, tier: str, enabled_only: bool = True) -> List[Model]:
        models = self.get_all(enabled_only)
        return [m for m in models if tier in m.tier_availability]
    
    def get_by_provider(self, provider: ModelProvider, enabled_only: bool = True) -> List[Model]:
        models = self.get_all(enabled_only)
        return [m for m in models if m.provider == provider]
    
    def get_by_capability(self, capability: ModelCapability, enabled_only: bool = True) -> List[Model]:
        models = self.get_all(enabled_only)
        return [m for m in models if capability in m.capabilities]
    
    def resolve_model_id(self, model_id: str) -> Optional[str]:
        model = self.get(model_id)
        return model.id if model else None
    
    def get_litellm_model_id(self, model_id: str) -> str:
        """Get the LiteLLM model ID for a given registry model ID or alias.
        
        Args:
            model_id: Registry model ID (e.g., "kortix/basic") or alias
            
        Returns:
            LiteLLM model ID (e.g., Bedrock ARN or Anthropic API ID)
        """
        model = self.get(model_id)
        if model:
            return model.litellm_model_id
        
        # Return as-is if not found (let LiteLLM handle it)
        return model_id
    
    def resolve_from_litellm_id(self, litellm_model_id: str) -> str:
        """Reverse lookup: resolve a LiteLLM model ID back to registry model ID.
        
        This is the inverse of get_litellm_model_id. Used by cost calculator to find pricing.
        
        Args:
            litellm_model_id: The LiteLLM model ID (e.g., Bedrock ARN or Anthropic API ID)
            
        Returns:
            The registry model ID (e.g., 'kortix/basic') or the input if not found
        """
        # Search through all models to find matching litellm_model_id
        for model in self._models.values():
            if model.litellm_model_id == litellm_model_id:
                return model.id
        
        # Handle Bedrock ARNs that may come in different formats
        # Format 1: bedrock/converse/arn:aws:bedrock:.../profile_id
        # Format 2: arn:aws:bedrock:.../profile_id
        if "application-inference-profile" in litellm_model_id:
            # Extract profile ID from ARN (last segment after final "/")
            profile_id = None
            if "/" in litellm_model_id:
                profile_id = litellm_model_id.split("/")[-1]
            
            if profile_id:
                # Map profile IDs to registry model IDs
                profile_to_model = {
                    HAIKU_4_5_PROFILE_ID: "kortix/basic",
                    SONNET_4_5_PROFILE_ID: "kortix/power",
                    KIMI_K2_PROFILE_ID: "kortix/test",
                    MINIMAX_M2_PROFILE_ID: "kortix/test",
                }
                
                registry_id = profile_to_model.get(profile_id)
                if registry_id and self.get(registry_id):
                    logger.debug(f"[MODEL_REGISTRY] Resolved Bedrock ARN profile '{profile_id}' to registry model '{registry_id}'")
                    return registry_id
                else:
                    logger.debug(f"[MODEL_REGISTRY] Bedrock profile '{profile_id}' not found in mapping or model not registered")
        
        # Check if this is already a registry ID
        if self.get(litellm_model_id):
            return litellm_model_id
        
        # Return as-is if no reverse mapping found
        return litellm_model_id
    
    def get_aliases(self, model_id: str) -> List[str]:
        model = self.get(model_id)
        return model.aliases if model else []
    
    def enable_model(self, model_id: str) -> bool:
        model = self.get(model_id)
        if model:
            model.enabled = True
            return True
        return False
    
    def disable_model(self, model_id: str) -> bool:
        model = self.get(model_id)
        if model:
            model.enabled = False
            return True
        return False
    
    def get_context_window(self, model_id: str, default: int = 31_000) -> int:
        model = self.get(model_id)
        return model.context_window if model else default
    
    def get_pricing(self, model_id: str) -> Optional[ModelPricing]:
        """Get pricing for a model, with reverse lookup for LiteLLM model IDs.
        
        Handles both registry model IDs (kortix/basic) and LiteLLM model IDs (Bedrock ARNs).
        """
        # First try direct lookup
        model = self.get(model_id)
        if model and model.pricing:
            return model.pricing
        
        # Try reverse lookup from LiteLLM model ID
        resolved_id = self.resolve_from_litellm_id(model_id)
        if resolved_id != model_id:
            model = self.get(resolved_id)
            if model and model.pricing:
                return model.pricing
        
        return None
    
    def to_legacy_format(self) -> Dict:
        models_dict = {}
        pricing_dict = {}
        context_windows_dict = {}
        
        for model in self.get_all(enabled_only=True):
            models_dict[model.id] = {
                "pricing": {
                    "input_cost_per_million_tokens": model.pricing.input_cost_per_million_tokens,
                    "output_cost_per_million_tokens": model.pricing.output_cost_per_million_tokens,
                } if model.pricing else None,
                "context_window": model.context_window,
                "tier_availability": model.tier_availability,
            }
            
            if model.pricing:
                pricing_dict[model.id] = {
                    "input_cost_per_million_tokens": model.pricing.input_cost_per_million_tokens,
                    "output_cost_per_million_tokens": model.pricing.output_cost_per_million_tokens,
                }
            
            context_windows_dict[model.id] = model.context_window
        
        free_models = [m.id for m in self.get_by_tier("free")]
        paid_models = [m.id for m in self.get_by_tier("paid")]
        
        # Debug logging
        from core.utils.logger import logger
        logger.debug(f"Legacy format generation: {len(free_models)} free models, {len(paid_models)} paid models")
        logger.debug(f"Free models: {free_models}")
        logger.debug(f"Paid models: {paid_models}")
        
        return {
            "MODELS": models_dict,
            "HARDCODED_MODEL_PRICES": pricing_dict,
            "MODEL_CONTEXT_WINDOWS": context_windows_dict,
            "FREE_TIER_MODELS": free_models,
            "PAID_TIER_MODELS": paid_models,
        }

registry = ModelRegistry() 