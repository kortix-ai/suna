from typing import Optional, Dict
from datetime import datetime
from core.services.supabase import DBConnection

class CommitmentRepository:
    def __init__(self):
        self._db = None
    
    async def _get_client(self):
        if not self._db:
            self._db = DBConnection()
        return await self._db.client
    
    async def get_existing_commitment(self, subscription_id: str) -> bool:
        client = await self._get_client()
        result = await client.from_('commitment_history')\
            .select('id')\
            .eq('stripe_subscription_id', subscription_id)\
            .execute()
        
        return bool(result.data)
    
    async def check_user_exists(self, account_id: str) -> bool:
        client = await self._get_client()
        result = await client.from_('users')\
            .select('id')\
            .eq('id', account_id)\
            .execute()
        
        return bool(result.data)
    
    async def create_commitment_history(self, account_id: str, commitment_data: Dict) -> None:
        client = await self._get_client()
        await client.from_('commitment_history').insert(commitment_data).execute()
    
    async def update_commitment_in_credit_account(self, account_id: str, commitment_data: Dict) -> None:
        client = await self._get_client()
        await client.from_('credit_accounts').update(commitment_data).eq('account_id', account_id).execute()
