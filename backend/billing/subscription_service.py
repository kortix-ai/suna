from fastapi import HTTPException
from typing import Dict, Optional
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
    get_tier_by_name
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

    async def create_checkout_session(self, account_id: str, price_id: str, success_url: str, cancel_url: str) -> Dict:
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
                        'previous_tier': current_tier or 'trial'
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
                        'account_type': 'personal'
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
            'stripe_subscription_id'
        ).eq('account_id', account_id).execute()
        
        if not credit_result.data or not credit_result.data[0].get('stripe_subscription_id'):
            raise HTTPException(status_code=404, detail="No subscription found")
        
        subscription_id = credit_result.data[0]['stripe_subscription_id']
        
        try:
            subscription = await stripe.Subscription.modify_async(
                subscription_id,
                cancel_at_period_end=True,
                metadata={'cancellation_feedback': feedback} if feedback else {}
            )
            
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

    async def handle_subscription_change(self, subscription: Dict):
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
        
        new_tier_info = get_tier_by_price_id(price_id)
        if not new_tier_info:
            logger.warning(f"Unknown price ID in subscription: {price_id}")
            return
        
        new_tier = {
            'name': new_tier_info.name,
            'credits': float(new_tier_info.monthly_credits)
        }
        
        if subscription.status == 'trialing' and subscription.get('trial_end'):
            await self._handle_trial_subscription(subscription, account_id, new_tier, client)
            return
        
        billing_anchor = datetime.fromtimestamp(subscription['current_period_start'], tz=timezone.utc)
        next_grant_date = datetime.fromtimestamp(subscription['current_period_end'], tz=timezone.utc)
        
        current_account = await client.from_('credit_accounts').select(
            'tier, stripe_subscription_id, last_grant_date, billing_cycle_anchor'
        ).eq('account_id', account_id).execute()
        
        if current_account.data:
            existing_data = current_account.data[0]
            current_tier_name = existing_data.get('tier')
            old_subscription_id = existing_data.get('stripe_subscription_id')
            last_grant_date = existing_data.get('last_grant_date')
            existing_anchor = existing_data.get('billing_cycle_anchor')
            if last_grant_date and existing_anchor:
                try:
                    last_grant_dt = datetime.fromisoformat(last_grant_date.replace('Z', '+00:00'))
                    existing_anchor_dt = datetime.fromisoformat(existing_anchor.replace('Z', '+00:00'))
                    
                    if (abs((billing_anchor - last_grant_dt).total_seconds()) < 60 and 
                        current_tier_name == new_tier['name'] and 
                        old_subscription_id == subscription['id']):
                        logger.info(f"[IDEMPOTENCY] Skipping duplicate credit grant for {account_id} - "
                                  f"already processed at {last_grant_date}")
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
            
            should_grant_credits = self._should_grant_credits(current_tier_name, current_tier, new_tier, subscription, old_subscription_id)
            
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

    def _should_grant_credits(self, current_tier_name, current_tier, new_tier, subscription, old_subscription_id):
        should_grant_credits = False
        
        if current_tier_name in ['free', 'none'] and new_tier['name'] not in ['free', 'none']:
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
            elif new_tier['credits'] > current_tier['credits']:
                should_grant_credits = True
                logger.info(f"Credit increase for tier {new_tier['name']}: {current_tier['credits']} -> {new_tier['credits']}")
        
        return should_grant_credits

    async def _grant_subscription_credits(self, account_id, new_tier, billing_anchor):
        full_amount = Decimal(new_tier['credits'])
        logger.info(f"Granting {full_amount} credits to user {account_id}")
        
        expires_at = billing_anchor.replace(month=billing_anchor.month + 1) if billing_anchor.month < 12 else billing_anchor.replace(year=billing_anchor.year + 1, month=1)
        result = await credit_manager.add_credits(
            account_id=account_id,
            amount=full_amount,
            is_expiring=True,
            description=f"Subscription update: {new_tier['name']} - Full tier credits",
            expires_at=expires_at
        )
        
        logger.info(f"Successfully granted {full_amount} expiring credits")

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


subscription_service = SubscriptionService() 
