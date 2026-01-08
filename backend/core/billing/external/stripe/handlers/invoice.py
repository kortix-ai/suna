from typing import Dict
from decimal import Decimal
from datetime import datetime, timezone, timedelta
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
from core.billing import repo as billing_repo
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
            subscription_id = invoice.get('subscription')
            invoice_id = invoice.get('id')
            billing_reason = invoice.get('billing_reason')
            
            if not subscription_id or not invoice_id:
                return

            period_start = invoice.get('period_start')
            period_end = invoice.get('period_end')
            
            if not period_start or not period_end:
                return
            
            customer_data = await billing_repo.get_billing_customer_by_stripe_id(invoice['customer'])
            
            if not customer_data:
                logger.error(f"[RENEWAL] No account found for customer {invoice['customer']}")
                return
            
            account_id = customer_data['account_id']
            
            guard_check = await billing_repo.check_renewal_already_processed(account_id, period_start)
            
            if guard_check and guard_check.get('already_processed'):
                logger.info(
                    f"[RENEWAL GUARD] ⛔ Renewal already processed for {account_id} period {period_start} "
                    f"by {guard_check.get('processed_by')} at {guard_check.get('processed_at')}"
                )
                return
            
            lock = await RenewalLock.lock_renewal_processing(account_id, period_start)
            acquired = await lock.acquire(wait=True, wait_timeout=60)
            if not acquired:
                logger.error(f"[RENEWAL] Failed to acquire lock for {account_id} period {period_start}")
                return
            
            try:
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
                        # account_id already set from early customer lookup
                        logger.info(f"[RENEWAL] Processing prorated upgrade for account {account_id}")
                        
                        subscription = await StripeAPIWrapper.retrieve_subscription(subscription_id)
                        price_id = subscription['items']['data'][0]['price']['id'] if subscription.get('items') else None
                        
                        if price_id:
                            tier_info = get_tier_by_price_id(price_id) 
                            existing_tier_result = await billing_repo.get_credit_account_tier(account_id)
                            
                            if tier_info and existing_tier_result:
                                existing_tier_name = existing_tier_result.get('tier')
                                existing_tier = get_tier_by_name(existing_tier_name)
                                
                                if existing_tier and tier_info.name != existing_tier.name and float(tier_info.monthly_credits) > float(existing_tier.monthly_credits):
                                    logger.info(f"[RENEWAL] Prorated upgrade detected ({existing_tier.name} -> {tier_info.name}) - credits handled by subscription.updated, updating metadata only")
                                    
                                    await billing_repo.update_credit_account(account_id, {
                                        'tier': tier_info.name,
                                        'last_processed_invoice_id': invoice_id,
                                        'last_grant_date': datetime.fromtimestamp(period_start, tz=timezone.utc).isoformat()
                                    })
                                    
                                    return
                        logger.debug(f"[RENEWAL] No price_id found, returning")
                        return
                    
                    if not has_full_cycle_charge:
                        logger.info(f"[RENEWAL] subscription_update without full cycle charge - skipping (likely mid-period change)")
                        return
                    
                    logger.info(f"[RENEWAL] subscription_update WITH full cycle charge detected - treating as renewal and continuing processing")
                
                logger.debug(f"[RENEWAL] Fetching account for customer {invoice.get('customer')}")
                
                # account_id already set from early customer lookup
                logger.debug(f"[RENEWAL] Found account {account_id}, continuing with renewal")
                
                account = await billing_repo.get_credit_account_for_renewal(account_id)
                
                if not account:
                    logger.warning(f"[RENEWAL] No credit account found for {account_id}")
                    return
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
                    await billing_repo.update_credit_account(account_id, {
                        'last_processed_invoice_id': invoice_id
                    })
                    return
                
                if trial_status == 'active' and not is_still_trialing:
                    logger.info(f"[RENEWAL] Trial ended (subscription is {subscription_status}), will grant first paid period credits and mark trial as converted")
                    await billing_repo.update_credit_account(account_id, {
                        'trial_status': 'converted'
                    })
                    await billing_repo.mark_trial_converted(account_id)
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
                
                # Check tier config first to see if monthly_refill is enabled
                tier_config = get_tier_by_name(tier)
                if not tier_config:
                    logger.error(f"[RENEWAL] Tier {tier} not found in configuration - cannot process invoice")
                    raise ValueError(f"Tier not found: {tier}")
                
                # For tiers with monthly_refill_enabled=False (e.g., free tier), skip credit grant but still update metadata
                if not tier_config.monthly_refill_enabled:
                    logger.info(f"[RENEWAL] Skipping credit grant for tier {tier} - monthly_refill_enabled=False")
                    # Still update invoice tracking and metadata
                    await billing_repo.update_credit_account(account_id, {
                        'last_processed_invoice_id': invoice_id,
                        'stripe_subscription_id': subscription_id,
                        'tier': tier,
                        'billing_cycle_anchor': period_start_dt.isoformat(),
                        'next_credit_grant': BillingPeriodHandler._calculate_next_credit_grant(price_id, period_start, period_end) if price_id else None
                    })
                    await Cache.invalidate(f"credit_balance:{account_id}")
                    await Cache.invalidate(f"credit_summary:{account_id}")
                    await Cache.invalidate(f"subscription_tier:{account_id}")
                    await invalidate_account_state_cache(account_id)
                    return
                
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
                                'next_credit_grant': BillingPeriodHandler._calculate_next_credit_grant(price_id, period_start, period_end) if price_id else None
                            }
                            if trial_status != account.get('trial_status'):
                                update_data['trial_status'] = trial_status
                            
                            logger.info(f"[INITIAL GRANT SKIP] Updating metadata for tier {tier}")
                            await billing_repo.update_credit_account(account_id, update_data)
                            return
                    elif last_grant and current_db_tier != tier:
                        logger.info(f"[TIER CHANGE DETECTED] Last grant was for tier {current_db_tier}, but invoice is for tier {tier} - will grant credits for new tier")
                
                if is_true_renewal:
                    tier_config = get_tier_by_name(tier)
                    if tier_config and not tier_config.monthly_refill_enabled:
                        logger.info(f"[RENEWAL SKIP] Skipping monthly credit grant for {account_id} - tier {tier} has monthly_refill_enabled=False")
                        await billing_repo.update_credit_account(account_id, {
                            'last_processed_invoice_id': invoice_id,
                            'stripe_subscription_id': subscription_id
                        })
                        return
                    
                    logger.info(f"[RENEWAL] Using atomic function to grant ${monthly_credits} credits for {account_id} (TRUE RENEWAL)")
                    result = await billing_repo.atomic_grant_renewal_credits(
                        account_id=account_id,
                        period_start=period_start,
                        period_end=period_end,
                        credits=float(monthly_credits),
                        processed_by='webhook_invoice',
                        invoice_id=invoice_id,
                        stripe_event_id=stripe_event_id,
                        provider='stripe',
                        revenuecat_transaction_id=None,
                        revenuecat_product_id=None
                    )
                else:
                    recent_time_threshold = datetime.now(timezone.utc) - timedelta(minutes=5)
                    
                    recent_credits = await billing_repo.get_recent_credit_ledger_entries(
                        account_id, recent_time_threshold.isoformat()
                    )
                    
                    checkout_credits_already_granted = False
                    if recent_credits:
                        for entry in recent_credits:
                            description = entry.get('description', '') or ''
                            amount = entry.get('amount', 0)
                            stripe_event_id_check = entry.get('stripe_event_id') or ''
                            
                            if ((('checkout.session.completed' in description or 'checkout_' in stripe_event_id_check or 'free_upgrade_' in stripe_event_id_check) and
                                float(amount) == float(monthly_credits) and
                                tier in description) or 
                                ('Tier upgrade to' in description and float(amount) == float(monthly_credits)) or
                                ('Subscription credits for' in description and float(amount) == float(monthly_credits)) or
                                ('New subscription:' in description and tier in description and float(amount) == float(monthly_credits))):
                                checkout_credits_already_granted = True
                                logger.info(f"[INITIAL GRANT SKIP] Found recent upgrade credit grant: {description} (${amount})")
                                break
                    
                    if checkout_credits_already_granted:
                        logger.info(f"[INITIAL GRANT SKIP] Checkout handler already granted ${monthly_credits} credits for {account_id}, skipping invoice grant")
                        
                        plan_type = get_plan_type(price_id) if price_id else None
                        update_data = {
                            'tier': tier,
                            'plan_type': plan_type,
                            'last_processed_invoice_id': invoice_id,
                            'stripe_subscription_id': subscription_id,
                            'billing_cycle_anchor': datetime.fromtimestamp(subscription['current_period_start'], tz=timezone.utc).isoformat(),
                            'next_credit_grant': BillingPeriodHandler._calculate_next_credit_grant(price_id, period_start, period_end) if price_id else None
                        }
                        
                        if trial_status in ['cancelled', 'expired']:
                            update_data['trial_status'] = 'none'
                        
                        await billing_repo.update_credit_account(account_id, update_data)
                        return
                    
                    tier_config = get_tier_by_name(tier)
                    
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
                        'next_credit_grant': BillingPeriodHandler._calculate_next_credit_grant(price_id, period_start, period_end) if price_id else None,
                        'last_processed_invoice_id': invoice_id,
                        'stripe_subscription_id': subscription_id,
                        'billing_cycle_anchor': datetime.fromtimestamp(subscription['current_period_start'], tz=timezone.utc).isoformat()
                    }
                    
                    if trial_status in ['cancelled', 'expired']:
                        update_data['trial_status'] = 'none'
                        logger.info(f"[RENEWAL] Resetting trial_status from {trial_status} to 'none'")
                    
                    await billing_repo.update_credit_account(account_id, update_data)
                    
                    result = add_result
                
                if is_true_renewal and result:
                    credits_granted = result.get('credits_granted', monthly_credits)
                    expiring = result.get('expiring_credits', credits_granted)
                    non_expiring = result.get('non_expiring_credits', 0)
                    total = result.get('new_balance', credits_granted)
                    
                    if result.get('duplicate_prevented'):
                        logger.info(
                            f"[RENEWAL DEDUPE] ⛔ Duplicate renewal prevented for {account_id} period {period_start} "
                            f"(already processed by {result.get('processed_by')})"
                        )
                    elif result.get('success') or credits_granted:
                        logger.info(
                            f"[RENEWAL SUCCESS] ✅ Granted ${credits_granted} credits "
                            f"to {account_id}: Expiring=${expiring:.2f}, "
                            f"Non-expiring=${non_expiring:.2f}, "
                            f"Total=${total:.2f}"
                        )
                        
                        if trial_status == 'converted':
                            await billing_repo.update_credit_account(account_id, {
                                'trial_status': 'none'
                            })
                        
                        try:
                            await Cache.invalidate(f"credit_balance:{account_id}")
                            await Cache.invalidate(f"credit_summary:{account_id}")
                            await Cache.invalidate(f"subscription_tier:{account_id}")
                            await invalidate_account_state_cache(account_id)
                        except Exception as cache_err:
                            logger.warning(f"[RENEWAL] Cache invalidation failed for {account_id}: {str(cache_err)}")
                    else:
                        error_msg = result.get('error', 'Unknown error')
                        logger.error(f"[RENEWAL ERROR] Failed to grant credits for account {account_id}: {error_msg}")
                elif is_true_renewal:
                    logger.error(f"[RENEWAL ERROR] Failed to grant credits for account {account_id}: No response from atomic function")
                elif not is_true_renewal and result and result.get('success'):
                    logger.info(f"[INITIAL GRANT SUCCESS] ✅ Granted ${monthly_credits} initial subscription credits to {account_id}")
                    
                    try:
                        await Cache.invalidate(f"credit_balance:{account_id}")
                        await Cache.invalidate(f"credit_summary:{account_id}")
                        await Cache.invalidate(f"subscription_tier:{account_id}")
                        await invalidate_account_state_cache(account_id)
                    except Exception as cache_err:
                        logger.warning(f"[RENEWAL] Cache invalidation failed for {account_id}: {str(cache_err)}")
            
            except Exception as e:
                logger.error(
                    f"Error handling subscription renewal for invoice {invoice_id}, account {account_id}, tier {tier}: {str(e)}",
                    exc_info=True
                )
            
            finally:
                await lock.release()

        except Exception as e:
            invoice_id_str = invoice.get('id', 'unknown') if 'invoice' in locals() else 'unknown'
            account_id_str = account_id if 'account_id' in locals() else 'unknown'
            tier_str = tier if 'tier' in locals() else 'unknown'
            logger.error(
                f"Outer error in handle_subscription_renewal - invoice_id={invoice_id_str}, account_id={account_id_str}, tier={tier_str}: {str(e)}",
                exc_info=True
            )

    @staticmethod
    async def handle_invoice_payment_failed(event, client=None):
        invoice = event.data.object
        subscription_id = invoice.get('subscription')
        billing_reason = invoice.get('billing_reason')
        
        logger.info(f"[PAYMENT FAILED] Processing: subscription_id={subscription_id}, billing_reason={billing_reason}")
        
        if not subscription_id:
            logger.info("[PAYMENT FAILED] No subscription_id in invoice, skipping")
            return
            
        try:
            subscription = await StripeAPIWrapper.retrieve_subscription(subscription_id)
            account_id = subscription.metadata.get('account_id')
            subscription_status = subscription.get('status')
            
            logger.debug(f"[PAYMENT FAILED] Retrieved subscription: status={subscription_status}, account_id={account_id}")
            
            if not account_id:
                customer_data = await billing_repo.get_billing_customer_by_stripe_id(subscription['customer'])
                
                if customer_data:
                    account_id = customer_data['account_id']
                    logger.info(f"[PAYMENT FAILED] Found account_id from billing_customers: {account_id}")
            
            if account_id:
                try:
                    is_new_subscription_failure = (
                        billing_reason == 'subscription_create' and 
                        subscription_status in ['incomplete', 'incomplete_expired', 'canceled']
                    )
                    
                    if is_new_subscription_failure:
                        logger.info(f"[PAYMENT FAILED] Initial subscription payment failed for {account_id} - reverting tier to 'free'")
                        
                        await billing_repo.update_credit_account(account_id, {
                            'payment_status': 'failed',
                            'last_payment_failure': datetime.now(timezone.utc).isoformat(),
                            'tier': 'free',
                            'stripe_subscription_id': None,
                            'stripe_subscription_status': None
                        })
                        
                        logger.info(f"[PAYMENT FAILED] Successfully reverted {account_id} to free tier")
                    else:
                        await billing_repo.update_credit_account(account_id, {
                            'payment_status': 'failed',
                            'last_payment_failure': datetime.now(timezone.utc).isoformat()
                        })
                        
                        logger.info(f"[PAYMENT FAILED] Marked payment as failed for account {account_id}")
                    
                except Exception as update_error:
                    logger.warning(f"[WEBHOOK] Could not update payment status: {update_error}")
            else:
                logger.warning(f"[PAYMENT FAILED] Could not find account_id for subscription {subscription_id}")
                
        except Exception as e:
            logger.error(f"[WEBHOOK] Error processing payment failure: {e}")
