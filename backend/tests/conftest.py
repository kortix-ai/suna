"""
Shared pytest fixtures for E2E API tests

This file is intentionally standalone - it does NOT import from the backend
to keep E2E test dependencies minimal.
"""
import os
import secrets
import string
import logging

from dotenv import load_dotenv
load_dotenv()

import pytest
import httpx
import jwt
from datetime import datetime, timezone, timedelta
from typing import AsyncGenerator, Dict

from tests.config import E2ETestConfig

# Simple logging setup
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("e2e_tests")


# Register custom markers
def pytest_configure(config):
    config.addinivalue_line("markers", "e2e: End-to-end tests")
    config.addinivalue_line("markers", "slow: Slow tests (streaming, long runs)")
    config.addinivalue_line("markers", "billing: Tests requiring billing/credits")


@pytest.fixture(scope="session")
def test_config() -> E2ETestConfig:
    """Test configuration fixture - reads from environment variables"""
    return E2ETestConfig(
        base_url=os.getenv("TEST_API_URL", "http://localhost:8000/v1"),
        supabase_url=os.getenv("SUPABASE_URL", ""),
        supabase_anon_key=os.getenv("SUPABASE_ANON_KEY", ""),
        supabase_jwt_secret=os.getenv("SUPABASE_JWT_SECRET", ""),
        admin_api_key=os.getenv("KORTIX_ADMIN_API_KEY", ""),
    )


def _generate_random_yopmail() -> str:
    """Generate a random yopmail email address"""
    random_part = ''.join(secrets.choice(string.ascii_lowercase + string.digits) for _ in range(secrets.randbelow(5) + 8))
    return f"{random_part}@yopmail.com"


# Module-level cache for test user info
_cached_test_user: Dict[str, str] | None = None


async def _ensure_test_user_exists(test_config: E2ETestConfig) -> Dict[str, str]:
    """
    Create a test user via Supabase Admin API.

    Account initialization happens automatically when the user first
    hits an API endpoint (handled by the API server).
    """
    global _cached_test_user

    if _cached_test_user:
        logger.debug(f"Using cached test user: {_cached_test_user['email']}")
        return _cached_test_user

    from supabase import create_client, Client

    supabase_url = os.getenv("SUPABASE_URL")
    supabase_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")

    if not supabase_url or not supabase_key:
        raise ValueError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required for test user setup")

    client: Client = create_client(supabase_url, supabase_key)

    TEST_USER_EMAIL = _generate_random_yopmail()
    logger.info(f"Creating test user: {TEST_USER_EMAIL}")

    try:
        user_response = client.auth.admin.create_user({
            'email': TEST_USER_EMAIL,
            'password': test_config.test_user_password,
            'email_confirm': True,
            'user_metadata': {
                'test_user': True,
                'created_by': 'e2e_api_tests',
            }
        })

        user_id = user_response.user.id
        _cached_test_user = {
            "user_id": user_id,
            "email": TEST_USER_EMAIL
        }

        logger.info(f"✅ Created test user: {TEST_USER_EMAIL} (ID: {user_id})")

        # Create profile (some APIs may require this)
        try:
            client.table('profiles').insert({
                'user_id': user_id,
                'email': TEST_USER_EMAIL,
                'full_name': 'E2E Test User',
            }).execute()
        except Exception:
            pass  # Profile might be auto-created by trigger

        # Account initialization happens automatically when user hits API
        # No need to call initialize_user_account here

        return _cached_test_user

    except Exception as e:
        if "already been registered" in str(e):
            # Retry with new email
            TEST_USER_EMAIL = _generate_random_yopmail()
            user_response = client.auth.admin.create_user({
                'email': TEST_USER_EMAIL,
                'password': test_config.test_user_password,
                'email_confirm': True,
                'user_metadata': {'test_user': True}
            })
            user_id = user_response.user.id
            _cached_test_user = {"user_id": user_id, "email": TEST_USER_EMAIL}
            return _cached_test_user

        raise ValueError(f"Could not create test user: {e}")


@pytest.fixture(scope="function")
async def test_user(test_config: E2ETestConfig) -> Dict[str, str]:
    """Get or create a test user"""
    user_info = await _ensure_test_user_exists(test_config)

    print(f"\n{'='*60}")
    print(f"🧪 TEST USER: {user_info['email']}")
    print(f"{'='*60}\n")

    return user_info


@pytest.fixture
async def auth_token(test_user: Dict[str, str], test_config: E2ETestConfig) -> str:
    """Generate JWT token for test user"""
    jwt_secret = test_config.supabase_jwt_secret or os.getenv("SUPABASE_JWT_SECRET")

    if not jwt_secret:
        raise ValueError("SUPABASE_JWT_SECRET not configured")

    payload = {
        'sub': test_user["user_id"],
        'aud': 'authenticated',
        'role': 'authenticated',
        'iat': datetime.now(timezone.utc).timestamp(),
        'exp': (datetime.now(timezone.utc) + timedelta(hours=1)).timestamp(),
    }

    return jwt.encode(payload, jwt_secret, algorithm='HS256')


@pytest.fixture
async def client(test_config: E2ETestConfig, auth_token: str) -> AsyncGenerator[httpx.AsyncClient, None]:
    """Authenticated HTTP client for API requests"""
    async with httpx.AsyncClient(
        base_url=test_config.base_url,
        headers={"Authorization": f"Bearer {auth_token}"},
        timeout=test_config.request_timeout,
        follow_redirects=True
    ) as client:
        yield client
