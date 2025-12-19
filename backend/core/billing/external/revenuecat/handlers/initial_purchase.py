from typing import Dict
from core.utils.logger import logger
from ..services import SubscriptionService
from ..utils import ProductMapper


class InitialPurchaseHandler:
    @staticmethod
    async def handle(webhook_data: Dict) -> None:
        event = webhook_data.get('event', {})
        app_user_id = event.get('app_user_id')
        product_id = event.get('product_id')
        price = event.get('price', 0)
        
        # SECURITY: Reject purchases from anonymous users
        if not app_user_id or app_user_id.startswith('$RCAnonymousID:'):
            logger.error(
                f"[REVENUECAT INITIAL_PURCHASE] 🚫 REJECTED - Anonymous user purchase blocked\n"
                f"app_user_id: {app_user_id}\n"
                f"product_id: {product_id}\n"
                f"Purchases must be linked to a real account"
            )
            return
        
        if not ProductMapper.validate_product_id(product_id):
            logger.error(f"[REVENUECAT] Skipping INITIAL_PURCHASE for invalid product: {product_id}")
            return
        
        try:
            await SubscriptionService.apply_subscription_change(
                app_user_id=app_user_id,
                product_id=product_id,
                price=price,
                event_type='INITIAL_PURCHASE',
                webhook_data=webhook_data
            )
            
            try:
                from core.billing.shared.cache_utils import invalidate_account_state_cache
                await invalidate_account_state_cache(app_user_id)
                logger.info(f"[REVENUECAT INITIAL_PURCHASE] Cache invalidated for {app_user_id}")
            except Exception as cache_error:
                logger.warning(f"[REVENUECAT INITIAL_PURCHASE] Cache invalidation failed: {cache_error}")
            
            logger.info(f"[REVENUECAT INITIAL_PURCHASE] ✅ Successfully processed purchase for {app_user_id}")
        except Exception as e:
            logger.error(f"[REVENUECAT INITIAL_PURCHASE] ❌ Failed to process: {e}", exc_info=True)
            raise

