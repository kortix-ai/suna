from typing import Dict, Optional

from core.utils.config import config
from core.utils.logger import logger
from core.billing.shared.config import get_tier_by_price_id
from core.billing.external.stripe import StripeAPIWrapper

from .customer import CustomerHandler
from ..services.checkout_service import CheckoutService
from ..services.subscription_upgrade_service import SubscriptionUpgradeService
from ..services.schedule_service import ScheduleService

class SubscriptionCheckoutHandler:
    def __init__(self):
        self.checkout_service = CheckoutService()
        self.upgrade_service = SubscriptionUpgradeService()
        self.schedule_service = ScheduleService()
    
    @classmethod
    async def create_checkout_session(
        cls,
        account_id: str, 
        price_id: str, 
        success_url: str, 
        cancel_url: str, 
        commitment_type: Optional[str] = None
    ) -> Dict:
        handler = cls()
        return await handler._create_checkout_session(
            account_id, price_id, success_url, cancel_url, commitment_type
        )
    
    async def _create_checkout_session(
        self,
        account_id: str, 
        price_id: str, 
        success_url: str, 
        cancel_url: str, 
        commitment_type: Optional[str] = None
    ) -> Dict:
        customer_id = await CustomerHandler.get_or_create_stripe_customer(account_id)
        subscription_status = await self.checkout_service.get_current_subscription_status(account_id)
        
        logger.info(f"[CHECKOUT ROUTING] account_id={account_id}, subscription_status={subscription_status}")
        
        idempotency_key = self.checkout_service.generate_idempotency_key(account_id, price_id, commitment_type)
        flow_type = self.checkout_service.determine_checkout_flow(subscription_status)
        
        if flow_type == 'trial_conversion':
            return await self._handle_trial_conversion(
                customer_id, account_id, price_id, success_url, cancel_url,
                subscription_status, commitment_type, idempotency_key
            )
        elif flow_type == 'upgrade_existing':
            return await self._handle_existing_subscription_upgrade(
                customer_id, account_id, price_id, success_url, cancel_url,
                subscription_status, commitment_type, idempotency_key
            )
        else:
            return await self._handle_new_subscription(
                customer_id, account_id, price_id, success_url, cancel_url,
                commitment_type, idempotency_key
            )

    async def _handle_trial_conversion(
        self,
        customer_id: str, 
        account_id: str, 
        price_id: str, 
        success_url: str,
        cancel_url: str,
        subscription_status: Dict,
        commitment_type: Optional[str], 
        idempotency_key: str
    ) -> Dict:
        new_tier_info = get_tier_by_price_id(price_id)
        tier_display_name = new_tier_info.display_name if new_tier_info else 'paid plan'

        existing_subscription_id = subscription_status['subscription_id']
        
        # DON'T cancel here - pass the subscription ID to cancel in the webhook
        # This ensures if user abandons checkout, they still have their trial
        metadata = self.checkout_service.build_subscription_metadata(
            account_id, commitment_type, 'trial_conversion', 
            subscription_status['current_tier'], existing_subscription_id
        )
        # Mark which subscription to cancel after checkout succeeds
        metadata['cancel_after_checkout'] = existing_subscription_id

        session = await self._create_stripe_checkout_session(
            customer_id, price_id, success_url, metadata, idempotency_key, cancel_url
        )
        
        return self.checkout_service.build_checkout_response(
            session, 'trial_conversion', new_tier_info, tier_display_name
        )
    
    async def _cancel_existing_subscription(self, subscription_id: str, reason: str) -> None:
        if not subscription_id:
            return
            
        try:
            await StripeAPIWrapper.cancel_subscription(subscription_id, cancel_immediately=True)
            logger.info(f"[{reason.upper()}] Successfully cancelled subscription {subscription_id}")
        except Exception as e:
            logger.warning(f"[{reason.upper()}] Could not cancel existing subscription {subscription_id}: {e}")
    
    async def _create_stripe_checkout_session(
        self,
        customer_id: str,
        price_id: str,
        success_url: str,
        metadata: Dict,
        idempotency_key: str,
        cancel_url: str = None
    ):
        """
        Create a Stripe checkout session.
        By default uses hosted mode (Stripe's hosted checkout page).
        """
        return await StripeAPIWrapper.create_checkout_session(
            customer=customer_id,
            payment_method_types=['card'],
            line_items=[{'price': price_id, 'quantity': 1}],
            mode='subscription',
            success_url=success_url,
            cancel_url=cancel_url or success_url,
            allow_promotion_codes=True,
            subscription_data={'metadata': metadata},
            idempotency_key=idempotency_key
        )

    async def _handle_existing_subscription_upgrade(
        self,
        customer_id: str,
        account_id: str, 
        price_id: str,
        success_url: str,
        cancel_url: str,
        subscription_status: Dict,
        commitment_type: Optional[str],
        idempotency_key: str
    ) -> Dict:
        existing_subscription_id = subscription_status['subscription_id']
        subscription = await StripeAPIWrapper.retrieve_subscription(existing_subscription_id)
        
        current_amount = subscription['items']['data'][0]['price'].get('unit_amount', 0) or 0
        current_tier = subscription_status['current_tier']
        
        if current_amount == 0 or current_tier == 'free':
            return await self._handle_free_tier_upgrade(
                customer_id, account_id, price_id, success_url, cancel_url,
                subscription_status, commitment_type, idempotency_key
            )
        
        upgrade_type = self.upgrade_service.classify_upgrade_type(subscription, price_id)
        
        if upgrade_type == 'yearly_to_monthly':
            return await self.upgrade_service.perform_yearly_to_monthly_upgrade(
                account_id, subscription, price_id
            )
        elif upgrade_type == 'yearly_to_yearly':
            return await self.upgrade_service.perform_yearly_to_yearly_upgrade(
                account_id, subscription, price_id
            )
        elif upgrade_type == 'yearly_schedule_change':
            return await self.schedule_service.schedule_yearly_plan_change(
                account_id, subscription, price_id, commitment_type
            )
        else:
            # For standard paid-to-paid upgrades, use Stripe's subscription modification API
            # This is instant and handles proration automatically - no checkout needed since 
            # payment method is already on file
            logger.info(f"[STANDARD UPGRADE] Modifying subscription in-place from {current_tier} to {price_id}")
            
            result = await self.upgrade_service.perform_standard_upgrade(
                existing_subscription_id, subscription, price_id, account_id
            )
            await self.checkout_service.invalidate_caches(account_id)
            return result

    async def _handle_free_tier_upgrade(
        self,
        customer_id: str,
        account_id: str,
        price_id: str,
        success_url: str,
        cancel_url: str,
        subscription_status: Dict,
        commitment_type: Optional[str],
        idempotency_key: str
    ) -> Dict:
        new_tier_info = get_tier_by_price_id(price_id)
        tier_display_name = new_tier_info.display_name if new_tier_info else 'paid plan'
        
        existing_subscription_id = subscription_status['subscription_id']
        
        # DON'T cancel here - pass the subscription ID to cancel in the webhook
        # This ensures if user abandons checkout, they still have their free tier
        metadata = self.checkout_service.build_subscription_metadata(
            account_id, commitment_type, 'free_upgrade', 
            subscription_status['current_tier'], existing_subscription_id
        )
        # Mark which subscription to cancel after checkout succeeds
        metadata['cancel_after_checkout'] = existing_subscription_id

        session = await self._create_stripe_checkout_session(
            customer_id, price_id, success_url, metadata, idempotency_key, cancel_url
        )
        
        return self.checkout_service.build_checkout_response(
            session, 'free_upgrade', new_tier_info, tier_display_name
        )

    async def _handle_new_subscription(
        self,
        customer_id: str,
        account_id: str,
        price_id: str,
        success_url: str,
        cancel_url: str,
        commitment_type: Optional[str],
        idempotency_key: str
    ) -> Dict:
        metadata = self.checkout_service.build_subscription_metadata(
            account_id, commitment_type, 'new_subscription'
        )

        session = await self._create_stripe_checkout_session(
            customer_id, price_id, success_url, metadata, idempotency_key, cancel_url
        )
        
        return self.checkout_service.build_checkout_response(session)