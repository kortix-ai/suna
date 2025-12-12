#!/usr/bin/env python3
"""
Script to grant missed renewal credits for users whose renewal was on a specific date.

Usage:
    uv run python core/utils/scripts/fix_missed_renewals.py --date 2025-12-04 --dry-run
    uv run python core/utils/scripts/fix_missed_renewals.py --date 2025-12-04
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
from core.services.supabase import DBConnection
from core.utils.config import config
from core.utils.logger import logger
from core.billing.shared.config import get_tier_by_name, get_tier_by_price_id, get_plan_type
from core.billing.credits.manager import credit_manager
from dateutil.relativedelta import relativedelta

stripe.api_key = config.STRIPE_SECRET_KEY


async def fix_missed_renewals(target_date: str, dry_run: bool = False):
    """Grant missed renewal credits for users whose renewal was on target date."""
    logger.info("="*80)
    logger.info(f"GRANTING MISSED RENEWAL CREDITS FOR {target_date}")
    logger.info("="*80)
    
    db = DBConnection()
    await db.initialize()
    client = await db.client
    
    # Parse target date
    start_of_day = datetime.strptime(target_date, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    end_of_day = start_of_day + timedelta(days=1)
    
    logger.info(f"Searching for users whose next_credit_grant was on {target_date}...")
    
    batch_size = 1000
    offset = 0
    fixed_count = 0
    skipped_count = 0
    total_checked = 0
    
    while True:
        # Find users whose next_credit_grant was on target date
        users = await client.from_('credit_accounts').select(
            'account_id, tier, stripe_subscription_id, next_credit_grant, last_grant_date, billing_cycle_anchor, plan_type'
        ).gte('next_credit_grant', start_of_day.isoformat()).lt(
            'next_credit_grant', end_of_day.isoformat()
        ).not_.is_('stripe_subscription_id', 'null').not_.in_('tier', ['none']).range(
            offset, offset + batch_size - 1
        ).execute()
        
        if not users.data:
            break
        
        logger.info(f"\nBatch {offset//batch_size + 1}: Processing {len(users.data)} users...")
        
        for user_data in users.data:
            total_checked += 1
            try:
                account_id = user_data['account_id']
                tier_name = user_data['tier']
                stripe_subscription_id = user_data.get('stripe_subscription_id')
                last_grant_date = user_data.get('last_grant_date')
                plan_type = user_data.get('plan_type', 'monthly')
                
                # Check if they already got credited on or after target date
                if last_grant_date:
                    last_grant_dt = datetime.fromisoformat(last_grant_date.replace('Z', '+00:00'))
                    if last_grant_dt >= start_of_day:
                        logger.info(f"✅ Already processed: {account_id} (last_grant: {last_grant_date})")
                        skipped_count += 1
                        continue
                
                # Get tier info
                tier_info = get_tier_by_name(tier_name)
                
                if not tier_info:
                    logger.warning(f"⚠️  Unknown tier {tier_name} for {account_id}")
                    skipped_count += 1
                    continue
                
                if not tier_info.monthly_refill_enabled:
                    logger.info(f"Skipping {account_id}: tier {tier_name} has no monthly refill")
                    skipped_count += 1
                    continue
                
                # Fetch subscription from Stripe to get accurate billing info
                try:
                    subscription = await stripe.Subscription.retrieve_async(
                        stripe_subscription_id,
                        expand=['items.data.price']
                    )
                except Exception as e:
                    logger.warning(f"⚠️  Could not fetch subscription {stripe_subscription_id} for {account_id}: {e}")
                    skipped_count += 1
                    continue
                
                if subscription.status not in ['active', 'trialing', 'past_due']:
                    logger.info(f"Skipping {account_id}: subscription status is {subscription.status}")
                    skipped_count += 1
                    continue
                
                # Get price info from subscription
                items = subscription.get('items')
                if items and items.get('data') and len(items['data']) > 0:
                    price_id = items['data'][0]['price']['id']
                    actual_plan_type = get_plan_type(price_id)
                else:
                    actual_plan_type = plan_type
                
                # Calculate next grant date
                current_period_end = datetime.fromtimestamp(subscription.current_period_end, tz=timezone.utc)
                billing_anchor = datetime.fromtimestamp(subscription.current_period_start, tz=timezone.utc)
                
                if actual_plan_type == 'yearly' or actual_plan_type == 'yearly_commitment':
                    # For yearly plans, grant monthly credits, next grant is 1 month from now
                    next_grant_date = start_of_day + relativedelta(months=1)
                else:
                    # For monthly plans, next grant is at the end of current period
                    next_grant_date = current_period_end
                
                logger.info(f"\n{'[DRY RUN] ' if dry_run else ''}Processing {account_id}:")
                logger.info(f"  Tier: {tier_name}")
                logger.info(f"  Plan type: {actual_plan_type}")
                logger.info(f"  Credits to grant: ${tier_info.monthly_credits}")
                logger.info(f"  Current period end: {current_period_end}")
                logger.info(f"  Next grant date: {next_grant_date}")
                
                if not dry_run:
                    # Grant renewal credits
                    await credit_manager.add_credits(
                        account_id=account_id,
                        amount=tier_info.monthly_credits,
                        is_expiring=True,
                        description=f"Monthly renewal for {tier_info.display_name} (missed webhook recovery {target_date})",
                        expires_at=next_grant_date
                    )
                    
                    # Update billing info
                    await client.from_('credit_accounts').update({
                        'last_grant_date': start_of_day.isoformat(),
                        'next_credit_grant': next_grant_date.isoformat(),
                        'billing_cycle_anchor': billing_anchor.isoformat(),
                        'plan_type': actual_plan_type
                    }).eq('account_id', account_id).execute()
                    
                    logger.info(f"✅ Granted ${tier_info.monthly_credits} credits to {account_id}")
                
                fixed_count += 1
                
            except Exception as e:
                logger.error(f"❌ Error processing {account_id}: {e}", exc_info=True)
                continue
        
        offset += batch_size
        
        if len(users.data) < batch_size:
            break
    
    logger.info(f"\n{'[DRY RUN] ' if dry_run else ''}Summary:")
    logger.info(f"  Total checked: {total_checked}")
    logger.info(f"  Already processed/skipped: {skipped_count}")
    logger.info(f"  Fixed: {fixed_count}")


async def main():
    parser = argparse.ArgumentParser(
        description='Grant missed renewal credits for a specific date',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Dry run to preview
  uv run python core/utils/scripts/fix_missed_renewals.py --date 2025-12-04 --dry-run
  
  # Actually grant credits
  uv run python core/utils/scripts/fix_missed_renewals.py --date 2025-12-04
        """
    )
    parser.add_argument(
        '--date',
        type=str,
        required=True,
        help='Date of missed renewals in YYYY-MM-DD format (e.g., 2025-12-04)'
    )
    parser.add_argument(
        '--dry-run',
        action='store_true',
        help='Preview changes without applying them'
    )
    
    args = parser.parse_args()
    
    logger.info("="*80)
    logger.info(f"MISSED RENEWAL CREDITS RECOVERY")
    logger.info(f"Date: {args.date}")
    logger.info(f"Mode: {'DRY RUN' if args.dry_run else 'LIVE'}")
    logger.info("="*80)
    
    if args.dry_run:
        logger.info("\n⚠️  DRY RUN MODE - No changes will be made\n")
    
    try:
        await fix_missed_renewals(args.date, args.dry_run)
        
        logger.info("\n" + "="*80)
        logger.info("✅ RECOVERY COMPLETE")
        logger.info("="*80)
        
    except Exception as e:
        logger.error(f"❌ Fatal error: {e}", exc_info=True)
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())

