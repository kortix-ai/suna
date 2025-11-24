#!/usr/bin/env python3

import asyncio
import sys
import argparse
from pathlib import Path
from datetime import datetime, timezone, timedelta
from decimal import Decimal

backend_dir = Path(__file__).parent.parent.parent.parent
sys.path.insert(0, str(backend_dir))

import stripe
from core.services.supabase import DBConnection
from core.utils.config import config
from core.utils.logger import logger
from core.billing.shared.config import get_tier_by_price_id, is_commitment_price_id, get_commitment_duration_months
from core.billing.credits.manager import credit_manager

stripe.api_key = config.STRIPE_SECRET_KEY

async def fix_missing_subscription(user_email: str):
    logger.info("="*80)
    logger.info(f"FIXING SUBSCRIPTION FOR {user_email}")
    logger.info("="*80)
    
    db = DBConnection()
    await db.initialize()
    client = await db.client
    
    result = await client.rpc('get_user_account_by_email', {
        'email_input': user_email.lower()
    }).execute()
    
    if not result.data:
        logger.error(f"❌ User {user_email} not found in database")
        return
    
    account_id = result.data['id']
    logger.info(f"✅ Found user: {user_email}")
    logger.info(f"   Account ID: {account_id}")
    logger.info(f"   Account name: {result.data.get('name', 'N/A')}")
    
    billing_customer_result = await client.schema('basejump').from_('billing_customers').select('id, account_id').eq('account_id', account_id).execute()
    
    if not billing_customer_result.data:
        logger.error(f"❌ No billing customer found for account {account_id}")
        return
    
    stripe_customer_id = billing_customer_result.data[0]['id']
    logger.info(f"✅ Found Stripe customer: {stripe_customer_id}")
    
    logger.info("\n" + "="*80)
    logger.info("FETCHING STRIPE SUBSCRIPTION & SCHEDULES")
    logger.info("="*80)
    
    subscriptions = await stripe.Subscription.list_async(
        customer=stripe_customer_id,
        status='all',
        limit=10
    )
    
    if not subscriptions.data:
        logger.error(f"❌ No subscriptions found in Stripe for customer {stripe_customer_id}")
        return
    
    logger.info(f"Found {len(subscriptions.data)} subscription(s) in Stripe")
    
    active_sub = None
    for sub in subscriptions.data:
        if sub.status in ['active', 'trialing']:
            full_sub = await stripe.Subscription.retrieve_async(
                sub.id,
                expand=['items.data.price', 'schedule']
            )
            active_sub = full_sub
            break
    
    if not active_sub:
        logger.error("❌ No active or trialing subscription found")
        logger.info("\nAll subscriptions:")
        for sub in subscriptions.data:
            logger.info(f"  - {sub.id}: {sub.status}")
        return
    
    subscription = active_sub
    
    logger.info(f"\nActive subscription found:")
    logger.info(f"  ID: {subscription.id}")
    logger.info(f"  Status: {subscription.status}")
    logger.info(f"  Created: {datetime.fromtimestamp(subscription.created).isoformat()}")
    logger.info(f"  Current period: {datetime.fromtimestamp(subscription.current_period_start).isoformat()} to {datetime.fromtimestamp(subscription.current_period_end).isoformat()}")
    
    if hasattr(subscription, 'schedule') and subscription.schedule:
        logger.info(f"  Has schedule: {subscription.schedule}")
        try:
            schedule = await stripe.SubscriptionSchedule.retrieve_async(
                subscription.schedule,
                expand=['phases.items.price']
            )
            logger.info(f"\n  Schedule details:")
            logger.info(f"    Status: {schedule.status}")
            logger.info(f"    Phases: {len(schedule.phases)}")
            for idx, phase in enumerate(schedule.phases):
                logger.info(f"    Phase {idx + 1}:")
                logger.info(f"      Start: {datetime.fromtimestamp(phase['start_date']).isoformat()}")
                logger.info(f"      End: {datetime.fromtimestamp(phase['end_date']).isoformat() if phase.get('end_date') else 'ongoing'}")
                if phase.get('items'):
                    for item in phase['items']:
                        price = item.get('price')
                        if isinstance(price, str):
                            price_obj = await stripe.Price.retrieve_async(price)
                            logger.info(f"      Price ID: {price}")
                            logger.info(f"      Amount: ${price_obj.unit_amount / 100:.2f}")
                        elif hasattr(price, 'id'):
                            logger.info(f"      Price ID: {price.id}")
                            logger.info(f"      Amount: ${price.unit_amount / 100:.2f}")
        except Exception as e:
            logger.error(f"  Failed to retrieve schedule: {e}")
    
    logger.info("\n" + "="*80)
    logger.info("PROCESSING SUBSCRIPTION ITEMS")
    logger.info("="*80)
    
    price_id = None
    price = None
    
    try:
        items_data = subscription.items.data if hasattr(subscription.items, 'data') else []
    except:
        items_data = []
    
    if items_data and len(items_data) > 0:
        item = items_data[0]
        price_id = item.price.id
        price = item.price
        logger.info(f"✅ Found price from subscription items: {price_id}")
    else:
        logger.error("❌ Subscription has no items directly")
        
        logger.info("\n⚠️  Attempting to extract price from latest invoice...")
        try:
            invoices = await stripe.Invoice.list_async(
                subscription=subscription.id,
                limit=1
            )
            
            if invoices.data and len(invoices.data) > 0:
                invoice = invoices.data[0]
                logger.info(f"✅ Found invoice: {invoice.id}")
                logger.info(f"   Status: {invoice.status}")
                logger.info(f"   Amount: ${invoice.amount_due / 100:.2f}")
                
                if invoice.lines.data and len(invoice.lines.data) > 0:
                    line = invoice.lines.data[0]
                    logger.info(f"   Line item: {line.description}")
                    
                    if hasattr(line, 'price') and line.price:
                        price_id = line.price.id if hasattr(line.price, 'id') else line.price
                        logger.info(f"✅ Found price ID from invoice: {price_id}")
                        
                        price = await stripe.Price.retrieve_async(price_id)
                    else:
                        logger.error("❌ Invoice line has no price")
                        return
                else:
                    logger.error("❌ Invoice has no lines")
                    return
            else:
                logger.error("❌ No invoices found for subscription")
                return
        except Exception as e:
            logger.error(f"Failed to extract price from invoice: {e}")
            return
    
    if not price_id or not price:
        logger.error("❌ Could not determine price ID")
        return
    
    logger.info(f"\nSubscription details:")
    logger.info(f"  Price ID: {price_id}")
    logger.info(f"  Amount: ${price.unit_amount / 100:.2f}")
    logger.info(f"  Currency: {price.currency}")
    logger.info(f"  Interval: {price.recurring.interval if hasattr(price, 'recurring') else 'N/A'}")
    
    tier = get_tier_by_price_id(price_id)
    if not tier:
        logger.error(f"❌ Price ID {price_id} doesn't match any known tier")
        logger.info("\nKnown yearly commitment price IDs:")
        logger.info(f"  Prod $17/mo: {config.STRIPE_TIER_2_17_YEARLY_COMMITMENT_ID}")
        logger.info(f"  Prod $42.50/mo: {config.STRIPE_TIER_6_42_YEARLY_COMMITMENT_ID}")
        logger.info(f"  Prod $170/mo: {config.STRIPE_TIER_25_170_YEARLY_COMMITMENT_ID}")
        return
    
    logger.info(f"\n✅ Matched to tier: {tier.name} ({tier.display_name})")
    logger.info(f"   Monthly credits: ${tier.monthly_credits}")
    
    is_commitment = is_commitment_price_id(price_id)
    commitment_duration = get_commitment_duration_months(price_id)
    
    logger.info(f"   Is commitment: {is_commitment}")
    logger.info(f"   Commitment duration: {commitment_duration} months")
    
    logger.info("\n" + "="*80)
    logger.info("CHECKING CURRENT DATABASE STATE")
    logger.info("="*80)
    
    credit_account = await client.from_('credit_accounts').select('*').eq('account_id', account_id).execute()
    
    if credit_account.data:
        acc = credit_account.data[0]
        logger.info(f"Current credit account state:")
        logger.info(f"  Tier: {acc.get('tier', 'none')}")
        logger.info(f"  Balance: ${acc.get('balance', 0)}")
        logger.info(f"  Subscription ID: {acc.get('stripe_subscription_id', 'None')}")
        logger.info(f"  Commitment type: {acc.get('commitment_type', 'None')}")
        logger.info(f"  Commitment start: {acc.get('commitment_start_date', 'None')}")
        logger.info(f"  Commitment end: {acc.get('commitment_end_date', 'None')}")
    else:
        logger.info("No credit account found - will be created")
    
    logger.info("\n" + "="*80)
    logger.info("UPDATING DATABASE")
    logger.info("="*80)
    
    start_date = datetime.fromtimestamp(subscription.current_period_start, tz=timezone.utc)
    next_grant = datetime.fromtimestamp(subscription.current_period_end, tz=timezone.utc)
    
    update_data = {
        'tier': tier.name,
        'stripe_subscription_id': subscription.id,
        'billing_cycle_anchor': start_date.isoformat(),
        'next_credit_grant': next_grant.isoformat(),
        'updated_at': datetime.now(timezone.utc).isoformat()
    }
    
    if is_commitment and commitment_duration > 0:
        end_date = start_date + timedelta(days=365)
        
        update_data.update({
            'commitment_type': 'yearly_commitment',
            'commitment_start_date': start_date.isoformat(),
            'commitment_end_date': end_date.isoformat(),
            'commitment_price_id': price_id,
            'can_cancel_after': end_date.isoformat()
        })
        
        logger.info(f"Setting up yearly commitment:")
        logger.info(f"  Start date: {start_date.date()}")
        logger.info(f"  End date: {end_date.date()}")
        logger.info(f"  Duration: 12 months")
    else:
        update_data.update({
            'commitment_type': None,
            'commitment_start_date': None,
            'commitment_end_date': None,
            'commitment_price_id': None,
            'can_cancel_after': None
        })
        
        logger.info(f"Clearing commitment data (this is a regular monthly subscription)")
    
    await client.from_('credit_accounts').upsert(
        {**update_data, 'account_id': account_id},
        on_conflict='account_id'
    ).execute()
    
    logger.info("✅ Updated credit_accounts table")
    
    if is_commitment and commitment_duration > 0:
        existing_commitment = await client.from_('commitment_history').select('id').eq('stripe_subscription_id', subscription.id).execute()
        
        if not existing_commitment.data:
            end_date = start_date + timedelta(days=365)
            
            await client.from_('commitment_history').insert({
                'account_id': account_id,
                'commitment_type': 'yearly_commitment',
                'price_id': price_id,
                'start_date': start_date.isoformat(),
                'end_date': end_date.isoformat(),
                'stripe_subscription_id': subscription.id
            }).execute()
            
            logger.info("✅ Created commitment_history record")
        else:
            logger.info("✅ Commitment_history record already exists")
    
    logger.info("\n" + "="*80)
    logger.info("GRANTING INITIAL CREDITS")
    logger.info("="*80)
    
    current_balance = await client.from_('credit_accounts').select('balance').eq('account_id', account_id).execute()
    balance = Decimal(str(current_balance.data[0]['balance'])) if current_balance.data else Decimal('0')
    
    logger.info(f"Current balance: ${balance}")
    
    if balance < Decimal('1.0'):
        credits_to_grant = tier.monthly_credits
        logger.info(f"Granting ${credits_to_grant} initial credits...")
        
        result = await credit_manager.add_credits(
            account_id=account_id,
            amount=credits_to_grant,
            is_expiring=True,
            description=f"Initial credits for {tier.display_name} (yearly commitment)"
        )
        
        if result.get('success'):
            logger.info(f"✅ Granted ${credits_to_grant} credits")
            logger.info(f"   New balance: ${result.get('new_total', 0)}")
        else:
            logger.error(f"❌ Failed to grant credits: {result.get('error', 'Unknown error')}")
    else:
        logger.info(f"User already has ${balance} credits, skipping initial grant")
    
    logger.info("\n" + "="*80)
    logger.info("VERIFICATION")
    logger.info("="*80)
    
    final_account = await client.from_('credit_accounts').select('*').eq('account_id', account_id).execute()
    
    if final_account.data:
        acc = final_account.data[0]
        logger.info(f"Final credit account state:")
        logger.info(f"  ✅ Tier: {acc.get('tier')}")
        logger.info(f"  ✅ Balance: ${acc.get('balance')}")
        logger.info(f"  ✅ Subscription ID: {acc.get('stripe_subscription_id')}")
        logger.info(f"  ✅ Commitment type: {acc.get('commitment_type')}")
        logger.info(f"  ✅ Commitment start: {acc.get('commitment_start_date')}")
        logger.info(f"  ✅ Commitment end: {acc.get('commitment_end_date')}")
        logger.info(f"  ✅ Next credit grant: {acc.get('next_credit_grant')}")
    
    if is_commitment:
        commitment_history = await client.from_('commitment_history').select('*').eq('account_id', account_id).execute()
        
        if commitment_history.data:
            logger.info(f"\n  ✅ Commitment history records: {len(commitment_history.data)}")
            for record in commitment_history.data:
                logger.info(f"     - Type: {record.get('commitment_type')}, ends: {record.get('end_date')}")
    
    logger.info("\n" + "="*80)
    logger.info("✅ SUBSCRIPTION SETUP COMPLETE")
    logger.info("="*80)

def main():
    parser = argparse.ArgumentParser(
        description='Fix missing subscription for a user by syncing Stripe subscription data to database'
    )
    parser.add_argument(
        'email',
        type=str,
        help='Email address of the user to fix subscription for'
    )
    
    args = parser.parse_args()
    asyncio.run(fix_missing_subscription(args.email))

if __name__ == "__main__":
    main()

