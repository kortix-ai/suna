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

Convex Endpoints Required:
  - admin:list_credit_accounts_by_tier - List credit accounts filtered by tier
  - admin:list_credit_accounts_by_date - List credit accounts by date range
  - admin:list_credit_accounts_with_subscription - List accounts with subscription filters
  - get_credit_account - Get credit account by account_id
  - upsert_credit_account - Create/update credit account
  - add_credits - Add credits to account
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
from core.services.convex_client import get_convex_client
from core.utils.config import config
from core.utils.logger import logger
from core.billing.shared.config import get_tier_by_price_id, get_plan_type
from dateutil.relativedelta import relativedelta

stripe.api_key = config.STRIPE_SECRET_KEY


class MissedWebhookRecovery:
    """Recovery service for missed webhooks.
    
    Uses Convex endpoints:
      - admin:list_credit_accounts_by_tier
      - admin:list_credit_accounts_by_date
      - admin:list_credit_accounts_with_subscription
      - get_credit_account
      - upsert_credit_account
      - add_credits
    """
    
    def __init__(self):
        self.convex = get_convex_client()
        self.stats = {
            'processed': 0,
            'fixed': 0,
            'credits_granted': 0,
            'errors': 0,
        }
    
    async def fix_new_signups(self, target_date: str, dry_run: bool = False):
        """Fix users stuck on 'none' tier who have active Stripe subscriptions.
        
        Requires Convex endpoint: admin:list_credit_accounts_by_tier
        """
        logger.info("="*80)
        logger.info("FIXING NEW SIGNUPS (stuck on 'none' tier)")
        logger.info("="*80)
        
        try:
            # Get accounts with tier='none'
            result = await self.convex.admin_rpc("list_credit_accounts_by_tier", {
                "tier": "none",
                "limit": 1000
            })
            
            accounts = result.get('accounts', []) if result else []
            logger.info(f"Found {len(accounts)} accounts with tier='none'")
            
            for account in accounts:
                account_id = account.get('account_id')
                
                # Check Stripe for active subscription
                try:
                    # Get billing customer
                    billing_result = await self.convex.admin_rpc("get_billing_customer", {
                        "account_id": account_id
                    })
                    
                    if not billing_result:
                        continue
                    
                    stripe_customer_id = billing_result.get('id')
                    
                    subscriptions = stripe.Subscription.list(
                        customer=stripe_customer_id,
                        status='active',
                        limit=1
                    )
                    
                    if not subscriptions.data:
                        continue
                    
                    subscription = subscriptions.data[0]
                    price_id = subscription['items']['data'][0]['price']['id']
                    
                    tier = get_tier_by_price_id(price_id)
                    if not tier:
                        logger.warning(f"Unknown price {price_id} for {account_id}")
                        continue
                    
                    logger.info(f"Found active subscription for {account_id}: {tier.name}")
                    
                    if dry_run:
                        logger.info(f"[DRY RUN] Would fix {account_id}: tier={tier.name}")
                        self.stats['processed'] += 1
                        continue
                    
                    # Update account
                    await self.convex.upsert_credit_account(
                        account_id=account_id,
                        tier=tier.name,
                        stripe_subscription_id=subscription.id,
                        billing_cycle_anchor=datetime.fromtimestamp(
                            subscription.current_period_start, tz=timezone.utc
                        ).isoformat(),
                        next_credit_grant=datetime.fromtimestamp(
                            subscription.current_period_end, tz=timezone.utc
                        ).isoformat(),
                    )
                    
                    # Grant credits
                    await self.convex.add_credits(
                        account_id=account_id,
                        amount=int(tier.monthly_credits),
                        description=f"Webhook recovery: Initial credits for {tier.display_name}",
                        credit_type="webhook_recovery"
                    )
                    
                    self.stats['fixed'] += 1
                    self.stats['credits_granted'] += 1
                    logger.info(f"✅ Fixed {account_id}")
                    
                except Exception as e:
                    self.stats['errors'] += 1
                    logger.error(f"Error processing {account_id}: {e}")
                    
        except Exception as e:
            logger.error(f"Error in fix_new_signups: {e}")
    
    async def fix_renewals(self, target_date: str, dry_run: bool = False):
        """Fix users who should have received renewal credits on target date but didn't.
        
        Requires Convex endpoint: admin:list_credit_accounts_by_date
        """
        logger.info("="*80)
        logger.info("FIXING RENEWALS (missing credit grants)")
        logger.info("="*80)
        
        try:
            # Parse target date
            date = datetime.strptime(target_date, "%Y-%m-%d").replace(tzinfo=timezone.utc)
            date_start = date
            date_end = date + timedelta(days=1)
            
            # Get accounts with next_credit_grant on target date
            result = await self.convex.admin_rpc("list_credit_accounts_by_date", {
                "field": "next_credit_grant",
                "start": date_start.isoformat(),
                "end": date_end.isoformat(),
                "limit": 1000
            })
            
            accounts = result.get('accounts', []) if result else []
            logger.info(f"Found {len(accounts)} accounts with renewal on {target_date}")
            
            for account in accounts:
                account_id = account.get('account_id')
                tier_name = account.get('tier')
                
                if not tier_name or tier_name == 'none':
                    continue
                
                # Check if credits were already granted
                # Look for credit transactions on the target date
                transactions = await self.convex.get_credit_transactions(
                    account_id=account_id,
                    limit=10
                )
                
                # Check if renewal was already processed
                already_processed = False
                for tx in transactions:
                    tx_date = datetime.fromisoformat(tx.get('created_at', '').replace('Z', '+00:00'))
                    if tx_date.date() == date.date() and 'renewal' in tx.get('description', '').lower():
                        already_processed = True
                        break
                
                if already_processed:
                    logger.debug(f"Renewal already processed for {account_id}")
                    continue
                
                from core.billing.shared.config import get_tier_by_name
                tier = get_tier_by_name(tier_name)
                
                if not tier:
                    logger.warning(f"Unknown tier {tier_name} for {account_id}")
                    continue
                
                logger.info(f"Missing renewal for {account_id}: ${tier.monthly_credits}")
                
                if dry_run:
                    logger.info(f"[DRY RUN] Would grant ${tier.monthly_credits} to {account_id}")
                    self.stats['processed'] += 1
                    continue
                
                # Grant renewal credits
                await self.convex.add_credits(
                    account_id=account_id,
                    amount=int(tier.monthly_credits),
                    description=f"Webhook recovery: Renewal credits for {tier.display_name}",
                    credit_type="renewal"
                )
                
                # Update next_credit_grant
                await self.convex.upsert_credit_account(
                    account_id=account_id,
                    next_credit_grant=(date + relativedelta(months=1)).isoformat()
                )
                
                self.stats['fixed'] += 1
                self.stats['credits_granted'] += 1
                logger.info(f"✅ Granted renewal credits to {account_id}")
                
        except Exception as e:
            logger.error(f"Error in fix_renewals: {e}")
    
    async def fix_upgrades(self, target_date: str, dry_run: bool = False):
        """Fix users whose actual Stripe subscription doesn't match their database tier.
        
        Requires Convex endpoint: admin:list_credit_accounts_with_subscription
        """
        logger.info("="*80)
        logger.info("FIXING UPGRADES (tier mismatches)")
        logger.info("="*80)
        
        try:
            # Get accounts with subscription
            result = await self.convex.admin_rpc("list_credit_accounts_with_subscription", {
                "limit": 1000
            })
            
            accounts = result.get('accounts', []) if result else []
            logger.info(f"Found {len(accounts)} accounts with subscriptions")
            
            for account in accounts:
                account_id = account.get('account_id')
                db_tier = account.get('tier')
                stripe_subscription_id = account.get('stripe_subscription_id')
                
                if not stripe_subscription_id:
                    continue
                
                try:
                    # Get actual subscription from Stripe
                    subscription = stripe.Subscription.retrieve(stripe_subscription_id)
                    
                    if subscription.status != 'active':
                        continue
                    
                    price_id = subscription['items']['data'][0]['price']['id']
                    actual_tier = get_tier_by_price_id(price_id)
                    
                    if not actual_tier:
                        continue
                    
                    if db_tier != actual_tier.name:
                        logger.info(f"Tier mismatch for {account_id}: DB={db_tier}, Stripe={actual_tier.name}")
                        
                        if dry_run:
                            logger.info(f"[DRY RUN] Would upgrade {account_id}: {db_tier} → {actual_tier.name}")
                            self.stats['processed'] += 1
                            continue
                        
                        # Update tier
                        await self.convex.upsert_credit_account(
                            account_id=account_id,
                            tier=actual_tier.name,
                            next_credit_grant=datetime.fromtimestamp(
                                subscription.current_period_end, tz=timezone.utc
                            ).isoformat()
                        )
                        
                        # Grant new tier credits
                        await self.convex.add_credits(
                            account_id=account_id,
                            amount=int(actual_tier.monthly_credits),
                            description=f"Webhook recovery: Upgrade to {actual_tier.display_name}",
                            credit_type="upgrade"
                        )
                        
                        self.stats['fixed'] += 1
                        self.stats['credits_granted'] += 1
                        logger.info(f"✅ Upgraded {account_id}: {db_tier} → {actual_tier.name}")
                        
                except Exception as e:
                    self.stats['errors'] += 1
                    logger.error(f"Error checking {account_id}: {e}")
                    
        except Exception as e:
            logger.error(f"Error in fix_upgrades: {e}")
    
    async def run(self, target_date: str, dry_run: bool = False, only: str = None):
        """Run the recovery process."""
        logger.info("="*80)
        logger.info("MISSED WEBHOOK RECOVERY")
        logger.info(f"Date: {target_date}")
        logger.info(f"Mode: {'DRY RUN' if dry_run else 'LIVE'}")
        logger.info(f"Types: {only if only else 'ALL'}")
        logger.info("="*80 + "\n")
        
        if not only or only == 'signups':
            await self.fix_new_signups(target_date, dry_run)
        
        if not only or only == 'renewals':
            await self.fix_renewals(target_date, dry_run)
        
        if not only or only == 'upgrades':
            await self.fix_upgrades(target_date, dry_run)
        
        # Summary
        logger.info("\n" + "="*80)
        logger.info("RECOVERY COMPLETE")
        logger.info("="*80)
        logger.info(f"Processed: {self.stats['processed']}")
        logger.info(f"Fixed: {self.stats['fixed']}")
        logger.info(f"Credits granted: {self.stats['credits_granted']}")
        logger.info(f"Errors: {self.stats['errors']}")
        logger.info("="*80)


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
    
    recovery = MissedWebhookRecovery()
    
    try:
        await recovery.run(args.date, args.dry_run, args.only)
    except Exception as e:
        logger.error(f"❌ Fatal error: {e}", exc_info=True)
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
