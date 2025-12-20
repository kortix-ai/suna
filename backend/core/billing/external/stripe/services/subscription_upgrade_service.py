from typing import Dict, Optional
from datetime import datetime, timezone
from decimal import Decimal
from core.utils.logger import logger
from core.utils.distributed_lock import DistributedLock
from core.billing.shared.config import get_tier_by_price_id, is_commitment_price_id
from ..repositories.subscription_repository import SubscriptionRepository
from .commitment_service import CommitmentService
from core.billing.shared.config import get_plan_type
from core.billing.credits.manager import credit_manager

class SubscriptionUpgradeService:
    def __init__(self):
        self.subscription_repo = SubscriptionRepository()
        self.commitment_service = CommitmentService()
    
    async def handle_tier_upgrade_from_free(
        self, 
        account_id: str, 
        subscription: Dict, 
        current_tier: str
    ) -> None:
        price_id = subscription['items']['data'][0]['price']['id'] if subscription.get('items') else None
        tier_info = get_tier_by_price_id(price_id)
        
        if not tier_info:
            logger.error(f"[UPGRADE] Cannot process upgrade - price_id {price_id} not recognized")
            raise ValueError(f"Unrecognized price_id: {price_id}")
        
        subscription_status = getattr(subscription, 'status', None) or subscription.get('status')
        
        billing_dates = self._calculate_billing_dates(subscription)
        plan_type = get_plan_type(price_id)
        
        if subscription_status != 'active':
            logger.info(f"[UPGRADE] Subscription status '{subscription_status}' is not active - storing pending subscription without setting tier for {account_id}")
            
            await self.subscription_repo.update_subscription_metadata(account_id, {
                'stripe_subscription_id': subscription['id'],
                'stripe_subscription_status': subscription_status or 'unknown',
                'payment_status': 'pending'
            })
            return
        
        logger.info(f"[UPGRADE] User {account_id} upgrading from {current_tier} to {tier_info.name}")
        
        lock_key = f"credit_grant:free_upgrade:{account_id}"
        lock = DistributedLock(lock_key, timeout_seconds=60)
        
        acquired = await lock.acquire(wait=True, wait_timeout=30)
        if not acquired:
            logger.error(f"[UPGRADE] Failed to acquire lock for free tier upgrade credit grant to {account_id}")
            await self.subscription_repo.update_subscription_metadata(account_id, {
                'tier': tier_info.name,
                'plan_type': plan_type,
                'stripe_subscription_id': subscription['id'],
                'billing_cycle_anchor': billing_dates['billing_anchor_iso'],
                'next_credit_grant': billing_dates['next_grant_date_iso']
            })
            return
        
        try:
            if tier_info.monthly_refill_enabled:
                credits_amount = Decimal(str(tier_info.monthly_credits))
                logger.info(f"[UPGRADE] Granting ${credits_amount} credits for new {tier_info.name} subscription (upgrade from {current_tier})")
                
                await credit_manager.add_credits(
                    account_id=account_id,
                    amount=credits_amount,
                    is_expiring=True,
                    description=f"New subscription: {tier_info.name} (upgrade from {current_tier})",
                    expires_at=billing_dates['next_grant_date'],
                    stripe_event_id=f"free_upgrade_{account_id}_{subscription['id']}"
                )
                logger.info(f"[UPGRADE] ✅ Granted ${credits_amount} credits to {account_id}")
            else:
                logger.info(f"[UPGRADE] Skipping credits for tier {tier_info.name} - monthly_refill_enabled=False")
            
            await self.subscription_repo.update_subscription_metadata(account_id, {
                'tier': tier_info.name,
                'plan_type': plan_type,
                'stripe_subscription_id': subscription['id'],
                'billing_cycle_anchor': billing_dates['billing_anchor_iso'],
                'next_credit_grant': billing_dates['next_grant_date_iso'],
                'last_grant_date': billing_dates['billing_anchor_iso']
            })
        finally:
            await lock.release()
    
    async def handle_incomplete_to_active_upgrade(
        self, 
        account_id: str, 
        subscription: Dict,
        current_tier: str
    ) -> None:
        if current_tier not in ['free', 'none']:
            return
        
        price_id = subscription['items']['data'][0]['price']['id']
        tier_info = get_tier_by_price_id(price_id)
        
        if not tier_info:
            logger.error(f"[UPGRADE] Cannot process incomplete→active - price_id {price_id} not recognized")
            raise ValueError(f"Unrecognized price_id: {price_id}")
        
        billing_dates = self._calculate_billing_dates(subscription)
        
        logger.info(f"[UPGRADE] User {account_id} upgrading from {current_tier} via incomplete→active to {tier_info.name}")
        
        await self.subscription_repo.update_subscription_metadata(account_id, {
            'tier': tier_info.name,
            'stripe_subscription_id': subscription['id'],
            'billing_cycle_anchor': billing_dates['billing_anchor_iso'],
            'next_credit_grant': billing_dates['next_grant_date_iso'],
            'last_grant_date': billing_dates['billing_anchor_iso']
        })
    
    async def handle_cancelled_trial_resubscription(self, account_id: str, subscription: Dict) -> None:
        if subscription.status != 'active':
            return
        
        price_id = subscription['items']['data'][0]['price']['id']
        tier_info = get_tier_by_price_id(price_id)
        
        if not tier_info:
            logger.error(f"[RESUBSCRIPTION] Cannot process - price_id {price_id} not recognized")
            raise ValueError(f"Unrecognized price_id: {price_id}")
        
        billing_dates = self._calculate_billing_dates(subscription)
        
        logger.info(f"[RESUBSCRIPTION] User {account_id} with cancelled trial subscribing to {tier_info.name}")
        
        await self.subscription_repo.update_subscription_metadata(account_id, {
            'trial_status': 'none',
            'tier': tier_info.name,
            'stripe_subscription_id': subscription['id'],
            'billing_cycle_anchor': billing_dates['billing_anchor_iso'],
            'next_credit_grant': billing_dates['next_grant_date_iso'],
            'last_grant_date': billing_dates['billing_anchor_iso']
        })
    
    def _calculate_billing_dates(self, subscription: Dict) -> Dict:
        billing_anchor = datetime.fromtimestamp(subscription['current_period_start'], tz=timezone.utc)
        next_grant_date = datetime.fromtimestamp(subscription['current_period_end'], tz=timezone.utc)
        
        return {
            'billing_anchor': billing_anchor,
            'next_grant_date': next_grant_date,
            'billing_anchor_iso': billing_anchor.isoformat(),
            'next_grant_date_iso': next_grant_date.isoformat()
        }
    