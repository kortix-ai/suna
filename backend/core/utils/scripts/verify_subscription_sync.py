#!/usr/bin/env python3
import asyncio
import sys
from pathlib import Path
from typing import Dict, List, Optional
from datetime import datetime, timezone
from decimal import Decimal
import time

backend_dir = Path(__file__).parent.parent.parent
sys.path.insert(0, str(backend_dir))

import stripe
from core.services.supabase import DBConnection
from core.utils.config import config
from core.utils.logger import logger
from billing.config import get_tier_by_price_id, TIERS

stripe.api_key = config.STRIPE_SECRET_KEY

class VerifySubscriptionSyncService:
    def __init__(self):
        self.db = DBConnection()
        self.issues = {
            'missing_in_db': [],
            'wrong_tier': [],
            'no_credits': [],
            'inactive_but_has_tier': [],
            'total_checked': 0,
            'healthy': 0
        }
        self.start_time = time.time()
    
    async def initialize(self):
        await self.db.initialize()
        self.client = await self.db.client
    
    async def run(self):
        print("\n" + "="*60)
        print("SUBSCRIPTION SYNC VERIFICATION")
        print("="*60)
        print("🔍 Checking all active subscriptions for proper sync...")
        print("="*60)
        
        await self.initialize()
        await self.verify_active_subscriptions()
        await self.check_database_consistency()
        self.print_report()
    
    async def verify_active_subscriptions(self):
        print("\n📊 CHECKING STRIPE SUBSCRIPTIONS...")
        
        customers_result = await self.client.schema('basejump')\
            .from_('billing_customers')\
            .select('id, account_id')\
            .execute()
        
        if not customers_result.data:
            print("  No customers found")
            return
        
        print(f"  Found {len(customers_result.data)} customers to check")
        batch_size = 10
        for i in range(0, len(customers_result.data), batch_size):
            batch = customers_result.data[i:i+batch_size]
            print(f"  Checking batch {i//batch_size + 1} ({i+1}-{min(i+batch_size, len(customers_result.data))} of {len(customers_result.data)})...")
            
            tasks = []
            for customer in batch:
                tasks.append(self.verify_customer(customer))
            
            await asyncio.gather(*tasks, return_exceptions=True)
            
            if i + batch_size < len(customers_result.data):
                await asyncio.sleep(0.5)
    
    async def verify_customer(self, customer: Dict) -> None:
        stripe_customer_id = customer['id']
        account_id = customer['account_id']
        
        try:
            subscriptions = await stripe.Subscription.list_async(
                customer=stripe_customer_id,
                status='all',
                limit=1,
                expand=['data.items.data.price']
            )
            
            if not subscriptions.data:
                return
            
            sub = subscriptions.data[0]
            
            if sub.status not in ['active', 'trialing']:
                return
            
            self.issues['total_checked'] += 1
            
            price_id = self.extract_price_id(sub)
            
            if not price_id:
                logger.warning(f"Customer {stripe_customer_id}: Active subscription but no price_id")
                return
            
            expected_tier = get_tier_by_price_id(price_id)
            if not expected_tier:
                logger.warning(f"Customer {stripe_customer_id}: price_id {price_id} doesn't match any tier")
                return
            
            db_account = await self.client.from_('credit_accounts')\
                .select('tier, balance, stripe_subscription_id')\
                .eq('account_id', account_id)\
                .single()\
                .execute()
            
            if not db_account.data:
                self.issues['missing_in_db'].append({
                    'customer_id': stripe_customer_id,
                    'account_id': account_id,
                    'expected_tier': expected_tier.name,
                    'subscription_status': sub.status
                })
                return
            
            current_tier = db_account.data.get('tier')
            current_balance = Decimal(str(db_account.data.get('balance', 0)))
            db_sub_id = db_account.data.get('stripe_subscription_id')
            
            has_issue = False
            
            if current_tier != expected_tier.name:
                self.issues['wrong_tier'].append({
                    'customer_id': stripe_customer_id,
                    'account_id': account_id,
                    'current_tier': current_tier,
                    'expected_tier': expected_tier.name,
                    'subscription_status': sub.status
                })
                has_issue = True
            
            if current_balance < Decimal('1.0') and expected_tier.monthly_credits > 0:
                self.issues['no_credits'].append({
                    'customer_id': stripe_customer_id,
                    'account_id': account_id,
                    'tier': current_tier,
                    'balance': float(current_balance),
                    'expected_credits': float(expected_tier.monthly_credits),
                    'subscription_status': sub.status
                })
                has_issue = True
            
            if db_sub_id != sub.id:
                logger.warning(f"Customer {stripe_customer_id}: DB has subscription {db_sub_id} but Stripe has {sub.id}")
            
            if not has_issue:
                self.issues['healthy'] += 1
                
        except Exception as e:
            logger.error(f"Error verifying customer {stripe_customer_id}: {e}")
    
    async def check_database_consistency(self):
        print("\n🔍 CHECKING DATABASE CONSISTENCY...")
        
        orphaned = await self.client.from_('credit_accounts')\
            .select('account_id, tier, balance')\
            .not_.in_('tier', ['none', 'free'])\
            .is_('stripe_subscription_id', 'null')\
            .execute()
        
        if orphaned.data:
            print(f"  ⚠️  Found {len(orphaned.data)} users with paid tiers but no subscription ID")
            for user in orphaned.data[:5]:
                print(f"    - Account {user['account_id']}: tier={user['tier']}, balance={user['balance']}")
        
        mismatched = await self.client.from_('credit_accounts')\
            .select('account_id, stripe_subscription_id, balance')\
            .eq('tier', 'none')\
            .not_.is_('stripe_subscription_id', 'null')\
            .execute()
        
        if mismatched.data:
            print(f"  ⚠️  Found {len(mismatched.data)} users with tier='none' but have subscription ID")
            for user in mismatched.data[:5]:
                print(f"    - Account {user['account_id']}: sub_id={user['stripe_subscription_id']}")
    
    def extract_price_id(self, subscription) -> Optional[str]:
        try:
            if hasattr(subscription, 'items') and hasattr(subscription.items, 'data'):
                items = subscription.items.data
                if items and len(items) > 0:
                    item = items[0]
                    if hasattr(item, 'price'):
                        if hasattr(item.price, 'id'):
                            return item.price.id
                        elif isinstance(item.price, str):
                            return item.price
        except Exception as e:
            logger.error(f"Error extracting price_id: {e}")
        return None
    
    def print_report(self):
        elapsed = time.time() - self.start_time
        
        print("\n" + "="*60)
        print("VERIFICATION REPORT")
        print("="*60)
        print(f"⏱️  Time taken: {elapsed:.2f} seconds")
        print(f"📊 Total active/trialing subscriptions checked: {self.issues['total_checked']}")
        print(f"✅ Healthy (properly synced): {self.issues['healthy']}")
        
        total_issues = (
            len(self.issues['missing_in_db']) +
            len(self.issues['wrong_tier']) +
            len(self.issues['no_credits'])
        )
        
        if total_issues == 0:
            print("\n🎉 PERFECT! All active subscriptions are properly synced!")
        else:
            print(f"\n⚠️  Found {total_issues} issues:")
            
            if self.issues['missing_in_db']:
                print(f"\n❌ MISSING IN DATABASE ({len(self.issues['missing_in_db'])} users):")
                for issue in self.issues['missing_in_db'][:5]:
                    print(f"  - Customer {issue['customer_id']}: expected tier={issue['expected_tier']}")
                if len(self.issues['missing_in_db']) > 5:
                    print(f"  ... and {len(self.issues['missing_in_db']) - 5} more")
            
            if self.issues['wrong_tier']:
                print(f"\n❌ WRONG TIER ({len(self.issues['wrong_tier'])} users):")
                for issue in self.issues['wrong_tier'][:5]:
                    print(f"  - Customer {issue['customer_id']}: has {issue['current_tier']}, should be {issue['expected_tier']}")
                if len(self.issues['wrong_tier']) > 5:
                    print(f"  ... and {len(self.issues['wrong_tier']) - 5} more")
            
            if self.issues['no_credits']:
                print(f"\n❌ NO CREDITS ({len(self.issues['no_credits'])} users):")
                for issue in self.issues['no_credits'][:5]:
                    print(f"  - Customer {issue['customer_id']}: tier={issue['tier']}, balance={issue['balance']}, expected={issue['expected_credits']}")
                if len(self.issues['no_credits']) > 5:
                    print(f"  ... and {len(self.issues['no_credits']) - 5} more")
            
            print("\n💡 TO FIX THESE ISSUES:")
            print("  1. Run: uv run python core/utils/scripts/sync_stripe_subscriptions_v2.py")
            print("  2. Then: uv run python core/utils/scripts/grant_missing_credits.py")
        
        print("="*60)

async def main():
    service = VerifySubscriptionSyncService()
    try:
        await service.run()
    except Exception as e:
        print(f"\n❌ FATAL ERROR: {e}")
        logger.error(f"Verification failed: {e}", exc_info=True)
        sys.exit(1)

if __name__ == "__main__":
    print("Starting subscription sync verification...")
    asyncio.run(main()) 