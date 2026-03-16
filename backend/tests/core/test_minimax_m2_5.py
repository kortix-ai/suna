"""
Unit tests for MiniMax M2.5 model registration and configuration.
Tests model registry, provider detection, pricing, and LiteLLM parameter generation.
"""

import os
import sys
import logging
import pytest

# Add backend to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

# Set minimal required env vars before importing config
os.environ.setdefault("SUPABASE_URL", "http://localhost:54321")
os.environ.setdefault("SUPABASE_ANON_KEY", "test-anon-key")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key")
os.environ.setdefault("SUPABASE_JWT_SECRET", "test-jwt-secret")
os.environ.setdefault("ENV_MODE", "local")

# Polyfill for Python <3.11 (getLevelNamesMapping added in 3.11)
if not hasattr(logging, 'getLevelNamesMapping'):
    logging.getLevelNamesMapping = lambda: {
        'CRITICAL': logging.CRITICAL,
        'ERROR': logging.ERROR,
        'WARNING': logging.WARNING,
        'INFO': logging.INFO,
        'DEBUG': logging.DEBUG,
        'NOTSET': logging.NOTSET,
    }

from core.ai_models.models import ModelProvider, ModelCapability
from core.ai_models.registry import (
    ModelFactory,
    ModelRegistry,
    PricingPresets,
    registry,
)
from core.ai_models.providers.minimax import MiniMaxProvider
from core.ai_models.providers.provider_registry import get_provider_for_model


class TestMiniMaxM25Model:
    """Tests for the MiniMax M2.5 model definition."""

    def test_create_minimax_m2_5_openrouter(self):
        model = ModelFactory.create_minimax_m2_5(use_openrouter=True)
        assert model.id == "kortix/minimax-m2.5"
        assert model.name == "MiniMax M2.5"
        assert model.litellm_model_id == "openrouter/minimax/minimax-m2.5"
        assert model.provider == ModelProvider.OPENROUTER

    def test_create_minimax_m2_5_direct(self):
        model = ModelFactory.create_minimax_m2_5(use_openrouter=False)
        assert model.id == "kortix/minimax-m2.5"
        assert model.litellm_model_id == "minimax/MiniMax-M2.5"
        assert model.provider == ModelProvider.MINIMAX

    def test_minimax_m2_5_context_window(self):
        model = ModelFactory.create_minimax_m2_5()
        assert model.context_window == 196_608

    def test_minimax_m2_5_capabilities(self):
        model = ModelFactory.create_minimax_m2_5()
        assert ModelCapability.CHAT in model.capabilities
        assert ModelCapability.FUNCTION_CALLING in model.capabilities
        assert ModelCapability.THINKING in model.capabilities
        assert ModelCapability.PROMPT_CACHING in model.capabilities

    def test_minimax_m2_5_tier_availability(self):
        model = ModelFactory.create_minimax_m2_5()
        assert "free" in model.tier_availability
        assert "paid" in model.tier_availability

    def test_minimax_m2_5_aliases(self):
        model = ModelFactory.create_minimax_m2_5()
        assert "minimax-m2.5" in model.aliases
        assert "minimax-m2-5" in model.aliases
        assert "MiniMax-M2.5" in model.aliases

    def test_minimax_m2_5_reasoning_config(self):
        model = ModelFactory.create_minimax_m2_5()
        assert model.config is not None
        assert model.config.reasoning is not None
        assert model.config.reasoning.enabled is True
        assert model.config.reasoning.split_output is True


class TestMiniMaxM25Pricing:
    """Tests for the MiniMax M2.5 pricing preset."""

    def test_pricing_preset_exists(self):
        assert hasattr(PricingPresets, "MINIMAX_M2_5")

    def test_pricing_values(self):
        pricing = PricingPresets.MINIMAX_M2_5
        assert pricing.input_cost_per_million_tokens == 0.25
        assert pricing.output_cost_per_million_tokens == 1.20
        assert pricing.cached_read_cost_per_million_tokens == 0.025

    def test_pricing_per_token(self):
        pricing = PricingPresets.MINIMAX_M2_5
        assert pricing.input_cost_per_token == 0.25 / 1_000_000
        assert pricing.output_cost_per_token == 1.20 / 1_000_000

    def test_m2_5_cheaper_input_than_m2(self):
        assert PricingPresets.MINIMAX_M2_5.input_cost_per_million_tokens < PricingPresets.MINIMAX_M2.input_cost_per_million_tokens


class TestMiniMaxM25Registry:
    """Tests for M2.5 model in the global registry."""

    def test_m2_5_registered(self):
        model = registry.get("kortix/minimax-m2.5")
        assert model is not None
        assert model.name == "MiniMax M2.5"

    def test_m2_5_alias_resolution(self):
        model = registry.get("minimax-m2.5")
        assert model is not None
        assert model.id == "kortix/minimax-m2.5"

    def test_m2_1_still_registered(self):
        model = registry.get("kortix/minimax")
        assert model is not None
        assert model.name == "MiniMax M2.1"

    def test_m2_5_litellm_model_id(self):
        litellm_id = registry.get_litellm_model_id("kortix/minimax-m2.5")
        assert litellm_id == "openrouter/minimax/minimax-m2.5"

    def test_m2_5_pricing_lookup(self):
        pricing = registry.get_pricing("kortix/minimax-m2.5")
        assert pricing is not None
        assert pricing.input_cost_per_million_tokens == 0.25

    def test_m2_5_pricing_from_litellm_id(self):
        pricing = registry.get_pricing_for_litellm_id("openrouter/minimax/minimax-m2.5")
        assert pricing is not None
        assert pricing.input_cost_per_million_tokens == 0.25

    def test_m2_5_pricing_from_direct_litellm_id(self):
        pricing = registry.get_pricing_for_litellm_id("minimax/MiniMax-M2.5")
        assert pricing is not None
        assert pricing.input_cost_per_million_tokens == 0.25


class TestMiniMaxM25Provider:
    """Tests for provider detection with M2.5 models."""

    def test_provider_detected_openrouter(self):
        provider = get_provider_for_model("openrouter/minimax/minimax-m2.5")
        assert provider is not None
        assert provider.name == "openrouter"

    def test_provider_detected_direct(self):
        provider = get_provider_for_model("minimax/MiniMax-M2.5")
        assert provider is not None
        assert provider.name == "minimax"

    def test_provider_default_model_id(self):
        p = MiniMaxProvider(use_openrouter=True)
        assert p.get_model_id() == "openrouter/minimax/minimax-m2.5"

    def test_provider_custom_model_id(self):
        p = MiniMaxProvider(use_openrouter=True)
        assert p.get_model_id("minimax-m2.1") == "openrouter/minimax/minimax-m2.1"

    def test_provider_direct_default_model_id(self):
        p = MiniMaxProvider(use_openrouter=False)
        assert p.get_model_id() == "minimax/minimax-m2.5"


class TestMiniMaxM25LiteLLMParams:
    """Tests for LiteLLM parameter generation with M2.5."""

    def test_litellm_params_model(self):
        params = registry.get_litellm_params("kortix/minimax-m2.5")
        assert params["model"] == "openrouter/minimax/minimax-m2.5"

    def test_litellm_params_reasoning(self):
        params = registry.get_litellm_params("kortix/minimax-m2.5")
        assert "reasoning" in params
        assert params["reasoning"]["enabled"] is True

    def test_litellm_params_reasoning_split(self):
        params = registry.get_litellm_params("kortix/minimax-m2.5")
        assert params.get("reasoning_split") is True


class TestMiniMaxBasicPowerDefaults:
    """Tests that basic/power models default to M2.5 when minimax is selected."""

    def test_basic_model_minimax_uses_m2_5(self):
        model = ModelFactory.create_basic_model("minimax")
        assert "minimax-m2.5" in model.litellm_model_id

    def test_power_model_minimax_uses_m2_5(self):
        model = ModelFactory.create_power_model("minimax")
        assert "minimax-m2.5" in model.litellm_model_id

    def test_basic_model_minimax_pricing(self):
        model = ModelFactory.create_basic_model("minimax")
        assert model.pricing == PricingPresets.MINIMAX_M2_5

    def test_power_model_minimax_pricing(self):
        model = ModelFactory.create_power_model("minimax")
        assert model.pricing == PricingPresets.MINIMAX_M2_5

    def test_basic_model_minimax_context(self):
        model = ModelFactory.create_basic_model("minimax")
        assert model.context_window == 196_608
