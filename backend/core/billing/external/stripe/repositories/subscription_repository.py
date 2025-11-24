from typing import Optional, Dict, List
from core.services.supabase import DBConnection

class SubscriptionRepository:
    def __init__(self):
        self._db = None
    
    async def _get_client(self):
        if not self._db:
            self._db = DBConnection()
        return await self._db.client
    
    async def get_account_from_customer(self, customer_id: str) -> Optional[str]:
        client = await self._get_client()
        result = await client.schema('basejump').from_('billing_customers')\
            .select('account_id')\
            .eq('id', customer_id)\
            .execute()
        
        return result.data[0]['account_id'] if result.data else None
    
    async def get_credit_account_basic(self, account_id: str) -> Optional[Dict]:
        client = await self._get_client()
        result = await client.from_('credit_accounts').select(
            'trial_status, tier, stripe_subscription_id'
        ).eq('account_id', account_id).execute()
        
        return result.data[0] if result.data else None
    
    async def get_credit_account_full(self, account_id: str) -> Optional[Dict]:
        client = await self._get_client()
        result = await client.from_('credit_accounts').select(
            'trial_status, tier, commitment_type, balance, expiring_credits, non_expiring_credits, stripe_subscription_id, provider, revenuecat_subscription_id, revenuecat_product_id'
        ).eq('account_id', account_id).execute()
        
        return result.data[0] if result.data else None
    
    async def update_subscription_metadata(self, account_id: str, update_data: Dict) -> None:
        client = await self._get_client()
        await client.from_('credit_accounts').update(update_data).eq('account_id', account_id).execute()
    
    async def update_subscription_status_and_anchor(self, account_id: str, status: str, billing_anchor: str) -> None:
        client = await self._get_client()
        await client.from_('credit_accounts').update({
            'stripe_subscription_status': status,
            'billing_cycle_anchor': billing_anchor
        }).eq('account_id', account_id).execute()
    
    async def get_scheduled_changes(self, account_id: str) -> Optional[Dict]:
        client = await self._get_client()
        result = await client.from_('credit_accounts').select(
            'scheduled_tier_change, scheduled_price_id, tier'
        ).eq('account_id', account_id).execute()
        
        return result.data[0] if result.data else None
    
    async def clear_scheduled_changes(self, account_id: str, tier_name: str) -> None:
        client = await self._get_client()
        await client.from_('credit_accounts').update({
            'tier': tier_name,
            'scheduled_tier_change': None,
            'scheduled_tier_change_date': None,
            'scheduled_price_id': None
        }).eq('account_id', account_id).execute()
    
    async def add_credit_ledger_entry(self, account_id: str, amount: float, balance_after: float, type: str, description: str) -> None:
        client = await self._get_client()
        await client.from_('credit_ledger').insert({
            'account_id': account_id,
            'amount': amount,
            'balance_after': balance_after,
            'type': type,
            'description': description
        }).execute()
