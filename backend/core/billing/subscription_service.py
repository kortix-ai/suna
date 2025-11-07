from fastapi import HTTPException
from typing import Dict, Optional, List
from decimal import Decimal
from datetime import datetime, timezone, timedelta
import time
import stripe
from core.services.supabase import DBConnection
from core.utils.config import config
from core.utils.logger import logger
from core.utils.cache import Cache
from core.utils.distributed_lock import DistributedLock
from .config import (
    get_tier_by_price_id, 
    TIERS, 
    TRIAL_DURATION_DAYS,
    TRIAL_CREDITS,
    get_tier_by_name,
    is_commitment_price_id,
    get_commitment_duration_months,
    get_price_type
)
from .credit_manager import credit_manager
from .idempotency import (
    generate_checkout_idempotency_key,
    generate_subscription_modify_idempotency_key
)
from .stripe_circuit_breaker import StripeAPIWrapper

class SubscriptionService:
    def __init__(self):
        self.stripe = stripe
        
    async def get_or_create_stripe_customer(self, account_id: str) -> str:
        db = DBConnection()
        client = await db.client
        
        customer_result = await client.schema('basejump').from_('billing_customers')\
            .select('id, email')\
            .eq('account_id', account_id)\
            .execute()
        
        if customer_result.data:
            return customer_result.data[0]['id']
        
        account_result = await client.schema('basejump').from_('accounts')\
            .select('id, name, personal_account, primary_owner_user_id')\
            .eq('id', account_id)\
            .execute()
        
        if not account_result.data:
            raise HTTPException(status_code=404, detail="Account not found")
        
        account = account_result.data[0]
        user_id = account['primary_owner_user_id']

        email = None
        
        try:
            user_result = await client.auth.admin.get_user_by_id(user_id)
            email = user_result.user.email if user_result and user_result.user else None
        except Exception as e:
            logger.warning(f"Failed to get user via auth.admin API for user {user_id}: {e}")
        
        if not email:
            try:
                user_email_result = await client.rpc('get_user_email', {'user_id': user_id}).execute()
                if user_email_result.data:
                    email = user_email_result.data
            except Exception as e:
                logger.warning(f"Failed to get email via RPC for user {user_id}: {e}")
        
        if not email:
            logger.error(f"Could not find email for user {user_id} / account {account_id}")
            raise HTTPException(
                status_code=400, 
                detail="Unable to retrieve user email. Please ensure your account has a valid email address."
            )
        
        customer = await StripeAPIWrapper.safe_stripe_call(
            stripe.Customer.create_async,
            email=email,
            metadata={'account_id': account_id}
        )
        
        await client.schema('basejump').from_('billing_customers').insert({
            'id': customer.id,
            'account_id': account_id,
            'email': email
        }).execute()
    
        return customer.id

    async def get_subscription(self, account_id: str) -> Dict:
        db = DBConnection()
        client = await db.client
        
        credit_result = await client.from_('credit_accounts').select('*').eq('account_id', account_id).execute()
        if not credit_result.data or len(credit_result.data) == 0:
            try:
                credit_result_fallback = await client.from_('credit_accounts').select('*').eq('user_id', account_id).execute()
                if credit_result_fallback.data:
                    credit_result = credit_result_fallback
            except Exception as e:
                logger.debug(f"[SUBSCRIPTION] Fallback query failed: {e}")
        
        subscription_data = None
        
        if credit_result.data:
            credit_account = credit_result.data[0]
            tier_name = credit_account.get('tier', 'none')
            trial_status = credit_account.get('trial_status')
            trial_ends_at = credit_account.get('trial_ends_at')
            tier_obj = TIERS.get(tier_name, TIERS['none'])
            
            actual_credits = float(tier_obj.monthly_credits)
            if tier_name != 'free':
                parts = tier_name.split('_')
                if len(parts) >= 3 and parts[0] == 'tier':
                    subscription_cost = float(parts[-1])
                    actual_credits = subscription_cost + 5.0
            
            tier_info = {
                'name': tier_obj.name,
                'credits': actual_credits,
                'display_name': tier_obj.display_name
            }
            
            if tier_obj and len(tier_obj.price_ids) > 0:
                price_id = tier_obj.price_ids[0]
            else:
                price_id = config.STRIPE_FREE_TIER_ID
            
            stripe_subscription_id = credit_account.get('stripe_subscription_id')
            if stripe_subscription_id:
                try:
                    stripe_subscription = await StripeAPIWrapper.retrieve_subscription(
                        stripe_subscription_id
                    )
                    
                    if (stripe_subscription.get('items') and 
                          len(stripe_subscription['items']['data']) > 0 and
                          stripe_subscription['items']['data'][0].get('price')):
                        price_id = stripe_subscription['items']['data'][0]['price']['id']
                    
                    if stripe_subscription['status'] == 'trialing' and trial_status == 'active':
                        subscription_data = {
                            'id': stripe_subscription['id'],
                            'status': 'trialing',
                            'is_trial': True,
                            'current_period_end': stripe_subscription["items"]["data"][0]['current_period_end'],
                            'cancel_at_period_end': stripe_subscription['cancel_at_period_end'],
                            'trial_end': stripe_subscription.get('trial_end'),
                            'price_id': price_id,
                            'created': stripe_subscription['created'],
                            'metadata': stripe_subscription.get('metadata', {}),
                            'trial_ends_at': trial_ends_at,
                            'trial_tier': tier_name  # Include the tier that's active during trial
                        }
                    else:
                        subscription_data = {
                            'id': stripe_subscription['id'],
                            'status': stripe_subscription['status'],
                            'is_trial': False,
                            'current_period_end': stripe_subscription["items"]["data"][0]['current_period_end'],
                            'cancel_at_period_end': stripe_subscription['cancel_at_period_end'],
                            'trial_end': stripe_subscription.get('trial_end'),
                            'price_id': price_id,
                            'created': stripe_subscription['created'],
                            'metadata': stripe_subscription.get('metadata', {})
                        }
                    
                except Exception as e:
                    logger.error(f"Error retrieving Stripe subscription {stripe_subscription_id}: {e}")
            
            # If user is in active trial but subscription data wasn't retrieved above
            elif trial_status == 'active':
                subscription_data = {
                    'id': None,
                    'status': 'trialing',
                    'is_trial': True,
                    'current_period_end': None,
                    'cancel_at_period_end': False,
                    'trial_end': trial_ends_at,
                    'price_id': price_id,
                    'created': None,
                    'metadata': {},
                    'trial_ends_at': trial_ends_at,
                    'trial_tier': tier_name
                }
            
            return {
                'tier': tier_info,
                'price_id': price_id,
                'subscription': subscription_data,
                'credit_account': credit_account,
                'trial_status': trial_status,
                'trial_ends_at': trial_ends_at
            }
        
        return {
            'tier': {'name': 'none', 'credits': 0, 'display_name': 'No Plan'},
            'price_id': None,
            'subscription': None,
            'credit_account': None,
            'trial_status': None,
            'trial_ends_at': None
        }

    async def create_checkout_session(self, account_id: str, price_id: str, success_url: str, cancel_url: str, commitment_type: Optional[str] = None) -> Dict:
        customer_id = await self.get_or_create_stripe_customer(account_id)
        
        db = DBConnection()
        client = await db.client

        credit_account = await client.from_('credit_accounts')\
            .select('stripe_subscription_id, trial_status, tier')\
            .eq('account_id', account_id)\
            .execute()
        
        existing_subscription_id = None
        trial_status = None
        current_tier = None
        
        if credit_account.data and len(credit_account.data) > 0:
            existing_subscription_id = credit_account.data[0].get('stripe_subscription_id')
            trial_status = credit_account.data[0].get('trial_status')
            current_tier = credit_account.data[0].get('tier')
        
        # Always use timestamp in idempotency key to allow retries with different parameters
        import time
        timestamp = int(time.time() * 1000)  # Millisecond precision
        base_key = generate_checkout_idempotency_key(account_id, price_id, commitment_type)
        idempotency_key = f"{base_key}_{timestamp}"
        
        if trial_status == 'active' and existing_subscription_id:
            logger.info(f"[TRIAL CONVERSION] User {account_id} upgrading from trial to paid plan")
            
            new_tier_info = get_tier_by_price_id(price_id)
            tier_display_name = new_tier_info.display_name if new_tier_info else 'paid plan'

            session = await StripeAPIWrapper.create_checkout_session(
                customer=customer_id,
                payment_method_types=['card'],
                line_items=[{'price': price_id, 'quantity': 1}],
                mode='subscription',
                ui_mode='embedded',
                return_url=success_url,
                allow_promotion_codes=True,
                subscription_data={
                    'metadata': {
                        'account_id': account_id,
                        'account_type': 'personal',
                        'converting_from_trial': 'true',
                        'previous_tier': current_tier or 'trial',
                        'previous_subscription_id': existing_subscription_id,
                        'commitment_type': commitment_type or 'none'
                    }
                },
                idempotency_key=idempotency_key
            )
            
            logger.info(f"[TRIAL CONVERSION] Created new checkout session for user {account_id}")
            
            # Generate frontend checkout wrapper URL for Apple compliance
            frontend_url = config.FRONTEND_URL
            client_secret = getattr(session, 'client_secret', None)
            checkout_param = f"client_secret={client_secret}" if client_secret else f"session_id={session.id}"
            fe_checkout_url = f"{frontend_url}/checkout?{checkout_param}"
            
            return {
                'checkout_url': fe_checkout_url,  # Use embedded checkout URL (session.url is None for embedded mode)
                'fe_checkout_url': fe_checkout_url,  # Kortix-branded embedded checkout
                'session_id': session.id,
                'client_secret': client_secret,
                'converting_from_trial': True,
                'message': f'Converting from trial to {tier_display_name}. Your trial will end and the new plan will begin immediately upon payment.',
                'tier_info': {
                    'name': new_tier_info.name if new_tier_info else price_id,
                    'display_name': tier_display_name,
                    'monthly_credits': float(new_tier_info.monthly_credits) if new_tier_info else 0
                }
            }

        elif existing_subscription_id and trial_status != 'active':
            subscription = await StripeAPIWrapper.retrieve_subscription(existing_subscription_id)
            
            current_price = subscription['items']['data'][0]['price']
            current_amount = current_price.get('unit_amount', 0) or 0
            
            if current_amount == 0 or current_tier == 'free':
                logger.info(f"[FREE TIER UPGRADE] User {account_id} upgrading from free tier to paid plan")
                
                new_tier_info = get_tier_by_price_id(price_id)
                tier_display_name = new_tier_info.display_name if new_tier_info else 'paid plan'
                
                session = await StripeAPIWrapper.create_checkout_session(
                    customer=customer_id,
                    payment_method_types=['card'],
                    line_items=[{'price': price_id, 'quantity': 1}],
                    mode='subscription',
                    ui_mode='embedded',
                    return_url=success_url,
                    allow_promotion_codes=True,
                    subscription_data={
                        'metadata': {
                            'account_id': account_id,
                            'account_type': 'personal',
                            'converting_from_free': 'true',
                            'previous_tier': current_tier or 'free',
                            'previous_subscription_id': existing_subscription_id,
                            'commitment_type': commitment_type or 'none'
                        }
                    },
                    idempotency_key=idempotency_key
                )
                
                logger.info(f"[FREE TIER UPGRADE] Created checkout session for user {account_id}")
                
                frontend_url = config.FRONTEND_URL
                client_secret = getattr(session, 'client_secret', None)
                checkout_param = f"client_secret={client_secret}" if client_secret else f"session_id={session.id}"
                fe_checkout_url = f"{frontend_url}/checkout?{checkout_param}"
                
                return {
                    'checkout_url': fe_checkout_url,
                    'fe_checkout_url': fe_checkout_url,
                    'session_id': session.id,
                    'client_secret': client_secret,
                    'converting_from_free': True,
                    'message': f'Upgrading from free tier to {tier_display_name}. Your free tier will end and the new plan will begin immediately upon payment.',
                    'tier_info': {
                        'name': new_tier_info.name if new_tier_info else price_id,
                        'display_name': tier_display_name,
                        'monthly_credits': float(new_tier_info.monthly_credits) if new_tier_info else 0
                    }
                }
            
            logger.info(f"Updating subscription {existing_subscription_id} to price {price_id}")
            
            modify_key = generate_subscription_modify_idempotency_key(existing_subscription_id, price_id)
            
            updated_subscription = await StripeAPIWrapper.modify_subscription(
                existing_subscription_id,
                items=[{
                    'id': subscription['items']['data'][0].id,
                    'price': price_id,
                }],
                proration_behavior='always_invoice',
                payment_behavior='pending_if_incomplete',
                idempotency_key=modify_key
            )
            
            logger.info(f"Stripe subscription updated, processing subscription change")
            await self.handle_subscription_change(updated_subscription)

            await Cache.invalidate(f"subscription_tier:{account_id}")
            await Cache.invalidate(f"credit_balance:{account_id}")
            await Cache.invalidate(f"credit_summary:{account_id}")
            
            old_price_id = subscription['items']['data'][0].price.id
            old_tier = get_tier_by_price_id(old_price_id)
            new_tier = get_tier_by_price_id(price_id)
            
            old_amount = float(old_tier.monthly_credits) if old_tier else 0
            new_amount = float(new_tier.monthly_credits) if new_tier else 0
            
            return {
                'status': 'upgraded' if new_amount > old_amount else 'updated',
                'subscription_id': updated_subscription.id,
                'message': 'Subscription updated successfully',
                'details': {
                    'is_upgrade': new_amount > old_amount,
                    'current_price': old_amount,
                    'new_price': new_amount
                }
            }
        else:
            session = await StripeAPIWrapper.create_checkout_session(
                customer=customer_id,
                payment_method_types=['card'],
                line_items=[{'price': price_id, 'quantity': 1}],
                mode='subscription',
                ui_mode='embedded',
                return_url=success_url,
                allow_promotion_codes=True,
                subscription_data={
                    'metadata': {
                        'account_id': account_id,
                        'account_type': 'personal',
                        'commitment_type': commitment_type or 'none'
                    }
                },
                idempotency_key=idempotency_key
            )
            
            # Generate frontend checkout wrapper URL for Apple compliance
            frontend_url = config.FRONTEND_URL
            client_secret = getattr(session, 'client_secret', None)
            checkout_param = f"client_secret={client_secret}" if client_secret else f"session_id={session.id}"
            fe_checkout_url = f"{frontend_url}/checkout?{checkout_param}"
            
            return {
                'checkout_url': fe_checkout_url,  # Use embedded checkout URL (session.url is None for embedded mode)
                'fe_checkout_url': fe_checkout_url,  # Kortix-branded embedded checkout
                'session_id': session.id,
                'client_secret': client_secret,
            }

    async def create_portal_session(self, account_id: str, return_url: str) -> Dict:
        customer_id = await self.get_or_create_stripe_customer(account_id)
        
        session = await StripeAPIWrapper.safe_stripe_call(
            stripe.billing_portal.Session.create_async,
            customer=customer_id,
            return_url=return_url
        )
        
        return {'portal_url': session.url}

    async def sync_subscription(self, account_id: str) -> Dict:
        db = DBConnection()
        client = await db.client
        
        credit_result = await client.from_('credit_accounts').select(
            'stripe_subscription_id, tier'
        ).eq('account_id', account_id).execute()
        
        if not credit_result.data or not credit_result.data[0].get('stripe_subscription_id'):
            return {'success': False, 'message': 'No subscription found'}
        
        subscription_id = credit_result.data[0]['stripe_subscription_id']
        
        try:
            subscription = await StripeAPIWrapper.retrieve_subscription(subscription_id)
            await self.handle_subscription_change(subscription)
            
            await Cache.invalidate(f"subscription_tier:{account_id}")
            await Cache.invalidate(f"credit_balance:{account_id}")
            await Cache.invalidate(f"credit_summary:{account_id}")
            
            return {
                'success': True,
                'message': 'Subscription synced successfully',
                'status': subscription.status
            }
            
        except stripe.error.StripeError as e:
            logger.error(f"Error retrieving subscription {subscription_id}: {e}")
            return {'success': False, 'message': f'Stripe error: {str(e)}'}

    async def cancel_subscription(self, account_id: str, feedback: Optional[str] = None) -> Dict:
        logger.info(f"[CANCEL] Processing cancellation for {account_id} - will downgrade to free tier at period end")
        
        try:
            result = await self.schedule_tier_downgrade(
                account_id=account_id,
                target_tier_key='free',
                commitment_type='monthly'
            )
            
            logger.info(f"[CANCEL] Successfully scheduled downgrade to free tier for {account_id}")
            
            if feedback:
                db = DBConnection()
                client = await db.client
                credit_result = await client.from_('credit_accounts').select(
                    'stripe_subscription_id'
                ).eq('account_id', account_id).execute()
                
                if credit_result.data and credit_result.data[0].get('stripe_subscription_id'):
                    subscription_id = credit_result.data[0]['stripe_subscription_id']
                    try:
                        await StripeAPIWrapper.modify_subscription(
                            subscription_id,
                            metadata={'cancellation_feedback': feedback}
                        )
                        logger.info(f"[CANCEL] Saved cancellation feedback for {account_id}")
                    except Exception as e:
                        logger.warning(f"[CANCEL] Could not save feedback: {e}")
            
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

    async def reactivate_subscription(self, account_id: str) -> Dict:
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
                logger.info(f"[REACTIVATE] Found scheduled downgrade to {scheduled_tier}, cancelling it")
                
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

    async def handle_subscription_change(self, subscription: Dict, previous_attributes: Dict = None):
        logger.info(f"[SUBSCRIPTION] Processing change for subscription {subscription.get('id')}, status: {subscription.get('status')}")
        
        db = DBConnection()
        client = await db.client
        
        account_id = subscription.get('metadata', {}).get('account_id')
        
        if not account_id:
            customer_result = await client.schema('basejump').from_('billing_customers').select('account_id').eq('id', subscription['customer']).execute()
            
            if not customer_result.data or len(customer_result.data) == 0:
                logger.warning(f"Could not find account for customer {subscription['customer']}")
                return
            
            account_id = customer_result.data[0]['account_id']
        
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
            await self._update_subscription_metadata_only(account_id, subscription, price_id, client)
            return

        current_account = await client.from_('credit_accounts').select(
            'tier, stripe_subscription_id, last_grant_date, billing_cycle_anchor, last_processed_invoice_id, trial_status'
        ).eq('account_id', account_id).execute()

        is_renewal = False
        is_upgrade = False
        
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
                        
                        is_upgrade_invoice = False
                        if billing_reason == 'subscription_update':
                            is_upgrade_invoice = True
                            logger.info(f"[RENEWAL DETECTION] Invoice {invoice['id']} is a subscription_update - likely an upgrade")
                        
                        logger.warning(f"[RENEWAL DETECTION] Found invoice {invoice['id']} for current period")
                        logger.warning(f"[RENEWAL DETECTION] Invoice status: {invoice_status}, billing_reason: {billing_reason}")
                        
                        if not is_upgrade_invoice and invoice_status in ['draft', 'open', 'paid', 'uncollectible']:
                            is_renewal = True
                            logger.warning(f"[RENEWAL DETECTION] Invoice exists (status: {invoice_status}) - this is a RENEWAL")
                            logger.warning(f"[RENEWAL DETECTION] Credits will be handled by invoice.payment_succeeded - BLOCKING")
                            break
                        elif is_upgrade_invoice:
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
                new_tier_info = get_tier_by_price_id(price_id)
                
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
                    logger.warning(f"[RENEWAL DETECTION] We're only {seconds_since_period_start:.0f}s after period start")
                    logger.warning(f"[RENEWAL DETECTION] This is almost certainly a renewal - BLOCKING subscription.updated credits")
        
        if not is_renewal and not is_upgrade and previous_attributes and 'current_period_start' in previous_attributes:
            prev_period_start = previous_attributes.get('current_period_start')
            current_period_start = subscription.get('current_period_start')
            
            prev_price_id = previous_attributes.get('items', {}).get('data', [{}])[0].get('price', {}).get('id') if previous_attributes.get('items') else None
            current_price_id = subscription['items']['data'][0]['price']['id'] if subscription.get('items') else None
            
            is_tier_change = False
            if prev_price_id and current_price_id and prev_price_id != current_price_id:
                prev_tier = get_tier_by_price_id(prev_price_id)
                current_tier = get_tier_by_price_id(current_price_id)
                if prev_tier and current_tier and prev_tier.name != current_tier.name:
                    is_tier_change = True
                    logger.info(f"[RENEWAL DETECTION] Tier changed from {prev_tier.name} to {current_tier.name}")
            
            if prev_period_start != current_period_start and not is_tier_change:
                is_renewal = True
                logger.info(f"[RENEWAL DETECTION] Period changed from {prev_period_start} to {current_period_start} - this is a RENEWAL")
                logger.info(f"[RENEWAL DETECTION] SKIPPING credit grant - will be handled by invoice.payment_succeeded webhook")
            elif prev_period_start != current_period_start and is_tier_change:
                logger.info(f"[RENEWAL DETECTION] Period changed but tier also changed - treating as UPGRADE, not renewal")
        
        if not is_renewal and not is_upgrade and current_account.data:
            last_renewal_period_start = current_account.data[0].get('last_renewal_period_start')
            if last_renewal_period_start and last_renewal_period_start == subscription.get('current_period_start'):
                is_renewal = True
                logger.info(f"[RENEWAL DETECTION] Invoice webhook already processed this renewal - skipping")
            
            if not is_renewal:
                last_grant_date = current_account.data[0].get('last_grant_date')
                if last_grant_date:
                    try:
                        last_grant_dt = datetime.fromisoformat(last_grant_date.replace('Z', '+00:00'))
                        if abs((billing_anchor - last_grant_dt).total_seconds()) < 120:
                            is_renewal = True
                            logger.info(f"[RENEWAL DETECTION] Grant at period start detected - treating as renewal")
                    except:
                        pass
            
            last_grant_date = current_account.data[0].get('last_grant_date')
            if last_grant_date:
                try:
                    last_grant_dt = datetime.fromisoformat(last_grant_date.replace('Z', '+00:00'))
                    time_since_grant = (datetime.now(timezone.utc) - last_grant_dt).total_seconds()
                    
                    if time_since_grant < 3600 and current_account.data[0].get('tier') == new_tier['name']:
                        is_renewal = True
                        logger.info(f"[RENEWAL DETECTION] Credits recently granted {time_since_grant:.0f}s ago for same tier - skipping")
                except Exception as e:
                    logger.warning(f"Error checking last grant date: {e}")
        
        if is_upgrade:
            logger.info(f"[UPGRADE] Upgrade detected - will grant credits for tier change")
        elif is_renewal:
            logger.info(f"[RENEWAL BLOCK] Subscription {subscription['id']} identified as renewal - NO CREDITS will be granted")
            logger.info(f"[RENEWAL BLOCK] Credits for renewals are handled exclusively by invoice.payment_succeeded webhook")
            
            # Still update subscription metadata but DO NOT grant any credits
            await self._track_commitment_if_needed(account_id, price_id, subscription, client)
            
            new_tier_info = get_tier_by_price_id(price_id)
            if new_tier_info:
                await client.from_('credit_accounts').update({
                    'tier': new_tier_info.name,
                    'stripe_subscription_id': subscription['id'],
                    'billing_cycle_anchor': billing_anchor.isoformat(),
                    'next_credit_grant': datetime.fromtimestamp(subscription['current_period_end'], tz=timezone.utc).isoformat()
                }).eq('account_id', account_id).execute()
                logger.info(f"[RENEWAL BLOCK] Updated subscription metadata only (no credits granted)")
            return
        
        await self._track_commitment_if_needed(account_id, price_id, subscription, client)
        
        new_tier_info = get_tier_by_price_id(price_id)
        if not new_tier_info:
            logger.warning(f"Unknown price ID in subscription: {price_id}")
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
                await self._handle_trial_subscription(subscription, account_id, new_tier, client)
                return
        
        next_grant_date = datetime.fromtimestamp(subscription['current_period_end'], tz=timezone.utc)
        logger.debug(f"[SUBSCRIPTION] Current account data exists: {bool(current_account.data)}")
        
        if current_account.data:
            existing_data = current_account.data[0]
            current_tier_name = existing_data.get('tier')
            logger.debug(f"[SUBSCRIPTION] Existing tier: {current_tier_name}")
            old_subscription_id = existing_data.get('stripe_subscription_id')
            last_grant_date = existing_data.get('last_grant_date')
            existing_anchor = existing_data.get('billing_cycle_anchor')
            current_trial_status = existing_data.get('trial_status')

            last_processed_invoice = existing_data.get('last_processed_invoice_id')
            last_renewal_period_start = existing_data.get('last_renewal_period_start')
            
            if current_trial_status == 'cancelled' and subscription.status == 'active' and not old_subscription_id:
                logger.info(f"[SUBSCRIPTION] User {account_id} with cancelled trial is subscribing - treating as new subscription")
                await self._grant_initial_subscription_credits(account_id, new_tier, billing_anchor, subscription, client)
                return
            
            # Check if invoice webhook already handled this period
            if last_renewal_period_start and last_renewal_period_start == subscription.get('current_period_start'):
                logger.warning(f"[DOUBLE CREDIT BLOCK] Invoice webhook already processed period {subscription.get('current_period_start')}")
                logger.warning(f"[DOUBLE CREDIT BLOCK] NO credits will be granted via subscription.updated - RETURNING")
                return
            
            # Additional check using last_grant_date as fallback
            if not last_renewal_period_start and last_grant_date:
                try:
                    last_grant_dt = datetime.fromisoformat(last_grant_date.replace('Z', '+00:00'))
                    # If grant was within 60 seconds of period start, it's likely the same renewal
                    if abs((billing_anchor - last_grant_dt).total_seconds()) < 60:
                        logger.warning(f"[DOUBLE CREDIT BLOCK] Credits recently granted at period start - likely duplicate")
                        logger.warning(f"[DOUBLE CREDIT BLOCK] Last grant: {last_grant_dt}, Period: {billing_anchor}")
                        return
                except:
                    pass
            
            if last_grant_date:
                try:
                    last_grant_dt = datetime.fromisoformat(last_grant_date.replace('Z', '+00:00'))
                    time_since_last_grant = (datetime.now(timezone.utc) - last_grant_dt).total_seconds()
                    
                    # STRICT: Block if credits were granted in last 15 minutes for same tier
                    if time_since_last_grant < 900 and current_tier_name == new_tier['name']:
                        logger.warning(f"[DOUBLE CREDIT BLOCK] Credits granted {time_since_last_grant:.0f}s ago for tier {new_tier['name']}")
                        logger.warning(f"[DOUBLE CREDIT BLOCK] This is too recent - BLOCKING duplicate credit grant")
                        return
                    
                    # Check if credits align with billing period (likely a renewal)
                    if abs((billing_anchor - last_grant_dt).total_seconds()) < 900:
                        logger.warning(f"[DOUBLE CREDIT BLOCK] Credits already granted near billing period start")
                        logger.warning(f"[DOUBLE CREDIT BLOCK] Last grant: {last_grant_dt}, Period: {billing_anchor} - BLOCKING")
                        return
                except Exception as e:
                    logger.warning(f"Error parsing dates for idempotency check: {e}")
            
            current_tier = get_tier_by_name(current_tier_name) if current_tier_name else None
            
            current_tier = {
                'name': current_tier.name,
                'credits': float(current_tier.monthly_credits)
            } if current_tier else {
                'name': 'none',
                'credits': 0
            }
            
            logger.debug(f"[SUBSCRIPTION] Tier comparison - Current: {current_tier['name']} ({current_tier['credits']}), New: {new_tier['name']} ({new_tier['credits']})")
            
            if current_tier['name'] == new_tier['name'] and current_tier['name'] not in ['free', 'none']:
                logger.info(f"[SUBSCRIPTION] Same tier detected ({new_tier['name']}) - identified as renewal, blocking duplicate credits")
                
                await client.from_('credit_accounts').update({
                    'tier': new_tier['name'],
                    'stripe_subscription_id': subscription['id'],
                    'billing_cycle_anchor': billing_anchor.isoformat(),
                    'next_credit_grant': next_grant_date.isoformat()
                }).eq('account_id', account_id).execute()
                return
            
            should_grant_credits = self._should_grant_credits(current_tier_name, current_tier, new_tier, subscription, old_subscription_id, is_renewal)
            
            if should_grant_credits:
                logger.info(f"[UPGRADE] Granting upgrade credits but NOT setting last_renewal_period_start (renewal tracking is for invoices only)")
                await client.from_('credit_accounts').update({
                    'last_grant_date': billing_anchor.isoformat()
                }).eq('account_id', account_id).execute()
                
                await self._grant_subscription_credits(account_id, new_tier, billing_anchor)
            else:
                logger.info(f"No credits granted - not an upgrade scenario")
            
            await client.from_('credit_accounts').update({
                'tier': new_tier['name'],
                'stripe_subscription_id': subscription['id'],
                'billing_cycle_anchor': billing_anchor.isoformat(),
                'next_credit_grant': next_grant_date.isoformat()
            }).eq('account_id', account_id).execute()
        else:
            logger.warning(f"[SUBSCRIPTION] No existing credit account found for {account_id} - creating initial subscription (may indicate new user or data issue)")
            await self._grant_initial_subscription_credits(account_id, new_tier, billing_anchor, subscription, client)

    async def _handle_trial_subscription(self, subscription, account_id, new_tier, client):
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
                elif current_status == 'none':
                    logger.info(f"[WEBHOOK] Activating trial for account {account_id}")
            
            recent_trial_credits = await client.from_('credit_ledger').select('*').eq(
                'account_id', account_id
            ).eq('description', f'{TRIAL_DURATION_DAYS}-day free trial credits').execute()
            
            if recent_trial_credits.data:
                logger.warning(f"[WEBHOOK] Trial credits already granted for account {account_id} (found in ledger), skipping duplicate")
                return
                
            trial_ends_at = datetime.fromtimestamp(subscription.trial_end, tz=timezone.utc)
            
            await client.from_('credit_accounts').update({
                'trial_status': 'active',
                'trial_started_at': datetime.now(timezone.utc).isoformat(),
                'trial_ends_at': trial_ends_at.isoformat(),
                'stripe_subscription_id': subscription['id'],
                'tier': new_tier['name']
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
            
            logger.info(f"[WEBHOOK] ✅ Started trial for user {account_id} via Stripe subscription - granted ${TRIAL_CREDITS} credits")
        finally:
            await lock.release()

    def _should_grant_credits(self, current_tier_name, current_tier, new_tier, subscription, old_subscription_id, is_renewal=False):
        should_grant_credits = False

        if is_renewal:
            should_grant_credits = False
            logger.info(f"Renewal detected for tier {new_tier['name']} - skipping credits (handled by invoice webhook)")
        elif current_tier_name in ['free', 'none'] and new_tier['name'] not in ['free', 'none']:
            should_grant_credits = True
            logger.info(f"Upgrade from free tier to {new_tier['name']} - will grant credits")
        elif current_tier:
            if current_tier['name'] != new_tier['name']:
                if new_tier['credits'] > current_tier['credits']:
                    should_grant_credits = True
                    logger.info(f"Tier upgrade detected: {current_tier['name']} -> {new_tier['name']}")
                else:
                    logger.info(f"Tier change (not upgrade): {current_tier['name']} -> {new_tier['name']}")
            elif subscription['id'] != old_subscription_id and old_subscription_id is not None:
                should_grant_credits = True
                logger.info(f"New subscription for tier {new_tier['name']}: {old_subscription_id} -> {subscription['id']}")
            elif current_tier['name'] == new_tier['name'] and current_tier['credits'] == new_tier['credits']:
                should_grant_credits = False
                logger.info(f"Same tier {new_tier['name']} with same credits - likely a renewal, skipping credits")
            elif new_tier['credits'] > current_tier['credits']:
                should_grant_credits = True
                logger.info(f"Credit increase for tier {new_tier['name']}: {current_tier['credits']} -> {new_tier['credits']}")
        
        return should_grant_credits

    async def _grant_subscription_credits(self, account_id, new_tier, billing_anchor):
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
            result = await credit_manager.add_credits(
                account_id=account_id,
                amount=full_amount,
                is_expiring=True,
                description=f"Tier upgrade to {new_tier['name']}",
                expires_at=expires_at
            )
            
            logger.info(f"[CREDIT GRANT] ✅ Successfully granted {full_amount} expiring credits for tier upgrade to {new_tier['name']}")
        finally:
            await lock.release()

    async def _grant_initial_subscription_credits(self, account_id, new_tier, billing_anchor, subscription, client):
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
            
            next_grant_date = datetime.fromtimestamp(subscription['current_period_end'], tz=timezone.utc)
            
            await client.from_('credit_accounts').update({
                'tier': new_tier['name'],
                'stripe_subscription_id': subscription['id'],
                'billing_cycle_anchor': billing_anchor.isoformat(),
                'next_credit_grant': next_grant_date.isoformat(),
                'trial_status': 'none',
                'last_grant_date': billing_anchor.isoformat()
            }).eq('account_id', account_id).execute()
            
            logger.info(f"[CREDIT GRANT] ✅ Initial grant completed for {account_id}")
        finally:
            await lock.release()

    async def get_user_subscription_tier(self, account_id: str) -> Dict:
        cache_key = f"subscription_tier:{account_id}"
        cached = await Cache.get(cache_key)
        if cached:
            return cached
        
        db = DBConnection()
        client = await db.client

        credit_result = await client.from_('credit_accounts')\
            .select('tier, trial_status')\
            .eq('account_id', account_id)\
            .execute()
        
        tier_name = 'none'
        trial_status = None
        
        if credit_result.data and len(credit_result.data) > 0:
            tier_name = credit_result.data[0].get('tier', 'none')
            trial_status = credit_result.data[0].get('trial_status')
        
        # IMPORTANT: If trial is active but tier is 'none', use TRIAL_TIER
        # This handles cases where trial was activated but tier wasn't set properly
        if trial_status == 'active' and tier_name == 'none':
            from .config import TRIAL_TIER
            tier_name = TRIAL_TIER
            logger.info(f"[TIER] Trial active but tier=none for {account_id}, using TRIAL_TIER: {TRIAL_TIER}")
        
        tier_obj = TIERS.get(tier_name, TIERS['none'])
        tier_info = {
            'name': tier_obj.name,
            'display_name': tier_obj.display_name,
            'credits': float(tier_obj.monthly_credits),
            'can_purchase_credits': tier_obj.can_purchase_credits,
            'models': tier_obj.models,
            'project_limit': tier_obj.project_limit,
            'is_trial': trial_status == 'active'
        }
        
        await Cache.set(cache_key, tier_info, ttl=60)
        return tier_info

    async def get_allowed_models_for_user(self, user_id: str, client=None) -> List[str]:
        try:
            from core.ai_models import model_manager

            tier_info = await self.get_user_subscription_tier(user_id)
            tier_name = tier_info['name']
            
            logger.debug(f"[ALLOWED_MODELS] User {user_id} tier: {tier_name}")

            if 'all' in tier_info.get('models', []):
                all_models = model_manager.list_available_models(include_disabled=False)
                allowed_model_ids = [model_data["id"] for model_data in all_models]
                logger.debug(f"[ALLOWED_MODELS] User {user_id} has access to all {len(allowed_model_ids)} models")
                return allowed_model_ids
            
            elif tier_info.get('models'):
                logger.debug(f"[ALLOWED_MODELS] User {user_id} has specific models: {tier_info['models']}")
                return tier_info['models']
            
            else:
                logger.debug(f"[ALLOWED_MODELS] User {user_id} has no model access (tier: {tier_name})")
                return []
                
        except Exception as e:
            logger.error(f"[ALLOWED_MODELS] Error getting allowed models for user {user_id}: {e}")
            return []

    async def _update_subscription_metadata_only(self, account_id: str, subscription: Dict, price_id: str, client):
        logger.info(f"[SUBSCRIPTION] Updating metadata only (no credit grants) for {account_id}")
        
        new_tier_info = get_tier_by_price_id(price_id)
        if not new_tier_info:
            logger.warning(f"Unknown price ID in subscription: {price_id}")
            return
        
        billing_anchor = datetime.fromtimestamp(subscription['current_period_start'], tz=timezone.utc)
        next_grant_date = datetime.fromtimestamp(subscription['current_period_end'], tz=timezone.utc)
        
        await client.from_('credit_accounts').update({
            'tier': new_tier_info.name,
            'stripe_subscription_id': subscription['id'],
            'billing_cycle_anchor': billing_anchor.isoformat(),
            'next_credit_grant': next_grant_date.isoformat()
        }).eq('account_id', account_id).execute()
        
        await self._track_commitment_if_needed(account_id, price_id, subscription, client)
        
        logger.info(f"[SUBSCRIPTION] ✅ Metadata updated for {account_id}, tier={new_tier_info.name}")
    
    async def _track_commitment_if_needed(self, account_id: str, price_id: str, subscription: Dict, client):
        if not is_commitment_price_id(price_id):
            return
        
        commitment_duration = get_commitment_duration_months(price_id)
        if commitment_duration == 0:
            return
        
        existing_commitment = await client.from_('commitment_history').select('id').eq('stripe_subscription_id', subscription['id']).execute()
        if existing_commitment.data:
            logger.info(f"[COMMITMENT] Commitment already tracked for subscription {subscription['id']}, skipping")
            return
        
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
    
    async def get_commitment_status(self, account_id: str) -> Dict:
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

    async def schedule_tier_downgrade(self, account_id: str, target_tier_key: str, commitment_type: Optional[str] = None) -> Dict:
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
            
            if user_commitment_type == 'yearly_commitment' and commitment_end_date:
                commitment_end_dt = datetime.fromisoformat(commitment_end_date.replace('Z', '+00:00'))
                if datetime.now(timezone.utc) < commitment_end_dt:
                    logger.info(f"[DOWNGRADE] User has active commitment until {commitment_end_dt.date()}")
                    current_period_end = int(commitment_end_dt.timestamp())
                    current_period_end_date = commitment_end_dt
                    logger.info(f"[DOWNGRADE] Scheduling downgrade for commitment end date: {commitment_end_date}")
                else:
                    current_period_end = subscription['current_period_end']
                    current_period_end_date = datetime.fromtimestamp(current_period_end, tz=timezone.utc)
            else:
                current_period_end = subscription['current_period_end']
                current_period_end_date = datetime.fromtimestamp(current_period_end, tz=timezone.utc)
            
            if commitment_type and len(target_tier.price_ids) >= 3:
                target_price_id = target_tier.price_ids[2] if commitment_type == 'yearly_commitment' else target_tier.price_ids[0]
            elif commitment_type == 'yearly' and len(target_tier.price_ids) >= 2:
                target_price_id = target_tier.price_ids[1]
            else:
                target_price_id = target_tier.price_ids[0]
            
            current_price_type = get_price_type(subscription['items']['data'][0]['price']['id'])
            target_price_type = get_price_type(target_price_id)
            
            schedule_metadata = {
                'account_id': account_id,
                'downgrade': 'true',
                'previous_tier': current_tier_name,
                'target_tier': target_tier_key,
                'scheduled_by': 'user',
                'scheduled_at': datetime.now(timezone.utc).isoformat(),
                'scheduled_price_id': target_price_id
            }
            
            try:
                existing_schedule_id = subscription.get('schedule')
                schedule = None
                
                if existing_schedule_id:
                    logger.info(f"[DOWNGRADE] Found existing schedule {existing_schedule_id}, checking status")
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
                            schedule = existing_schedule
                        else:
                            logger.info(f"[DOWNGRADE] Schedule {existing_schedule_id} is {schedule_status}, releasing and creating new")
                            await StripeAPIWrapper.safe_stripe_call(
                                stripe.SubscriptionSchedule.release_async,
                                existing_schedule_id
                            )
                            logger.info(f"[DOWNGRADE] Released completed/canceled schedule {existing_schedule_id}")
                            
                            import asyncio
                            await asyncio.sleep(1)
                            
                            subscription = await StripeAPIWrapper.retrieve_subscription(subscription_id)
                            existing_schedule_id = None
                            
                    except stripe.error.InvalidRequestError as e:
                        if 'No such subscription_schedule' in str(e):
                            logger.info(f"[DOWNGRADE] Schedule {existing_schedule_id} no longer exists, creating new")
                            existing_schedule_id = None
                        else:
                            raise
                
                if not existing_schedule_id:
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
                    
                    logger.info(f"[DOWNGRADE] Created new Stripe subscription schedule {schedule.id} for {account_id}")
                
                await client.from_('credit_accounts').update({
                    'scheduled_tier_change': target_tier_key,
                    'scheduled_tier_change_date': current_period_end_date.isoformat(),
                    'scheduled_price_id': target_price_id
                }).eq('account_id', account_id).execute()
                
            except stripe.error.StripeError as e:
                logger.error(f"Error creating subscription schedule: {e}")
                raise HTTPException(status_code=500, detail=f"Failed to schedule downgrade in Stripe: {str(e)}")
            
            logger.info(f"[DOWNGRADE] Scheduled downgrade for {account_id} from {current_tier_name} to {target_tier_key} at {current_period_end_date.isoformat()}")
            
            if user_commitment_type == 'yearly_commitment' and commitment_end_date:
                commitment_end_dt = datetime.fromisoformat(commitment_end_date.replace('Z', '+00:00'))
                if datetime.now(timezone.utc) < commitment_end_dt:
                    period_description = "annual commitment period"
                    message = f'Your plan will be downgraded to {target_tier.display_name} at the end of your annual commitment on {commitment_end_dt.strftime("%B %d, %Y")}'
                else:
                    period_description = "billing period"
                    message = f'Your plan will be downgraded to {target_tier.display_name} at the end of your current billing period'
            elif current_price_type == 'yearly' or current_price_type == 'yearly_commitment':
                period_description = "yearly billing period"
                message = f'Your plan will be downgraded to {target_tier.display_name} at the end of your current yearly billing period'
            elif current_price_type == 'monthly':
                period_description = "monthly billing period"
                message = f'Your plan will be downgraded to {target_tier.display_name} at the end of your current monthly billing period'
            else:
                period_description = "billing period"
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
            
        except stripe.error.StripeError as e:
            logger.error(f"Error scheduling downgrade for subscription {subscription_id}: {e}")
            raise HTTPException(status_code=500, detail=f"Failed to schedule downgrade: {str(e)}")

    async def get_scheduled_changes(self, account_id: str) -> Dict:
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


subscription_service = SubscriptionService()

