from typing import Optional, Dict, List
from datetime import datetime
from core.billing import repo as billing_repo


class CreditAccountRepository:
    """Credit account repository using SQLAlchemy."""
    
    async def get_credit_account(self, account_id: str, fields: str = '*') -> Optional[Dict]:
        """Get credit account. Note: fields parameter is ignored, always returns all fields."""
        return await billing_repo.get_credit_account_by_id(account_id)
    
    async def get_credit_account_with_subscription(self, account_id: str) -> Optional[Dict]:
        return await billing_repo.get_credit_account_subscription_info(account_id)
    
    async def update_credit_account(self, account_id: str, update_data: Dict) -> None:
        await billing_repo.update_credit_account(account_id, update_data)
    
    async def get_subscription_details(self, account_id: str) -> Optional[Dict]:
        return await billing_repo.get_credit_account_subscription_details(account_id)
    
    async def get_scheduled_changes(self, account_id: str) -> Optional[Dict]:
        return await billing_repo.get_credit_account_scheduled_changes(account_id)
    
    async def clear_scheduled_changes(self, account_id: str) -> None:
        await billing_repo.clear_credit_account_scheduled_changes(account_id)
    
    async def check_renewal_already_processed(self, account_id: str, period_start: int) -> Optional[Dict]:
        return await billing_repo.check_renewal_already_processed(account_id, period_start)
    
    async def update_trial_status(self, account_id: str, status: str) -> None:
        await billing_repo.update_credit_account(account_id, {'trial_status': status})
    
    async def update_commitment_info(self, account_id: str, commitment_data: Dict) -> None:
        await billing_repo.update_credit_account(account_id, commitment_data)
