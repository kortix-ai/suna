from typing import Dict, List, Optional, Tuple, Any
from .models import Model, ModelProvider, ModelCapability, ModelPricing, ModelConfig, ReasoningSettings
from .providers import provider_registry
from .providers.anthropic import BedrockProvider
from core.utils.config import config, EnvMode
from core.utils.logger import logger


class BedrockConfig:
    REGION = "us-west-2"
    ACCOUNT_ID = "935064898258"
    
    PROFILE_IDS = {
        "haiku_4_5": "heol2zyy5v48",
        "sonnet_4_5": "few7z4l830xh",
        "kimi_k2": "hfgufmm5fgcq",
        "minimax_m2": "zix3khptbyoe",
    }
    
    @classmethod
    def build_arn(cls, profile_id: str) -> str:
        return f"bedrock/converse/arn:aws:bedrock:{cls.REGION}:{cls.ACCOUNT_ID}:application-inference-profile/{profile_id}"
    
    @classmethod
    def get_haiku_arn(cls) -> str:
        return cls.build_arn(cls.PROFILE_IDS["haiku_4_5"])
    
    @classmethod
    def get_sonnet_arn(cls) -> str:
        return cls.build_arn(cls.PROFILE_IDS["sonnet_4_5"])


class PricingPresets:
    HAIKU_4_5 = ModelPricing(
        input_cost_per_million_tokens=1.00,
        output_cost_per_million_tokens=5.00,
        cached_read_cost_per_million_tokens=0.10,
        cache_write_5m_cost_per_million_tokens=1.25,
        cache_write_1h_cost_per_million_tokens=2.00,
    )
    
    MINIMAX_M2 = ModelPricing(
        input_cost_per_million_tokens=0.30,
        output_cost_per_million_tokens=1.20,
        cached_read_cost_per_million_tokens=0.03,
        cache_write_5m_cost_per_million_tokens=0.375,
    )
    
    GROK_4_1_FAST = ModelPricing(
        input_cost_per_million_tokens=0.20,
        output_cost_per_million_tokens=0.50,
        cached_read_cost_per_million_tokens=0.05,
    )
    
    GPT_4O_MINI = ModelPricing(
        input_cost_per_million_tokens=0.15,
        output_cost_per_million_tokens=0.60,
        cached_read_cost_per_million_tokens=0.075,
    )


FREE_MODEL_ID = "kortix/basic"
PREMIUM_MODEL_ID = "kortix/power"
IMAGE_MODEL_ID = "kortix/haiku"


def _create_anthropic_model_config() -> ModelConfig:
    return ModelConfig()


def _create_minimax_model_config() -> ModelConfig:
    return ModelConfig(
        reasoning=ReasoningSettings(enabled=True, split_output=True),
        extra_body={"app": "Kortix.com"},
    )


def _should_use_bedrock() -> bool:
    return config.ENV_MODE in (EnvMode.STAGING, EnvMode.PRODUCTION) and config.MAIN_LLM == "bedrock"


def _get_main_llm() -> str:
    return getattr(config, 'MAIN_LLM', 'bedrock')

class ModelFactory:
    
    @staticmethod
    def create_anthropic_haiku(use_bedrock: bool = False) -> Model:
        if use_bedrock:
            litellm_id = BedrockConfig.get_haiku_arn()
            provider = ModelProvider.BEDROCK
        else:
            litellm_id = "anthropic/claude-haiku-4-5-20251001"
            provider = ModelProvider.ANTHROPIC
        
        return Model(
            id="kortix/haiku",
            name="Claude Haiku 4.5",
            litellm_model_id=litellm_id,
            provider=provider,
            aliases=[litellm_id],
            context_window=200_000,
            capabilities=[
                ModelCapability.CHAT,
                ModelCapability.FUNCTION_CALLING,
                ModelCapability.VISION,
                ModelCapability.PROMPT_CACHING,
            ],
            pricing=PricingPresets.HAIKU_4_5,
            tier_availability=["free", "paid"],
            priority=50,
            recommended=False,
            enabled=True,
            config=_create_anthropic_model_config(),
        )
    
    @staticmethod
    def create_minimax_m2(use_openrouter: bool = True) -> Model:
        if use_openrouter:
            litellm_id = "openrouter/minimax/minimax-m2.1"
            provider = ModelProvider.OPENROUTER
        else:
            litellm_id = "minimax/MiniMax-M2.1"
            provider = ModelProvider.MINIMAX
        
        return Model(
            id="kortix/minimax",
            name="MiniMax M2.1",
            litellm_model_id=litellm_id,
            provider=provider,
            aliases=["minimax-m2", "minimax-m2.1"],
            context_window=200_000,
            capabilities=[
                ModelCapability.CHAT,
                ModelCapability.FUNCTION_CALLING,
                ModelCapability.THINKING,
                ModelCapability.PROMPT_CACHING,
            ],
            pricing=PricingPresets.MINIMAX_M2,
            tier_availability=["free", "paid"],
            priority=100,
            recommended=False,
            enabled=True,
            config=_create_minimax_model_config(),
        )
    
    @staticmethod
    def create_basic_model(main_llm: str) -> Model:
        if main_llm == "bedrock":
            return Model(
                id="kortix/basic",
                name="Kortix Basic",
                litellm_model_id=BedrockConfig.get_haiku_arn(),
                provider=ModelProvider.BEDROCK,
                aliases=["kortix-basic", "Kortix Basic"],
                context_window=200_000,
                capabilities=[
                    ModelCapability.CHAT,
                    ModelCapability.FUNCTION_CALLING,
                    ModelCapability.VISION,
                    ModelCapability.PROMPT_CACHING,
                ],
                pricing=PricingPresets.HAIKU_4_5,
                tier_availability=["free", "paid"],
                priority=102,
                recommended=True,
                enabled=True,
                config=_create_anthropic_model_config(),
            )
        elif main_llm == "anthropic":
            return Model(
                id="kortix/basic",
                name="Kortix Basic",
                litellm_model_id="anthropic/claude-haiku-4-5-20251001",
                provider=ModelProvider.ANTHROPIC,
                aliases=["kortix-basic", "Kortix Basic"],
                context_window=200_000,
                capabilities=[
                    ModelCapability.CHAT,
                    ModelCapability.FUNCTION_CALLING,
                    ModelCapability.VISION,
                    ModelCapability.PROMPT_CACHING,
                ],
                pricing=PricingPresets.HAIKU_4_5,
                tier_availability=["free", "paid"],
                priority=102,
                recommended=True,
                enabled=True,
                config=_create_anthropic_model_config(),
            )
        elif main_llm == "grok":
            return Model(
                id="kortix/basic",
                name="Kortix Basic",
                litellm_model_id="openrouter/x-ai/grok-4.1-fast",
                provider=ModelProvider.OPENROUTER,
                aliases=["kortix-basic", "Kortix Basic"],
                context_window=2_000_000,
                capabilities=[
                    ModelCapability.CHAT,
                    ModelCapability.FUNCTION_CALLING,
                    ModelCapability.VISION,
                    ModelCapability.PROMPT_CACHING,
                ],
                pricing=PricingPresets.GROK_4_1_FAST,
                tier_availability=["free", "paid"],
                priority=102,
                recommended=True,
                enabled=True,
            )
        elif main_llm == "openai":
            return Model(
                id="kortix/basic",
                name="Kortix Basic",
                litellm_model_id="openrouter/openai/gpt-4o-mini",
                provider=ModelProvider.OPENROUTER,
                aliases=["kortix-basic", "Kortix Basic"],
                context_window=128_000,
                capabilities=[
                    ModelCapability.CHAT,
                    ModelCapability.FUNCTION_CALLING,
                    ModelCapability.VISION,
                ],
                pricing=PricingPresets.GPT_4O_MINI,
                tier_availability=["free", "paid"],
                priority=102,
                recommended=True,
                enabled=True,
            )
        else:  # minimax
            return Model(
                id="kortix/basic",
                name="Kortix Basic",
                litellm_model_id="openrouter/minimax/minimax-m2.1",
                provider=ModelProvider.OPENROUTER,
                aliases=["kortix-basic", "Kortix Basic"],
                context_window=200_000,
                capabilities=[
                    ModelCapability.CHAT,
                    ModelCapability.FUNCTION_CALLING,
                    ModelCapability.THINKING,
                    ModelCapability.PROMPT_CACHING,
                ],
                pricing=PricingPresets.MINIMAX_M2,
                tier_availability=["free", "paid"],
                priority=102,
                recommended=True,
                enabled=True,
                config=_create_minimax_model_config(),
            )
    
    @staticmethod
    def create_power_model(main_llm: str) -> Model:
        if main_llm == "bedrock":
            return Model(
                id="kortix/power",
                name="Kortix Advanced Mode",
                litellm_model_id=BedrockConfig.get_haiku_arn(),
                provider=ModelProvider.BEDROCK,
                aliases=["kortix-power", "Kortix POWER Mode", "Kortix Power", "Kortix Advanced Mode"],
                context_window=200_000,
                capabilities=[
                    ModelCapability.CHAT,
                    ModelCapability.FUNCTION_CALLING,
                    ModelCapability.VISION,
                    ModelCapability.THINKING,
                    ModelCapability.PROMPT_CACHING,
                ],
                pricing=PricingPresets.HAIKU_4_5,
                tier_availability=["paid"],
                priority=101,
                recommended=True,
                enabled=True,
                config=_create_anthropic_model_config(),
            )
        elif main_llm == "anthropic":
            return Model(
                id="kortix/power",
                name="Kortix Advanced Mode",
                litellm_model_id="anthropic/claude-haiku-4-5-20251001",
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
                pricing=PricingPresets.HAIKU_4_5,
                tier_availability=["paid"],
                priority=101,
                recommended=True,
                enabled=True,
                config=_create_anthropic_model_config(),
            )
        elif main_llm == "grok":
            return Model(
                id="kortix/power",
                name="Kortix Advanced Mode",
                litellm_model_id="openrouter/x-ai/grok-4.1-fast",
                provider=ModelProvider.OPENROUTER,
                aliases=["kortix-power", "Kortix POWER Mode", "Kortix Power", "Kortix Advanced Mode"],
                context_window=2_000_000,
                capabilities=[
                    ModelCapability.CHAT,
                    ModelCapability.FUNCTION_CALLING,
                    ModelCapability.VISION,
                    ModelCapability.THINKING,
                    ModelCapability.PROMPT_CACHING,
                ],
                pricing=PricingPresets.GROK_4_1_FAST,
                tier_availability=["paid"],
                priority=101,
                recommended=True,
                enabled=True,
            )
        elif main_llm == "openai":
            return Model(
                id="kortix/power",
                name="Kortix Advanced Mode",
                litellm_model_id="openrouter/openai/gpt-4o-mini",
                provider=ModelProvider.OPENROUTER,
                aliases=["kortix-power", "Kortix POWER Mode", "Kortix Power", "Kortix Advanced Mode"],
                context_window=128_000,
                capabilities=[
                    ModelCapability.CHAT,
                    ModelCapability.FUNCTION_CALLING,
                    ModelCapability.VISION,
                ],
                pricing=PricingPresets.GPT_4O_MINI,
                tier_availability=["paid"],
                priority=101,
                recommended=True,
                enabled=True,
            )
        else:  # minimax
            return Model(
                id="kortix/power",
                name="Kortix Advanced Mode",
                litellm_model_id="openrouter/minimax/minimax-m2.1",
                provider=ModelProvider.OPENROUTER,
                aliases=["kortix-power", "Kortix POWER Mode", "Kortix Power", "Kortix Advanced Mode"],
                context_window=200_000,
                capabilities=[
                    ModelCapability.CHAT,
                    ModelCapability.FUNCTION_CALLING,
                    ModelCapability.THINKING,
                    ModelCapability.PROMPT_CACHING,
                ],
                pricing=PricingPresets.MINIMAX_M2,
                tier_availability=["paid"],
                priority=101,
                recommended=True,
                enabled=True,
                config=_create_minimax_model_config(),
            )
    
    @staticmethod
    def create_test_model() -> Model:
        return Model(
            id="kortix/test",
            name="Kortix Test",
            litellm_model_id="openrouter/minimax/minimax-m2.1",
            provider=ModelProvider.OPENROUTER,
            aliases=["kortix-test", "Kortix Test"],
            context_window=200_000,
            capabilities=[
                ModelCapability.CHAT,
                ModelCapability.FUNCTION_CALLING,
                ModelCapability.THINKING,
                ModelCapability.PROMPT_CACHING,
            ],
            pricing=PricingPresets.MINIMAX_M2,
            tier_availability=["free", "paid"],
            priority=100,
            recommended=False,
            enabled=True,
            config=_create_minimax_model_config(),
        )
    
    @staticmethod
    def create_grok_4_1_fast() -> Model:
        return Model(
            id="kortix/grok-4-1-fast",
            name="Grok 4.1 Fast",
            litellm_model_id="openrouter/x-ai/grok-4.1-fast",
            provider=ModelProvider.OPENROUTER,
            aliases=["grok-4.1-fast", "grok-4-1-fast", "x-ai/grok-4.1-fast"],
            context_window=2_000_000,
            capabilities=[
                ModelCapability.CHAT,
                ModelCapability.FUNCTION_CALLING,
                ModelCapability.VISION,
                ModelCapability.PROMPT_CACHING,
            ],
            pricing=PricingPresets.GROK_4_1_FAST,
            tier_availability=["paid"],
            priority=90,
            recommended=False,
            enabled=True,
        )
    
    @staticmethod
    def create_gpt4o_mini() -> Model:
        return Model(
            id="kortix/gpt4o-mini",
            name="GPT-4o Mini",
            litellm_model_id="openrouter/openai/gpt-4o-mini",
            provider=ModelProvider.OPENROUTER,
            aliases=["gpt-4o-mini", "gpt4o-mini", "openai/gpt-4o-mini"],
            context_window=128_000,
            capabilities=[
                ModelCapability.CHAT,
                ModelCapability.FUNCTION_CALLING,
                ModelCapability.VISION,
            ],
            pricing=PricingPresets.GPT_4O_MINI,
            tier_availability=["free", "paid"],
            priority=95,
            recommended=True,
            enabled=True,
        )

    @staticmethod
    def create_gpt5_mini() -> Model:
        return Model(
            id="kortix/gpt-5-mini",
            name="GPT-5 Mini",
            litellm_model_id="openrouter/openai/gpt-4o-mini",
            provider=ModelProvider.OPENROUTER,
            aliases=["gpt-4o-mini", "gpt4o-mini", "openai/gpt-4o-mini"],
            context_window=128_000,
            capabilities=[
                ModelCapability.CHAT,
                ModelCapability.FUNCTION_CALLING,
                ModelCapability.VISION,
            ],
            pricing=PricingPresets.GPT_4O_MINI,
            tier_availability=["free", "paid"],
            priority=95,
            recommended=True,
            enabled=True,
        )


class ModelRegistry:
    
    def __init__(self):
        self._models: Dict[str, Model] = {}
        self._aliases: Dict[str, str] = {}
        self._litellm_id_to_pricing: Dict[str, ModelPricing] = {}
        self._initialize_providers()
        self._initialize_models()
    
    def _initialize_providers(self):
        bedrock_provider = BedrockProvider(
            region=BedrockConfig.REGION,
            account_id=BedrockConfig.ACCOUNT_ID,
        )
        provider_registry.register("bedrock", bedrock_provider)
    
    def _initialize_models(self):
        self._register_pricing_mappings()
        
        main_llm = _get_main_llm()
        use_bedrock = _should_use_bedrock()
        
        self.register(ModelFactory.create_basic_model(main_llm))
        self.register(ModelFactory.create_power_model(main_llm))
        self.register(ModelFactory.create_anthropic_haiku(use_bedrock))
        self.register(ModelFactory.create_grok_4_1_fast())
        self.register(ModelFactory.create_gpt4o_mini())
        
        if config.ENV_MODE != EnvMode.PRODUCTION:
            self.register(ModelFactory.create_test_model())
    
    def _register_pricing_mappings(self):
        self._litellm_id_to_pricing[BedrockConfig.get_haiku_arn()] = PricingPresets.HAIKU_4_5
        self._litellm_id_to_pricing["minimax/minimax-m2.1"] = PricingPresets.MINIMAX_M2
        self._litellm_id_to_pricing["openrouter/minimax/minimax-m2.1"] = PricingPresets.MINIMAX_M2
        self._litellm_id_to_pricing["openrouter/x-ai/grok-4.1-fast"] = PricingPresets.GROK_4_1_FAST
        self._litellm_id_to_pricing["openrouter/openai/gpt-4o-mini"] = PricingPresets.GPT_4O_MINI
    
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
        resolved = self.get(model_id)
        if resolved:
            return resolved.id
        
        reverse_resolved = self.resolve_from_litellm_id(model_id)
        if reverse_resolved != model_id:
            return reverse_resolved
        
        return model_id
    
    def get_litellm_model_id(self, model_id: str) -> str:
        model = self.get(model_id)
        if model:
            return model.litellm_model_id
        return model_id
    
    def supports_vision(self, model_id: str) -> bool:
        model = self.get(model_id)
        if model:
            return model.supports_vision
        return False
    
    def get_litellm_params(self, model_id: str, **override_params) -> Dict[str, Any]:
        model = self.get(model_id)
        if not model:
            return {
                "model": model_id,
                "num_retries": 5,
                **override_params
            }
        
        params = model.get_litellm_params(**override_params)
        params["model"] = self.get_litellm_model_id(model_id)
        
        return params
    
    def _normalize_model_id(self, model_id: str) -> str:
        if not model_id:
            return model_id
        
        provider_prefixes = ['openrouter/', 'anthropic/', 'bedrock/', 'openai/', 'minimax/']
        
        for prefix in provider_prefixes:
            if model_id.startswith(prefix):
                return model_id
        
        return f"openrouter/{model_id}"
    
    def resolve_from_litellm_id(self, litellm_model_id: str) -> str:
        for model in self._models.values():
            if model.litellm_model_id == litellm_model_id:
                return model.id
        
        normalized_id = self._normalize_model_id(litellm_model_id)
        if normalized_id != litellm_model_id:
            for model in self._models.values():
                if model.litellm_model_id == normalized_id:
                    return model.id
        
        if self.get(litellm_model_id):
            return litellm_model_id
        
        return litellm_model_id
    
    def get_pricing_for_litellm_id(self, litellm_model_id: str) -> Optional[ModelPricing]:
        resolved_id = self.resolve_from_litellm_id(litellm_model_id)
        model = self.get(resolved_id)
        if model and model.pricing:
            return model.pricing
        
        if litellm_model_id in self._litellm_id_to_pricing:
            return self._litellm_id_to_pricing[litellm_model_id]
        
        normalized_id = self._normalize_model_id(litellm_model_id)
        if normalized_id in self._litellm_id_to_pricing:
            return self._litellm_id_to_pricing[normalized_id]
        
        if "application-inference-profile" in litellm_model_id:
            profile_id = litellm_model_id.split("/")[-1] if "/" in litellm_model_id else None
            if profile_id == BedrockConfig.PROFILE_IDS["haiku_4_5"]:
                return PricingPresets.HAIKU_4_5
        
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
        model = self.get(model_id)
        if model:
            return model.context_window
        return default
    
    def get_pricing(self, model_id: str) -> Optional[ModelPricing]:
        model = self.get(model_id)
        if model and model.pricing:
            return model.pricing
        
        return self.get_pricing_for_litellm_id(model_id)
    
    def validate_model(self, model_id: str) -> Tuple[bool, str]:
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
        try:
            if config.ENV_MODE == EnvMode.LOCAL:
                return PREMIUM_MODEL_ID
            
            from core.billing.subscriptions import subscription_service
            
            subscription_info = await subscription_service.get_subscription(user_id)
            subscription = subscription_info.get('subscription')
            
            is_paid_tier = False
            if subscription:
                tier_info = subscription_info.get('tier', {})
                if tier_info and tier_info.get('name') not in ('free', 'none'):
                    is_paid_tier = True
            
            return PREMIUM_MODEL_ID if is_paid_tier else FREE_MODEL_ID
            
        except Exception as e:
            logger.warning(f"Failed to determine user tier for {user_id}: {e}")
            return FREE_MODEL_ID
    
    def check_token_limit(
        self,
        model_id: str,
        token_count: int,
        is_input: bool = True
    ) -> Tuple[bool, int]:
        model = self.get(model_id)
        if not model:
            return False, 0
        
        max_allowed = model.context_window
        return token_count <= max_allowed, max_allowed
    
    def format_model_info(self, model_id: str) -> Dict[str, Any]:
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
        if tier:
            models = self.get_by_tier(tier, enabled_only=not include_disabled)
        else:
            models = self.get_all(enabled_only=not include_disabled)
        
        if not models:
            logger.warning(f"No models found for tier '{tier}'")
        
        models = sorted(
            models,
            key=lambda m: (not m.is_free_tier, -m.priority, m.name)
        )
        
        return [self.format_model_info(m.id) for m in models]


registry = ModelRegistry()


HAIKU_BEDROCK_ARN = BedrockConfig.get_haiku_arn()
SONNET_BEDROCK_ARN = BedrockConfig.get_sonnet_arn()
HAIKU_PRICING = PricingPresets.HAIKU_4_5
HAIKU_4_5_PROFILE_ID = BedrockConfig.PROFILE_IDS["haiku_4_5"]
