from typing import Dict
import stripe

from core.billing.external.stripe import StripeAPIWrapper
from .customer import CustomerHandler

class PortalHandler:
    @staticmethod
    async def create_portal_session(account_id: str, return_url: str) -> Dict:
        customer_id = await CustomerHandler.get_or_create_stripe_customer(account_id)
        
        session = await StripeAPIWrapper.safe_stripe_call(
            stripe.billing_portal.Session.create_async,
            customer=customer_id,
            return_url=return_url
        )
        
        return {'portal_url': session.url}
