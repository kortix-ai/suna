from typing import Dict, Optional
from datetime import datetime, timezone

from core.utils.logger import logger
from core.billing.shared.config import get_tier_by_price_id, get_plan_type
from core.billing.external.stripe.client import StripeAPIWrapper
from ..repositories.subscription_repository import SubscriptionRepository

class SubscriptionService:
    def __init__(self):
        self.repository = SubscriptionRepository()
    
    async def get_account_id(self, subscription: Dict) -> Optional[str]:
        account_id = subscription.get('metadata', {}).get('account_id')
        
        if not account_id:
            customer_id = subscription.get('customer')
            if customer_id:
                account_id = await self.repository.get_account_from_customer(customer_id)
                
        return account_id
    
    def extract_subscription_info(self, subscription: Dict) -> Dict:
        price_id = subscription['items']['data'][0]['price']['id'] if subscription.get('items') else None
        price_amount = subscription['items']['data'][0]['price'].get('unit_amount', 0) or 0 if subscription.get('items') else 0
        
        return {
            'subscription_id': subscription.get('id'),
            'customer_id': subscription.get('customer'),
            'price_id': price_id,
            'price_amount': price_amount,
            'status': subscription.get('status'),
            'current_period_start': subscription.get('current_period_start'),
            'current_period_end': subscription.get('current_period_end'),
            'metadata': subscription.get('metadata', {})
        }
    
    def is_tier_upgrade(self, current_tier_info, prev_tier_info) -> bool:
        return (current_tier_info and prev_tier_info and 
                current_tier_info.name != prev_tier_info.name and
                float(current_tier_info.monthly_credits) > float(prev_tier_info.monthly_credits))
    
    def should_skip_due_to_timing(self, subscription: Dict, previous_attributes: Dict) -> bool:
        current_period_start = subscription.get('current_period_start')
        if not current_period_start:
            return False
            
        now = datetime.now(timezone.utc).timestamp()
        time_since_period = now - current_period_start
        
        prev_status = previous_attributes.get('status') if previous_attributes else None
        current_status = subscription.get('status')
        is_incomplete_to_active = prev_status == 'incomplete' and current_status == 'active'
        
        return 0 <= time_since_period < 1800 and not is_incomplete_to_active
    
    def has_period_change(self, subscription: Dict, previous_attributes: Dict) -> bool:
        if not previous_attributes or 'current_period_start' not in previous_attributes:
            return False
            
        prev_period = previous_attributes.get('current_period_start')
        curr_period = subscription.get('current_period_start')
        return prev_period != curr_period
    
    async def update_subscription_metadata_via_stripe(self, subscription_id: str, metadata: Dict) -> None:
        try:
            await StripeAPIWrapper.modify_subscription(subscription_id, metadata=metadata)
            logger.info(f"[SUBSCRIPTION] Updated Stripe metadata for subscription {subscription_id}")
        except Exception as e:
            logger.error(f"[SUBSCRIPTION] Failed to update subscription metadata: {e}")
    
    def calculate_billing_dates(self, subscription: Dict) -> Dict:
        billing_anchor = datetime.fromtimestamp(subscription['current_period_start'], tz=timezone.utc)
        next_grant_date = datetime.fromtimestamp(subscription['current_period_end'], tz=timezone.utc)
        
        return {
            'billing_anchor': billing_anchor,
            'next_grant_date': next_grant_date,
            'billing_anchor_iso': billing_anchor.isoformat(),
            'next_grant_date_iso': next_grant_date.isoformat()
        }
