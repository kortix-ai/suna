from fastapi import HTTPException
from typing import Dict, Optional
from datetime import datetime, timezone

import stripe
from core.utils.logger import logger
from core.billing.shared.config import (
    get_tier_by_price_id, 
    get_tier_by_name,
    is_commitment_price_id,
    get_commitment_duration_months,
    get_plan_type
)
from core.billing.external.stripe import StripeAPIWrapper
from ..services.lifecycle_service import LifecycleService
from ..services.trial_service import TrialService
from ..repositories.credit_account import CreditAccountRepository
from ..repositories.commitment import CommitmentRepository

class SubscriptionLifecycleHandler:
    def __init__(self):
        self.lifecycle_service = LifecycleService()
        self.trial_service = TrialService()
        self.credit_repo = CreditAccountRepository()
        self.commitment_repo = CommitmentRepository()
    
    @classmethod
    async def cancel_subscription(cls, account_id: str, feedback: Optional[str] = None) -> Dict:
        handler = cls()
        return await handler._cancel_subscription(account_id, feedback)
    
    async def _cancel_subscription(self, account_id: str, feedback: Optional[str] = None) -> Dict:
        logger.info(f"[CANCEL] Processing cancellation for {account_id} - will downgrade to free tier at period end")
        
        try:
            from .scheduling import SchedulingHandler
            result = await SchedulingHandler.schedule_tier_downgrade(
                account_id=account_id,
                target_tier_key='free',
                commitment_type='monthly'
            )
            
            logger.info(f"[CANCEL] Successfully scheduled downgrade to free tier for {account_id}")
            
            if feedback:
                await self._save_cancellation_feedback(account_id, feedback)
            
            return {
                'success': True,
                'message': result.get('message', 'Your plan will be downgraded to the free tier at the end of your current billing period'),
                'scheduled_date': result.get('scheduled_date'),
                'downgrade_to_free': True
            }
            
        except HTTPException as e:
            raise e
        except Exception as e:
            logger.error(f"Error cancelling subscription for {account_id}: {e}")
            raise HTTPException(status_code=500, detail=f"Failed to cancel subscription: {str(e)}")

    async def _save_cancellation_feedback(self, account_id: str, feedback: str):
        try:
            credit_account = await self.credit_repo.get_credit_account(account_id, 'stripe_subscription_id')
            
            if credit_account and credit_account.get('stripe_subscription_id'):
                subscription_id = credit_account['stripe_subscription_id']
                await StripeAPIWrapper.modify_subscription(
                    subscription_id,
                    metadata={'cancellation_feedback': feedback}
                )
                logger.info(f"[CANCEL] Saved cancellation feedback for {account_id}")
        except Exception as e:
            logger.warning(f"[CANCEL] Could not save feedback: {e}")

    @classmethod
    async def reactivate_subscription(cls, account_id: str) -> Dict:
        handler = cls()
        return await handler._reactivate_subscription(account_id)
        
    async def _reactivate_subscription(self, account_id: str) -> Dict:
        subscription_details = await self.credit_repo.get_subscription_details(account_id)
        
        if not subscription_details or not subscription_details.get('stripe_subscription_id'):
            raise HTTPException(status_code=404, detail="No subscription found")
        
        subscription_id = subscription_details['stripe_subscription_id']
        scheduled_tier = subscription_details.get('scheduled_tier_change')
        
        try:
            subscription = await StripeAPIWrapper.retrieve_subscription(subscription_id)
            
            if scheduled_tier:
                await self._cancel_scheduled_downgrade(account_id, subscription)
            
            await StripeAPIWrapper.modify_subscription(
                subscription_id,
                cancel_at_period_end=False,
                cancel_at=None
            )
            
            return {
                'success': True,
                'message': 'Subscription reactivated successfully',
                'status': subscription.status
            }
            
        except stripe.error.StripeError as e:
            logger.error(f"Error reactivating subscription {subscription_id}: {e}")
            raise HTTPException(status_code=500, detail=f"Stripe error: {str(e)}")

    async def _cancel_scheduled_downgrade(self, account_id: str, subscription: Dict):
        logger.info(f"[REACTIVATE] Cancelling scheduled downgrade for {account_id}")
        
        schedule_id = subscription.get('schedule')
        if schedule_id:
            await self._release_subscription_schedule(schedule_id)
        
        await self._clear_subscription_metadata(subscription['id'])
        await self.credit_repo.clear_scheduled_changes(account_id)
        
        logger.info(f"[REACTIVATE] Cleared scheduled downgrade for {account_id}")

    async def _release_subscription_schedule(self, schedule_id: str):
        try:
            schedule = await StripeAPIWrapper.safe_stripe_call(
                stripe.SubscriptionSchedule.retrieve_async,
                schedule_id
            )
            
            if schedule.get('status') in ['active', 'not_started']:
                await StripeAPIWrapper.safe_stripe_call(
                    stripe.SubscriptionSchedule.release_async,
                    schedule_id
                )
                logger.info(f"[REACTIVATE] Released schedule {schedule_id}")
        except stripe.error.StripeError as e:
            logger.warning(f"[REACTIVATE] Could not release schedule: {e}")

    async def _clear_subscription_metadata(self, subscription_id: str):
        await StripeAPIWrapper.modify_subscription(
            subscription_id,
            metadata={
                'downgrade': None,
                'previous_tier': None,
                'target_tier': None,
                'scheduled_by': None,
                'scheduled_at': None,
                'scheduled_price_id': None
            }
        )

    @classmethod
    async def handle_subscription_change(cls, subscription: Dict, previous_attributes: Dict = None):
        handler = cls()
        return await handler._handle_subscription_change(subscription, previous_attributes)
    



    async def _handle_subscription_change(self, subscription: Dict, previous_attributes: Dict = None):
        logger.info(f"[SUBSCRIPTION] Processing change for subscription {subscription.get('id')}, status: {subscription.get('status')}")
        
        customer_id = subscription.get('customer')
        account_id = await self.lifecycle_service.get_account_id_from_subscription(subscription, customer_id)
        if not account_id:
            return

        price_id = subscription['items']['data'][0]['price']['id'] if subscription.get('items') else None
        billing_anchor = datetime.fromtimestamp(subscription['current_period_start'], tz=timezone.utc)
        period_start = subscription.get('current_period_start')
        
        logger.debug(f"[SUBSCRIPTION] Account: {account_id}, Price: {price_id}, Billing anchor: {billing_anchor}")
        
        if await self._is_already_processed(account_id, period_start):
            return
        
        current_account = await self.credit_repo.get_credit_account(
            account_id, 
            'tier, stripe_subscription_id, last_grant_date, billing_cycle_anchor, trial_status'
        )

        await self._handle_trial_status_transition(subscription, previous_attributes, current_account, account_id)

        is_renewal = self.lifecycle_service.is_renewal(subscription, current_account, billing_anchor)
        
        if is_renewal:
            logger.info(f"[RENEWAL BLOCK] Subscription {subscription['id']} identified as renewal - NO CREDITS will be granted")
            await self._track_commitment_if_needed(account_id, price_id, subscription)
            await self._update_subscription_metadata_only(account_id, subscription, price_id)
            await self.lifecycle_service.invalidate_caches(account_id)
            return
        
        await self._process_subscription_change(subscription, account_id, price_id, billing_anchor, current_account)




    async def _is_already_processed(self, account_id: str, period_start: int) -> bool:
        guard_check = await self.credit_repo.check_renewal_already_processed(account_id, period_start)
        
        if guard_check and guard_check.get('already_processed'):
            logger.info(
                f"[SUBSCRIPTION GUARD] ⛔ Renewal already processed for {account_id} period {period_start} "
                f"by {guard_check.get('processed_by')}. Will only update metadata."
            )
            return True
        return False




    async def _handle_trial_status_transition(self, subscription: Dict, previous_attributes: Dict, current_account: Optional[Dict], account_id: str):
        if not current_account:
            return
        
        current_trial_status = current_account.get('trial_status')
        current_subscription_status = subscription.get('status')
        prev_subscription_status = previous_attributes.get('status') if previous_attributes else None
        
        if (current_trial_status == 'active' and 
            prev_subscription_status == 'trialing' and 
            current_subscription_status == 'active'):
            
            logger.info(f"[TRIAL END] Subscription transitioned from trialing to active - marking trial as converted")
            await self.trial_service.convert_trial(account_id, 'converted')




    async def _process_subscription_change(self, subscription: Dict, account_id: str, price_id: str, billing_anchor: datetime, current_account: Optional[Dict]):
        await self._track_commitment_if_needed(account_id, price_id, subscription)
        
        tier_info = get_tier_by_price_id(price_id)
        if not tier_info:
            logger.warning(f"Unknown price ID in subscription: {price_id}")
            await self.lifecycle_service.invalidate_caches(account_id)
            return
        
        new_tier = {
            'name': tier_info.name,
            'credits': float(tier_info.monthly_credits)
        }
        
        if subscription.status == 'trialing' and subscription.get('trial_end'):
            await self._handle_trial_subscription(subscription, account_id, new_tier, current_account)
            await self.lifecycle_service.invalidate_caches(account_id)
            return
        
        if current_account:
            await self._handle_existing_account_subscription(
                current_account, account_id, new_tier, billing_anchor, subscription
            )
        else:
            await self._handle_new_account_subscription(account_id, new_tier, billing_anchor, subscription)
        
        await self.lifecycle_service.invalidate_caches(account_id)





    async def _handle_trial_subscription(self, subscription: Dict, account_id: str, new_tier: Dict, current_account: Optional[Dict]):
        existing_trial = current_account.get('trial_status') if current_account else None
        
        if existing_trial in ['converted']:
            logger.info(f"[SUBSCRIPTION] Trial already converted for {account_id}, processing as regular subscription")
            return
        
        await self.trial_service.activate_trial(account_id, subscription, new_tier)





    async def _handle_existing_account_subscription(self, existing_data: Dict, account_id: str, new_tier: Dict, billing_anchor: datetime, subscription: Dict):
        current_tier_name = existing_data.get('tier')
        last_grant_date = existing_data.get('last_grant_date')
        trial_status = existing_data.get('trial_status')
        
        if trial_status == 'cancelled' and subscription.status == 'active':
            logger.info(f"[SUBSCRIPTION] User {account_id} with cancelled trial is subscribing - treating as new subscription")
            await self._handle_new_account_subscription(account_id, new_tier, billing_anchor, subscription)
            return
        
        is_tier_change = current_tier_name != new_tier['name']
        if not is_tier_change and self.lifecycle_service.is_duplicate_credit_grant(last_grant_date, billing_anchor, current_tier_name, new_tier):
            logger.warning(f"[DOUBLE CREDIT BLOCK] Duplicate credit grant detected for SAME tier - updating metadata only")
            await self._update_subscription_metadata_only(account_id, subscription, subscription['items']['data'][0]['price']['id'])
            return
        elif is_tier_change:
            logger.info(f"[TIER CHANGE DETECTED] {current_tier_name} -> {new_tier['name']} - proceeding with credit processing")
        
        current_tier = get_tier_by_name(current_tier_name) if current_tier_name else None
        current_tier_data = {
            'name': current_tier.name,
            'credits': float(current_tier.monthly_credits)
        } if current_tier else {'name': 'none', 'credits': 0}
        
        should_grant_credits = self.lifecycle_service.should_grant_credits(current_tier_data, new_tier, subscription)
        
        if should_grant_credits:
            original_tier = subscription.get('metadata', {}).get('previous_tier', current_tier_name)
            
            is_free_to_paid_upgrade = (original_tier in ['free', 'none'] and new_tier['name'] not in ['free', 'none'])
            is_paid_to_paid_upgrade = (original_tier not in ['free', 'none'] and original_tier != new_tier['name'])
            
            is_tier_upgrade = is_free_to_paid_upgrade or is_paid_to_paid_upgrade
            
            logger.info(f"[TIER UPGRADE DETECTION] Original: {original_tier}, New: {new_tier['name']}, Is upgrade: {is_tier_upgrade}")
            
            if is_tier_upgrade:
                logger.info(f"[TIER UPGRADE] Processing tier upgrade: {current_tier_name} -> {new_tier['name']}")
                await self.lifecycle_service.grant_subscription_credits(account_id, new_tier, billing_anchor, True)
            else:
                logger.info(f"[NEW SUBSCRIPTION] Processing brand new subscription for {new_tier['name']}")
                await self.lifecycle_service.grant_subscription_credits(account_id, new_tier, billing_anchor, False)
            
            await self.credit_repo.update_credit_account(account_id, {
                'last_grant_date': billing_anchor.isoformat()
            })
        
        await self._update_subscription_metadata_only(account_id, subscription, subscription['items']['data'][0]['price']['id'])





    async def _handle_new_account_subscription(self, account_id: str, new_tier: Dict, billing_anchor: datetime, subscription: Dict):
        logger.info(f"[SUBSCRIPTION] Creating initial subscription for {account_id}")
        
        await self.lifecycle_service.grant_subscription_credits(account_id, new_tier, billing_anchor, is_tier_upgrade=False)
        
        plan_type = get_plan_type(subscription['items']['data'][0]['price']['id'])
        next_grant_date = self.lifecycle_service.calculate_next_credit_grant(
            plan_type, billing_anchor, subscription['current_period_end']
        )
        
        await self.credit_repo.update_credit_account(account_id, {
            'tier': new_tier['name'],
            'plan_type': plan_type,
            'stripe_subscription_id': subscription['id'],
            'billing_cycle_anchor': billing_anchor.isoformat(),
            'next_credit_grant': next_grant_date.isoformat(),
            'trial_status': 'none',
            'last_grant_date': billing_anchor.isoformat()
        })
        
        logger.info(f"[SUBSCRIPTION] ✅ Initial subscription setup completed for {account_id}")




    async def _update_subscription_metadata_only(self, account_id: str, subscription: Dict, price_id: str):
        logger.info(f"[SUBSCRIPTION] Updating metadata only (no credit grants) for {account_id}")
        
        tier_info = get_tier_by_price_id(price_id)
        if not tier_info:
            logger.warning(f"Unknown price ID in subscription: {price_id}")
            return
        
        plan_type = get_plan_type(price_id)
        billing_anchor = datetime.fromtimestamp(subscription['current_period_start'], tz=timezone.utc)
        next_grant_date = self.lifecycle_service.calculate_next_credit_grant(
            plan_type, billing_anchor, subscription['current_period_end']
        )
        
        await self.credit_repo.update_credit_account(account_id, {
            'tier': tier_info.name,
            'plan_type': plan_type,
            'stripe_subscription_id': subscription['id'],
            'billing_cycle_anchor': billing_anchor.isoformat(),
            'next_credit_grant': next_grant_date.isoformat()
        })
        
        await self._track_commitment_if_needed(account_id, price_id, subscription)
        
        logger.info(f"[SUBSCRIPTION] ✅ Metadata updated for {account_id}, tier={tier_info.name}")
    




    async def _track_commitment_if_needed(self, account_id: str, price_id: str, subscription: Dict):
        if not is_commitment_price_id(price_id):
            return
        
        commitment_duration = get_commitment_duration_months(price_id)
        if commitment_duration == 0:
            return
        
        existing_commitment = await self.commitment_repo.get_existing_commitment(subscription['id'])
        if existing_commitment:
            logger.info(f"[COMMITMENT] Commitment already tracked for subscription {subscription['id']}, skipping")
            return
        
        from datetime import timedelta
        start_date = datetime.fromtimestamp(subscription['current_period_start'], tz=timezone.utc)
        end_date = start_date + timedelta(days=365) if commitment_duration == 12 else start_date + timedelta(days=commitment_duration * 30)
        
        commitment_data = {
            'commitment_type': 'yearly_commitment',
            'commitment_start_date': start_date.isoformat(),
            'commitment_end_date': end_date.isoformat(),
            'commitment_price_id': price_id,
            'can_cancel_after': end_date.isoformat()
        }
        
        await self.credit_repo.update_commitment_info(account_id, commitment_data)
        
        await self.commitment_repo.create_commitment_history({
            'account_id': account_id,
            'commitment_type': 'yearly_commitment',
            'price_id': price_id,
            'start_date': start_date.isoformat(),
            'end_date': end_date.isoformat(),
            'stripe_subscription_id': subscription['id']
        })
        
        logger.info(f"[COMMITMENT] Tracked yearly commitment for account {account_id}, subscription {subscription['id']}, ends {end_date.date()}")
        