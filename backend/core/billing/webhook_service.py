from fastapi import HTTPException, Request
from typing import Dict
from decimal import Decimal
from datetime import datetime, timezone, timedelta
import stripe
from core.services.supabase import DBConnection
from core.utils.config import config
from core.utils.logger import logger
from core.utils.cache import Cache
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


class WebhookService:
    def __init__(self):
        self.stripe = stripe
        
    async def process_stripe_webhook(self, request: Request) -> Dict:
        try:
            payload = await request.body()
            sig_header = request.headers.get('stripe-signature')
            

            logger.info(f"[WEBHOOK] Received webhook request, signature present: {bool(sig_header)}")
            if not config.STRIPE_WEBHOOK_SECRET:
                logger.error("[WEBHOOK] STRIPE_WEBHOOK_SECRET is not configured!")
                raise HTTPException(status_code=500, detail="Webhook secret not configured")
            
            # SECURITY: Validate webhook signature with tolerance
            try:
                event = stripe.Webhook.construct_event(
                    payload, sig_header, config.STRIPE_WEBHOOK_SECRET,
                    tolerance=300  # 5 minutes tolerance for timestamp
                )
            except stripe.error.SignatureVerificationError as e:
                logger.error(f"[WEBHOOK] Signature verification failed: {e}")
                raise HTTPException(status_code=400, detail="Invalid webhook signature")
            except ValueError as e:
                logger.error(f"[WEBHOOK] Invalid payload: {e}")
                raise HTTPException(status_code=400, detail="Invalid payload")
            
            logger.info(f"[WEBHOOK] Received event: type={event.type}, id={event.id}")
            db = DBConnection()
            client = await db.client
            
            cache_key = f"stripe_event:{event.id}"
            if await Cache.get(cache_key):
                logger.info(f"[WEBHOOK] Event {event.id} already processed, skipping")
                return {'status': 'success', 'message': 'Event already processed'}
            
            await Cache.set(cache_key, True, ttl=3600)
            
            if event.type == 'checkout.session.completed':
                await self._handle_checkout_session_completed(event, client)
            
            elif event.type in ['customer.subscription.created', 'customer.subscription.updated']:
                await self._handle_subscription_created_or_updated(event, client)
            
            elif event.type == 'customer.subscription.deleted':
                await self._handle_subscription_deleted(event, client)
            
            elif event.type in ['invoice.payment_succeeded', 'invoice_payment.paid']:
                await self._handle_invoice_payment_succeeded(event, client)
            
            elif event.type == 'invoice.payment_failed':
                await self._handle_invoice_payment_failed(event, client)
            
            elif event.type == 'customer.subscription.trial_will_end':
                await self._handle_trial_will_end(event, client)
            
            else:
                logger.info(f"[WEBHOOK] Unhandled event type: {event.type}")
            
            return {'status': 'success'}
        
        except Exception as e:
            logger.error(f"Webhook error: {e}")
            raise HTTPException(status_code=400, detail=str(e))
    
    async def _handle_checkout_session_completed(self, event, client):
        session = event.data.object
        if session.get('metadata', {}).get('type') == 'credit_purchase':
            await self._handle_credit_purchase(session, client)
        elif session.get('subscription'):
            await self._handle_subscription_checkout(session, client)
    
    async def _handle_credit_purchase(self, session, client):
        # SECURITY: Safe metadata access
        metadata = session.get('metadata', {})
        account_id = metadata.get('account_id')
        credit_amount_str = metadata.get('credit_amount')
        
        if not account_id or not credit_amount_str:
            logger.error(f"[WEBHOOK] Missing required metadata in credit purchase: account_id={account_id}, credit_amount={credit_amount_str}")
            return
            
        try:
            credit_amount = Decimal(credit_amount_str)
        except (ValueError, TypeError) as e:
            logger.error(f"[WEBHOOK] Invalid credit amount: {credit_amount_str}, error: {e}")
            return
        
        # SAFETY: Transaction-like behavior with rollback capability
        try:
            current_state = await client.from_('credit_accounts').select(
                'balance, expiring_credits, non_expiring_credits'
            ).eq('account_id', account_id).execute()
            
            # Update purchase status first
            await client.table('credit_purchases').update({
                'status': 'completed',
                'completed_at': datetime.now(timezone.utc).isoformat()
            }).eq('stripe_payment_intent_id', session.payment_intent).execute()
            
            # Add credits
            result = await credit_manager.add_credits(
                account_id=account_id,
                amount=credit_amount,
                is_expiring=False,
                description=f"Purchased ${credit_amount} credits"
            )
            
            if not result.get('success'):
                # Rollback purchase status on credit failure
                await client.table('credit_purchases').update({
                    'status': 'failed',
                    'error_message': 'Credit addition failed'
                }).eq('stripe_payment_intent_id', session.payment_intent).execute()
                
                logger.error(f"[WEBHOOK] Credit purchase failed for {account_id}: {result}")
                return
        except Exception as e:
            # Rollback on any failure
            logger.error(f"[WEBHOOK] Credit purchase transaction failed for {account_id}: {e}")
            try:
                await client.table('credit_purchases').update({
                    'status': 'failed',
                    'error_message': str(e)
                }).eq('stripe_payment_intent_id', session.payment_intent).execute()
            except:
                pass  # Don't fail the webhook if rollback fails
            return
        
        final_state = await client.from_('credit_accounts').select(
            'balance, expiring_credits, non_expiring_credits'
        ).eq('account_id', account_id).execute()
        
        if final_state.data:
            logger.info(f"[WEBHOOK] State AFTER purchase: {final_state.data[0]}")
            
            before = current_state.data[0] if current_state.data else {'balance': 0, 'expiring_credits': 0, 'non_expiring_credits': 0}
            after = final_state.data[0]
            
            expected_total = float(before['balance']) + float(credit_amount)
            actual_total = float(after['balance'])
            
            if abs(expected_total - actual_total) > 0.01:
                logger.error(f"[WEBHOOK] BALANCE MISMATCH! Expected ${expected_total}, got ${actual_total}")
                logger.error(f"[WEBHOOK] Before: {before}")
                logger.error(f"[WEBHOOK] After: {after}")
                logger.error(f"[WEBHOOK] Credit amount: ${credit_amount}")
    
    async def _handle_subscription_checkout(self, session, client):
        logger.info(f"[WEBHOOK] Checkout completed for new subscription: {session['subscription']}")
        logger.info(f"[WEBHOOK] Session metadata: {session.get('metadata', {})}")
        
        # First check if this is a trial user buying a subscription directly
        account_id = session.get('metadata', {}).get('account_id')
        if not account_id:
            # Try to get account from customer
            customer_result = await client.schema('basejump').from_('billing_customers')\
                .select('account_id')\
                .eq('id', session.get('customer'))\
                .execute()
            if customer_result.data:
                account_id = customer_result.data[0].get('account_id')
        
        if account_id:
            # Check if user is currently on trial
            trial_check = await client.from_('credit_accounts').select(
                'trial_status, tier, balance'
            ).eq('account_id', account_id).execute()
            
            if trial_check.data and trial_check.data[0].get('trial_status') == 'active':
                # Trial user purchasing subscription - convert the trial
                logger.info(f"[WEBHOOK] Converting trial to paid for {account_id} via checkout")
                
                subscription_id = session.get('subscription')
                if subscription_id:
                    subscription = await stripe.Subscription.retrieve_async(subscription_id)
                    price_id = subscription['items']['data'][0]['price']['id'] if subscription.get('items') else None
                    tier_info = get_tier_by_price_id(price_id)
                    
                    if tier_info:
                        # Update trial status to converted
                        await client.from_('credit_accounts').update({
                            'trial_status': 'converted',
                            'tier': tier_info.name,
                            'stripe_subscription_id': subscription['id']
                        }).eq('account_id', account_id).execute()
                        
                        # Update trial history
                        await client.from_('trial_history').update({
                            'ended_at': datetime.now(timezone.utc).isoformat(),
                            'converted_to_paid': True
                        }).eq('account_id', account_id).is_('ended_at', 'null').execute()
                        
                        logger.info(f"[WEBHOOK] Trial converted to {tier_info.name} for account {account_id}")
                        # Credits are already granted via subscription creation, no need to add more

        elif session.get('metadata', {}).get('converting_from_trial') == 'true':
            account_id = session['metadata'].get('account_id')
            logger.info(f"[WEBHOOK] Trial conversion detected for account {account_id}")
            
            if session.get('subscription'):
                subscription_id = session['subscription']
                subscription = stripe.Subscription.retrieve(subscription_id, expand=['default_payment_method'])

                price_id = subscription['items']['data'][0]['price']['id'] if subscription.get('items') else None
                tier_info = get_tier_by_price_id(price_id)
                
                if not tier_info:
                    logger.error(f"[WEBHOOK] No tier found for price_id {price_id}")
                    return
                
                tier_name = tier_info.name
                tier_credits = float(tier_info.monthly_credits)
                
                # Get current credit balance (preserve non-expiring credits from trial if any)
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
                
                # Update credit account to reflect conversion
                await client.from_('credit_accounts').update({
                    'trial_status': 'converted',
                    'converted_to_paid_at': datetime.now(timezone.utc).isoformat(),
                    'tier': tier_name,
                    'stripe_subscription_id': subscription['id'],
                    'billing_cycle_anchor': billing_anchor.isoformat(),
                    'next_credit_grant': next_grant_date.isoformat()
                }).eq('account_id', account_id).execute()
                
                # Grant the new tier's credits
                await credit_manager.add_credits(
                    account_id=account_id,
                    amount=Decimal(str(tier_credits)),
                    is_expiring=True,
                    description=f"Converted from trial to {tier_info.display_name} plan",
                    expires_at=expires_at
                )
                
                # Update trial history
                await client.from_('trial_history').update({
                    'ended_at': datetime.now(timezone.utc).isoformat(),
                    'converted_to_paid': True
                }).eq('account_id', account_id).is_('ended_at', 'null').execute()
                
                logger.info(f"[WEBHOOK] Successfully converted trial to paid for account {account_id}, tier: {tier_name}, credits: {tier_credits}")
                return

        if session.get('metadata', {}).get('trial_start') == 'true':
            account_id = session['metadata'].get('account_id')
            logger.info(f"[WEBHOOK] Trial checkout detected for account {account_id}")

            if session.get('subscription'):
                subscription_id = session['subscription']
                subscription = stripe.Subscription.retrieve(subscription_id, expand=['default_payment_method'])
                
                if subscription.status == 'trialing':
                    logger.info(f"[WEBHOOK] Trial subscription created for account {account_id}")

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
                    
                    logger.info(f"[WEBHOOK] Activated trial for account {account_id}, tier: {tier_name}")
                    
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
                        'stripe_checkout_session_id': session.get('id')
                    }, on_conflict='account_id').execute()
                    
                    logger.info(f"[WEBHOOK] Trial fully activated for account {account_id}")
                else:
                    logger.info(f"[WEBHOOK] Subscription status: {subscription.status}, not trialing")
    
    async def _handle_subscription_created_or_updated(self, event, client):
        subscription = event.data.object
        logger.info(f"[WEBHOOK] Subscription event: type={event.type}, status={subscription.status}")
        logger.info(f"[WEBHOOK] Subscription ID: {subscription['id']}, Customer: {subscription['customer']}")
        logger.info(f"[WEBHOOK] Current period: {subscription.get('current_period_start')} -> {subscription.get('current_period_end')}")
        logger.info(f"[WEBHOOK] Subscription metadata: {subscription.get('metadata', {})}")
        
        if event.type == 'customer.subscription.updated':
            previous_attributes = event.data.get('previous_attributes', {})
            if previous_attributes:
                logger.info(f"[WEBHOOK] Previous attributes: {previous_attributes}")
            await self._handle_subscription_updated(event, subscription, client)
        
        if subscription.status in ['active', 'trialing']:
            logger.info(f"[WEBHOOK] Processing subscription change for customer: {subscription['customer']}")
            
            if subscription.status == 'trialing' and not subscription.get('metadata', {}).get('account_id'):
                customer_result = await client.schema('basejump').from_('billing_customers')\
                    .select('account_id')\
                    .eq('id', subscription['customer'])\
                    .execute()
                
                if customer_result.data and customer_result.data[0].get('account_id'):
                    account_id = customer_result.data[0]['account_id']
                    logger.info(f"[WEBHOOK] Found account_id {account_id} for customer {subscription['customer']}")
                    try:
                        await stripe.Subscription.modify_async(
                            subscription['id'],
                            metadata={'account_id': account_id, 'trial_start': 'true'}
                        )
                        subscription['metadata'] = {'account_id': account_id, 'trial_start': 'true'}
                        logger.info(f"[WEBHOOK] Updated subscription metadata with account_id")
                    except Exception as e:
                        logger.error(f"[WEBHOOK] Failed to update subscription metadata: {e}")
            
            if event.type == 'customer.subscription.created':
                account_id = subscription.get('metadata', {}).get('account_id')
                price_id = subscription['items']['data'][0]['price']['id'] if subscription.get('items') else None
                commitment_type = subscription.get('metadata', {}).get('commitment_type')
                
                if not account_id:
                    customer_result = await client.schema('basejump').from_('billing_customers')\
                        .select('account_id')\
                        .eq('id', subscription['customer'])\
                        .execute()
                    if customer_result.data:
                        account_id = customer_result.data[0].get('account_id')
                
                if account_id:
                    trial_check = await client.from_('credit_accounts').select(
                        'trial_status, tier'
                    ).eq('account_id', account_id).execute()
                    
                    if trial_check.data and trial_check.data[0].get('trial_status') == 'active':
                        logger.info(f"[WEBHOOK] Trial user {account_id} purchasing subscription - converting trial")
                        
                        tier_info = get_tier_by_price_id(price_id)
                        if tier_info:
                            await client.from_('credit_accounts').update({
                                'trial_status': 'converted',
                                'tier': tier_info.name,
                                'stripe_subscription_id': subscription['id']
                            }).eq('account_id', account_id).execute()
                            
                            await client.from_('trial_history').update({
                                'ended_at': datetime.now(timezone.utc).isoformat(),
                                'converted_to_paid': True
                            }).eq('account_id', account_id).is_('ended_at', 'null').execute()
                            
                            await credit_manager.add_credits(
                                account_id=account_id,
                                amount=tier_info.monthly_credits,
                                is_expiring=True,
                                description=f"Subscription credits - {tier_info.display_name}",
                                stripe_event_id=event.id
                            )
                            
                            logger.info(f"[WEBHOOK] Trial converted: {account_id} -> {tier_info.name}, granted {tier_info.monthly_credits} credits")
                
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
                
                if current_price_id and prev_price_id and current_price_id == prev_price_id:
                    logger.warning(f"[WEBHOOK ROUTING] Same price ID {current_price_id} - this is a RENEWAL, not an upgrade")
                    logger.warning(f"[WEBHOOK ROUTING] Blocking ALL credit operations - invoice.payment_succeeded will handle credits")
                    return

                try:
                    invoices = stripe.Invoice.list(
                        subscription=subscription['id'],
                        limit=3
                    )
                    
                    for invoice in invoices.data:
                        if (invoice.get('period_start') == subscription.get('current_period_start') or
                            invoice.get('period_end') == subscription.get('current_period_end')):
                            
                            invoice_status = invoice.get('status')
                            if invoice_status in ['draft', 'open']:
                                logger.warning(f"[WEBHOOK ROUTING] Found {invoice_status} invoice {invoice['id']} for current period")
                                logger.warning(f"[WEBHOOK ROUTING] This is a RENEWAL waiting for payment - blocking credits")
                                logger.warning(f"[WEBHOOK ROUTING] Credits will be granted when invoice.payment_succeeded fires")
                                return
                                
                except Exception as e:
                    logger.error(f"[WEBHOOK ROUTING] Error checking invoices: {e}")
                
                current_period_start = subscription.get('current_period_start')
                if current_period_start:
                    now = datetime.now(timezone.utc).timestamp()
                    time_since_period = now - current_period_start
                    
                    if 0 <= time_since_period < 1800:
                        logger.warning(f"[WEBHOOK ROUTING] Only {time_since_period:.0f}s since period start - treating as RENEWAL")
                        logger.warning(f"[WEBHOOK ROUTING] Blocking subscription.updated from granting any credits")
                        return

                if 'current_period_start' in previous_attributes:
                    prev_period = previous_attributes.get('current_period_start')
                    curr_period = subscription.get('current_period_start')
                    if prev_period != curr_period:
                        logger.info(f"[WEBHOOK ROUTING] Period change detected - this is a RENEWAL")
                        logger.info(f"[WEBHOOK ROUTING] Skipping subscription_service.handle_subscription_change")
                        logger.info(f"[WEBHOOK ROUTING] Renewal credits will be handled by invoice.payment_succeeded webhook")
                        
                        price_id = subscription['items']['data'][0]['price']['id'] if subscription.get('items') else None
                        if price_id and is_commitment_price_id(price_id):
                            account_id = subscription.metadata.get('account_id')
                            if account_id:
                                await self._track_commitment(account_id, price_id, subscription, client)
                        return
            
            from .subscription_service import subscription_service
            await subscription_service.handle_subscription_change(subscription, previous_attributes)
    
    async def _handle_subscription_updated(self, event, subscription, client):
        previous_attributes = event.data.get('previous_attributes', {})
        prev_status = previous_attributes.get('status')
        prev_default_payment = previous_attributes.get('default_payment_method')
        
        logger.info(f"[WEBHOOK] Subscription updated: id={subscription['id']}, "
                   f"status={subscription.status}, prev_status={prev_status}, "
                   f"has_payment={bool(subscription.get('default_payment_method'))}")
        logger.info(f"[WEBHOOK] Previous attributes: {previous_attributes}")
        logger.info(f"[WEBHOOK] Account ID from metadata: {subscription.metadata.get('account_id')}")
        
        logger.info(f"[WEBHOOK] Full subscription metadata: {subscription.metadata}")
        
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
                
                logger.info(f"[WEBHOOK] Marked trial as converted (payment added) for account {account_id}, tier: {tier_name}")

        if prev_status == 'trialing' and subscription.status != 'trialing':
            account_id = subscription.metadata.get('account_id')
            
            if not account_id:
                logger.warning(f"[WEBHOOK] No account_id in subscription metadata, trying customer lookup")
                customer_result = await client.schema('basejump').from_('billing_customers')\
                    .select('account_id')\
                    .eq('id', subscription['customer'])\
                    .execute()
                    
                if customer_result.data and customer_result.data[0].get('account_id'):
                    account_id = customer_result.data[0]['account_id']
                    logger.info(f"[WEBHOOK] Found account_id {account_id} from customer {subscription['customer']}")
                else:
                    logger.error(f"[WEBHOOK] Could not find account for customer {subscription['customer']}")
                    return
            
            if account_id:
                current_account = await client.from_('credit_accounts').select(
                    'trial_status, tier, commitment_type'
                ).eq('account_id', account_id).execute()
                
                if not current_account.data:
                    logger.warning(f"[WEBHOOK] No credit account found for {account_id}, skipping trial end processing")
                    return
                
                account_data = current_account.data[0]
                current_trial_status = account_data.get('trial_status')
                current_tier = account_data.get('tier')
                commitment_type = account_data.get('commitment_type')
                
                if current_trial_status not in ['active', 'converted']:
                    logger.info(f"[WEBHOOK] Skipping trial end processing - user {account_id} not on active trial (status: {current_trial_status}, tier: {current_tier})")
                    return
                
                # Only block if user has commitment OR is already converted (not on trial)
                if commitment_type or (current_trial_status == 'converted'):
                    logger.warning(f"[WEBHOOK] SAFETY BLOCK: User already converted or has commitment {account_id} (trial_status: {current_trial_status}, commitment: {commitment_type})")
                    return
                
                if subscription.status == 'active':
                    logger.info(f"[WEBHOOK] Trial converted to paid for account {account_id}")
                    
                    price_id = subscription['items']['data'][0]['price']['id']
                    tier_info = get_tier_by_price_id(price_id)
                    tier_name = tier_info.name if tier_info else 'tier_2_20'
                    tier_credits = float(tier_info.monthly_credits) if tier_info else 20.0
                    
                    # Mark trial as converted
                    await client.from_('credit_accounts').update({
                        'trial_status': 'converted',
                        'tier': tier_name,
                        'stripe_subscription_id': subscription['id']
                    }).eq('account_id', account_id).execute()
                    
                    await client.from_('trial_history').update({
                        'ended_at': datetime.now(timezone.utc).isoformat(),
                        'converted_to_paid': True
                    }).eq('account_id', account_id).is_('ended_at', 'null').execute()
                    
                    # Grant first month's subscription credits (trial credits remain)
                    logger.info(f"[WEBHOOK] Granting first month credits ({tier_credits}) for converted trial user {account_id}")
                    await credit_manager.add_credits(
                        account_id=account_id,
                        amount=Decimal(str(tier_credits)),
                        is_expiring=True,
                        description=f"First month subscription credits - {tier_name}",
                        stripe_event_id=event.id if hasattr(event, 'id') else None
                    )
                    
                    logger.info(f"[WEBHOOK] Trial conversion completed for account {account_id} to tier {tier_name}, granted {tier_credits} credits")
                    
                elif subscription.status == 'canceled':
                    logger.info(f"[WEBHOOK] Trial cancelled for account {account_id}")
                    
                    await client.from_('credit_accounts').update({
                        'trial_status': 'cancelled',
                        'tier': 'none',
                        'stripe_subscription_id': None
                    }).eq('account_id', account_id).execute()
                    
                    await client.from_('trial_history').update({
                        'ended_at': datetime.now(timezone.utc).isoformat(),
                        'converted_to_paid': False
                    }).eq('account_id', account_id).is_('ended_at', 'null').execute()
                    
                else:
                    logger.warning(f"[WEBHOOK] Trial expired without conversion for account {account_id}, status: {subscription.status}")
                    logger.warning(f"[WEBHOOK] RESETTING CREDITS TO ZERO for account {account_id} - trial expired")
                    
                    await client.from_('credit_accounts').update({
                        'trial_status': 'expired',
                        'tier': 'none',
                        'balance': '0.00',
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
            logger.warning(f"[WEBHOOK] No account found for deleted subscription {subscription['id']}")
            return
        
        # Get current account state
        current_account = await client.from_('credit_accounts').select(
            'trial_status, tier, commitment_type, balance, expiring_credits, non_expiring_credits'
        ).eq('account_id', account_id).execute()
        
        if not current_account.data:
            logger.warning(f"[WEBHOOK] No credit account found for {account_id}, skipping subscription deletion processing")
            return
        
        account_data = current_account.data[0]
        current_trial_status = account_data.get('trial_status')
        current_tier = account_data.get('tier')
        commitment_type = account_data.get('commitment_type')
        current_balance = account_data.get('balance', 0)
        expiring_credits = account_data.get('expiring_credits', 0)
        non_expiring_credits = account_data.get('non_expiring_credits', 0)
        
        logger.info(f"[WEBHOOK] Processing subscription deletion for {account_id}: trial_status={current_trial_status}, tier={current_tier}, balance={current_balance}")
        
        if commitment_type:
            logger.warning(f"[WEBHOOK] User {account_id} has active commitment, subscription deletion may be end-of-commitment")

        if current_trial_status == 'active' and subscription.status == 'trialing':
            logger.warning(f"[WEBHOOK] Trial cancelled for {account_id} - removing all credits")
            
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
            logger.info(f"[WEBHOOK] Paid subscription cancelled for {account_id} - removing expiring credits, keeping non-expiring")
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
            
            logger.info(f"[WEBHOOK] Subscription cancellation complete: removed ${expiring_credits} expiring, kept ${non_expiring_credits} non-expiring")
        
        else:
            logger.warning(f"[WEBHOOK] Edge case subscription deletion for {account_id} - clearing subscription only")
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
            
            logger.info(f"[WEBHOOK] Successfully removed all access for account {account_id} after trial cancellation")
    
    async def _handle_invoice_payment_succeeded(self, event, client):
        invoice = event.data.object
        billing_reason = invoice.get('billing_reason')
        
        if invoice.get('lines', {}).get('data'):
            for line in invoice['lines']['data']:
                if 'Credit' in line.get('description', ''):
                    logger.info(f"[WEBHOOK] Skipping renewal - this is a credit purchase invoice")
                    return

        if invoice.get('subscription') and billing_reason in ['subscription_cycle', 'subscription_update']:
            logger.info(f"[WEBHOOK] Processing subscription renewal for subscription: {invoice['subscription']}, billing_reason: {billing_reason}")
            await self.handle_subscription_renewal(invoice, event.id)
        else:
            logger.info(f"[WEBHOOK] Skipping renewal handler for billing_reason: {billing_reason}")
    
    
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
    
    
    async def handle_subscription_renewal(self, invoice: Dict, stripe_event_id: str = None):
        try:
            db = DBConnection()
            client = await db.client
            
            subscription_id = invoice.get('subscription')
            invoice_id = invoice.get('id')
            
            if not subscription_id or not invoice_id:
                logger.warning(f"Invoice missing subscription or ID: {invoice}")
                return

            period_start = invoice.get('period_start')
            period_end = invoice.get('period_end')
            
            if not period_start or not period_end:
                logger.warning(f"Invoice missing period information: {invoice_id}")
                return
            
            customer_result = await client.schema('basejump').from_('billing_customers')\
                .select('account_id')\
                .eq('id', invoice['customer'])\
                .execute()
            
            if not customer_result.data:
                return
            
            account_id = customer_result.data[0]['account_id']
            
            account_result = await client.from_('credit_accounts')\
                .select('tier, last_grant_date, next_credit_grant, billing_cycle_anchor, last_processed_invoice_id, trial_status')\
                .eq('account_id', account_id)\
                .execute()
            
            if not account_result.data:
                return
            
            account = account_result.data[0]
            tier = account['tier']
            trial_status = account.get('trial_status')
            period_start_dt = datetime.fromtimestamp(period_start, tz=timezone.utc)
            
            if account.get('last_processed_invoice_id') == invoice_id:
                logger.info(f"[IDEMPOTENCY] Invoice {invoice_id} already processed for account {account_id}")
                return
                
            if account.get('last_grant_date') and trial_status != 'converted':
                last_grant = datetime.fromisoformat(account['last_grant_date'].replace('Z', '+00:00'))

                time_diff = abs((period_start_dt - last_grant).total_seconds())
                if time_diff < 300:
                    logger.info(f"[IDEMPOTENCY] Skipping renewal for user {account_id} - "
                              f"already processed at {account['last_grant_date']} "
                              f"(current period_start: {period_start_dt.isoformat()}, diff: {time_diff}s)")
                    return
            elif trial_status == 'converted':
                logger.info(f"[WEBHOOK] Processing first payment after trial conversion for account {account_id}")
            
            try:
                await client.from_('credit_accounts').update({
                    'last_renewal_period_start': period_start,
                    'last_processed_invoice_id': invoice_id,
                    'last_grant_date': period_start_dt.isoformat()
                }).eq('account_id', account_id).execute()
                logger.info(f"[RENEWAL] Marked period {period_start} as processed")
            except Exception as e:
                logger.warning(f"[RENEWAL] Could not update last_renewal_period_start: {e}")
                await client.from_('credit_accounts').update({
                    'last_processed_invoice_id': invoice_id,
                    'last_grant_date': period_start_dt.isoformat()
                }).eq('account_id', account_id).execute()
                logger.info(f"[RENEWAL] Updated last_grant_date as fallback tracking")
            
            monthly_credits = get_monthly_credits(tier)
            if monthly_credits > 0:
                logger.info(f"💰 [RENEWAL] Processing subscription renewal via invoice webhook for user {account_id}, tier={tier}, monthly_credits=${monthly_credits}")
                logger.info(f"[RENEWAL] Invoice ID: {invoice_id}, Subscription ID: {subscription_id}")
                logger.info(f"[RENEWAL] Period: {period_start} -> {period_end}")
                
                current_state = await client.from_('credit_accounts').select(
                    'balance, expiring_credits, non_expiring_credits'
                ).eq('account_id', account_id).execute()
                
                if current_state.data:
                    logger.info(f"[RENEWAL] State BEFORE renewal: {current_state.data[0]}")
                
                result = await credit_manager.reset_expiring_credits(
                    account_id=account_id,
                    new_credits=monthly_credits,
                    description=f"Monthly {tier} tier credits renewal",
                    stripe_event_id=stripe_event_id
                )
                
                if result['success']:
                    logger.info(f"[RENEWAL] Renewal complete: Expiring=${result['new_expiring']:.2f}, "
                               f"Non-expiring=${result['non_expiring']:.2f}, Total=${result['total_balance']:.2f}")
                
                next_grant = datetime.fromtimestamp(period_end, tz=timezone.utc)
                
                update_data = {
                    'last_grant_date': period_start_dt.isoformat(),
                    'next_credit_grant': next_grant.isoformat(),
                    'last_processed_invoice_id': invoice_id
                }
                
                # Try to add renewal tracking if column exists
                try:
                    update_data['last_renewal_period_start'] = period_start
                except:
                    pass

                if trial_status == 'converted':
                    update_data['trial_status'] = 'none'
                    logger.info(f"[WEBHOOK] Clearing converted status for account {account_id}")
                
                await client.from_('credit_accounts').update(update_data).eq('account_id', account_id).execute()
                
                logger.info(f"[RENEWAL] Updated credit_accounts with last_processed_invoice_id={invoice_id} and last_renewal_period_start={period_start}")
                
                final_state = await client.from_('credit_accounts').select(
                    'balance, expiring_credits, non_expiring_credits'
                ).eq('account_id', account_id).execute()
                
                if final_state.data:
                    logger.info(f"[RENEWAL] State AFTER renewal: {final_state.data[0]}")
                
                await Cache.invalidate(f"credit_balance:{account_id}")
                await Cache.invalidate(f"credit_summary:{account_id}")
                await Cache.invalidate(f"subscription_tier:{account_id}")
                
                logger.info(f"✅ [RENEWAL] Renewed credits for user {account_id}: ${monthly_credits} expiring + "
                           f"${result['non_expiring']:.2f} non-expiring = ${result['total_balance']:.2f} total")
        
        except Exception as e:
            logger.error(f"Error handling subscription renewal: {e}")


    async def _track_commitment(self, account_id: str, price_id: str, subscription: Dict, client):
        commitment_duration = get_commitment_duration_months(price_id)
        if commitment_duration == 0:
            return
        
        existing_commitment = await client.from_('commitment_history').select('id').eq('stripe_subscription_id', subscription['id']).execute()
        if existing_commitment.data:
            logger.info(f"[WEBHOOK COMMITMENT] Commitment already tracked for subscription {subscription['id']}, skipping")
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
        
        await client.from_('commitment_history').insert({
            'account_id': account_id,
            'commitment_type': 'yearly_commitment',
            'price_id': price_id,
            'start_date': start_date.isoformat(),
            'end_date': end_date.isoformat(),
            'stripe_subscription_id': subscription['id']
        }).execute()
        
        logger.info(f"[WEBHOOK COMMITMENT] Tracked yearly commitment for account {account_id}, subscription {subscription['id']}, ends {end_date.date()}")


    async def _handle_invoice_payment_failed(self, event, client):
        """Handle failed payment attempts - critical for subscription management"""
        invoice = event.data.object
        subscription_id = invoice.get('subscription')
        
        if not subscription_id:
            logger.warning(f"[WEBHOOK] Failed payment invoice {invoice['id']} has no subscription")
            return
            
        # Get account from subscription
        try:
            subscription = await stripe.Subscription.retrieve_async(subscription_id)
            account_id = subscription.metadata.get('account_id')
            
            if not account_id:
                # Fallback customer lookup
                customer_result = await client.schema('basejump').from_('billing_customers')\
                    .select('account_id')\
                    .eq('id', subscription['customer'])\
                    .execute()
                
                if customer_result.data:
                    account_id = customer_result.data[0]['account_id']
            
            if account_id:
                logger.warning(f"[WEBHOOK] Payment failed for account {account_id}, subscription {subscription_id}")
                
                # Mark potential service degradation
                await client.from_('credit_accounts').update({
                    'payment_status': 'failed',
                    'last_payment_failure': datetime.now(timezone.utc).isoformat()
                }).eq('account_id', account_id).execute()
                
        except Exception as e:
            logger.error(f"[WEBHOOK] Error processing payment failure: {e}")

    async def _handle_trial_will_end(self, event, client):
        """Handle trial ending notification"""
        subscription = event.data.object
        account_id = subscription.metadata.get('account_id')
        
        if account_id:
            logger.info(f"[WEBHOOK] Trial will end soon for account {account_id}")


webhook_service = WebhookService() 