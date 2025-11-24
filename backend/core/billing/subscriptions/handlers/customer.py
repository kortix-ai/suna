from fastapi import HTTPException
from typing import Optional

from core.utils.logger import logger
from ..repositories.customer import CustomerRepository
from ..services.customer_service import CustomerService

class CustomerHandler:
    def __init__(self):
        self.repository = CustomerRepository()
        self.service = CustomerService()
    
    @classmethod
    async def get_or_create_stripe_customer(cls, account_id: str) -> str:
        handler = cls()
        return await handler._get_or_create_stripe_customer(account_id)
    
    async def _get_or_create_stripe_customer(self, account_id: str) -> str:
        existing_customer = await self._try_get_existing_customer(account_id)
        if existing_customer:
            return existing_customer
        
        return await self._create_new_customer(account_id)
    
    async def _try_get_existing_customer(self, account_id: str) -> Optional[str]:
        customer_data = await self.repository.get_billing_customer(account_id)
        if not customer_data:
            return None
        
        customer_id = customer_data['id']
        
        if await self.service.validate_stripe_customer(customer_id):
            logger.info(f"[BILLING] Found existing Stripe customer {customer_id} for account {account_id}")
            return customer_id
        
        await self.service.cleanup_stale_customer_record(account_id)
        return None
    
    async def _create_new_customer(self, account_id: str) -> str:
        account_data = await self._get_account_data(account_id)
        user_id = account_data['primary_owner_user_id']
        
        email = await self.service.get_user_email(user_id, account_id)
        customer_id = await self.service.create_stripe_customer(email, account_id)
        
        await self.repository.create_billing_customer(customer_id, account_id, email)
        
        return customer_id
    
    async def _get_account_data(self, account_id: str) -> dict:
        account_data = await self.repository.get_account_details(account_id)
        if not account_data:
            raise HTTPException(status_code=404, detail="Account not found")
        return account_data
