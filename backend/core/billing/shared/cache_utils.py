"""
Billing Cache Utilities

This module provides cache invalidation functions for billing-related data.
Kept separate to avoid circular imports.
"""
from core.utils.cache import Cache
from core.utils.logger import logger


ACCOUNT_STATE_CACHE_TTL = 300  # 5 minutes


async def invalidate_account_state_cache(account_id: str):
    """Invalidate the account state cache for a user."""
    cache_key = f"account_state:{account_id}"
    await Cache.invalidate(cache_key)
    logger.info(f"[ACCOUNT_STATE] Cache invalidated for {account_id}")


async def invalidate_all_billing_caches(account_id: str):
    """Invalidate all billing-related caches for a user."""
    await Cache.invalidate(f"account_state:{account_id}")
    await Cache.invalidate(f"credit_balance:{account_id}")
    await Cache.invalidate(f"credit_summary:{account_id}")
    await Cache.invalidate(f"subscription_tier:{account_id}")
    logger.info(f"[BILLING CACHE] All caches invalidated for {account_id}")

