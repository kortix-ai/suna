#!/usr/bin/env python3
import asyncio
import sys
from pathlib import Path
sys.path.append(str(Path(__file__).parent.parent.parent))

from decimal import Decimal
from datetime import datetime, timezone
from core.services.supabase import DBConnection
from billing.config import get_tier_by_price_id, get_monthly_credits, FREE_TIER_INITIAL_CREDITS
from core.utils.logger import logger
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
        """
        Calculate how much of a user's existing balance is expiring vs non-expiring.
        This looks at credit_ledger history to determine the split.
        
        Returns: (expiring_credits, non_expiring_credits)
        """
        # Get all credit transactions from ledger
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
            
            # Identify purchases (non-expiring)
            if entry_type == 'purchase' and amount > 0:
                total_purchases += amount
            elif 'purchased' in description and amount > 0:
                total_purchases += amount
            # Identify tier grants (expiring)
            elif entry_type in ('tier_grant', 'tier_upgrade') and amount > 0:
                total_tier_grants += amount
            # Track usage
            elif entry_type == 'usage' and amount < 0:
                total_usage += abs(amount)
        
        # Apply usage to expiring credits first
        if total_usage > total_tier_grants:
            # All tier credits were used, some purchases were used
            remaining_tier_credits = Decimal('0')
            remaining_purchases = total_purchases - (total_usage - total_tier_grants)
        else:
            # Some tier credits remain, all purchases remain
            remaining_tier_credits = total_tier_grants - total_usage
            remaining_purchases = total_purchases
        
        # Ensure non-negative values
        remaining_tier_credits = max(Decimal('0'), remaining_tier_credits)
        remaining_purchases = max(Decimal('0'), remaining_purchases)
        
        return remaining_tier_credits, remaining_purchases
    
    async def analyze_users(self):
        logger.info("Analyzing current user billing state...")
        
        accounts_result = await self.client.schema('basejump').from_('accounts').select('*').filter('personal_account', 'eq', True).execute()
        
        if not accounts_result.data:
            logger.error("No accounts found")
            return None
            
        subs_result = await self.client.schema('basejump').from_('billing_subscriptions').select('*').execute()
        subscriptions = {s['account_id']: s for s in (subs_result.data or [])}
        
        credit_accounts = await self.client.from_('credit_accounts').select('*').execute()
        migrated_users = {ca['user_id'] for ca in (credit_accounts.data or [])}
        
        # Get old balances from credit_balance table
        old_balances = await self.client.from_('credit_balance').select('*').execute()
        old_balance_map = {}
        if old_balances.data:
            for balance in old_balances.data:
                user_id = balance.get('user_id')
                amount = balance.get('amount', 0)
                if user_id and amount > 0:
                    old_balance_map[user_id] = Decimal(str(amount))
        
        # Get credit purchases to identify topups
        purchases_result = await self.client.from_('credit_purchases')\
            .select('user_id, amount, status')\
            .eq('status', 'completed')\
            .execute()
        
        user_purchases = {}
        if purchases_result.data:
            for purchase in purchases_result.data:
                user_id = purchase['user_id']
                amount = Decimal(str(purchase['amount']))
                if user_id not in user_purchases:
                    user_purchases[user_id] = Decimal('0')
                user_purchases[user_id] += amount
        
        if old_balance_map:
            logger.info(f"Found {len(old_balance_map)} users with existing credit balances")
        if user_purchases:
            logger.info(f"Found {len(user_purchases)} users with credit purchases")
        
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
        
        # Determine tier
        if subscription and subscription['status'] == 'active':
            price_id = subscription.get('price_id')
            tier = get_tier_by_price_id(price_id)
            tier_name = tier.name if tier else 'free'
        else:
            tier_name = 'free'
        
        # Calculate monthly credits for tier
        if tier_name == 'free':
            monthly_credits = FREE_TIER_INITIAL_CREDITS
        else:
            parts = tier_name.split('_')
            if len(parts) == 3 and parts[0] == 'tier':
                subscription_cost = Decimal(parts[2])
                monthly_credits = subscription_cost + FREE_TIER_INITIAL_CREDITS
            else:
                monthly_credits = get_monthly_credits(tier_name)
        
        # Get current month usage
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
        
        # Calculate credit split if there's an old balance
        expiring_from_history = Decimal('0')
        non_expiring_from_history = Decimal('0')
        
        if old_balance > 0:
            # Calculate split based on ledger history
            expiring_from_history, non_expiring_from_history = await self.calculate_credit_split(user_id)
            logger.info(f"  - Historical split: ${expiring_from_history:.2f} expiring, ${non_expiring_from_history:.2f} non-expiring")
        
        # Calculate final balances
        # For current month: tier credits minus usage (but not below 0)
        current_month_expiring = max(Decimal('0'), monthly_credits - current_usage)
        
        # Total expiring = current month remaining + any historical expiring credits
        total_expiring = current_month_expiring + expiring_from_history
        
        # Non-expiring = all historical non-expiring credits (purchases)
        total_non_expiring = non_expiring_from_history
        
        # Total balance
        total_balance = total_expiring + total_non_expiring
        
        if self.dry_run:
            logger.info(f"[DRY RUN] Would migrate user {user_id} to tier '{tier_name}'")
            logger.info(f"  - Monthly tier limit: ${monthly_credits}")
            logger.info(f"  - Current month usage: ${current_usage}")
            logger.info(f"  - Expiring credits: ${total_expiring}")
            logger.info(f"  - Non-expiring credits: ${total_non_expiring}")
            logger.info(f"  - Total balance: ${total_balance}")
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
            
            # Add stripe_subscription_id if user has an active subscription
            if subscription and subscription.get('id'):
                account_data['stripe_subscription_id'] = subscription['id']
                if subscription.get('current_period_end'):
                    account_data['next_credit_grant'] = subscription['current_period_end']
            
            await self.client.from_('credit_accounts').insert(account_data).execute()
            
            # Create ledger entry
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
                'is_expiring': total_expiring > 0,  # Mark as expiring if any expiring credits
                'metadata': {
                    'migration': True,
                    'tier': tier_name,
                    'old_balance': str(old_balance),
                    'tier_credits': str(monthly_credits),
                    'current_usage': str(current_usage),
                    'expiring_credits': str(total_expiring),
                    'non_expiring_credits': str(total_non_expiring)
                }
            }
            
            await self.client.from_('credit_ledger').insert(ledger_entry).execute()
            
            logger.info(f"Successfully migrated user {user_id}:")
            logger.info(f"  - Tier: {tier_name}")
            logger.info(f"  - Expiring: ${total_expiring}")
            logger.info(f"  - Non-expiring: ${total_non_expiring}")
            logger.info(f"  - Total: ${total_balance}")
            return True
            
        except Exception as e:
            logger.error(f"Failed to migrate user {user_id}: {e}")
            return False
    
    async def run_migration(self):
        analysis = await self.analyze_users()
        
        if not analysis:
            return
        
        logger.info("="*60)
        logger.info("CREDIT SYSTEM MIGRATION ANALYSIS")
        logger.info("="*60)
        logger.info(f"Total users: {analysis['total_users']}")
        logger.info(f"Active subscriptions: {analysis['active_subscriptions']}")
        logger.info(f"Users with old credit balance: {len(analysis['old_balances'])}")
        logger.info(f"Users with credit purchases: {len(analysis['user_purchases'])}")
        logger.info(f"Already migrated: {analysis['already_migrated']}")
        logger.info(f"To migrate: {len(analysis['to_migrate'])}")
        logger.info("="*60)
        
        if not analysis['to_migrate']:
            logger.info("No users to migrate")
            return
        
        if self.dry_run:
            logger.info("\n[DRY RUN] Would migrate the following users:")
            for user_data in analysis['to_migrate'][:10]:  # Show first 10 in dry run
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
                logger.info(info)
                
                # Do detailed migration for first few users in dry run
                await self.migrate_user(user_data)
        else:
            logger.info(f"\nStarting migration of {len(analysis['to_migrate'])} users...")
            
            for user_data in analysis['to_migrate']:
                success = await self.migrate_user(user_data)
                if success:
                    self.successful.append(user_data['user_id'])
                else:
                    self.failed.append(user_data['user_id'])
        
        logger.info("="*60)
        logger.info("MIGRATION COMPLETE")
        logger.info("="*60)
        logger.info(f"Successfully migrated: {len(self.successful) if not self.dry_run else len(analysis['to_migrate'])}")
        logger.info(f"Failed: {len(self.failed)}")
        
        if self.failed:
            logger.error(f"Failed user IDs: {self.failed}")

async def main():
    parser = argparse.ArgumentParser(description='Migrate users to credit system with expiring/non-expiring split')
    parser.add_argument('--dry-run', action='store_true', help='Run in dry-run mode (no changes)')
    args = parser.parse_args()
    
    if args.dry_run:
        logger.info("Running in DRY RUN mode - no changes will be made")
    else:
        logger.warning("Running in PRODUCTION mode - changes will be made to the database")
        response = input("Are you sure you want to proceed? (yes/no): ")
        if response.lower() != 'yes':
            logger.info("Migration cancelled")
            return
    
    migration = CreditMigration(dry_run=args.dry_run)
    await migration.initialize()
    await migration.run_migration()

if __name__ == "__main__":
    asyncio.run(main()) 