"""
Shared pytest fixtures for setup tests.
"""

import os
import tempfile
import shutil
from typing import Generator, Dict, Any

import pytest

from setup.config.schema import SetupConfig, SetupMethod


@pytest.fixture
def temp_dir() -> Generator[str, None, None]:
    """Create a temporary directory for tests."""
    temp = tempfile.mkdtemp()
    yield temp
    shutil.rmtree(temp, ignore_errors=True)


@pytest.fixture
def isolated_env(temp_dir: str) -> Generator[str, None, None]:
    """
    Create an isolated test environment with project structure.

    Creates:
    - backend/
    - apps/frontend/
    - apps/mobile/
    - README.md
    - docker-compose.yaml
    """
    # Create directory structure
    os.makedirs(os.path.join(temp_dir, "backend"))
    os.makedirs(os.path.join(temp_dir, "apps", "frontend"))
    os.makedirs(os.path.join(temp_dir, "apps", "mobile"))

    # Create required files
    with open(os.path.join(temp_dir, "README.md"), "w") as f:
        f.write("# Test Project\n")

    with open(os.path.join(temp_dir, "docker-compose.yaml"), "w") as f:
        f.write("version: '3'\nservices: {}\n")

    yield temp_dir


@pytest.fixture
def mock_config() -> SetupConfig:
    """Create a complete mock configuration."""
    config = SetupConfig(
        setup_method=SetupMethod.MANUAL,
    )

    # Supabase
    config.supabase.SUPABASE_URL = "https://test.supabase.co"
    config.supabase.SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test"
    config.supabase.SUPABASE_SERVICE_ROLE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.service"
    config.supabase.SUPABASE_JWT_SECRET = "test-jwt-secret-with-at-least-32-characters"
    config.supabase.DATABASE_URL = "postgresql://postgres:password@localhost:5432/postgres"

    # Daytona
    config.daytona.DAYTONA_API_KEY = "test-daytona-api-key"
    config.daytona.DAYTONA_SERVER_URL = "https://app.daytona.io/api"

    # LLM
    config.llm.OPENAI_API_KEY = "sk-test-openai-key-12345678"

    # Composio
    config.composio.COMPOSIO_API_KEY = "test-composio-api-key"

    # Kortix
    config.kortix.KORTIX_ADMIN_API_KEY = "test-admin-api-key"

    return config


@pytest.fixture
def mock_env_vars() -> Dict[str, str]:
    """Create mock environment variables."""
    return {
        "SUPABASE_URL": "https://test.supabase.co",
        "SUPABASE_ANON_KEY": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test",
        "SUPABASE_SERVICE_ROLE_KEY": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.service",
        "OPENAI_API_KEY": "sk-test-openai-key",
        "DAYTONA_API_KEY": "test-daytona-key",
    }
