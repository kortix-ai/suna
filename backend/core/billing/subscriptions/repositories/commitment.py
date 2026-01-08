from typing import Optional, Dict
from core.billing import repo as billing_repo


class CommitmentRepository:
    async def get_existing_commitment(self, subscription_id: str) -> Optional[Dict]:
        return await billing_repo.get_existing_commitment(subscription_id)
    
    async def create_commitment_history(self, commitment_data: Dict) -> None:
        await billing_repo.create_commitment_history(commitment_data)
    
    async def get_commitment_status(self, account_id: str) -> Optional[Dict]:
        return await billing_repo.get_commitment_status(account_id)
    
    async def clear_commitment(self, account_id: str) -> None:
        await billing_repo.clear_commitment(account_id)
