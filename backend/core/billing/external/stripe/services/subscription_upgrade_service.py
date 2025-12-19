from typing import Dict, Optional
from datetime import datetime, timezone
from core.utils.logger import logger
from core.billing.shared.config import get_tier_by_price_id, is_commitment_price_id
from ..repositories.subscription_repository import SubscriptionRepository
from .commitment_service import CommitmentService
from core.billing.shared.config import get_plan_type

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
        
        # Get subscription status - handle both object and dict access
        subscription_status = getattr(subscription, 'status', None) or subscription.get('status')
        
        billing_dates = self._calculate_billing_dates(subscription)
        plan_type = get_plan_type(price_id)
        
        # Block tier setting for ANY non-active status (incomplete, incomplete_expired, canceled, etc.)
        # Only set tier when subscription is definitely active and payment succeeded
        if subscription_status != 'active':
            # Payment is pending or failed - do NOT set tier yet
            # Tier will be set when subscription becomes 'active' via subscription.updated webhook
            logger.info(f"[UPGRADE] Subscription status '{subscription_status}' is not active - storing pending subscription without setting tier for {account_id}")
            
            # Only store the pending subscription reference, NOT the tier
            await self.subscription_repo.update_subscription_metadata(account_id, {
                'stripe_subscription_id': subscription['id'],
                'stripe_subscription_status': subscription_status or 'unknown',
                'payment_status': 'pending'
            })
            return  # Don't proceed further until payment succeeds
        
        # subscription_status == 'active' - safe to set tier
        logger.info(f"[UPGRADE] User {account_id} upgrading from {current_tier} to {tier_info.name}")
        
        await self.subscription_repo.update_subscription_metadata(account_id, {
            'tier': tier_info.name,
            'plan_type': plan_type,
            'stripe_subscription_id': subscription['id'],
            'billing_cycle_anchor': billing_dates['billing_anchor_iso'],
            'next_credit_grant': billing_dates['next_grant_date_iso']
        })
    
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
    