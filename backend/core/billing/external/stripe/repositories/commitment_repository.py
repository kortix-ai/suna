from typing import Optional, Dict
from datetime import datetime
from core.billing import repo as billing_repo


class CommitmentRepository:
    async def get_existing_commitment(self, subscription_id: str) -> bool:
        result = await billing_repo.get_existing_commitment(subscription_id)
        return result is not None
    
    async def check_user_exists(self, account_id: str) -> bool:
        result = await billing_repo.get_account_details(account_id)
        return result is not None
    
    async def create_commitment_history(self, account_id: str, commitment_data: Dict) -> None:
        data = {'account_id': account_id, **commitment_data}
        await billing_repo.create_commitment_history(data)
    
    async def update_commitment_in_credit_account(self, account_id: str, commitment_data: Dict) -> None:
        await billing_repo.update_credit_account(account_id, commitment_data)
