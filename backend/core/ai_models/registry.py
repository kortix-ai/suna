from typing import Dict, List, Optional, Set
from .ai_models import Model, ModelProvider, ModelCapability, ModelPricing, ModelConfig
from core.utils.config import config, EnvMode

# SHOULD_USE_ANTHROPIC = False
# CRITICAL: Production and Staging must ALWAYS use Bedrock, never Anthropic API directly
SHOULD_USE_ANTHROPIC = config.ENV_MODE == EnvMode.LOCAL and bool(config.ANTHROPIC_API_KEY)

if SHOULD_USE_ANTHROPIC:
    FREE_MODEL_ID = "anthropic/claude-haiku-4-5"
    PREMIUM_MODEL_ID = "anthropic/claude-haiku-4-5"
else:  
    FREE_MODEL_ID = "bedrock/converse/arn:aws:bedrock:us-west-2:935064898258:application-inference-profile/heol2zyy5v48"
    PREMIUM_MODEL_ID = "bedrock/converse/arn:aws:bedrock:us-west-2:935064898258:application-inference-profile/heol2zyy5v48"

is_local = config.ENV_MODE == EnvMode.LOCAL
is_prod = config.ENV_MODE == EnvMode.PRODUCTION
# pricing_multiplier = 0.20 if is_prod else 1.0

class ModelRegistry:
    def __init__(self):
        self._models: Dict[str, Model] = {}
        self._aliases: Dict[str, str] = {}
        self._initialize_models()
    
    def _initialize_models(self):
        self.register(Model(
            id="anthropic/claude-haiku-4-5" if SHOULD_USE_ANTHROPIC else "bedrock/converse/arn:aws:bedrock:us-west-2:935064898258:application-inference-profile/heol2zyy5v48",
            name="Haiku 4.5",
            provider=ModelProvider.ANTHROPIC,
            aliases=["claude-haiku-4.5", "anthropic/claude-haiku-4.5", "anthropic/claude-haiku-4-5", "Claude Haiku 4.5", "anthropic/claude-haiku-4-5-20251001", "global.anthropic.claude-haiku-4-5-20251001-v1:0", "bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0", "bedrock/converse/arn:aws:bedrock:us-west-2:935064898258:application-inference-profile/heol2zyy5v48", "arn:aws:bedrock:us-west-2:935064898258:application-inference-profile/heol2zyy5v48"],
            context_window=200_000,
            capabilities=[
                ModelCapability.CHAT,
                ModelCapability.FUNCTION_CALLING,
                ModelCapability.VISION,
            ],
            pricing=ModelPricing(
                input_cost_per_million_tokens=1.00,
                output_cost_per_million_tokens=5.00,
                cached_read_cost_per_million_tokens=0.10,  # Cache hits & refreshes
                cache_write_5m_cost_per_million_tokens=1.25,  # 5-minute cache writes
                cache_write_1h_cost_per_million_tokens=2.00  # 1-hour cache writes
            ),
            tier_availability=["paid"],
            priority=102,
            recommended=True,
            enabled=True,
            config=ModelConfig(
                extra_headers={
                    "anthropic-beta": "fine-grained-tool-streaming-2025-05-14" 
                },
            )
        ))
        
        self.register(Model(
            id="anthropic/claude-sonnet-4-5-20250929" if SHOULD_USE_ANTHROPIC else "bedrock/converse/arn:aws:bedrock:us-west-2:935064898258:application-inference-profile/few7z4l830xh",
            name="Sonnet 4.5",
            provider=ModelProvider.ANTHROPIC,
            aliases=["claude-sonnet-4.5", "anthropic/claude-sonnet-4.5", "anthropic/claude-sonnet-4-5", "anthropic/claude-sonnet-4-5-20250929", "Claude Sonnet 4.5", "claude-sonnet-4-5-20250929", "global.anthropic.claude-sonnet-4-5-20250929-v1:0", "arn:aws:bedrock:us-west-2:935064898258:inference-profile/global.anthropic.claude-sonnet-4-5-20250929-v1:0", "bedrock/global.anthropic.claude-sonnet-4-5-20250929-v1:0", "bedrock/converse/arn:aws:bedrock:us-west-2:935064898258:application-inference-profile/few7z4l830xh", "arn:aws:bedrock:us-west-2:935064898258:application-inference-profile/few7z4l830xh"],
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
                cached_read_cost_per_million_tokens=0.30,  # Cache hits & refreshes
                cache_write_5m_cost_per_million_tokens=3.75,  # 5-minute cache writes
                cache_write_1h_cost_per_million_tokens=6.00  # 1-hour cache writes
            ),
            tier_availability=["paid"],
            priority=101,
            recommended=True,
            enabled=True,
            config=ModelConfig(
                extra_headers={
                    "anthropic-beta": "context-1m-2025-08-07,fine-grained-tool-streaming-2025-05-14" 
                },
            )
        ))
        
        self.register(Model(
            id="anthropic/claude-sonnet-4-20250514" if SHOULD_USE_ANTHROPIC else "bedrock/converse/arn:aws:bedrock:us-west-2:935064898258:application-inference-profile/tyj1ks3nj9qf",
            name="Sonnet 4",
            provider=ModelProvider.ANTHROPIC,
            aliases=["claude-sonnet-4", "anthropic/claude-sonnet-4", "anthropic/claude-sonnet-4-20250514", "Claude Sonnet 4", "claude-sonnet-4-20250514", "global.anthropic.claude-sonnet-4-20250514-v1:0", "arn:aws:bedrock:us-west-2:935064898258:inference-profile/global.anthropic.claude-sonnet-4-20250514-v1:0", "bedrock/global.anthropic.claude-sonnet-4-20250514-v1:0", "bedrock/converse/arn:aws:bedrock:us-west-2:935064898258:application-inference-profile/tyj1ks3nj9qf", "arn:aws:bedrock:us-west-2:935064898258:application-inference-profile/tyj1ks3nj9qf"],
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
                cached_read_cost_per_million_tokens=0.30,  # Cache hits & refreshes
                cache_write_5m_cost_per_million_tokens=3.75,  # 5-minute cache writes
                cache_write_1h_cost_per_million_tokens=6.00  # 1-hour cache writes
            ),
            tier_availability=["paid"],
            priority=100,
            recommended=True,
            enabled=True,
            config=ModelConfig(
                extra_headers={
                    "anthropic-beta": "context-1m-2025-08-07,fine-grained-tool-streaming-2025-05-14" 
                },
            )
        ))
        
        # Sonnet 3.7 - No global inference profile available yet
        # self.register(Model(
        #     id="anthropic/claude-3-7-sonnet-latest" if SHOULD_USE_ANTHROPIC else "global.anthropic.claude-3-7-sonnet-20250219-v1:0",
        #     name="Sonnet 3.7",
        #     provider=ModelProvider.ANTHROPIC,
        #     aliases=["claude-3.7", "Claude 3.7 Sonnet", "claude-3-7-sonnet-latest", "global.anthropic.claude-3-7-sonnet-20250219-v1:0", "arn:aws:bedrock:us-west-2:935064898258:inference-profile/global.anthropic.claude-3-7-sonnet-20250219-v1:0", "bedrock/global.anthropic.claude-3-7-sonnet-20250219-v1:0"],
        #     context_window=200_000,
        #     capabilities=[
        #         ModelCapability.CHAT,
        #         ModelCapability.FUNCTION_CALLING,
        #         ModelCapability.VISION,
        #     ],
        #     pricing=ModelPricing(
        #         input_cost_per_million_tokens=3.00,
        #         output_cost_per_million_tokens=15.00
        #     ),
        #     tier_availability=["paid"],
        #     priority=99,
        #     enabled=True,
        #     config=ModelConfig(
        #         # extra_headers={
        #         #     "anthropic-beta": "prompt-caching-2024-07-31"
        #         # },
        #     )
        # ))

        # Commented out non-Anthropic models as requested
        # self.register(Model(
        #     id="xai/grok-4-fast-non-reasoning",
        #     name="Grok 4 Fast",
        #     provider=ModelProvider.XAI,
        #     aliases=["grok-4-fast-non-reasoning", "Grok 4 Fast"],
        #     context_window=2_000_000,
        #     capabilities=[
        #         ModelCapability.CHAT,
        #         ModelCapability.FUNCTION_CALLING,
        #     ],
        #     pricing=ModelPricing(
        #         input_cost_per_million_tokens=0.20,
        #         output_cost_per_million_tokens=0.50
        #     ),
        #     tier_availability=["paid"],
        #     priority=98,
        #     enabled=True
        # ))        
        
        # self.register(Model(
        #     id="anthropic/claude-3-5-sonnet-latest",
        #     name="Claude 3.5 Sonnet",
        #     provider=ModelProvider.ANTHROPIC,
        #     aliases=["sonnet-3.5", "claude-3.5", "Claude 3.5 Sonnet", "claude-3-5-sonnet-latest"],
        #     context_window=200_000,
        #     capabilities=[
        #         ModelCapability.CHAT,
        #         ModelCapability.FUNCTION_CALLING,
        #         ModelCapability.VISION,
        #     ],
        #     pricing=ModelPricing(
        #         input_cost_per_million_tokens=3.00,
        #         output_cost_per_million_tokens=15.00
        #     ),
        #     tier_availability=["paid"],
        #     priority=90,
        #     enabled=True
        # ))
        
        # Commented out OpenAI models as requested
        # self.register(Model(
        #     id="openai/gpt-5",
        #     name="GPT-5",
        #     provider=ModelProvider.OPENAI,
        #     aliases=["gpt-5", "GPT-5"],
        #     context_window=400_000,
        #     capabilities=[
        #         ModelCapability.CHAT,
        #         ModelCapability.FUNCTION_CALLING,
        #         ModelCapability.VISION,
        #         ModelCapability.STRUCTURED_OUTPUT,
        #     ],
        #     pricing=ModelPricing(
        #         input_cost_per_million_tokens=1.25,
        #         output_cost_per_million_tokens=10.00
        #     ),
        #     tier_availability=["paid"],
        #     priority=97,
        #     enabled=True
        # ))
        
        # self.register(Model(
        #     id="openai/gpt-5-mini",
        #     name="GPT-5 Mini",
        #     provider=ModelProvider.OPENAI,
        #     aliases=["gpt-5-mini", "GPT-5 Mini"],
        #     context_window=400_000,
        #     capabilities=[
        #         ModelCapability.CHAT,
        #         ModelCapability.FUNCTION_CALLING,
        #         ModelCapability.STRUCTURED_OUTPUT,
        #     ],
        #     pricing=ModelPricing(
        #         input_cost_per_million_tokens=0.25,
        #         output_cost_per_million_tokens=2.00
        #     ),
        #     tier_availability=["free", "paid"],
        #     priority=96,
        #     enabled=True
        # ))
        
        # Commented out Google models as requested
        # self.register(Model(
        #     id="gemini/gemini-2.5-pro",
        #     name="Gemini 2.5 Pro",
        #     provider=ModelProvider.GOOGLE,
        #     aliases=["gemini-2.5-pro", "Gemini 2.5 Pro"],
        #     context_window=2_000_000,
        #     capabilities=[
        #         ModelCapability.CHAT,
        #         ModelCapability.FUNCTION_CALLING,
        #         ModelCapability.VISION,
        #         ModelCapability.STRUCTURED_OUTPUT,
        #     ],
        #     pricing=ModelPricing(
        #         input_cost_per_million_tokens=1.25,
        #         output_cost_per_million_tokens=10.00
        #     ),
        #     tier_availability=["paid"],
        #     priority=95,
        #     enabled=True
        # ))
        
        
        # self.register(Model(
        #     id="openrouter/moonshotai/kimi-k2",
        #     name="Kimi K2",
        #     provider=ModelProvider.MOONSHOTAI,
        #     aliases=["kimi-k2", "Kimi K2", "moonshotai/kimi-k2"],
        #     context_window=200_000,
        #     capabilities=[
        #         ModelCapability.CHAT,
        #         ModelCapability.FUNCTION_CALLING,
        #     ],
        #     pricing=ModelPricing(
        #         input_cost_per_million_tokens=1.00,
        #         output_cost_per_million_tokens=3.00
        #     ),
        #     tier_availability=["free", "paid"],
        #     priority=94,
        #     enabled=True,
        #     config=ModelConfig(
        #         extra_headers={
        #             "HTTP-Referer": config.OR_SITE_URL if hasattr(config, 'OR_SITE_URL') and config.OR_SITE_URL else "",
        #             "X-Title": config.OR_APP_NAME if hasattr(config, 'OR_APP_NAME') and config.OR_APP_NAME else ""
        #         }
        #     )
        # ))
        
        # # DeepSeek Models
        # self.register(Model(
        #     id="openrouter/deepseek/deepseek-chat",
        #     name="DeepSeek Chat",
        #     provider=ModelProvider.OPENROUTER,
        #     aliases=["deepseek", "deepseek-chat"],
        #     context_window=128_000,
        #     capabilities=[
        #         ModelCapability.CHAT, 
        #         ModelCapability.FUNCTION_CALLING
        #     ],
        #     pricing=ModelPricing(
        #         input_cost_per_million_tokens=0.38,
        #         output_cost_per_million_tokens=0.89
        #     ),
        #     tier_availability=["free", "paid"],
        #     priority=95,
        #     enabled=False  # Currently disabled
        # ))
        
        # # Qwen Models
        # self.register(Model(
        #     id="openrouter/qwen/qwen3-235b-a22b",
        #     name="Qwen3 235B",
        #     provider=ModelProvider.OPENROUTER,
        #     aliases=["qwen3", "qwen-3"],
        #     context_window=128_000,
        #     capabilities=[
        #         ModelCapability.CHAT, 
        #         ModelCapability.FUNCTION_CALLING
        #     ],
        #     pricing=ModelPricing(
        #         input_cost_per_million_tokens=0.13,
        #         output_cost_per_million_tokens=0.60
        #     ),
        #     tier_availability=["free", "paid"],
        #     priority=90,
        #     enabled=False  # Currently disabled
        # ))
        
    
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