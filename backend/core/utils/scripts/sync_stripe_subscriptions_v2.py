#!/usr/bin/env python3
import asyncio
import sys
from pathlib import Path
from typing import List, Dict, Any, Optional
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
from billing.credit_manager import credit_manager

stripe.api_key = config.STRIPE_SECRET_KEY

class StripeSubscriptionSyncV2:
    def __init__(self):
        self.db = DBConnection()
        self.stats = {
            'total_customers': 0,
            'subscriptions_found': 0,
            'synced': 0,
            'credits_granted': 0,
            'no_subscription': 0,
            'wrong_status': 0,
            'no_price_id': 0,
            'unmatched_tier': 0,
            'errors': 0,
            'start_time': time.time()
        }
    
    async def initialize(self):
        await self.db.initialize()
        self.client = await self.db.client
    
    async def run(self):
        print("\n" + "="*60)
        print("STRIPE SUBSCRIPTION SYNC V2")
        print("="*60)
        print("✨ Improved price ID extraction & credit granting")
        print("="*60)
        
        await self.initialize()
        await self.sync_all_subscriptions()
        self.print_stats()
    
    async def sync_all_subscriptions(self):
        print("\n📊 SYNCING STRIPE SUBSCRIPTIONS...")
        
        offset = 0
        batch_size = 500
        
        while True:
            customers_result = await self.client.schema('basejump')\
                .from_('billing_customers')\
                .select('id, account_id')\
                .range(offset, offset + batch_size - 1)\
                .execute()
            
            if not customers_result.data:
                break
            
            self.stats['total_customers'] += len(customers_result.data)
            print(f"  Processing batch {offset//batch_size + 1} ({len(customers_result.data)} customers)...")
            
            tasks = []
            for customer in customers_result.data:
                tasks.append(self.sync_customer_subscription(customer))
            
            for i in range(0, len(tasks), 20):
                chunk = tasks[i:i+20]
                await asyncio.gather(*chunk, return_exceptions=True)
            
            offset += batch_size
            
            if len(customers_result.data) < batch_size:
                break
        
        print(f"  ✅ Processed {self.stats['synced']} subscriptions")
    
    async def sync_customer_subscription(self, customer: Dict) -> None:
        stripe_customer_id = customer['id']
        account_id = customer['account_id']
        
        try:
            current_account = await self.client.from_('credit_accounts')\
                .select('tier, balance')\
                .eq('account_id', account_id)\
                .single()\
                .execute()
            
            current_tier = current_account.data.get('tier') if current_account.data else 'none'
            
            subscriptions = await stripe.Subscription.list_async(
                customer=stripe_customer_id,
                status='all',
                limit=1,
                expand=['data.items.data.price']
            )
            
            if not subscriptions.data:
                self.stats['no_subscription'] += 1
                return
            
            sub = subscriptions.data[0]
            self.stats['subscriptions_found'] += 1
            
            if sub.status not in ['active', 'trialing']:
                self.stats['wrong_status'] += 1
                logger.debug(f"Customer {stripe_customer_id}: status={sub.status}")
                return
            
            price_id = self.extract_price_id(sub, stripe_customer_id)
            
            if not price_id:
                self.stats['no_price_id'] += 1
                logger.warning(f"Customer {stripe_customer_id}: Could not extract price_id from subscription")
                logger.debug(f"Subscription items: {sub.items if hasattr(sub, 'items') else 'No items'}")
                return
            
            # Match to tier
            tier = get_tier_by_price_id(price_id)
            if not tier:
                self.stats['unmatched_tier'] += 1
                logger.warning(f"Customer {stripe_customer_id}: price_id {price_id} doesn't match any tier")
                return
            
            update_data = {
                'tier': tier.name,
                'stripe_subscription_id': sub.id,
                'billing_cycle_anchor': datetime.fromtimestamp(sub.created).isoformat() if sub.created else None,
                'updated_at': datetime.now(timezone.utc).isoformat()
            }
            
            if sub.current_period_end:
                update_data['next_credit_grant'] = datetime.fromtimestamp(sub.current_period_end).isoformat()
            
            await self.client.from_('credit_accounts')\
                .update(update_data)\
                .eq('account_id', account_id)\
                .execute()
            
            current_balance = Decimal(str(current_account.data.get('balance', 0))) if current_account.data else Decimal('0')
            needs_credits = (
                (current_tier == 'none' and tier.monthly_credits > 0) or
                (tier.monthly_credits > 0 and current_balance < Decimal('1.0'))
            )
            
            if needs_credits:
                await self.grant_initial_credits(account_id, tier, sub)
                self.stats['credits_granted'] += 1
                logger.info(f"Granted {tier.monthly_credits} credits to {account_id} for tier {tier.name}")
            
            self.stats['synced'] += 1
            logger.info(f"Synced {stripe_customer_id}: {current_tier} → {tier.name}")
            
        except Exception as e:
            logger.error(f"Error syncing customer {stripe_customer_id}: {e}", exc_info=True)
            self.stats['errors'] += 1
    
    def extract_price_id(self, subscription: Any, customer_id: str) -> Optional[str]:
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
            
            if hasattr(subscription, 'items') and callable(subscription.items):
                items_obj = subscription.items()
                if hasattr(items_obj, 'data'):
                    items = items_obj.data
                    if items and len(items) > 0:
                        item = items[0]
                        if hasattr(item, 'price'):
                            if hasattr(item.price, 'id'):
                                return item.price.id
                            elif isinstance(item.price, str):
                                return item.price
            
            if hasattr(subscription, 'subscription_items'):
                items = subscription.subscription_items
                if hasattr(items, 'data'):
                    items_data = items.data
                    if items_data and len(items_data) > 0:
                        item = items_data[0]
                        if hasattr(item, 'price'):
                            if hasattr(item.price, 'id'):
                                return item.price.id
                            elif isinstance(item.price, str):
                                return item.price
            
            if isinstance(subscription, dict):
                items = subscription.get('items', {}).get('data', [])
                if items and len(items) > 0:
                    price = items[0].get('price')
                    if isinstance(price, dict):
                        return price.get('id')
                    elif isinstance(price, str):
                        return price
            
            logger.warning(f"Customer {customer_id}: Unable to extract price_id, subscription structure: {type(subscription)}")
            
        except Exception as e:
            logger.error(f"Error extracting price_id for {customer_id}: {e}")
        
        return None
    
    async def grant_initial_credits(self, account_id: str, tier: Any, subscription: Any):
        try:
            is_trial = subscription.status == 'trialing'
            
            credits_to_grant = tier.monthly_credits
            description = f"Initial credits for {tier.display_name}"
            
            if is_trial:
                description = f"Trial credits for {tier.display_name}"
            
            await credit_manager.add_credits(
                account_id=account_id,
                amount=credits_to_grant,
                is_expiring=True,
                description=description
            )
            
        except Exception as e:
            logger.error(f"Error granting credits to {account_id}: {e}")
    
    def print_stats(self):
        elapsed = time.time() - self.stats['start_time']
        
        print("\n" + "="*60)
        print("SYNC COMPLETE")
        print("="*60)
        print(f"⏱️  Time taken: {elapsed:.2f} seconds")
        print(f"👥 Total customers processed: {self.stats['total_customers']}")
        print(f"✅ Subscriptions synced: {self.stats['synced']}")
        print(f"💰 Credits granted: {self.stats['credits_granted']}")
        print(f"❌ Errors: {self.stats['errors']}")
        
        print("\n📊 Detailed Breakdown:")
        print(f"  Subscriptions found in Stripe: {self.stats['subscriptions_found']}")
        print(f"  No subscription: {self.stats['no_subscription']}")
        print(f"  Wrong status (not active/trialing): {self.stats['wrong_status']}")
        print(f"  Could not extract price ID: {self.stats['no_price_id']}")
        print(f"  Price ID doesn't match tiers: {self.stats['unmatched_tier']}")
        
        success_rate = (self.stats['synced'] / self.stats['total_customers'] * 100) if self.stats['total_customers'] > 0 else 0
        print(f"\n📈 Success rate: {success_rate:.2f}%")
        print("="*60)

async def main():
    service = StripeSubscriptionSyncV2()
    try:
        await service.run()
    except Exception as e:
        print(f"\n❌ FATAL ERROR: {e}")
        logger.error(f"Sync failed: {e}", exc_info=True)
        sys.exit(1)

if __name__ == "__main__":
    print("Starting Stripe Subscription Sync V2...")
    asyncio.run(main()) 