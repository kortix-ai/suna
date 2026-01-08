from typing import Optional, Dict
from datetime import datetime
from .base import BaseRepository

class CommitmentRepository(BaseRepository):
    
    async def get_existing_commitment(self, subscription_id: str) -> Optional[Dict]:
        client = await self._get_client()
        result = await client.from_('commitment_history')\
            .select('id')\
            .eq('stripe_subscription_id', subscription_id)\
            .execute()
        
        return result.data[0] if result.data else None
    
    async def create_commitment_history(self, commitment_data: Dict) -> None:
        client = await self._get_client()
        await client.from_('commitment_history')\
            .insert(commitment_data)\
            .execute()
    
    async def get_commitment_status(self, account_id: str) -> Optional[Dict]:
        client = await self._get_client()
        result = await client.from_('credit_accounts')\
            .select('commitment_type, commitment_start_date, commitment_end_date, commitment_price_id')\
            .eq('account_id', account_id)\
            .execute()
        
        return result.data[0] if result.data else None
    
    async def clear_commitment(self, account_id: str) -> None:
        client = await self._get_client()
        await client.from_('credit_accounts').update({
            'commitment_type': None,
            'commitment_start_date': None,
            'commitment_end_date': None,
            'commitment_price_id': None,
            'can_cancel_after': None
        }).eq('account_id', account_id).execute()
