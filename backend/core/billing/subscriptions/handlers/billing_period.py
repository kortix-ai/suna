from typing import Dict, Optional
from decimal import Decimal
from datetime import datetime, timezone, timedelta
from dateutil.relativedelta import relativedelta

from core.services.supabase import DBConnection
from core.utils.logger import logger
from core.utils.cache import Cache
from core.billing.shared.config import (
    get_tier_by_price_id, 
    get_plan_type,
    get_price_type
)
from core.billing.credits.manager import credit_manager

class BillingPeriodHandler:
    @staticmethod
    async def handle_subscription_for_billing_period(
        subscription: Dict, 
        account_id: str, 
        price_id: str,
        is_new_subscription: bool = False,
        skip_credits: bool = False
    ) -> Dict:
        db = DBConnection()
        client = await db.client
        
        tier_info = get_tier_by_price_id(price_id)
        if not tier_info:
            logger.error(f"[BILLING PERIOD] Unknown price ID: {price_id}")
            return {'success': False, 'error': 'Unknown price ID'}
        
        plan_type = get_plan_type(price_id)
        billing_anchor = datetime.fromtimestamp(subscription['current_period_start'], tz=timezone.utc)
        
        logger.info(f"[BILLING PERIOD] Processing {plan_type} subscription for account {account_id}, tier {tier_info.name}")
        
        if plan_type == 'yearly':
            next_credit_grant = billing_anchor + relativedelta(months=1)
            logger.info(f"[BILLING PERIOD] Yearly plan: next credits in 1 month ({next_credit_grant})")
            
        elif plan_type == 'yearly_commitment':
            next_credit_grant = datetime.fromtimestamp(subscription['current_period_end'], tz=timezone.utc)
            logger.info(f"[BILLING PERIOD] Yearly commitment: next credits at period end ({next_credit_grant})")
            
        else:
            next_credit_grant = datetime.fromtimestamp(subscription['current_period_end'], tz=timezone.utc)
            logger.info(f"[BILLING PERIOD] Monthly plan: next credits at period end ({next_credit_grant})")
        
        update_data = {
            'tier': tier_info.name,
            'plan_type': plan_type,
            'stripe_subscription_id': subscription['id'],
            'stripe_subscription_status': subscription.get('status', 'active'),
            'billing_cycle_anchor': billing_anchor.isoformat(),
            'next_credit_grant': next_credit_grant.isoformat()
        }
        
        if not skip_credits and is_new_subscription:
            await BillingPeriodHandler._grant_initial_credits_for_billing_period(
                account_id, tier_info, plan_type, billing_anchor, next_credit_grant
            )
            update_data['last_grant_date'] = billing_anchor.isoformat()
        
        await client.from_('credit_accounts').update(update_data).eq('account_id', account_id).execute()
        
        await Cache.invalidate(f"subscription_tier:{account_id}")
        await Cache.invalidate(f"credit_balance:{account_id}")
        await Cache.invalidate(f"credit_summary:{account_id}")
        
        logger.info(f"[BILLING PERIOD] ✅ Successfully processed {plan_type} subscription for {account_id}")
        
        return {
            'success': True,
            'tier': tier_info.name,
            'plan_type': plan_type,
            'next_credit_grant': next_credit_grant.isoformat(),
            'credits_granted': not skip_credits and is_new_subscription
        }
    
    @staticmethod
    async def _grant_initial_credits_for_billing_period(
        account_id: str, 
        tier_info, 
        plan_type: str, 
        billing_anchor: datetime,
        next_credit_grant: datetime
    ):
        credits_amount = Decimal(str(tier_info.monthly_credits))
        
        if plan_type == 'yearly':
            expires_at = next_credit_grant
            description = f"Initial {tier_info.display_name} yearly subscription credits"
            
        elif plan_type == 'yearly_commitment':
            expires_at = next_credit_grant
            description = f"Initial {tier_info.display_name} yearly commitment credits"
            
        else:
            expires_at = next_credit_grant
            description = f"Initial {tier_info.display_name} monthly subscription credits"
        
        logger.info(f"[BILLING PERIOD] Granting ${credits_amount} {plan_type} credits to {account_id}, expires {expires_at}")
        
        await credit_manager.add_credits(
            account_id=account_id,
            amount=credits_amount,
            is_expiring=True,
            description=description,
            expires_at=expires_at
        )
        
        logger.info(f"[BILLING PERIOD] ✅ Granted ${credits_amount} credits for {plan_type} subscription")
    
    @staticmethod
    def is_billing_period_change(current_tier: str, new_tier: str, old_plan_type: str, new_plan_type: str) -> bool:
        return (current_tier == new_tier and 
                current_tier not in ['free', 'none'] and
                old_plan_type != new_plan_type)
    
    @staticmethod
    async def handle_billing_period_switch(
        account_id: str,
        subscription: Dict, 
        old_plan_type: str,
        new_plan_type: str
    ) -> Dict:
        price_id = subscription['items']['data'][0]['price']['id']
        
        logger.info(f"[BILLING PERIOD SWITCH] {account_id}: {old_plan_type} → {new_plan_type}")
        
        result = await BillingPeriodHandler.handle_subscription_for_billing_period(
            subscription=subscription,
            account_id=account_id,
            price_id=price_id,
            is_new_subscription=False,
            skip_credits=True
        )
        
        logger.info(f"[BILLING PERIOD SWITCH] ✅ Successfully switched to {new_plan_type}")
        return result
    
    @staticmethod 
    def _calculate_next_credit_grant(price_id: str, period_start: int, period_end: int) -> str:
        """Calculate correct next_credit_grant based on plan type"""
        from core.billing.shared.config import get_plan_type
        
        plan_type = get_plan_type(price_id)
        billing_anchor = datetime.fromtimestamp(period_start, tz=timezone.utc)
        
        if plan_type == 'yearly':
            # Yearly: User pays upfront, gets credits monthly
            next_grant_date = billing_anchor + relativedelta(months=1)
        elif plan_type == 'yearly_commitment':
            # Yearly commitment: User pays monthly but committed to 12 months
            next_grant_date = datetime.fromtimestamp(period_end, tz=timezone.utc)
        else:
            # Monthly: Normal period end
            next_grant_date = datetime.fromtimestamp(period_end, tz=timezone.utc)
        
        return next_grant_date.isoformat()
