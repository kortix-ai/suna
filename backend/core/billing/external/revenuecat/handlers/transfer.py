from typing import Dict
from core.utils.logger import logger
from ..services import SubscriptionService, ValidationService


class TransferHandler:
    @staticmethod
    async def handle(webhook_data: Dict) -> None:
        event = webhook_data.get('event', {})
        transferred_from = event.get('transferred_from', [])
        
        try:
            new_app_user_id, product_id, price = await ValidationService.validate_transfer_event(
                event, webhook_data
            )
        except ValueError as e:
            logger.info(f"[REVENUECAT TRANSFER] Transfer validation failed: {e}")
            return
        
        transferred_from_valid = [
            user_id for user_id in transferred_from 
            if not user_id.startswith('$RCAnonymousID:')
        ]
        
        await SubscriptionService.apply_subscription_change(
            app_user_id=new_app_user_id,
            product_id=product_id,
            price=price,
            event_type='TRANSFER',
            webhook_data=webhook_data
        )
        
        logger.info(f"[REVENUECAT TRANSFER] ✅ Transfer complete: {transferred_from_valid} → {new_app_user_id}")

