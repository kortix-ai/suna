from typing import Dict, Optional, List
import stripe # type: ignore
from core.utils.config import config
from .handlers.customer import CustomerHandler
from .handlers.retrieval import SubscriptionRetrievalHandler
from .handlers.checkout import SubscriptionCheckoutHandler
from .handlers.portal import PortalHandler
from .handlers.sync import SubscriptionSyncHandler
from .handlers.lifecycle import SubscriptionLifecycleHandler
from .handlers.tier import TierHandler
from .handlers.scheduling import SchedulingHandler

class SubscriptionService:
    def __init__(self):
        self.stripe = stripe
        stripe.api_key = config.STRIPE_SECRET_KEY
    
    async def get_or_create_stripe_customer(self, account_id: str) -> str:
        return await CustomerHandler.get_or_create_stripe_customer(account_id)
    
    async def get_subscription(self, account_id: str) -> Dict:
        return await SubscriptionRetrievalHandler.get_subscription(account_id)
    
    async def create_checkout_session(
        self, 
        account_id: str, 
        price_id: str, 
        success_url: str, 
        cancel_url: str, 
        commitment_type: Optional[str] = None
    ) -> Dict:
        return await SubscriptionCheckoutHandler.create_checkout_session(
            account_id, price_id, success_url, cancel_url, commitment_type
        )
    
    async def create_portal_session(self, account_id: str, return_url: str) -> Dict:
        return await PortalHandler.create_portal_session(account_id, return_url)
    
    async def sync_subscription(self, account_id: str) -> Dict:
        return await SubscriptionSyncHandler.sync_subscription(account_id)
    
    async def cancel_subscription(self, account_id: str, feedback: Optional[str] = None) -> Dict:
        return await SubscriptionLifecycleHandler.cancel_subscription(account_id, feedback)
    
    async def reactivate_subscription(self, account_id: str) -> Dict:
        return await SubscriptionLifecycleHandler.reactivate_subscription(account_id)
    
    async def handle_subscription_change(self, subscription: Dict, previous_attributes: Dict = None):
        return await SubscriptionLifecycleHandler.handle_subscription_change(subscription, previous_attributes)
    
    async def get_user_subscription_tier(self, account_id: str, skip_cache: bool = False) -> Dict:
        return await TierHandler.get_user_subscription_tier(account_id, skip_cache)
    
    async def get_allowed_models_for_user(self, user_id: str, client=None) -> List[str]:
        return await TierHandler.get_allowed_models_for_user(user_id, client)
    
    async def schedule_tier_downgrade(
        self, 
        account_id: str, 
        target_tier_key: str, 
        commitment_type: Optional[str] = None
    ) -> Dict:
        return await SchedulingHandler.schedule_tier_downgrade(account_id, target_tier_key, commitment_type)
    
    async def get_commitment_status(self, account_id: str) -> Dict:
        return await SchedulingHandler.get_commitment_status(account_id)
    
    async def get_scheduled_changes(self, account_id: str) -> Dict:
        return await SchedulingHandler.get_scheduled_changes(account_id)
    
    async def cancel_scheduled_change(self, account_id: str) -> Dict:
        return await SchedulingHandler.cancel_scheduled_change(account_id)


subscription_service = SubscriptionService()
