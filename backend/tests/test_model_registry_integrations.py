import pytest

from core.ai_models import model_manager, ModelProvider
from core.ai_models.registry import FREE_MODEL_ID, PREMIUM_MODEL_ID, registry


REQUIRED_PROVIDERS = [
    ModelProvider.OPENAI,
    ModelProvider.GOOGLE,
    ModelProvider.GROQ,
    ModelProvider.DEEPSEEK,
    ModelProvider.ANTHROPIC,
]


@pytest.mark.unit
def test_registry_includes_required_providers():
    for provider in REQUIRED_PROVIDERS:
        models = model_manager.registry.get_by_provider(provider, enabled_only=True)
        assert models, f"Expected models for provider '{provider.value}'"


@pytest.mark.unit
def test_default_model_ids_are_registered():
    assert registry.get(FREE_MODEL_ID) is not None, "Free tier default model should be registered"
    assert registry.get(PREMIUM_MODEL_ID) is not None, "Premium tier default model should be registered"


@pytest.mark.unit
def test_bedrock_provider_is_optional():
    bedrock_models = model_manager.registry.get_by_provider(ModelProvider.BEDROCK, enabled_only=True)

    if not bedrock_models:
        pytest.skip("Bedrock credentials not provided; provider is correctly optional")

    assert all(model.provider == ModelProvider.BEDROCK for model in bedrock_models)
