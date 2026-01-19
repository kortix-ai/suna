"""
Billing Cache Utilities

This module provides cache invalidation functions for billing-related data.
Kept separate to avoid circular imports.
"""
from core.utils.cache import Cache
from core.utils.logger import logger


ACCOUNT_STATE_CACHE_TTL = 600


async def invalidate_account_state_cache(account_id: str):
    """Invalidate the account state cache for a user."""
    cache_key = f"account_state:{account_id}"
    await Cache.invalidate(cache_key)
    
    # Also invalidate tier_info cache
    tier_key = f"tier_info:{account_id}"
    await Cache.invalidate(tier_key)
    
    # Also invalidate slot_manager tier cache so new limits take effect immediately
    try:
        from core.agents.pipeline.slot_manager import invalidate_tier_cache
        await invalidate_tier_cache(account_id)
    except Exception as e:
        logger.warning(f"[CACHE] Failed to invalidate slot_manager tier cache: {e}")
    
    logger.info(f"[ACCOUNT_STATE] Cache invalidated for {account_id}")


async def invalidate_all_billing_caches(account_id: str):
    """Invalidate all billing-related caches for a user using batch operation."""
    keys = [
        f"account_state:{account_id}",
        f"credit_balance:{account_id}",
        f"credit_summary:{account_id}",
        f"subscription_tier:{account_id}",
        f"tier_info:{account_id}",
    ]
    await Cache.invalidate_multiple(keys)
    
    # Also invalidate slot_manager tier cache so new limits take effect immediately
    try:
        from core.agents.pipeline.slot_manager import invalidate_tier_cache
        await invalidate_tier_cache(account_id)
    except Exception as e:
        logger.warning(f"[CACHE] Failed to invalidate slot_manager tier cache: {e}")
    
    logger.info(f"[BILLING CACHE] All caches invalidated for {account_id}")

