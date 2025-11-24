from typing import Dict, Optional
from datetime import datetime, timezone, timedelta
from decimal import Decimal

from core.utils.logger import logger
from core.utils.cache import Cache
from core.utils.distributed_lock import DistributedLock
from core.billing.shared.config import (
    get_tier_by_price_id, 
    get_tier_by_name,
    TRIAL_DURATION_DAYS,
    TRIAL_CREDITS,
    get_plan_type
)
from core.billing.credits.manager import credit_manager
from core.billing.external.stripe import StripeAPIWrapper
from ..repositories.credit_account import CreditAccountRepository
from ..repositories.trial import TrialRepository

class LifecycleService:
    def __init__(self):
        self.credit_repo = CreditAccountRepository()
        self.trial_repo = TrialRepository()
    



    async def get_account_id_from_subscription(self, subscription: Dict, customer_id: str) -> Optional[str]:
        account_id = subscription.get('metadata', {}).get('account_id')
        
        if not account_id:
            from core.services.supabase import DBConnection
            db = DBConnection()
            client = await db.client
            
            customer_result = await client.schema('basejump').from_('billing_customers')\
                .select('account_id')\
                .eq('id', customer_id)\
                .execute()
            
            if not customer_result.data or len(customer_result.data) == 0:
                logger.warning(f"Could not find account for customer {customer_id}")
                return None
            
            account_id = customer_result.data[0]['account_id']
        
        return account_id
    




    def is_renewal(self, subscription: Dict, current_account_data: Optional[Dict], billing_anchor: datetime) -> bool:
        if not subscription.get('id'):
            return False
        
        if not current_account_data:
            return False
        
        current_tier_name = current_account_data.get('tier', 'none')
        old_subscription_id = current_account_data.get('stripe_subscription_id')
        
        new_tier_info = get_tier_by_price_id(subscription['items']['data'][0]['price']['id'])
        is_new_subscription = (old_subscription_id is None or 
                              old_subscription_id == '' or 
                              old_subscription_id != subscription.get('id'))
        
        is_free_to_paid_upgrade = (current_tier_name in ['free', 'none'] and 
                                  new_tier_info and 
                                  new_tier_info.name not in ['free', 'none'])
        
        is_tier_change = (current_tier_name not in ['free', 'none'] and 
                         new_tier_info and 
                         new_tier_info.name != current_tier_name)
        
        if is_new_subscription or is_free_to_paid_upgrade or is_tier_change:
            logger.info(f"[RENEWAL DETECTION] New subscription, free-to-paid upgrade, or tier change ({current_tier_name} -> {new_tier_info.name if new_tier_info else 'unknown'}) - NOT blocking")
            return False
        
        now = datetime.now(timezone.utc)
        seconds_since_period_start = (now - billing_anchor).total_seconds()
        
        if 0 <= seconds_since_period_start < 1800:
            logger.warning(f"[RENEWAL DETECTION] Within 30min of period start - likely renewal - BLOCKING")
            return True
        
        return False
    




    def should_grant_credits(self, current_tier_data: Optional[Dict], new_tier: Dict, subscription: Dict, is_renewal: bool = False) -> bool:
        if is_renewal:
            return False
        
        if not current_tier_data:
            logger.info(f"No existing tier data - will grant credits for new subscription")
            return True
        
        current_tier_name = current_tier_data.get('name', 'none')
        current_credits = current_tier_data.get('credits', 0)
        
        if current_tier_name in ['free', 'none'] and new_tier['name'] not in ['free', 'none']:
            logger.info(f"Upgrade from free tier to {new_tier['name']} - will grant credits")
            return True
        
        if current_tier_name != new_tier['name']:
            if new_tier['credits'] > current_credits:
                logger.info(f"Tier upgrade detected: {current_tier_name} -> {new_tier['name']} ({current_credits} -> {new_tier['credits']} credits)")
                return True
            else:
                logger.info(f"Tier change to lower/same credits: {current_tier_name} -> {new_tier['name']} ({current_credits} -> {new_tier['credits']} credits) - no additional credits granted")
                return False
        
        return False
    





    def is_duplicate_credit_grant(self, last_grant_date: Optional[str], billing_anchor: datetime, current_tier_name: str, new_tier: Dict) -> bool:
        if not last_grant_date:
            return False
        
        try:
            last_grant_dt = datetime.fromisoformat(last_grant_date.replace('Z', '+00:00'))
            time_since_last_grant = (datetime.now(timezone.utc) - last_grant_dt).total_seconds()
            
            is_free_to_paid_upgrade = (current_tier_name in ['free', 'none'] and 
                                      new_tier['name'] not in ['free', 'none'])
            
            is_tier_upgrade = (current_tier_name not in ['free', 'none'] and 
                              new_tier['name'] not in ['free', 'none'] and
                              current_tier_name != new_tier['name'])
            
            if time_since_last_grant < 900 and current_tier_name == new_tier['name'] and not is_free_to_paid_upgrade:
                logger.warning(f"[DOUBLE CREDIT BLOCK] Credits granted {time_since_last_grant:.0f}s ago for SAME tier {new_tier['name']}")
                return True
            
            if is_free_to_paid_upgrade or is_tier_upgrade:
                logger.info(f"[TIER CHANGE ALLOWED] Allowing credit grant for tier change: {current_tier_name} -> {new_tier['name']}")
                return False
            
            if abs((billing_anchor - last_grant_dt).total_seconds()) < 900 and current_tier_name == new_tier['name']:
                logger.warning(f"[DOUBLE CREDIT BLOCK] Credits already granted near billing period start for SAME tier")
                return True
                
        except Exception as e:
            logger.warning(f"Error parsing dates for idempotency check: {e}")
            
        return False
    





    async def grant_subscription_credits(self, account_id: str, tier: Dict, billing_anchor: datetime, is_tier_upgrade: bool = False) -> None:
        full_amount = Decimal(tier['credits'])
        
        lock_key = f"credit_grant:upgrade:{account_id}:{tier['name']}"
        lock = DistributedLock(lock_key, timeout_seconds=60)
        
        acquired = await lock.acquire(wait=True, wait_timeout=30)
        if not acquired:
            logger.error(f"[CREDIT GRANT] Failed to acquire lock for subscription grant to {account_id}")
            raise Exception(f"Failed to acquire lock for credit grant - possible concurrent processing")
        
        try:
            logger.info(f"[CREDIT GRANT] 🔒 Acquired lock for granting ${full_amount} credits to {account_id}")
            
            await self._check_for_recent_duplicate_credits(account_id, tier['name'], full_amount)
            
            from dateutil.relativedelta import relativedelta # type: ignore
            expires_at = billing_anchor + relativedelta(months=1)
            
            if is_tier_upgrade:
                logger.info(f"[TIER UPGRADE] Replacing existing credits with ${full_amount} for {tier['name']} (Stripe handled payment proration)")
                
                import time
                unique_id = f"lifecycle_upgrade_{account_id}_{tier['name']}_{int(time.time())}"
                
                await credit_manager.reset_expiring_credits(
                    account_id=account_id,
                    new_credits=full_amount,
                    description=f"Tier upgrade to {tier['name']} (prorated by Stripe)",
                    stripe_event_id=unique_id
                )
            else:
                logger.info(f"[NEW SUBSCRIPTION] Adding ${full_amount} credits for new {tier['name']} subscription")
                
                await credit_manager.add_credits(
                    account_id=account_id,
                    amount=full_amount,
                    is_expiring=True,
                    description=f"New subscription: {tier['name']}",
                    expires_at=expires_at
                )
            
            logger.info(f"[CREDIT GRANT] ✅ Successfully processed ${full_amount} credits for {tier['name']}")
        finally:
            await lock.release()
    




    async def _check_for_recent_duplicate_credits(self, account_id: str, tier_name: str, amount: Decimal) -> None:
        from core.services.supabase import DBConnection
        
        db = DBConnection()
        client = await db.client
        
        two_minutes_ago = (datetime.now(timezone.utc) - timedelta(minutes=2)).isoformat()
        
        recent_credits = await client.from_('credit_ledger').select('amount, description, created_at').eq(
            'account_id', account_id
        ).gte('created_at', two_minutes_ago).execute()
        
        if recent_credits.data:
            for credit in recent_credits.data:
                credit_description = credit.get('description', '')
                credit_amount = credit.get('amount', 0)
                
                if (f"to {tier_name}" in credit_description and 
                    abs(float(credit_amount) - float(amount)) < 0.01):
                    logger.warning(f"[DUPLICATE PREVENTION] Credits for {tier_name} (${amount}) already granted recently - BLOCKING duplicate")
                    raise Exception(f"Credits for {tier_name} upgrade already granted recently")
    


    
    async def invalidate_caches(self, account_id: str) -> None:
        cache_keys = [
            f"subscription_tier:{account_id}",
            f"credit_balance:{account_id}",
            f"credit_summary:{account_id}",
            f"project_count_limit:{account_id}"
        ]
        
        for key in cache_keys:
            await Cache.invalidate(key)
    
    
    def calculate_next_credit_grant(self, plan_type: str, billing_anchor: datetime, period_end_timestamp: int) -> datetime:
        if plan_type == 'yearly':
            from dateutil.relativedelta import relativedelta # type: ignore
            return billing_anchor + relativedelta(months=1)
        else:
            return datetime.fromtimestamp(period_end_timestamp, tz=timezone.utc)
