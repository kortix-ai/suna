from typing import Dict, Optional
from datetime import datetime, timezone

from core.utils.logger import logger
from core.billing.shared.config import get_tier_by_price_id, get_plan_type, TRIAL_DURATION_DAYS, TRIAL_CREDITS
from core.billing.credits.manager import credit_manager
from ..repositories.trial_repository import TrialRepository
from ..repositories.subscription_repository import SubscriptionRepository

class TrialService:
    def __init__(self):
        self.trial_repo = TrialRepository()
        self.subscription_repo = SubscriptionRepository()
    
    async def handle_trial_conversion(self, account_id: str, subscription: Dict, tier_info) -> None:
        await self.trial_repo.update_trial_status(
            account_id, 'converted', tier_info.name, subscription['id']
        )
        
        await self.trial_repo.update_trial_history(
            account_id, datetime.now(timezone.utc), converted=True
        )
        
        logger.info(f"[TRIAL] Converted trial to paid subscription for {account_id}")
    
    async def handle_payment_method_added_to_trial(self, account_id: str, subscription: Dict) -> None:
        logger.info(f"[TRIAL] Payment method added to trial for account {account_id}")
        
        price_id = subscription['items']['data'][0]['price']['id'] if subscription.get('items') else None
        tier_info = get_tier_by_price_id(price_id)
        tier_name = tier_info.name if tier_info else 'tier_2_20'
        
        await self.trial_repo.update_trial_status(account_id, 'converted', tier_name)
        await self.trial_repo.update_trial_history(
            account_id, datetime.now(timezone.utc), converted=True
        )
    
    async def activate_trial_for_subscription(self, subscription: Dict, account_id: str, new_tier: Dict) -> None:
        if not subscription.get('trial_end'):
            return
        
        existing_account = await self.subscription_repo.get_credit_account_basic(account_id)
        if existing_account:
            current_status = existing_account.get('trial_status')
            if current_status == 'active':
                logger.info(f"[TRIAL] Trial already active for account {account_id}, skipping")
                return
        
        trial_ends_at = datetime.fromtimestamp(subscription.trial_end, tz=timezone.utc)
        
        await self.subscription_repo.update_subscription_metadata(account_id, {
            'trial_status': 'active',
            'trial_started_at': datetime.now(timezone.utc).isoformat(),
            'trial_ends_at': trial_ends_at.isoformat(),
            'stripe_subscription_id': subscription['id'],
            'tier': new_tier['name']
        })
        
        await credit_manager.add_credits(
            account_id=account_id,
            amount=TRIAL_CREDITS,
            is_expiring=True,
            description=f'{TRIAL_DURATION_DAYS}-day free trial credits',
            expires_at=trial_ends_at
        )
        
        await self.trial_repo.upsert_trial_history(account_id, datetime.now(timezone.utc))
        
        logger.info(f"[TRIAL] ✅ Activated trial for {account_id}")
    
    async def handle_trial_cancellation(self, account_id: str, subscription: Dict) -> None:
        account_data = await self.subscription_repo.get_credit_account_full(account_id)
        if not account_data:
            return
        
        current_balance = account_data.get('balance', 0)
        
        if subscription.status == 'trialing':
            await self.subscription_repo.update_subscription_metadata(account_id, {
                'trial_status': 'cancelled',
                'tier': 'none',
                'balance': 0.00,
                'expiring_credits': 0.00,
                'non_expiring_credits': 0.00,
                'stripe_subscription_id': None
            })
            
            await self.subscription_repo.add_credit_ledger_entry(
                account_id, -current_balance, 0.00, 'adjustment',
                'Trial cancelled - all credits removed'
            )
            
            logger.info(f"[TRIAL] ✅ Cancelled active trial for {account_id}")
        
        await self.trial_repo.update_trial_history(
            account_id, datetime.now(timezone.utc), converted=False, status='cancelled'
        )
