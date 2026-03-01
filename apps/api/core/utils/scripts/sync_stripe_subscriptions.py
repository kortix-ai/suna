#!/usr/bin/env python3
"""
Stripe Subscription Sync

Syncs all Stripe subscriptions to Convex credit accounts.

Convex Endpoints Required:
  - admin:list_billing_customers - List all billing customers
  - get_credit_account - Get credit account by account_id
  - upsert_credit_account - Create/update credit account
  - admin:list_credit_purchases - Get purchase history for account
  - add_credits - Add credits to account
"""
import asyncio
import sys
from pathlib import Path
from typing import List, Dict, Any
from datetime import datetime, timezone
from decimal import Decimal
import time

backend_dir = Path(__file__).parent.parent.parent
sys.path.insert(0, str(backend_dir))

import stripe
from core.services.convex_client import get_convex_client
from core.utils.config import config
from core.utils.logger import logger
from core.billing.shared.config import get_tier_by_price_id, TIERS

stripe.api_key = config.STRIPE_SECRET_KEY


class FastSyncService:
    """
    Syncs Stripe subscriptions to Convex credit accounts.
    
    Required Convex Admin Endpoints:
      - admin:list_billing_customers - List billing customers with optional filters
      - admin:list_credit_purchases - Get credit purchase history
    """
    
    def __init__(self):
        self.convex = get_convex_client()
        self.stats = {
            'total_users': 0,
            'synced': 0,
            'converted_to_trial': 0,
            'errors': 0,
            'skipped': 0,
            'no_subscription': 0,
            'wrong_status': 0,
            'no_price_id': 0,
            'unmatched_tier': 0,
            'start_time': time.time()
        }
    
    async def get_billing_customers(self, limit: int = 100, offset: int = 0) -> List[Dict]:
        """Get list of billing customers from Convex.
        
        Requires Convex endpoint: admin:list_billing_customers
        """
        try:
            result = await self.convex.admin_rpc("list_billing_customers", {
                "limit": limit,
                "offset": offset
            })
            return result.get('customers', []) if result else []
        except Exception as e:
            logger.error(f"Error listing billing customers: {e}")
            return []
    
    async def get_credit_purchases(self, account_id: str) -> List[Dict]:
        """Get credit purchases for an account.
        
        Requires Convex endpoint: admin:list_credit_purchases
        """
        try:
            result = await self.convex.admin_rpc("list_credit_purchases", {
                "account_id": account_id
            })
            return result.get('purchases', []) if result else []
        except Exception as e:
            logger.error(f"Error listing credit purchases for {account_id}: {e}")
            return []
    
    async def sync_user_subscription(
        self, 
        billing_customer: Dict, 
        dry_run: bool = False
    ) -> bool:
        """Sync a single user's subscription from Stripe to Convex."""
        account_id = billing_customer.get('account_id')
        stripe_customer_id = billing_customer.get('id')
        
        try:
            # Get Stripe subscriptions
            subscriptions = stripe.Subscription.list(
                customer=stripe_customer_id,
                status='all',
                limit=10
            )
            
            if not subscriptions.data:
                self.stats['no_subscription'] += 1
                return True
            
            # Find active subscription
            active_sub = None
            for sub in subscriptions.data:
                if sub.status in ['active', 'trialing', 'past_due']:
                    active_sub = sub
                    break
            
            if not active_sub:
                self.stats['wrong_status'] += 1
                return True
            
            # Extract price ID
            price_id = None
            if active_sub.items and active_sub.items.data:
                price_id = active_sub.items.data[0].price.id
            
            if not price_id:
                self.stats['no_price_id'] += 1
                logger.warning(f"No price ID for subscription {active_sub.id}")
                return True
            
            # Get tier from price ID
            tier = get_tier_by_price_id(price_id)
            if not tier:
                self.stats['unmatched_tier'] += 1
                logger.warning(f"Unmatched tier for price {price_id}")
                return True
            
            # Get current credit account
            credit_account = await self.convex.get_credit_account(account_id)
            
            # Calculate dates
            start_date = datetime.fromtimestamp(
                active_sub.current_period_start, tz=timezone.utc
            )
            next_grant = datetime.fromtimestamp(
                active_sub.current_period_end, tz=timezone.utc
            )
            
            update_data = {
                'account_id': account_id,
                'tier': tier.name,
                'stripe_subscription_id': active_sub.id,
                'billing_cycle_anchor': start_date.isoformat(),
                'next_credit_grant': next_grant.isoformat(),
            }
            
            if dry_run:
                logger.info(f"[DRY RUN] Would update {account_id}: tier={tier.name}")
                self.stats['synced'] += 1
                return True
            
            # Update credit account
            await self.convex.upsert_credit_account(**update_data)
            
            # Grant credits if needed
            current_balance = Decimal(str(credit_account.get('balance', 0))) if credit_account else Decimal('0')
            
            if current_balance < Decimal('1.0'):
                await self.convex.add_credits(
                    account_id=account_id,
                    amount=int(tier.monthly_credits),
                    description=f"Sync: Initial credits for {tier.display_name}",
                    credit_type="subscription_sync"
                )
            
            self.stats['synced'] += 1
            logger.info(f"✅ Synced {account_id}: tier={tier.name}")
            return True
            
        except Exception as e:
            self.stats['errors'] += 1
            logger.error(f"Error syncing {account_id}: {e}")
            return False
    
    async def run(self, dry_run: bool = False, limit: int = None):
        """Run the sync process."""
        print("\n" + "="*60)
        print("STRIPE SUBSCRIPTION SYNC")
        print("="*60)
        print(f"Mode: {'DRY RUN' if dry_run else 'LIVE'}")
        print(f"Limit: {limit or 'All users'}")
        print("="*60 + "\n")
        
        # Get all billing customers
        offset = 0
        batch_size = 100
        total_processed = 0
        
        while True:
            customers = await self.get_billing_customers(limit=batch_size, offset=offset)
            
            if not customers:
                break
                
            self.stats['total_users'] += len(customers)
            
            for customer in customers:
                await self.sync_user_subscription(customer, dry_run)
                total_processed += 1
                
                if limit and total_processed >= limit:
                    break
            
            if limit and total_processed >= limit:
                break
                
            offset += batch_size
        
        # Print summary
        elapsed = time.time() - self.stats['start_time']
        print("\n" + "="*60)
        print("SYNC COMPLETE")
        print("="*60)
        print(f"Total users processed: {self.stats['total_users']}")
        print(f"Synced: {self.stats['synced']}")
        print(f"No subscription: {self.stats['no_subscription']}")
        print(f"Wrong status: {self.stats['wrong_status']}")
        print(f"No price ID: {self.stats['no_price_id']}")
        print(f"Unmatched tier: {self.stats['unmatched_tier']}")
        print(f"Errors: {self.stats['errors']}")
        print(f"Time: {elapsed:.2f}s")
        print("="*60)


async def main():
    import argparse
    
    parser = argparse.ArgumentParser(description='Sync Stripe subscriptions to Convex')
    parser.add_argument('--dry-run', action='store_true', help='Preview changes')
    parser.add_argument('--limit', type=int, help='Limit number of users to process')
    
    args = parser.parse_args()
    
    service = FastSyncService()
    try:
        await service.run(dry_run=args.dry_run, limit=args.limit)
    except Exception as e:
        print(f"\n❌ FATAL ERROR: {e}")
        logger.error(f"Sync failed: {e}", exc_info=True)
        sys.exit(1)


if __name__ == "__main__":
    print("Starting fast sync service...")
    asyncio.run(main())