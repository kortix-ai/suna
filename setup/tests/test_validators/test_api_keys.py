"""
Tests for API key validators.
"""

import pytest
from setup.validators.api_keys import (
    validate_api_key,
    validate_openai_key,
    validate_anthropic_key,
    validate_supabase_key,
    validate_jwt_secret,
    get_key_prefix,
)


class TestValidateApiKey:
    """Tests for validate_api_key function."""

    def test_valid_api_key(self):
        is_valid, error = validate_api_key("sk-1234567890abcdefghij")
        assert is_valid is True
        assert error is None

    def test_api_key_too_short(self):
        is_valid, error = validate_api_key("short")
        assert is_valid is False
        assert "10 characters" in error

    def test_empty_api_key_not_allowed(self):
        is_valid, error = validate_api_key("")
        assert is_valid is False
        assert error is not None

    def test_empty_api_key_allowed(self):
        is_valid, error = validate_api_key("", allow_empty=True)
        assert is_valid is True
        assert error is None

    def test_custom_min_length(self):
        is_valid, error = validate_api_key("12345", min_length=5)
        assert is_valid is True
        assert error is None


class TestValidateOpenaiKey:
    """Tests for validate_openai_key function."""

    def test_valid_openai_key(self):
        is_valid, error = validate_openai_key("sk-" + "a" * 48)
        assert is_valid is True
        assert error is None

    def test_invalid_openai_key_wrong_prefix(self):
        is_valid, error = validate_openai_key("abc-" + "a" * 48)
        assert is_valid is False
        assert "sk-" in error

    def test_invalid_openai_key_too_short(self):
        is_valid, error = validate_openai_key("sk-short")
        assert is_valid is False
        assert "too short" in error.lower()


class TestValidateAnthropicKey:
    """Tests for validate_anthropic_key function."""

    def test_valid_anthropic_key(self):
        is_valid, error = validate_anthropic_key("sk-ant-" + "a" * 48)
        assert is_valid is True
        assert error is None

    def test_invalid_anthropic_key_wrong_prefix(self):
        is_valid, error = validate_anthropic_key("sk-" + "a" * 48)
        assert is_valid is False
        assert "sk-ant-" in error


class TestValidateSupabaseKey:
    """Tests for validate_supabase_key function."""

    def test_valid_supabase_key(self):
        is_valid, error = validate_supabase_key("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test.sig")
        assert is_valid is True
        assert error is None

    def test_invalid_supabase_key_not_jwt(self):
        is_valid, error = validate_supabase_key("not-a-jwt-token")
        assert is_valid is False
        assert "JWT" in error


class TestValidateJwtSecret:
    """Tests for validate_jwt_secret function."""

    def test_valid_jwt_secret(self):
        is_valid, error = validate_jwt_secret("a" * 32)
        assert is_valid is True
        assert error is None

    def test_jwt_secret_too_short(self):
        is_valid, error = validate_jwt_secret("short")
        assert is_valid is False
        assert "32 characters" in error


class TestGetKeyPrefix:
    """Tests for get_key_prefix function."""

    def test_get_prefix(self):
        prefix = get_key_prefix("sk-1234567890abcdefghij")
        assert prefix == "sk-12345..."

    def test_short_key(self):
        prefix = get_key_prefix("short")
        assert prefix == "short"

    def test_empty_key(self):
        prefix = get_key_prefix("")
        assert prefix == ""
