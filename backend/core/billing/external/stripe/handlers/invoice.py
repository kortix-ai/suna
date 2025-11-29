from typing import Dict
from decimal import Decimal
from datetime import datetime, timezone, timedelta, timedelta
from core.services.supabase import DBConnection
from core.utils.logger import logger
from core.utils.cache import Cache
from core.utils.distributed_lock import RenewalLock
from core.billing.shared.config import (
    get_tier_by_price_id, 
    get_tier_by_name,
    get_monthly_credits,
    get_plan_type
)
from core.billing.credits.manager import credit_manager
from core.billing.shared.cache_utils import invalidate_account_state_cache
from ..client import StripeAPIWrapper
from ....subscriptions.handlers.billing_period import BillingPeriodHandler

class InvoiceHandler:
    @staticmethod
    async def handle_invoice_payment_succeeded(event, client):
        invoice = event.data.object
        billing_reason = invoice.get('billing_reason')

        if invoice.get('lines', {}).get('data'):
            for line in invoice['lines']['data']:
                if 'Credit' in line.get('description', ''):
                    return

        if invoice.get('subscription'):
            if billing_reason in ['subscription_cycle', 'subscription_update', 'subscription_create']:
                await InvoiceHandler.handle_subscription_renewal(invoice, event.id)
            else:
                await InvoiceHandler.handle_subscription_renewal(invoice, event.id)

    @staticmethod
    async def handle_subscription_renewal(invoice: Dict, stripe_event_id: str = None):
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
                                    # Only skip credit grant if monthly_refill is explicitly disabled
                                    if not tier_info.monthly_refill_enabled:
                                        logger.info(f"[RENEWAL] Skipping upgrade credits for tier {tier_info.name} - monthly_refill_enabled=False")
                                    else:
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
                                'next_credit_grant': BillingPeriodHandler._calculate_next_credit_grant(price_id, period_start, period_end)
                            }
                            if trial_status != account.get('trial_status'):
                                update_data['trial_status'] = trial_status
                            
                            logger.info(f"[INITIAL GRANT SKIP] Updating metadata for tier {tier}")
                            await client.from_('credit_accounts').update(update_data).eq('account_id', account_id).execute()
                            return
                    elif last_grant and current_db_tier != tier:
                        logger.info(f"[TIER CHANGE DETECTED] Last grant was for tier {current_db_tier}, but invoice is for tier {tier} - will grant credits for new tier")
                
                if is_true_renewal:
                    tier_config = get_tier_by_name(tier)
                    # Only skip credit grant if monthly_refill is explicitly disabled (e.g., free tier)
                    if tier_config and not tier_config.monthly_refill_enabled:
                        logger.info(f"[RENEWAL SKIP] Skipping monthly credit grant for {account_id} - tier {tier} has monthly_refill_enabled=False")
                        await client.from_('credit_accounts').update({
                            'last_processed_invoice_id': invoice_id,
                            'stripe_subscription_id': subscription_id
                        }).eq('account_id', account_id).execute()
                        return
                    
                    logger.info(f"[RENEWAL] Using atomic function to grant ${monthly_credits} credits for {account_id} (TRUE RENEWAL)")
                    result = await client.rpc('atomic_grant_renewal_credits', {
                        'p_account_id': account_id,
                        'p_period_start': period_start,
                        'p_period_end': period_end,
                        'p_credits': float(monthly_credits),
                        'p_processed_by': 'webhook_invoice',
                        'p_invoice_id': invoice_id,
                        'p_stripe_event_id': stripe_event_id,
                        'p_provider': 'stripe',
                        'p_revenuecat_transaction_id': None,
                        'p_revenuecat_product_id': None
                    }).execute()
                else:
                    recent_time_threshold = datetime.now(timezone.utc) - timedelta(minutes=5)
                    
                    recent_credits = await client.from_('credit_ledger').select('description, amount, created_at, stripe_event_id').eq(
                        'account_id', account_id
                    ).gte('created_at', recent_time_threshold.isoformat()).execute()
                    
                    checkout_credits_already_granted = False
                    if recent_credits.data:
                        for entry in recent_credits.data:
                            description = entry.get('description', '')
                            amount = entry.get('amount', 0)
                            stripe_event_id_check = entry.get('stripe_event_id', '')
                            
                            if ((('checkout.session.completed' in description or 'checkout_' in stripe_event_id_check) and
                                float(amount) == float(monthly_credits) and
                                tier in description) or 
                                ('Tier upgrade to' in description and float(amount) == float(monthly_credits)) or
                                ('Subscription credits for' in description and float(amount) == float(monthly_credits))):
                                checkout_credits_already_granted = True
                                logger.info(f"[INITIAL GRANT SKIP] Found recent upgrade credit grant: {description} (${amount})")
                                break
                    
                    if checkout_credits_already_granted:
                        logger.info(f"[INITIAL GRANT SKIP] Checkout handler already granted ${monthly_credits} credits for {account_id}, skipping invoice grant")
                        
                        plan_type = get_plan_type(price_id)
                        update_data = {
                            'tier': tier,
                            'plan_type': plan_type,
                            'last_processed_invoice_id': invoice_id,
                            'stripe_subscription_id': subscription_id,
                            'billing_cycle_anchor': datetime.fromtimestamp(subscription['current_period_start'], tz=timezone.utc).isoformat(),
                            'next_credit_grant': BillingPeriodHandler._calculate_next_credit_grant(price_id, period_start, period_end)
                        }
                        
                        if trial_status in ['cancelled', 'expired']:
                            update_data['trial_status'] = 'none'
                        
                        await client.from_('credit_accounts').update(update_data).eq('account_id', account_id).execute()
                        return
                    
                    tier_config = get_tier_by_name(tier)
                    # Only skip credit grant if monthly_refill is explicitly disabled (e.g., free tier)
                    if tier_config and not tier_config.monthly_refill_enabled:
                        logger.info(f"[INITIAL GRANT SKIP] Skipping initial credit grant for {account_id} - tier {tier} has monthly_refill_enabled=False")
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
                        'next_credit_grant': BillingPeriodHandler._calculate_next_credit_grant(price_id, period_start, period_end),
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
                    await invalidate_account_state_cache(account_id)
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
                    await invalidate_account_state_cache(account_id)
            
            except Exception as e:
                logger.error(f"Error handling subscription renewal: {e}")
            
            finally:
                await lock.release()

        except Exception as e:
            logger.error(f"Outer error in handle_subscription_renewal: {e}")

    @staticmethod
    async def handle_invoice_payment_failed(event, client):
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
