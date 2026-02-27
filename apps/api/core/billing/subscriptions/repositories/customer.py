from typing import Optional, Dict
from core.billing import repo as billing_repo

class CustomerRepository:
    async def get_billing_customer(self, account_id: str) -> Optional[Dict]:
        return await billing_repo.get_billing_customer(account_id)
    
    async def delete_billing_customer(self, account_id: str) -> None:
        await billing_repo.delete_billing_customer(account_id)
    
    async def get_account_details(self, account_id: str) -> Optional[Dict]:
        return await billing_repo.get_account_details(account_id)
    
    async def create_billing_customer(self, customer_id: str, account_id: str, email: str) -> None:
        await billing_repo.create_billing_customer(customer_id, account_id, email)
    
    async def get_user_email_by_rpc(self, user_id: str) -> Optional[str]:
        return await billing_repo.get_user_email(user_id)
