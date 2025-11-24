from typing import Optional
from fastapi import HTTPException # type: ignore
import stripe # type: ignore

from core.utils.config import config
from core.utils.logger import logger
from core.billing.external.stripe import StripeAPIWrapper
from ..repositories.customer import CustomerRepository

class CustomerService:
    def __init__(self):
        self.repository = CustomerRepository()
    
    async def validate_stripe_customer(self, customer_id: str) -> bool:
        try:
            await StripeAPIWrapper.safe_stripe_call(
                stripe.Customer.retrieve_async,
                customer_id
            )
            return True
        except stripe.error.InvalidRequestError as e:
            if 'No such customer' in str(e):
                return False
            raise
    
    async def get_user_email(self, user_id: str, account_id: str) -> str:
        email = await self._try_get_email_from_auth(user_id)
        
        if not email:
            email = await self.repository.get_user_email_by_rpc(user_id)
        
        if not email:
            logger.error(f"Could not find email for user {user_id} / account {account_id}")
            raise HTTPException(
                status_code=400, 
                detail="Unable to retrieve user email. Please ensure your account has a valid email address."
            )
        
        return email
    
    async def _try_get_email_from_auth(self, user_id: str) -> Optional[str]:
        try:
            from core.services.supabase import DBConnection
            db = DBConnection()
            client = await db.client
            user_result = await client.auth.admin.get_user_by_id(user_id)
            return user_result.user.email if user_result and user_result.user else None
        except Exception as e:
            logger.warning(f"Failed to get user via auth.admin API for user {user_id}: {e}")
            return None
    
    async def create_stripe_customer(self, email: str, account_id: str) -> str:
        customer = await StripeAPIWrapper.safe_stripe_call(
            stripe.Customer.create_async,
            email=email,
            metadata={'account_id': account_id}
        )
        return customer.id
    
    async def cleanup_stale_customer_record(self, account_id: str) -> None:
        logger.warning(f"[BILLING] Deleting stale customer record for account {account_id}")
        await self.repository.delete_billing_customer(account_id)
