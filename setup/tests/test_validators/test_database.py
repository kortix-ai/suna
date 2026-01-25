"""
Tests for database URL validators.
"""

import pytest
from setup.validators.database import (
    validate_database_url,
    normalize_database_url,
    construct_database_url,
    parse_database_url,
    mask_database_url,
)


class TestValidateDatabaseUrl:
    """Tests for validate_database_url function."""

    def test_valid_postgresql_url(self):
        is_valid, error = validate_database_url(
            "postgresql://user:pass@localhost:5432/mydb"
        )
        assert is_valid is True
        assert error is None

    def test_valid_postgres_url(self):
        is_valid, error = validate_database_url(
            "postgres://user:pass@localhost:5432/mydb"
        )
        assert is_valid is True
        assert error is None

    def test_invalid_scheme(self):
        is_valid, error = validate_database_url(
            "mysql://user:pass@localhost:5432/mydb"
        )
        assert is_valid is False
        assert "postgresql://" in error or "postgres://" in error

    def test_missing_database_name(self):
        is_valid, error = validate_database_url(
            "postgresql://user:pass@localhost:5432/"
        )
        assert is_valid is False
        assert "database name" in error.lower()

    def test_empty_url_not_allowed(self):
        is_valid, error = validate_database_url("")
        assert is_valid is False
        assert error is not None

    def test_empty_url_allowed(self):
        is_valid, error = validate_database_url("", allow_empty=True)
        assert is_valid is True
        assert error is None


class TestNormalizeDatabaseUrl:
    """Tests for normalize_database_url function."""

    def test_convert_postgres_to_postgresql(self):
        url = normalize_database_url("postgres://user:pass@localhost:5432/mydb")
        assert url.startswith("postgresql://")

    def test_url_encode_password(self):
        url = normalize_database_url("postgresql://user:p@ss@localhost:5432/mydb")
        assert "p%40ss" in url  # @ should be encoded as %40

    def test_handle_double_encoded_password(self):
        url = normalize_database_url("postgresql://user:p%2540ss@localhost:5432/mydb")
        # Should decode %25 (encoded %) back to single encoding
        assert "%40" in url

    def test_preserve_url_without_password(self):
        original = "postgresql://user@localhost:5432/mydb"
        url = normalize_database_url(original)
        assert url == original


class TestConstructDatabaseUrl:
    """Tests for construct_database_url function."""

    def test_construct_basic_url(self):
        url = construct_database_url(
            project_ref="test123",
            password="mypassword",
            host="localhost",
            port=5432,
            dbname="postgres",
        )
        assert url == "postgresql://postgres:mypassword@localhost:5432/postgres"

    def test_construct_pooler_url(self):
        url = construct_database_url(
            project_ref="test123",
            password="mypassword",
            host="pooler.supabase.com",
            port=6543,
            dbname="postgres",
            use_pooler=True,
        )
        assert url == "postgresql://postgres.test123:mypassword@pooler.supabase.com:6543/postgres"

    def test_construct_url_with_special_chars(self):
        url = construct_database_url(
            project_ref="test123",
            password="p@ss:word/",
            host="localhost",
            port=5432,
            dbname="postgres",
        )
        # Special characters should be URL encoded
        assert "p%40ss%3Aword%2F" in url


class TestParseDatabaseUrl:
    """Tests for parse_database_url function."""

    def test_parse_full_url(self):
        result = parse_database_url("postgresql://user:pass@localhost:5432/mydb")
        assert result is not None
        assert result["scheme"] == "postgresql"
        assert result["username"] == "user"
        assert result["password"] == "pass"
        assert result["hostname"] == "localhost"
        assert result["port"] == 5432
        assert result["database"] == "mydb"

    def test_parse_invalid_url(self):
        result = parse_database_url("not-a-url")
        # Should return None or empty dict for invalid URLs
        assert result is None or result.get("hostname") is None


class TestMaskDatabaseUrl:
    """Tests for mask_database_url function."""

    def test_mask_password(self):
        url = mask_database_url("postgresql://user:secretpassword@localhost:5432/mydb")
        assert "secretpassword" not in url
        assert "***" in url

    def test_mask_url_without_password(self):
        url = "postgresql://user@localhost:5432/mydb"
        masked = mask_database_url(url)
        assert masked == url
