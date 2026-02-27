from typing import Dict, Optional
from datetime import datetime, timezone
import stripe # type: ignore

from core.utils.logger import logger
from core.billing.shared.config import get_tier_by_price_id, get_price_type
from core.billing.external.stripe import StripeAPIWrapper
from ..repositories.credit_account import CreditAccountRepository

class ScheduleService:
    def __init__(self):
        self.credit_account_repo = CreditAccountRepository()
    
    async def schedule_yearly_plan_change(
        self,
        account_id: str,
        current_subscription: Dict,
        target_price_id: str,
        commitment_type: Optional[str]
    ) -> Dict:
        current_period_end = current_subscription['current_period_end']
        current_period_end_date = datetime.fromtimestamp(current_period_end, tz=timezone.utc)
        
        target_tier = get_tier_by_price_id(target_price_id)
        current_tier_name = get_tier_by_price_id(current_subscription['items']['data'][0]['price']['id']).name
        
        logger.info(f"[YEARLY SCHEDULE] Scheduling change from {current_tier_name} to {target_tier.name} at period end: {current_period_end_date}")
        
        schedule = await self._create_subscription_schedule(
            current_subscription, target_price_id, current_period_end, 
            account_id, current_tier_name, target_tier.name
        )
        
        await self._update_credit_account_schedule(
            account_id, target_tier.name, current_period_end_date, 
            target_price_id, current_subscription
        )
        
        return {
            'status': 'scheduled',
            'message': f'Your plan will change to {target_tier.display_name} at the end of your current yearly billing period on {current_period_end_date.strftime("%B %d, %Y")}',
            'scheduled_date': current_period_end_date.isoformat(),
            'effective_date': current_period_end_date.isoformat(),
            'current_tier': current_tier_name,
            'target_tier': target_tier.name,
            'schedule_id': schedule.id
        }
    
    async def _create_subscription_schedule(
        self, 
        current_subscription: Dict, 
        target_price_id: str, 
        current_period_end: int,
        account_id: str,
        current_tier_name: str,
        target_tier_name: str
    ):
        schedule = await StripeAPIWrapper.safe_stripe_call(
            stripe.SubscriptionSchedule.create_async,
            from_subscription=current_subscription['id']
        )
        
        await StripeAPIWrapper.safe_stripe_call(
            stripe.SubscriptionSchedule.modify_async,
            schedule.id,
            phases=[
                {
                    'items': [{
                        'price': current_subscription['items']['data'][0]['price']['id'],
                        'quantity': 1,
                    }],
                    'start_date': current_subscription['current_period_start'],
                    'end_date': current_period_end,
                    'proration_behavior': 'none',
                },
                {
                    'items': [{
                        'price': target_price_id,
                        'quantity': 1,
                    }],
                    'iterations': None,
                    'proration_behavior': 'none',
                }
            ],
            end_behavior='release',
            metadata={
                'account_id': account_id,
                'scheduled_change': 'true',
                'previous_tier': current_tier_name,
                'target_tier': target_tier_name,
                'scheduled_by': 'user',
                'scheduled_at': datetime.now(timezone.utc).isoformat(),
                'scheduled_price_id': target_price_id
            }
        )
        
        logger.info(f"[YEARLY SCHEDULE] Created subscription schedule {schedule.id} for {account_id}")
        return schedule
    
    async def _update_credit_account_schedule(
        self,
        account_id: str,
        target_tier_name: str,
        current_period_end_date: datetime,
        target_price_id: str,
        current_subscription: Dict
    ):
        update_data = {
            'scheduled_tier_change': target_tier_name,
            'scheduled_tier_change_date': current_period_end_date.isoformat(),
            'scheduled_price_id': target_price_id
        }
        
        current_credit_result = await self.credit_account_repo.get_credit_account(
            account_id, 'next_credit_grant, billing_cycle_anchor, plan_type'
        )
        
        if current_credit_result:
            current_plan_type = current_credit_result.get('plan_type')
            if current_plan_type == 'yearly':
                current_anchor = current_credit_result.get('billing_cycle_anchor')
                if current_anchor:
                    from dateutil.relativedelta import relativedelta # type: ignore
                    anchor_dt = datetime.fromisoformat(current_anchor.replace('Z', '+00:00'))
                    correct_next_grant = anchor_dt + relativedelta(months=1)
                    update_data['next_credit_grant'] = correct_next_grant.isoformat()
                    logger.info(f"[YEARLY SCHEDULE] Preserving yearly next_credit_grant: {correct_next_grant}")
        
        await self.credit_account_repo.update_credit_account(account_id, update_data)
