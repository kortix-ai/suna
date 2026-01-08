from .models import Model, ModelProvider, ModelCapability, ModelPricing, ModelConfig
from .registry import ModelRegistry, registry

# Backwards compatibility alias
model_manager = registry

__all__ = [
    'ModelRegistry',
    'registry',
    'Model',
    'ModelProvider',
    'ModelCapability',
    'ModelPricing',
    'ModelConfig',
    'model_manager',  # Backwards compatibility
]
