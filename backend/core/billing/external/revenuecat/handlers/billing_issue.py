from typing import Dict
from core.utils.logger import logger


class BillingIssueHandler:
    @staticmethod
    async def handle_subscription_paused(webhook_data: Dict) -> None:
        event = webhook_data.get('event', {})
        app_user_id = event.get('app_user_id')
        logger.info(f"[REVENUECAT PAUSED] Subscription paused for user {app_user_id}")
    
    @staticmethod
    async def handle_billing_issue(webhook_data: Dict) -> None:
        event = webhook_data.get('event', {})
        app_user_id = event.get('app_user_id')
        logger.warning(f"[REVENUECAT BILLING_ISSUE] Billing issue for user {app_user_id}")

