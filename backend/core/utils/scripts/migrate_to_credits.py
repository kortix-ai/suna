#!/usr/bin/env python3
import asyncio
import sys
from pathlib import Path

backend_dir = Path(__file__).parent.parent.parent
sys.path.insert(0, str(backend_dir))

from decimal import Decimal
from datetime import datetime, timezone
from core.services.supabase import DBConnection
from billing.config import get_tier_by_price_id, get_monthly_credits, FREE_TIER_INITIAL_CREDITS
import argparse

class CreditMigration:
    def __init__(self, dry_run: bool = True):
        self.dry_run = dry_run
        self.db = DBConnection()
        self.successful = []
        self.failed = []
        
    async def initialize(self):
        await self.db.initialize()
        self.client = await self.db.client
    
    async def calculate_credit_split(self, user_id: str) -> tuple[Decimal, Decimal]:
        ledger_result = await self.client.from_('credit_ledger')\
            .select('amount, type, description')\
            .eq('user_id', user_id)\
            .execute()
        
        total_purchases = Decimal('0')
        total_tier_grants = Decimal('0')
        total_usage = Decimal('0')
        
        for entry in ledger_result.data or []:
            amount = Decimal(str(entry['amount']))
            entry_type = entry['type']
            description = entry.get('description', '').lower()
            
            if entry_type == 'purchase' and amount > 0:
                total_purchases += amount
            elif 'purchased' in description and amount > 0:
                total_purchases += amount
            elif entry_type in ('tier_grant', 'tier_upgrade') and amount > 0:
                total_tier_grants += amount
            elif entry_type == 'usage' and amount < 0:
                total_usage += abs(amount)
        
        if total_usage > total_tier_grants:
            remaining_tier_credits = Decimal('0')
            remaining_purchases = total_purchases - (total_usage - total_tier_grants)
        else:
            remaining_tier_credits = total_tier_grants - total_usage
            remaining_purchases = total_purchases
        
        remaining_tier_credits = max(Decimal('0'), remaining_tier_credits)
        remaining_purchases = max(Decimal('0'), remaining_purchases)
        
        return remaining_tier_credits, remaining_purchases
    
    async def analyze_users(self):
        print("Analyzing current user billing state...")
        
        accounts_result = await self.client.schema('basejump').from_('accounts').select('*').filter('personal_account', 'eq', True).execute()
        
        if not accounts_result.data:
            print("ERROR: No accounts found")
            return None
            
        subs_result = await self.client.schema('basejump').from_('billing_subscriptions').select('*').execute()
        subscriptions = {s['account_id']: s for s in (subs_result.data or [])}
        
        credit_accounts = await self.client.from_('credit_accounts').select('*').execute()
        migrated_users = {ca['user_id'] for ca in (credit_accounts.data or [])}
        
        old_balances = await self.client.from_('credit_balance').select('*').execute()
        old_balance_map = {}
        if old_balances.data:
            for balance in old_balances.data:
                user_id = balance.get('user_id')
                amount = balance.get('amount', 0)
                if user_id and amount > 0:
                    old_balance_map[user_id] = Decimal(str(amount))
        
        user_purchases = {}
        try:
            purchases_result = await self.client.from_('credit_purchases')\
                .select('user_id, amount_dollars, status')\
                .eq('status', 'completed')\
                .execute()
            
            if purchases_result.data:
                for purchase in purchases_result.data:
                    user_id = purchase['user_id']
                    amount = Decimal(str(purchase.get('amount_dollars', 0)))
                    if user_id not in user_purchases:
                        user_purchases[user_id] = Decimal('0')
                    user_purchases[user_id] += amount
        except Exception as e:
            print(f"WARNING: Could not fetch credit purchases: {e}")
            try:
                ledger_purchases = await self.client.from_('credit_ledger')\
                    .select('user_id, amount')\
                    .eq('type', 'purchase')\
                    .execute()
                
                if ledger_purchases.data:
                    for entry in ledger_purchases.data:
                        user_id = entry['user_id']
                        amount = Decimal(str(entry['amount']))
                        if amount > 0:
                            if user_id not in user_purchases:
                                user_purchases[user_id] = Decimal('0')
                            user_purchases[user_id] += amount
            except Exception as e2:
                print(f"WARNING: Could not fetch purchases from ledger: {e2}")
        
        if old_balance_map:
            print(f"Found {len(old_balance_map)} users with existing credit balances")
        if user_purchases:
            print(f"Found {len(user_purchases)} users with credit purchases")
        
        analysis = {
            'total_users': len(accounts_result.data),
            'active_subscriptions': len([s for s in subscriptions.values() if s['status'] == 'active']),
            'already_migrated': len(migrated_users),
            'to_migrate': [],
            'old_balances': old_balance_map,
            'user_purchases': user_purchases
        }
        
        for account in accounts_result.data:
            user_id = account['id']
            
            if user_id in migrated_users:
                continue
                
            subscription = subscriptions.get(user_id)
            user_data = {
                'user_id': user_id,
                'subscription': subscription,
                'old_balance': old_balance_map.get(user_id, Decimal('0')),
                'total_purchases': user_purchases.get(user_id, Decimal('0'))
            }
            analysis['to_migrate'].append(user_data)
        
        return analysis
    
    async def migrate_user(self, user_data: dict):
        user_id = user_data['user_id']
        subscription = user_data['subscription']
        old_balance = user_data['old_balance']
        total_purchases = user_data.get('total_purchases', Decimal('0'))
        
        if subscription and subscription['status'] == 'active':
            price_id = subscription.get('price_id')
            tier = get_tier_by_price_id(price_id)
            tier_name = tier.name if tier else 'free'
        else:
            tier_name = 'free'
        
        if tier_name == 'free':
            monthly_credits = FREE_TIER_INITIAL_CREDITS
        else:
            parts = tier_name.split('_')
            if len(parts) == 3 and parts[0] == 'tier':
                subscription_cost = Decimal(parts[2])
                monthly_credits = subscription_cost + FREE_TIER_INITIAL_CREDITS
            else:
                monthly_credits = get_monthly_credits(tier_name)
        
        month_start = datetime.now(timezone.utc).replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        usage_result = await self.client.from_('credit_ledger')\
            .select('amount')\
            .eq('user_id', user_id)\
            .eq('type', 'usage')\
            .gte('created_at', month_start.isoformat())\
            .execute()
        
        current_usage = Decimal('0')
        for entry in usage_result.data or []:
            amount = Decimal(str(entry['amount']))
            if amount < 0:
                current_usage += abs(amount)
        
        expiring_from_history = Decimal('0')
        non_expiring_from_history = Decimal('0')
        
        if old_balance > 0:
            expiring_from_history, non_expiring_from_history = await self.calculate_credit_split(user_id)
            print(f"  - Historical split from ledger: ${expiring_from_history:.2f} expiring, ${non_expiring_from_history:.2f} non-expiring")
        
        if total_purchases > 0:
            print(f"  - Found ${total_purchases:.2f} in credit purchases (topups)")
            if total_purchases > non_expiring_from_history:
                additional_purchases = total_purchases - non_expiring_from_history
                print(f"  - Adding ${additional_purchases:.2f} additional purchases not in ledger")
                non_expiring_from_history = total_purchases
        
        current_month_expiring = max(Decimal('0'), monthly_credits - current_usage)
        
        total_expiring = current_month_expiring + expiring_from_history
        
        total_non_expiring = non_expiring_from_history
        
        total_balance = total_expiring + total_non_expiring
        
        if self.dry_run:
            print(f"[DRY RUN] Would migrate user {user_id} to tier '{tier_name}'")
            print(f"  - Monthly tier limit: ${monthly_credits}")
            print(f"  - Current month usage: ${current_usage}")
            print(f"  - Expiring credits: ${total_expiring}")
            print(f"  - Non-expiring credits: ${total_non_expiring}")
            print(f"  - Total balance: ${total_balance}")
            return True
        
        try:
            account_data = {
                'user_id': user_id,
                'balance': str(total_balance),
                'expiring_credits': str(total_expiring),
                'non_expiring_credits': str(total_non_expiring),
                'tier': tier_name
            }
            
            if tier_name != 'free' and monthly_credits > 0:
                account_data['last_grant_date'] = datetime.now(timezone.utc).isoformat()
            
            if subscription and subscription.get('id'):
                account_data['stripe_subscription_id'] = subscription['id']
                if subscription.get('current_period_end'):
                    account_data['next_credit_grant'] = subscription['current_period_end']
            
            await self.client.from_('credit_accounts').insert(account_data).execute()
            
            description_parts = []
            if total_non_expiring > 0:
                description_parts.append(f"Non-expiring (purchases): ${total_non_expiring}")
            if total_expiring > 0:
                description_parts.append(f"Expiring (tier): ${total_expiring}")
            
            ledger_entry = {
                'user_id': user_id,
                'amount': str(total_balance),
                'balance_after': str(total_balance),
                'type': 'tier_grant',
                'description': f"Migration: {' | '.join(description_parts)}",
                'is_expiring': total_expiring > 0,
                'metadata': {
                    'migration': True,
                    'tier': tier_name,
                    'old_balance': str(old_balance),
                    'tier_credits': str(monthly_credits),
                    'current_usage': str(current_usage),
                    'expiring_credits': str(total_expiring),
                    'non_expiring_credits': str(total_non_expiring),
                    'total_purchases': str(total_purchases)
                }
            }
            
            await self.client.from_('credit_ledger').insert(ledger_entry).execute()
            
            print(f"Successfully migrated user {user_id}:")
            print(f"  - Tier: {tier_name}")
            print(f"  - Expiring: ${total_expiring}")
            print(f"  - Non-expiring: ${total_non_expiring}")
            print(f"  - Total: ${total_balance}")
            return True
            
        except Exception as e:
            print(f"ERROR: Failed to migrate user {user_id}: {e}")
            return False
    
    async def run_migration(self):
        analysis = await self.analyze_users()
        
        if not analysis:
            return
        
        print("="*60)
        print("CREDIT SYSTEM MIGRATION ANALYSIS")
        print("="*60)
        print(f"Total users: {analysis['total_users']}")
        print(f"Active subscriptions: {analysis['active_subscriptions']}")
        print(f"Users with old credit balance: {len(analysis['old_balances'])}")
        print(f"Users with credit purchases: {len(analysis['user_purchases'])}")
        print(f"Already migrated: {analysis['already_migrated']}")
        print(f"To migrate: {len(analysis['to_migrate'])}")
        print("="*60)
        
        if not analysis['to_migrate']:
            print("No users to migrate")
            return
        
        if self.dry_run:
            print("\n[DRY RUN] Would migrate the following users:")
            for user_data in analysis['to_migrate'][:10]:
                sub = user_data['subscription']
                old_balance = user_data['old_balance']
                purchases = user_data['total_purchases']
                if sub and sub['status'] == 'active':
                    price_id = sub.get('price_id')
                    tier = get_tier_by_price_id(price_id)
                    tier_name = tier.name if tier else 'free'
                else:
                    tier_name = 'free'
                
                info = f"[DRY RUN] User {user_data['user_id'][:8]}... tier '{tier_name}'"
                if old_balance > 0:
                    info += f", balance ${old_balance:.2f}"
                if purchases > 0:
                    info += f", purchases ${purchases:.2f}"
                print(info)
                
                await self.migrate_user(user_data)
        else:
            print(f"\nStarting migration of {len(analysis['to_migrate'])} users...")
            
            for user_data in analysis['to_migrate']:
                success = await self.migrate_user(user_data)
                if success:
                    self.successful.append(user_data['user_id'])
                else:
                    self.failed.append(user_data['user_id'])
        
        print("="*60)
        print("MIGRATION COMPLETE")
        print("="*60)
        print(f"Successfully migrated: {len(self.successful) if not self.dry_run else len(analysis['to_migrate'])}")
        print(f"Failed: {len(self.failed)}")
        
        if self.failed:
            print(f"ERROR: Failed user IDs: {self.failed}")

async def main():
    parser = argparse.ArgumentParser(description='Migrate users to credit system with expiring/non-expiring split')
    parser.add_argument('--dry-run', action='store_true', help='Run in dry-run mode (no changes)')
    args = parser.parse_args()
    
    if args.dry_run:
        print("Running in DRY RUN mode - no changes will be made")
    else:
        print("WARNING: Running in PRODUCTION mode - changes will be made to the database")
        response = input("Are you sure you want to proceed? (yes/no): ")
        if response.lower() != 'yes':
            print("Migration cancelled")
            return
    
    migration = CreditMigration(dry_run=args.dry_run)
    await migration.initialize()
    await migration.run_migration()

if __name__ == "__main__":
    asyncio.run(main()) 