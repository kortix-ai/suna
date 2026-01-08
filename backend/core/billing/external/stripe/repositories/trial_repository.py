from typing import Optional, Dict
from datetime import datetime
from core.billing import repo as billing_repo

class TrialRepository:
    async def update_trial_status(self, account_id: str, status: str, tier: str = None, subscription_id: str = None) -> None:
        update_data = {'trial_status': status}
        
        if tier:
            update_data['tier'] = tier
        if subscription_id:
            update_data['stripe_subscription_id'] = subscription_id
            
        await billing_repo.update_credit_account(account_id, update_data)
    
    async def update_trial_history(self, account_id: str, ended_at: datetime, converted: bool, status: str = None) -> None:
        update_data = {
            'ended_at': ended_at.isoformat(),
            'converted_to_paid': converted
        }
        
        if status:
            update_data['status'] = status
            
        await billing_repo.update_trial_history(account_id, update_data)
    
    async def upsert_trial_history(self, account_id: str, started_at: datetime) -> None:
        await billing_repo.upsert_trial_history(account_id, {
            'started_at': started_at.isoformat(),
            'status': 'active'
        })
