"""
API key validation utilities.
"""

import re
from typing import Tuple, Optional, Dict


# API key patterns for different providers
API_KEY_PATTERNS: Dict[str, re.Pattern] = {
    "openai": re.compile(r"^sk-[a-zA-Z0-9_-]+$"),
    "anthropic": re.compile(r"^sk-ant-[a-zA-Z0-9_-]+$"),
    "supabase_anon": re.compile(r"^eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+$"),
    "supabase_service": re.compile(r"^eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+$"),
}


def validate_api_key(
    api_key: str,
    allow_empty: bool = False,
    min_length: int = 10,
    provider: Optional[str] = None,
) -> Tuple[bool, Optional[str]]:
    """
    Validate an API key.

    Args:
        api_key: The API key to validate
        allow_empty: If True, empty keys are considered valid
        min_length: Minimum required length for the key
        provider: Optional provider name for pattern-specific validation

    Returns:
        Tuple of (is_valid: bool, error_message: Optional[str])
    """
    if allow_empty and not api_key:
        return True, None

    if not api_key:
        return False, "API key cannot be empty"

    if len(api_key) < min_length:
        return False, f"API key must be at least {min_length} characters long"

    # If a specific provider is given, validate against its pattern
    if provider and provider.lower() in API_KEY_PATTERNS:
        pattern = API_KEY_PATTERNS[provider.lower()]
        if not pattern.match(api_key):
            return False, f"Invalid {provider} API key format"

    return True, None


def validate_openai_key(api_key: str, allow_empty: bool = False) -> Tuple[bool, Optional[str]]:
    """
    Validate an OpenAI API key.

    Args:
        api_key: The OpenAI API key
        allow_empty: If True, empty keys are considered valid

    Returns:
        Tuple of (is_valid: bool, error_message: Optional[str])
    """
    if allow_empty and not api_key:
        return True, None

    if not api_key:
        return False, "OpenAI API key cannot be empty"

    # OpenAI keys typically start with 'sk-'
    if not api_key.startswith("sk-"):
        return False, "OpenAI API key should start with 'sk-'"

    if len(api_key) < 40:
        return False, "OpenAI API key seems too short"

    return True, None


def validate_anthropic_key(api_key: str, allow_empty: bool = False) -> Tuple[bool, Optional[str]]:
    """
    Validate an Anthropic API key.

    Args:
        api_key: The Anthropic API key
        allow_empty: If True, empty keys are considered valid

    Returns:
        Tuple of (is_valid: bool, error_message: Optional[str])
    """
    if allow_empty and not api_key:
        return True, None

    if not api_key:
        return False, "Anthropic API key cannot be empty"

    # Anthropic keys typically start with 'sk-ant-'
    if not api_key.startswith("sk-ant-"):
        return False, "Anthropic API key should start with 'sk-ant-'"

    return True, None


def validate_supabase_key(api_key: str, key_type: str = "anon") -> Tuple[bool, Optional[str]]:
    """
    Validate a Supabase API key (anon or service role).

    Args:
        api_key: The Supabase key
        key_type: Either 'anon' or 'service'

    Returns:
        Tuple of (is_valid: bool, error_message: Optional[str])
    """
    if not api_key:
        return False, f"Supabase {key_type} key cannot be empty"

    # Supabase keys are JWTs starting with 'eyJ'
    if not api_key.startswith("eyJ"):
        return False, f"Supabase {key_type} key should be a JWT (starts with 'eyJ')"

    # JWT should have 3 parts separated by dots
    parts = api_key.split(".")
    if len(parts) != 3:
        return False, f"Invalid Supabase {key_type} key format (not a valid JWT)"

    return True, None


def validate_jwt_secret(secret: str) -> Tuple[bool, Optional[str]]:
    """
    Validate a JWT secret.

    Args:
        secret: The JWT secret

    Returns:
        Tuple of (is_valid: bool, error_message: Optional[str])
    """
    if not secret:
        return False, "JWT secret cannot be empty"

    if len(secret) < 32:
        return False, "JWT secret must be at least 32 characters long"

    return True, None


def get_key_prefix(api_key: str) -> str:
    """
    Get a safe prefix of an API key for logging/display.

    Args:
        api_key: The API key

    Returns:
        First 8 characters followed by '...'
    """
    if not api_key or len(api_key) < 8:
        return api_key or ""
    return api_key[:8] + "..."
