from typing import Optional, Dict, List
from core.billing import repo as billing_repo


class SubscriptionRepository:
    async def get_account_from_customer(self, customer_id: str) -> Optional[str]:
        result = await billing_repo.get_billing_customer_by_stripe_id(customer_id)
        return result['account_id'] if result else None
    
    async def get_credit_account_basic(self, account_id: str) -> Optional[Dict]:
        return await billing_repo.get_credit_account_subscription_info(account_id)
    
    async def get_credit_account_full(self, account_id: str) -> Optional[Dict]:
        return await billing_repo.get_credit_account(account_id)
    
    async def update_subscription_metadata(self, account_id: str, update_data: Dict) -> None:
        await billing_repo.update_credit_account(account_id, update_data)
    
    async def update_subscription_status_and_anchor(self, account_id: str, status: str, billing_anchor: str) -> None:
        await billing_repo.update_credit_account(account_id, {
            'stripe_subscription_status': status,
            'billing_cycle_anchor': billing_anchor
        })
    
    async def get_scheduled_changes(self, account_id: str) -> Optional[Dict]:
        return await billing_repo.get_credit_account_scheduled_changes(account_id)
    
    async def clear_scheduled_changes(self, account_id: str, tier_name: str) -> None:
        await billing_repo.update_credit_account(account_id, {
            'tier': tier_name,
            'scheduled_tier_change': None,
            'scheduled_tier_change_date': None,
            'scheduled_price_id': None
        })
    
    async def add_credit_ledger_entry(self, account_id: str, amount: float, balance_after: float, type: str, description: str) -> None:
        await billing_repo.insert_credit_ledger_entry(
            account_id=account_id,
            amount=amount,
            balance_after=balance_after,
            entry_type=type,
            description=description
        )
