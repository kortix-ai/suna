"""
Replicate API Client Helper

Provides centralized Replicate API access with:
- Multi-key load balancing (comma-separated keys in REPLICATE_API_TOKEN)
- Rate limit retry with backoff (429 errors)
- Backwards compatible with single key

Usage:
    from core.utils.replicate_client import replicate_run, replicate_run_sync

    # Async (wraps in thread pool)
    output = await replicate_run("model/name", input={...})

    # Sync (for blocking contexts)
    output = replicate_run_sync("model/name", input={...})
"""

import os
import random
import time
import asyncio
from typing import Any, Optional
import replicate

from core.utils.logger import logger
from core.utils.config import get_config

# Rate limit retry config
RATE_LIMIT_RETRY_DELAY = 5.0  # seconds
RATE_LIMIT_MAX_RETRIES = 3


def _get_replicate_keys() -> list[str]:
    """
    Get list of Replicate API keys from config.
    Supports multiple keys separated by comma (no spaces).
    Backwards compatible with single key.

    Returns:
        List of API keys

    Raises:
        Exception if no keys configured
    """
    config = get_config()
    token = config.REPLICATE_API_TOKEN
    if not token:
        raise Exception("Replicate API token not configured. Add REPLICATE_API_TOKEN to your .env")

    # Split by comma, strip whitespace, filter empty
    keys = [k.strip() for k in token.split(",") if k.strip()]
    if not keys:
        raise Exception("Replicate API token not configured. Add REPLICATE_API_TOKEN to your .env")

    return keys


def _select_random_key() -> str:
    """Select a random key from available keys and set it in environment."""
    keys = _get_replicate_keys()
    selected = random.choice(keys)
    os.environ["REPLICATE_API_TOKEN"] = selected
    return selected


def _is_rate_limit_error(error: Exception) -> bool:
    """Check if error is a rate limit (429) error."""
    error_str = str(error).lower()
    # Check for 429 status code or rate limit keywords
    if "429" in error_str:
        return True
    if "rate" in error_str and "limit" in error_str:
        return True
    if "throttled" in error_str:
        return True
    return False


def replicate_run_sync(
    model: str,
    input: dict[str, Any],
    max_retries: int = RATE_LIMIT_MAX_RETRIES,
    retry_delay: float = RATE_LIMIT_RETRY_DELAY,
) -> Any:
    """
    Run Replicate model synchronously with multi-key support and rate limit retry.

    Args:
        model: Model identifier (e.g., "openai/gpt-image-1.5")
        input: Model input parameters
        max_retries: Max retries on rate limit (default 3)
        retry_delay: Delay between retries in seconds (default 5)

    Returns:
        Model output

    Raises:
        Exception on failure after retries
    """
    last_error: Optional[Exception] = None

    for attempt in range(max_retries + 1):
        try:
            # Select random key for this attempt
            _select_random_key()

            # Run the model
            output = replicate.run(model, input=input)
            return output

        except Exception as e:
            last_error = e

            if _is_rate_limit_error(e):
                if attempt < max_retries:
                    logger.warning(
                        f"Replicate rate limit hit for {model}, "
                        f"retry {attempt + 1}/{max_retries} after {retry_delay}s"
                    )
                    time.sleep(retry_delay)
                    continue
                else:
                    logger.error(f"Replicate rate limit exhausted for {model} after {max_retries} retries")
            else:
                # Non-rate-limit error, don't retry
                raise

    # Should not reach here, but just in case
    if last_error:
        raise last_error
    raise Exception(f"Replicate call failed for {model}")


async def replicate_run(
    model: str,
    input: dict[str, Any],
    max_retries: int = RATE_LIMIT_MAX_RETRIES,
    retry_delay: float = RATE_LIMIT_RETRY_DELAY,
) -> Any:
    """
    Run Replicate model asynchronously with multi-key support and rate limit retry.
    Wraps synchronous replicate.run() in thread pool to not block event loop.

    Args:
        model: Model identifier (e.g., "openai/gpt-image-1.5")
        input: Model input parameters
        max_retries: Max retries on rate limit (default 3)
        retry_delay: Delay between retries in seconds (default 5)

    Returns:
        Model output

    Raises:
        Exception on failure after retries
    """
    return await asyncio.to_thread(
        replicate_run_sync,
        model,
        input,
        max_retries,
        retry_delay,
    )


def get_replicate_token() -> str:
    """
    Legacy helper - get and set a Replicate API token.
    For backwards compatibility with existing code.

    Returns:
        Selected API token
    """
    return _select_random_key()
