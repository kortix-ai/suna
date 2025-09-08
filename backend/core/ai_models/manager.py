from typing import Optional, List, Dict, Any, Tuple
from .registry import registry
from .ai_models import Model, ModelCapability
from core.utils.logger import logger
from .registry import DEFAULT_PREMIUM_MODEL, DEFAULT_FREE_MODEL

class ModelManager:
    def __init__(self):
        self.registry = registry
    
    def get_model(self, model_id: str) -> Optional[Model]:
        return self.registry.get(model_id)
    
    def resolve_model_id(self, model_id: str) -> str:
        logger.debug(f"resolve_model_id called with: '{model_id}' (type: {type(model_id)})")
        
        resolved = self.registry.resolve_model_id(model_id)
        if resolved:
            logger.debug(f"Resolved model '{model_id}' to '{resolved}'")
            return resolved
        
        # Silently return the original model_id if we can't resolve it
        # This avoids spamming logs with warnings for unknown models
        logger.debug(f"Could not resolve model ID: '{model_id}', returning as-is")
        return model_id
    
    def validate_model(self, model_id: str) -> Tuple[bool, str]:
        model = self.get_model(model_id)
        
        if not model:
            return False, f"Model '{model_id}' not found"
        
        if not model.enabled:
            return False, f"Model '{model.name}' is currently disabled"
        
        return True, ""
    
    def calculate_cost(
        self,
        model_id: str,
        input_tokens: int,
        output_tokens: int
    ) -> Optional[float]:
        model = self.get_model(model_id)
        if not model or not model.pricing:
            logger.warning(f"No pricing available for model: {model_id}")
            return None
        
        input_cost = input_tokens * model.pricing.input_cost_per_token
        output_cost = output_tokens * model.pricing.output_cost_per_token
        total_cost = input_cost + output_cost
        
        logger.debug(
            f"Cost calculation for {model.name}: "
            f"{input_tokens} input tokens (${input_cost:.6f}) + "
            f"{output_tokens} output tokens (${output_cost:.6f}) = "
            f"${total_cost:.6f}"
        )
        
        return total_cost
    
    def get_models_for_tier(self, tier: str) -> List[Model]:
        return self.registry.get_by_tier(tier, enabled_only=True)
    
    def get_models_with_capability(self, capability: ModelCapability) -> List[Model]:
        return self.registry.get_by_capability(capability, enabled_only=True)
    
    def select_best_model(
        self,
        tier: str,
        required_capabilities: Optional[List[ModelCapability]] = None,
        min_context_window: Optional[int] = None,
        prefer_cheaper: bool = False
    ) -> Optional[Model]:
        models = self.get_models_for_tier(tier)
        
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
        models = self.get_models_for_tier(tier)
        
        recommended = [m for m in models if m.recommended]
        if recommended:
            recommended = sorted(recommended, key=lambda m: -m.priority)
            return recommended[0]
        
        if models:
            models = sorted(models, key=lambda m: -m.priority)
            return models[0]
        
        return None
    
    def get_context_window(self, model_id: str, default: int = 31_000) -> int:
        return self.registry.get_context_window(model_id, default)
    
    def check_token_limit(
        self,
        model_id: str,
        token_count: int,
        is_input: bool = True
    ) -> Tuple[bool, int]:
        model = self.get_model(model_id)
        if not model:
            return False, 0
        
        if is_input:
            max_allowed = model.context_window
        else:
            max_allowed = model.max_output_tokens or model.context_window
        
        return token_count <= max_allowed, max_allowed
    
    def format_model_info(self, model_id: str) -> Dict[str, Any]:
        model = self.get_model(model_id)
        if not model:
            return {"error": f"Model '{model_id}' not found"}
        
        return {
            "id": model.id,
            "name": model.name,
            "provider": model.provider.value,
            "context_window": model.context_window,
            "max_output_tokens": model.max_output_tokens,
            "capabilities": [cap.value for cap in model.capabilities],
            "pricing": {
                "input_per_million": model.pricing.input_cost_per_million_tokens,
                "output_per_million": model.pricing.output_cost_per_million_tokens,
            } if model.pricing else None,
            "enabled": model.enabled,
            "beta": model.beta,
            "tier_availability": model.tier_availability,
            "priority": model.priority,
            "recommended": model.recommended,
        }
    
    def list_available_models(
        self,
        tier: Optional[str] = None,
        include_disabled: bool = False
    ) -> List[Dict[str, Any]]:
        logger.debug(f"list_available_models called with tier='{tier}', include_disabled={include_disabled}")
        
        if tier:
            models = self.registry.get_by_tier(tier, enabled_only=not include_disabled)
            logger.debug(f"Found {len(models)} models for tier '{tier}'")
        else:
            models = self.registry.get_all(enabled_only=not include_disabled)
            logger.debug(f"Found {len(models)} total models")
        
        if models:
            model_names = [m.name for m in models]
            logger.debug(f"Models: {model_names}")
        else:
            logger.warning(f"No models found for tier '{tier}' - this might indicate a configuration issue")
        
        models = sorted(
            models,
            key=lambda m: (not m.is_free_tier, -m.priority, m.name)
        )
        
        return [self.format_model_info(m.id) for m in models]
    
    def get_legacy_constants(self) -> Dict:
        return self.registry.to_legacy_format()
    
    async def get_default_model_for_user(self, client, user_id: str) -> str:
        try:
            from core.utils.config import config, EnvMode
            if config.ENV_MODE == EnvMode.LOCAL:
                return DEFAULT_PREMIUM_MODEL
                
            from core.services.billing import get_user_subscription, SUBSCRIPTION_TIERS
            
            subscription = await get_user_subscription(user_id)
            
            is_paid_tier = False
            if subscription:
                price_id = None
                if subscription.get('items') and subscription['items'].get('data') and len(subscription['items']['data']) > 0:
                    price_id = subscription['items']['data'][0]['price']['id']
                else:
                    price_id = subscription.get('price_id')
                
                tier_info = SUBSCRIPTION_TIERS.get(price_id)
                if tier_info and tier_info['name'] != 'free':
                    is_paid_tier = True
            
            if is_paid_tier:
                logger.debug(f"Setting Claude Sonnet 4 as default for paid user {user_id}")
                return DEFAULT_PREMIUM_MODEL
            else:
                logger.debug(f"Setting Kimi K2 as default for free user {user_id}")
                return DEFAULT_FREE_MODEL
                
        except Exception as e:
            logger.warning(f"Failed to determine user tier for {user_id}: {e}")
            return DEFAULT_FREE_MODEL


model_manager = ModelManager() 