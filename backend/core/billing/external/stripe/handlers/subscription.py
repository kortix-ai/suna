from fastapi import HTTPException, Request
from typing import Dict
from decimal import Decimal
from datetime import datetime, timezone, timedelta
import stripe
from dateutil.relativedelta import relativedelta

from core.services.supabase import DBConnection
from core.utils.config import config
from core.utils.logger import logger
from core.utils.cache import Cache
from core.utils.distributed_lock import WebhookLock, RenewalLock, DistributedLock
from core.billing.shared.config import (
    get_tier_by_price_id, 
    get_tier_by_name,
    TIERS, 
    get_monthly_credits,
    TRIAL_DURATION_DAYS,
    TRIAL_CREDITS,
    is_commitment_price_id,
    get_commitment_duration_months,
    get_plan_type
)
from core.billing.credits.manager import credit_manager
from core.billing.external.stripe.client import StripeAPIWrapper

class SubscriptionHandler:
    @staticmethod
    async def handle_subscription_created_or_updated(event, client):
        subscription = event.data.object
        subscription_id = subscription.get('id')
        subscription_status = subscription.get('status')
        
        logger.info(f"[SUBSCRIPTION HANDLER] Event: {event.type}, Subscription: {subscription_id}, Status: {subscription_status}")
        
        if event.type == 'customer.subscription.updated':
            previous_attributes = event.data.get('previous_attributes', {})
            await SubscriptionHandler._handle_subscription_updated(event, subscription, client)
        
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
                    customer_subs = await stripe.Subscription.list_async(
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
                    # NOTE: Duplicate cleanup logic repeated here in original code? 
                    # Yes, it seems duplicated in original code (lines 611-661 vs 523-573). 
                    # Keeping it to maintain exact functionality.
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
                        customer_subs = await stripe.Subscription.list_async(
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
                                plan_type = get_plan_type(price_id)
                                
                                await client.from_('credit_accounts').update({
                                    'tier': tier_info.name,
                                    'plan_type': plan_type,
                                    'stripe_subscription_id': subscription['id'],
                                    'billing_cycle_anchor': billing_anchor.isoformat(),
                                    'next_credit_grant': next_grant_date.isoformat()
                                }).eq('account_id', account_id).execute()
                                logger.info(f"[WEBHOOK] Updated tier to {tier_info.name}, plan_type to {plan_type}, waiting for payment to grant credits")
                                
                            elif subscription.status == 'active':
                                logger.info(f"[WEBHOOK] User {account_id} upgrading from {current_tier} tier to paid - updating metadata only (credits handled by invoice webhook)")
                                
                                plan_type = get_plan_type(price_id)
                                
                                await client.from_('credit_accounts').update({
                                    'tier': tier_info.name,
                                    'plan_type': plan_type,
                                    'stripe_subscription_id': subscription['id'],
                                    'billing_cycle_anchor': billing_anchor.isoformat(),
                                    'next_credit_grant': next_grant_date.isoformat()
                                }).eq('account_id', account_id).execute()
                                
                                logger.info(f"[WEBHOOK] Updated metadata for {account_id}, tier={tier_info.name} - credits will be granted by invoice.payment_succeeded webhook")
                        
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
                            
                            logger.info(f"[WEBHOOK] User {account_id} with cancelled trial subscribing - metadata updated, credits will be granted by invoice webhook")
                            
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
                    await SubscriptionHandler._track_commitment(account_id, price_id, subscription, client)
            
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
                                    
                                    logger.info(f"[WEBHOOK] User {account_id} upgrading from {current_tier} via incomplete→active transition to {tier_info.name} - metadata updated, credits handled by invoice webhook")
                                    
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
                                    await SubscriptionHandler._track_commitment(account_id, price_id, subscription, client)
                            if not is_tier_upgrade:
                                logger.info(f"[WEBHOOK] Period changed but not upgrade - returning early")
                                return
            
            from core.billing.subscriptions import subscription_service
            await subscription_service.handle_subscription_change(subscription, previous_attributes)

    @staticmethod
    async def _handle_subscription_updated(event, subscription, client):
        account_id = subscription.metadata.get('account_id')
        if not account_id:
            customer_result = await client.schema('basejump').from_('billing_customers')\
                .select('account_id')\
                .eq('id', subscription['customer'])\
                .execute()
            if customer_result.data and customer_result.data[0].get('account_id'):
                account_id = customer_result.data[0]['account_id']

        if account_id:
            try:
                billing_anchor = datetime.fromtimestamp(subscription['billing_cycle_anchor'], tz=timezone.utc)
                await client.from_('credit_accounts').update({
                    'stripe_subscription_status': subscription.status,
                    'billing_cycle_anchor': billing_anchor.isoformat()
                }).eq('account_id', account_id).execute()
                logger.info(f"[WEBHOOK] Synced status='{subscription.status}' & anchor='{billing_anchor}' for {account_id}")
            except Exception as e:
                logger.error(f"[WEBHOOK] Error syncing subscription status: {e}")

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
                await SubscriptionHandler._track_commitment(account_id, price_id, subscription, client)
        
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

    @staticmethod
    async def handle_subscription_deleted(event, client):
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
                active_subs = await stripe.Subscription.list_async(
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
                'stripe_subscription_id': None,
                'stripe_subscription_status': 'canceled'
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

    @staticmethod
    async def _track_commitment(account_id: str, price_id: str, subscription: Dict, client):
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

    @staticmethod
    async def handle_trial_will_end(event, client):
        subscription = event.data.object
        account_id = subscription.metadata.get('account_id')

    @staticmethod
    async def handle_trial_subscription(subscription, account_id, new_tier, client):
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
