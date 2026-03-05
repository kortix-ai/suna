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
        admin_api_key=os.getenv("KORTIX_ADMIN_API_KEY", ""),
    )


def _generate_random_yopmail() -> str:
    """Generate a random yopmail email address"""
    random_part = ''.join(secrets.choice(string.ascii_lowercase + string.digits) for _ in range(secrets.randbelow(5) + 8))
    return f"{random_part}@yopmail.com"


# Module-level cache for test user info
_cached_test_user: Dict[str, str] | None = None


def _generate_random_test_user() -> Dict[str, str]:
    """Generate a mock test user - tests can now use Convex client for user operations."""
    global _cached_test_user

    if _cached_test_user:
        logger.debug(f"Using cached test user: {_cached_test_user['email']}")
        return _cached_test_user

    # Generate mock test data (no actual DB operations)
    TEST_USER_EMAIL = _generate_random_yopmail()
    TEST_USER_ID = f"test_user_{secrets.token_hex(8)}"

    _cached_test_user = {
        "user_id": TEST_USER_ID,
        "email": TEST_USER_EMAIL,
    }

    logger.info(f"✅ Created mock test user: {TEST_USER_EMAIL} (ID: {TEST_USER_ID})")

    return _cached_test_user


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
    """Generate JWT token for test user

    MIGRATED: Test fixtures use Convex client for JWT token generation
    """
    # For now, return a mock token
    import hashlib
    mock_token = hashlib.sha256(f"{test_user['user_id']}:{test_user['email']}".encode()).hexdigest()
    return f"mock_convex_token_{mock_token[:32]}"


@pytest.fixture
async def client(test_config: E2ETestConfig, auth_token: str) -> AsyncGenerator[httpx.AsyncClient, None]:
    """Authenticated HTTP client for API requests"""
    async with httpx.AsyncClient(
        base_url=test_config.base_url,
        headers={"Authorization": f"Bearer {auth_token}"},
        timeout=test_config.request_timeout,
        follow_redirects=True,
    ) as client:
        yield client
