from typing import Dict, Optional
from datetime import datetime, timezone
from decimal import Decimal
import asyncio

from core.utils.logger import logger
from core.billing.shared.config import get_tier_by_price_id, get_price_type
from core.billing.external.stripe import (
    StripeAPIWrapper,
    generate_subscription_modify_idempotency_key
)

class SubscriptionUpgradeService:
    
    def classify_upgrade_type(self, current_subscription: Dict, target_price_id: str) -> str:
        current_price = current_subscription['items']['data'][0]['price']
        current_amount = current_price.get('unit_amount', 0) or 0
        current_price_id = current_price['id']
        
        if current_amount == 0:
            return 'free_tier_upgrade'
        
        current_plan_type = get_price_type(current_price_id)
        target_plan_type = get_price_type(target_price_id)
        
        if current_plan_type == 'yearly':
            if target_plan_type == 'monthly':
                return 'yearly_to_monthly'
            elif target_plan_type == 'yearly':
                return 'yearly_to_yearly'
            else:
                return 'yearly_schedule_change'
        
        return 'standard_upgrade'
    
    async def perform_standard_upgrade(
        self, 
        subscription_id: str,
        subscription: Dict,
        target_price_id: str,
        account_id: str
    ) -> Dict:
        await self._cleanup_duplicate_subscriptions(
            subscription['customer'], subscription_id, account_id
        )
        
        await asyncio.sleep(1)
        
        modify_key = generate_subscription_modify_idempotency_key(subscription_id, target_price_id)
        
        try:
            updated_subscription = await StripeAPIWrapper.modify_subscription(
                subscription_id,
                items=[{
                    'id': subscription['items']['data'][0].id,
                    'price': target_price_id,
                }],
                proration_behavior='always_invoice',
                payment_behavior='pending_if_incomplete',
                idempotency_key=modify_key
            )
            
        except Exception as e:
            logger.error(f"Failed to modify subscription {subscription_id}: {e}")
            raise
        
        await asyncio.sleep(1)
        await self._cleanup_duplicate_subscriptions(
            subscription['customer'], updated_subscription.id, account_id
        )
        
        return await self._process_subscription_change(updated_subscription, account_id, target_price_id)
    
    async def perform_yearly_to_monthly_upgrade(
        self,
        account_id: str,
        current_subscription: Dict,
        target_price_id: str
    ) -> Dict:
        subscription_id = current_subscription['id']
        
        logger.info(f"[YEARLY→MONTHLY] Processing switch for {account_id}")
        
        modify_key = generate_subscription_modify_idempotency_key(subscription_id, target_price_id)
        
        updated_subscription = await StripeAPIWrapper.modify_subscription(
            subscription_id,
            items=[{
                'id': current_subscription['items']['data'][0]['id'],
                'price': target_price_id,
            }],
            proration_behavior='always_invoice',
            payment_behavior='pending_if_incomplete',
            idempotency_key=modify_key
        )
        
        await self._process_subscription_change(updated_subscription, account_id, target_price_id)
        
        current_tier = get_tier_by_price_id(current_subscription['items']['data'][0]['price']['id'])
        target_tier = get_tier_by_price_id(target_price_id)
        
        return {
            'status': 'switched_to_monthly',
            'message': f"Successfully switched from {current_tier.display_name if current_tier else 'yearly'} to {target_tier.display_name if target_tier else 'monthly'}! Stripe automatically applied credit for unused yearly time.",
            'subscription_id': updated_subscription.id,
            'next_billing_date': datetime.fromtimestamp(updated_subscription.current_period_end).isoformat()
        }
    
    async def perform_yearly_to_yearly_upgrade(
        self,
        account_id: str,
        current_subscription: Dict,
        target_price_id: str
    ) -> Dict:
        current_tier = get_tier_by_price_id(current_subscription['items']['data'][0]['price']['id'])
        target_tier = get_tier_by_price_id(target_price_id)
        
        current_price_cents = current_subscription['items']['data'][0]['price']['unit_amount']
        target_price_obj = await StripeAPIWrapper.safe_stripe_call(
            StripeAPIWrapper.stripe.Price.retrieve_async, target_price_id
        )
        target_price_cents = target_price_obj.unit_amount
        
        if target_price_cents <= current_price_cents:
            return {
                'status': 'downgrade_not_supported',
                'message': 'Yearly plan downgrades are scheduled for end of billing period. Please contact support for assistance.',
                'current_tier': current_tier.display_name if current_tier else 'Current Plan',
                'target_tier': target_tier.display_name if target_tier else 'Target Plan'
            }
        
        modify_key = generate_subscription_modify_idempotency_key(current_subscription['id'], target_price_id)
        
        updated_subscription = await StripeAPIWrapper.modify_subscription(
            current_subscription['id'],
            items=[{
                'id': current_subscription['items']['data'][0]['id'],
                'price': target_price_id,
            }],
            proration_behavior='always_invoice',
            payment_behavior='pending_if_incomplete',
            idempotency_key=modify_key
        )
        
        await self._process_subscription_change(updated_subscription, account_id, target_price_id)
        
        return {
            'status': 'yearly_upgrade_completed',
            'message': f"Upgraded from {current_tier.display_name if current_tier else 'current plan'} to {target_tier.display_name if target_tier else 'new plan'}! Stripe automatically handled the upgrade charge.",
            'subscription_id': updated_subscription.id
        }
    
    async def _process_subscription_change(self, updated_subscription: Dict, account_id: str, price_id: str) -> Dict:
        from ..handlers.lifecycle import SubscriptionLifecycleHandler
        from ..handlers.scheduling import SchedulingHandler
        
        await SubscriptionLifecycleHandler.handle_subscription_change(updated_subscription)
        
        old_tier = get_tier_by_price_id(updated_subscription['items']['data'][0]['price']['id'])
        new_tier = get_tier_by_price_id(price_id)
        
        old_amount = float(old_tier.monthly_credits) if old_tier else 0
        new_amount = float(new_tier.monthly_credits) if new_tier else 0
        
        # If this is an upgrade (or any plan change), cancel any scheduled downgrade
        # This ensures that if user was scheduled to downgrade but then upgrades, the downgrade is cancelled
        try:
            await SchedulingHandler.cancel_scheduled_change(account_id)
            logger.info(f"[UPGRADE] Cleared any scheduled downgrades for {account_id} after plan change")
        except Exception as e:
            logger.warning(f"[UPGRADE] Could not clear scheduled changes for {account_id}: {e}")
        
        return {
            'status': 'upgraded' if new_amount > old_amount else 'updated',
            'subscription_id': updated_subscription.id,
            'message': 'Subscription updated successfully',
            'details': {
                'is_upgrade': new_amount > old_amount,
                'current_price': old_amount,
                'new_price': new_amount
            }
        }
    
    async def _cleanup_duplicate_subscriptions(self, customer_id: str, keep_subscription_id: str, account_id: str):
        try:
            import stripe # type: ignore
            
            all_statuses = ['active', 'trialing', 'past_due', 'unpaid']
            all_subscriptions = []
            
            for status in all_statuses:
                try:
                    subs = await StripeAPIWrapper.safe_stripe_call(
                        stripe.Subscription.list_async,
                        customer=customer_id,
                        status=status,
                        limit=50
                    )
                    all_subscriptions.extend(subs.data)
                except Exception as e:
                    logger.warning(f"[CLEANUP] Could not fetch {status} subscriptions: {e}")
            
            duplicates_found = []
            for sub in all_subscriptions:
                if sub.id != keep_subscription_id and sub.status in ['active', 'trialing', 'past_due', 'unpaid']:
                    logger.info(f"[CLEANUP] Found duplicate subscription {sub.id}, canceling...")
                    try:
                        await StripeAPIWrapper.cancel_subscription(sub.id, cancel_immediately=True)
                        duplicates_found.append(sub.id)
                        await asyncio.sleep(0.5)
                    except Exception as e:
                        logger.error(f"[CLEANUP] Failed to cancel duplicate subscription {sub.id}: {e}")
            
            if duplicates_found:
                logger.info(f"[CLEANUP] ✅ Cleaned up {len(duplicates_found)} duplicate subscriptions for {account_id}")
            
        except Exception as e:
            logger.error(f"[CLEANUP] Error during subscription cleanup for {account_id}: {e}")
