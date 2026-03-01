#!/usr/bin/env python3
"""
Fix missing subscription for a user.

Convex Endpoints Required:
  - admin:get_user_by_email - Get user account by email
  - admin:get_billing_customer - Get billing customer by account_id
  - get_credit_account - Get credit account by account_id
  - upsert_credit_account - Create/update credit account
  - admin:create_commitment_history - Create commitment history record
  - add_credits - Add credits to account
"""

import asyncio
import sys
import argparse
from pathlib import Path
from datetime import datetime, timezone, timedelta
from decimal import Decimal

backend_dir = Path(__file__).parent.parent.parent.parent
sys.path.insert(0, str(backend_dir))

import stripe
from core.services.convex_client import get_convex_client
from core.utils.config import config
from core.utils.logger import logger
from core.billing.shared.config import get_tier_by_price_id, is_commitment_price_id, get_commitment_duration_months

stripe.api_key = config.STRIPE_SECRET_KEY


async def get_user_by_email(email: str, convex) -> dict:
    """Get user by email.
    
    Requires Convex endpoint: admin:get_user_by_email
    """
    try:
        result = await convex.admin_rpc("get_user_by_email", {"email": email.lower()})
        return result
    except Exception as e:
        logger.error(f"Error finding user: {e}")
        return None


async def get_billing_customer(account_id: str, convex) -> dict:
    """Get billing customer for account.
    
    Requires Convex endpoint: admin:get_billing_customer
    """
    try:
        result = await convex.admin_rpc("get_billing_customer", {"account_id": account_id})
        return result
    except Exception as e:
        logger.error(f"Error getting billing customer: {e}")
        return None


async def fix_missing_subscription(user_email: str, dry_run: bool = False):
    """Fix missing subscription for a user.
    
    Uses Convex endpoints:
      - admin:get_user_by_email
      - admin:get_billing_customer
      - get_credit_account
      - upsert_credit_account
      - admin:create_commitment_history
      - add_credits
    """
    logger.info("="*80)
    logger.info(f"FIXING SUBSCRIPTION FOR {user_email}")
    logger.info(f"Mode: {'DRY RUN' if dry_run else 'LIVE'}")
    logger.info("="*80)
    
    convex = get_convex_client()
    
    # Step 1: Find user
    user_result = await get_user_by_email(user_email, convex)
    
    if not user_result:
        logger.error(f"❌ User {user_email} not found in database")
        return False
    
    account_id = user_result['id']
    logger.info(f"✅ Found user: {user_email}")
    logger.info(f"   Account ID: {account_id}")
    logger.info(f"   Account name: {user_result.get('name', 'N/A')}")
    
    # Step 2: Get billing customer
    billing_customer = await get_billing_customer(account_id, convex)
    
    if not billing_customer:
        logger.error(f"❌ No billing customer found for account {account_id}")
        return False
    
    stripe_customer_id = billing_customer['id']
    logger.info(f"✅ Found Stripe customer: {stripe_customer_id}")
    
    # Step 3: Fetch Stripe subscription
    logger.info("\n" + "="*80)
    logger.info("FETCHING STRIPE SUBSCRIPTION & SCHEDULES")
    logger.info("="*80)
    
    try:
        subscriptions = stripe.Subscription.list(
            customer=stripe_customer_id,
            status='all',
            limit=10
        )
    except Exception as e:
        logger.error(f"❌ Error fetching subscriptions: {e}")
        return False
    
    if not subscriptions.data:
        logger.error(f"❌ No subscriptions found in Stripe for customer {stripe_customer_id}")
        return False
    
    logger.info(f"Found {len(subscriptions.data)} subscription(s) in Stripe")
    
    # Find active subscription
    active_sub = None
    for sub in subscriptions.data:
        if sub.status in ['active', 'trialing', 'past_due']:
            try:
                full_sub = stripe.Subscription.retrieve(
                    sub.id,
                    expand=['items.data.price', 'schedule']
                )
                active_sub = full_sub
                break
            except Exception as e:
                logger.warning(f"Could not retrieve subscription {sub.id}: {e}")
                continue
    
    if not active_sub:
        logger.error("❌ No active, trialing, or past_due subscription found")
        logger.info("\nAll subscriptions:")
        for sub in subscriptions.data:
            logger.info(f"  - {sub.id}: {sub.status}")
        return False
    
    subscription = active_sub
    
    logger.info(f"\nActive subscription found:")
    logger.info(f"  ID: {subscription.id}")
    logger.info(f"  Status: {subscription.status}")
    if subscription.status == 'past_due':
        logger.info(f"  ⚠️  GRACE PERIOD: Payment failed, Stripe will retry automatically")
    logger.info(f"  Created: {datetime.fromtimestamp(subscription.created).isoformat()}")
    logger.info(f"  Current period: {datetime.fromtimestamp(subscription.current_period_start).isoformat()} to {datetime.fromtimestamp(subscription.current_period_end).isoformat()}")
    
    # Step 4: Extract price ID
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
            invoices = stripe.Invoice.list(
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
                        
                        price = stripe.Price.retrieve(price_id)
                    else:
                        logger.error("❌ Invoice line has no price")
                        return False
                else:
                    logger.error("❌ Invoice has no lines")
                    return False
            else:
                logger.error("❌ No invoices found for subscription")
                return False
        except Exception as e:
            logger.error(f"Failed to extract price from invoice: {e}")
            return False
    
    if not price_id or not price:
        logger.error("❌ Could not determine price ID")
        return False
    
    logger.info(f"\nSubscription details:")
    logger.info(f"  Price ID: {price_id}")
    logger.info(f"  Amount: ${price.unit_amount / 100:.2f}")
    logger.info(f"  Currency: {price.currency}")
    logger.info(f"  Interval: {price.recurring.interval if hasattr(price, 'recurring') else 'N/A'}")
    
    # Step 5: Match to tier
    tier = get_tier_by_price_id(price_id)
    if not tier:
        logger.error(f"❌ Price ID {price_id} doesn't match any known tier")
        logger.info("\nKnown yearly commitment price IDs:")
        logger.info(f"  Prod $17/mo: {config.STRIPE_TIER_2_17_YEARLY_COMMITMENT_ID}")
        logger.info(f"  Prod $42.50/mo: {config.STRIPE_TIER_6_42_YEARLY_COMMITMENT_ID}")
        logger.info(f"  Prod $170/mo: {config.STRIPE_TIER_25_170_YEARLY_COMMITMENT_ID}")
        return False
    
    logger.info(f"\n✅ Matched to tier: {tier.name} ({tier.display_name})")
    logger.info(f"   Monthly credits: ${tier.monthly_credits}")
    
    is_commitment = is_commitment_price_id(price_id)
    commitment_duration = get_commitment_duration_months(price_id)
    
    logger.info(f"   Is commitment: {is_commitment}")
    logger.info(f"   Commitment duration: {commitment_duration} months")
    
    # Step 6: Check current state
    logger.info("\n" + "="*80)
    logger.info("CHECKING CURRENT DATABASE STATE")
    logger.info("="*80)
    
    credit_account = await convex.get_credit_account(account_id)
    
    if credit_account:
        logger.info(f"Current credit account state:")
        logger.info(f"  Tier: {credit_account.get('tier', 'none')}")
        logger.info(f"  Balance: ${credit_account.get('balance', 0)}")
        logger.info(f"  Subscription ID: {credit_account.get('stripe_subscription_id', 'None')}")
        logger.info(f"  Commitment type: {credit_account.get('commitment_type', 'None')}")
        logger.info(f"  Commitment start: {credit_account.get('commitment_start_date', 'None')}")
        logger.info(f"  Commitment end: {credit_account.get('commitment_end_date', 'None')}")
    else:
        logger.info("No credit account found - will be created")
    
    # Step 7: Update database
    logger.info("\n" + "="*80)
    logger.info("UPDATING DATABASE")
    logger.info("="*80)
    
    start_date = datetime.fromtimestamp(subscription.current_period_start, tz=timezone.utc)
    next_grant = datetime.fromtimestamp(subscription.current_period_end, tz=timezone.utc)
    
    update_data = {
        'account_id': account_id,
        'tier': tier.name,
        'stripe_subscription_id': subscription.id,
        'billing_cycle_anchor': start_date.isoformat(),
        'next_credit_grant': next_grant.isoformat(),
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
    
    if dry_run:
        logger.info("[DRY RUN] Would update credit account:")
        for k, v in update_data.items():
            logger.info(f"  {k}: {v}")
        return True
    
    try:
        await convex.upsert_credit_account(**update_data)
        logger.info("✅ Updated credit_accounts table")
        
        if is_commitment and commitment_duration > 0:
            await convex.admin_rpc("create_commitment_history", {
                "account_id": account_id,
                "commitment_type": "yearly_commitment",
                "price_id": price_id,
                "start_date": start_date.isoformat(),
                "end_date": end_date.isoformat(),
                "stripe_subscription_id": subscription.id
            })
            logger.info("✅ Created commitment_history record")
        
        # Step 8: Grant initial credits
        logger.info("\n" + "="*80)
        logger.info("GRANTING INITIAL CREDITS")
        logger.info("="*80)
        
        current_balance = Decimal(str(credit_account.get('balance', 0))) if credit_account else Decimal('0')
        logger.info(f"Current balance: ${current_balance}")
        
        if current_balance < Decimal('1.0'):
            credits_to_grant = tier.monthly_credits
            logger.info(f"Granting ${credits_to_grant} initial credits...")
            
            result = await convex.add_credits(
                account_id=account_id,
                amount=int(credits_to_grant),
                description=f"Initial credits for {tier.display_name}{' (yearly commitment)' if is_commitment else ''}",
                credit_type="subscription_fix"
            )
            
            if result and result.get('success'):
                logger.info(f"✅ Granted ${credits_to_grant} credits")
                logger.info(f"   New balance: ${result.get('new_balance', 0)}")
            else:
                logger.error(f"❌ Failed to grant credits: {result}")
        else:
            logger.info(f"User already has ${current_balance} credits, skipping initial grant")
        
        # Step 9: Verification
        logger.info("\n" + "="*80)
        logger.info("VERIFICATION")
        logger.info("="*80)
        
        final_account = await convex.get_credit_account(account_id)
        
        if final_account:
            logger.info(f"Final credit account state:")
            logger.info(f"  ✅ Tier: {final_account.get('tier')}")
            logger.info(f"  ✅ Balance: ${final_account.get('balance')}")
            logger.info(f"  ✅ Subscription ID: {final_account.get('stripe_subscription_id')}")
            logger.info(f"  ✅ Commitment type: {final_account.get('commitment_type')}")
            logger.info(f"  ✅ Commitment start: {final_account.get('commitment_start_date')}")
            logger.info(f"  ✅ Commitment end: {final_account.get('commitment_end_date')}")
            logger.info(f"  ✅ Next credit grant: {final_account.get('next_credit_grant')}")
        
        logger.info("\n" + "="*80)
        logger.info("✅ SUBSCRIPTION SETUP COMPLETE")
        logger.info("="*80)
        return True
        
    except Exception as e:
        logger.error(f"❌ Error updating database: {e}", exc_info=True)
        return False


def main():
    parser = argparse.ArgumentParser(
        description='Fix missing subscription for a user by syncing Stripe subscription data to database'
    )
    parser.add_argument(
        'email',
        type=str,
        help='Email address of the user to fix subscription for'
    )
    parser.add_argument(
        '--dry-run',
        action='store_true',
        help='Show what would be done without making changes'
    )
    
    args = parser.parse_args()
    
    success = asyncio.run(fix_missing_subscription(args.email, args.dry_run))
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()

