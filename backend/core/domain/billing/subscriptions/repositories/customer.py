from typing import Optional, Dict
from .base import BaseRepository

class CustomerRepository(BaseRepository):
    
    async def get_billing_customer(self, account_id: str) -> Optional[Dict]:
        client = await self._get_client()
        result = await client.schema('basejump').from_('billing_customers')\
            .select('id, email')\
            .eq('account_id', account_id)\
            .execute()
        
        return result.data[0] if result.data else None
    
    async def delete_billing_customer(self, account_id: str) -> None:
        client = await self._get_client()
        await client.schema('basejump').from_('billing_customers')\
            .delete()\
            .eq('account_id', account_id)\
            .execute()
    
    async def get_account_details(self, account_id: str) -> Optional[Dict]:
        client = await self._get_client()
        result = await client.schema('basejump').from_('accounts')\
            .select('id, name, personal_account, primary_owner_user_id')\
            .eq('id', account_id)\
            .execute()
        
        return result.data[0] if result.data else None
    
    async def create_billing_customer(self, customer_id: str, account_id: str, email: str) -> None:
        client = await self._get_client()
        await client.schema('basejump').from_('billing_customers').insert({
            'id': customer_id,
            'account_id': account_id,
            'email': email
        }).execute()
    
    async def get_user_email_by_rpc(self, user_id: str) -> Optional[str]:
        client = await self._get_client()
        try:
            result = await client.rpc('get_user_email', {'user_id': user_id}).execute()
            return result.data if result.data else None
        except Exception:
            return None
