#!/usr/bin/env python3
"""
Script to fix users affected by missed webhooks due to endpoint change.

Handles three types of affected users:
1. New signups who didn't get tier set up (stuck on 'none' tier)
2. Users who had renewals and didn't receive credits
3. Users who upgraded and didn't get tier updated

Usage:
    uv run python core/utils/scripts/fix_missed_webhooks.py --date 2025-12-04
    uv run python core/utils/scripts/fix_missed_webhooks.py --date 2025-12-04 --dry-run
    uv run python core/utils/scripts/fix_missed_webhooks.py --date 2025-12-04 --only signups
    uv run python core/utils/scripts/fix_missed_webhooks.py --date 2025-12-04 --only renewals
    uv run python core/utils/scripts/fix_missed_webhooks.py --date 2025-12-04 --only upgrades
"""

import asyncio
import sys
import argparse
from pathlib import Path
from datetime import datetime, timezone, timedelta
from decimal import Decimal
from typing import List, Dict

backend_dir = Path(__file__).parent.parent.parent.parent
sys.path.insert(0, str(backend_dir))

import stripe
from core.services.supabase import DBConnection
from core.utils.config import config
from core.utils.logger import logger
from core.billing.shared.config import get_tier_by_price_id, get_plan_type
from core.billing.credits.manager import credit_manager
from dateutil.relativedelta import relativedelta

stripe.api_key = config.STRIPE_SECRET_KEY


async def fix_new_signups(target_date: str, dry_run: bool = False):
    """Fix users stuck on 'none' tier who have active Stripe subscriptions."""
    logger.info("="*80)
    logger.info(f"FIXING USERS STUCK ON 'NONE' TIER")
    logger.info("="*80)
    
    db = DBConnection()
    await db.initialize()
    client = await db.client
    
    logger.info("Searching database for users stuck on 'none' tier with active Stripe subscriptions...")
    
    batch_size = 1000
    offset = 0
    fixed_count = 0
    skipped_count = 0
    total_checked = 0
    
    while True:
        # Get users with tier='none' who have a stripe_subscription_id
        affected_users = await client.from_('credit_accounts').select(
            'account_id, tier, stripe_subscription_id, stripe_subscription_status, balance'
        ).eq('tier', 'none').not_.is_('stripe_subscription_id', 'null').range(
            offset, offset + batch_size - 1
        ).execute()
        
        if not affected_users.data:
            break
        
        logger.info(f"\nBatch {offset//batch_size + 1}: Processing {len(affected_users.data)} users...")
        
        for user_data in affected_users.data:
            total_checked += 1
            try:
                account_id = user_data['account_id']
                current_sub_id = user_data.get('stripe_subscription_id')
                
                # Fetch subscription from Stripe
                try:
                    subscription = await stripe.Subscription.retrieve_async(
                        current_sub_id,
                        expand=['items.data.price']
                    )
                except Exception as e:
                    logger.warning(f"⚠️  Could not fetch subscription {current_sub_id} for {account_id}: {e}")
                    skipped_count += 1
                    continue
                
                if subscription.status not in ['active', 'trialing', 'past_due']:
                    skipped_count += 1
                    continue
                
                # Get price info
                items = subscription.get('items')
                if not items or not items.get('data'):
                    logger.warning(f"⚠️  Subscription {current_sub_id} has no items")
                    skipped_count += 1
                    continue
                
                price_id = items['data'][0]['price']['id']
                tier_info = get_tier_by_price_id(price_id)
                
                if not tier_info:
                    logger.warning(f"⚠️  Unknown price_id {price_id} for subscription {current_sub_id}")
                    skipped_count += 1
                    continue
                
                logger.info(f"{'[DRY RUN] ' if dry_run else ''}Fixing {account_id}: tier=none -> {tier_info.name}")
                
                if not dry_run:
                    # Set up subscription
                    billing_anchor = datetime.fromtimestamp(subscription.current_period_start, tz=timezone.utc)
                    next_grant_date = datetime.fromtimestamp(subscription.current_period_end, tz=timezone.utc)
                    plan_type = get_plan_type(price_id)
                    
                    if plan_type == 'yearly':
                        next_grant_date = billing_anchor + relativedelta(months=1)
                    
                    # Update tier
                    await client.from_('credit_accounts').update({
                        'tier': tier_info.name,
                        'plan_type': plan_type,
                        'stripe_subscription_status': subscription.status,
                        'billing_cycle_anchor': billing_anchor.isoformat(),
                        'next_credit_grant': next_grant_date.isoformat(),
                        'last_grant_date': billing_anchor.isoformat()
                    }).eq('account_id', account_id).execute()
                    
                    # Grant initial credits if needed
                    current_balance = Decimal(str(user_data.get('balance', 0)))
                    if tier_info.monthly_refill_enabled and current_balance < Decimal('1.0'):
                        await credit_manager.add_credits(
                            account_id=account_id,
                            amount=tier_info.monthly_credits,
                            is_expiring=True,
                            description=f"Initial credits for {tier_info.display_name} (missed webhook recovery)",
                            expires_at=next_grant_date
                        )
                        logger.info(f"  ✅ Granted ${tier_info.monthly_credits} credits")
                
                fixed_count += 1
                
            except Exception as e:
                logger.error(f"❌ Error processing {account_id}: {e}", exc_info=True)
                continue
        
        offset += batch_size
        
        if len(affected_users.data) < batch_size:
            break
    
    logger.info(f"\n{'[DRY RUN] ' if dry_run else ''}Summary:")
    logger.info(f"  Total checked: {total_checked}")
    logger.info(f"  Skipped: {skipped_count}")
    logger.info(f"  Fixed: {fixed_count}")


async def fix_renewals(target_date: str, dry_run: bool = False):
    """Fix users who should have received renewal credits on target date but didn't."""
    logger.info("="*80)
    logger.info(f"FIXING MISSED RENEWALS FOR {target_date}")
    logger.info("="*80)
    
    db = DBConnection()
    await db.initialize()
    client = await db.client
    
    # Parse target date
    start_of_day = datetime.strptime(target_date, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    end_of_day = start_of_day + timedelta(days=1)
    
    logger.info(f"Searching for users whose next_credit_grant was on {target_date} but weren't processed...")
    
    batch_size = 1000
    offset = 0
    fixed_count = 0
    skipped_count = 0
    total_checked = 0
    
    while True:
        # Find users whose next_credit_grant was on target date
        # AND last_grant_date is NOT on target date (meaning they didn't get credited)
        affected_users = await client.from_('credit_accounts').select(
            'account_id, tier, stripe_subscription_id, next_credit_grant, last_grant_date, balance'
        ).gte('next_credit_grant', start_of_day.isoformat()).lt(
            'next_credit_grant', end_of_day.isoformat()
        ).not_.is_('stripe_subscription_id', 'null').not_.in_('tier', ['none', 'free']).range(
            offset, offset + batch_size - 1
        ).execute()
        
        if not affected_users.data:
            break
        
        logger.info(f"\nBatch {offset//batch_size + 1}: Processing {len(affected_users.data)} users...")
        
        for user_data in affected_users.data:
            total_checked += 1
            try:
                account_id = user_data['account_id']
                tier_name = user_data['tier']
                last_grant = user_data.get('last_grant_date')
                
                # Check if they already got credited on target date
                if last_grant:
                    last_grant_date = datetime.fromisoformat(last_grant.replace('Z', '+00:00'))
                    if start_of_day <= last_grant_date < end_of_day:
                        # Already got credits
                        skipped_count += 1
                        continue
                
                # Get tier info
                tier_info = get_tier_by_price_id(None)
                # We need to look up by tier name since we don't have price_id
                from core.billing.shared.config import get_tier_by_name
                tier_info = get_tier_by_name(tier_name)
                
                if not tier_info or not tier_info.monthly_refill_enabled:
                    skipped_count += 1
                    continue
                
                # Fetch subscription to get current period
                current_sub_id = user_data.get('stripe_subscription_id')
                try:
                    subscription = await stripe.Subscription.retrieve_async(
                        current_sub_id,
                        expand=['items.data.price']
                    )
                except Exception as e:
                    logger.warning(f"⚠️  Could not fetch subscription {current_sub_id} for {account_id}: {e}")
                    skipped_count += 1
                    continue
                
                logger.info(f"{'[DRY RUN] ' if dry_run else ''}Granting missed renewal for {account_id}: {tier_info.name}, ${tier_info.monthly_credits}")
                
                if not dry_run:
                    # Grant renewal credits
                    next_grant_date = datetime.fromtimestamp(subscription.current_period_end, tz=timezone.utc)
                    items = subscription.get('items')
                    if items and items.get('data'):
                        price_id = items['data'][0]['price']['id']
                        plan_type = get_plan_type(price_id)
                    else:
                        plan_type = 'monthly'
                    
                    if plan_type == 'yearly':
                        billing_anchor = datetime.fromtimestamp(subscription.current_period_start, tz=timezone.utc)
                        last_grant_dt = datetime.fromisoformat(last_grant.replace('Z', '+00:00')) if last_grant else billing_anchor
                        next_grant_date = last_grant_dt + relativedelta(months=1)
                    
                    await credit_manager.add_credits(
                        account_id=account_id,
                        amount=tier_info.monthly_credits,
                        is_expiring=True,
                        description=f"Monthly renewal for {tier_info.display_name} (missed webhook recovery {target_date})",
                        expires_at=next_grant_date
                    )
                    
                    # Update last processed
                    await client.from_('credit_accounts').update({
                        'last_grant_date': start_of_day.isoformat(),
                        'next_credit_grant': next_grant_date.isoformat()
                    }).eq('account_id', account_id).execute()
                    
                    logger.info(f"  ✅ Granted ${tier_info.monthly_credits} credits")
                
                fixed_count += 1
                
            except Exception as e:
                logger.error(f"❌ Error processing {account_id}: {e}", exc_info=True)
                continue
        
        offset += batch_size
        
        if len(affected_users.data) < batch_size:
            break
    
    logger.info(f"\n{'[DRY RUN] ' if dry_run else ''}Summary:")
    logger.info(f"  Total checked: {total_checked}")
    logger.info(f"  Skipped: {skipped_count}")
    logger.info(f"  Fixed: {fixed_count}")


async def fix_upgrades(target_date: str, dry_run: bool = False):
    """Fix users whose actual Stripe subscription doesn't match their database tier."""
    logger.info("="*80)
    logger.info(f"FIXING TIER MISMATCHES")
    logger.info("="*80)
    
    db = DBConnection()
    await db.initialize()
    client = await db.client
    
    logger.info("Searching for users whose DB tier doesn't match their Stripe subscription...")
    
    batch_size = 1000
    offset = 0
    fixed_count = 0
    skipped_count = 0
    total_checked = 0
    
    while True:
        # Get all users with active subscriptions
        users = await client.from_('credit_accounts').select(
            'account_id, tier, stripe_subscription_id'
        ).not_.is_('stripe_subscription_id', 'null').not_.in_('tier', ['none']).range(
            offset, offset + batch_size - 1
        ).execute()
        
        if not users.data:
            break
        
        logger.info(f"\nBatch {offset//batch_size + 1}: Checking {len(users.data)} users...")
        
        for user_data in users.data:
            total_checked += 1
            try:
                account_id = user_data['account_id']
                db_tier = user_data['tier']
                current_sub_id = user_data.get('stripe_subscription_id')
                
                # Fetch actual subscription from Stripe
                try:
                    subscription = await stripe.Subscription.retrieve_async(
                        current_sub_id,
                        expand=['items.data.price']
                    )
                except Exception as e:
                    logger.warning(f"⚠️  Could not fetch subscription {current_sub_id} for {account_id}: {e}")
                    skipped_count += 1
                    continue
                
                if subscription.status not in ['active', 'trialing', 'past_due']:
                    skipped_count += 1
                    continue
                
                items = subscription.get('items')
                if not items or not items.get('data'):
                    skipped_count += 1
                    continue
                
                price_id = items['data'][0]['price']['id']
                tier_info = get_tier_by_price_id(price_id)
                
                if not tier_info:
                    skipped_count += 1
                    continue
                
                # Check if tier matches
                if db_tier == tier_info.name:
                    skipped_count += 1
                    continue
                
                logger.info(f"{'[DRY RUN] ' if dry_run else ''}Fixing tier mismatch for {account_id}: {db_tier} -> {tier_info.name}")
                
                if not dry_run:
                    # Update tier
                    billing_anchor = datetime.fromtimestamp(subscription.current_period_start, tz=timezone.utc)
                    next_grant_date = datetime.fromtimestamp(subscription.current_period_end, tz=timezone.utc)
                    plan_type = get_plan_type(price_id)
                    
                    if plan_type == 'yearly':
                        next_grant_date = billing_anchor + relativedelta(months=1)
                    
                    await client.from_('credit_accounts').update({
                        'tier': tier_info.name,
                        'plan_type': plan_type,
                        'billing_cycle_anchor': billing_anchor.isoformat(),
                        'next_credit_grant': next_grant_date.isoformat()
                    }).eq('account_id', account_id).execute()
                    
                    # Replace credits if this was an upgrade
                    if tier_info.monthly_refill_enabled:
                        import time
                        unique_id = f"upgrade_recovery_{account_id}_{tier_info.name}_{int(time.time())}"
                        
                        await credit_manager.reset_expiring_credits(
                            account_id=account_id,
                            new_credits=Decimal(str(tier_info.monthly_credits)),
                            description=f"Tier correction to {tier_info.display_name} (missed webhook recovery)",
                            stripe_event_id=unique_id
                        )
                        logger.info(f"  ✅ Updated credits to ${tier_info.monthly_credits}")
                
                fixed_count += 1
                
            except Exception as e:
                logger.error(f"❌ Error processing {account_id}: {e}", exc_info=True)
                continue
        
        offset += batch_size
        
        if len(users.data) < batch_size:
            break
    
    logger.info(f"\n{'[DRY RUN] ' if dry_run else ''}Summary:")
    logger.info(f"  Total checked: {total_checked}")
    logger.info(f"  Skipped (already correct): {skipped_count}")
    logger.info(f"  Fixed: {fixed_count}")


async def main():
    parser = argparse.ArgumentParser(
        description='Fix users affected by missed webhooks due to endpoint change',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Dry run for all types
  uv run python core/utils/scripts/fix_missed_webhooks.py --date 2025-12-04 --dry-run
  
  # Fix only new signups
  uv run python core/utils/scripts/fix_missed_webhooks.py --date 2025-12-04 --only signups
  
  # Fix all types for real
  uv run python core/utils/scripts/fix_missed_webhooks.py --date 2025-12-04
        """
    )
    parser.add_argument(
        '--date',
        type=str,
        required=True,
        help='Date to process in YYYY-MM-DD format (e.g., 2025-12-04)'
    )
    parser.add_argument(
        '--dry-run',
        action='store_true',
        help='Preview changes without applying them'
    )
    parser.add_argument(
        '--only',
        type=str,
        choices=['signups', 'renewals', 'upgrades'],
        help='Only process specific type of affected users'
    )
    
    args = parser.parse_args()
    
    logger.info("="*80)
    logger.info(f"MISSED WEBHOOK RECOVERY SCRIPT")
    logger.info(f"Date: {args.date}")
    logger.info(f"Mode: {'DRY RUN' if args.dry_run else 'LIVE'}")
    logger.info(f"Types: {args.only if args.only else 'ALL'}")
    logger.info("="*80)
    
    if args.dry_run:
        logger.info("\n⚠️  DRY RUN MODE - No changes will be made\n")
    
    try:
        if not args.only or args.only == 'signups':
            await fix_new_signups(args.date, args.dry_run)
        
        if not args.only or args.only == 'renewals':
            await fix_renewals(args.date, args.dry_run)
        
        if not args.only or args.only == 'upgrades':
            await fix_upgrades(args.date, args.dry_run)
        
        logger.info("\n" + "="*80)
        logger.info("✅ RECOVERY COMPLETE")
        logger.info("="*80)
        
    except Exception as e:
        logger.error(f"❌ Fatal error: {e}", exc_info=True)
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
