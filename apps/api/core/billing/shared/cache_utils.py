from core.utils.cache import Cache
from core.utils.logger import logger

ACCOUNT_STATE_CACHE_TTL = 600

async def invalidate_account_state_cache(account_id: str):
    cache_key = f"account_state:{account_id}"
    await Cache.invalidate(cache_key)

    minimal_key = f"account_state_minimal:{account_id}"
    await Cache.invalidate(minimal_key)

    tier_key = f"tier_info:{account_id}"
    await Cache.invalidate(tier_key)

    subscription_tier_key = f"subscription_tier:{account_id}"
    await Cache.invalidate(subscription_tier_key)
    try:
        from core.cache.runtime_cache import invalidate_tier_info_cache
        await invalidate_tier_info_cache(account_id)
    except Exception as e:
        logger.warning(f"[CACHE] Failed to invalidate Redis tier_info cache: {e}")
    
    try:
        from core.agents.pipeline.slot_manager import invalidate_tier_cache
        await invalidate_tier_cache(account_id)
    except Exception as e:
        logger.warning(f"[CACHE] Failed to invalidate slot_manager tier cache: {e}")
    
    logger.info(f"[ACCOUNT_STATE] Cache invalidated for {account_id}")


async def invalidate_all_billing_caches(account_id: str):
    keys = [
        f"account_state:{account_id}",
        f"account_state_minimal:{account_id}",
        f"credit_balance:{account_id}",
        f"credit_summary:{account_id}",
        f"subscription_tier:{account_id}",
        f"tier_info:{account_id}",
    ]
    await Cache.invalidate_multiple(keys)
    
    try:
        from core.cache.runtime_cache import invalidate_tier_info_cache
        await invalidate_tier_info_cache(account_id)
    except Exception as e:
        logger.warning(f"[CACHE] Failed to invalidate Redis tier_info cache: {e}")
    
    try:
        from core.agents.pipeline.slot_manager import invalidate_tier_cache
        await invalidate_tier_cache(account_id)
    except Exception as e:
        logger.warning(f"[CACHE] Failed to invalidate slot_manager tier cache: {e}")
    
    logger.info(f"[BILLING CACHE] All caches invalidated for {account_id}")
