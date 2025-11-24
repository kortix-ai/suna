from typing import Optional, Dict
from datetime import datetime
from core.services.supabase import DBConnection

class TrialRepository:
    def __init__(self):
        self._db = None
    
    async def _get_client(self):
        if not self._db:
            self._db = DBConnection()
        return await self._db.client
    
    async def update_trial_status(self, account_id: str, status: str, tier: str = None, subscription_id: str = None) -> None:
        client = await self._get_client()
        update_data = {'trial_status': status}
        
        if tier:
            update_data['tier'] = tier
        if subscription_id:
            update_data['stripe_subscription_id'] = subscription_id
            
        await client.from_('credit_accounts').update(update_data).eq('account_id', account_id).execute()
    
    async def update_trial_history(self, account_id: str, ended_at: datetime, converted: bool, status: str = None) -> None:
        client = await self._get_client()
        update_data = {
            'ended_at': ended_at.isoformat(),
            'converted_to_paid': converted
        }
        
        if status:
            update_data['status'] = status
            
        await client.from_('trial_history').update(update_data)\
            .eq('account_id', account_id)\
            .is_('ended_at', 'null')\
            .execute()
    
    async def upsert_trial_history(self, account_id: str, started_at: datetime) -> None:
        client = await self._get_client()
        await client.from_('trial_history').upsert({
            'account_id': account_id,
            'started_at': started_at.isoformat()
        }, on_conflict='account_id').execute()
