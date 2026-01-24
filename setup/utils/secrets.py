"""
Secret key generation utilities.
"""

import secrets
import base64


def generate_encryption_key() -> str:
    """
    Generate a secure base64-encoded encryption key for MCP credentials.

    Returns:
        A 32-byte key encoded as base64 (44 characters)
    """
    key_bytes = secrets.token_bytes(32)
    return base64.b64encode(key_bytes).decode("utf-8")


def generate_admin_api_key() -> str:
    """
    Generate a secure admin API key for Kortix.

    Returns:
        A 32-byte key encoded as hex (64 characters)
    """
    key_bytes = secrets.token_bytes(32)
    return key_bytes.hex()


def generate_webhook_secret() -> str:
    """
    Generate a secure shared secret for trigger webhooks.

    Returns:
        A 32-byte secret encoded as hex (64 characters)
    """
    return secrets.token_hex(32)


def generate_jwt_secret() -> str:
    """
    Generate a secure JWT secret.

    Returns:
        A 64-byte secret encoded as base64 (88 characters)
    """
    key_bytes = secrets.token_bytes(64)
    return base64.b64encode(key_bytes).decode("utf-8")


def mask_sensitive_value(value: str, show_last: int = 4) -> str:
    """
    Mask sensitive values for display, showing only the last few characters.

    Args:
        value: The sensitive value to mask
        show_last: Number of characters to show at the end

    Returns:
        Masked string with asterisks
    """
    if not value or len(value) <= show_last:
        return value
    return "*" * (len(value) - show_last) + value[-show_last:]
