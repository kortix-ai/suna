"""
Test configuration for E2E API tests
"""
from dataclasses import dataclass
import os


@dataclass
class E2ETestConfig:
    """Configuration for E2E API tests"""
    base_url: str = os.getenv("TEST_API_URL", "http://localhost:8000/v1")
    supabase_url: str = os.getenv("SUPABASE_URL", "")
    supabase_anon_key: str = os.getenv("SUPABASE_ANON_KEY", "")
    supabase_jwt_secret: str = os.getenv("SUPABASE_JWT_SECRET", "")
    admin_api_key: str = os.getenv("KORTIX_ADMIN_API_KEY", "")
    test_user_password: str = os.getenv("TEST_USER_PASSWORD", "test_password_e2e_12345")
    request_timeout: float = float(os.getenv("TEST_REQUEST_TIMEOUT", "30.0"))
    agent_timeout: float = float(os.getenv("TEST_AGENT_TIMEOUT", "120.0"))

