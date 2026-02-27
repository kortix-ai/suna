from typing import Dict, Optional
from datetime import datetime, timezone

from core.utils.logger import logger
from core.utils.cache import Cache
from core.utils.distributed_lock import DistributedLock
from core.billing.shared.config import TRIAL_DURATION_DAYS, TRIAL_CREDITS, get_plan_type
from core.billing.credits.manager import credit_manager
from ..repositories.credit_account import CreditAccountRepository
from ..repositories.trial import TrialRepository

class TrialService:
    def __init__(self):
        self.credit_repo = CreditAccountRepository()
        self.trial_repo = TrialRepository()
    
    async def activate_trial(self, account_id: str, subscription: Dict, tier: Dict) -> None:
        if not subscription.get('trial_end'):
            return
        
        lock_key = f"credit_grant:trial:{account_id}"
        lock = DistributedLock(lock_key, timeout_seconds=60)
        
        acquired = await lock.acquire(wait=True, wait_timeout=30)
        if not acquired:
            logger.error(f"[TRIAL GRANT] Failed to acquire lock for trial grant to {account_id}")
            return
        
        try:
            logger.info(f"[TRIAL GRANT] 🔒 Acquired lock for trial activation for {account_id}")
            
            # Check if trial is already active
            existing_account = await self.credit_repo.get_credit_account(account_id, 'trial_status')
            if existing_account:
                current_status = existing_account.get('trial_status')
                if current_status == 'active':
                    logger.info(f"[TRIAL] Trial already active for account {account_id}, skipping")
                    return
            
            # Check for existing trial credits
            trial_description = f'{TRIAL_DURATION_DAYS}-day free trial credits'
            recent_trial_credits = await self.trial_repo.get_trial_credits_by_description(
                account_id, trial_description
            )
            
            if recent_trial_credits:
                logger.warning(f"[TRIAL] Trial credits already granted for account {account_id}, skipping")
                return
            
            trial_ends_at = datetime.fromtimestamp(subscription.trial_end, tz=timezone.utc)
            plan_type = get_plan_type(subscription['items']['data'][0]['price']['id'])
            
            # Update trial status
            await self.credit_repo.update_credit_account(account_id, {
                'trial_status': 'active',
                'trial_started_at': datetime.now(timezone.utc).isoformat(),
                'trial_ends_at': trial_ends_at.isoformat(),
                'stripe_subscription_id': subscription['id'],
                'tier': tier['name'],
                'plan_type': plan_type
            })
            
            # Grant trial credits
            await credit_manager.add_credits(
                account_id=account_id,
                amount=TRIAL_CREDITS,
                is_expiring=True,
                description=trial_description,
                expires_at=trial_ends_at
            )
            
            # Create trial history
            await self.trial_repo.create_trial_history(
                account_id, datetime.now(timezone.utc)
            )
            
            await self._invalidate_trial_caches(account_id)
            
            logger.info(f"[TRIAL] ✅ Started trial for user {account_id} - granted ${TRIAL_CREDITS} credits")
        finally:
            await lock.release()
    
    async def convert_trial(self, account_id: str, new_status: str = 'converted') -> None:
        await self.credit_repo.update_trial_status(account_id, new_status)
        await self.trial_repo.update_trial_end(
            account_id, datetime.now(timezone.utc), converted=True
        )
        logger.info(f"[TRIAL] Marked trial as {new_status} for account {account_id}")
    
    async def _invalidate_trial_caches(self, account_id: str) -> None:
        cache_keys = [
            f"subscription_tier:{account_id}",
            f"credit_balance:{account_id}",
            f"credit_summary:{account_id}"
        ]
        
        for key in cache_keys:
            await Cache.invalidate(key)
