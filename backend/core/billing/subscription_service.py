from fastapi import HTTPException
from typing import Dict, Optional, List
from decimal import Decimal
from datetime import datetime, timezone, timedelta
import stripe
from core.services.supabase import DBConnection
from core.utils.config import config
from core.utils.logger import logger
from core.utils.cache import Cache
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
        
        customer = await stripe.Customer.create_async(
            email=email,
            metadata={'account_id': account_id}
        )
        
        await client.schema('basejump').from_('billing_customers').insert({
            'id': customer.id,
            'account_id': account_id,
            'email': email
        }).execute()
        
        logger.info(f"Created Stripe customer {customer.id} for account {account_id} with email {email}")
        return customer.id

    async def get_subscription(self, account_id: str) -> Dict:
        db = DBConnection()
        client = await db.client
        
        credit_result = await client.from_('credit_accounts').select('*').eq('account_id', account_id).execute()
        if not credit_result.data or len(credit_result.data) == 0:
            try:
                credit_result_fallback = await client.from_('credit_accounts').select('*').eq('user_id', account_id).execute()
                if credit_result_fallback.data:
                    logger.info(f"[SUBSCRIPTION] Using user_id fallback for account {account_id}")
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
                    stripe_subscription = await stripe.Subscription.retrieve_async(
                        stripe_subscription_id,
                        expand=['items.data.price']
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
        
        if trial_status == 'active' and existing_subscription_id:
            logger.info(f"[TRIAL CONVERSION] User {account_id} upgrading from trial to paid plan")
            
            new_tier_info = get_tier_by_price_id(price_id)
            tier_display_name = new_tier_info.display_name if new_tier_info else 'paid plan'

            try:
                cancelled_trial = await stripe.Subscription.cancel_async(existing_subscription_id)
                logger.info(f"[TRIAL CONVERSION] Cancelled trial subscription {existing_subscription_id}")
            except stripe.error.InvalidRequestError as e:
                logger.warning(f"[TRIAL CONVERSION] Could not cancel trial subscription: {e}")
            except stripe.error.StripeError as e:
                logger.error(f"[TRIAL CONVERSION] Failed to cancel trial subscription: {e}")

            session = await stripe.checkout.Session.create_async(
                customer=customer_id,
                payment_method_types=['card'],
                line_items=[{'price': price_id, 'quantity': 1}],
                mode='subscription',
                success_url=success_url,
                cancel_url=cancel_url,
                subscription_data={
                    'metadata': {
                        'account_id': account_id,
                        'account_type': 'personal',
                        'converting_from_trial': 'true',
                        'previous_tier': current_tier or 'trial',
                        'commitment_type': commitment_type or 'none'
                    }
                }
            )
            
            logger.info(f"[TRIAL CONVERSION] Created new checkout session for user {account_id}")
            return {
                'checkout_url': session.url, 
                'converting_from_trial': True,
                'message': f'Converting from trial to {tier_display_name}. Your trial will end and the new plan will begin immediately upon payment.',
                'tier_info': {
                    'name': new_tier_info.name if new_tier_info else price_id,
                    'display_name': tier_display_name,
                    'monthly_credits': float(new_tier_info.monthly_credits) if new_tier_info else 0
                }
            }

        elif existing_subscription_id and trial_status != 'active':
            subscription = await stripe.Subscription.retrieve_async(existing_subscription_id)
            
            logger.info(f"Updating subscription {existing_subscription_id} to price {price_id}")
            
            updated_subscription = await stripe.Subscription.modify_async(
                existing_subscription_id,
                items=[{
                    'id': subscription['items']['data'][0].id,
                    'price': price_id,
                }],
                proration_behavior='always_invoice',
                payment_behavior='pending_if_incomplete'
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
            session = await stripe.checkout.Session.create_async(
                customer=customer_id,
                payment_method_types=['card'],
                line_items=[{'price': price_id, 'quantity': 1}],
                mode='subscription',
                success_url=success_url,
                cancel_url=cancel_url,
                subscription_data={
                    'metadata': {
                        'account_id': account_id,
                        'account_type': 'personal',
                        'commitment_type': commitment_type or 'none'
                    }
                }
            )
            return {'checkout_url': session.url}

    async def create_portal_session(self, account_id: str, return_url: str) -> Dict:
        customer_id = await self.get_or_create_stripe_customer(account_id)
        
        session = await stripe.billing_portal.Session.create_async(
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
            subscription = await stripe.Subscription.retrieve_async(subscription_id)
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
        db = DBConnection()
        client = await db.client
        
        credit_result = await client.from_('credit_accounts').select(
            'stripe_subscription_id, commitment_type, commitment_start_date, commitment_end_date'
        ).eq('account_id', account_id).execute()
        
        if not credit_result.data or not credit_result.data[0].get('stripe_subscription_id'):
            raise HTTPException(status_code=404, detail="No subscription found")
        
        subscription_id = credit_result.data[0]['stripe_subscription_id']
        commitment_type = credit_result.data[0].get('commitment_type')
        commitment_end_date = credit_result.data[0].get('commitment_end_date')
        
        if commitment_type == 'yearly_commitment' and commitment_end_date:
            end_date = datetime.fromisoformat(commitment_end_date.replace('Z', '+00:00'))
            if datetime.now(timezone.utc) < end_date:
                logger.info(f"Scheduling cancellation for commitment end date: {end_date.date()} for account {account_id}")
                
                try:
                    subscription = await stripe.Subscription.modify_async(
                        subscription_id,
                        cancel_at=int(end_date.timestamp()),
                        metadata={'cancellation_feedback': feedback, 'scheduled_commitment_cancel': 'true'} if feedback else {'scheduled_commitment_cancel': 'true'}
                    )
                    
                    try:
                        commitment_start = credit_result.data[0].get('commitment_start_date')
                        if commitment_start:
                            await client.from_('commitment_history').insert({
                                'account_id': account_id,
                                'commitment_type': commitment_type,
                                'start_date': commitment_start,
                                'end_date': commitment_end_date,
                                'stripe_subscription_id': subscription_id,
                                'cancelled_at': datetime.now(timezone.utc).isoformat(),
                                'cancellation_reason': feedback or f'Scheduled cancellation for {end_date.date()}'
                            }).execute()
                    except Exception as e:
                        logger.warning(f"Failed to log commitment history: {e}, but cancellation was scheduled successfully")
                    
                    months_remaining = (end_date.year - datetime.now(timezone.utc).year) * 12 + \
                                     (end_date.month - datetime.now(timezone.utc).month)
                    
                    return {
                        'success': True,
                        'scheduled': True,
                        'message': f'Your subscription is scheduled to cancel on {end_date.date()} at the end of your commitment period',
                        'cancel_at': subscription.cancel_at,
                        'months_remaining': max(0, months_remaining),
                        'commitment_end_date': commitment_end_date
                    }
                    
                except stripe.error.StripeError as e:
                    logger.error(f"Error scheduling cancellation for subscription {subscription_id}: {e}")
                    raise HTTPException(status_code=500, detail=f"Failed to schedule cancellation: {str(e)}")
        
        try:
            subscription = await stripe.Subscription.modify_async(
                subscription_id,
                cancel_at_period_end=True,
                metadata={'cancellation_feedback': feedback} if feedback else {}
            )
            
            # Log cancellation in commitment history if applicable
            if commitment_type:
                await client.from_('commitment_history').insert({
                    'account_id': account_id,
                    'commitment_type': commitment_type,
                    'start_date': credit_result.data[0].get('commitment_start_date'),
                    'end_date': commitment_end_date,
                    'stripe_subscription_id': subscription_id,
                    'cancelled_at': datetime.now(timezone.utc).isoformat(),
                    'cancellation_reason': feedback or 'User cancelled'
                }).execute()
            
            return {
                'success': True,
                'message': 'Subscription will be cancelled at the end of the current period',
                'period_end': subscription.current_period_end
            }
            
        except stripe.error.StripeError as e:
            logger.error(f"Error cancelling subscription {subscription_id}: {e}")
            raise HTTPException(status_code=500, detail=f"Stripe error: {str(e)}")

    async def reactivate_subscription(self, account_id: str) -> Dict:
        db = DBConnection()
        client = await db.client
        
        credit_result = await client.from_('credit_accounts').select(
            'stripe_subscription_id'
        ).eq('account_id', account_id).execute()
        
        if not credit_result.data or not credit_result.data[0].get('stripe_subscription_id'):
            raise HTTPException(status_code=404, detail="No subscription found")
        
        subscription_id = credit_result.data[0]['stripe_subscription_id']
        
        try:
            subscription = await stripe.Subscription.modify_async(
                subscription_id,
                cancel_at_period_end=False
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
        logger.error(f"[HANDLE_SUBSCRIPTION_CHANGE] CALLED! Subscription: {subscription.get('id')}")
        logger.error(f"[HANDLE_SUBSCRIPTION_CHANGE] Status: {subscription.get('status')}")
        logger.error(f"[HANDLE_SUBSCRIPTION_CHANGE] Previous attributes: {previous_attributes}")
        
        db = DBConnection()
        client = await db.client
        
        account_id = subscription.get('metadata', {}).get('account_id')
        
        if not account_id:
            customer_result = await client.schema('basejump').from_('billing_customers').select('account_id').eq('id', subscription['customer']).execute()
            
            if not customer_result.data or len(customer_result.data) == 0:
                logger.warning(f"Could not find account for customer {subscription['customer']}")
                return
            
            account_id = customer_result.data[0]['account_id']
        
        logger.error(f"[SUBSCRIPTION INFO] Account ID: {account_id}")
        
        price_id = subscription['items']['data'][0]['price']['id'] if subscription.get('items') else None
        
        logger.error(f"[SUBSCRIPTION INFO] Price ID: {price_id}")
        
        billing_anchor = datetime.fromtimestamp(subscription['current_period_start'], tz=timezone.utc)
        logger.error(f"[SUBSCRIPTION INFO] Billing anchor: {billing_anchor}")

        current_account = await client.from_('credit_accounts').select(
            'tier, stripe_subscription_id, last_grant_date, billing_cycle_anchor, last_processed_invoice_id'
        ).eq('account_id', account_id).execute()

        is_renewal = False
        
        if subscription.get('id'):
            try:
                invoices = stripe.Invoice.list(
                    subscription=subscription['id'],
                    limit=5
                )
                
                current_period_start = subscription.get('current_period_start')
                current_period_end = subscription.get('current_period_end')
                
                for invoice in invoices.data:
                    # Check if this invoice is for the current billing period
                    invoice_period_start = invoice.get('period_start')
                    invoice_period_end = invoice.get('period_end')
                    
                    if (invoice_period_start == current_period_start or 
                        invoice_period_end == current_period_end):
                        
                        invoice_status = invoice.get('status')
                        logger.warning(f"[RENEWAL DETECTION] Found invoice {invoice['id']} for current period")
                        logger.warning(f"[RENEWAL DETECTION] Invoice status: {invoice_status}, created: {invoice.get('created')}")
                        
                        # If there's ANY invoice for this period (even draft), it's a renewal
                        if invoice_status in ['draft', 'open', 'paid', 'uncollectible']:
                            is_renewal = True
                            logger.warning(f"[RENEWAL DETECTION] Invoice exists (status: {invoice_status}) - this is a RENEWAL")
                            logger.warning(f"[RENEWAL DETECTION] Credits will be handled by invoice.payment_succeeded - BLOCKING")
                            break
                        
            except Exception as e:
                logger.error(f"[RENEWAL DETECTION] Error checking invoices: {e}")

        if not is_renewal:
            now = datetime.now(timezone.utc)
            seconds_since_period_start = (now - billing_anchor).total_seconds()
            
            if 0 <= seconds_since_period_start < 1800:
                is_renewal = True
                logger.warning(f"[RENEWAL DETECTION] We're only {seconds_since_period_start:.0f}s after period start")
                logger.warning(f"[RENEWAL DETECTION] This is almost certainly a renewal - BLOCKING subscription.updated credits")
        
        # Also check if period explicitly changed
        if not is_renewal and previous_attributes and 'current_period_start' in previous_attributes:
            prev_period_start = previous_attributes.get('current_period_start')
            current_period_start = subscription.get('current_period_start')
            
            if prev_period_start != current_period_start:
                is_renewal = True
                logger.info(f"[RENEWAL DETECTION] Period changed from {prev_period_start} to {current_period_start} - this is a RENEWAL")
                logger.info(f"[RENEWAL DETECTION] SKIPPING credit grant - will be handled by invoice.payment_succeeded webhook")
        
        if not is_renewal and current_account.data:
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
        
        if is_renewal:
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
        logger.error(f"[ACCOUNT CHECK] Current account data: {current_account.data}")
        
        if current_account.data:
            existing_data = current_account.data[0]
            current_tier_name = existing_data.get('tier')
            logger.error(f"[ACCOUNT CHECK] Existing tier: {current_tier_name}")
            old_subscription_id = existing_data.get('stripe_subscription_id')
            last_grant_date = existing_data.get('last_grant_date')
            existing_anchor = existing_data.get('billing_cycle_anchor')

            last_processed_invoice = existing_data.get('last_processed_invoice_id')
            last_renewal_period_start = existing_data.get('last_renewal_period_start')
            
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
            
            logger.error(f"[TIER DEBUG] Current: {current_tier['name']} ({current_tier['credits']}), New: {new_tier['name']} ({new_tier['credits']})")
            logger.error(f"[TIER DEBUG] Subscription ID: {subscription['id']}, Account: {account_id}")
            
            if current_tier['name'] == new_tier['name'] and current_tier['name'] not in ['free', 'none']:
                logger.error(f"[CREDIT BLOCK!!!] SAME TIER DETECTED: {new_tier['name']}")
                logger.error(f"[CREDIT BLOCK!!!] This is 100% a RENEWAL, not an upgrade")
                logger.error(f"[CREDIT BLOCK!!!] BLOCKING all credit operations")
                
                await client.from_('credit_accounts').update({
                    'tier': new_tier['name'],
                    'stripe_subscription_id': subscription['id'],
                    'billing_cycle_anchor': billing_anchor.isoformat(),
                    'next_credit_grant': next_grant_date.isoformat()
                }).eq('account_id', account_id).execute()
                return
            
            should_grant_credits = self._should_grant_credits(current_tier_name, current_tier, new_tier, subscription, old_subscription_id, is_renewal)
            
            if should_grant_credits:
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
            logger.error(f"[CRITICAL WARNING] No existing credit account found for {account_id}")
            logger.error(f"[CRITICAL WARNING] This should NOT happen for renewals!")
            logger.error(f"[CRITICAL WARNING] Creating initial subscription - but this might be wrong!")
            await self._grant_initial_subscription_credits(account_id, new_tier, billing_anchor, subscription, client)

    async def _handle_trial_subscription(self, subscription, account_id, new_tier, client):
        if not subscription.get('trial_end'):
            return
        
        existing_account = await client.from_('credit_accounts').select('trial_status').eq('account_id', account_id).execute()
        if existing_account.data:
            current_status = existing_account.data[0].get('trial_status')
            if current_status == 'active':
                logger.info(f"[WEBHOOK] Trial already active for account {account_id}, skipping duplicate processing")
                return
            elif current_status == 'none':
                logger.info(f"[WEBHOOK] Activating trial for account {account_id}")
            
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
        
        logger.info(f"[WEBHOOK] Started trial for user {account_id} via Stripe subscription - granted ${TRIAL_CREDITS} credits")

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
        logger.error(f"[CREDIT GRANT WARNING] subscription.updated is granting {full_amount} credits to {account_id}")
        logger.error(f"[CREDIT GRANT WARNING] This should ONLY happen for tier UPGRADES, not renewals!")
        logger.info(f"[CREDIT GRANT] Granting {full_amount} credits to user {account_id} for tier {new_tier['name']}")
        logger.info(f"[CREDIT GRANT] Billing anchor: {billing_anchor}, Trigger: subscription.updated webhook")
        
        expires_at = billing_anchor.replace(month=billing_anchor.month + 1) if billing_anchor.month < 12 else billing_anchor.replace(year=billing_anchor.year + 1, month=1)
        result = await credit_manager.add_credits(
            account_id=account_id,
            amount=full_amount,
            is_expiring=True,
            description=f"Tier upgrade to {new_tier['name']}",
            expires_at=expires_at
        )
        
        logger.info(f"[CREDIT GRANT] Successfully granted {full_amount} expiring credits for tier upgrade to {new_tier['name']}")

    async def _grant_initial_subscription_credits(self, account_id, new_tier, billing_anchor, subscription, client):
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
            'next_credit_grant': next_grant_date.isoformat()
        }).eq('account_id', account_id).execute()

    async def get_user_subscription_tier(self, account_id: str) -> Dict:
        """
        Get the subscription tier information for a user.
        
        Args:
            account_id: The user's account ID
            
        Returns:
            Dictionary containing tier information
        """
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
        """
        Get the list of model IDs allowed for a user based on their subscription tier.
        
        Args:
            user_id: The user's account ID
            client: Optional Supabase client (for compatibility with old API)
            
        Returns:
            List of model IDs allowed for the user's subscription tier.
        """
        try:
            from core.ai_models import model_manager
            
            # Get user's subscription tier
            tier_info = await self.get_user_subscription_tier(user_id)
            tier_name = tier_info['name']
            
            logger.debug(f"[ALLOWED_MODELS] User {user_id} tier: {tier_name}")
            
            # If user has 'all' models access
            if 'all' in tier_info.get('models', []):
                # Get all available models from the model manager
                all_models = model_manager.list_available_models(include_disabled=False)
                allowed_model_ids = [model_data["id"] for model_data in all_models]
                logger.debug(f"[ALLOWED_MODELS] User {user_id} has access to all {len(allowed_model_ids)} models")
                return allowed_model_ids
            
            # If user has specific models listed
            elif tier_info.get('models'):
                logger.debug(f"[ALLOWED_MODELS] User {user_id} has specific models: {tier_info['models']}")
                return tier_info['models']
            
            # If user has no access (free/none tier)
            else:
                logger.debug(f"[ALLOWED_MODELS] User {user_id} has no model access (tier: {tier_name})")
                return []
                
        except Exception as e:
            logger.error(f"[ALLOWED_MODELS] Error getting allowed models for user {user_id}: {e}")
            return []

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
        
        # Insert commitment history record
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
        """Get the commitment status for an account"""
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
            # Commitment has expired, clear it
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


subscription_service = SubscriptionService()

