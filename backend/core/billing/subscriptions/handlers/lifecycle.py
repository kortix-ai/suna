from fastapi import HTTPException
from typing import Dict, Optional
from decimal import Decimal
from datetime import datetime, timezone
from dateutil.relativedelta import relativedelta

import stripe
from core.services.supabase import DBConnection
from core.utils.logger import logger
from core.utils.cache import Cache
from core.utils.distributed_lock import DistributedLock
from core.billing.shared.config import (
    get_tier_by_price_id, 
    get_tier_by_name,
    TRIAL_DURATION_DAYS,
    TRIAL_CREDITS,
    is_commitment_price_id,
    get_commitment_duration_months,
    get_plan_type
)
from core.billing.credits.manager import credit_manager
from core.billing.external.stripe import StripeAPIWrapper

class SubscriptionLifecycleHandler:
    @staticmethod
    async def cancel_subscription(account_id: str, feedback: Optional[str] = None) -> Dict:
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
                await SubscriptionLifecycleHandler._save_cancellation_feedback(account_id, feedback)
            
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

    @staticmethod
    async def _save_cancellation_feedback(account_id: str, feedback: str):
        try:
            db = DBConnection()
            client = await db.client
            credit_result = await client.from_('credit_accounts').select(
                'stripe_subscription_id'
            ).eq('account_id', account_id).execute()
            
            if credit_result.data and credit_result.data[0].get('stripe_subscription_id'):
                subscription_id = credit_result.data[0]['stripe_subscription_id']
                await StripeAPIWrapper.modify_subscription(
                    subscription_id,
                    metadata={'cancellation_feedback': feedback}
                )
                logger.info(f"[CANCEL] Saved cancellation feedback for {account_id}")
        except Exception as e:
            logger.warning(f"[CANCEL] Could not save feedback: {e}")

    @staticmethod
    async def reactivate_subscription(account_id: str) -> Dict:
        db = DBConnection()
        client = await db.client
        
        credit_result = await client.from_('credit_accounts').select(
            'stripe_subscription_id, scheduled_tier_change, scheduled_price_id'
        ).eq('account_id', account_id).execute()
        
        if not credit_result.data or not credit_result.data[0].get('stripe_subscription_id'):
            raise HTTPException(status_code=404, detail="No subscription found")
        
        subscription_id = credit_result.data[0]['stripe_subscription_id']
        scheduled_tier = credit_result.data[0].get('scheduled_tier_change')
        
        try:
            subscription = await StripeAPIWrapper.retrieve_subscription(subscription_id)
            
            if scheduled_tier:
                await SubscriptionLifecycleHandler._cancel_scheduled_downgrade(
                    account_id, subscription, subscription_id, client
                )
            
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

    @staticmethod
    async def _cancel_scheduled_downgrade(account_id: str, subscription: Dict, subscription_id: str, client):
        logger.info(f"[REACTIVATE] Found scheduled downgrade, cancelling it")
        
        schedule_id = subscription.get('schedule')
        if schedule_id:
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
        
        await client.from_('credit_accounts').update({
            'scheduled_tier_change': None,
            'scheduled_tier_change_date': None,
            'scheduled_price_id': None
        }).eq('account_id', account_id).execute()
        
        logger.info(f"[REACTIVATE] Cleared scheduled downgrade for {account_id}")

    @staticmethod
    async def handle_subscription_change(subscription: Dict, previous_attributes: Dict = None):
        logger.info(f"[SUBSCRIPTION] Processing change for subscription {subscription.get('id')}, status: {subscription.get('status')}")
        
        db = DBConnection()
        client = await db.client
        
        account_id = await SubscriptionLifecycleHandler._get_account_id(subscription, client)
        if not account_id:
            return

        price_id = subscription['items']['data'][0]['price']['id'] if subscription.get('items') else None
        billing_anchor = datetime.fromtimestamp(subscription['current_period_start'], tz=timezone.utc)
        period_start = subscription.get('current_period_start')
        
        logger.debug(f"[SUBSCRIPTION] Account: {account_id}, Price: {price_id}, Billing anchor: {billing_anchor}")
        
        guard_check = await client.rpc('check_renewal_already_processed', {
            'p_account_id': account_id,
            'p_period_start': period_start
        }).execute()
        
        if guard_check.data and guard_check.data.get('already_processed'):
            logger.info(
                f"[SUBSCRIPTION GUARD] ⛔ Renewal already processed for {account_id} period {period_start} "
                f"by {guard_check.data.get('processed_by')}. Will only update metadata, no credit grants."
            )
            await SubscriptionLifecycleHandler._update_subscription_metadata_only(
                account_id, subscription, price_id, client
            )
            await Cache.invalidate(f"subscription_tier:{account_id}")
            return

        current_account = await client.from_('credit_accounts').select(
            'tier, stripe_subscription_id, last_grant_date, billing_cycle_anchor, last_processed_invoice_id, trial_status'
        ).eq('account_id', account_id).execute()

        await SubscriptionLifecycleHandler._handle_trial_status_transition(
            subscription, previous_attributes, current_account, client, account_id
        )

        is_renewal = await SubscriptionLifecycleHandler._detect_renewal(
            subscription, previous_attributes, current_account, billing_anchor, account_id
        )
        
        if is_renewal:
            logger.info(f"[RENEWAL BLOCK] Subscription {subscription['id']} identified as renewal - NO CREDITS will be granted")
            logger.info(f"[RENEWAL BLOCK] Credits for renewals are handled exclusively by invoice.payment_succeeded webhook")
            
            await SubscriptionLifecycleHandler._track_commitment_if_needed(account_id, price_id, subscription, client)
            await SubscriptionLifecycleHandler._update_subscription_metadata_only(account_id, subscription, price_id, client)
            await Cache.invalidate(f"subscription_tier:{account_id}")
            return
        
        await SubscriptionLifecycleHandler._process_subscription_change(
            subscription, account_id, price_id, billing_anchor, current_account, client
        )

    @staticmethod
    async def _get_account_id(subscription: Dict, client) -> Optional[str]:
        account_id = subscription.get('metadata', {}).get('account_id')
        
        if not account_id:
            customer_result = await client.schema('basejump').from_('billing_customers').select('account_id').eq('id', subscription['customer']).execute()
            
            if not customer_result.data or len(customer_result.data) == 0:
                logger.warning(f"Could not find account for customer {subscription['customer']}")
                return None
            
            account_id = customer_result.data[0]['account_id']
        
        return account_id

    @staticmethod
    async def _handle_trial_status_transition(subscription: Dict, previous_attributes: Dict, current_account, client, account_id: str):
        if current_account.data:
            current_trial_status = current_account.data[0].get('trial_status')
            current_subscription_status = subscription.get('status')
            prev_subscription_status = previous_attributes.get('status') if previous_attributes else None
            
            if current_trial_status == 'active' and prev_subscription_status == 'trialing' and current_subscription_status == 'active':
                logger.info(f"[TRIAL END] Subscription transitioned from trialing to active - marking trial as converted")
                await client.from_('credit_accounts').update({
                    'trial_status': 'converted'
                }).eq('account_id', account_id).execute()
                await client.from_('trial_history').update({
                    'ended_at': datetime.now(timezone.utc).isoformat(),
                    'converted_to_paid': True
                }).eq('account_id', account_id).is_('ended_at', 'null').execute()

    @staticmethod
    async def _detect_renewal(subscription: Dict, previous_attributes: Dict, current_account, billing_anchor: datetime, account_id: str) -> bool:
        is_renewal = False
        is_upgrade = False
        
        if subscription.get('id'):
            try:
                invoices = await StripeAPIWrapper.list_invoices(
                    subscription=subscription['id'],
                    limit=5
                )
                
                current_period_start = subscription.get('current_period_start')
                current_period_end = subscription.get('current_period_end')
                
                for invoice in invoices.data:
                    invoice_period_start = invoice.get('period_start')
                    invoice_period_end = invoice.get('period_end')
                    
                    if (invoice_period_start == current_period_start or 
                        invoice_period_end == current_period_end):
                        
                        invoice_status = invoice.get('status')
                        billing_reason = invoice.get('billing_reason')
                        
                        is_upgrade_invoice = billing_reason == 'subscription_update'
                        
                        logger.warning(f"[RENEWAL DETECTION] Found invoice {invoice['id']} for current period")
                        logger.warning(f"[RENEWAL DETECTION] Invoice status: {invoice_status}, billing_reason: {billing_reason}")
                        
                        current_tier_name = current_account.data[0].get('tier') if current_account.data else 'none'
                        new_tier_info = get_tier_by_price_id(subscription['items']['data'][0]['price']['id'])
                        is_free_to_paid_upgrade = (current_tier_name in ['free', 'none'] and 
                                                  new_tier_info and 
                                                  new_tier_info.name not in ['free', 'none'])
                        
                        if not is_upgrade_invoice and not is_free_to_paid_upgrade and invoice_status in ['draft', 'open', 'paid', 'uncollectible']:
                            is_renewal = True
                            logger.warning(f"[RENEWAL DETECTION] Invoice exists (status: {invoice_status}) - this is a RENEWAL")
                            break
                        elif is_upgrade_invoice or is_free_to_paid_upgrade:
                            if is_free_to_paid_upgrade:
                                logger.info(f"[RENEWAL DETECTION] Free-to-paid upgrade detected - NOT blocking credits")
                            else:
                                logger.info(f"[RENEWAL DETECTION] Upgrade invoice detected - NOT blocking credits")
                            is_upgrade = True
                            break
                        
            except Exception as e:
                logger.error(f"[RENEWAL DETECTION] Error checking invoices: {e}")

        if not is_renewal and not is_upgrade:
            now = datetime.now(timezone.utc)
            seconds_since_period_start = (now - billing_anchor).total_seconds()
            
            if 0 <= seconds_since_period_start < 1800:
                current_tier_name = current_account.data[0].get('tier') if current_account.data else 'none'
                old_subscription_id = current_account.data[0].get('stripe_subscription_id') if current_account.data else None
                new_tier_info = get_tier_by_price_id(subscription['items']['data'][0]['price']['id'])
                
                is_new_subscription = (old_subscription_id is None or 
                                      old_subscription_id == '' or 
                                      old_subscription_id != subscription.get('id'))
                
                is_free_to_paid_upgrade = (current_tier_name in ['free', 'none'] and 
                                          new_tier_info and 
                                          new_tier_info.name not in ['free', 'none'])
                
                if is_new_subscription or is_free_to_paid_upgrade:
                    logger.info(f"[RENEWAL DETECTION] Within 30min BUT new subscription (old_sub={old_subscription_id}, new_sub={subscription.get('id')}) or free-to-paid upgrade ({current_tier_name} → {new_tier_info.name if new_tier_info else 'unknown'}) - NOT blocking")
                else:
                    is_renewal = True
                    logger.warning(f"[RENEWAL DETECTION] We're only {seconds_since_period_start:.0f}s after period start - this is almost certainly a renewal - BLOCKING")

        return is_renewal

    @staticmethod
    async def _process_subscription_change(subscription: Dict, account_id: str, price_id: str, billing_anchor: datetime, current_account, client):
        await SubscriptionLifecycleHandler._track_commitment_if_needed(account_id, price_id, subscription, client)
        
        new_tier_info = get_tier_by_price_id(price_id)
        if not new_tier_info:
            logger.warning(f"Unknown price ID in subscription: {price_id}")
            await Cache.invalidate(f"subscription_tier:{account_id}")
            return
        
        new_tier = {
            'name': new_tier_info.name,
            'credits': float(new_tier_info.monthly_credits)
        }
        
        if subscription.status == 'trialing' and subscription.get('trial_end'):
            existing_trial = await client.from_('credit_accounts').select('trial_status').eq('account_id', account_id).execute()
            if existing_trial.data and existing_trial.data[0].get('trial_status') in ['converted']:
                logger.info(f"[SUBSCRIPTION] Trial already converted for {account_id}, processing as regular subscription")
            else:
                await SubscriptionLifecycleHandler._handle_trial_subscription(subscription, account_id, new_tier, client)
                await Cache.invalidate(f"subscription_tier:{account_id}")
                return
        
        next_grant_date = datetime.fromtimestamp(subscription['current_period_end'], tz=timezone.utc)
        
        if current_account.data:
            await SubscriptionLifecycleHandler._handle_existing_account_subscription(
                current_account.data[0], account_id, new_tier, billing_anchor, subscription, client, next_grant_date
            )
        else:
            logger.warning(f"[SUBSCRIPTION] No existing credit account found for {account_id} - creating initial subscription")
            await SubscriptionLifecycleHandler._grant_initial_subscription_credits(account_id, new_tier, billing_anchor, subscription, client)
        
        await Cache.invalidate(f"subscription_tier:{account_id}")
        await Cache.invalidate(f"credit_balance:{account_id}")
        await Cache.invalidate(f"credit_summary:{account_id}")
        await Cache.invalidate(f"project_count_limit:{account_id}")

    @staticmethod
    async def _handle_existing_account_subscription(existing_data: Dict, account_id: str, new_tier: Dict, billing_anchor: datetime, subscription: Dict, client, next_grant_date: datetime):
        current_tier_name = existing_data.get('tier')
        old_subscription_id = existing_data.get('stripe_subscription_id')
        last_grant_date = existing_data.get('last_grant_date')
        current_trial_status = existing_data.get('trial_status')
        last_renewal_period_start = existing_data.get('last_renewal_period_start')
        
        if current_trial_status == 'cancelled' and subscription.status == 'active' and not old_subscription_id:
            logger.info(f"[SUBSCRIPTION] User {account_id} with cancelled trial is subscribing - treating as new subscription")
            await SubscriptionLifecycleHandler._grant_initial_subscription_credits(account_id, new_tier, billing_anchor, subscription, client)
            return
        
        if last_renewal_period_start and last_renewal_period_start == subscription.get('current_period_start'):
            logger.warning(f"[DOUBLE CREDIT BLOCK] Invoice webhook already processed period {subscription.get('current_period_start')}")
            await Cache.invalidate(f"subscription_tier:{account_id}")
            return
        
        if SubscriptionLifecycleHandler._is_duplicate_credit_grant(last_grant_date, billing_anchor, current_tier_name, new_tier):
            logger.warning(f"[DOUBLE CREDIT BLOCK] Duplicate credit grant detected - BLOCKING credits but updating metadata")
            
            plan_type = get_plan_type(subscription['items']['data'][0]['price']['id'])
            
            # Calculate correct next_credit_grant for duplicate block case
            if plan_type == 'yearly':
                next_grant_date = billing_anchor + relativedelta(months=1)
                logger.info(f"[SUBSCRIPTION] Duplicate block yearly: next credits in 1 month ({next_grant_date})")
            elif plan_type == 'yearly_commitment':
                next_grant_date = datetime.fromtimestamp(subscription['current_period_end'], tz=timezone.utc)
                logger.info(f"[SUBSCRIPTION] Duplicate block yearly commitment: next credits at period end ({next_grant_date})")
            else:
                next_grant_date = datetime.fromtimestamp(subscription['current_period_end'], tz=timezone.utc)
                logger.info(f"[SUBSCRIPTION] Duplicate block monthly: next credits at period end ({next_grant_date})")
            
            logger.info(f"[SUBSCRIPTION] Updating metadata only due to duplicate block: account_id={account_id}, tier={new_tier['name']}, plan_type={plan_type}")
            
            await client.from_('credit_accounts').update({
                'tier': new_tier['name'],
                'plan_type': plan_type,
                'stripe_subscription_id': subscription['id'],
                'billing_cycle_anchor': billing_anchor.isoformat(),
                'next_credit_grant': next_grant_date.isoformat()
            }).eq('account_id', account_id).execute()
            
            await Cache.invalidate(f"subscription_tier:{account_id}")
            return
        
        current_tier = get_tier_by_name(current_tier_name) if current_tier_name else None
        current_tier = {
            'name': current_tier.name,
            'credits': float(current_tier.monthly_credits)
        } if current_tier else {
            'name': 'none',
            'credits': 0
        }
        
        if current_tier['name'] == new_tier['name'] and current_tier['name'] not in ['free', 'none']:
            plan_type = get_plan_type(subscription['items']['data'][0]['price']['id'])
            
            if plan_type == 'yearly':
                next_grant_date = billing_anchor + relativedelta(months=1)
                logger.info(f"[SUBSCRIPTION] Same tier yearly: next credits in 1 month ({next_grant_date})")
            elif plan_type == 'yearly_commitment':
                next_grant_date = datetime.fromtimestamp(subscription['current_period_end'], tz=timezone.utc)
                logger.info(f"[SUBSCRIPTION] Same tier yearly commitment: next credits at period end ({next_grant_date})")
            else:
                next_grant_date = datetime.fromtimestamp(subscription['current_period_end'], tz=timezone.utc)
                logger.info(f"[SUBSCRIPTION] Same tier monthly: next credits at period end ({next_grant_date})")

            await client.from_('credit_accounts').update({
                'tier': new_tier['name'],
                'plan_type': plan_type,
                'stripe_subscription_id': subscription['id'],
                'billing_cycle_anchor': billing_anchor.isoformat(),
                'next_credit_grant': next_grant_date.isoformat()
            }).eq('account_id', account_id).execute()
            return
        
        should_grant_credits = SubscriptionLifecycleHandler._should_grant_credits(
            current_tier_name, current_tier, new_tier, subscription, old_subscription_id
        )
        
        if should_grant_credits:
            logger.info(f"[UPGRADE] Granting upgrade credits")
            await client.from_('credit_accounts').update({
                'last_grant_date': billing_anchor.isoformat()
            }).eq('account_id', account_id).execute()
            
            await SubscriptionLifecycleHandler._grant_subscription_credits(account_id, new_tier, billing_anchor)
        else:
            logger.info(f"No credits granted - not an upgrade scenario")
        
        plan_type = get_plan_type(subscription['items']['data'][0]['price']['id'])
        
        if plan_type == 'yearly':
            next_grant_date = billing_anchor + relativedelta(months=1)
            logger.info(f"[SUBSCRIPTION] Yearly plan: next credits in 1 month ({next_grant_date})")
        elif plan_type == 'yearly_commitment':
            next_grant_date = datetime.fromtimestamp(subscription['current_period_end'], tz=timezone.utc)
            logger.info(f"[SUBSCRIPTION] Yearly commitment: next credits at period end ({next_grant_date})")
        else:
            next_grant_date = datetime.fromtimestamp(subscription['current_period_end'], tz=timezone.utc)
            logger.info(f"[SUBSCRIPTION] Monthly plan: next credits at period end ({next_grant_date})")
        
        await client.from_('credit_accounts').update({
            'tier': new_tier['name'],
            'plan_type': plan_type,
            'stripe_subscription_id': subscription['id'],
            'billing_cycle_anchor': billing_anchor.isoformat(),
            'next_credit_grant': next_grant_date.isoformat()
        }).eq('account_id', account_id).execute()

    @staticmethod
    def _is_duplicate_credit_grant(last_grant_date: str, billing_anchor: datetime, current_tier_name: str, new_tier: Dict) -> bool:
        if not last_grant_date:
            return False
            
        try:
            last_grant_dt = datetime.fromisoformat(last_grant_date.replace('Z', '+00:00'))
            time_since_last_grant = (datetime.now(timezone.utc) - last_grant_dt).total_seconds()
            
            is_free_to_paid_upgrade = (current_tier_name in ['free', 'none'] and 
                                      new_tier['name'] not in ['free', 'none'])
            
            if time_since_last_grant < 900 and current_tier_name == new_tier['name'] and not is_free_to_paid_upgrade:
                logger.warning(f"[DOUBLE CREDIT BLOCK] Credits granted {time_since_last_grant:.0f}s ago for tier {new_tier['name']}")
                return True
            elif is_free_to_paid_upgrade:
                logger.info(f"[FREE TO PAID UPGRADE] Allowing credit grant despite recent activity - upgrading from {current_tier_name} to {new_tier['name']}")
            
            if abs((billing_anchor - last_grant_dt).total_seconds()) < 900 and not is_free_to_paid_upgrade:
                logger.warning(f"[DOUBLE CREDIT BLOCK] Credits already granted near billing period start")
                return True
        except Exception as e:
            logger.warning(f"Error parsing dates for idempotency check: {e}")
            
        return False

    @staticmethod
    def _should_grant_credits(current_tier_name: str, current_tier: Dict, new_tier: Dict, subscription: Dict, old_subscription_id: str, is_renewal: bool = False) -> bool:
        if is_renewal:
            return False
        elif current_tier_name in ['free', 'none'] and new_tier['name'] not in ['free', 'none']:
            logger.info(f"Upgrade from free tier to {new_tier['name']} - will grant credits")
            return True
        elif current_tier:
            if current_tier['name'] != new_tier['name']:
                if new_tier['credits'] > current_tier['credits']:
                    logger.info(f"Tier upgrade detected: {current_tier['name']} -> {new_tier['name']}")
                    return True
                else:
                    logger.info(f"Tier change (not upgrade): {current_tier['name']} -> {new_tier['name']}")
            elif subscription['id'] != old_subscription_id and old_subscription_id is not None:
                logger.info(f"New subscription for tier {new_tier['name']}: {old_subscription_id} -> {subscription['id']}")
                return True
            elif new_tier['credits'] > current_tier['credits']:
                logger.info(f"Credit increase for tier {new_tier['name']}: {current_tier['credits']} -> {new_tier['credits']}")
                return True
        
        return False

    @staticmethod
    async def _handle_trial_subscription(subscription, account_id, new_tier, client):
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
            
            existing_account = await client.from_('credit_accounts').select('trial_status').eq('account_id', account_id).execute()
            if existing_account.data:
                current_status = existing_account.data[0].get('trial_status')
                if current_status == 'active':
                    logger.info(f"[WEBHOOK] Trial already active for account {account_id}, skipping duplicate processing")
                    return
            
            recent_trial_credits = await client.from_('credit_ledger').select('*').eq(
                'account_id', account_id
            ).eq('description', f'{TRIAL_DURATION_DAYS}-day free trial credits').execute()
            
            if recent_trial_credits.data:
                logger.warning(f"[WEBHOOK] Trial credits already granted for account {account_id} (found in ledger), skipping duplicate")
                return
                
            trial_ends_at = datetime.fromtimestamp(subscription.trial_end, tz=timezone.utc)
            
            plan_type = get_plan_type(subscription['items']['data'][0]['price']['id'])
            logger.info(f"[TRIAL] Setting plan_type to: {plan_type} for trial subscription")
            
            await client.from_('credit_accounts').update({
                'trial_status': 'active',
                'trial_started_at': datetime.now(timezone.utc).isoformat(),
                'trial_ends_at': trial_ends_at.isoformat(),
                'stripe_subscription_id': subscription['id'],
                'tier': new_tier['name'],
                'plan_type': plan_type
            }).eq('account_id', account_id).execute()
            
            await credit_manager.add_credits(
                account_id=account_id,
                amount=TRIAL_CREDITS,
                is_expiring=True,
                description=f'{TRIAL_DURATION_DAYS}-day free trial credits',
                expires_at=trial_ends_at
            )
            
            await client.from_('trial_history').upsert({
                'account_id': account_id,
                'started_at': datetime.now(timezone.utc).isoformat()
            }, on_conflict='account_id').execute()
            
            await Cache.invalidate(f"subscription_tier:{account_id}")
            await Cache.invalidate(f"credit_balance:{account_id}")
            await Cache.invalidate(f"credit_summary:{account_id}")
            
            logger.info(f"[WEBHOOK] ✅ Started trial for user {account_id} via Stripe subscription - granted ${TRIAL_CREDITS} credits")
        finally:
            await lock.release()

    @staticmethod
    async def _grant_subscription_credits(account_id: str, new_tier: Dict, billing_anchor: datetime):
        full_amount = Decimal(new_tier['credits'])
        
        lock_key = f"credit_grant:upgrade:{account_id}:{int(billing_anchor.timestamp())}"
        lock = DistributedLock(lock_key, timeout_seconds=60)
        
        acquired = await lock.acquire(wait=True, wait_timeout=30)
        if not acquired:
            logger.error(f"[CREDIT GRANT] Failed to acquire lock for upgrade grant to {account_id}")
            raise Exception(f"Failed to acquire lock for credit grant - possible concurrent processing")
        
        try:
            logger.info(f"[CREDIT GRANT] 🔒 Acquired lock for granting ${full_amount} credits to {account_id} for tier {new_tier['name']} upgrade")
            
            expires_at = billing_anchor.replace(month=billing_anchor.month + 1) if billing_anchor.month < 12 else billing_anchor.replace(year=billing_anchor.year + 1, month=1)
            await credit_manager.add_credits(
                account_id=account_id,
                amount=full_amount,
                is_expiring=True,
                description=f"Tier upgrade to {new_tier['name']}",
                expires_at=expires_at
            )
            
            logger.info(f"[CREDIT GRANT] ✅ Successfully granted {full_amount} expiring credits for tier upgrade to {new_tier['name']}")
        finally:
            await lock.release()

    @staticmethod
    async def _grant_initial_subscription_credits(account_id: str, new_tier: Dict, billing_anchor: datetime, subscription: Dict, client):
        lock_key = f"credit_grant:initial:{account_id}:{int(billing_anchor.timestamp())}"
        lock = DistributedLock(lock_key, timeout_seconds=60)
        
        acquired = await lock.acquire(wait=True, wait_timeout=30)
        if not acquired:
            logger.error(f"[CREDIT GRANT] Failed to acquire lock for initial grant to {account_id}")
            raise Exception(f"Failed to acquire lock for initial credit grant - possible concurrent processing")
        
        try:
            logger.info(f"[CREDIT GRANT] 🔒 Acquired lock for initial grant to {account_id} for tier {new_tier['name']}")
            
            expires_at = billing_anchor.replace(month=billing_anchor.month + 1) if billing_anchor.month < 12 else billing_anchor.replace(year=billing_anchor.year + 1, month=1)
            
            await credit_manager.add_credits(
                account_id=account_id,
                amount=Decimal(new_tier['credits']),
                is_expiring=True,
                description=f"Initial grant for {new_tier['name']} subscription",
                expires_at=expires_at
            )
            
            plan_type = get_plan_type(subscription['items']['data'][0]['price']['id'])
            
            # Calculate correct next_credit_grant based on plan type
            if plan_type == 'yearly':
                next_grant_date = billing_anchor + relativedelta(months=1)
                logger.info(f"[CREDIT GRANT] Yearly plan: next credits in 1 month ({next_grant_date})")
            elif plan_type == 'yearly_commitment':
                next_grant_date = datetime.fromtimestamp(subscription['current_period_end'], tz=timezone.utc)
                logger.info(f"[CREDIT GRANT] Yearly commitment: next credits at period end ({next_grant_date})")
            else:
                next_grant_date = datetime.fromtimestamp(subscription['current_period_end'], tz=timezone.utc)
                logger.info(f"[CREDIT GRANT] Monthly plan: next credits at period end ({next_grant_date})")

            await client.from_('credit_accounts').update({
                'tier': new_tier['name'],
                'plan_type': plan_type,
                'stripe_subscription_id': subscription['id'],
                'billing_cycle_anchor': billing_anchor.isoformat(),
                'next_credit_grant': next_grant_date.isoformat(),
                'trial_status': 'none',
                'last_grant_date': billing_anchor.isoformat()
            }).eq('account_id', account_id).execute()
            
            await Cache.invalidate(f"subscription_tier:{account_id}")
            await Cache.invalidate(f"credit_balance:{account_id}")
            await Cache.invalidate(f"credit_summary:{account_id}")
            
            logger.info(f"[CREDIT GRANT] ✅ Initial grant completed for {account_id}")
        finally:
            await lock.release()

    @staticmethod
    async def _update_subscription_metadata_only(account_id: str, subscription: Dict, price_id: str, client):
        logger.info(f"[SUBSCRIPTION] Updating metadata only (no credit grants) for {account_id}")
        
        new_tier_info = get_tier_by_price_id(price_id)
        if not new_tier_info:
            logger.warning(f"Unknown price ID in subscription: {price_id}")
            await Cache.invalidate(f"subscription_tier:{account_id}")
            return
        
        plan_type = get_plan_type(price_id)
        billing_anchor = datetime.fromtimestamp(subscription['current_period_start'], tz=timezone.utc)
        
        # Calculate correct next_credit_grant based on plan type
        if plan_type == 'yearly':
            # Yearly: User pays upfront, gets credits monthly
            from dateutil.relativedelta import relativedelta
            next_grant_date = billing_anchor + relativedelta(months=1)
            logger.info(f"[SUBSCRIPTION] Yearly plan: next credits in 1 month ({next_grant_date})")
        elif plan_type == 'yearly_commitment':
            # Yearly commitment: User pays monthly but committed to 12 months
            next_grant_date = datetime.fromtimestamp(subscription['current_period_end'], tz=timezone.utc)
            logger.info(f"[SUBSCRIPTION] Yearly commitment: next credits at period end ({next_grant_date})")
        else:
            # Monthly: Normal period end
            next_grant_date = datetime.fromtimestamp(subscription['current_period_end'], tz=timezone.utc)
            logger.info(f"[SUBSCRIPTION] Monthly plan: next credits at period end ({next_grant_date})")
        
        logger.info(f"[SUBSCRIPTION] Updating metadata only: account_id={account_id}, tier={new_tier_info.name}, plan_type={plan_type}, price_id={price_id}")
        
        await client.from_('credit_accounts').update({
            'tier': new_tier_info.name,
            'plan_type': plan_type,
            'stripe_subscription_id': subscription['id'],
            'billing_cycle_anchor': billing_anchor.isoformat(),
            'next_credit_grant': next_grant_date.isoformat()
        }).eq('account_id', account_id).execute()
        
        await SubscriptionLifecycleHandler._track_commitment_if_needed(account_id, price_id, subscription, client)
        
        await Cache.invalidate(f"subscription_tier:{account_id}")
        await Cache.invalidate(f"credit_balance:{account_id}")
        await Cache.invalidate(f"credit_summary:{account_id}")
        await Cache.invalidate(f"project_count_limit:{account_id}")
        
        logger.info(f"[SUBSCRIPTION] ✅ Metadata updated for {account_id}, tier={new_tier_info.name}")
    
    @staticmethod
    async def _track_commitment_if_needed(account_id: str, price_id: str, subscription: Dict, client):
        if not is_commitment_price_id(price_id):
            return
        
        commitment_duration = get_commitment_duration_months(price_id)
        if commitment_duration == 0:
            return
        
        existing_commitment = await client.from_('commitment_history').select('id').eq('stripe_subscription_id', subscription['id']).execute()
        if existing_commitment.data:
            logger.info(f"[COMMITMENT] Commitment already tracked for subscription {subscription['id']}, skipping")
            return
        
        from datetime import timedelta
        start_date = datetime.fromtimestamp(subscription['current_period_start'], tz=timezone.utc)
        end_date = start_date + timedelta(days=365) if commitment_duration == 12 else start_date + timedelta(days=commitment_duration * 30)
        
        await client.from_('credit_accounts').update({
            'commitment_type': 'yearly_commitment',
            'commitment_start_date': start_date.isoformat(),
            'commitment_end_date': end_date.isoformat(),
            'commitment_price_id': price_id,
            'can_cancel_after': end_date.isoformat()
        }).eq('account_id', account_id).execute()
        
        await client.from_('commitment_history').insert({
            'account_id': account_id,
            'commitment_type': 'yearly_commitment',
            'price_id': price_id,
            'start_date': start_date.isoformat(),
            'end_date': end_date.isoformat(),
            'stripe_subscription_id': subscription['id']
        }).execute()
        
        logger.info(f"[COMMITMENT] Tracked yearly commitment for account {account_id}, subscription {subscription['id']}, ends {end_date.date()}")
