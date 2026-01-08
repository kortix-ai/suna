from typing import Optional, Dict, List
from datetime import datetime
from core.billing import repo as billing_repo


class TrialRepository:
    """Trial repository using SQLAlchemy."""
    
    async def get_trial_credits_by_description(self, account_id: str, description: str) -> Optional[List[Dict]]:
        return await billing_repo.get_trial_credits_by_description(account_id, description)
    
    async def create_trial_history(self, account_id: str, started_at: datetime) -> None:
        await billing_repo.create_trial_history(account_id, started_at)
    
    async def update_trial_end(self, account_id: str, ended_at: datetime, converted: bool = True) -> None:
        await billing_repo.update_trial_end(account_id, ended_at, converted)
