"""
Shared pytest fixtures for E2E API tests
"""
import sys
import os
import secrets
import string

# Add backend to path FIRST
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Load .env file before any other imports that depend on env vars
from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), '.env'))

import pytest
import httpx
import jwt
from datetime import datetime, timezone, timedelta
from typing import AsyncGenerator, Dict

from tests.config import E2ETestConfig
from core.utils.config import config
from core.utils.logger import logger


# Register custom markers
def pytest_configure(config):
    config.addinivalue_line("markers", "e2e: End-to-end tests")
    config.addinivalue_line("markers", "slow: Slow tests (streaming, long runs)")
    config.addinivalue_line("markers", "billing: Tests requiring billing/credits")


@pytest.fixture(scope="session")
def test_config() -> E2ETestConfig:
    """Test configuration fixture - uses values from core.utils.config"""
    return E2ETestConfig(
        base_url=os.getenv("TEST_API_URL", "http://localhost:8000/v1"),
        supabase_url=config.SUPABASE_URL or "",
        supabase_anon_key=config.SUPABASE_ANON_KEY or "",
        supabase_jwt_secret=config.SUPABASE_JWT_SECRET or "",
        admin_api_key=config.KORTIX_ADMIN_API_KEY or "",
    )


def _generate_random_yopmail() -> str:
    """Generate a random yopmail email address"""
    # Generate random string: 8-12 alphanumeric characters
    random_part = ''.join(secrets.choice(string.ascii_lowercase + string.digits) for _ in range(secrets.randbelow(5) + 8))
    return f"{random_part}@yopmail.com"


# Module-level cache for test user info to avoid repeated Supabase queries
_cached_test_user: Dict[str, str] | None = None  # {"user_id": "...", "email": "..."}


async def _ensure_test_user_exists(test_config: E2ETestConfig) -> Dict[str, str]:
    """
    Create a fresh verified test user with random yopmail email.
    Uses a fresh Supabase client to avoid event loop issues.
    
    Returns:
        dict with "user_id" and "email" keys
    
    The user is created with:
    - Random yopmail email (e.g., "abc123xyz@yopmail.com")
    - email_confirm: True (verified email, no magic link needed)
    - A password for direct auth if needed
    """
    global _cached_test_user
    
    # Return cached user if available
    if _cached_test_user:
        logger.debug(f"Using cached test user: {_cached_test_user['email']} (ID: {_cached_test_user['user_id']})")
        return _cached_test_user
    
    # Use synchronous Supabase client to avoid event loop issues
    from supabase import create_client, Client
    
    supabase_url = config.SUPABASE_URL
    supabase_key = config.SUPABASE_SERVICE_ROLE_KEY
    
    if not supabase_url or not supabase_key:
        raise ValueError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required for test user setup")
    
    # Create sync client
    client: Client = create_client(supabase_url, supabase_key)
    
    # Generate random yopmail email
    TEST_USER_EMAIL = _generate_random_yopmail()
    logger.info(f"Generated random yopmail: {TEST_USER_EMAIL}")
    
    try:
        # Create new verified test user with random email
        logger.info(f"Creating verified test user: {TEST_USER_EMAIL}")
        
        user_response = client.auth.admin.create_user({
            'email': TEST_USER_EMAIL,
            'password': test_config.test_user_password,
            'email_confirm': True,  # This marks email as verified - no magic link needed
            'user_metadata': {
                'test_user': True,
                'created_by': 'e2e_api_tests',
                'yopmail': True
            }
        })
        
        user_id = user_response.user.id
        _cached_test_user = {
            "user_id": user_id,
            "email": TEST_USER_EMAIL
        }
        
        logger.info(f"✅ Created verified test user: {TEST_USER_EMAIL} (ID: {user_id})")
        
        # Create profile (some APIs may require this)
        try:
            client.table('profiles').insert({
                'user_id': user_id,
                'email': TEST_USER_EMAIL,
                'full_name': 'E2E Test User',
            }).execute()
            logger.debug("Created profile for test user")
        except Exception as profile_error:
            # Profile might be auto-created by trigger or already exist
            logger.debug(f"Profile creation skipped: {profile_error}")
        
        # Initialize account (set up tier and credits)
        try:
            from core.setup.api import initialize_user_account
            
            logger.info(f"Initializing account for test user: {TEST_USER_EMAIL}")
            user_record = {
                'id': user_id,
                'email': TEST_USER_EMAIL,
                'raw_user_meta_data': {
                    'test_user': True,
                    'created_by': 'e2e_api_tests',
                    'yopmail': True
                }
            }
            
            # Call initialize_user_account (async function)
            init_result = await initialize_user_account(user_id, TEST_USER_EMAIL, user_record)
            
            if init_result.get('success'):
                logger.info(f"✅ Account initialized: subscription={init_result.get('subscription_id')}, agent={init_result.get('agent_id')}")
            else:
                logger.warning(f"⚠️ Account initialization had issues: {init_result.get('message')}")
        except Exception as init_error:
            logger.error(f"Failed to initialize account for test user: {init_error}", exc_info=True)
            # Don't fail the test - account might still work without full initialization
        
        return _cached_test_user
        
    except Exception as e:
        error_str = str(e)
        
        # If user already exists (shouldn't happen with random emails, but handle it)
        if "already been registered" in error_str:
            logger.warning(f"User {TEST_USER_EMAIL} already exists, generating new email...")
            # Try again with a new random email
            TEST_USER_EMAIL = _generate_random_yopmail()
            try:
                user_response = client.auth.admin.create_user({
                    'email': TEST_USER_EMAIL,
                    'password': test_config.test_user_password,
                    'email_confirm': True,
                    'user_metadata': {
                        'test_user': True,
                        'created_by': 'e2e_api_tests',
                        'yopmail': True
                    }
                })
                user_id = user_response.user.id
                _cached_test_user = {
                    "user_id": user_id,
                    "email": TEST_USER_EMAIL
                }
                logger.info(f"✅ Created verified test user (retry): {TEST_USER_EMAIL} (ID: {user_id})")
                
                # Initialize account (set up tier and credits)
                try:
                    from core.setup.api import initialize_user_account
                    
                    logger.info(f"Initializing account for test user (retry): {TEST_USER_EMAIL}")
                    user_record = {
                        'id': user_id,
                        'email': TEST_USER_EMAIL,
                        'raw_user_meta_data': {
                            'test_user': True,
                            'created_by': 'e2e_api_tests',
                            'yopmail': True
                        }
                    }
                    
                    init_result = await initialize_user_account(user_id, TEST_USER_EMAIL, user_record)
                    
                    if init_result.get('success'):
                        logger.info(f"✅ Account initialized (retry): subscription={init_result.get('subscription_id')}, agent={init_result.get('agent_id')}")
                    else:
                        logger.warning(f"⚠️ Account initialization had issues (retry): {init_result.get('message')}")
                except Exception as init_error:
                    logger.error(f"Failed to initialize account for test user (retry): {init_error}", exc_info=True)
                
                return _cached_test_user
            except Exception as retry_error:
                logger.error(f"Retry failed: {retry_error}")
        
        logger.error(f"Error ensuring test user: {e}", exc_info=True)
        
        raise ValueError(
            f"Could not create test user with email '{TEST_USER_EMAIL}'. "
            "Please check Supabase credentials and permissions."
        )


@pytest.fixture(scope="function")
async def test_user(test_config: E2ETestConfig) -> Dict[str, str]:
    """
    Get or create a verified test user with random yopmail email.
    Uses a sync client internally to avoid event loop issues.
    
    Returns:
        dict with "user_id" and "email" keys
        Example: {"user_id": "uuid-here", "email": "abc123xyz@yopmail.com"}
    """
    user_info = await _ensure_test_user_exists(test_config)
    
    # Print email prominently so it's visible when running tests
    print(f"\n{'='*60}")
    print(f"🧪 TEST USER EMAIL: {user_info['email']}")
    print(f"   User ID: {user_info['user_id']}")
    print(f"{'='*60}\n")
    
    return user_info


@pytest.fixture
async def test_user_email(test_user: Dict[str, str]) -> str:
    """
    Helper fixture to get just the test user email.
    
    Returns:
        Random yopmail email (e.g., "abc123xyz@yopmail.com")
    """
    return test_user["email"]


@pytest.fixture
async def auth_token(test_user: Dict[str, str], test_config: E2ETestConfig) -> str:
    """
    Generate JWT token for test user.
    
    Reuses logic from test_harness/runner.py _generate_jwt_token()
    """
    jwt_secret = test_config.supabase_jwt_secret or config.SUPABASE_JWT_SECRET
    
    if not jwt_secret:
        raise ValueError("SUPABASE_JWT_SECRET not configured")
    
    user_id = test_user["user_id"]
    
    # Generate JWT token for test user
    payload = {
        'sub': user_id,
        'aud': 'authenticated',
        'role': 'authenticated',
        'iat': datetime.now(timezone.utc).timestamp(),
        'exp': (datetime.now(timezone.utc) + timedelta(hours=1)).timestamp(),
    }
    
    token = jwt.encode(payload, jwt_secret, algorithm='HS256')
    logger.debug(f"Generated JWT token for test user: {test_user['email']} (ID: {user_id})")
    return token


@pytest.fixture
async def client(test_config: E2ETestConfig, auth_token: str) -> AsyncGenerator[httpx.AsyncClient, None]:
    """
    Authenticated HTTP client for API requests.
    """
    async with httpx.AsyncClient(
        base_url=test_config.base_url,
        headers={"Authorization": f"Bearer {auth_token}"},
        timeout=test_config.request_timeout,
        follow_redirects=True
    ) as client:
        yield client

