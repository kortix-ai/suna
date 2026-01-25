"""
Database URL validation and normalization utilities.
"""

from typing import Tuple, Optional
from urllib.parse import urlparse, urlunparse, quote, unquote


def validate_database_url(url: str, allow_empty: bool = False) -> Tuple[bool, Optional[str]]:
    """
    Validate a PostgreSQL database URL format.

    Args:
        url: The database URL to validate
        allow_empty: If True, empty URLs are considered valid

    Returns:
        Tuple of (is_valid: bool, error_message: Optional[str])
    """
    if allow_empty and not url:
        return True, None

    if not url:
        return False, "Database URL cannot be empty"

    # Must start with postgresql:// or postgres://
    if not (url.startswith("postgresql://") or url.startswith("postgres://")):
        return False, "Database URL must start with postgresql:// or postgres://"

    try:
        parsed = urlparse(url)

        # Check required components
        if not parsed.scheme:
            return False, "Database URL missing scheme"

        if not parsed.hostname:
            return False, "Database URL missing hostname"

        # Check for valid port if specified
        if parsed.port is not None and (parsed.port < 1 or parsed.port > 65535):
            return False, f"Invalid port number: {parsed.port}"

        # Check for database name in path
        if not parsed.path or parsed.path == "/":
            return False, "Database URL missing database name"

        return True, None

    except Exception as e:
        return False, f"Invalid database URL: {e}"


def normalize_database_url(url: str) -> str:
    """
    Normalize a database URL.

    Performs the following normalizations:
    - Converts postgres:// to postgresql://
    - Ensures password is properly URL-encoded (handles double-encoding)
    - Validates structure

    Args:
        url: The database URL to normalize

    Returns:
        Normalized database URL
    """
    if not url:
        return url

    # Convert postgres:// to postgresql://
    if url.startswith("postgres://"):
        url = url.replace("postgres://", "postgresql://", 1)

    try:
        parsed = urlparse(url)

        # URL-encode the password if present
        if parsed.password:
            # Decode password until no more URL-encoded sequences remain
            # (handles double/triple encoding)
            decoded_password = parsed.password
            while "%" in decoded_password:
                try:
                    new_decoded = unquote(decoded_password)
                    if new_decoded == decoded_password:
                        break  # No more decoding possible
                    decoded_password = new_decoded
                except Exception:
                    break  # Stop if decoding fails

            # Reconstruct with properly URL-encoded password (encode once)
            encoded_password = quote(decoded_password, safe="")
            netloc = f"{parsed.username}:{encoded_password}@{parsed.hostname}"
            if parsed.port:
                netloc += f":{parsed.port}"

            normalized = urlunparse(
                (
                    parsed.scheme,
                    netloc,
                    parsed.path,
                    parsed.params,
                    parsed.query,
                    parsed.fragment,
                )
            )
            return normalized

        return url

    except Exception:
        # If parsing fails, return original (will be caught by validation)
        return url


def construct_database_url(
    project_ref: str,
    password: str,
    host: str,
    port: int = 5432,
    dbname: str = "postgres",
    use_pooler: bool = False,
) -> str:
    """
    Construct a properly formatted DATABASE_URL with URL-encoded password.

    Args:
        project_ref: Supabase project reference
        password: Database password (will be URL-encoded)
        host: Database hostname
        port: Database port (default: 5432)
        dbname: Database name (default: postgres)
        use_pooler: If True, uses pooler format with postgres.[ref] username

    Returns:
        Properly formatted DATABASE_URL string
    """
    # URL-encode the password to handle special characters
    encoded_password = quote(password, safe="")

    # Determine username based on connection type
    if use_pooler:
        username = f"postgres.{project_ref}"
    else:
        username = "postgres"

    # Construct the URL
    database_url = f"postgresql://{username}:{encoded_password}@{host}:{port}/{dbname}"

    return database_url


def parse_database_url(url: str) -> Optional[dict]:
    """
    Parse a database URL into its components.

    Args:
        url: The database URL to parse

    Returns:
        Dictionary with parsed components, or None if parsing fails
    """
    try:
        parsed = urlparse(url)
        return {
            "scheme": parsed.scheme,
            "username": parsed.username,
            "password": parsed.password,
            "hostname": parsed.hostname,
            "port": parsed.port or 5432,
            "database": parsed.path.lstrip("/") if parsed.path else None,
            "query": parsed.query,
        }
    except Exception:
        return None


def mask_database_url(url: str) -> str:
    """
    Mask the password in a database URL for safe logging.

    Args:
        url: The database URL

    Returns:
        URL with password masked as '***'
    """
    try:
        parsed = urlparse(url)
        if parsed.password:
            masked = url.replace(parsed.password, "***", 1)
            return masked
        return url
    except Exception:
        return url
