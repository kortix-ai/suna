#!/usr/bin/env python3
"""
Migration script to track commitment plans for existing users.

Usage:
    # Dry run - see what would be changed without making changes
    python -m core.billing.migrate_existing_commitments --dry-run
    
    # Apply the migration
    python -m core.billing.migrate_existing_commitments
    
    # Only verify existing commitments
    python -m core.billing.migrate_existing_commitments --verify-only
"""
import asyncio
import sys
import argparse
import stripe
from datetime import datetime, timezone, timedelta
from core.services.supabase import DBConnection
from core.utils.config import config
from core.utils.logger import logger
from .config import is_commitment_price_id, get_commitment_duration_months

stripe.api_key = config.STRIPE_SECRET_KEY

async def migrate_existing_commitments(dry_run=False):
    db = DBConnection()
    client = await db.client
    
    mode = "DRY RUN" if dry_run else "LIVE"
    logger.info(f"[COMMITMENT MIGRATION] Starting migration of existing commitment users - {mode} MODE")
    
    if dry_run:
        logger.info("[COMMITMENT MIGRATION] ⚠️  DRY RUN - No changes will be made to the database")
    
    result = await client.from_('credit_accounts').select(
        'account_id, stripe_subscription_id, tier, created_at'
    ).not_.is_('stripe_subscription_id', 'null').execute()
    
    if not result.data:
        logger.info("[COMMITMENT MIGRATION] No active subscriptions found")
        return
    
    migrated_count = 0
    error_count = 0
    skipped_count = 0
    accounts_to_migrate = []
    
    for account in result.data:
        account_id = account['account_id']
        subscription_id = account['stripe_subscription_id']
        
        if not subscription_id:
            continue
        
        try:
            subscription = await stripe.Subscription.retrieve_async(subscription_id)
            
            if subscription.status not in ['active', 'trialing']:
                continue
            
            price_id = subscription['items']['data'][0]['price']['id'] if subscription.get('items') else None
            
            if not price_id:
                continue
            
            if is_commitment_price_id(price_id):
                commitment_duration = get_commitment_duration_months(price_id)
                
                start_date = datetime.fromtimestamp(subscription['start_date'], tz=timezone.utc)
                
                end_date = start_date + timedelta(days=365)
                
                existing = await client.from_('credit_accounts').select(
                    'commitment_type'
                ).eq('account_id', account_id).execute()
                
                if existing.data and existing.data[0].get('commitment_type'):
                    logger.info(f"[COMMITMENT MIGRATION] Account {account_id} already has commitment tracked, skipping")
                    skipped_count += 1
                    continue
                
                months_remaining = (end_date.year - datetime.now(timezone.utc).year) * 12 + \
                                 (end_date.month - datetime.now(timezone.utc).month)
                
                if dry_run:
                    logger.info(
                        f"[COMMITMENT MIGRATION] 🔍 Would migrate account {account_id}:\n"
                        f"  - Price ID: {price_id}\n"
                        f"  - Commitment start: {start_date.date()}\n"
                        f"  - Commitment end: {end_date.date()}\n"
                        f"  - Months remaining: {months_remaining}"
                    )
                    accounts_to_migrate.append({
                        'account_id': account_id,
                        'price_id': price_id,
                        'end_date': end_date.date(),
                        'months_remaining': months_remaining
                    })
                else:
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
                        'stripe_subscription_id': subscription_id
                    }).execute()
                    
                    logger.info(
                        f"[COMMITMENT MIGRATION] ✅ Migrated account {account_id}: "
                        f"commitment ends {end_date.date()}, {months_remaining} months remaining"
                    )
                
                migrated_count += 1
                
        except Exception as e:
            logger.error(f"[COMMITMENT MIGRATION] Error processing account {account_id}: {e}")
            error_count += 1
            continue
    
    action = "Would migrate" if dry_run else "Migrated"
    logger.info(
        f"[COMMITMENT MIGRATION] Migration {'simulation' if dry_run else 'complete'}. "
        f"{action}: {migrated_count}, Skipped: {skipped_count}, Errors: {error_count}"
    )
    
    if dry_run:
        logger.info("[COMMITMENT MIGRATION] ⚠️  This was a DRY RUN - no changes were made")
        logger.info("[COMMITMENT MIGRATION] To apply changes, run without --dry-run flag")
        
        if accounts_to_migrate:
            logger.info("\n[COMMITMENT MIGRATION] Summary of accounts that would be migrated:")
            logger.info("=" * 70)
            for acc in accounts_to_migrate:
                logger.info(
                    f"  Account: {acc['account_id']}\n"
                    f"    - Commitment ends: {acc['end_date']}\n"
                    f"    - Months remaining: {acc['months_remaining']}\n"
                    f"    - Price ID: {acc['price_id']}"
                )
            logger.info("=" * 70)
            logger.info(f"Total accounts that would be migrated: {len(accounts_to_migrate)}")
    else:
        commitment_accounts = await client.from_('credit_accounts').select(
            'account_id, commitment_type, commitment_end_date'
        ).not_.is_('commitment_type', 'null').execute()
        
        if commitment_accounts.data:
            logger.info(f"[COMMITMENT MIGRATION] Total accounts with commitments: {len(commitment_accounts.data)}")
            for acc in commitment_accounts.data:
                end_date = acc.get('commitment_end_date')
                if end_date:
                    logger.info(f"  - Account {acc['account_id']}: ends {end_date}")

async def verify_commitment_tracking():
    db = DBConnection()
    client = await db.client
    
    result = await client.from_('credit_accounts').select(
        'account_id, stripe_subscription_id, commitment_type'
    ).not_.is_('stripe_subscription_id', 'null').execute()
    
    untracked = []
    
    for account in result.data:
        if not account.get('commitment_type'):
            subscription_id = account['stripe_subscription_id']
            try:
                subscription = await stripe.Subscription.retrieve_async(subscription_id)
                price_id = subscription['items']['data'][0]['price']['id'] if subscription.get('items') else None
                
                if price_id and is_commitment_price_id(price_id):
                    untracked.append({
                        'account_id': account['account_id'],
                        'price_id': price_id,
                        'subscription_id': subscription_id
                    })
            except Exception:
                continue
    
    if untracked:
        logger.warning(f"[COMMITMENT VERIFICATION] Found {len(untracked)} untracked commitment accounts:")
        for item in untracked:
            logger.warning(f"  - Account {item['account_id']}: {item['price_id']}")
    else:
        logger.info("[COMMITMENT VERIFICATION] All commitment accounts are properly tracked")

async def main(dry_run=False):
    try:
        await migrate_existing_commitments(dry_run=dry_run)
        if not dry_run:
            await verify_commitment_tracking()
    except Exception as e:
        logger.error(f"[COMMITMENT MIGRATION] Fatal error: {e}")
        raise

if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description='Migrate existing commitment plan users to track their commitments'
    )
    parser.add_argument(
        '--dry-run',
        action='store_true',
        help='Run in dry-run mode (no database changes)'
    )
    parser.add_argument(
        '--verify-only',
        action='store_true',
        help='Only verify existing commitments without migrating'
    )
    
    args = parser.parse_args()
    
    if args.verify_only:
        asyncio.run(verify_commitment_tracking())
    else:
        asyncio.run(main(dry_run=args.dry_run))
