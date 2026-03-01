"""
Test configuration for E2E API tests

MIGRATED: Uses Convex client for backend operations - see conftest.py for fixtures
"""
from dataclasses import dataclass
import os


@dataclass
class E2ETestConfig:
    """Configuration for E2E API tests"""
    base_url: str = os.getenv("TEST_API_URL", "http://localhost:8000/v1")
    # Convex configuration (optional - tests use mock-based approach by default)
    convex_url: str = os.getenv("CONVEX_URL", "https://disciplined-tiger-449.convex.site")
    convex_api_key: str = os.getenv("CONVEX_API_KEY", "dev_suna_api_key_2024")
    admin_api_key: str = os.getenv("KORTIX_ADMIN_API_KEY", "")
    test_user_password: str = os.getenv("TEST_USER_PASSWORD", "test_password_e2e_12345")
    request_timeout: float = float(os.getenv("TEST_REQUEST_TIMEOUT", "30.0"))
    agent_timeout: float = float(os.getenv("TEST_AGENT_TIMEOUT", "120.0"))

