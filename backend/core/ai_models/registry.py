from typing import Dict, List, Optional
from .ai_models import Model, ModelProvider, ModelCapability, ModelPricing, ModelConfig
from core.utils.config import config
from core.utils.logger import logger

BEDROCK_HAIKU_PROFILE = "bedrock/converse/arn:aws:bedrock:us-west-2:935064898258:application-inference-profile/heol2zyy5v48"
BEDROCK_SONNET_PROFILE = "bedrock/converse/arn:aws:bedrock:us-west-2:935064898258:application-inference-profile/few7z4l830xh"
BEDROCK_SONNET4_PROFILE = "bedrock/converse/arn:aws:bedrock:us-west-2:935064898258:application-inference-profile/tyj1ks3nj9qf"


def _has_config_value(attr: str) -> bool:
    return bool(getattr(config, attr, None))


def _has_bedrock_credentials() -> bool:
    return bool(
        getattr(config, "AWS_BEARER_TOKEN_BEDROCK", None)
        or (
            getattr(config, "AWS_ACCESS_KEY_ID", None)
            and getattr(config, "AWS_SECRET_ACCESS_KEY", None)
            and getattr(config, "AWS_REGION_NAME", None)
        )
    )


def _choose_default_model(candidates: List[tuple], fallback: str) -> str:
    for condition, model_id in candidates:
        if condition:
            return model_id
    return fallback


FREE_MODEL_ID = _choose_default_model(
    [
        (_has_config_value("OPENAI_API_KEY"), "openai/gpt-4o-mini"),
        (_has_config_value("GEMINI_API_KEY"), "google/gemini-2.0-flash-exp"),
        (_has_config_value("GROQ_API_KEY"), "groq/llama-3.3-8b-instant"),
        (_has_config_value("DEEPSEEK_API_KEY"), "deepseek/deepseek-chat"),
        (_has_config_value("ANTHROPIC_API_KEY"), "anthropic/claude-3-7-haiku-latest"),
        (_has_bedrock_credentials(), BEDROCK_HAIKU_PROFILE),
    ],
    "openai/gpt-4o-mini",
)


PREMIUM_MODEL_ID = _choose_default_model(
    [
        (_has_config_value("ANTHROPIC_API_KEY"), "anthropic/claude-3-7-sonnet-latest"),
        (_has_bedrock_credentials(), BEDROCK_SONNET_PROFILE),
        (_has_config_value("OPENAI_API_KEY"), "openai/gpt-4.1-mini"),
        (_has_config_value("GROQ_API_KEY"), "groq/llama-3.3-70b-versatile"),
        (_has_config_value("GEMINI_API_KEY"), "google/gemini-2.0-pro-exp"),
        (_has_config_value("DEEPSEEK_API_KEY"), "deepseek/deepseek-reasoner"),
    ],
    "openai/gpt-4o-mini",
)

class ModelRegistry:
    def __init__(self):
        self._models: Dict[str, Model] = {}
        self._aliases: Dict[str, str] = {}
        self._initialize_models()
    
    def _initialize_models(self):
        groq_base = getattr(config, "GROQ_API_BASE", "https://api.groq.com/openai/v1")
        deepseek_base = getattr(config, "DEEPSEEK_API_BASE", "https://api.deepseek.com")
        gemini_base = getattr(config, "GEMINI_API_BASE", "https://generativelanguage.googleapis.com")

        if _has_bedrock_credentials():
            # AWS Bedrock MAP profiles (Anthropic via Bedrock)
            self.register(Model(
                id=BEDROCK_HAIKU_PROFILE,
                name="Claude Haiku 4.5 (Bedrock MAP)",
                provider=ModelProvider.BEDROCK,
                aliases=[
                    "claude-haiku-4.5",
                    "anthropic/claude-haiku-4-5",
                    BEDROCK_HAIKU_PROFILE,
                    "bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0",
                ],
                context_window=200_000,
                capabilities=[
                    ModelCapability.CHAT,
                    ModelCapability.FUNCTION_CALLING,
                    ModelCapability.VISION,
                ],
                pricing=ModelPricing(
                    input_cost_per_million_tokens=1.00,
                    output_cost_per_million_tokens=5.00,
                ),
                tier_availability=["paid"],
                priority=110,
                recommended=True,
                enabled=True,
                config=ModelConfig(
                    extra_headers={"anthropic-beta": "context-1m-2025-08-07"},
                    performanceConfig={"latency": "optimized"},
                ),
            ))

            self.register(Model(
                id=BEDROCK_SONNET_PROFILE,
                name="Claude Sonnet 4.5 (Bedrock MAP)",
                provider=ModelProvider.BEDROCK,
                aliases=[
                    "claude-sonnet-4.5",
                    "anthropic/claude-sonnet-4-5",
                    BEDROCK_SONNET_PROFILE,
                    "bedrock/global.anthropic.claude-sonnet-4-5-20250929-v1:0",
                ],
                context_window=1_000_000,
                capabilities=[
                    ModelCapability.CHAT,
                    ModelCapability.FUNCTION_CALLING,
                    ModelCapability.VISION,
                    ModelCapability.THINKING,
                ],
                pricing=ModelPricing(
                    input_cost_per_million_tokens=3.00,
                    output_cost_per_million_tokens=15.00,
                ),
                tier_availability=["paid"],
                priority=109,
                recommended=True,
                enabled=True,
                config=ModelConfig(
                    extra_headers={"anthropic-beta": "context-1m-2025-08-07"},
                    performanceConfig={"latency": "optimized"},
                ),
            ))

            self.register(Model(
                id=BEDROCK_SONNET4_PROFILE,
                name="Claude Sonnet 4 (Bedrock MAP)",
                provider=ModelProvider.BEDROCK,
                aliases=[
                    "claude-sonnet-4",
                    "anthropic/claude-sonnet-4",
                    BEDROCK_SONNET4_PROFILE,
                    "bedrock/global.anthropic.claude-sonnet-4-20250514-v1:0",
                ],
                context_window=1_000_000,
                capabilities=[
                    ModelCapability.CHAT,
                    ModelCapability.FUNCTION_CALLING,
                    ModelCapability.VISION,
                    ModelCapability.THINKING,
                ],
                pricing=ModelPricing(
                    input_cost_per_million_tokens=3.00,
                    output_cost_per_million_tokens=15.00,
                ),
                tier_availability=["paid"],
                priority=108,
                recommended=False,
                enabled=True,
                config=ModelConfig(
                    extra_headers={"anthropic-beta": "context-1m-2025-08-07"},
                    performanceConfig={"latency": "optimized"},
                ),
            ))
        else:
            logger.info("Bedrock credentials not detected; skipping Bedrock model registration")

        # Direct Anthropic API models
        self.register(Model(
            id="anthropic/claude-3-7-haiku-latest",
            name="Claude 3.7 Haiku",
            provider=ModelProvider.ANTHROPIC,
            aliases=["claude-3.7-haiku", "claude-3-7-haiku-latest"],
            context_window=200_000,
            capabilities=[
                ModelCapability.CHAT,
                ModelCapability.FUNCTION_CALLING,
                ModelCapability.VISION,
            ],
            pricing=ModelPricing(
                input_cost_per_million_tokens=0.25,
                output_cost_per_million_tokens=1.25,
            ),
            tier_availability=["free", "paid"],
            priority=104,
            recommended=True,
            enabled=True,
            config=ModelConfig(
                extra_headers={"anthropic-beta": "prompt-caching-2024-07-31"},
            ),
        ))

        self.register(Model(
            id="anthropic/claude-3-7-sonnet-latest",
            name="Claude 3.7 Sonnet",
            provider=ModelProvider.ANTHROPIC,
            aliases=["claude-3.7-sonnet", "claude-3-7-sonnet-latest"],
            context_window=200_000,
            capabilities=[
                ModelCapability.CHAT,
                ModelCapability.FUNCTION_CALLING,
                ModelCapability.VISION,
                ModelCapability.THINKING,
            ],
            pricing=ModelPricing(
                input_cost_per_million_tokens=3.00,
                output_cost_per_million_tokens=15.00,
            ),
            tier_availability=["paid"],
            priority=107,
            recommended=True,
            enabled=True,
            config=ModelConfig(
                extra_headers={"anthropic-beta": "context-1m-2025-08-07"},
            ),
        ))

        # OpenAI models
        self.register(Model(
            id="openai/gpt-4o-mini",
            name="GPT-4o Mini",
            provider=ModelProvider.OPENAI,
            aliases=["gpt-4o-mini", "openai/gpt-4o-mini"],
            context_window=128_000,
            capabilities=[
                ModelCapability.CHAT,
                ModelCapability.FUNCTION_CALLING,
                ModelCapability.VISION,
                ModelCapability.STRUCTURED_OUTPUT,
            ],
            pricing=ModelPricing(
                input_cost_per_million_tokens=0.15,
                output_cost_per_million_tokens=0.60,
            ),
            tier_availability=["free", "paid"],
            priority=105,
            recommended=True,
            enabled=True,
            config=ModelConfig(),
        ))

        self.register(Model(
            id="openai/gpt-4.1-mini",
            name="GPT-4.1 Mini",
            provider=ModelProvider.OPENAI,
            aliases=["gpt-4.1-mini", "openai/gpt-4.1-mini"],
            context_window=128_000,
            capabilities=[
                ModelCapability.CHAT,
                ModelCapability.FUNCTION_CALLING,
                ModelCapability.VISION,
                ModelCapability.STRUCTURED_OUTPUT,
            ],
            pricing=ModelPricing(
                input_cost_per_million_tokens=2.50,
                output_cost_per_million_tokens=10.00,
            ),
            tier_availability=["paid"],
            priority=106,
            recommended=True,
            enabled=True,
            config=ModelConfig(),
        ))

        # Google Gemini models
        self.register(Model(
            id="google/gemini-2.0-flash-exp",
            name="Gemini 2.0 Flash",
            provider=ModelProvider.GOOGLE,
            aliases=["gemini-2.0-flash", "gemini-2.0-flash-exp"],
            context_window=2_000_000,
            capabilities=[
                ModelCapability.CHAT,
                ModelCapability.FUNCTION_CALLING,
                ModelCapability.VISION,
                ModelCapability.STRUCTURED_OUTPUT,
            ],
            pricing=ModelPricing(
                input_cost_per_million_tokens=0.35,
                output_cost_per_million_tokens=1.05,
            ),
            tier_availability=["free", "paid"],
            priority=103,
            recommended=True,
            enabled=True,
            config=ModelConfig(api_base=gemini_base),
        ))

        self.register(Model(
            id="google/gemini-2.0-pro-exp",
            name="Gemini 2.0 Pro",
            provider=ModelProvider.GOOGLE,
            aliases=["gemini-2.0-pro", "gemini-2.0-pro-exp"],
            context_window=2_000_000,
            capabilities=[
                ModelCapability.CHAT,
                ModelCapability.FUNCTION_CALLING,
                ModelCapability.VISION,
                ModelCapability.STRUCTURED_OUTPUT,
            ],
            pricing=ModelPricing(
                input_cost_per_million_tokens=1.25,
                output_cost_per_million_tokens=5.00,
            ),
            tier_availability=["paid"],
            priority=102,
            recommended=True,
            enabled=True,
            config=ModelConfig(api_base=gemini_base),
        ))

        # Groq models
        self.register(Model(
            id="groq/llama-3.3-8b-instant",
            name="Llama 3.3 8B Instant",
            provider=ModelProvider.GROQ,
            aliases=["llama-3.3-8b", "llama-3.3-8b-instant"],
            context_window=131_072,
            capabilities=[
                ModelCapability.CHAT,
                ModelCapability.FUNCTION_CALLING,
            ],
            pricing=ModelPricing(
                input_cost_per_million_tokens=0.10,
                output_cost_per_million_tokens=0.20,
            ),
            tier_availability=["free", "paid"],
            priority=101,
            recommended=True,
            enabled=True,
            config=ModelConfig(api_base=groq_base),
        ))

        self.register(Model(
            id="groq/llama-3.3-70b-versatile",
            name="Llama 3.3 70B Versatile",
            provider=ModelProvider.GROQ,
            aliases=["llama-3.3-70b", "llama-3.3-70b-versatile"],
            context_window=131_072,
            capabilities=[
                ModelCapability.CHAT,
                ModelCapability.FUNCTION_CALLING,
                ModelCapability.VISION,
            ],
            pricing=ModelPricing(
                input_cost_per_million_tokens=0.59,
                output_cost_per_million_tokens=0.79,
            ),
            tier_availability=["paid"],
            priority=100,
            recommended=True,
            enabled=True,
            config=ModelConfig(api_base=groq_base),
        ))

        # DeepSeek models
        self.register(Model(
            id="deepseek/deepseek-chat",
            name="DeepSeek Chat",
            provider=ModelProvider.DEEPSEEK,
            aliases=["deepseek", "deepseek-chat"],
            context_window=128_000,
            capabilities=[
                ModelCapability.CHAT,
                ModelCapability.FUNCTION_CALLING,
            ],
            pricing=ModelPricing(
                input_cost_per_million_tokens=0.14,
                output_cost_per_million_tokens=0.28,
            ),
            tier_availability=["free", "paid"],
            priority=99,
            recommended=True,
            enabled=True,
            config=ModelConfig(api_base=deepseek_base),
        ))

        self.register(Model(
            id="deepseek/deepseek-reasoner",
            name="DeepSeek Reasoner",
            provider=ModelProvider.DEEPSEEK,
            aliases=["deepseek-reasoner"],
            context_window=128_000,
            capabilities=[
                ModelCapability.CHAT,
                ModelCapability.FUNCTION_CALLING,
                ModelCapability.THINKING,
            ],
            pricing=ModelPricing(
                input_cost_per_million_tokens=0.55,
                output_cost_per_million_tokens=1.10,
            ),
            tier_availability=["paid"],
            priority=98,
            recommended=True,
            enabled=True,
            config=ModelConfig(api_base=deepseek_base),
        ))
        
    
    def register(self, model: Model) -> None:
        self._models[model.id] = model
        for alias in model.aliases:
            self._aliases[alias] = model.id
    
    def get(self, model_id: str) -> Optional[Model]:
        # Handle None or empty model_id
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
        model = self.get(model_id)
        return model.pricing if model else None
    
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