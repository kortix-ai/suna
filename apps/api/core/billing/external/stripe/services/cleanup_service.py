from typing import List, Dict
import stripe

from core.utils.logger import logger
from core.billing.external.stripe.client import StripeAPIWrapper

class CleanupService:
    
    async def cleanup_duplicate_subscriptions(
        self, 
        customer_id: str, 
        new_subscription_id: str,
        new_amount: int,
        previous_subscription_id: str = None
    ) -> List[str]:
        canceled_subs = []
        
        if previous_subscription_id:
            canceled_subs.extend(await self._cancel_previous_subscription(
                previous_subscription_id, new_subscription_id
            ))
        
        canceled_subs.extend(await self._cleanup_active_subscriptions(
            customer_id, new_subscription_id, new_amount
        ))
        
        if canceled_subs:
            logger.info(f"[CLEANUP SUMMARY] ✅ Canceled {len(canceled_subs)} old subscriptions: {canceled_subs}")
        else:
            logger.info(f"[CLEANUP SUMMARY] No duplicate subscriptions found to cancel")
            
        return canceled_subs
    
    async def _cancel_previous_subscription(self, previous_subscription_id: str, account_id: str) -> List[str]:
        try:
            logger.info(f"[UPGRADE CLEANUP] Immediately canceling previous subscription {previous_subscription_id} for {account_id}")
            await StripeAPIWrapper.cancel_subscription(previous_subscription_id)
            logger.info(f"[UPGRADE CLEANUP] ✅ Canceled previous subscription {previous_subscription_id}")
            return [previous_subscription_id]
        except stripe.error.StripeError as e:
            logger.warning(f"[UPGRADE CLEANUP] Could not cancel previous subscription {previous_subscription_id}: {e}")
            return []
    
    async def _cleanup_active_subscriptions(
        self, 
        customer_id: str, 
        keep_subscription_id: str, 
        new_amount: int
    ) -> List[str]:
        try:
            logger.info(f"[SUBSCRIPTION CLEANUP] Fetching all active subscriptions for customer {customer_id}")
            customer_subs = await StripeAPIWrapper.list_subscriptions(
                customer=customer_id,
                status='active',
                limit=10
            )
            
            logger.info(f"[SUBSCRIPTION CLEANUP] Found {len(customer_subs.data)} active subscriptions for customer")
            
            canceled_subs = []
            for old_sub in customer_subs.data:
                if old_sub.id != keep_subscription_id:
                    old_price = old_sub['items']['data'][0]['price']
                    old_amount = old_price.get('unit_amount', 0) or 0
                    
                    logger.info(f"[SUBSCRIPTION CLEANUP] Checking subscription {old_sub.id} with amount ${old_amount/100:.2f}")
                    
                    should_cancel = self._should_cancel_old_subscription(old_amount, new_amount)
                    
                    if should_cancel:
                        reason = self._get_cancellation_reason(old_amount, new_amount)
                        logger.info(f"[DUPLICATE CLEANUP] {reason}")
                        
                        await StripeAPIWrapper.cancel_subscription(old_sub.id)
                        canceled_subs.append(old_sub.id)
                        logger.info(f"[DUPLICATE CLEANUP] ✅ Canceled old subscription {old_sub.id}")
            
            return canceled_subs
            
        except stripe.error.StripeError as e:
            logger.error(f"[DUPLICATE CLEANUP] Error checking for duplicate subscriptions: {e}")
            return []
    
    def _should_cancel_old_subscription(self, old_amount: int, new_amount: int) -> bool:
        if old_amount == 0 and new_amount > 0:
            return True
        elif old_amount == 0 and new_amount == 0:
            return True
        return False
    
    def _get_cancellation_reason(self, old_amount: int, new_amount: int) -> str:
        if old_amount == 0 and new_amount > 0:
            return f"New subscription is PAID (${new_amount/100:.2f}), canceling old FREE subscription"
        elif old_amount == 0 and new_amount == 0:
            return f"Both are $0, keeping newer subscription, canceling old duplicate"
        else:
            return f"Cleaning up old subscription (${old_amount/100:.2f})"
    
    async def check_for_other_active_subscriptions(self, customer_id: str, exclude_subscription_id: str) -> List[Dict]:
        try:
            active_subs = await StripeAPIWrapper.list_subscriptions(
                customer=customer_id,
                status='all',
                limit=10
            )
            
            other_active_subs = [
                sub for sub in active_subs.data 
                if sub.id != exclude_subscription_id and sub.status in ['active', 'trialing', 'incomplete']
            ]
            
            return [{'id': sub.id, 'status': sub.status} for sub in other_active_subs]
            
        except Exception as e:
            logger.error(f"[CLEANUP] Error checking for other subscriptions: {e}")
            return []
