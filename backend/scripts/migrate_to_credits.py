#!/usr/bin/env python3
import asyncio
import sys
from pathlib import Path
sys.path.append(str(Path(__file__).parent.parent))

from decimal import Decimal
from datetime import datetime, timezone
from core.services.supabase import DBConnection
from core.billing_config import get_tier_by_price_id, get_monthly_credits, FREE_TIER_INITIAL_CREDITS
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
        
        old_balances = await self.client.from_('credit_balance').select('*').execute()
        old_balance_map = {}
        if old_balances.data:
            for balance in old_balances.data:
                user_id = balance.get('user_id')
                amount = balance.get('amount', 0)
                if user_id and amount > 0:
                    old_balance_map[user_id] = Decimal(str(amount))
        
        if old_balance_map:
            logger.info(f"Found {len(old_balance_map)} users with existing credit balances")
        
        analysis = {
            'total_users': len(accounts_result.data),
            'active_subscriptions': len([s for s in subscriptions.values() if s['status'] == 'active']),
            'already_migrated': len(migrated_users),
            'to_migrate': [],
            'old_balances': old_balance_map
        }
        
        for account in accounts_result.data:
            user_id = account['id']
            
            if user_id in migrated_users:
                continue
                
            subscription = subscriptions.get(user_id)
            user_data = {
                'user_id': user_id,
                'subscription': subscription,
                'old_balance': old_balance_map.get(user_id, Decimal('0'))
            }
            analysis['to_migrate'].append(user_data)
        
        return analysis
    
    async def migrate_user(self, user_data: dict):
        user_id = user_data['user_id']
        subscription = user_data['subscription']
        old_balance = user_data['old_balance']
        
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
        
        total_initial_balance = monthly_credits - current_usage + old_balance
        
        if self.dry_run:
            logger.info(f"[DRY RUN] Would migrate user {user_id} to tier '{tier_name}'")
            if old_balance > 0:
                logger.info(f"  - Preserving existing balance: ${old_balance}")
            logger.info(f"  - Monthly tier limit: ${monthly_credits}")
            logger.info(f"  - Current month usage: ${current_usage}")
            logger.info(f"  - Total initial balance: ${total_initial_balance}")
            return True
        
        try:
            account_data = {
                'user_id': user_id,
                'balance': str(total_initial_balance),
                'tier': tier_name
            }
            
            if tier_name != 'free' and monthly_credits > 0:
                account_data['last_grant_date'] = datetime.now(timezone.utc).isoformat()
            
            await self.client.from_('credit_accounts').insert(account_data).execute()
            
            description_parts = []
            if old_balance > 0:
                description_parts.append(f"Migrated existing balance: ${old_balance}")
            description_parts.append(f"Initial {tier_name} tier credits: ${monthly_credits} - usage ${current_usage}")
            
            ledger_entry = {
                'user_id': user_id,
                'amount': str(total_initial_balance),
                'balance_after': str(total_initial_balance),
                'type': 'tier_grant',
                'description': ' | '.join(description_parts),
                'metadata': {
                    'migration': True,
                    'tier': tier_name,
                    'old_balance': str(old_balance),
                    'tier_credits': str(monthly_credits),
                    'current_usage': str(current_usage)
                }
            }
            
            await self.client.from_('credit_ledger').insert(ledger_entry).execute()
            
            if tier_name != 'free' and monthly_credits > 0:
                grant_entry = {
                    'user_id': user_id,
                    'amount': str(monthly_credits),
                    'tier': tier_name,
                    'period_start': datetime.now(timezone.utc).replace(day=1, hour=0, minute=0, second=0, microsecond=0).isoformat(),
                    'period_end': datetime.now(timezone.utc).replace(month=datetime.now().month % 12 + 1, day=1, hour=0, minute=0, second=0, microsecond=0).isoformat()
                }
                await self.client.from_('credit_grants').insert(grant_entry).execute()
            
            logger.info(f"Successfully migrated user {user_id} to tier '{tier_name}' with balance ${total_initial_balance} (${monthly_credits} limit - ${current_usage} usage)")
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
        logger.info(f"Already migrated: {analysis['already_migrated']}")
        logger.info(f"To migrate: {len(analysis['to_migrate'])}")
        logger.info("="*60)
        
        if not analysis['to_migrate']:
            logger.info("No users to migrate")
            return
        
        if self.dry_run:
            logger.info("\n[DRY RUN] Would migrate the following users:")
            for user_data in analysis['to_migrate']:
                sub = user_data['subscription']
                old_balance = user_data['old_balance']
                if sub and sub['status'] == 'active':
                    price_id = sub.get('price_id')
                    tier = get_tier_by_price_id(price_id)
                    tier_name = tier.name if tier else 'free'
                else:
                    tier_name = 'free'
                
                info = f"[DRY RUN] Would migrate user {user_data['user_id'][:8]}... with tier '{tier_name}'"
                if old_balance > 0:
                    info += f" + existing ${old_balance:.2f}"
                logger.info(info)
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
    parser = argparse.ArgumentParser(description='Migrate users to credit system')
    parser.add_argument('--dry-run', action='store_true', help='Run in dry-run mode (no changes)')
    args = parser.parse_args()
    
    if args.dry_run:
        logger.info("Running in DRY RUN mode - no changes will be made")
    else:
        logger.warning("Running in NON-DRY mode - changes will be made to the database")
        response = input("Are you sure you want to proceed? (yes/no): ")
        if response.lower() != 'yes':
            logger.info("Migration cancelled")
            return
    
    migration = CreditMigration(dry_run=args.dry_run)
    await migration.initialize()
    await migration.run_migration()

if __name__ == "__main__":
    asyncio.run(main()) 