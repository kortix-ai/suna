from typing import Dict, List, Optional, Tuple, Any
from .models import Model, ModelProvider, ModelCapability, ModelPricing, ModelConfig
from core.utils.config import config, EnvMode
from core.utils.logger import logger

# Use Bedrock for STAGING and PRODUCTION, LOCAL uses native APIs (Anthropic API, etc.)
SHOULD_USE_BEDROCK = config.ENV_MODE in (EnvMode.STAGING, EnvMode.PRODUCTION)

AWS_BEDROCK_REGION = "us-west-2"
AWS_BEDROCK_ACCOUNT_ID = "935064898258"

# Bedrock inference profile IDs
KIMI_K2_PROFILE_ID = "hfgufmm5fgcq"
SONNET_4_5_PROFILE_ID = "few7z4l830xh"
HAIKU_4_5_PROFILE_ID = "heol2zyy5v48"
MINIMAX_M2_PROFILE_ID = "zix3khptbyoe"

def build_bedrock_profile_arn(profile_id: str) -> str:
    """Build Bedrock inference profile ARN."""
    return f"bedrock/converse/arn:aws:bedrock:{AWS_BEDROCK_REGION}:{AWS_BEDROCK_ACCOUNT_ID}:application-inference-profile/{profile_id}"

# Pre-built ARNs for convenience
HAIKU_BEDROCK_ARN = build_bedrock_profile_arn(HAIKU_4_5_PROFILE_ID)
SONNET_BEDROCK_ARN = build_bedrock_profile_arn(SONNET_4_5_PROFILE_ID)

# Default model IDs
FREE_MODEL_ID = "kortix/basic"
PREMIUM_MODEL_ID = "kortix/power"
IMAGE_MODEL_ID = "kortix/haiku"  # Model to use when thread has images

# Haiku 4.5 pricing (used for billing resolution)
HAIKU_PRICING = ModelPricing(
    input_cost_per_million_tokens=1.00,
    output_cost_per_million_tokens=5.00,
    cached_read_cost_per_million_tokens=0.10,
    cache_write_5m_cost_per_million_tokens=1.25,
    cache_write_1h_cost_per_million_tokens=2.00,
)


class ModelRegistry:
    def __init__(self):
        self._models: Dict[str, Model] = {}
        self._aliases: Dict[str, str] = {}
        # Mapping of LiteLLM model IDs to pricing (for models not in registry)
        self._litellm_id_to_pricing: Dict[str, ModelPricing] = {}
        self._initialize_models()
    
    def _initialize_models(self):
        # Register Haiku Bedrock ARN pricing for billing resolution
        self._litellm_id_to_pricing[HAIKU_BEDROCK_ARN] = HAIKU_PRICING
        
        # MiniMax M2.1 pricing (LiteLLM may return model ID without openrouter/ prefix)
        minimax_m2_pricing = ModelPricing(
            input_cost_per_million_tokens=0.30,
            output_cost_per_million_tokens=1.20,
            cached_read_cost_per_million_tokens=0.03,
            cache_write_5m_cost_per_million_tokens=0.375,
        )
        self._litellm_id_to_pricing["minimax/minimax-m2.1"] = minimax_m2_pricing
        self._litellm_id_to_pricing["openrouter/minimax/minimax-m2.1"] = minimax_m2_pricing
        
        # Kortix Basic - using MiniMax M2.1
        # Anthropic: basic_litellm_id = build_bedrock_profile_arn(HAIKU_4_5_PROFILE_ID) if SHOULD_USE_BEDROCK else "anthropic/claude-haiku-4-5-20251001"
        basic_litellm_id = "openrouter/minimax/minimax-m2.1"  # 204,800 context $0.30/M input tokens $1.20/M output tokens
        
        self.register(Model(
            id="kortix/basic",
            name="Kortix Basic",
            litellm_model_id=basic_litellm_id,
            provider=ModelProvider.OPENROUTER,
            aliases=["kortix-basic", "Kortix Basic"],
            context_window=200_000,
            capabilities=[
                ModelCapability.CHAT,
                ModelCapability.FUNCTION_CALLING,
                # ModelCapability.VISION,
                ModelCapability.PROMPT_CACHING,
            ],
            pricing=minimax_m2_pricing,
            tier_availability=["free", "paid"],
            priority=102,
            recommended=True,
            enabled=True,
            config=ModelConfig()
        ))
        
        # Kortix Power - using MiniMax M2.1
        # Anthropic: power_litellm_id = build_bedrock_profile_arn(HAIKU_4_5_PROFILE_ID) if SHOULD_USE_BEDROCK else "anthropic/claude-haiku-4-5-20251001"
        power_litellm_id = "openrouter/minimax/minimax-m2.1"  # 204,800 context $0.30/M input tokens $1.20/M output tokens
        
        self.register(Model(
            id="kortix/power",
            name="Kortix Advanced Mode",
            litellm_model_id=power_litellm_id,
            provider=ModelProvider.OPENROUTER,
            aliases=["kortix-power", "Kortix POWER Mode", "Kortix Power", "Kortix Advanced Mode"],
            context_window=200_000,
            capabilities=[
                ModelCapability.CHAT,
                ModelCapability.FUNCTION_CALLING,
                # ModelCapability.VISION,
                ModelCapability.THINKING,
                ModelCapability.PROMPT_CACHING,
            ],
            pricing=minimax_m2_pricing,
            tier_availability=["paid"],
            priority=101,
            recommended=True,
            enabled=True,
            config=ModelConfig()
        ))
        
        # Claude Haiku 4.5 - can be used as a fallback for vision tasks
        haiku_litellm_id = HAIKU_BEDROCK_ARN if SHOULD_USE_BEDROCK else "anthropic/claude-haiku-4-5-20251001"
        
        self.register(Model(
            id="kortix/haiku",
            name="Claude Haiku 4.5",
            litellm_model_id=haiku_litellm_id,
            provider=ModelProvider.BEDROCK if SHOULD_USE_BEDROCK else ModelProvider.ANTHROPIC,
            aliases=[haiku_litellm_id],
            context_window=200_000,
            capabilities=[
                ModelCapability.CHAT,
                ModelCapability.FUNCTION_CALLING,
                ModelCapability.VISION,
                ModelCapability.PROMPT_CACHING,
            ],
            pricing=HAIKU_PRICING,
            tier_availability=["free", "paid"],
            priority=50,
            recommended=False,
            enabled=True,
            config=ModelConfig(
                extra_headers={
                    "anthropic-beta": "fine-grained-tool-streaming-2025-05-14,token-efficient-tools-2025-02-19"
                },
            )
        ))
        
        # Kortix Test - uses MiniMax M2.1 via direct API (only in LOCAL and STAGING, not PRODUCTION)
        if config.ENV_MODE != EnvMode.PRODUCTION:
            # MiniMax direct API - requires MINIMAX_API_KEY env var
            # Docs: https://docs.litellm.ai/docs/providers/minimax
            # test_litellm_id = "minimax/MiniMax-M2.1"  # 204,800 context $0.30/M input $1.20/M output
            test_litellm_id = "openrouter/minimax/minimax-m2.1"  # 204,800 context $0.30/M input $1.20/M output 
            # test_litellm_id = "minimax/MiniMax-M2.1-lightning"  # Faster ~100 tps, $2.40/M output
            # test_litellm_id = "minimax/MiniMax-M2"  # Agentic capabilities
            # test_litellm_id = build_bedrock_profile_arn(MINIMAX_M2_PROFILE_ID)
            # test_litellm_id ="openrouter/minimax/minimax-m2" #  205K context $0.255/M input $1.02/M output
            # test_litellm_id ="openrouter/z-ai/glm-4.6v" #  204,800 context $0.30/M input $1.20/M output
            # test_litellm_id = "openrouter/google/gemini-3-flash-preview"
            # test_litellm_id = "openrouter/x-ai/grok-4.1-fast"
            # test_litellm_id ="groq/moonshotai/kimi-k2-instruct" 

            self.register(Model(
                id="kortix/test",
                name="Kortix Test",
                litellm_model_id=test_litellm_id,
                provider=ModelProvider.MINIMAX,
                aliases=["kortix-test", "Kortix Test"],
                context_window=200_000,
                capabilities=[
                    ModelCapability.CHAT,
                    ModelCapability.FUNCTION_CALLING,
                    ModelCapability.THINKING,
                    ModelCapability.PROMPT_CACHING,
                ],
                pricing=ModelPricing(
                    input_cost_per_million_tokens=0.30,
                    output_cost_per_million_tokens=1.20,
                    cached_read_cost_per_million_tokens=0.03,
                    cache_write_5m_cost_per_million_tokens=0.375,
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
    
    def get_model(self, model_id: str) -> Optional[Model]:
        """Alias for get() for backwards compatibility."""
        return self.get(model_id)
    
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
        """Resolve a model ID to its registry ID.
        
        Handles:
        - Registry model IDs (kortix/basic) → returns as-is
        - Model aliases → resolves to registry ID
        - LiteLLM model IDs (Bedrock ARNs) → reverse lookup to registry ID
        """
        # First try direct registry lookup
        resolved = self.get(model_id)
        if resolved:
            return resolved.id
        
        # Try reverse lookup from LiteLLM model ID
        reverse_resolved = self.resolve_from_litellm_id(model_id)
        if reverse_resolved != model_id:
            return reverse_resolved
            
        return model_id
    
    def get_litellm_model_id(self, model_id: str) -> str:
        """Get the LiteLLM model ID for a given registry model ID or alias."""
        model = self.get(model_id)
        if model:
            return model.litellm_model_id
        return model_id
    
    def supports_vision(self, model_id: str) -> bool:
        """Check if a model supports vision natively."""
        model = self.get(model_id)
        if model:
            return model.supports_vision
        return False
    
    def get_litellm_params(self, model_id: str, **override_params) -> Dict[str, Any]:
        """Get complete LiteLLM parameters for a model from the registry."""
        model = self.get(model_id)
        if not model:
            return {
                "model": model_id,
                "num_retries": 5,
                **override_params
            }
        
        # Get config from model, then override the model ID with the actual LiteLLM model ID
        params = model.get_litellm_params(**override_params)
        params["model"] = self.get_litellm_model_id(model_id)
        
        return params
    
    
    def _normalize_model_id(self, model_id: str) -> str:
        """Normalize model ID for consistent matching.
        
        LiteLLM/OpenRouter may return model IDs without provider prefix (e.g., 'minimax/minimax-m2.1')
        but we store them with prefix (e.g., 'openrouter/minimax/minimax-m2.1').
        """
        if not model_id:
            return model_id
        
        # Common provider prefixes that LiteLLM might strip
        provider_prefixes = ['openrouter/', 'anthropic/', 'bedrock/', 'openai/', 'minimax/']
        
        # If ID already has a known prefix, return as-is
        for prefix in provider_prefixes:
            if model_id.startswith(prefix):
                return model_id
        
        # Try adding openrouter/ prefix (most common case for external models)
        openrouter_variant = f"openrouter/{model_id}"
        return openrouter_variant
    
    def resolve_from_litellm_id(self, litellm_model_id: str) -> str:
        """Reverse lookup: resolve a LiteLLM model ID back to registry model ID.
        
        Used by cost calculator to find pricing. Returns input if not found.
        Handles model ID variations (with/without provider prefix).
        """
        # Direct lookup in registered models
        for model in self._models.values():
            if model.litellm_model_id == litellm_model_id:
                return model.id
        
        # Try normalized version (handles openrouter/ prefix)
        normalized_id = self._normalize_model_id(litellm_model_id)
        if normalized_id != litellm_model_id:
            for model in self._models.values():
                if model.litellm_model_id == normalized_id:
                    return model.id
        
        # Check if this is already a registry ID
        if self.get(litellm_model_id):
            return litellm_model_id
        
        return litellm_model_id
    
    def get_pricing_for_litellm_id(self, litellm_model_id: str) -> Optional[ModelPricing]:
        """Get pricing for a LiteLLM model ID (handles both registry models and raw IDs).
        
        This is the primary method for billing to resolve pricing, as it handles:
        1. Registry model IDs (kortix/basic)
        2. LiteLLM model IDs that map to registry models (with/without provider prefix)
        3. Fallback model IDs (like Haiku Bedrock ARN) that have explicit pricing
        """
        # First, check if it's a registry model or maps to one
        resolved_id = self.resolve_from_litellm_id(litellm_model_id)
        model = self.get(resolved_id)
        if model and model.pricing:
            return model.pricing
        
        # Check explicit litellm ID to pricing mapping (for fallback models)
        if litellm_model_id in self._litellm_id_to_pricing:
            return self._litellm_id_to_pricing[litellm_model_id]
        
        # Try with normalized ID in pricing mapping
        normalized_id = self._normalize_model_id(litellm_model_id)
        if normalized_id in self._litellm_id_to_pricing:
            return self._litellm_id_to_pricing[normalized_id]
        
        # Handle Bedrock ARN patterns
        if "application-inference-profile" in litellm_model_id:
            profile_id = litellm_model_id.split("/")[-1] if "/" in litellm_model_id else None
            if profile_id == HAIKU_4_5_PROFILE_ID:
                return HAIKU_PRICING
        
        return None
    
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
        """Get context window for a model.
        
        Args:
            model_id: Registry model ID or alias
            default: Default context window if model not found
        """
        model = self.get(model_id)
        if model:
            return model.context_window
        return default
    
    def get_pricing(self, model_id: str) -> Optional[ModelPricing]:
        """Get pricing for a model by registry ID or LiteLLM ID."""
        # Direct registry lookup
        model = self.get(model_id)
        if model and model.pricing:
            return model.pricing
        
        # Try as LiteLLM ID
        return self.get_pricing_for_litellm_id(model_id)
    
    def validate_model(self, model_id: str) -> Tuple[bool, str]:
        """Validate that a model exists and is enabled."""
        model = self.get(model_id)
        
        if not model:
            return False, f"Model '{model_id}' not found"
        
        if not model.enabled:
            return False, f"Model '{model.name}' is currently disabled"
        
        return True, ""
    
    def select_best_model(
        self,
        tier: str,
        required_capabilities: Optional[List[ModelCapability]] = None,
        min_context_window: Optional[int] = None,
        prefer_cheaper: bool = False
    ) -> Optional[Model]:
        """Select the best model for given criteria."""
        models = self.get_by_tier(tier, enabled_only=True)
        
        if required_capabilities:
            models = [
                m for m in models
                if all(cap in m.capabilities for cap in required_capabilities)
            ]
        
        if min_context_window:
            models = [m for m in models if m.context_window >= min_context_window]
        
        if not models:
            return None
        
        if prefer_cheaper and any(m.pricing for m in models):
            models_with_pricing = [m for m in models if m.pricing]
            if models_with_pricing:
                models = sorted(
                    models_with_pricing,
                    key=lambda m: m.pricing.input_cost_per_million_tokens
                )
        else:
            models = sorted(
                models,
                key=lambda m: (-m.priority, not m.recommended)
            )
        
        return models[0] if models else None
    
    def get_default_model(self, tier: str = "free") -> Optional[Model]:
        """Get the default model for a tier."""
        models = self.get_by_tier(tier, enabled_only=True)
        
        recommended = [m for m in models if m.recommended]
        if recommended:
            recommended = sorted(recommended, key=lambda m: -m.priority)
            return recommended[0]
        
        if models:
            models = sorted(models, key=lambda m: -m.priority)
            return models[0]
        
        return None
    
    async def get_default_model_for_user(self, client, user_id: str) -> str:
        """Get the default model ID for a user based on their subscription tier."""
        try:
            from core.utils.config import config, EnvMode
            if config.ENV_MODE == EnvMode.LOCAL:
                return PREMIUM_MODEL_ID
                
            from core.billing.subscriptions import subscription_service
            
            subscription_info = await subscription_service.get_subscription(user_id)
            subscription = subscription_info.get('subscription')
            
            is_paid_tier = False
            if subscription:
                price_id = None
                if subscription.get('items') and subscription['items'].get('data') and len(subscription['items']['data']) > 0:
                    price_id = subscription['items']['data'][0]['price']['id']
                else:
                    price_id = subscription.get('price_id')
                
                # Check if this is a paid tier by looking at the tier info
                tier_info = subscription_info.get('tier', {})
                if tier_info and tier_info.get('name') != 'free' and tier_info.get('name') != 'none':
                    is_paid_tier = True
            
            if is_paid_tier:
                return PREMIUM_MODEL_ID
            else:
                return FREE_MODEL_ID
                
        except Exception as e:
            logger.warning(f"Failed to determine user tier for {user_id}: {e}")
            return FREE_MODEL_ID
    
    def check_token_limit(
        self,
        model_id: str,
        token_count: int,
        is_input: bool = True
    ) -> Tuple[bool, int]:
        """Check if token count is within model limits."""
        model = self.get(model_id)
        if not model:
            return False, 0
        
        if is_input:
            max_allowed = model.context_window
        else:
            # Use context_window as max output if not specified
            max_allowed = model.context_window
        
        return token_count <= max_allowed, max_allowed
    
    def format_model_info(self, model_id: str) -> Dict[str, Any]:
        """Format model info for API responses."""
        model = self.get(model_id)
        if not model:
            return {"error": f"Model '{model_id}' not found"}
        
        return {
            "id": model.id,
            "name": model.name,
            "aliases": model.aliases,
            "context_window": model.context_window,
            "capabilities": [cap.value for cap in model.capabilities],
            "enabled": model.enabled,
            "tier_availability": model.tier_availability,
            "priority": model.priority,
            "recommended": model.recommended,
        }
    
    def list_available_models(
        self,
        tier: Optional[str] = None,
        include_disabled: bool = False
    ) -> List[Dict[str, Any]]:
        """List available models, optionally filtered by tier."""
        if tier:
            models = self.get_by_tier(tier, enabled_only=not include_disabled)
        else:
            models = self.get_all(enabled_only=not include_disabled)
        
        if not models:
            logger.warning(f"No models found for tier '{tier}' - this might indicate a configuration issue")
        
        models = sorted(
            models,
            key=lambda m: (not m.is_free_tier, -m.priority, m.name)
        )
        
        return [self.format_model_info(m.id) for m in models]


registry = ModelRegistry()
