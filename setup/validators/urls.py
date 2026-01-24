"""
URL validation utilities.
"""

import re
from typing import Tuple, Optional


def validate_url(url: str, allow_empty: bool = False) -> Tuple[bool, Optional[str]]:
    """
    Validate a URL format.

    Args:
        url: The URL to validate
        allow_empty: If True, empty URLs are considered valid

    Returns:
        Tuple of (is_valid: bool, error_message: Optional[str])
    """
    if allow_empty and not url:
        return True, None

    if not url:
        return False, "URL cannot be empty"

    # URL validation pattern
    pattern = re.compile(
        r"^(?:http|https)://"  # http:// or https://
        r"(?:(?:[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?\.)+(?:[A-Z]{2,6}\.?|[A-Z0-9-]{2,}\.?)|"  # domain
        r"localhost|"  # localhost
        r"\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})"  # IP address
        r"(?::\d+)?"  # optional port
        r"(?:/?|[/?]\S+)$",  # path
        re.IGNORECASE,
    )

    if pattern.match(url):
        return True, None

    return False, "Invalid URL format. Must be a valid HTTP/HTTPS URL."


def validate_supabase_url(url: str) -> Tuple[bool, Optional[str]]:
    """
    Validate a Supabase project URL.

    Args:
        url: The Supabase URL to validate

    Returns:
        Tuple of (is_valid: bool, error_message: Optional[str])
    """
    is_valid, error = validate_url(url)
    if not is_valid:
        return is_valid, error

    # Check for Supabase URL pattern
    if not re.match(r"https://[a-z0-9]+\.supabase\.co/?$", url, re.IGNORECASE):
        return False, "URL should match pattern: https://[project-ref].supabase.co"

    return True, None


def extract_supabase_project_ref(url: str) -> Optional[str]:
    """
    Extract the project reference from a Supabase URL.

    Args:
        url: The Supabase URL

    Returns:
        The project reference, or None if extraction fails
    """
    match = re.search(r"https://([^.]+)\.supabase\.co", url, re.IGNORECASE)
    if match:
        return match.group(1)
    return None


def validate_webhook_url(url: str, allow_empty: bool = False) -> Tuple[bool, Optional[str]]:
    """
    Validate a webhook URL (must be publicly accessible).

    Args:
        url: The webhook URL to validate
        allow_empty: If True, empty URLs are considered valid

    Returns:
        Tuple of (is_valid: bool, error_message: Optional[str])
    """
    if allow_empty and not url:
        return True, None

    is_valid, error = validate_url(url)
    if not is_valid:
        return is_valid, error

    # Warn about localhost URLs (not accessible externally)
    if "localhost" in url.lower() or "127.0.0.1" in url:
        return False, "Webhook URL must be publicly accessible (localhost is not allowed)"

    return True, None
