from fastapi import HTTPException, Request
from typing import Dict
from decimal import Decimal
from datetime import datetime, timezone, timedelta
import stripe
from core.services.supabase import DBConnection
from core.utils.config import config
from core.utils.logger import logger
from core.utils.cache import Cache
from core.utils.distributed_lock import WebhookLock, RenewalLock
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
            raise HTTPException(status_code=400, detail=str(e))
    
    async def _handle_checkout_session_completed(self, event, client):
        session = event.data.object
        if session.get('metadata', {}).get('type') == 'credit_purchase':
            await self._handle_credit_purchase(session, client)
        elif session.get('subscription'):
            await self._handle_subscription_checkout(session, client)
    
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
                    update_result = await client.table('credit_purchases').update({
                        'status': 'completed',
                        'completed_at': datetime.now(timezone.utc).isoformat(),
                        'stripe_payment_intent_id': session.payment_intent
                    }).eq('stripe_checkout_session_id', session.id).execute()
            else:
                update_result = await client.table('credit_purchases').update({
                    'status': 'completed',
                    'completed_at': datetime.now(timezone.utc).isoformat()
                }).eq('stripe_checkout_session_id', session.id).execute()
            
            result = await credit_manager.add_credits(
                account_id=account_id,
                amount=credit_amount,
                is_expiring=False,
                description=f"Purchased ${credit_amount} credits"
            )
            
            if not result.get('success'):
                if session.payment_intent:
                    await client.table('credit_purchases').update({
                        'status': 'failed',
                        'error_message': 'Credit addition failed'
                    }).eq('stripe_payment_intent_id', session.payment_intent).execute()
                else:
                    await client.table('credit_purchases').update({
                        'status': 'failed',
                        'error_message': 'Credit addition failed'
                    }).eq('stripe_checkout_session_id', session.id).execute()
                
                return
        except Exception as e:
            try:
                if session.payment_intent:
                    await client.table('credit_purchases').update({
                        'status': 'failed',
                        'error_message': str(e)
                    }).eq('stripe_payment_intent_id', session.payment_intent).execute()
                else:
                    await client.table('credit_purchases').update({
                        'status': 'failed',
                        'error_message': str(e)
                    }).eq('stripe_checkout_session_id', session.id).execute()
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
        account_id = session.get('metadata', {}).get('account_id')
        if not account_id:
            customer_result = await client.schema('basejump').from_('billing_customers')\
                .select('account_id')\
                .eq('id', session.get('customer'))\
                .execute()
            if customer_result.data:
                account_id = customer_result.data[0].get('account_id')
        
        if account_id:
            trial_check = await client.from_('credit_accounts').select(
                'trial_status, tier, balance'
            ).eq('account_id', account_id).execute()
            
            if trial_check.data and trial_check.data[0].get('trial_status') == 'active':
                subscription_id = session.get('subscription')
                if subscription_id:
                    subscription = await stripe.Subscription.retrieve_async(subscription_id)
                    price_id = subscription['items']['data'][0]['price']['id'] if subscription.get('items') else None
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
                        

        elif session.get('metadata', {}).get('converting_from_trial') == 'true':
            account_id = session['metadata'].get('account_id')
            if session.get('subscription'):
                subscription_id = session['subscription']
                subscription = stripe.Subscription.retrieve(subscription_id, expand=['default_payment_method'])

                price_id = subscription['items']['data'][0]['price']['id'] if subscription.get('items') else None
                tier_info = get_tier_by_price_id(price_id)
                
                if not tier_info:
                    return
                
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
                    'converted_to_paid': True
                }).eq('account_id', account_id).is_('ended_at', 'null').execute()
                
                return

        if session.get('metadata', {}).get('trial_start') == 'true':
            account_id = session['metadata'].get('account_id')
            if session.get('subscription'):
                subscription_id = session['subscription']
                subscription = stripe.Subscription.retrieve(subscription_id, expand=['default_payment_method'])
                
                if subscription.status == 'trialing':
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
                        'stripe_checkout_session_id': session.get('id')
                    }, on_conflict='account_id').execute()
                    
                    logger.info(f"[WEBHOOK] Trial activated for account {account_id} via checkout.session.completed - granted ${TRIAL_CREDITS} credits")
                else:
                    logger.info(f"[WEBHOOK] Subscription status: {subscription.status}, not trialing")
    
    async def _handle_subscription_created_or_updated(self, event, client):
        subscription = event.data.object
        
        if event.type == 'customer.subscription.updated':
            previous_attributes = event.data.get('previous_attributes', {})
            await self._handle_subscription_updated(event, subscription, client)
        
        if subscription.status in ['active', 'trialing']:
            if subscription.status == 'trialing' and not subscription.get('metadata', {}).get('account_id'):
                customer_result = await client.schema('basejump').from_('billing_customers')\
                    .select('account_id')\
                    .eq('id', subscription['customer'])\
                    .execute()
                
                if customer_result.data and customer_result.data[0].get('account_id'):
                    account_id = customer_result.data[0]['account_id']
                    try:
                        await stripe.Subscription.modify_async(
                            subscription['id'],
                            metadata={'account_id': account_id, 'trial_start': 'true'}
                        )
                        subscription['metadata'] = {'account_id': account_id, 'trial_start': 'true'}
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
                        invoices = stripe.Invoice.list(
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
                        
                        if 0 <= time_since_period < 1800:
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
                        'converted_to_paid': True
                    }).eq('account_id', account_id).is_('ended_at', 'null').execute()
                    
                    
                elif subscription.status == 'canceled':
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
            return
        
        current_account = await client.from_('credit_accounts').select(
            'trial_status, tier, commitment_type, balance, expiring_credits, non_expiring_credits'
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
            
            lock = await RenewalLock.lock_renewal_processing(account_id, period_start)
            acquired = await lock.acquire(wait=True, wait_timeout=60)
            if not acquired:
                logger.error(f"[RENEWAL] Failed to acquire lock for {account_id} period {period_start}")
                return
            
            try:
                db_check = DBConnection()
                client_check = await db_check.client
                
                logger.info(f"[RENEWAL DEBUG] Starting renewal logic for account {account_id}, billing_reason={billing_reason}")
                
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
                
                logger.info(f"[RENEWAL DEBUG] is_prorated={is_prorated_upgrade}, has_full_cycle={has_full_cycle_charge}")
                
                if billing_reason == 'subscription_cycle':
                    is_prorated_upgrade = False
                    has_full_cycle_charge = True
                    logger.info(f"[RENEWAL DEBUG] Billing reason is subscription_cycle, forcing has_full_cycle=True")
                    
                elif billing_reason == 'subscription_update':
                    logger.info(f"[RENEWAL DEBUG] Billing reason is subscription_update")
                    if is_prorated_upgrade:
                        customer_result = await client.schema('basejump').from_('billing_customers')\
                            .select('account_id')\
                            .eq('id', invoice['customer'])\
                            .execute()
                        
                        if not customer_result.data:
                            logger.info(f"[RENEWAL DEBUG] No customer data found, returning")
                            return
                        
                        account_id = customer_result.data[0]['account_id']
                        logger.info(f"[RENEWAL DEBUG] Processing prorated upgrade for account {account_id}")
                        
                        subscription = await stripe.Subscription.retrieve_async(subscription_id)
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
                                    
                                    logger.info(f"[RENEWAL DEBUG] Upgrade credits granted, returning")
                                    return
                        logger.info(f"[RENEWAL DEBUG] No price_id found, returning")
                        return
                    if not has_full_cycle_charge:
                        logger.info(f"[RENEWAL DEBUG] Not full cycle charge, returning")
                        return
                    logger.info(f"[RENEWAL DEBUG] End of subscription_update block, returning")
                    return
                
                logger.info(f"[RENEWAL DEBUG] Fetching account for customer {invoice.get('customer')}")
                
                customer_result = await client.schema('basejump').from_('billing_customers')\
                    .select('account_id')\
                    .eq('id', invoice['customer'])\
                    .execute()
                
                if not customer_result.data:
                    logger.error(f"[RENEWAL DEBUG] No account found for customer {invoice.get('customer')}, RETURNING")
                    return
                
                account_id = customer_result.data[0]['account_id']
                logger.info(f"[RENEWAL DEBUG] Found account {account_id}, continuing with renewal")
                
                account_result = await client.from_('credit_accounts')\
                    .select('tier, last_grant_date, next_credit_grant, billing_cycle_anchor, last_processed_invoice_id, trial_status, last_renewal_period_start')\
                    .eq('account_id', account_id)\
                    .execute()
                
                if not account_result.data:
                    logger.error(f"[RENEWAL DEBUG] No credit account found for {account_id}, RETURNING")
                    return
                
                account = account_result.data[0]
                tier = account['tier']
                trial_status = account.get('trial_status')
                period_start_dt = datetime.fromtimestamp(period_start, tz=timezone.utc)
                
                logger.info(f"[RENEWAL DEBUG] Account tier={tier}, trial_status={trial_status}, invoice_id={invoice_id}")
                
                if account.get('last_processed_invoice_id') == invoice_id:
                    logger.warning(f"[RENEWAL DEBUG] Invoice {invoice_id} already processed, RETURNING")
                    return
                
                subscription = await stripe.Subscription.retrieve_async(subscription_id)
                subscription_status = subscription.get('status')
                is_still_trialing = subscription_status == 'trialing'
                
                logger.info(f"[RENEWAL DEBUG] subscription_status={subscription_status}, trial_status={trial_status}, billing_reason={billing_reason}")
                
                if trial_status == 'active' and billing_reason == 'subscription_create' and is_still_trialing:
                    logger.info(f"[RENEWAL DEBUG] Trial + subscription_create + still trialing, updating invoice ID and RETURNING")
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
                
                monthly_credits = get_monthly_credits(tier)
                logger.info(f"[RENEWAL] invoice_id={invoice_id}, billing_reason={billing_reason}, monthly_credits={monthly_credits}, tier={tier}")
                
                if monthly_credits <= 0:
                    logger.info(f"[RENEWAL] No credits to grant for tier {tier}, skipping")
                    await client.from_('credit_accounts').update({
                        'last_processed_invoice_id': invoice_id
                    }).eq('account_id', account_id).execute()
                    return
                
                result = await credit_manager.reset_expiring_credits(
                    account_id=account_id,
                    new_credits=monthly_credits,
                    description=f"Monthly {tier} tier credits",
                    stripe_event_id=stripe_event_id
                )
                
                if result['success']:
                    logger.info(f"[RENEWAL SUCCESS] Granted ${monthly_credits} credits: Expiring=${result['new_expiring']:.2f}, "
                               f"Non-expiring=${result['non_expiring']:.2f}, Total=${result['total_balance']:.2f}")
                    
                    update_data = {
                        'last_processed_invoice_id': invoice_id,
                        'last_grant_date': period_start_dt.isoformat(),
                        'next_credit_grant': datetime.fromtimestamp(period_end, tz=timezone.utc).isoformat()
                    }
                    
                    if trial_status == 'converted':
                        update_data['trial_status'] = 'none'
                    
                    await client.from_('credit_accounts').update(update_data).eq('account_id', account_id).execute()
                    
                    await Cache.invalidate(f"credit_balance:{account_id}")
                    await Cache.invalidate(f"credit_summary:{account_id}")
                    await Cache.invalidate(f"subscription_tier:{account_id}")
                else:
                    logger.error(f"[RENEWAL ERROR] Failed to grant credits for account {account_id}: {result}")
            
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
        
        await client.from_('commitment_history').insert({
            'account_id': account_id,
            'commitment_type': 'yearly_commitment',
            'price_id': price_id,
            'start_date': start_date.isoformat(),
            'end_date': end_date.isoformat(),
            'stripe_subscription_id': subscription['id']
        }).execute()

    async def _handle_invoice_payment_failed(self, event, client):
        invoice = event.data.object
        subscription_id = invoice.get('subscription')
        
        if not subscription_id:
            return
            
        try:
            subscription = await stripe.Subscription.retrieve_async(subscription_id)
            account_id = subscription.metadata.get('account_id')
            
            if not account_id:
                customer_result = await client.schema('basejump').from_('billing_customers')\
                    .select('account_id')\
                    .eq('id', subscription['customer'])\
                    .execute()
                
                if customer_result.data:
                    account_id = customer_result.data[0]['account_id']
            
            if account_id:
                await client.from_('credit_accounts').update({
                    'payment_status': 'failed',
                    'last_payment_failure': datetime.now(timezone.utc).isoformat()
                }).eq('account_id', account_id).execute()
                
        except Exception as e:
            logger.error(f"[WEBHOOK] Error processing payment failure: {e}")

    async def _handle_trial_will_end(self, event, client):
        subscription = event.data.object
        account_id = subscription.metadata.get('account_id')
    
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