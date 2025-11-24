from typing import Optional, Dict, List
from datetime import datetime
from .base import BaseRepository

class CreditAccountRepository(BaseRepository):
    
    async def get_credit_account(self, account_id: str, fields: str = '*') -> Optional[Dict]:
        client = await self._get_client()
        result = await client.from_('credit_accounts')\
            .select(fields)\
            .eq('account_id', account_id)\
            .execute()
        
        return result.data[0] if result.data else None
    
    async def get_credit_account_with_subscription(self, account_id: str) -> Optional[Dict]:
        fields = 'stripe_subscription_id, trial_status, tier'
        return await self.get_credit_account(account_id, fields)
    
    async def update_credit_account(self, account_id: str, update_data: Dict) -> None:
        client = await self._get_client()
        await client.from_('credit_accounts')\
            .update(update_data)\
            .eq('account_id', account_id)\
            .execute()
    
    async def get_subscription_details(self, account_id: str) -> Optional[Dict]:
        fields = 'stripe_subscription_id, tier, commitment_type, commitment_end_date'
        return await self.get_credit_account(account_id, fields)
    
    async def get_scheduled_changes(self, account_id: str) -> Optional[Dict]:
        fields = 'stripe_subscription_id, tier, scheduled_tier_change, scheduled_tier_change_date, scheduled_price_id'
        return await self.get_credit_account(account_id, fields)
    
    async def clear_scheduled_changes(self, account_id: str) -> None:
        update_data = {
            'scheduled_tier_change': None,
            'scheduled_tier_change_date': None,
            'scheduled_price_id': None
        }
        await self.update_credit_account(account_id, update_data)
    
    async def check_renewal_already_processed(self, account_id: str, period_start: int) -> Optional[Dict]:
        client = await self._get_client()
        result = await client.rpc('check_renewal_already_processed', {
            'p_account_id': account_id,
            'p_period_start': period_start
        }).execute()
        
        return result.data if result.data else None
    
    async def update_trial_status(self, account_id: str, status: str) -> None:
        await self.update_credit_account(account_id, {'trial_status': status})
    
    async def update_commitment_info(self, account_id: str, commitment_data: Dict) -> None:
        await self.update_credit_account(account_id, commitment_data)
