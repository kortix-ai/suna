from decimal import Decimal
from datetime import datetime, timezone
import stripe
from dateutil.relativedelta import relativedelta # type: ignore

from core.utils.logger import logger
from core.utils.distributed_lock import DistributedLock
from core.billing.shared.config import (
    get_tier_by_price_id, 
    TRIAL_DURATION_DAYS,
    TRIAL_CREDITS,
    get_plan_type
)
from core.billing.credits.manager import credit_manager
from core.billing.external.stripe.client import StripeAPIWrapper

class CheckoutHandler:
    @staticmethod
    async def handle_checkout_session_completed(event, client):
        session = event.data.object
        logger.info(f"[WEBHOOK] Checkout session completed - ID: {session.get('id')}, Has subscription: {bool(session.get('subscription'))}, Metadata: {session.get('metadata', {})}")
        
        if session.get('metadata', {}).get('type') == 'credit_purchase':
            await CheckoutHandler._handle_credit_purchase(session, client)
        elif session.get('metadata', {}).get('type') == 'yearly_upgrade':
            await CheckoutHandler._handle_yearly_upgrade_payment(session, client)
        elif session.get('subscription'):
            logger.info(f"[WEBHOOK] Routing to subscription checkout handler")
            await CheckoutHandler._handle_subscription_checkout(session, client)
        else:
            logger.warning(f"[WEBHOOK] Checkout session has neither credit_purchase type nor subscription")

    @staticmethod
    async def _handle_credit_purchase(session, client):
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

    @staticmethod
    async def _handle_yearly_upgrade_payment(session, client):
        """Handle completed yearly upgrade payment and create new subscription"""
        metadata = session.get('metadata', {})
        account_id = metadata.get('account_id')
        target_price_id = metadata.get('target_price_id')
        
        if not account_id or not target_price_id:
            logger.error(f"[YEARLY UPGRADE] Missing required metadata: account_id={account_id}, target_price_id={target_price_id}")
            return
            
        logger.info(f"[YEARLY UPGRADE] Processing upgrade payment for {account_id} → {target_price_id}")
        
        try:
            # 1. Create the new yearly subscription
            customer_result = await client.schema('basejump').from_('billing_customers')\
                .select('id')\
                .eq('account_id', account_id)\
                .execute()
            
            if not customer_result.data:
                logger.error(f"[YEARLY UPGRADE] No customer found for account {account_id}")
                return
                
            customer_id = customer_result.data[0]['id']
            
            new_subscription = await StripeAPIWrapper.safe_stripe_call(
                stripe.Subscription.create_async,
                customer=customer_id,
                items=[{'price': target_price_id}],
                metadata={
                    'account_id': account_id,
                    'yearly_upgrade': 'true',
                    'upgrade_payment_session': session.get('id'),
                    'upgrade_amount_paid': metadata.get('upgrade_amount', '0')
                }
            )
            
            logger.info(f"[YEARLY UPGRADE] Created new subscription {new_subscription.id} for {account_id}")
            
            # 2. Update local state
            from ....subscriptions.handlers.lifecycle import SubscriptionLifecycleHandler
            await SubscriptionLifecycleHandler.handle_subscription_change(new_subscription)
            
            # 3. Clear pending upgrade fields
            await client.from_('credit_accounts').update({
                'pending_yearly_upgrade': None,
                'pending_upgrade_amount': None,
                'upgrade_effective_date': None
            }).eq('account_id', account_id).execute()
            
            logger.info(f"[YEARLY UPGRADE] ✅ Successfully completed yearly upgrade for {account_id}")
            
        except Exception as e:
            logger.error(f"[YEARLY UPGRADE] Error processing upgrade payment: {e}")
            # Mark the upgrade as failed
            await client.from_('credit_accounts').update({
                'pending_yearly_upgrade': None,
                'pending_upgrade_amount': None,
                'upgrade_effective_date': None
            }).eq('account_id', account_id).execute()

    @staticmethod
    async def _handle_subscription_checkout(session, client):
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
                    
                    # Invalidate account-state cache to refresh subscription and limits
                    from core.billing.shared.cache_utils import invalidate_account_state_cache
                    await invalidate_account_state_cache(account_id)
                    
                    return

        logger.info(f"[WEBHOOK CHECKOUT] Checking converting_from_trial metadata: {session.get('metadata', {}).get('converting_from_trial')}")
        if session.get('metadata', {}).get('converting_from_trial') == 'true':
            await CheckoutHandler._handle_trial_conversion_webhook(session, client)
            return

        logger.info(f"[WEBHOOK CHECKOUT] Checking trial_start metadata: {session.get('metadata', {}).get('trial_start')}")
        if session.get('metadata', {}).get('trial_start') == 'true':
            await CheckoutHandler._handle_trial_start_webhook(session, client)
            return

        logger.info(f"[WEBHOOK CHECKOUT] Reached default handler section. Has subscription: {bool(session.get('subscription'))}")
        if session.get('subscription'):
            await CheckoutHandler._handle_default_subscription_webhook(session, client)

    @staticmethod
    async def _handle_trial_conversion_webhook(session, client):
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
                
                plan_type = get_plan_type(price_id)
                
                if plan_type == 'yearly':
                    next_grant_date = billing_anchor + relativedelta(months=1)
                    logger.info(f"[WEBHOOK TRIAL CONVERSION] Yearly plan detected - setting next_credit_grant to 1 month from now: {next_grant_date}")
                
                expires_at = next_grant_date
                
                await client.from_('credit_accounts').update({
                    'trial_status': 'converted',
                    'converted_to_paid_at': datetime.now(timezone.utc).isoformat(),
                    'tier': tier_name,
                    'plan_type': plan_type,
                    'stripe_subscription_id': subscription['id'],
                    'stripe_subscription_status': subscription.get('status', 'active'),
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
                
                await CheckoutHandler._cleanup_duplicate_subscriptions(
                    session.get('customer'), subscription['id'], account_id
                )
                
                # Cancel old subscription if this was a trial conversion via checkout
                cancel_after_checkout = subscription.get('metadata', {}).get('cancel_after_checkout')
                if cancel_after_checkout:
                    logger.info(f"[TRIAL CONVERSION] Cancelling old subscription {cancel_after_checkout} after checkout completion")
                    try:
                        await StripeAPIWrapper.cancel_subscription(cancel_after_checkout, cancel_immediately=True)
                        logger.info(f"[TRIAL CONVERSION] ✅ Successfully cancelled old subscription {cancel_after_checkout}")
                    except Exception as e:
                        logger.warning(f"[TRIAL CONVERSION] Could not cancel old subscription {cancel_after_checkout}: {e}")
                
                # Invalidate account-state cache to refresh subscription and limits
                from core.billing.shared.cache_utils import invalidate_account_state_cache
                await invalidate_account_state_cache(account_id)
                
                logger.info(f"[TRIAL CONVERSION] ✅ Completed trial conversion for {account_id}")
            finally:
                await lock.release()

    @staticmethod
    async def _handle_trial_start_webhook(session, client):
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
                    
                    # Cancel old subscription if any was marked for cancellation
                    cancel_after_checkout = subscription.get('metadata', {}).get('cancel_after_checkout')
                    if cancel_after_checkout:
                        logger.info(f"[WEBHOOK] Cancelling old subscription {cancel_after_checkout} after trial start")
                        try:
                            await StripeAPIWrapper.cancel_subscription(cancel_after_checkout, cancel_immediately=True)
                            logger.info(f"[WEBHOOK] ✅ Successfully cancelled old subscription {cancel_after_checkout}")
                        except Exception as e:
                            logger.warning(f"[WEBHOOK] Could not cancel old subscription {cancel_after_checkout}: {e}")
                    
                    # Invalidate account-state cache
                    from core.billing.shared.cache_utils import invalidate_account_state_cache
                    await invalidate_account_state_cache(account_id)
                    
                    logger.info(f"[WEBHOOK] ✅ Trial activated for account {account_id} via checkout.session.completed - granted ${TRIAL_CREDITS} credits")
                finally:
                    await lock.release()
            else:
                logger.info(f"[WEBHOOK] Subscription status: {subscription.status}, not trialing")

    @staticmethod
    async def _handle_default_subscription_webhook(session, client):
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
                current_subscription_id = current.get('stripe_subscription_id')
                
                # Check if this is an upgrade via checkout (old subscription was cancelled, new one created)
                upgrade_from_subscription = session.get('metadata', {}).get('upgrade_from_subscription')
                if upgrade_from_subscription and current_subscription_id == upgrade_from_subscription:
                    logger.info(f"[WEBHOOK DEFAULT] Processing upgrade via checkout: {upgrade_from_subscription} -> {subscription_id}")
                    # This is an upgrade - proceed with processing
                elif current_subscription_id == subscription_id and current.get('tier') == tier_info.name:
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
                
                plan_type = get_plan_type(price_id)
                
                if plan_type == 'yearly':
                    next_grant_date = billing_anchor + relativedelta(months=1)
                    logger.info(f"[WEBHOOK DEFAULT] Yearly plan detected - setting next_credit_grant to 1 month from now: {next_grant_date}")
                elif plan_type == 'yearly_commitment':
                    next_grant_date = datetime.fromtimestamp(subscription['current_period_end'], tz=timezone.utc)
                    logger.info(f"[WEBHOOK DEFAULT] Yearly commitment detected - setting next_credit_grant to period end: {next_grant_date}")
                else:
                    next_grant_date = datetime.fromtimestamp(subscription['current_period_end'], tz=timezone.utc)
                    logger.info(f"[WEBHOOK DEFAULT] Monthly plan - setting next_credit_grant to period end: {next_grant_date}")
             
                current_tier = credit_account.data[0].get('tier') if credit_account.data else 'none'
                is_tier_upgrade = (current_tier and current_tier != 'none' and 
                                  current_tier != tier_info.name)
                
                if is_tier_upgrade:
                    if not tier_info.monthly_refill_enabled or (tier_info.daily_credit_config and tier_info.daily_credit_config.get('enabled')):
                        logger.info(f"[WEBHOOK DEFAULT] Skipping upgrade credits for tier {tier_info.name} - monthly_refill_enabled=False")
                    else:
                        logger.info(f"[WEBHOOK DEFAULT] Tier upgrade detected: {current_tier} -> {tier_info.name}")
                        logger.info(f"[WEBHOOK DEFAULT] Replacing existing credits with ${tier_info.monthly_credits} for {tier_info.name} (Stripe handled payment proration)")
                        
                        import time
                        unique_id = f"checkout_upgrade_{account_id}_{tier_info.name}_{int(time.time())}"
                        
                        await credit_manager.reset_expiring_credits(
                            account_id=account_id,
                            new_credits=Decimal(str(tier_info.monthly_credits)),
                            description=f"Tier upgrade to {tier_info.display_name} (prorated by Stripe)",
                            stripe_event_id=unique_id
                        )
                else:
                    if not tier_info.monthly_refill_enabled or (tier_info.daily_credit_config and tier_info.daily_credit_config.get('enabled')):
                        logger.info(f"[WEBHOOK DEFAULT] Skipping initial credits for tier {tier_info.name} - monthly_refill_enabled=False (using daily credits)")
                    else:
                        logger.info(f"[WEBHOOK DEFAULT] Granting ${tier_info.monthly_credits} credits for new {plan_type} subscription")
                        
                        await credit_manager.add_credits(
                            account_id=account_id,
                            amount=Decimal(str(tier_info.monthly_credits)),
                            is_expiring=True,
                            description=f"Initial {tier_info.display_name} subscription credits (checkout.session.completed)",
                            expires_at=next_grant_date,
                            stripe_event_id=f"checkout_{account_id}_{subscription['id']}"
                        )
                
                logger.info(f"[WEBHOOK DEFAULT] Granted {tier_info.monthly_credits} credits to {account_id}")
                
                update_data = {
                    'tier': tier_info.name,
                    'plan_type': plan_type,
                    'stripe_subscription_id': subscription['id'],
                    'stripe_subscription_status': subscription.get('status', 'active'),
                    'billing_cycle_anchor': billing_anchor.isoformat(),
                    'next_credit_grant': next_grant_date.isoformat(),
                    'last_grant_date': billing_anchor.isoformat(),
                    'last_processed_invoice_id': f"checkout_processed_{subscription['id']}"  # Mark to prevent invoice duplication
                }
                
                if credit_account.data and credit_account.data[0].get('trial_status') == 'cancelled':
                    update_data['trial_status'] = 'none'
                
                await client.from_('credit_accounts').update(update_data).eq('account_id', account_id).execute()
                
                # Invalidate account-state cache to refresh subscription and limits
                from core.billing.shared.cache_utils import invalidate_account_state_cache
                await invalidate_account_state_cache(account_id)
                
                if subscription.get('metadata', {}).get('requires_cleanup') == 'true':
                    logger.info(f"[WEBHOOK] Cleanup required for account {account_id}, removing duplicate subscriptions")
                    await CheckoutHandler._cleanup_duplicate_subscriptions(
                        session.get('customer'), subscription_id, account_id
                    )
                
                # Cancel old subscription if this was a trial/free tier conversion
                cancel_after_checkout = subscription.get('metadata', {}).get('cancel_after_checkout')
                if cancel_after_checkout:
                    logger.info(f"[WEBHOOK DEFAULT] Cancelling old subscription {cancel_after_checkout} after checkout completion")
                    try:
                        from core.billing.external.stripe import StripeAPIWrapper
                        await StripeAPIWrapper.cancel_subscription(cancel_after_checkout, cancel_immediately=True)
                        logger.info(f"[WEBHOOK DEFAULT] ✅ Successfully cancelled old subscription {cancel_after_checkout}")
                    except Exception as e:
                        logger.warning(f"[WEBHOOK DEFAULT] Could not cancel old subscription {cancel_after_checkout}: {e}")
            finally:
                await lock.release()

    @staticmethod
    async def _cleanup_duplicate_subscriptions(customer_id: str, keep_subscription_id: str, account_id: str):
        try:
            logger.info(f"[WEBHOOK CLEANUP] Checking for duplicate subscriptions for customer {customer_id}")
            
            customer_subs = await StripeAPIWrapper.safe_stripe_call(
                stripe.Subscription.list_async,
                customer=customer_id,
                status='active',
                limit=20
            )
            
            duplicates_found = []
            for sub in customer_subs.data:
                if sub.id != keep_subscription_id:
                    logger.info(f"[WEBHOOK CLEANUP] Found duplicate subscription {sub.id}, canceling...")
                    try:
                        await StripeAPIWrapper.safe_stripe_call(
                            stripe.Subscription.cancel_async,
                            sub.id,
                            prorate=True
                        )
                        duplicates_found.append(sub.id)
                        logger.info(f"[WEBHOOK CLEANUP] ✅ Canceled duplicate subscription {sub.id}")
                    except Exception as e:
                        logger.error(f"[WEBHOOK CLEANUP] Failed to cancel duplicate subscription {sub.id}: {e}")
            
            if duplicates_found:
                logger.info(f"[WEBHOOK CLEANUP] Cleaned up {len(duplicates_found)} duplicate subscriptions for {account_id}")
            else:
                logger.info(f"[WEBHOOK CLEANUP] No duplicate subscriptions found for {account_id}")
                
        except Exception as e:
            logger.error(f"[WEBHOOK CLEANUP] Error during subscription cleanup for {account_id}: {e}")