from typing import Dict
from core.services.supabase import DBConnection
from core.utils.logger import logger
from ..repositories import SubscriptionRepository


class CancellationHandler:
    @staticmethod
    async def handle_cancellation(webhook_data: Dict) -> None:
        event = webhook_data.get('event', {})
        app_user_id = event.get('app_user_id')
        expiration_at_ms = event.get('expiration_at_ms')
        
        logger.info(
            f"[REVENUECAT CANCELLATION] User {app_user_id} cancelled "
            f"- will switch to Stripe free tier at end of billing period"
        )
        
        db = DBConnection()
        client = await db.client
        
        await SubscriptionRepository.mark_subscription_as_cancelled(
            client, app_user_id, expiration_at_ms
        )
    
    @staticmethod
    async def handle_uncancellation(webhook_data: Dict) -> None:
        event = webhook_data.get('event', {})
        app_user_id = event.get('app_user_id')
        
        logger.info(
            f"[REVENUECAT UNCANCELLATION] User {app_user_id} reactivated "
            f"- cancelling scheduled free tier switch"
        )
        
        db = DBConnection()
        client = await db.client
        
        await SubscriptionRepository.clear_cancellation(client, app_user_id)

