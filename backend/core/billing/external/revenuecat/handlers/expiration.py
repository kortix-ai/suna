from typing import Dict
from decimal import Decimal
from core.services.supabase import DBConnection
from core.utils.logger import logger
from ....credits.manager import credit_manager
from ..repositories import SubscriptionRepository


class ExpirationHandler:
    @staticmethod
    async def handle(webhook_data: Dict) -> None:
        event = webhook_data.get('event', {})
        app_user_id = event.get('app_user_id')
        
        logger.info(
            f"[REVENUECAT EXPIRATION] Subscription expired for {app_user_id} "
            f"- switching to Stripe free tier NOW"
        )
        
        db = DBConnection()
        client = await db.client
        
        logger.info(
            f"[REVENUECAT EXPIRATION] Clearing expiring credits for {app_user_id} "
            f"(free tier subscription will grant new credits)"
        )
        
        await credit_manager.reset_expiring_credits(
            account_id=app_user_id,
            new_credits=Decimal('0.00'),
            description="Subscription expired - clearing credits before free tier"
        )
        
        await SubscriptionRepository.transition_to_free_tier(client, app_user_id)
        
        from ....subscriptions import free_tier_service
        result = await free_tier_service.auto_subscribe_to_free_tier(app_user_id)
        
        if result.get('success'):
            subscription_id = result.get('subscription_id')
            logger.info(
                f"[REVENUECAT EXPIRATION] ✅ Successfully switched {app_user_id} "
                f"to Stripe free tier (subscription: {subscription_id})"
            )
        else:
            error = result.get('error')
            message = result.get('message')
            logger.error(
                f"[REVENUECAT EXPIRATION] ❌ Failed to create Stripe free tier: "
                f"error={error}, message={message}, full_result={result}"
            )

