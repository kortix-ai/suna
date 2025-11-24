from typing import Optional, Dict, List
from datetime import datetime
from .base import BaseRepository

class TrialRepository(BaseRepository):
    
    async def get_trial_credits_by_description(self, account_id: str, description: str) -> Optional[List[Dict]]:
        client = await self._get_client()
        result = await client.from_('credit_ledger')\
            .select('*')\
            .eq('account_id', account_id)\
            .eq('description', description)\
            .execute()
        
        return result.data if result.data else None
    
    async def create_trial_history(self, account_id: str, started_at: datetime) -> None:
        client = await self._get_client()
        await client.from_('trial_history').upsert({
            'account_id': account_id,
            'started_at': started_at.isoformat()
        }, on_conflict='account_id').execute()
    
    async def update_trial_end(self, account_id: str, ended_at: datetime, converted: bool = True) -> None:
        client = await self._get_client()
        await client.from_('trial_history').update({
            'ended_at': ended_at.isoformat(),
            'converted_to_paid': converted
        }).eq('account_id', account_id).is_('ended_at', 'null').execute()
