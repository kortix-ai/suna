from typing import Dict, Optional, Tuple
from datetime import datetime, timezone

from core.utils.logger import logger
from core.billing.shared.config import get_tier_by_name, get_price_type
from core.billing.external.stripe import StripeAPIWrapper
from ..repositories.credit_account import CreditAccountRepository
import stripe

class SchedulingService:
    def __init__(self):
        self.credit_repo = CreditAccountRepository()
    
    def validate_downgrade_request(self, current_tier, target_tier) -> None:
        from fastapi import HTTPException
        
        if not target_tier:
            raise HTTPException(status_code=400, detail=f"Invalid target tier")
        
        if not current_tier:
            raise HTTPException(status_code=400, detail="Could not determine current tier")
        
        if target_tier.monthly_credits >= current_tier.monthly_credits:
            raise HTTPException(
                status_code=400, 
                detail="Target tier must be lower than current tier. Use the upgrade flow for tier increases."
            )
    
    def determine_downgrade_timing(self, subscription: Dict, user_commitment_type: str, commitment_end_date: str) -> Tuple[int, datetime]:
        if user_commitment_type == 'yearly_commitment' and commitment_end_date:
            commitment_end_dt = datetime.fromisoformat(commitment_end_date.replace('Z', '+00:00'))
            if datetime.now(timezone.utc) < commitment_end_dt:
                logger.info(f"[DOWNGRADE] User has active commitment until {commitment_end_dt.date()}")
                current_period_end = int(commitment_end_dt.timestamp())
                current_period_end_date = commitment_end_dt
                logger.info(f"[DOWNGRADE] Scheduling downgrade for commitment end date: {commitment_end_date}")
                return current_period_end, current_period_end_date
        
        current_period_end = subscription['current_period_end']
        current_period_end_date = datetime.fromtimestamp(current_period_end, tz=timezone.utc)
        return current_period_end, current_period_end_date

    def determine_target_price_id(self, target_tier, commitment_type: Optional[str]) -> str:
        if commitment_type and len(target_tier.price_ids) >= 3:
            return target_tier.price_ids[2] if commitment_type == 'yearly_commitment' else target_tier.price_ids[0]
        elif commitment_type == 'yearly' and len(target_tier.price_ids) >= 2:
            return target_tier.price_ids[1]
        else:
            return target_tier.price_ids[0]

    async def create_or_update_subscription_schedule(
        self, 
        subscription_id: str, 
        subscription: Dict, 
        target_price_id: str, 
        current_period_end: int, 
        account_id: str, 
        current_tier_name: str, 
        target_tier_key: str
    ):
        schedule_metadata = {
            'account_id': account_id,
            'downgrade': 'true',
            'previous_tier': current_tier_name,
            'target_tier': target_tier_key,
            'scheduled_by': 'user',
            'scheduled_at': datetime.now(timezone.utc).isoformat(),
            'scheduled_price_id': target_price_id
        }
        
        existing_schedule_id = subscription.get('schedule')
        
        if existing_schedule_id:
            schedule = await self._handle_existing_schedule(
                existing_schedule_id, subscription, target_price_id, current_period_end, schedule_metadata
            )
        
        if not existing_schedule_id or schedule is None:
            schedule = await self._create_new_schedule(
                subscription_id, subscription, target_price_id, current_period_end, schedule_metadata
            )
        
        await self.credit_repo.update_credit_account(account_id, {
            'scheduled_tier_change': target_tier_key,
            'scheduled_tier_change_date': datetime.fromtimestamp(current_period_end, tz=timezone.utc).isoformat(),
            'scheduled_price_id': target_price_id
        })
        
        return schedule

    async def _handle_existing_schedule(
        self, 
        existing_schedule_id: str, 
        subscription: Dict, 
        target_price_id: str, 
        current_period_end: int, 
        schedule_metadata: Dict
    ):
        try:
            existing_schedule = await StripeAPIWrapper.safe_stripe_call(
                stripe.SubscriptionSchedule.retrieve_async,
                existing_schedule_id
            )
            
            schedule_status = existing_schedule.get('status')
            logger.info(f"[DOWNGRADE] Existing schedule status: {schedule_status}")
            
            if schedule_status in ['active', 'not_started']:
                await self._update_existing_schedule(
                    existing_schedule_id, subscription, target_price_id, current_period_end, schedule_metadata
                )
                logger.info(f"[DOWNGRADE] Updated existing schedule {existing_schedule_id}")
                return existing_schedule
            else:
                await self._release_completed_schedule(existing_schedule_id)
                import asyncio
                await asyncio.sleep(1)
                return None
                
        except stripe.error.InvalidRequestError as e:
            if 'No such subscription_schedule' in str(e):
                logger.info(f"[DOWNGRADE] Schedule {existing_schedule_id} no longer exists, will create new")
                return None
            else:
                raise

    async def _update_existing_schedule(
        self, 
        schedule_id: str, 
        subscription: Dict, 
        target_price_id: str, 
        current_period_end: int, 
        schedule_metadata: Dict
    ):
        await StripeAPIWrapper.safe_stripe_call(
            stripe.SubscriptionSchedule.modify_async,
            schedule_id,
            phases=[
                {
                    'items': [{
                        'price': subscription['items']['data'][0]['price']['id'],
                        'quantity': 1,
                    }],
                    'start_date': subscription['current_period_start'],
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
            metadata=schedule_metadata
        )

    async def _release_completed_schedule(self, schedule_id: str):
        logger.info(f"[DOWNGRADE] Schedule {schedule_id} is completed/canceled, releasing and creating new")
        await StripeAPIWrapper.safe_stripe_call(
            stripe.SubscriptionSchedule.release_async,
            schedule_id
        )
        logger.info(f"[DOWNGRADE] Released completed/canceled schedule {schedule_id}")

    async def _create_new_schedule(
        self, 
        subscription_id: str, 
        subscription: Dict, 
        target_price_id: str, 
        current_period_end: int, 
        schedule_metadata: Dict
    ):
        schedule = await StripeAPIWrapper.safe_stripe_call(
            stripe.SubscriptionSchedule.create_async,
            from_subscription=subscription_id,
        )
        
        await StripeAPIWrapper.safe_stripe_call(
            stripe.SubscriptionSchedule.modify_async,
            schedule.id,
            phases=[
                {
                    'items': [{
                        'price': subscription['items']['data'][0]['price']['id'],
                        'quantity': 1,
                    }],
                    'start_date': subscription['current_period_start'],
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
            metadata=schedule_metadata
        )
        
        logger.info(f"[DOWNGRADE] Created new Stripe subscription schedule {schedule.id}")
        return schedule

    def build_downgrade_response(
        self, 
        current_tier, 
        target_tier, 
        current_period_end_date: datetime, 
        current_price_type: str, 
        target_price_type: str, 
        user_commitment_type: str, 
        commitment_end_date: str
    ) -> Dict:
        if user_commitment_type == 'yearly_commitment' and commitment_end_date:
            commitment_end_dt = datetime.fromisoformat(commitment_end_date.replace('Z', '+00:00'))
            if datetime.now(timezone.utc) < commitment_end_dt:
                message = f'Your plan will be downgraded to {target_tier.display_name} at the end of your annual commitment on {commitment_end_dt.strftime("%B %d, %Y")}'
            else:
                message = f'Your plan will be downgraded to {target_tier.display_name} at the end of your current billing period'
        elif current_price_type == 'yearly' or current_price_type == 'yearly_commitment':
            message = f'Your plan will be downgraded to {target_tier.display_name} at the end of your current yearly billing period'
        elif current_price_type == 'monthly':
            message = f'Your plan will be downgraded to {target_tier.display_name} at the end of your current monthly billing period'
        else:
            message = f'Your plan will be downgraded to {target_tier.display_name} at the end of your current billing period'
        
        change_description = f"{current_tier.display_name} to {target_tier.display_name}"
        if current_price_type != target_price_type:
            if current_price_type == 'yearly' or current_price_type == 'yearly_commitment':
                change_description += f" (switching from yearly to {target_price_type} billing)"
            else:
                change_description += f" (switching from {current_price_type} to {target_price_type} billing)"
        
        return {
            'success': True,
            'message': message,
            'scheduled_date': current_period_end_date.isoformat(),
            'current_tier': {
                'name': current_tier.name,
                'display_name': current_tier.display_name,
                'monthly_credits': float(current_tier.monthly_credits)
            },
            'target_tier': {
                'name': target_tier.name,
                'display_name': target_tier.display_name,
                'monthly_credits': float(target_tier.monthly_credits)
            },
            'billing_change': current_price_type != target_price_type,
            'current_billing_period': current_price_type,
            'target_billing_period': target_price_type,
            'change_description': change_description,
            'is_commitment': user_commitment_type == 'yearly_commitment' and commitment_end_date is not None
        }
