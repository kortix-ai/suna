from typing import Dict
from core.utils.logger import logger
from ..services import CreditService


class TopupHandler:
    @staticmethod
    async def handle(webhook_data: Dict) -> None:
        event = webhook_data.get('event', {})
        app_user_id = event.get('app_user_id')
        product_id = event.get('product_id')
        price = event.get('price', 0)
        transaction_id = event.get('id') or event.get('transaction_id')
        purchased_at_ms = event.get('purchased_at_ms') or event.get('event_timestamp_ms')
        
        # SECURITY: Reject topups from anonymous users
        if not app_user_id or app_user_id.startswith('$RCAnonymousID:'):
            logger.error(f"[REVENUECAT ONE_TIME] 🚫 REJECTED - Anonymous user: {app_user_id}")
            return
        
        if not transaction_id:
            logger.error(f"[REVENUECAT ONE_TIME] No transaction ID found, using fallback")
            transaction_id = f"rc_topup_{app_user_id}_{purchased_at_ms}"
        
        await CreditService.add_one_time_credits(
            app_user_id=app_user_id,
            price=price,
            product_id=product_id,
            transaction_id=transaction_id
        )

