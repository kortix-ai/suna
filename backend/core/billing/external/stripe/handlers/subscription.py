from fastapi import HTTPException, Request
from typing import Dict
from datetime import datetime, timezone

import stripe
from core.utils.logger import logger
from core.utils.cache import Cache
from core.utils.distributed_lock import DistributedLock
from core.billing.shared.config import get_tier_by_price_id, get_plan_type, is_commitment_price_id

from ..services.subscription_service import SubscriptionService
from ..services.cleanup_service import CleanupService
from ..services.trial_service import TrialService
from ..services.commitment_service import CommitmentService
from ..services.subscription_cancellation_service import SubscriptionCancellationService
from ..services.subscription_upgrade_service import SubscriptionUpgradeService

class SubscriptionHandler:
    def __init__(self):
        self.subscription_service = SubscriptionService()
        self.cleanup_service = CleanupService()
        self.trial_service = TrialService()
        self.commitment_service = CommitmentService()
        self.cancellation_service = SubscriptionCancellationService()
        self.upgrade_service = SubscriptionUpgradeService()
    
    @classmethod
    async def handle_subscription_created_or_updated(cls, event, client):
        handler = cls()
        return await handler._handle_subscription_created_or_updated(event, client)
    
    async def _handle_subscription_created_or_updated(self, event, client):
        subscription = event.data.object
        subscription_info = self.subscription_service.extract_subscription_info(subscription)
        
        logger.info(f"[SUBSCRIPTION HANDLER] Event: {event.type}, Subscription: {subscription_info['subscription_id']}, Status: {subscription_info['status']}")
        
        if event.type == 'customer.subscription.updated':
            previous_attributes = event.data.get('previous_attributes', {})
            await self._handle_subscription_updated(event, subscription, client)
        
        if event.type == 'customer.subscription.created':
            await self._handle_subscription_created(subscription, subscription_info, client)
        
        await self._route_to_lifecycle_if_needed(event, subscription, client)
    
    async def _handle_subscription_created(self, subscription: Dict, subscription_info: Dict, client):
        logger.info(f"[SUBSCRIPTION.CREATED] Processing subscription.created for {subscription_info['subscription_id']}")
        
        account_id = await self.subscription_service.get_account_id(subscription)
        if not account_id:
            logger.warning("[SUBSCRIPTION.CREATED] No account_id found")
            return
        
        logger.info(f"[SUBSCRIPTION.CREATED] account_id={account_id}, customer_id={subscription_info['customer_id']}, price_id={subscription_info['price_id']}")
        
        await self._cleanup_duplicate_subscriptions(subscription, subscription_info, account_id)
        
        await self._process_new_subscription_by_state(account_id, subscription, subscription_info, client)
        
        await self.commitment_service.track_commitment_if_needed(
            account_id, 
            subscription_info['price_id'], 
            subscription,
            subscription_info['metadata'].get('commitment_type')
        )
    
    async def _cleanup_duplicate_subscriptions(self, subscription: Dict, subscription_info: Dict, account_id: str):
        previous_subscription_id = subscription_info['metadata'].get('previous_subscription_id')
        
        await self.cleanup_service.cleanup_duplicate_subscriptions(
            subscription_info['customer_id'],
            subscription_info['subscription_id'],
            subscription_info['price_amount'],
            previous_subscription_id
        )
    
    async def _process_new_subscription_by_state(self, account_id: str, subscription: Dict, subscription_info: Dict, client):
        account_data = await self.subscription_service.repository.get_credit_account_basic(account_id)
        if not account_data:
            logger.warning(f"[SUBSCRIPTION.CREATED] No credit account found for {account_id}")
            return
        
        current_tier = account_data.get('tier')
        trial_status = account_data.get('trial_status')
        
        if current_tier in ['free', 'none']:
            await self.upgrade_service.handle_tier_upgrade_from_free(
                account_id, subscription, current_tier
            )
        elif trial_status == 'active':
            await self._handle_trial_conversion(account_id, subscription, subscription_info)
        elif trial_status == 'cancelled':
            await self.upgrade_service.handle_cancelled_trial_resubscription(
                account_id, subscription
            )
    
    async def _handle_trial_conversion(self, account_id: str, subscription: Dict, subscription_info: Dict):
        tier_info = get_tier_by_price_id(subscription_info['price_id'])
        if not tier_info:
            logger.error(f"[TRIAL] Cannot process trial conversion - price_id {subscription_info['price_id']} not recognized")
            raise ValueError(f"Unrecognized price_id: {subscription_info['price_id']}")
        
        await self.trial_service.handle_trial_conversion(account_id, subscription, tier_info)
    
    async def _route_to_lifecycle_if_needed(self, event, subscription, client):
        if subscription.status in ['active', 'trialing']:
            previous_attributes = event.data.get('previous_attributes', {}) if event.type == 'customer.subscription.updated' else None
            
            from core.billing.subscriptions import subscription_service
            await subscription_service.handle_subscription_change(subscription, previous_attributes)
    
    @classmethod
    async def handle_subscription_deleted(cls, event, client):
        handler = cls()
        return await handler._handle_subscription_deleted(event, client)
    
    async def _handle_subscription_deleted(self, event, client):
        subscription = event.data.object
        
        account_id = await self.subscription_service.get_account_id(subscription)
        if not account_id:
            logger.warning("[DELETION] No account_id found for deleted subscription")
            return
        
        customer_id = subscription.get('customer')
        other_active_subs = []
        if customer_id:
            other_active_subs = await self.cleanup_service.check_for_other_active_subscriptions(
                customer_id, subscription.id
            )
        
        await self.cancellation_service.process_subscription_deletion(subscription, other_active_subs)
    
    async def _handle_subscription_updated(self, event, subscription, client):
        account_id = await self.subscription_service.get_account_id(subscription)
        if not account_id:
            return
        
        await self._sync_subscription_status(account_id, subscription)
        
        await self._handle_trial_status_changes(event, subscription, account_id, client)
        
        await self._handle_scheduled_downgrades(subscription, account_id, client)
        
        await self._handle_commitment_updates(event, subscription, account_id)
    


    async def _sync_subscription_status(self, account_id: str, subscription: Dict):
        try:
            billing_anchor = datetime.fromtimestamp(subscription['billing_cycle_anchor'], tz=timezone.utc)
            await self.subscription_service.repository.update_subscription_status_and_anchor(
                account_id, subscription.status, billing_anchor.isoformat()
            )
            logger.info(f"[SYNC] Synced status='{subscription.status}' & anchor='{billing_anchor}' for {account_id}")
        except Exception as e:
            logger.error(f"[SYNC] Error syncing subscription status: {e}")
    
    async def _handle_trial_status_changes(self, event, subscription: Dict, account_id: str, client):
        previous_attributes = event.data.get('previous_attributes', {})
        prev_status = previous_attributes.get('status')
        prev_default_payment = previous_attributes.get('default_payment_method')
        
        if (subscription.status == 'trialing' and 
            subscription.get('default_payment_method') and 
            not prev_default_payment):
            
            await self.trial_service.handle_payment_method_added_to_trial(account_id, subscription)
        
        if prev_status == 'trialing' and subscription.status != 'trialing':
            await self._handle_trial_end_transitions(subscription, account_id)
    
    async def _handle_trial_end_transitions(self, subscription: Dict, account_id: str):
        account_data = await self.subscription_service.repository.get_credit_account_basic(account_id)
        if not account_data:
            return
        
        current_trial_status = account_data.get('trial_status')
        if current_trial_status not in ['active', 'converted']:
            return
        
        if subscription.status == 'active':
            price_id = subscription['items']['data'][0]['price']['id']
            tier_info = get_tier_by_price_id(price_id)
            await self.trial_service.handle_trial_conversion(account_id, subscription, tier_info)
            
        elif subscription.status == 'canceled':
            await self.trial_service.handle_trial_cancellation(account_id, subscription)
    
    async def _handle_scheduled_downgrades(self, subscription: Dict, account_id: str, client):
        scheduled_changes = await self.subscription_service.repository.get_scheduled_changes(account_id)
        
        if not scheduled_changes:
            return
        
        current_price_id = subscription['items']['data'][0]['price']['id'] if subscription.get('items') else None
        
        if self.commitment_service.is_scheduled_downgrade_ready(scheduled_changes, current_price_id):
            tier_info = get_tier_by_price_id(current_price_id)
            if tier_info:
                await self.subscription_service.repository.clear_scheduled_changes(account_id, tier_info.name)
                await Cache.invalidate(f"subscription_tier:{account_id}")
                logger.info(f"[DOWNGRADE] ✅ Applied scheduled downgrade to {tier_info.name}")
    
    async def _handle_commitment_updates(self, event, subscription: Dict, account_id: str):
        price_id = subscription['items']['data'][0]['price']['id'] if subscription.get('items') else None
        previous_attributes = event.data.get('previous_attributes', {})
        prev_price_id = previous_attributes.get('items', {}).get('data', [{}])[0].get('price', {}).get('id') if previous_attributes.get('items') else None
        commitment_type = subscription.metadata.get('commitment_type')
        
        if price_id and (
            (price_id != prev_price_id and is_commitment_price_id(price_id)) or
            (commitment_type == 'yearly_commitment' and is_commitment_price_id(price_id))
        ):
            await self.commitment_service.track_commitment_if_needed(
                account_id, price_id, subscription, commitment_type
            )
    
    @classmethod  
    async def handle_trial_will_end(cls, event, client):
        subscription = event.data.object
        account_id = subscription.metadata.get('account_id')
        logger.info(f"[TRIAL] Trial will end for account {account_id}")
    
    @classmethod
    async def handle_trial_subscription(cls, subscription, account_id, new_tier, client):
        handler = cls()
        await handler.trial_service.activate_trial_for_subscription(subscription, account_id, new_tier)
