from typing import Dict
from datetime import datetime, timezone

from core.utils.logger import logger
from ..repositories.subscription_repository import SubscriptionRepository

class SubscriptionCancellationService:
    def __init__(self):
        self.subscription_repo = SubscriptionRepository()
    
    async def process_subscription_deletion(self, subscription: Dict, other_active_subs: list) -> None:
        account_id = subscription.get('metadata', {}).get('account_id')
        if not account_id:
            customer_id = subscription.get('customer')
            account_id = await self.subscription_repo.get_account_from_customer(customer_id)
        
        if not account_id:
            logger.warning("[DELETION] No account_id found for deleted subscription")
            return
        
        if other_active_subs:
            logger.info(f"[DELETION] User {account_id} has {len(other_active_subs)} other active subscriptions - skipping credit removal")
            return
        
        logger.info(f"[DELETION] No other subscriptions found for {account_id} - proceeding with cleanup")
        
        account_data = await self.subscription_repo.get_credit_account_full(account_id)
        if not account_data:
            return
        
        await self._handle_deletion_by_type(account_id, account_data, subscription)
    
    async def _handle_deletion_by_type(self, account_id: str, account_data: Dict, subscription: Dict) -> None:
        current_tier = account_data.get('tier')
        expiring_credits = account_data.get('expiring_credits', 0)
        non_expiring_credits = account_data.get('non_expiring_credits', 0)
        provider = account_data.get('provider', 'stripe')
        
        if provider == 'revenuecat' or account_data.get('revenuecat_subscription_id'):
            logger.info(f"[DELETION] Account {account_id} uses RevenueCat - skipping Stripe cleanup")
            return
        
        if current_tier not in ['none', 'free']:
            await self._handle_paid_subscription_cancellation(
                account_id, expiring_credits, non_expiring_credits
            )
        else:
            await self._handle_free_tier_cancellation(account_id)
    
    async def _handle_free_tier_cancellation(self, account_id: str) -> None:
        await self.subscription_repo.update_subscription_metadata(account_id, {
            'tier': 'none',
            'stripe_subscription_id': None,
            'stripe_subscription_status': 'canceled'
        })
        
        logger.info(f"[DELETION] ✅ Processed free tier cancellation for {account_id}")
    
    async def _handle_paid_subscription_cancellation(
        self, 
        account_id: str, 
        expiring_credits: float, 
        non_expiring_credits: float
    ) -> None:
        new_balance = float(non_expiring_credits)
        
        await self.subscription_repo.update_subscription_metadata(account_id, {
            'tier': 'none',
            'expiring_credits': 0.00,
            'balance': new_balance,
            'stripe_subscription_id': None,
            'stripe_subscription_status': 'canceled'
        })
        
        if expiring_credits > 0:
            await self.subscription_repo.add_credit_ledger_entry(
                account_id, -float(expiring_credits), new_balance, 'adjustment',
                'Subscription cancelled - expiring credits removed'
            )
        
        logger.info(f"[DELETION] ✅ Processed paid subscription cancellation for {account_id}")
    
