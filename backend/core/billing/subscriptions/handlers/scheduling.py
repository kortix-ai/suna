from fastapi import HTTPException
from typing import Dict, Optional
from datetime import datetime, timezone, timedelta
import stripe

from core.services.supabase import DBConnection
from core.utils.logger import logger
from core.billing.shared.config import (
    get_tier_by_name,
    get_tier_by_price_id,
    get_price_type
)
from core.billing.external.stripe import StripeAPIWrapper

class SchedulingHandler:
    @staticmethod
    async def schedule_tier_downgrade(account_id: str, target_tier_key: str, commitment_type: Optional[str] = None) -> Dict:
        db = DBConnection()
        client = await db.client
        
        credit_result = await client.from_('credit_accounts').select(
            'stripe_subscription_id, tier, commitment_type, commitment_end_date'
        ).eq('account_id', account_id).execute()
        
        if not credit_result.data or not credit_result.data[0].get('stripe_subscription_id'):
            raise HTTPException(status_code=404, detail="No active subscription found")
        
        subscription_id = credit_result.data[0]['stripe_subscription_id']
        current_tier_name = credit_result.data[0].get('tier', 'none')
        user_commitment_type = credit_result.data[0].get('commitment_type')
        commitment_end_date = credit_result.data[0].get('commitment_end_date')
        
        current_tier = get_tier_by_name(current_tier_name)
        target_tier = get_tier_by_name(target_tier_key)
        
        if not target_tier:
            raise HTTPException(status_code=400, detail=f"Invalid target tier: {target_tier_key}")
        
        if not current_tier:
            raise HTTPException(status_code=400, detail="Could not determine current tier")
        
        if target_tier.monthly_credits >= current_tier.monthly_credits:
            raise HTTPException(
                status_code=400, 
                detail="Target tier must be lower than current tier. Use the upgrade flow for tier increases."
            )
        
        try:
            subscription = await StripeAPIWrapper.retrieve_subscription(subscription_id)
            
            current_period_end, current_period_end_date = SchedulingHandler._determine_downgrade_timing(
                subscription, user_commitment_type, commitment_end_date
            )
            
            target_price_id = SchedulingHandler._determine_target_price_id(target_tier, commitment_type)
            
            current_price_type = get_price_type(subscription['items']['data'][0]['price']['id'])
            target_price_type = get_price_type(target_price_id)
            
            await SchedulingHandler._create_or_update_schedule(
                subscription_id, subscription, target_price_id, current_period_end, account_id, 
                current_tier_name, target_tier_key, client
            )
            
            return SchedulingHandler._build_downgrade_response(
                current_tier, target_tier, current_period_end_date, current_price_type, 
                target_price_type, user_commitment_type, commitment_end_date
            )
            
        except stripe.error.StripeError as e:
            logger.error(f"Error scheduling downgrade for subscription {subscription_id}: {e}")
            raise HTTPException(status_code=500, detail=f"Failed to schedule downgrade: {str(e)}")

    @staticmethod
    def _determine_downgrade_timing(subscription: Dict, user_commitment_type: str, commitment_end_date: str):
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

    @staticmethod
    def _determine_target_price_id(target_tier, commitment_type: Optional[str]) -> str:
        if commitment_type and len(target_tier.price_ids) >= 3:
            return target_tier.price_ids[2] if commitment_type == 'yearly_commitment' else target_tier.price_ids[0]
        elif commitment_type == 'yearly' and len(target_tier.price_ids) >= 2:
            return target_tier.price_ids[1]
        else:
            return target_tier.price_ids[0]

    @staticmethod
    async def _create_or_update_schedule(
        subscription_id: str, subscription: Dict, target_price_id: str, 
        current_period_end: int, account_id: str, current_tier_name: str, 
        target_tier_key: str, client
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
        schedule = None
        
        if existing_schedule_id:
            schedule = await SchedulingHandler._handle_existing_schedule(
                existing_schedule_id, subscription, target_price_id, current_period_end, schedule_metadata
            )
        
        if not existing_schedule_id or not schedule:
            schedule = await SchedulingHandler._create_new_schedule(
                subscription_id, subscription, target_price_id, current_period_end, schedule_metadata
            )
        
        await client.from_('credit_accounts').update({
            'scheduled_tier_change': target_tier_key,
            'scheduled_tier_change_date': datetime.fromtimestamp(current_period_end, tz=timezone.utc).isoformat(),
            'scheduled_price_id': target_price_id
        }).eq('account_id', account_id).execute()

    @staticmethod
    async def _handle_existing_schedule(
        existing_schedule_id: str, subscription: Dict, target_price_id: str, 
        current_period_end: int, schedule_metadata: Dict
    ):
        try:
            existing_schedule = await StripeAPIWrapper.safe_stripe_call(
                stripe.SubscriptionSchedule.retrieve_async,
                existing_schedule_id
            )
            
            schedule_status = existing_schedule.get('status')
            logger.info(f"[DOWNGRADE] Existing schedule status: {schedule_status}")
            
            if schedule_status in ['active', 'not_started']:
                logger.info(f"[DOWNGRADE] Updating active schedule {existing_schedule_id}")
                await StripeAPIWrapper.safe_stripe_call(
                    stripe.SubscriptionSchedule.modify_async,
                    existing_schedule_id,
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
                logger.info(f"[DOWNGRADE] Updated existing schedule {existing_schedule_id}")
                return existing_schedule
            else:
                logger.info(f"[DOWNGRADE] Schedule {existing_schedule_id} is {schedule_status}, releasing and creating new")
                await StripeAPIWrapper.safe_stripe_call(
                    stripe.SubscriptionSchedule.release_async,
                    existing_schedule_id
                )
                logger.info(f"[DOWNGRADE] Released completed/canceled schedule {existing_schedule_id}")
                
                import asyncio
                await asyncio.sleep(1)
                return None
                
        except stripe.error.InvalidRequestError as e:
            if 'No such subscription_schedule' in str(e):
                logger.info(f"[DOWNGRADE] Schedule {existing_schedule_id} no longer exists, will create new")
                return None
            else:
                raise

    @staticmethod
    async def _create_new_schedule(
        subscription_id: str, subscription: Dict, target_price_id: str, 
        current_period_end: int, schedule_metadata: Dict
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

    @staticmethod
    def _build_downgrade_response(
        current_tier, target_tier, current_period_end_date: datetime, 
        current_price_type: str, target_price_type: str, user_commitment_type: str, 
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

    @staticmethod
    async def get_commitment_status(account_id: str) -> Dict:
        db = DBConnection()
        client = await db.client
        
        result = await client.from_('credit_accounts').select(
            'commitment_type, commitment_start_date, commitment_end_date, commitment_price_id'
        ).eq('account_id', account_id).execute()
        
        if not result.data or not result.data[0].get('commitment_type'):
            return {
                'has_commitment': False,
                'can_cancel': True,
                'commitment_type': None,
                'months_remaining': None,
                'commitment_end_date': None
            }
        
        data = result.data[0]
        end_date = datetime.fromisoformat(data['commitment_end_date'].replace('Z', '+00:00'))
        now = datetime.now(timezone.utc)
        
        if now >= end_date:
            await client.from_('credit_accounts').update({
                'commitment_type': None,
                'commitment_start_date': None,
                'commitment_end_date': None,
                'commitment_price_id': None,
                'can_cancel_after': None
            }).eq('account_id', account_id).execute()
            
            return {
                'has_commitment': False,
                'can_cancel': True,
                'commitment_type': None,
                'months_remaining': None,
                'commitment_end_date': None
            }
        
        months_remaining = (end_date.year - now.year) * 12 + (end_date.month - now.month)
        
        return {
            'has_commitment': True,
            'can_cancel': False,
            'commitment_type': data['commitment_type'],
            'months_remaining': max(1, months_remaining),
            'commitment_end_date': data['commitment_end_date']
        }

    @staticmethod
    async def get_scheduled_changes(account_id: str) -> Dict:
        db = DBConnection()
        client = await db.client
        
        credit_result = await client.from_('credit_accounts').select(
            'stripe_subscription_id, tier, scheduled_tier_change, scheduled_tier_change_date, scheduled_price_id'
        ).eq('account_id', account_id).execute()
        
        if not credit_result.data:
            return {
                'has_scheduled_change': False,
                'scheduled_change': None
            }
        
        data = credit_result.data[0]
        scheduled_tier = data.get('scheduled_tier_change')
        scheduled_date = data.get('scheduled_tier_change_date')
        current_tier_name = data.get('tier')
        
        if scheduled_tier and current_tier_name == scheduled_tier:
            logger.info(f"[SCHEDULED_CHANGES] Scheduled tier {scheduled_tier} matches current tier - downgrade already completed, clearing fields")
            await client.from_('credit_accounts').update({
                'scheduled_tier_change': None,
                'scheduled_tier_change_date': None,
                'scheduled_price_id': None
            }).eq('account_id', account_id).execute()
            
            return {
                'has_scheduled_change': False,
                'scheduled_change': None
            }
        
        if not scheduled_tier or not scheduled_date:
            return await SchedulingHandler._check_stripe_metadata_for_scheduled_changes(
                data, current_tier_name
            )
        
        current_tier = get_tier_by_name(data.get('tier', 'none'))
        target_tier = get_tier_by_name(scheduled_tier)
        
        return {
            'has_scheduled_change': True,
            'scheduled_change': {
                'type': 'downgrade',
                'current_tier': {
                    'name': current_tier.name if current_tier else 'none',
                    'display_name': current_tier.display_name if current_tier else 'Unknown',
                    'monthly_credits': float(current_tier.monthly_credits) if current_tier else 0
                },
                'target_tier': {
                    'name': target_tier.name if target_tier else scheduled_tier,
                    'display_name': target_tier.display_name if target_tier else scheduled_tier,
                    'monthly_credits': float(target_tier.monthly_credits) if target_tier else 0
                },
                'effective_date': scheduled_date
            }
        }

    @staticmethod
    async def _check_stripe_metadata_for_scheduled_changes(data: Dict, current_tier_name: str) -> Dict:
        subscription_id = data.get('stripe_subscription_id')
        if subscription_id:
            try:
                subscription = await StripeAPIWrapper.retrieve_subscription(subscription_id)
                
                if subscription.get('metadata', {}).get('downgrade') == 'true':
                    target_tier_name = subscription['metadata'].get('target_tier')
                    if target_tier_name:
                        if current_tier_name == target_tier_name:
                            logger.info(f"[SCHEDULED_CHANGES] Stripe metadata tier {target_tier_name} matches current tier - downgrade already completed")
                            return {
                                'has_scheduled_change': False,
                                'scheduled_change': None
                            }
                        
                        target_tier = get_tier_by_name(target_tier_name)
                        current_tier = get_tier_by_name(current_tier_name)
                        
                        return {
                            'has_scheduled_change': True,
                            'scheduled_change': {
                                'type': 'downgrade',
                                'current_tier': {
                                    'name': current_tier.name if current_tier else 'none',
                                    'display_name': current_tier.display_name if current_tier else 'Unknown'
                                },
                                'target_tier': {
                                    'name': target_tier.name if target_tier else target_tier_name,
                                    'display_name': target_tier.display_name if target_tier else target_tier_name
                                },
                                'effective_date': datetime.fromtimestamp(
                                    subscription['current_period_end'], tz=timezone.utc
                                ).isoformat()
                            }
                        }
            except Exception as e:
                logger.error(f"Error checking Stripe subscription for scheduled changes: {e}")
        
        return {
            'has_scheduled_change': False,
            'scheduled_change': None
        }
