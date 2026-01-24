"""
Tests for configuration schema.
"""

import pytest
from setup.config.schema import (
    SetupMethod,
    SupabaseConfig,
    DaytonaConfig,
    LLMConfig,
    SearchConfig,
    ComposioConfig,
    SetupConfig,
)


class TestSetupMethod:
    """Tests for SetupMethod enum."""

    def test_docker_method(self):
        assert SetupMethod.DOCKER.value == "docker"

    def test_manual_method(self):
        assert SetupMethod.MANUAL.value == "manual"


class TestSupabaseConfig:
    """Tests for SupabaseConfig model."""

    def test_default_values(self):
        config = SupabaseConfig()
        assert config.SUPABASE_URL == ""
        assert config.SUPABASE_ANON_KEY == ""

    def test_is_complete_with_all_fields(self):
        config = SupabaseConfig(
            SUPABASE_URL="https://test.supabase.co",
            SUPABASE_ANON_KEY="test-anon-key-12345",
            SUPABASE_SERVICE_ROLE_KEY="test-service-key-12345",
            SUPABASE_JWT_SECRET="test-jwt-secret-12345",
        )
        assert config.is_complete() is True

    def test_is_complete_with_missing_fields(self):
        config = SupabaseConfig(
            SUPABASE_URL="https://test.supabase.co",
        )
        assert config.is_complete() is False

    def test_url_validation(self):
        # Valid URL
        config = SupabaseConfig(SUPABASE_URL="https://test.supabase.co")
        assert config.SUPABASE_URL == "https://test.supabase.co"

        # Invalid URL should raise validation error
        with pytest.raises(ValueError):
            SupabaseConfig(SUPABASE_URL="not-a-url")


class TestDaytonaConfig:
    """Tests for DaytonaConfig model."""

    def test_default_values(self):
        config = DaytonaConfig()
        assert config.DAYTONA_SERVER_URL == "https://app.daytona.io/api"
        assert config.DAYTONA_TARGET == "us"

    def test_is_complete(self):
        config = DaytonaConfig(DAYTONA_API_KEY="test-key")
        assert config.is_complete() is True

        config = DaytonaConfig()
        assert config.is_complete() is False


class TestLLMConfig:
    """Tests for LLMConfig model."""

    def test_get_configured_providers_empty(self):
        config = LLMConfig()
        assert config.get_configured_providers() == []

    def test_get_configured_providers(self):
        config = LLMConfig(
            OPENAI_API_KEY="sk-test",
            ANTHROPIC_API_KEY="sk-ant-test",
        )
        providers = config.get_configured_providers()
        assert "OpenAI" in providers
        assert "Anthropic" in providers

    def test_has_required_keys(self):
        config = LLMConfig()
        assert config.has_required_keys() is False

        # Default MAIN_LLM is "anthropic", so need ANTHROPIC_API_KEY
        config = LLMConfig(ANTHROPIC_API_KEY="sk-ant-test")
        assert config.has_required_keys() is True


class TestSearchConfig:
    """Tests for SearchConfig model."""

    def test_default_firecrawl_url(self):
        config = SearchConfig()
        assert config.FIRECRAWL_URL == "https://api.firecrawl.dev"

    def test_get_configured_tools(self):
        config = SearchConfig(
            TAVILY_API_KEY="test-key",
            FIRECRAWL_API_KEY="test-key",
        )
        tools = config.get_configured_tools()
        assert "Tavily" in tools
        assert "Firecrawl" in tools


class TestSetupConfig:
    """Tests for SetupConfig model."""

    def test_default_values(self):
        config = SetupConfig()
        assert config.setup_method is None
        assert config.supabase is not None
        assert config.daytona is not None

    def test_is_setup_complete(self):
        config = SetupConfig()
        assert config.is_setup_complete() is False

    def test_get_missing_required(self):
        config = SetupConfig()
        missing = config.get_missing_required()
        assert "SUPABASE_URL" in missing
        assert "DAYTONA_API_KEY" in missing
        assert "COMPOSIO_API_KEY" in missing
        # Default MAIN_LLM is "anthropic"
        assert "ANTHROPIC_API_KEY" in missing

    def test_to_flat_dict(self):
        config = SetupConfig(setup_method=SetupMethod.DOCKER)
        flat = config.to_flat_dict()
        assert "setup_method" in flat
        assert flat["setup_method"] == "docker"
