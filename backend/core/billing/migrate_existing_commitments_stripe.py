#!/usr/bin/env python3
"""
Migration script to track commitment plans by querying Stripe directly.

Usage:
    # Dry run - see what would be changed without making changes
    python -m core.billing.migrate_existing_commitments_stripe --dry-run
    
    # Apply the migration
    python -m core.billing.migrate_existing_commitments_stripe
    
    # Only verify existing commitments
    python -m core.billing.migrate_existing_commitments_stripe --verify-only
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

if config.STRIPE_SECRET_KEY:
    stripe.api_key = config.STRIPE_SECRET_KEY
else:
    logger.warning("[COMMITMENT MIGRATION] No STRIPE_SECRET_KEY configured")

async def migrate_existing_commitments(dry_run=False):
    db = DBConnection()
    client = await db.client
    
    mode = "DRY RUN" if dry_run else "LIVE"
    logger.info(f"[COMMITMENT MIGRATION] Starting migration of existing commitment users - {mode} MODE")
    
    if dry_run:
        logger.info("[COMMITMENT MIGRATION] ⚠️  DRY RUN - No changes will be made to the database")
    
    commitment_price_ids = [
        config.STRIPE_TIER_2_17_YEARLY_COMMITMENT_ID,
        config.STRIPE_TIER_6_42_YEARLY_COMMITMENT_ID,
        config.STRIPE_TIER_25_170_YEARLY_COMMITMENT_ID
    ]
    
    commitment_price_ids = [pid for pid in commitment_price_ids if pid]
    
    if not commitment_price_ids:
        logger.error("[COMMITMENT MIGRATION] No commitment price IDs configured!")
        return
    
    logger.info(f"[COMMITMENT MIGRATION] Looking for subscriptions with commitment price IDs: {commitment_price_ids}")
    
    logger.info("[COMMITMENT MIGRATION] Querying Stripe for ALL subscriptions to find commitments...")
    
    commitment_subscriptions = []
    migrated_count = 0
    error_count = 0
    skipped_count = 0
    accounts_to_migrate = []
    
    all_price_ids_seen = set()
    price_id_counts = {}
    
    try:
        has_more = True
        starting_after = None
        total_checked = 0
        
        while has_more:
            params = {
                'status': 'active',
                'limit': 100
            }
            if starting_after:
                params['starting_after'] = starting_after
            
            logger.info(f"[COMMITMENT MIGRATION] Fetching batch of subscriptions from Stripe (checked {total_checked} so far)...")
            subscriptions = await stripe.Subscription.list_async(**params)
            
            logger.info(f"[COMMITMENT MIGRATION] Retrieved {len(subscriptions.data)} subscriptions in this batch")
            
            for subscription in subscriptions.data:
                total_checked += 1
                
                try:
                    price_id = None
                    
                    if total_checked == 1:
                        logger.info(f"[COMMITMENT MIGRATION] First subscription structure: {type(subscription)}")
                        logger.info(f"[COMMITMENT MIGRATION] Subscription has items attr: {hasattr(subscription, 'items')}")
                        if hasattr(subscription, 'items'):
                            logger.info(f"[COMMITMENT MIGRATION] Items type: {type(subscription.items)}")
                    
                    if hasattr(subscription, 'items'):
                        items = subscription.items
                        if hasattr(items, 'data') and len(items.data) > 0:
                            price_id = items.data[0].price.id
                    
                    if not price_id:
                        continue
                    
                    all_price_ids_seen.add(price_id)
                    price_id_counts[price_id] = price_id_counts.get(price_id, 0) + 1
                    
                    if is_commitment_price_id(price_id):
                        commitment_subscriptions.append(subscription)
                        
                        account_id = subscription.metadata.get('account_id')
                        
                        if not account_id:
                            customer_result = await client.schema('basejump').from_('billing_customers')\
                                .select('account_id')\
                                .eq('id', subscription.customer)\
                                .execute()
                            
                            if customer_result.data:
                                account_id = customer_result.data[0]['account_id']
                        
                        if account_id:
                            logger.info(f"[COMMITMENT MIGRATION] Found commitment subscription: {subscription.id} for account: {account_id}, price: {price_id}")
                        else:
                            logger.warning(f"[COMMITMENT MIGRATION] Found commitment subscription {subscription.id} but couldn't determine account_id")
                            
                except Exception as e:
                    logger.warning(f"[COMMITMENT MIGRATION] Error processing subscription: {e}")
                    continue
            
            has_more = subscriptions.has_more
            if has_more and subscriptions.data:
                starting_after = subscriptions.data[-1].id
                
        logger.info(f"[COMMITMENT MIGRATION] Checked {total_checked} total subscriptions")
        logger.info(f"[COMMITMENT MIGRATION] Found {len(commitment_subscriptions)} commitment subscriptions")
        
        logger.info(f"[COMMITMENT MIGRATION] Found {len(all_price_ids_seen)} unique price IDs across all subscriptions")

        if price_id_counts:
            sorted_price_ids = sorted(price_id_counts.items(), key=lambda x: x[1], reverse=True)
            logger.info("[COMMITMENT MIGRATION] Top 10 most common price IDs:")
            for price_id, count in sorted_price_ids[:10]:
                is_commitment = is_commitment_price_id(price_id)
                marker = " ✓ COMMITMENT" if is_commitment else ""
                logger.info(f"  - {price_id}: {count} subscriptions{marker}")
                for commitment_id in commitment_price_ids:
                    if commitment_id and price_id and commitment_id[:10] in price_id:
                        logger.warning(f"    ⚠️  This looks similar to commitment ID: {commitment_id}")
        
        logger.info("[COMMITMENT MIGRATION] Checking commitment price ID configuration:")
        for cpid in commitment_price_ids:
            if cpid and cpid.startswith('price_'):
                is_recognized = is_commitment_price_id(cpid)
                if is_recognized:
                    logger.info(f"  ✓ {cpid} - recognized as commitment price ID by is_commitment_price_id()")
                else:
                    logger.error(f"  ✗ {cpid} - NOT recognized by is_commitment_price_id() function!")
            else:
                logger.warning(f"  ✗ {cpid} - doesn't look like valid Stripe price ID")
        
    except Exception as e:
        logger.error(f"[COMMITMENT MIGRATION] Error querying Stripe: {str(e)}")
        return
    
    if not commitment_subscriptions:
        logger.info("[COMMITMENT MIGRATION] No commitment subscriptions found in Stripe")
        return
    
    for subscription in commitment_subscriptions:
        try:
            account_id = subscription.metadata.get('account_id')
            
            if not account_id:
                customer_result = await client.schema('basejump').from_('billing_customers')\
                    .select('account_id')\
                    .eq('id', subscription.customer)\
                    .execute()
                
                if customer_result.data:
                    account_id = customer_result.data[0]['account_id']
                else:
                    logger.warning(f"[COMMITMENT MIGRATION] Cannot find account_id for subscription {subscription.id}")
                    error_count += 1
                    continue
            
            start_date = datetime.fromtimestamp(subscription.start_date, tz=timezone.utc)
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
            
            price_id = None
            if hasattr(subscription, 'items'):
                items = subscription.items
                if hasattr(items, 'data') and len(items.data) > 0:
                    price_id = items.data[0].price.id
            
            if not price_id:
                logger.warning(f"[COMMITMENT MIGRATION] Cannot get price_id for subscription {subscription.id}")
                error_count += 1
                continue
            
            if dry_run:
                logger.info(
                    f"[COMMITMENT MIGRATION] 🔍 Would migrate account {account_id}:\n"
                    f"  - Subscription ID: {subscription.id}\n"
                    f"  - Price ID: {price_id}\n"
                    f"  - Commitment start: {start_date.date()}\n"
                    f"  - Commitment end: {end_date.date()}\n"
                    f"  - Months remaining: {months_remaining}"
                )
                accounts_to_migrate.append({
                    'account_id': account_id,
                    'subscription_id': subscription.id,
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
                    'stripe_subscription_id': subscription.id
                }).execute()
                
                logger.info(
                    f"[COMMITMENT MIGRATION] ✅ Migrated account {account_id}: "
                    f"commitment ends {end_date.date()}, {months_remaining} months remaining"
                )
            
            migrated_count += 1
            
        except Exception as e:
            logger.error(f"[COMMITMENT MIGRATION] Error processing subscription {subscription.id}: {e}")
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
                    f"    - Subscription: {acc['subscription_id']}\n"
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

async def verify_commitment_tracking():
    db = DBConnection()
    client = await db.client
    
    logger.info("[COMMITMENT VERIFICATION] Starting verification...")
    
    commitment_price_ids = [
        config.STRIPE_TIER_2_17_YEARLY_COMMITMENT_ID,
        config.STRIPE_TIER_6_42_YEARLY_COMMITMENT_ID,
        config.STRIPE_TIER_25_170_YEARLY_COMMITMENT_ID
    ]
    commitment_price_ids = [pid for pid in commitment_price_ids if pid]
    
    tracked_accounts = await client.from_('credit_accounts').select(
        'account_id, stripe_subscription_id, commitment_type'
    ).not_.is_('commitment_type', 'null').execute()
    
    tracked_subscription_ids = set()
    if tracked_accounts.data:
        for acc in tracked_accounts.data:
            if acc.get('stripe_subscription_id'):
                tracked_subscription_ids.add(acc['stripe_subscription_id'])
    
    logger.info(f"[COMMITMENT VERIFICATION] Found {len(tracked_subscription_ids)} tracked commitment subscriptions in database")
    
    untracked = []
    has_more = True
    starting_after = None
    
    while has_more:
        params = {
            'status': 'active',
            'limit': 100
        }
        if starting_after:
            params['starting_after'] = starting_after
        
        subscriptions = await stripe.Subscription.list_async(**params)
        
        for subscription in subscriptions.data:
            price_id = None
            try:
                if hasattr(subscription, 'items'):
                    items = subscription.items
                    if hasattr(items, 'data') and len(items.data) > 0:
                        price_id = items.data[0].price.id
            except Exception:
                continue
            
            if price_id and is_commitment_price_id(price_id) and subscription.id not in tracked_subscription_ids:
                    untracked.append({
                        'subscription_id': subscription.id,
                        'price_id': price_id,
                        'customer': subscription.customer
                    })
        
        has_more = subscriptions.has_more
        if has_more and subscriptions.data:
            starting_after = subscriptions.data[-1].id
    
    if untracked:
        logger.warning(f"[COMMITMENT VERIFICATION] Found {len(untracked)} untracked commitment subscriptions:")
        for item in untracked:
            logger.warning(f"  - Subscription {item['subscription_id']}: {item['price_id']}")
    else:
        logger.info("[COMMITMENT VERIFICATION] ✅ All commitment subscriptions are properly tracked")

async def main(dry_run=False):
    try:
        await migrate_existing_commitments(dry_run=dry_run)
        if not dry_run:
            await verify_commitment_tracking()
    except Exception as e:
        logger.error(f"[COMMITMENT MIGRATION] Fatal error: {e}")
        raise

async def list_all_price_ids():
    logger.info("[PRICE ID DISCOVERY] Fetching all active subscriptions from Stripe...")
    
    price_id_counts = {}
    total_checked = 0
    has_more = True
    starting_after = None
    
    while has_more:
        params = {
            'status': 'active',
            'limit': 100
        }
        if starting_after:
            params['starting_after'] = starting_after
        
        subscriptions = await stripe.Subscription.list_async(**params)
        
        for subscription in subscriptions.data:
            total_checked += 1
            try:
                if hasattr(subscription, 'items'):
                    items = subscription.items
                    if hasattr(items, 'data') and len(items.data) > 0:
                        price_id = items.data[0].price.id
                        price_id_counts[price_id] = price_id_counts.get(price_id, 0) + 1
            except Exception:
                continue
        
        has_more = subscriptions.has_more
        if has_more and subscriptions.data:
            starting_after = subscriptions.data[-1].id
    
    logger.info(f"[PRICE ID DISCOVERY] Checked {total_checked} subscriptions")
    logger.info(f"[PRICE ID DISCOVERY] Found {len(price_id_counts)} unique price IDs")
    
    sorted_price_ids = sorted(price_id_counts.items(), key=lambda x: x[1], reverse=True)
    logger.info("[PRICE ID DISCOVERY] All price IDs (sorted by usage):")
    for price_id, count in sorted_price_ids:
        logger.info(f"  {price_id}: {count} subscriptions")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description='Migrate existing commitment plan users by querying Stripe directly'
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
    parser.add_argument(
        '--list-price-ids',
        action='store_true',
        help='List all price IDs from Stripe (for debugging)'
    )
    
    args = parser.parse_args()
    
    if args.list_price_ids:
        asyncio.run(list_all_price_ids())
    elif args.verify_only:
        asyncio.run(verify_commitment_tracking())
    else:
        asyncio.run(main(dry_run=args.dry_run))
