from typing import Dict
from core.utils.logger import logger
from ..services import SubscriptionService
from ..utils import ProductMapper


class RenewalHandler:
    @staticmethod
    async def handle(webhook_data: Dict) -> None:
        event = webhook_data.get('event', {})
        app_user_id = event.get('app_user_id')
        product_id = event.get('product_id')
        
        # SECURITY: Reject renewals from anonymous users
        if not app_user_id or app_user_id.startswith('$RCAnonymousID:'):
            logger.error(f"[REVENUECAT RENEWAL] 🚫 REJECTED - Anonymous user: {app_user_id}")
            return
        
        if not ProductMapper.validate_product_id(product_id):
            logger.error(f"[REVENUECAT] Skipping RENEWAL for invalid product: {product_id}")
            return
        
        logger.info(f"[REVENUECAT RENEWAL] User {app_user_id} renewed {product_id}")
        
        await SubscriptionService.process_renewal(
            app_user_id=app_user_id,
            product_id=product_id,
            webhook_data=webhook_data
        )

