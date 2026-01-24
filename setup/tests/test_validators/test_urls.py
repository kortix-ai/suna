"""
Tests for URL validators.
"""

import pytest
from setup.validators.urls import (
    validate_url,
    validate_supabase_url,
    extract_supabase_project_ref,
    validate_webhook_url,
)


class TestValidateUrl:
    """Tests for validate_url function."""

    def test_valid_https_url(self):
        is_valid, error = validate_url("https://example.com")
        assert is_valid is True
        assert error is None

    def test_valid_http_url(self):
        is_valid, error = validate_url("http://example.com")
        assert is_valid is True
        assert error is None

    def test_valid_url_with_path(self):
        is_valid, error = validate_url("https://example.com/path/to/resource")
        assert is_valid is True
        assert error is None

    def test_valid_url_with_port(self):
        is_valid, error = validate_url("https://example.com:8080")
        assert is_valid is True
        assert error is None

    def test_valid_localhost_url(self):
        is_valid, error = validate_url("http://localhost:3000")
        assert is_valid is True
        assert error is None

    def test_valid_ip_url(self):
        is_valid, error = validate_url("http://192.168.1.1:8080")
        assert is_valid is True
        assert error is None

    def test_invalid_url_no_scheme(self):
        is_valid, error = validate_url("example.com")
        assert is_valid is False
        assert error is not None

    def test_invalid_url_wrong_scheme(self):
        is_valid, error = validate_url("ftp://example.com")
        assert is_valid is False
        assert error is not None

    def test_empty_url_not_allowed(self):
        is_valid, error = validate_url("")
        assert is_valid is False
        assert error is not None

    def test_empty_url_allowed(self):
        is_valid, error = validate_url("", allow_empty=True)
        assert is_valid is True
        assert error is None


class TestValidateSupabaseUrl:
    """Tests for validate_supabase_url function."""

    def test_valid_supabase_url(self):
        is_valid, error = validate_supabase_url("https://abcdef.supabase.co")
        assert is_valid is True
        assert error is None

    def test_invalid_supabase_url_wrong_domain(self):
        is_valid, error = validate_supabase_url("https://example.com")
        assert is_valid is False
        assert error is not None


class TestExtractSupabaseProjectRef:
    """Tests for extract_supabase_project_ref function."""

    def test_extract_project_ref(self):
        ref = extract_supabase_project_ref("https://abcdefgh.supabase.co")
        assert ref == "abcdefgh"

    def test_extract_project_ref_invalid_url(self):
        ref = extract_supabase_project_ref("https://example.com")
        assert ref is None


class TestValidateWebhookUrl:
    """Tests for validate_webhook_url function."""

    def test_valid_webhook_url(self):
        is_valid, error = validate_webhook_url("https://webhook.example.com")
        assert is_valid is True
        assert error is None

    def test_localhost_not_allowed(self):
        is_valid, error = validate_webhook_url("http://localhost:8000")
        assert is_valid is False
        assert "publicly accessible" in error.lower()

    def test_empty_allowed(self):
        is_valid, error = validate_webhook_url("", allow_empty=True)
        assert is_valid is True
        assert error is None
