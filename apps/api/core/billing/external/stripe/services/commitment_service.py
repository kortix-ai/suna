from typing import Dict
from datetime import datetime, timezone, timedelta

from core.utils.logger import logger
from core.billing.shared.config import (
    is_commitment_price_id, 
    get_commitment_duration_months
)
from ..repositories.commitment_repository import CommitmentRepository

class CommitmentService:
    def __init__(self):
        self.commitment_repo = CommitmentRepository()
    
    async def track_commitment_if_needed(
        self, 
        account_id: str, 
        price_id: str, 
        subscription: Dict,
        commitment_type: str = None
    ) -> None:
        if not is_commitment_price_id(price_id) and commitment_type != 'yearly_commitment':
            return
        
        if await self.commitment_repo.get_existing_commitment(subscription['id']):
            logger.info(f"[COMMITMENT] Commitment already tracked for subscription {subscription['id']}")
            return
        
        commitment_duration = get_commitment_duration_months(price_id)
        if commitment_duration == 0:
            return
        
        start_date = datetime.fromtimestamp(subscription['current_period_start'], tz=timezone.utc)
        end_date = start_date + timedelta(days=365) if commitment_duration == 12 else start_date + timedelta(days=commitment_duration * 30)
        
        commitment_data = {
            'commitment_type': 'yearly_commitment',
            'commitment_start_date': start_date.isoformat(),
            'commitment_end_date': end_date.isoformat(),
            'commitment_price_id': price_id,
            'can_cancel_after': end_date.isoformat()
        }
        
        await self.commitment_repo.update_commitment_in_credit_account(account_id, commitment_data)
        
        if await self.commitment_repo.check_user_exists(account_id):
            await self.commitment_repo.create_commitment_history(account_id, {
                'account_id': account_id,
                'commitment_type': 'yearly_commitment',
                'price_id': price_id,
                'start_date': start_date.isoformat(),
                'end_date': end_date.isoformat(),
                'stripe_subscription_id': subscription['id']
            })
            
            logger.info(f"[COMMITMENT] Tracked yearly commitment for {account_id}, ends {end_date.date()}")
        else:
            logger.warning(f"[COMMITMENT] User {account_id} not found, skipped commitment_history")
    
    async def clear_commitment_if_needed(self, account_id: str) -> None:
        await self.commitment_repo.update_commitment_in_credit_account(account_id, {
            'commitment_type': None,
            'commitment_start_date': None,
            'commitment_end_date': None,
            'commitment_price_id': None,
            'can_cancel_after': None
        })
        
        logger.info(f"[COMMITMENT] Cleared commitment fields for {account_id}")
    
    def is_scheduled_downgrade_ready(
        self, 
        scheduled_changes: Dict, 
        current_price_id: str
    ) -> bool:
        if not scheduled_changes:
            return False
            
        scheduled_price_id = scheduled_changes.get('scheduled_price_id')
        return scheduled_price_id and current_price_id == scheduled_price_id
