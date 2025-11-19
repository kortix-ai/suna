from fastapi import HTTPException, Request
from typing import Dict
from decimal import Decimal
from datetime import datetime, timezone, timedelta
import stripe
from core.services.supabase import DBConnection
from core.utils.config import config
from core.utils.logger import logger
from core.utils.cache import Cache
from core.utils.distributed_lock import WebhookLock, RenewalLock, DistributedLock
from .config import (
    get_tier_by_price_id, 
    get_tier_by_name,
    TIERS, 
    get_monthly_credits,
    TRIAL_DURATION_DAYS,
    TRIAL_CREDITS,
    is_commitment_price_id,
    get_commitment_duration_months
)
from .credit_manager import credit_manager
from .stripe_circuit_breaker import StripeAPIWrapper


class WebhookService:
    def __init__(self):
        self.stripe = stripe
        
    async def process_stripe_webhook(self, request: Request) -> Dict:
        event = None
        try:
            payload = await request.body()
            sig_header = request.headers.get('stripe-signature')
            
            if not config.STRIPE_WEBHOOK_SECRET:
                raise HTTPException(status_code=500, detail="Webhook secret not configured")
            
            try:
                event = stripe.Webhook.construct_event(
                    payload, sig_header, config.STRIPE_WEBHOOK_SECRET,
                    tolerance=60
                )
            except stripe.error.SignatureVerificationError as e:
                raise HTTPException(status_code=400, detail="Invalid webhook signature")
            except ValueError as e:
                raise HTTPException(status_code=400, detail="Invalid payload")

            can_process, reason = await WebhookLock.check_and_mark_webhook_processing(
                event.id, 
                event.type,
                payload=event.to_dict() if hasattr(event, 'to_dict') else None
            )
            
            if not can_process:
                logger.info(f"[WEBHOOK] Skipping event {event.id}: {reason}")
                return {'status': 'success', 'message': f'Event already processed or in progress: {reason}'}
            
            cache_key = f"stripe_event:{event.id}"
            await Cache.set(cache_key, True, ttl=7200)
            
            db = DBConnection()
            client = await db.client
            
            logger.info(f"[WEBHOOK] Processing event type: {event.type} (ID: {event.id})")
            
            if event.type == 'checkout.session.completed':
                logger.info(f"[WEBHOOK] Handling checkout.session.completed")
                await self._handle_checkout_session_completed(event, client)
            
            elif event.type in ['customer.subscription.created', 'customer.subscription.updated']:
                await self._handle_subscription_created_or_updated(event, client)
            
            elif event.type == 'customer.subscription.deleted':
                await self._handle_subscription_deleted(event, client)
            
            elif event.type in ['invoice.payment_succeeded', 'invoice.paid', 'invoice_payment.paid']:
                await self._handle_invoice_payment_succeeded(event, client)
            
            elif event.type == 'invoice.payment_failed':
                await self._handle_invoice_payment_failed(event, client)
            
            elif event.type == 'customer.subscription.trial_will_end':
                await self._handle_trial_will_end(event, client)
            
            elif event.type in ['subscription_schedule.updated', 'subscription_schedule.completed', 'subscription_schedule.released']:
                await self._handle_subscription_schedule_event(event, client)
            
            elif event.type in ['charge.refunded', 'payment_intent.refunded']:
                await self._handle_refund(event, client)
            
            else:
                logger.info(f"[WEBHOOK] Unhandled event type: {event.type}")
            
            await WebhookLock.mark_webhook_completed(event.id)
            
            return {'status': 'success'}
        
        except Exception as e:
            logger.error(f"[WEBHOOK] Error processing webhook: {e}")
            if event and hasattr(event, 'id'):
                await WebhookLock.mark_webhook_failed(event.id, str(e))
            return {'status': 'success', 'error': 'processed_with_errors', 'message': 'Webhook logged as failed internally'}
    
    async def _handle_checkout_session_completed(self, event, client):
        session = event.data.object
        logger.info(f"[WEBHOOK] Checkout session completed - ID: {session.get('id')}, Has subscription: {bool(session.get('subscription'))}, Metadata: {session.get('metadata', {})}")
        if session.get('metadata', {}).get('type') == 'credit_purchase':
            await self._handle_credit_purchase(session, client)
        elif session.get('subscription'):
            logger.info(f"[WEBHOOK] Routing to subscription checkout handler")
            await self._handle_subscription_checkout(session, client)
        else:
            logger.warning(f"[WEBHOOK] Checkout session has neither credit_purchase type nor subscription")
    
    async def _handle_credit_purchase(self, session, client):
        metadata = session.get('metadata', {})
        account_id = metadata.get('account_id')
        credit_amount_str = metadata.get('credit_amount')
        
        if not account_id or not credit_amount_str:
            return
            
        try:
            credit_amount = Decimal(credit_amount_str)
        except (ValueError, TypeError) as e:
            return
        
        try:
            current_state = await client.from_('credit_accounts').select(
                'balance, expiring_credits, non_expiring_credits'
            ).eq('account_id', account_id).execute()
            
            if session.payment_intent:
                update_result = await client.table('credit_purchases').update({
                    'status': 'completed',
                    'completed_at': datetime.now(timezone.utc).isoformat(),
                    'stripe_payment_intent_id': session.payment_intent
                }).eq('stripe_payment_intent_id', session.payment_intent).execute()
                
                if not update_result.data or len(update_result.data) == 0:
                    purchase_id = metadata.get('purchase_id')
                    if purchase_id:
                        update_result = await client.table('credit_purchases').update({
                            'status': 'completed',
                            'completed_at': datetime.now(timezone.utc).isoformat(),
                            'stripe_payment_intent_id': session.payment_intent
                        }).eq('id', purchase_id).execute()
            else:
                purchase_id = metadata.get('purchase_id')
                if purchase_id:
                    update_result = await client.table('credit_purchases').update({
                        'status': 'completed',
                        'completed_at': datetime.now(timezone.utc).isoformat()
                    }).eq('id', purchase_id).execute()
            
            result = await credit_manager.add_credits(
                account_id=account_id,
                amount=credit_amount,
                is_expiring=False,
                description=f"Purchased ${credit_amount} credits"
            )
            
            if not result.get('success'):
                purchase_id = metadata.get('purchase_id')
                if purchase_id:
                    await client.table('credit_purchases').update({
                        'status': 'failed',
                        'error_message': 'Credit addition failed'
                    }).eq('id', purchase_id).execute()
                
                return
        except Exception as e:
            try:
                purchase_id = metadata.get('purchase_id')
                if purchase_id:
                    await client.table('credit_purchases').update({
                        'status': 'failed',
                        'error_message': str(e)
                    }).eq('id', purchase_id).execute()
            except:
                pass
            return
        
        final_state = await client.from_('credit_accounts').select(
            'balance, expiring_credits, non_expiring_credits'
        ).eq('account_id', account_id).execute()
        
        if final_state.data:
            
            before = current_state.data[0] if current_state.data else {'balance': 0, 'expiring_credits': 0, 'non_expiring_credits': 0}
            after = final_state.data[0]
            
            expected_total = float(before['balance']) + float(credit_amount)
            actual_total = float(after['balance'])
            
    async def _handle_subscription_checkout(self, session, client):
        logger.info(f"[WEBHOOK CHECKOUT] Starting subscription checkout handler for session {session.get('id')}")
        account_id = session.get('metadata', {}).get('account_id')
        if not account_id:
            customer_result = await client.schema('basejump').from_('billing_customers')\
                .select('account_id')\
                .eq('id', session.get('customer'))\
                .execute()
            if customer_result.data:
                account_id = customer_result.data[0].get('account_id')
        
        logger.info(f"[WEBHOOK CHECKOUT] Account ID: {account_id}, Has subscription: {bool(session.get('subscription'))}")
        
        if account_id:
            trial_check = await client.from_('credit_accounts').select(
                'trial_status, tier, balance'
            ).eq('account_id', account_id).execute()
            
            logger.info(f"[WEBHOOK CHECKOUT] Trial check data: {trial_check.data[0] if trial_check.data else 'No data'}")
            
            if trial_check.data and trial_check.data[0].get('trial_status') == 'active':
                subscription_id = session.get('subscription')
                if subscription_id:
                    subscription = await StripeAPIWrapper.retrieve_subscription(subscription_id)
                    price_id = subscription['items']['data'][0]['price']['id'] if subscription.get('items') else None
                    tier_info = get_tier_by_price_id(price_id)
                    
                    if not tier_info:
                        logger.error(f"[WEBHOOK CHECKOUT] Cannot process checkout - price_id {price_id} not recognized")
                        raise ValueError(f"Unrecognized price_id: {price_id}")
                    
                    await client.from_('credit_accounts').update({
                        'trial_status': 'converted',
                        'tier': tier_info.name,
                        'stripe_subscription_id': subscription['id']
                    }).eq('account_id', account_id).execute()
                    
                    await client.from_('trial_history').update({
                        'ended_at': datetime.now(timezone.utc).isoformat(),
                        'converted_to_paid': True,
                        'status': 'converted'
                    }).eq('account_id', account_id).is_('ended_at', 'null').execute()
                    
                    return

        logger.info(f"[WEBHOOK CHECKOUT] Checking converting_from_trial metadata: {session.get('metadata', {}).get('converting_from_trial')}")
        if session.get('metadata', {}).get('converting_from_trial') == 'true':
            account_id = session['metadata'].get('account_id')
            if session.get('subscription'):
                subscription_id = session['subscription']
                subscription = await StripeAPIWrapper.safe_stripe_call(
                    stripe.Subscription.retrieve_async, 
                    subscription_id, 
                    expand=['default_payment_method']
                )

                price_id = subscription['items']['data'][0]['price']['id'] if subscription.get('items') else None
                tier_info = get_tier_by_price_id(price_id)
                
                if not tier_info:
                    logger.error(f"[TRIAL CONVERSION] Cannot process trial conversion - price_id {price_id} not recognized")
                    raise ValueError(f"Unrecognized price_id: {price_id}")
                
                lock_key = f"credit_grant:trial_conversion:{account_id}"
                lock = DistributedLock(lock_key, timeout_seconds=60)
                
                acquired = await lock.acquire(wait=True, wait_timeout=30)
                if not acquired:
                    logger.error(f"[TRIAL CONVERSION] Failed to acquire lock for {account_id}")
                    return
                
                try:
                    logger.info(f"[TRIAL CONVERSION] 🔒 Acquired lock for trial conversion for {account_id}")
                    
                    tier_name = tier_info.name
                    tier_credits = float(tier_info.monthly_credits)
                    
                    current_balance_result = await client.from_('credit_accounts')\
                        .select('balance, non_expiring_credits')\
                        .eq('account_id', account_id)\
                        .execute()
                    
                    old_non_expiring = 0
                    if current_balance_result.data:
                        old_non_expiring = float(current_balance_result.data[0].get('non_expiring_credits', 0))
                    
                    billing_anchor = datetime.fromtimestamp(subscription['current_period_start'], tz=timezone.utc)
                    next_grant_date = datetime.fromtimestamp(subscription['current_period_end'], tz=timezone.utc)
                    expires_at = next_grant_date
                    
                    await client.from_('credit_accounts').update({
                        'trial_status': 'converted',
                        'converted_to_paid_at': datetime.now(timezone.utc).isoformat(),
                        'tier': tier_name,
                        'stripe_subscription_id': subscription['id'],
                        'billing_cycle_anchor': billing_anchor.isoformat(),
                        'next_credit_grant': next_grant_date.isoformat()
                    }).eq('account_id', account_id).execute()
                    
                    await credit_manager.add_credits(
                        account_id=account_id,
                        amount=Decimal(str(tier_credits)),
                        is_expiring=True,
                        description=f"Converted from trial to {tier_info.display_name} plan",
                        expires_at=expires_at
                    )
                    
                    await client.from_('trial_history').update({
                        'ended_at': datetime.now(timezone.utc).isoformat(),
                        'converted_to_paid': True,
                        'status': 'converted'
                    }).eq('account_id', account_id).is_('ended_at', 'null').execute()
                    
                    logger.info(f"[TRIAL CONVERSION] ✅ Completed trial conversion for {account_id}")
                finally:
                    await lock.release()
                
                return

        logger.info(f"[WEBHOOK CHECKOUT] Checking trial_start metadata: {session.get('metadata', {}).get('trial_start')}")
        if session.get('metadata', {}).get('trial_start') == 'true':
            account_id = session['metadata'].get('account_id')
            if session.get('subscription'):
                subscription_id = session['subscription']
                subscription = await StripeAPIWrapper.safe_stripe_call(
                    stripe.Subscription.retrieve_async, 
                    subscription_id, 
                    expand=['default_payment_method']
                )
                
                if subscription.status == 'trialing':
                    lock_key = f"credit_grant:trial:{account_id}"
                    lock = DistributedLock(lock_key, timeout_seconds=60)
                    
                    acquired = await lock.acquire(wait=True, wait_timeout=30)
                    if not acquired:
                        logger.error(f"[WEBHOOK TRIAL] Failed to acquire lock for trial activation {account_id}")
                        return
                    
                    try:
                        logger.info(f"[WEBHOOK TRIAL] 🔒 Acquired lock for trial activation for {account_id}")
                        
                        existing_account = await client.from_('credit_accounts').select('trial_status').eq('account_id', account_id).execute()
                        if existing_account.data and existing_account.data[0].get('trial_status') == 'active':
                            logger.info(f"[WEBHOOK] Trial already active for account {account_id} in checkout handler, skipping duplicate credits")
                            return
                        
                        recent_trial_credits = await client.from_('credit_ledger').select('*').eq(
                            'account_id', account_id
                        ).eq('description', f'{TRIAL_DURATION_DAYS}-day free trial credits').execute()
                        
                        if recent_trial_credits.data:
                            logger.warning(f"[WEBHOOK] Trial credits already granted for account {account_id} (found in ledger), skipping duplicate")
                            return
                        
                        price_id = subscription['items']['data'][0]['price']['id'] if subscription.get('items') else None
                        tier_info = get_tier_by_price_id(price_id)
                        tier_name = tier_info.name if tier_info else 'tier_2_20'

                        trial_ends_at = datetime.fromtimestamp(subscription.trial_end, tz=timezone.utc) if subscription.get('trial_end') else None
                        
                        await client.from_('credit_accounts').update({
                            'trial_status': 'active',
                            'trial_started_at': datetime.now(timezone.utc).isoformat(),
                            'trial_ends_at': trial_ends_at.isoformat() if trial_ends_at else None,
                            'stripe_subscription_id': subscription['id'],
                            'tier': tier_name
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
                            'started_at': datetime.now(timezone.utc).isoformat(),
                            'stripe_checkout_session_id': session.get('id'),
                            'status': 'active'
                        }, on_conflict='account_id').execute()
                        
                        logger.info(f"[WEBHOOK] ✅ Trial activated for account {account_id} via checkout.session.completed - granted ${TRIAL_CREDITS} credits")
                    finally:
                        await lock.release()
                    return
                else:
                    logger.info(f"[WEBHOOK] Subscription status: {subscription.status}, not trialing")
    
        logger.info(f"[WEBHOOK CHECKOUT] Reached default handler section. Has subscription: {bool(session.get('subscription'))}")
        if session.get('subscription'):
            subscription_id = session['subscription']
            subscription = await StripeAPIWrapper.safe_stripe_call(
                stripe.Subscription.retrieve_async, 
                subscription_id, 
                expand=['default_payment_method']
            )
            
            logger.info(f"[WEBHOOK CHECKOUT DEFAULT] Subscription status: {subscription.status}")
            if subscription.status == 'active':
                account_id = session.get('metadata', {}).get('account_id')
                if not account_id:
                    customer_result = await client.schema('basejump').from_('billing_customers')\
                        .select('account_id')\
                        .eq('id', session.get('customer'))\
                        .execute()
                    if customer_result.data:
                        account_id = customer_result.data[0].get('account_id')
                
                if not account_id:
                    logger.warning(f"[WEBHOOK] Could not find account_id for checkout session {session.get('id')}")
                    return
                
                price_id = subscription['items']['data'][0]['price']['id'] if subscription.get('items') else None
                tier_info = get_tier_by_price_id(price_id)
                
                if not tier_info:
                    logger.warning(f"[WEBHOOK] Unknown price_id {price_id} for subscription {subscription_id}")
                    return
                
                credit_account = await client.from_('credit_accounts').select('*').eq('account_id', account_id).execute()
                
                if credit_account.data:
                    current = credit_account.data[0]
                    if current.get('stripe_subscription_id') == subscription_id and current.get('tier') == tier_info.name:
                        logger.info(f"[WEBHOOK] Subscription already set up for {account_id}, skipping")
                        return
                    
                    if current.get('trial_status') == 'cancelled':
                        logger.info(f"[WEBHOOK DEFAULT] User {account_id} with cancelled trial is subscribing - handling as new subscription")
                
                lock_key = f"credit_grant:checkout:{account_id}"
                lock = DistributedLock(lock_key, timeout_seconds=60)
                
                acquired = await lock.acquire(wait=True, wait_timeout=30)
                if not acquired:
                    logger.error(f"[WEBHOOK DEFAULT] Failed to acquire lock for {account_id}")
                    return
                
                try:
                    logger.info(f"[WEBHOOK DEFAULT] 🔒 Processing new subscription for {account_id}")
                    
                    billing_anchor = datetime.fromtimestamp(subscription['current_period_start'], tz=timezone.utc)
                    next_grant_date = datetime.fromtimestamp(subscription['current_period_end'], tz=timezone.utc)
                    
                    from decimal import Decimal
                    await credit_manager.add_credits(
                        account_id=account_id,
                        amount=Decimal(str(tier_info.monthly_credits)),
                        is_expiring=True,
                        description=f"Initial {tier_info.display_name} subscription credits (checkout.session.completed)",
                        expires_at=next_grant_date
                    )
                    
                    logger.info(f"[WEBHOOK DEFAULT] Granted {tier_info.monthly_credits} credits to {account_id}")
                    
                    update_data = {
                        'tier': tier_info.name,
                        'stripe_subscription_id': subscription['id'],
                        'billing_cycle_anchor': billing_anchor.isoformat(),
                        'next_credit_grant': next_grant_date.isoformat(),
                        'last_grant_date': billing_anchor.isoformat()
                    }
                    
                    if credit_account.data and credit_account.data[0].get('trial_status') == 'cancelled':
                        update_data['trial_status'] = 'none'
                    
                    await client.from_('credit_accounts').update(update_data).eq('account_id', account_id).execute()
                finally:
                    await lock.release()
    
    async def _handle_subscription_created_or_updated(self, event, client):
        subscription = event.data.object
        subscription_id = subscription.get('id')
        subscription_status = subscription.get('status')
        
        logger.info(f"[SUBSCRIPTION HANDLER] Event: {event.type}, Subscription: {subscription_id}, Status: {subscription_status}")
        
        if event.type == 'customer.subscription.updated':
            previous_attributes = event.data.get('previous_attributes', {})
            await self._handle_subscription_updated(event, subscription, client)
        
        if event.type == 'customer.subscription.created':
            logger.info(f"[SUBSCRIPTION.CREATED] Processing subscription.created for {subscription_id}")
            account_id = subscription.get('metadata', {}).get('account_id')
            customer_id = subscription.get('customer')
            price_id = subscription['items']['data'][0]['price']['id'] if subscription.get('items') else None
            
            logger.info(f"[SUBSCRIPTION.CREATED] account_id={account_id}, customer_id={customer_id}, price_id={price_id}")
            
            if not account_id and customer_id:
                customer_result = await client.schema('basejump').from_('billing_customers')\
                    .select('account_id')\
                    .eq('id', customer_id)\
                    .execute()
                if customer_result.data:
                    account_id = customer_result.data[0].get('account_id')
                    logger.info(f"[SUBSCRIPTION.CREATED] Found account_id from billing_customers: {account_id}")
            
            if account_id and customer_id:
                canceled_subs = []
                new_price = subscription['items']['data'][0]['price']
                new_amount = new_price.get('unit_amount', 0) or 0
                
                logger.info(f"[SUBSCRIPTION CLEANUP] New subscription {subscription_id} created with amount ${new_amount/100:.2f}, checking for duplicates...")
                
                previous_subscription_id = subscription.get('metadata', {}).get('previous_subscription_id')
                if previous_subscription_id:
                    try:
                        logger.info(f"[UPGRADE CLEANUP] Immediately canceling previous subscription {previous_subscription_id} for {account_id}")
                        await StripeAPIWrapper.cancel_subscription(previous_subscription_id)
                        canceled_subs.append(previous_subscription_id)
                        logger.info(f"[UPGRADE CLEANUP] ✅ Canceled previous subscription {previous_subscription_id}")
                    except stripe.error.StripeError as e:
                        logger.warning(f"[UPGRADE CLEANUP] Could not cancel previous subscription {previous_subscription_id}: {e}")
                
                try:
                    logger.info(f"[SUBSCRIPTION CLEANUP] Fetching all active subscriptions for customer {customer_id}")
                    customer_subs = await self.stripe.Subscription.list_async(
                        customer=customer_id,
                        status='active',
                        limit=10
                    )
                    
                    logger.info(f"[SUBSCRIPTION CLEANUP] Found {len(customer_subs.data)} active subscriptions for customer")
                    
                    for old_sub in customer_subs.data:
                        if old_sub.id != subscription_id and old_sub.id not in canceled_subs:
                            old_price = old_sub['items']['data'][0]['price']
                            old_amount = old_price.get('unit_amount', 0) or 0
                            
                            logger.info(f"[SUBSCRIPTION CLEANUP] Checking subscription {old_sub.id} with amount ${old_amount/100:.2f}")
                            
                            if old_amount == 0 and new_amount > 0:
                                logger.info(f"[DUPLICATE CLEANUP] New subscription is PAID (${new_amount/100:.2f}), canceling old FREE subscription {old_sub.id}")
                                await StripeAPIWrapper.cancel_subscription(old_sub.id)
                                canceled_subs.append(old_sub.id)
                                logger.info(f"[DUPLICATE CLEANUP] ✅ Canceled old $0 subscription {old_sub.id}")
                            elif old_amount == 0 and new_amount == 0:
                                logger.info(f"[DUPLICATE CLEANUP] Both are $0, keeping newer subscription {subscription_id}, canceling old {old_sub.id}")
                                await StripeAPIWrapper.cancel_subscription(old_sub.id)
                                canceled_subs.append(old_sub.id)
                                logger.info(f"[DUPLICATE CLEANUP] ✅ Canceled duplicate $0 subscription {old_sub.id}")
                    
                    if canceled_subs:
                        logger.info(f"[CLEANUP SUMMARY] ✅ Canceled {len(canceled_subs)} old subscriptions: {canceled_subs}")
                    else:
                        logger.info(f"[CLEANUP SUMMARY] No duplicate subscriptions found to cancel")
                except stripe.error.StripeError as e:
                    logger.error(f"[DUPLICATE CLEANUP] Error checking for duplicate subscriptions: {e}")
        
        if subscription.status in ['active', 'trialing']:
            if subscription.status == 'trialing' and not subscription.get('metadata', {}).get('account_id'):
                customer_result = await client.schema('basejump').from_('billing_customers')\
                    .select('account_id')\
                    .eq('id', subscription['customer'])\
                    .execute()
                
                if customer_result.data and customer_result.data[0].get('account_id'):
                    account_id = customer_result.data[0]['account_id']
                    try:
                        await StripeAPIWrapper.modify_subscription(
                            subscription['id'],
                            metadata={'account_id': account_id, 'trial_start': 'true'}
                        )
                        subscription['metadata'] = {'account_id': account_id, 'trial_start': 'true'}
                    except Exception as e:
                        logger.error(f"[WEBHOOK] Failed to update subscription metadata: {e}")
            
            if event.type == 'customer.subscription.created':
                logger.info(f"[SUBSCRIPTION.CREATED] Processing subscription.created event for subscription {subscription.get('id')}")
                account_id = subscription.get('metadata', {}).get('account_id')
                price_id = subscription['items']['data'][0]['price']['id'] if subscription.get('items') else None
                commitment_type = subscription.get('metadata', {}).get('commitment_type')
                customer_id = subscription.get('customer')
                
                logger.info(f"[SUBSCRIPTION.CREATED] account_id={account_id}, customer_id={customer_id}, price_id={price_id}")
                
                if not account_id:
                    customer_result = await client.schema('basejump').from_('billing_customers')\
                        .select('account_id')\
                        .eq('id', customer_id)\
                        .execute()
                    if customer_result.data:
                        account_id = customer_result.data[0].get('account_id')
                
                if account_id and customer_id:
                    canceled_subs = []
                    new_price = subscription['items']['data'][0]['price']
                    new_amount = new_price.get('unit_amount', 0) or 0
                    
                    logger.info(f"[SUBSCRIPTION CLEANUP] New subscription {subscription.id} created with amount ${new_amount/100:.2f}, checking for duplicates...")
                    
                    previous_subscription_id = subscription.get('metadata', {}).get('previous_subscription_id')
                    if previous_subscription_id:
                        try:
                            logger.info(f"[UPGRADE CLEANUP] Immediately canceling previous subscription {previous_subscription_id} for {account_id}")
                            await StripeAPIWrapper.cancel_subscription(previous_subscription_id)
                            canceled_subs.append(previous_subscription_id)
                            logger.info(f"[UPGRADE CLEANUP] ✅ Canceled previous subscription {previous_subscription_id}")
                        except stripe.error.StripeError as e:
                            logger.warning(f"[UPGRADE CLEANUP] Could not cancel previous subscription {previous_subscription_id}: {e}")
                    
                    try:
                        logger.info(f"[SUBSCRIPTION CLEANUP] Fetching all active subscriptions for customer {customer_id}")
                        customer_subs = await self.stripe.Subscription.list_async(
                            customer=customer_id,
                            status='active',
                            limit=10
                        )
                        
                        logger.info(f"[SUBSCRIPTION CLEANUP] Found {len(customer_subs.data)} active subscriptions for customer")
                        
                        for old_sub in customer_subs.data:
                            if old_sub.id != subscription.id and old_sub.id not in canceled_subs:
                                old_price = old_sub['items']['data'][0]['price']
                                old_amount = old_price.get('unit_amount', 0) or 0
                                
                                logger.info(f"[SUBSCRIPTION CLEANUP] Checking subscription {old_sub.id} with amount ${old_amount/100:.2f}")
                                
                                if old_amount == 0 and new_amount > 0:
                                    logger.info(f"[DUPLICATE CLEANUP] New subscription is PAID (${new_amount/100:.2f}), canceling old FREE subscription {old_sub.id}")
                                    await StripeAPIWrapper.cancel_subscription(old_sub.id)
                                    canceled_subs.append(old_sub.id)
                                    logger.info(f"[DUPLICATE CLEANUP] ✅ Canceled old $0 subscription {old_sub.id}")
                                elif old_amount == 0 and new_amount == 0:
                                    logger.info(f"[DUPLICATE CLEANUP] Both are $0, keeping newer subscription {subscription.id}, canceling old {old_sub.id}")
                                    await StripeAPIWrapper.cancel_subscription(old_sub.id)
                                    canceled_subs.append(old_sub.id)
                                    logger.info(f"[DUPLICATE CLEANUP] ✅ Canceled duplicate $0 subscription {old_sub.id}")
                        
                        if canceled_subs:
                            logger.info(f"[CLEANUP SUMMARY] ✅ Canceled {len(canceled_subs)} old subscriptions: {canceled_subs}")
                        else:
                            logger.info(f"[CLEANUP SUMMARY] No duplicate subscriptions found to cancel")
                    except stripe.error.StripeError as e:
                        logger.error(f"[DUPLICATE CLEANUP] Error checking for duplicate subscriptions: {e}")
                    
                    trial_check = await client.from_('credit_accounts').select(
                        'trial_status, tier, stripe_subscription_id'
                    ).eq('account_id', account_id).execute()
                    
                    if trial_check.data:
                        trial_status = trial_check.data[0].get('trial_status')
                        current_tier = trial_check.data[0].get('tier')
                        current_subscription_id = trial_check.data[0].get('stripe_subscription_id')
                        
                        if current_tier in ['free', 'none']:
                            tier_info = get_tier_by_price_id(price_id)
                            if not tier_info:
                                logger.error(f"[WEBHOOK] Cannot process subscription - price_id {price_id} not recognized")
                                raise ValueError(f"Unrecognized price_id: {price_id}")
                            
                            billing_anchor = datetime.fromtimestamp(subscription['current_period_start'], tz=timezone.utc)
                            next_grant_date = datetime.fromtimestamp(subscription['current_period_end'], tz=timezone.utc)
                            
                            if subscription.status == 'incomplete':
                                logger.info(f"[WEBHOOK] User {account_id} upgrading from {current_tier} tier to {tier_info.name} (payment pending)")
                                await client.from_('credit_accounts').update({
                                    'tier': tier_info.name,
                                    'stripe_subscription_id': subscription['id'],
                                    'billing_cycle_anchor': billing_anchor.isoformat(),
                                    'next_credit_grant': next_grant_date.isoformat()
                                }).eq('account_id', account_id).execute()
                                logger.info(f"[WEBHOOK] Updated tier to {tier_info.name}, waiting for payment to grant credits")
                                
                            elif subscription.status == 'active':
                                logger.info(f"[WEBHOOK] User {account_id} upgrading from {current_tier} tier to paid")
                                
                                from decimal import Decimal
                                await credit_manager.add_credits(
                                    account_id=account_id,
                                    amount=Decimal(str(tier_info.monthly_credits)),
                                    is_expiring=True,
                                    description=f"Initial {tier_info.display_name} subscription credits",
                                    expires_at=next_grant_date
                                )
                                
                                logger.info(f"[WEBHOOK] Granted {tier_info.monthly_credits} credits to {account_id} for upgrade from {current_tier} tier")
                                
                                await client.from_('credit_accounts').update({
                                    'tier': tier_info.name,
                                    'stripe_subscription_id': subscription['id'],
                                    'billing_cycle_anchor': billing_anchor.isoformat(),
                                    'next_credit_grant': next_grant_date.isoformat(),
                                    'last_grant_date': billing_anchor.isoformat()
                                }).eq('account_id', account_id).execute()
                        
                        elif trial_status == 'active':
                            tier_info = get_tier_by_price_id(price_id)
                            if not tier_info:
                                logger.error(f"[WEBHOOK] Cannot process trial conversion - price_id {price_id} not recognized")
                                raise ValueError(f"Unrecognized price_id: {price_id}")
                            
                            await client.from_('credit_accounts').update({
                                'trial_status': 'converted',
                                'tier': tier_info.name,
                                'stripe_subscription_id': subscription['id']
                            }).eq('account_id', account_id).execute()
                            
                            await client.from_('trial_history').update({
                                'ended_at': datetime.now(timezone.utc).isoformat(),
                                'converted_to_paid': True
                            }).eq('account_id', account_id).is_('ended_at', 'null').execute()
                        
                        elif trial_status == 'cancelled' and subscription.status == 'active':
                            logger.info(f"[WEBHOOK] User {account_id} with cancelled trial is subscribing again")
                            tier_info = get_tier_by_price_id(price_id)
                            if not tier_info:
                                logger.error(f"[WEBHOOK] Cannot process cancelled trial resubscription - price_id {price_id} not recognized")
                                raise ValueError(f"Unrecognized price_id: {price_id}")
                            
                            billing_anchor = datetime.fromtimestamp(subscription['current_period_start'], tz=timezone.utc)
                            next_grant_date = datetime.fromtimestamp(subscription['current_period_end'], tz=timezone.utc)
                            
                            from decimal import Decimal
                            await credit_manager.add_credits(
                                account_id=account_id,
                                amount=Decimal(str(tier_info.monthly_credits)),
                                is_expiring=True,
                                description=f"Initial {tier_info.display_name} subscription credits",
                                expires_at=next_grant_date
                            )
                            
                            logger.info(f"[WEBHOOK] Granted {tier_info.monthly_credits} credits to {account_id} for new subscription after cancelled trial")
                            
                            await client.from_('credit_accounts').update({
                                'trial_status': 'none',
                                'tier': tier_info.name,
                                'stripe_subscription_id': subscription['id'],
                                'billing_cycle_anchor': billing_anchor.isoformat(),
                                'next_credit_grant': next_grant_date.isoformat(),
                                'last_grant_date': billing_anchor.isoformat()
                            }).eq('account_id', account_id).execute()
                
                if account_id and price_id and (
                    is_commitment_price_id(price_id) or 
                    commitment_type == 'yearly_commitment'
                ):
                    await self._track_commitment(account_id, price_id, subscription, client)
            
            previous_attributes = None
            if event.type == 'customer.subscription.updated':
                previous_attributes = event.data.get('previous_attributes', {})
                current_price_id = subscription['items']['data'][0]['price']['id'] if subscription.get('items') else None
                prev_price_id = previous_attributes.get('items', {}).get('data', [{}])[0].get('price', {}).get('id') if previous_attributes.get('items') else None
                
                prev_status = previous_attributes.get('status')
                current_status = subscription.get('status')
                
                account_id = subscription.get('metadata', {}).get('account_id')
                if not account_id:
                    customer_id = subscription.get('customer')
                    customer_result = await client.schema('basejump').from_('billing_customers')\
                        .select('account_id')\
                        .eq('id', customer_id)\
                        .execute()
                    if customer_result.data:
                        account_id = customer_result.data[0].get('account_id')
                
                if account_id and current_price_id and prev_price_id and current_price_id != prev_price_id:
                    check_scheduled = await client.from_('credit_accounts').select(
                        'scheduled_tier_change, scheduled_price_id, tier'
                    ).eq('account_id', account_id).execute()
                    
                    if check_scheduled.data:
                        scheduled_tier = check_scheduled.data[0].get('scheduled_tier_change')
                        scheduled_price_id = check_scheduled.data[0].get('scheduled_price_id')
                        current_db_tier = check_scheduled.data[0].get('tier')
                        
                        if scheduled_tier and scheduled_price_id and current_price_id == scheduled_price_id:
                            logger.info(f"[DOWNGRADE APPLIED] ✅ Stripe schedule changed price: {prev_price_id} → {current_price_id}")
                            logger.info(f"[DOWNGRADE APPLIED] Account: {account_id}, DB tier: {current_db_tier}, Target: {scheduled_tier}")
                            
                            lock_key = f"downgrade_tier_update:{account_id}:{current_price_id}"
                            tier_lock = DistributedLock(lock_key, timeout_seconds=30)
                            
                            acquired = await tier_lock.acquire(wait=True, wait_timeout=15)
                            if acquired:
                                try:
                                    logger.info(f"[DOWNGRADE APPLIED] 🔒 Acquired lock to update tier")
                                    
                                    recheck = await client.from_('credit_accounts').select(
                                        'scheduled_tier_change, scheduled_price_id, tier'
                                    ).eq('account_id', account_id).execute()
                                    
                                    if not recheck.data or not recheck.data[0].get('scheduled_price_id'):
                                        logger.info(f"[DOWNGRADE APPLIED] Already processed by another instance")
                                    elif recheck.data[0].get('scheduled_price_id') == scheduled_price_id:
                                        new_tier_info = get_tier_by_price_id(current_price_id)
                                        if new_tier_info:
                                            billing_anchor = datetime.fromtimestamp(subscription['current_period_start'], tz=timezone.utc)
                                            next_grant = datetime.fromtimestamp(subscription['current_period_end'], tz=timezone.utc)
                                            
                                            update_data = {
                                                'tier': new_tier_info.name,
                                                'scheduled_tier_change': None,
                                                'scheduled_tier_change_date': None,
                                                'scheduled_price_id': None,
                                                'billing_cycle_anchor': billing_anchor.isoformat(),
                                                'next_credit_grant': next_grant.isoformat()
                                            }
                                            
                                            if is_commitment_price_id(current_price_id):
                                                commitment_duration = get_commitment_duration_months(current_price_id)
                                                if commitment_duration > 0:
                                                    commitment_start = billing_anchor
                                                    commitment_end = commitment_start + timedelta(days=365) if commitment_duration == 12 else commitment_start + timedelta(days=commitment_duration * 30)
                                                    
                                                    update_data.update({
                                                        'commitment_type': 'yearly_commitment',
                                                        'commitment_start_date': commitment_start.isoformat(),
                                                        'commitment_end_date': commitment_end.isoformat(),
                                                        'commitment_price_id': current_price_id,
                                                        'can_cancel_after': commitment_end.isoformat()
                                                    })
                                                    
                                            try:
                                                user_check = await client.from_('users').select('id').eq('id', account_id).execute()
                                                if not user_check.data:
                                                    logger.warning(f"[DOWNGRADE APPLIED] User {account_id} not found, skipping commitment_history insert")
                                                else:
                                                    await client.from_('commitment_history').insert({
                                                        'account_id': account_id,
                                                        'commitment_type': 'yearly_commitment',
                                                        'price_id': current_price_id,
                                                        'start_date': commitment_start.isoformat(),
                                                        'end_date': commitment_end.isoformat(),
                                                        'stripe_subscription_id': subscription['id']
                                                    }).execute()
                                                    logger.info(f"[DOWNGRADE APPLIED] New tier has commitment - tracked in commitment_history until {commitment_end.date()}")
                                            except Exception as e:
                                                logger.warning(f"[DOWNGRADE APPLIED] Could not insert commitment_history (may already exist): {e}")
                                            else:
                                                update_data.update({
                                                    'commitment_type': None,
                                                    'commitment_start_date': None,
                                                    'commitment_end_date': None,
                                                    'commitment_price_id': None,
                                                    'can_cancel_after': None
                                                })
                                                logger.info(f"[DOWNGRADE APPLIED] New tier has no commitment - clearing commitment fields")
                                            
                                            await client.from_('credit_accounts').update(update_data).eq('account_id', account_id).execute()
                                            
                                            from core.utils.cache import Cache
                                            await Cache.invalidate(f"subscription_tier:{account_id}")
                                            
                                            logger.info(f"[DOWNGRADE APPLIED] ✅ Tier updated: {current_db_tier} → {new_tier_info.name}")
                                            logger.info(f"[DOWNGRADE APPLIED] Scheduled fields and commitment details updated")
                                finally:
                                    await tier_lock.release()
                
                if subscription.get('metadata', {}).get('downgrade') == 'true':
                    account_id = subscription.get('metadata', {}).get('account_id')
                    if not account_id:
                        customer_id = subscription.get('customer')
                        customer_result = await client.schema('basejump').from_('billing_customers')\
                            .select('account_id')\
                            .eq('id', customer_id)\
                            .execute()
                        if customer_result.data:
                            account_id = customer_result.data[0].get('account_id')
                    
                    if account_id:
                        logger.info(f"[DOWNGRADE] Downgrade metadata found for {account_id}")
                
                if current_price_id and prev_price_id and current_price_id == prev_price_id:
                    if not (prev_status == 'incomplete' and current_status == 'active'):
                        return
                    else:
                        logger.info(f"[WEBHOOK] Subscription {subscription['id']} changed from incomplete→active with same price_id, need to grant initial credits")
                        
                        account_id = subscription.get('metadata', {}).get('account_id')
                        if not account_id:
                            customer_id = subscription.get('customer')
                            customer_result = await client.schema('basejump').from_('billing_customers')\
                                .select('account_id')\
                                .eq('id', customer_id)\
                                .execute()
                            if customer_result.data:
                                account_id = customer_result.data[0].get('account_id')
                        
                        if account_id:
                            trial_check = await client.from_('credit_accounts').select(
                                'trial_status, tier'
                            ).eq('account_id', account_id).execute()
                            
                            if trial_check.data:
                                current_tier = trial_check.data[0].get('tier')
                                
                                if current_tier in ['free', 'none']:
                                    tier_info = get_tier_by_price_id(current_price_id)
                                    if not tier_info:
                                        logger.error(f"[WEBHOOK] Cannot process incomplete→active transition - price_id {current_price_id} not recognized")
                                        raise ValueError(f"Unrecognized price_id: {current_price_id}")
                                    
                                    billing_anchor = datetime.fromtimestamp(subscription['current_period_start'], tz=timezone.utc)
                                    next_grant_date = datetime.fromtimestamp(subscription['current_period_end'], tz=timezone.utc)
                                    
                                    logger.info(f"[WEBHOOK] User {account_id} upgrading from {current_tier} via incomplete→active transition to {tier_info.name}")
                                    
                                    from decimal import Decimal
                                    await credit_manager.add_credits(
                                        account_id=account_id,
                                        amount=Decimal(str(tier_info.monthly_credits)),
                                        is_expiring=True,
                                        description=f"Initial {tier_info.display_name} subscription credits (incomplete→active)",
                                        expires_at=next_grant_date
                                    )
                                    
                                    logger.info(f"[WEBHOOK] Granted {tier_info.monthly_credits} credits to {account_id} for incomplete→active upgrade")
                                    
                                    await client.from_('credit_accounts').update({
                                        'tier': tier_info.name,
                                        'stripe_subscription_id': subscription['id'],
                                        'billing_cycle_anchor': billing_anchor.isoformat(),
                                        'next_credit_grant': next_grant_date.isoformat(),
                                        'last_grant_date': billing_anchor.isoformat()
                                    }).eq('account_id', account_id).execute()
                                    
                                    return

                current_tier_info = get_tier_by_price_id(current_price_id) if current_price_id else None
                prev_tier_info = get_tier_by_price_id(prev_price_id) if prev_price_id else None
                
                is_tier_upgrade = (current_tier_info and prev_tier_info and 
                                 current_tier_info.name != prev_tier_info.name and
                                 float(current_tier_info.monthly_credits) > float(prev_tier_info.monthly_credits))
                
                if is_tier_upgrade:
                    logger.info(f"[WEBHOOK] Detected tier upgrade: {prev_tier_info.name} ({prev_tier_info.monthly_credits} credits) -> {current_tier_info.name} ({current_tier_info.monthly_credits} credits)")
                
                if not is_tier_upgrade:
                    try:
                        invoices = await StripeAPIWrapper.list_invoices(
                            subscription=subscription['id'],
                            limit=3
                        )
                        
                        for invoice in invoices.data:
                            if (invoice.get('period_start') == subscription.get('current_period_start') or
                                invoice.get('period_end') == subscription.get('current_period_end')):
                                
                                invoice_status = invoice.get('status')
                                if invoice_status in ['draft', 'open']:
                                    return
                                    
                    except Exception as e:
                        logger.error(f"[WEBHOOK ROUTING] Error checking invoices: {e}")
                
                if not is_tier_upgrade:
                    current_period_start = subscription.get('current_period_start')
                    if current_period_start:
                        now = datetime.now(timezone.utc).timestamp()
                        time_since_period = now - current_period_start
                        
                        is_incomplete_to_active = prev_status == 'incomplete' and current_status == 'active'
                        
                        if 0 <= time_since_period < 1800 and not is_incomplete_to_active:
                            return

                    if 'current_period_start' in previous_attributes:
                        prev_period = previous_attributes.get('current_period_start')
                        curr_period = subscription.get('current_period_start')
                        if prev_period != curr_period:
                            price_id = subscription['items']['data'][0]['price']['id'] if subscription.get('items') else None
                            if price_id and is_commitment_price_id(price_id):
                                account_id = subscription.metadata.get('account_id')
                                if account_id:
                                    await self._track_commitment(account_id, price_id, subscription, client)
                            if not is_tier_upgrade:
                                logger.info(f"[WEBHOOK] Period changed but not upgrade - returning early")
                                return
            
            from .subscription_service import subscription_service
            await subscription_service.handle_subscription_change(subscription, previous_attributes)
    
    async def _handle_subscription_updated(self, event, subscription, client):
        previous_attributes = event.data.get('previous_attributes', {})
        prev_status = previous_attributes.get('status')
        prev_default_payment = previous_attributes.get('default_payment_method')
        
        if prev_status == 'trialing' and subscription.status != 'trialing':
            logger.warning(f"[WEBHOOK] POTENTIAL TRIAL END DETECTED: {subscription['id']} - prev_status: {prev_status} → current_status: {subscription.status}")
            logger.warning(f"[WEBHOOK] Will verify if user is actually on trial before processing")
        
        price_id = subscription['items']['data'][0]['price']['id'] if subscription.get('items') else None
        prev_price_id = previous_attributes.get('items', {}).get('data', [{}])[0].get('price', {}).get('id') if previous_attributes.get('items') else None
        commitment_type = subscription.metadata.get('commitment_type')
        
        if price_id and (
            (price_id != prev_price_id and is_commitment_price_id(price_id)) or
            (commitment_type == 'yearly_commitment' and is_commitment_price_id(price_id))
        ):
            account_id = subscription.metadata.get('account_id')
            if account_id:
                await self._track_commitment(account_id, price_id, subscription, client)
        
        if subscription.status == 'trialing' and subscription.get('default_payment_method') and not prev_default_payment:
            account_id = subscription.metadata.get('account_id')
            if account_id:
                logger.info(f"[WEBHOOK] Payment method added to trial for account {account_id}")
                
                price_id = subscription['items']['data'][0]['price']['id'] if subscription.get('items') else None
                tier_info = get_tier_by_price_id(price_id)
                tier_name = tier_info.name if tier_info else 'tier_2_20'
                
                await client.from_('credit_accounts').update({
                    'trial_status': 'converted',
                    'tier': tier_name
                }).eq('account_id', account_id).execute()
                
                await client.from_('trial_history').update({
                    'converted_to_paid': True,
                    'ended_at': datetime.now(timezone.utc).isoformat()
                }).eq('account_id', account_id).is_('ended_at', 'null').execute()
                

        if prev_status == 'trialing' and subscription.status != 'trialing':
            account_id = subscription.metadata.get('account_id')
            
            if not account_id:
                customer_result = await client.schema('basejump').from_('billing_customers')\
                    .select('account_id')\
                    .eq('id', subscription['customer'])\
                    .execute()
                    
                if customer_result.data and customer_result.data[0].get('account_id'):
                    account_id = customer_result.data[0]['account_id']
                else:
                    return
            
            if account_id:
                current_account = await client.from_('credit_accounts').select(
                    'trial_status, tier, commitment_type'
                ).eq('account_id', account_id).execute()
                
                if not current_account.data:
                    return
                
                account_data = current_account.data[0]
                current_trial_status = account_data.get('trial_status')
                current_tier = account_data.get('tier')
                commitment_type = account_data.get('commitment_type')
                
                if current_trial_status not in ['active', 'converted']:
                    return
                
                if commitment_type or (current_trial_status == 'converted'):
                    return
                
                if subscription.status == 'active':
                    price_id = subscription['items']['data'][0]['price']['id']
                    tier_info = get_tier_by_price_id(price_id)
                    tier_name = tier_info.name if tier_info else 'tier_2_20'
                    
                    await client.from_('credit_accounts').update({
                        'trial_status': 'converted',
                        'tier': tier_name,
                        'stripe_subscription_id': subscription['id']
                    }).eq('account_id', account_id).execute()
                    
                    await client.from_('trial_history').update({
                        'ended_at': datetime.now(timezone.utc).isoformat(),
                        'converted_to_paid': True,
                        'status': 'converted'
                    }).eq('account_id', account_id).is_('ended_at', 'null').execute()
                    
                    
                elif subscription.status == 'canceled':
                    await client.from_('credit_accounts').update({
                        'trial_status': 'cancelled',
                        'tier': 'none',
                        'stripe_subscription_id': None
                    }).eq('account_id', account_id).execute()
                    
                    await client.from_('trial_history').update({
                        'ended_at': datetime.now(timezone.utc).isoformat(),
                        'converted_to_paid': False,
                        'status': 'cancelled'
                    }).eq('account_id', account_id).is_('ended_at', 'null').execute()
                    
                else:
                    await client.from_('credit_accounts').update({
                        'trial_status': 'expired',
                        'tier': 'none',
                        'balance': '0.00',
                        'stripe_subscription_id': None
                    }).eq('account_id', account_id).execute()
                    
                    await client.from_('trial_history').update({
                        'ended_at': datetime.now(timezone.utc).isoformat(),
                        'converted_to_paid': False,
                        'status': 'expired'
                    }).eq('account_id', account_id).is_('ended_at', 'null').execute()
                    
                    await client.from_('credit_ledger').insert({
                        'account_id': account_id,
                        'amount': -20.00,
                        'balance_after': 0.00,
                        'type': 'adjustment',
                        'description': 'Trial expired - all access removed'
                    }).execute()
    
    async def _handle_subscription_deleted(self, event, client):
        subscription = event.data.object
        account_id = subscription.get('metadata', {}).get('account_id')
        if not account_id:
            customer_result = await client.schema('basejump').from_('billing_customers').select('account_id').eq('id', subscription['customer']).execute()
            if customer_result.data:
                account_id = customer_result.data[0]['account_id']
        
        if not account_id:
            return
        
        customer_id = subscription.get('customer')
        if customer_id:
            try:
                active_subs = await self.stripe.Subscription.list_async(
                    customer=customer_id,
                    status='all',
                    limit=10
                )
                
                other_active_subs = [
                    sub for sub in active_subs.data 
                    if sub.id != subscription.id and sub.status in ['active', 'trialing', 'incomplete']
                ]
                
                if other_active_subs:
                    logger.info(f"[SUBSCRIPTION DELETED] User {account_id} has {len(other_active_subs)} other active subscriptions - skipping credit removal (likely an upgrade)")
                    logger.info(f"[SUBSCRIPTION DELETED] Other subscriptions: {[s.id for s in other_active_subs]}")
                    return
                else:
                    logger.info(f"[SUBSCRIPTION DELETED] No other active subscriptions found for {account_id} - proceeding with cancellation cleanup")
            except Exception as e:
                logger.error(f"[SUBSCRIPTION DELETED] Error checking for other subscriptions: {e}")
        
        current_account = await client.from_('credit_accounts').select(
            'trial_status, tier, commitment_type, balance, expiring_credits, non_expiring_credits, stripe_subscription_id, provider, revenuecat_subscription_id, revenuecat_product_id'
        ).eq('account_id', account_id).execute()
        
        if not current_account.data:
            return
        
        account_data = current_account.data[0]
        current_trial_status = account_data.get('trial_status')
        current_tier = account_data.get('tier')
        commitment_type = account_data.get('commitment_type')
        current_balance = account_data.get('balance', 0)
        expiring_credits = account_data.get('expiring_credits', 0)
        non_expiring_credits = account_data.get('non_expiring_credits', 0)
        current_subscription_id = account_data.get('stripe_subscription_id')
        provider = account_data.get('provider', 'stripe')
        revenuecat_subscription_id = account_data.get('revenuecat_subscription_id')
        revenuecat_product_id = account_data.get('revenuecat_product_id')
        
        if provider == 'revenuecat' or revenuecat_subscription_id or revenuecat_product_id:
            logger.info(
                f"[SUBSCRIPTION DELETED] Account {account_id} has switched to or is using RevenueCat "
                f"(provider={provider}, revenuecat_sub={revenuecat_subscription_id}, "
                f"revenuecat_product={revenuecat_product_id}) - skipping Stripe cleanup"
            )
            return
        
        if current_subscription_id and current_subscription_id != subscription.id:
            logger.info(f"[SUBSCRIPTION DELETED] Account {account_id} already has different subscription {current_subscription_id} - skipping cleanup")
            return
        
        if current_trial_status == 'active' and subscription.status == 'trialing':
            await client.from_('credit_accounts').update({
                'trial_status': 'cancelled',
                'tier': 'none',
                'balance': 0.00,
                'expiring_credits': 0.00,
                'non_expiring_credits': 0.00,
                'stripe_subscription_id': None
            }).eq('account_id', account_id).execute()
            
            await client.from_('credit_ledger').insert({
                'account_id': account_id,
                'amount': -current_balance,
                'balance_after': 0.00,
                'type': 'adjustment',
                'description': 'Trial cancelled - all credits removed'
            }).execute()
            
        elif current_trial_status == 'converted' or current_tier not in ['none', 'trial']:
            new_balance = float(non_expiring_credits)
            
            await client.from_('credit_accounts').update({
                'tier': 'none',
                'expiring_credits': 0.00,
                'balance': new_balance,
                'stripe_subscription_id': None
            }).eq('account_id', account_id).execute()
            
            if expiring_credits > 0:
                await client.from_('credit_ledger').insert({
                    'account_id': account_id,
                    'amount': -float(expiring_credits),
                    'balance_after': new_balance,
                    'type': 'adjustment',
                    'description': 'Subscription cancelled - expiring credits removed'
                }).execute()
            
        else:
            await client.from_('credit_accounts').update({
                'stripe_subscription_id': None
            }).eq('account_id', account_id).execute()
                
            await client.from_('trial_history').update({
                'ended_at': datetime.now(timezone.utc).isoformat(),
                'converted_to_paid': False
            }).eq('account_id', account_id).is_('ended_at', 'null').execute()
            
            await client.from_('credit_ledger').insert({
                'account_id': account_id,
                'amount': -20.00,
                'balance_after': 0.00,
                'type': 'adjustment',
                'description': 'Trial cancelled - all access removed'
            }).execute()
            
    
    async def _handle_invoice_payment_succeeded(self, event, client):
        invoice = event.data.object
        billing_reason = invoice.get('billing_reason')

        if invoice.get('lines', {}).get('data'):
            for line in invoice['lines']['data']:
                if 'Credit' in line.get('description', ''):
                    return

        if invoice.get('subscription'):
            if billing_reason in ['subscription_cycle', 'subscription_update', 'subscription_create']:
                await self.handle_subscription_renewal(invoice, event.id)
            else:
                await self.handle_subscription_renewal(invoice, event.id)

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

    
    async def handle_subscription_renewal(self, invoice: Dict, stripe_event_id: str = None):
        try:
            db = DBConnection()
            client = await db.client
            
            subscription_id = invoice.get('subscription')
            invoice_id = invoice.get('id')
            billing_reason = invoice.get('billing_reason')
            
            if not subscription_id or not invoice_id:
                return

            period_start = invoice.get('period_start')
            period_end = invoice.get('period_end')
            
            if not period_start or not period_end:
                return
            
            customer_result_early = await client.schema('basejump').from_('billing_customers')\
                .select('account_id')\
                .eq('id', invoice['customer'])\
                .execute()
            
            if not customer_result_early.data:
                logger.error(f"[RENEWAL] No account found for customer {invoice['customer']}")
                return
            
            account_id = customer_result_early.data[0]['account_id']
            
            guard_check = await client.rpc('check_renewal_already_processed', {
                'p_account_id': account_id,
                'p_period_start': period_start
            }).execute()
            
            if guard_check.data and guard_check.data.get('already_processed'):
                logger.info(
                    f"[RENEWAL GUARD] ⛔ Renewal already processed for {account_id} period {period_start} "
                    f"by {guard_check.data.get('processed_by')} at {guard_check.data.get('processed_at')}"
                )
                return
            
            lock = await RenewalLock.lock_renewal_processing(account_id, period_start)
            acquired = await lock.acquire(wait=True, wait_timeout=60)
            if not acquired:
                logger.error(f"[RENEWAL] Failed to acquire lock for {account_id} period {period_start}")
                return
            
            try:
                db_check = DBConnection()
                client_check = await db_check.client
                
                logger.debug(f"[RENEWAL] Starting renewal logic for account {account_id}, billing_reason={billing_reason}")
                
                is_prorated_upgrade = False
                has_full_cycle_charge = False
                
                if invoice.get('lines', {}).get('data'):
                    for line in invoice['lines']['data']:
                        if line.get('proration', False):
                            is_prorated_upgrade = True
                        
                        line_period_start = line.get('period', {}).get('start')
                        line_period_end = line.get('period', {}).get('end')
                        if line_period_start and line_period_end:
                            period_days = (line_period_end - line_period_start) / 86400
                            if period_days >= 28:
                                has_full_cycle_charge = True
                
                logger.debug(f"[RENEWAL] is_prorated={is_prorated_upgrade}, has_full_cycle={has_full_cycle_charge}")
                
                if billing_reason == 'subscription_cycle':
                    is_prorated_upgrade = False
                    has_full_cycle_charge = True
                    logger.debug(f"[RENEWAL] Billing reason is subscription_cycle, forcing has_full_cycle=True")
                    
                elif billing_reason == 'subscription_update':
                    logger.debug(f"[RENEWAL] Billing reason is subscription_update")
                    if is_prorated_upgrade:
                        customer_result = await client.schema('basejump').from_('billing_customers')\
                            .select('account_id')\
                            .eq('id', invoice['customer'])\
                            .execute()
                        
                        if not customer_result.data:
                            logger.debug(f"[RENEWAL] No customer data found, returning")
                            return
                        
                        account_id = customer_result.data[0]['account_id']
                        logger.info(f"[RENEWAL] Processing prorated upgrade for account {account_id}")
                        
                        subscription = await StripeAPIWrapper.retrieve_subscription(subscription_id)
                        price_id = subscription['items']['data'][0]['price']['id'] if subscription.get('items') else None
                        
                        if price_id:
                            tier_info = get_tier_by_price_id(price_id) 
                            existing_tier_result = await client.from_('credit_accounts').select('tier').eq('account_id', account_id).execute()
                            
                            if tier_info and existing_tier_result.data:
                                existing_tier_name = existing_tier_result.data[0].get('tier')
                                existing_tier = get_tier_by_name(existing_tier_name)
                                
                                if existing_tier and tier_info.name != existing_tier.name and float(tier_info.monthly_credits) > float(existing_tier.monthly_credits):
                                    await credit_manager.add_credits(
                                        account_id=account_id,
                                        amount=tier_info.monthly_credits,
                                        is_expiring=True,
                                        description=f"Upgrade to {tier_info.display_name} tier",
                                        stripe_event_id=stripe_event_id
                                    )
                                    
                                    await client.from_('credit_accounts').update({
                                        'tier': tier_info.name,
                                        'last_processed_invoice_id': invoice_id,
                                        'last_grant_date': datetime.fromtimestamp(period_start, tz=timezone.utc).isoformat()
                                    }).eq('account_id', account_id).execute()
                                    
                                    logger.info(f"[RENEWAL] Upgrade credits granted for prorated subscription_update")
                                    return
                        logger.debug(f"[RENEWAL] No price_id found, returning")
                        return
                    
                    if not has_full_cycle_charge:
                        logger.info(f"[RENEWAL] subscription_update without full cycle charge - skipping (likely mid-period change)")
                        return
                    
                    logger.info(f"[RENEWAL] subscription_update WITH full cycle charge detected - treating as renewal and continuing processing")
                
                logger.debug(f"[RENEWAL] Fetching account for customer {invoice.get('customer')}")
                
                customer_result = await client.schema('basejump').from_('billing_customers')\
                    .select('account_id')\
                    .eq('id', invoice['customer'])\
                    .execute()
                
                if not customer_result.data:
                    logger.warning(f"[RENEWAL] No account found for customer {invoice.get('customer')}")
                    return
                
                account_id = customer_result.data[0]['account_id']
                logger.debug(f"[RENEWAL] Found account {account_id}, continuing with renewal")
                
                account_result = await client.from_('credit_accounts')\
                    .select('tier, last_grant_date, next_credit_grant, billing_cycle_anchor, last_processed_invoice_id, trial_status, last_renewal_period_start')\
                    .eq('account_id', account_id)\
                    .execute()
                
                if not account_result.data:
                    logger.warning(f"[RENEWAL] No credit account found for {account_id}")
                    return
                
                account = account_result.data[0]
                tier = account['tier']
                trial_status = account.get('trial_status')
                period_start_dt = datetime.fromtimestamp(period_start, tz=timezone.utc)
                
                logger.debug(f"[RENEWAL] Account tier={tier}, trial_status={trial_status}, invoice_id={invoice_id}")
                
                if account.get('last_processed_invoice_id') == invoice_id:
                    logger.info(f"[RENEWAL] Invoice {invoice_id} already processed, skipping")
                    return
                
                subscription = await StripeAPIWrapper.retrieve_subscription(subscription_id)
                subscription_status = subscription.get('status')
                is_still_trialing = subscription_status == 'trialing'
                
                logger.debug(f"[RENEWAL] subscription_status={subscription_status}, trial_status={trial_status}, billing_reason={billing_reason}")
                
                if trial_status == 'active' and billing_reason == 'subscription_create' and is_still_trialing:
                    logger.debug(f"[RENEWAL] Trial + subscription_create + still trialing, updating invoice ID only")
                    await client.from_('credit_accounts').update({
                        'last_processed_invoice_id': invoice_id
                    }).eq('account_id', account_id).execute()
                    return
                
                if trial_status == 'active' and not is_still_trialing:
                    logger.info(f"[RENEWAL] Trial ended (subscription is {subscription_status}), will grant first paid period credits and mark trial as converted")
                    await client.from_('credit_accounts').update({
                        'trial_status': 'converted'
                    }).eq('account_id', account_id).execute()
                    await client.from_('trial_history').update({
                        'ended_at': datetime.now(timezone.utc).isoformat(),
                        'converted_to_paid': True
                    }).eq('account_id', account_id).is_('ended_at', 'null').execute()
                    trial_status = 'converted'
                    logger.info(f"[RENEWAL] Trial status updated to 'converted' for account {account_id}")
                
                price_id = subscription['items']['data'][0]['price']['id'] if subscription.get('items') and subscription['items']['data'] else None
                
                if not price_id:
                    logger.warning(f"[RENEWAL] No price_id from subscription, attempting to extract from invoice")
                    if invoice.get('lines', {}).get('data'):
                        for line in invoice['lines']['data']:
                            if line.get('price') and line.get('price', {}).get('id'):
                                price_id = line['price']['id']
                                logger.info(f"[RENEWAL] Found price_id from invoice line: {price_id}")
                                break
                
                if price_id:
                    tier_info = get_tier_by_price_id(price_id)
                    if tier_info:
                        tier = tier_info.name
                        logger.info(f"[RENEWAL] Updated tier from price_id {price_id}: {tier}")
                    else:
                        logger.error(f"[RENEWAL] Price ID {price_id} not recognized in tier configuration - cannot process invoice")
                        raise ValueError(f"Unrecognized price_id: {price_id}")
                else:
                    logger.error(f"[RENEWAL] Could not determine price_id from subscription or invoice - cannot process invoice")
                    raise ValueError("Could not determine price_id from subscription or invoice")
                
                if trial_status == 'cancelled' and billing_reason == 'subscription_create':
                    logger.info(f"[RENEWAL] Cancelled trial user subscribing - resetting trial status to 'none'")
                    trial_status = 'none'
                
                monthly_credits = get_monthly_credits(tier)
                logger.info(f"[RENEWAL] invoice_id={invoice_id}, billing_reason={billing_reason}, monthly_credits={monthly_credits}, tier={tier}")
                
                if monthly_credits <= 0:
                    logger.error(f"[RENEWAL] No credits configured for tier {tier} - cannot process invoice")
                    raise ValueError(f"No credits configured for tier: {tier}")
                
                is_true_renewal = billing_reason == 'subscription_cycle'
                is_initial_subscription = billing_reason == 'subscription_create'
                
                if is_initial_subscription:
                    last_grant = account.get('last_grant_date')
                    current_db_tier = account.get('tier')
                    
                    if last_grant and current_db_tier == tier:
                        last_grant_dt = datetime.fromisoformat(last_grant.replace('Z', '+00:00'))
                        seconds_since_grant = (datetime.now(timezone.utc) - last_grant_dt).total_seconds()
                        
                        if seconds_since_grant < 60:
                            logger.info(f"[INITIAL GRANT SKIP] Credits already granted {seconds_since_grant:.0f}s ago for tier {tier}, skipping duplicate grant")
                            update_data = {
                                'last_processed_invoice_id': invoice_id,
                                'tier': tier,
                                'stripe_subscription_id': subscription_id,
                                'billing_cycle_anchor': period_start_dt.isoformat(),
                                'next_credit_grant': datetime.fromtimestamp(period_end, tz=timezone.utc).isoformat()
                            }
                            if trial_status != account.get('trial_status'):
                                update_data['trial_status'] = trial_status
                            
                            logger.info(f"[INITIAL GRANT SKIP] Updating metadata for tier {tier}")
                            await client.from_('credit_accounts').update(update_data).eq('account_id', account_id).execute()
                            return
                    elif last_grant and current_db_tier != tier:
                        logger.info(f"[TIER CHANGE DETECTED] Last grant was for tier {current_db_tier}, but invoice is for tier {tier} - will grant credits for new tier")
                
                if is_true_renewal:
                    logger.info(f"[RENEWAL] Using atomic function to grant ${monthly_credits} credits for {account_id} (TRUE RENEWAL)")
                    result = await client.rpc('atomic_grant_renewal_credits', {
                        'p_account_id': account_id,
                        'p_period_start': period_start,
                        'p_period_end': period_end,
                        'p_credits': float(monthly_credits),
                        'p_processed_by': 'webhook_invoice',
                        'p_invoice_id': invoice_id,
                        'p_stripe_event_id': stripe_event_id
                    }).execute()
                else:
                    logger.info(f"[INITIAL GRANT] Granting ${monthly_credits} credits for {account_id} (billing_reason={billing_reason}, NOT a renewal - will not block future renewals)")
                    add_result = await credit_manager.add_credits(
                        account_id=account_id,
                        amount=Decimal(str(monthly_credits)),
                        is_expiring=True,
                        description=f"Initial subscription grant: {billing_reason}",
                        stripe_event_id=stripe_event_id
                    )
                    
                    update_data = {
                        'tier': tier,
                        'last_grant_date': datetime.fromtimestamp(period_start, tz=timezone.utc).isoformat(),
                        'next_credit_grant': datetime.fromtimestamp(period_end, tz=timezone.utc).isoformat(),
                        'last_processed_invoice_id': invoice_id,
                        'stripe_subscription_id': subscription_id,
                        'billing_cycle_anchor': datetime.fromtimestamp(subscription['current_period_start'], tz=timezone.utc).isoformat()
                    }
                    
                    if trial_status in ['cancelled', 'expired']:
                        update_data['trial_status'] = 'none'
                        logger.info(f"[RENEWAL] Resetting trial_status from {trial_status} to 'none'")
                    
                    await client.from_('credit_accounts').update(update_data).eq('account_id', account_id).execute()
                    
                    result = add_result
                
                if is_true_renewal and result and hasattr(result, 'data') and result.data:
                    data = result.data
                    credits_granted = data.get('credits_granted', monthly_credits)
                    expiring = data.get('expiring_credits', credits_granted)
                    non_expiring = data.get('non_expiring_credits', 0)
                    total = data.get('new_balance', credits_granted)
                    
                    logger.info(
                        f"[RENEWAL SUCCESS] ✅ Granted ${credits_granted} credits "
                        f"to {account_id}: Expiring=${expiring:.2f}, "
                        f"Non-expiring=${non_expiring:.2f}, "
                        f"Total=${total:.2f}"
                    )
                    
                    if trial_status == 'converted':
                        await client.from_('credit_accounts').update({
                            'trial_status': 'none'
                        }).eq('account_id', account_id).execute()
                    
                    await Cache.invalidate(f"credit_balance:{account_id}")
                    await Cache.invalidate(f"credit_summary:{account_id}")
                    await Cache.invalidate(f"subscription_tier:{account_id}")
                elif is_true_renewal and result and hasattr(result, 'data') and result.data and result.data.get('duplicate_prevented'):
                    logger.info(
                        f"[RENEWAL DEDUPE] ⛔ Duplicate renewal prevented for {account_id} period {period_start} "
                        f"(already processed by {result.data.get('processed_by')})"
                    )
                elif is_true_renewal:
                    error_msg = result.data.get('error', 'Unknown error') if (result and hasattr(result, 'data') and result.data) else 'No response from atomic function'
                    logger.error(f"[RENEWAL ERROR] Failed to grant credits for account {account_id}: {error_msg}")
                elif not is_true_renewal and result and result.get('success'):
                    logger.info(f"[INITIAL GRANT SUCCESS] ✅ Granted ${monthly_credits} initial subscription credits to {account_id}")
                    
                    await Cache.invalidate(f"credit_balance:{account_id}")
                    await Cache.invalidate(f"credit_summary:{account_id}")
                    await Cache.invalidate(f"subscription_tier:{account_id}")
            
            except Exception as e:
                logger.error(f"Error handling subscription renewal: {e}")
            
            finally:
                await lock.release()

        except Exception as e:
            logger.error(f"Outer error in handle_subscription_renewal: {e}")


    async def _track_commitment(self, account_id: str, price_id: str, subscription: Dict, client):
        commitment_duration = get_commitment_duration_months(price_id)
        if commitment_duration == 0:
            return
        
        existing_commitment = await client.from_('commitment_history').select('id').eq('stripe_subscription_id', subscription['id']).execute()
        if existing_commitment.data:
            return
        
        start_date = datetime.fromtimestamp(subscription['current_period_start'], tz=timezone.utc)
        end_date = start_date + timedelta(days=365)
        
        await client.from_('credit_accounts').update({
            'commitment_type': 'yearly_commitment',
            'commitment_start_date': start_date.isoformat(),
            'commitment_end_date': end_date.isoformat(),
            'commitment_price_id': price_id,
            'can_cancel_after': end_date.isoformat()
        }).eq('account_id', account_id).execute()
        
        try:
            user_check = await client.from_('users').select('id').eq('id', account_id).execute()
            if user_check.data:
                await client.from_('commitment_history').insert({
                    'account_id': account_id,
                    'commitment_type': 'yearly_commitment',
                    'price_id': price_id,
                    'start_date': start_date.isoformat(),
                    'end_date': end_date.isoformat(),
                    'stripe_subscription_id': subscription['id']
                }).execute()
            else:
                 logger.warning(f"[_track_commitment] User {account_id} not found, skipping commitment_history insert")
        except Exception as e:
            logger.warning(f"[_track_commitment] Could not insert commitment_history: {e}")

    async def _handle_invoice_payment_failed(self, event, client):
        invoice = event.data.object
        subscription_id = invoice.get('subscription')
        
        if not subscription_id:
            return
            
        try:
            subscription = await StripeAPIWrapper.retrieve_subscription(subscription_id)
            account_id = subscription.metadata.get('account_id')
            
            if not account_id:
                customer_result = await client.schema('basejump').from_('billing_customers')\
                    .select('account_id')\
                    .eq('id', subscription['customer'])\
                    .execute()
                
                if customer_result.data:
                    account_id = customer_result.data[0]['account_id']
            
            if account_id:
                try:
                    await client.from_('credit_accounts').update({
                        'payment_status': 'failed',
                        'last_payment_failure': datetime.now(timezone.utc).isoformat()
                    }).eq('account_id', account_id).execute()
                    logger.info(f"[WEBHOOK] Marked payment as failed for account {account_id}")
                except Exception as update_error:
                    logger.warning(f"[WEBHOOK] Could not update payment status (non-critical): {update_error}")
                
        except Exception as e:
            logger.error(f"[WEBHOOK] Error processing payment failure: {e}")

    async def _handle_trial_will_end(self, event, client):
        subscription = event.data.object
        account_id = subscription.metadata.get('account_id')
    
    async def _handle_subscription_schedule_event(self, event, client):
        schedule = event.data.object
        subscription_id = schedule.get('subscription')
        schedule_id = schedule.id
        
        logger.info(f"[SCHEDULE] Processing {event.type} for schedule {schedule_id}, subscription {subscription_id}")
        
        if event.type == 'subscription_schedule.completed':
            account_id = schedule.get('metadata', {}).get('account_id')
            scheduled_tier = schedule.get('metadata', {}).get('target_tier')
            
            if account_id and scheduled_tier and schedule.get('metadata', {}).get('downgrade') == 'true':
                logger.info(f"[SCHEDULE COMPLETED] Downgrade schedule completed for {account_id}")
                
                downgrade_lock_key = f"schedule_complete_cleanup:{account_id}:{schedule_id}"
                downgrade_lock = DistributedLock(downgrade_lock_key, timeout_seconds=30)
                
                acquired = await downgrade_lock.acquire(wait=True, wait_timeout=15)
                if acquired:
                    try:
                        logger.info(f"[SCHEDULE COMPLETED] 🔒 Acquired lock for cleanup")
                        
                        recheck = await client.from_('credit_accounts').select(
                            'scheduled_tier_change, tier'
                        ).eq('account_id', account_id).execute()
                        
                        if recheck.data and recheck.data[0].get('scheduled_tier_change'):
                            await client.from_('credit_accounts').update({
                                'scheduled_tier_change': None,
                                'scheduled_tier_change_date': None,
                                'scheduled_price_id': None
                            }).eq('account_id', account_id).execute()
                            
                            from core.utils.cache import Cache
                            await Cache.invalidate(f"subscription_tier:{account_id}")
                            
                            logger.info(f"[SCHEDULE COMPLETED] ✅ Cleared scheduled change fields for {account_id}")
                    finally:
                        await downgrade_lock.release()
        
        elif event.type == 'subscription_schedule.released':
            logger.info(f"[SCHEDULE RELEASED] Schedule {schedule_id} released (likely cancelled)")
    
    async def _handle_refund(self, event, client):
        refund_obj = event.data.object
        
        if event.type == 'charge.refunded':
            charge = refund_obj
            refund_id = charge.get('refunds', {}).get('data', [{}])[0].get('id') if charge.get('refunds') else None
            charge_id = charge.get('id')
            payment_intent_id = charge.get('payment_intent')
            amount_refunded = Decimal(str(charge.get('amount_refunded', 0))) / Decimal('100')
        else:
            payment_intent = refund_obj
            refund_id = payment_intent.get('charges', {}).get('data', [{}])[0].get('refunds', {}).get('data', [{}])[0].get('id')
            charge_id = payment_intent.get('charges', {}).get('data', [{}])[0].get('id')
            payment_intent_id = payment_intent.get('id')
            amount_refunded = Decimal(str(payment_intent.get('amount', 0))) / Decimal('100')
        
        if not refund_id or not charge_id:
            logger.error(f"[REFUND] Missing refund_id or charge_id in event {event.id}")
            return
        
        existing_refund = await client.from_('refund_history').select('id, status').eq(
            'stripe_refund_id', refund_id
        ).execute()
        
        if existing_refund.data:
            if existing_refund.data[0]['status'] == 'processed':
                logger.info(f"[REFUND] Refund {refund_id} already processed")
                return
        
        purchase_record = await client.from_('credit_purchases').select(
            'id, account_id, amount_dollars, status'
        ).eq('stripe_payment_intent_id', payment_intent_id).execute()
        
        if not purchase_record.data:
            logger.warning(f"[REFUND] No purchase found for payment_intent {payment_intent_id}")
            
            if not existing_refund.data:
                await client.from_('refund_history').insert({
                    'stripe_refund_id': refund_id,
                    'stripe_charge_id': charge_id,
                    'stripe_payment_intent_id': payment_intent_id,
                    'amount_refunded': float(amount_refunded),
                    'credits_deducted': 0,
                    'refund_reason': 'No associated purchase found',
                    'status': 'failed',
                    'error_message': 'Purchase record not found',
                    'account_id': '00000000-0000-0000-0000-000000000000',
                    'processed_at': datetime.now(timezone.utc).isoformat()
                }).execute()
            return
        
        purchase = purchase_record.data[0]
        account_id = purchase['account_id']
        credits_to_deduct = Decimal(str(purchase['amount_dollars']))
        
        try:
            if not existing_refund.data:
                await client.from_('refund_history').insert({
                    'account_id': account_id,
                    'stripe_refund_id': refund_id,
                    'stripe_charge_id': charge_id,
                    'stripe_payment_intent_id': payment_intent_id,
                    'amount_refunded': float(amount_refunded),
                    'credits_deducted': 0,
                    'status': 'pending',
                    'metadata': {'purchase_id': purchase['id']}
                }).execute()
            
            balance_info = await credit_manager.get_balance(account_id)
            current_balance = Decimal(str(balance_info['total']))
            
            if current_balance < credits_to_deduct:
                logger.warning(
                    f"[REFUND] Insufficient balance for full refund. "
                    f"Balance: ${current_balance}, Need: ${credits_to_deduct}"
                )
                credits_to_deduct = current_balance
            
            if credits_to_deduct > 0:
                result = await credit_manager.use_credits(
                    account_id=account_id,
                    amount=credits_to_deduct,
                    description=f"Refund deduction: {refund_id}",
                    thread_id=None,
                    message_id=None
                )
                
                if not result.get('success'):
                    logger.error(f"[REFUND] Failed to deduct credits: {result.get('error')}")
                    await client.from_('refund_history').update({
                        'status': 'failed',
                        'error_message': result.get('error'),
                        'processed_at': datetime.now(timezone.utc).isoformat()
                    }).eq('stripe_refund_id', refund_id).execute()
                    return
            
            await client.from_('credit_purchases').update({
                'status': 'refunded',
                'metadata': {'refund_id': refund_id, 'refund_processed_at': datetime.now(timezone.utc).isoformat()}
            }).eq('id', purchase['id']).execute()
            
            await client.from_('refund_history').update({
                'status': 'processed',
                'credits_deducted': float(credits_to_deduct),
                'processed_at': datetime.now(timezone.utc).isoformat()
            }).eq('stripe_refund_id', refund_id).execute()
            
            logger.info(
                f"[REFUND] Successfully processed refund {refund_id} for account {account_id}. "
                f"Deducted ${credits_to_deduct} credits"
            )
            
        except Exception as e:
            logger.error(f"[REFUND] Error processing refund {refund_id}: {e}")
            await client.from_('refund_history').update({
                'status': 'failed',
                'error_message': str(e),
                'processed_at': datetime.now(timezone.utc).isoformat()
            }).eq('stripe_refund_id', refund_id).execute()
        
webhook_service = WebhookService() 