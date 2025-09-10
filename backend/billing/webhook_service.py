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
            
            event = stripe.Webhook.construct_event(
                payload, sig_header, config.STRIPE_WEBHOOK_SECRET
            )
            
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
            
            elif event.type == 'invoice.payment_succeeded':
                await self._handle_invoice_payment_succeeded(event, client)
            
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
        account_id = session['metadata']['account_id']
        credit_amount = Decimal(session['metadata']['credit_amount'])
        
        current_state = await client.from_('credit_accounts').select(
            'balance, expiring_credits, non_expiring_credits'
        ).eq('account_id', account_id).execute()
        
        await client.table('credit_purchases').update({
            'status': 'completed',
            'completed_at': datetime.now(timezone.utc).isoformat()
        }).eq('stripe_payment_intent_id', session.payment_intent).execute()
        
        result = await credit_manager.add_credits(
            account_id=account_id,
            amount=credit_amount,
            is_expiring=False,
            description=f"Purchased ${credit_amount} credits"
        )
        
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

        if session.get('metadata', {}).get('converting_from_trial') == 'true':
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
        logger.info(f"[WEBHOOK] Subscription metadata: {subscription.get('metadata', {})}")
        
        if event.type == 'customer.subscription.updated':
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
            
            from .subscription_service import subscription_service
            await subscription_service.handle_subscription_change(subscription)
    
    async def _handle_subscription_updated(self, event, subscription, client):
        previous_attributes = event.data.get('previous_attributes', {})
        prev_status = previous_attributes.get('status')
        prev_default_payment = previous_attributes.get('default_payment_method')
        
        logger.info(f"[WEBHOOK] Subscription updated: id={subscription['id']}, "
                   f"status={subscription.status}, prev_status={prev_status}, "
                   f"has_payment={bool(subscription.get('default_payment_method'))}")
        logger.info(f"[WEBHOOK] Previous attributes: {previous_attributes}")
        logger.info(f"[WEBHOOK] Account ID from metadata: {subscription.metadata.get('account_id')}")
        
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
        
        # Handle trial end (transition from trialing to any other status)
        if prev_status == 'trialing' and subscription.status != 'trialing':
            account_id = subscription.metadata.get('account_id')
            
            # Fallback: try to get account_id from customer if not in metadata
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
                if subscription.status == 'active':
                    logger.info(f"[WEBHOOK] Trial converted to paid for account {account_id}")
                    
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
                        'converted_to_paid': True
                    }).eq('account_id', account_id).is_('ended_at', 'null').execute()
                    
                    logger.info(f"[WEBHOOK] Trial conversion completed for account {account_id} to tier {tier_name}, subscription: {subscription['id']}")
                    
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
                    logger.info(f"[WEBHOOK] Trial expired without conversion for account {account_id}, status: {subscription.status}")
                    
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
        if subscription.status in ['trialing', 'canceled']:
            account_id = subscription.get('metadata', {}).get('account_id')
            if not account_id:
                customer_result = await client.schema('basejump').from_('billing_customers').select('account_id').eq('id', subscription['customer']).execute()
                if customer_result.data:
                    account_id = customer_result.data[0]['account_id']
            
            if account_id:
                logger.info(f"[WEBHOOK] User {account_id} cancelled during trial - removing all access")
                
                await client.from_('credit_accounts').update({
                    'trial_status': 'expired',
                    'tier': 'none',
                    'balance': 0.00,
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
        
        if invoice.get('subscription') and billing_reason == 'subscription_cycle':
            logger.info(f"[WEBHOOK] Processing subscription renewal for subscription: {invoice['subscription']}")
            await self.handle_subscription_renewal(invoice)
        else:
            logger.info(f"[WEBHOOK] Skipping renewal handler for billing_reason: {billing_reason}")
    
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
        
        billing_anchor = datetime.fromtimestamp(subscription['current_period_start'], tz=timezone.utc)
        next_grant_date = datetime.fromtimestamp(subscription['current_period_end'], tz=timezone.utc)
        
        account_result = await client.from_('credit_accounts').select('tier, billing_cycle_anchor, stripe_subscription_id, trial_status, trial_started_at').eq('account_id', account_id).execute()
        
        if not account_result.data or len(account_result.data) == 0:
            logger.info(f"User {account_id} has no credit account, creating none tier account first")
            await client.from_('credit_accounts').insert({
                'account_id': account_id,
                'balance': 0,
                'tier': 'none'
            }).execute()
            account_result = await client.from_('credit_accounts').select('tier, billing_cycle_anchor, stripe_subscription_id, trial_status, trial_started_at').eq('account_id', account_id).execute()
        
        if account_result.data and len(account_result.data) > 0:
            account_data = account_result.data[0]
            current_tier_name = account_data.get('tier')
            existing_anchor = account_data.get('billing_cycle_anchor')
            old_subscription_id = account_data.get('stripe_subscription_id')
            trial_status = account_data.get('trial_status')
            trial_started_at = account_data.get('trial_started_at')

            if subscription.status == 'trialing':
                await self._handle_trial_subscription(subscription, account_id, new_tier, client)
                return
            elif subscription.status == 'active' and trial_status == 'active':
                logger.info(f"[TRIAL CONVERSION] User {account_id} upgrading from trial to {new_tier['name']}")
                
                current_balance_result = await client.from_('credit_accounts')\
                    .select('balance, expiring_credits, non_expiring_credits')\
                    .eq('account_id', account_id)\
                    .execute()
                
                old_balance = 0
                old_non_expiring = 0
                if current_balance_result.data:
                    old_balance = float(current_balance_result.data[0].get('balance', 0))
                    old_non_expiring = float(current_balance_result.data[0].get('non_expiring_credits', 0))
                    
                new_credits = Decimal(str(new_tier['credits']))
                new_total = float(new_credits) + old_non_expiring
                
                await client.from_('credit_accounts').update({
                    'trial_status': 'converted',
                    'converted_to_paid_at': datetime.now(timezone.utc).isoformat(),
                    'tier': new_tier['name'],
                    'balance': new_total,
                    'expiring_credits': float(new_credits),
                    'non_expiring_credits': old_non_expiring,
                    'stripe_subscription_id': subscription['id'],
                    'billing_cycle_anchor': billing_anchor.isoformat(),
                    'next_credit_grant': next_grant_date.isoformat()
                }).eq('account_id', account_id).execute()
                
                await client.from_('trial_history').update({
                    'ended_at': datetime.now(timezone.utc).isoformat(),
                    'converted_to_paid': True,
                    'conversion_tier': new_tier['name']
                }).eq('account_id', account_id).is_('ended_at', 'null').execute()
                
                credit_change = new_total - old_balance
                await client.from_('credit_ledger').insert({
                    'account_id': account_id,
                    'amount': credit_change,
                    'balance_after': new_total,
                    'type': 'grant',
                    'description': f"Trial converted to {new_tier['name']} - trial credits replaced with ${new_credits} tier credits"
                }).execute()
                
                logger.info(f"[TRIAL CONVERSION] Completed: ${old_balance} → ${new_total} (${new_credits} tier + ${old_non_expiring} purchased)")
                return

            current_tier_info = TIERS.get(current_tier_name)
            current_tier = None
            if current_tier_info:
                current_tier = {
                    'name': current_tier_info.name,
                    'credits': float(current_tier_info.monthly_credits)
                }
            
            should_grant_credits = self._should_grant_credits(current_tier_name, current_tier, new_tier, subscription, old_subscription_id)
            
            if should_grant_credits:
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

    async def handle_subscription_renewal(self, invoice: Dict):
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
            
            monthly_credits = get_monthly_credits(tier)
            if monthly_credits > 0:
                logger.info(f"💰 [RENEWAL] Processing subscription renewal for user {account_id}, tier={tier}, monthly_credits=${monthly_credits}")
                
                current_state = await client.from_('credit_accounts').select(
                    'balance, expiring_credits, non_expiring_credits'
                ).eq('account_id', account_id).execute()
                
                if current_state.data:
                    logger.info(f"[RENEWAL] State BEFORE renewal: {current_state.data[0]}")
                
                result = await credit_manager.reset_expiring_credits(
                    account_id=account_id,
                    new_credits=monthly_credits,
                    description=f"Monthly {tier} tier credits renewal"
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

                if trial_status == 'converted':
                    update_data['trial_status'] = 'none'
                    logger.info(f"[WEBHOOK] Clearing converted status for account {account_id}")
                
                await client.from_('credit_accounts').update(update_data).eq('account_id', account_id).execute()
                
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


webhook_service = WebhookService() 