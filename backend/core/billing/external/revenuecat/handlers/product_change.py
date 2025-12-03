from typing import Dict
from core.utils.logger import logger
from ..services import SubscriptionService
from ..utils import ProductMapper


class ProductChangeHandler:
    @staticmethod
    async def handle(webhook_data: Dict) -> None:
        event = webhook_data.get('event', {})
        app_user_id = event.get('app_user_id')
        new_product_id = event.get('new_product_id')
        old_product_id = event.get('product_id')

        # SECURITY: Reject product changes from anonymous users
        if not app_user_id or app_user_id.startswith('$RCAnonymousID:'):
            logger.error(f"[REVENUECAT PRODUCT_CHANGE] 🚫 REJECTED - Anonymous user: {app_user_id}")
            return

        if not new_product_id:
            logger.warning(
                f"[REVENUECAT PRODUCT_CHANGE] No new_product_id - this might be a "
                f"cancellation/reactivation, not an actual product change. Skipping."
            )
            return
        
        if not ProductMapper.validate_product_id(new_product_id):
            logger.error(f"[REVENUECAT] Skipping PRODUCT_CHANGE for invalid new product: {new_product_id}")
            return
        
        old_tier, old_tier_info = ProductMapper.get_tier_info(old_product_id) if old_product_id else (None, None)
        new_tier, new_tier_info = ProductMapper.get_tier_info(new_product_id)
        
        if not new_tier_info:
            logger.error(f"[REVENUECAT PRODUCT_CHANGE] Unknown new product: {new_product_id}, skipping")
            return
        
        is_upgrade = False
        is_downgrade = False
        
        if old_tier_info and new_tier_info:
            is_upgrade = new_tier_info.monthly_credits > old_tier_info.monthly_credits
            is_downgrade = new_tier_info.monthly_credits < old_tier_info.monthly_credits
        
        change_type = "upgrade" if is_upgrade else "downgrade" if is_downgrade else "change"
        
        old_credits = old_tier_info.monthly_credits if old_tier_info else 0
        new_credits = new_tier_info.monthly_credits if new_tier_info else 0
        
        logger.info(
            f"[REVENUECAT PRODUCT_CHANGE] User {app_user_id} {change_type}: "
            f"{old_product_id or 'none'} → {new_product_id} "
            f"(${old_credits} → ${new_credits})"
        )
        
        await SubscriptionService.schedule_plan_change_for_period_end(
            app_user_id, old_product_id, new_product_id, event, change_type
        )

        # Invalidate cache to reflect scheduled change immediately
        try:
            from core.billing.shared.cache_utils import invalidate_account_state_cache
            await invalidate_account_state_cache(app_user_id)
            logger.info(f"[REVENUECAT PRODUCT_CHANGE] Cache invalidated for {app_user_id}")
        except Exception as cache_error:
            logger.warning(f"[REVENUECAT PRODUCT_CHANGE] Cache invalidation failed: {cache_error}")

