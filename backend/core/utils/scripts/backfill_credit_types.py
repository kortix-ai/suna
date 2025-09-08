#!/usr/bin/env python3
"""
Script to backfill existing credit data to split between expiring and non-expiring credits.

This script:
1. Analyzes existing credit ledger entries
2. Categorizes credits as expiring (from tiers) or non-expiring (from purchases)
3. Updates the credit_accounts table with the split
4. Verifies the migration
"""

import asyncio
import sys
from datetime import datetime, timezone
from decimal import Decimal
from typing import Dict, List, Tuple
import logging

# Add parent directory to path for imports
sys.path.append('/Users/saumya/Desktop/suna/backend')

from core.services.supabase import DBConnection
from core.utils.logger import setup_logger

logger = setup_logger(__name__)

class CreditTypeBackfill:
    """Handles backfilling of expiring vs non-expiring credit types."""
    
    def __init__(self):
        self.db = DBConnection()
        self.stats = {
            'users_processed': 0,
            'users_with_purchases': 0,
            'users_with_tier_credits': 0,
            'total_expiring_credits': Decimal('0'),
            'total_non_expiring_credits': Decimal('0'),
            'errors': []
        }
    
    async def calculate_credit_split(self, user_id: str) -> Tuple[Decimal, Decimal]:
        """
        Calculate how much of a user's balance is expiring vs non-expiring.
        
        Returns:
            Tuple of (expiring_credits, non_expiring_credits)
        """
        client = await self.db.client
        
        # Get current balance
        balance_result = await client.from_('credit_accounts')\
            .select('balance')\
            .eq('user_id', user_id)\
            .execute()
        
        if not balance_result.data:
            return Decimal('0'), Decimal('0')
        
        current_balance = Decimal(str(balance_result.data[0]['balance']))
        
        # Get all credit transactions
        ledger_result = await client.from_('credit_ledger')\
            .select('amount, type')\
            .eq('user_id', user_id)\
            .execute()
        
        total_purchases = Decimal('0')
        total_tier_grants = Decimal('0')
        total_usage = Decimal('0')
        
        for entry in ledger_result.data:
            amount = Decimal(str(entry['amount']))
            entry_type = entry['type']
            
            if entry_type == 'purchase' and amount > 0:
                total_purchases += amount
            elif entry_type in ('tier_grant', 'tier_upgrade') and amount > 0:
                total_tier_grants += amount
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
        
        # Ensure values don't exceed current balance
        remaining_purchases = max(Decimal('0'), min(remaining_purchases, current_balance))
        remaining_tier_credits = max(Decimal('0'), min(remaining_tier_credits, current_balance - remaining_purchases))
        
        # Adjust if sum doesn't match balance (edge case handling)
        if (remaining_purchases + remaining_tier_credits) != current_balance:
            if remaining_purchases > current_balance:
                remaining_purchases = current_balance
                remaining_tier_credits = Decimal('0')
            else:
                remaining_tier_credits = current_balance - remaining_purchases
        
        return remaining_tier_credits, remaining_purchases
    
    async def backfill_user(self, user_id: str) -> bool:
        """
        Backfill credit types for a single user.
        
        Returns:
            True if successful, False otherwise
        """
        try:
            client = await self.db.client
            
            # Calculate the split
            expiring, non_expiring = await self.calculate_credit_split(user_id)
            
            # Update the account
            await client.from_('credit_accounts').update({
                'expiring_credits': float(expiring),
                'non_expiring_credits': float(non_expiring)
            }).eq('user_id', user_id).execute()
            
            # Update stats
            if expiring > 0:
                self.stats['users_with_tier_credits'] += 1
            if non_expiring > 0:
                self.stats['users_with_purchases'] += 1
            
            self.stats['total_expiring_credits'] += expiring
            self.stats['total_non_expiring_credits'] += non_expiring
            
            logger.info(f"User {user_id}: Expiring={expiring:.2f}, Non-expiring={non_expiring:.2f}")
            return True
            
        except Exception as e:
            logger.error(f"Error backfilling user {user_id}: {e}")
            self.stats['errors'].append(f"User {user_id}: {str(e)}")
            return False
    
    async def run_backfill(self, dry_run: bool = False):
        """
        Run the backfill process for all users with credits.
        """
        client = await self.db.client
        
        logger.info("Starting credit type backfill...")
        
        # Get all users with credits
        users_result = await client.from_('credit_accounts')\
            .select('user_id, balance, tier')\
            .gt('balance', 0)\
            .execute()
        
        total_users = len(users_result.data)
        logger.info(f"Found {total_users} users with positive balance")
        
        if dry_run:
            logger.info("DRY RUN MODE - No changes will be made")
        
        for user_data in users_result.data:
            user_id = user_data['user_id']
            balance = Decimal(str(user_data['balance']))
            tier = user_data['tier']
            
            logger.info(f"\nProcessing user {user_id} (Tier: {tier}, Balance: {balance:.2f})")
            
            if dry_run:
                expiring, non_expiring = await self.calculate_credit_split(user_id)
                logger.info(f"  Would set: Expiring={expiring:.2f}, Non-expiring={non_expiring:.2f}")
            else:
                success = await self.backfill_user(user_id)
                if success:
                    self.stats['users_processed'] += 1
        
        # Print summary
        logger.info("\n" + "="*50)
        logger.info("BACKFILL SUMMARY")
        logger.info("="*50)
        logger.info(f"Total users found: {total_users}")
        logger.info(f"Users processed: {self.stats['users_processed']}")
        logger.info(f"Users with tier credits: {self.stats['users_with_tier_credits']}")
        logger.info(f"Users with purchased credits: {self.stats['users_with_purchases']}")
        logger.info(f"Total expiring credits: ${self.stats['total_expiring_credits']:.2f}")
        logger.info(f"Total non-expiring credits: ${self.stats['total_non_expiring_credits']:.2f}")
        
        if self.stats['errors']:
            logger.error(f"\nErrors encountered: {len(self.stats['errors'])}")
            for error in self.stats['errors'][:10]:  # Show first 10 errors
                logger.error(f"  - {error}")
    
    async def verify_migration(self):
        """
        Verify that the migration was successful.
        """
        client = await self.db.client
        
        logger.info("\nVerifying migration...")
        
        # Check for mismatches
        mismatch_result = await client.rpc('execute_sql', {
            'query': """
                SELECT COUNT(*) as count
                FROM credit_accounts
                WHERE ABS(balance - (expiring_credits + non_expiring_credits)) > 0.01
            """
        }).execute()
        
        mismatch_count = mismatch_result.data[0]['count'] if mismatch_result.data else 0
        
        if mismatch_count > 0:
            logger.warning(f"Found {mismatch_count} accounts with balance mismatch!")
            
            # Get details of mismatches
            details_result = await client.rpc('execute_sql', {
                'query': """
                    SELECT user_id, balance, expiring_credits, non_expiring_credits
                    FROM credit_accounts
                    WHERE ABS(balance - (expiring_credits + non_expiring_credits)) > 0.01
                    LIMIT 10
                """
            }).execute()
            
            if details_result.data:
                logger.warning("Sample of mismatched accounts:")
                for row in details_result.data:
                    calculated = float(row['expiring_credits']) + float(row['non_expiring_credits'])
                    logger.warning(f"  User {row['user_id']}: Balance={row['balance']}, "
                                 f"Expiring={row['expiring_credits']}, Non-expiring={row['non_expiring_credits']}, "
                                 f"Sum={calculated}")
        else:
            logger.info("✅ All balances match! Migration verified successfully.")
        
        # Show summary statistics
        summary_result = await client.from_('credit_migration_summary').select('*').execute()
        
        if summary_result.data:
            summary = summary_result.data[0]
            logger.info("\nMigration Summary:")
            logger.info(f"  Total users: {summary['total_users']}")
            logger.info(f"  Total balance: ${summary['total_balance']}")
            logger.info(f"  Total expiring: ${summary['total_expiring']}")
            logger.info(f"  Total non-expiring: ${summary['total_non_expiring']}")
            logger.info(f"  Users with expiring credits: {summary['users_with_expiring']}")
            logger.info(f"  Users with non-expiring credits: {summary['users_with_non_expiring']}")


async def main():
    """Main entry point."""
    import argparse
    
    parser = argparse.ArgumentParser(description='Backfill credit types for existing users')
    parser.add_argument('--dry-run', action='store_true', help='Run without making changes')
    parser.add_argument('--verify-only', action='store_true', help='Only verify the migration')
    
    args = parser.parse_args()
    
    backfiller = CreditTypeBackfill()
    
    try:
        if args.verify_only:
            await backfiller.verify_migration()
        else:
            await backfiller.run_backfill(dry_run=args.dry_run)
            if not args.dry_run:
                await backfiller.verify_migration()
    except Exception as e:
        logger.error(f"Fatal error: {e}", exc_info=True)
        sys.exit(1)


if __name__ == '__main__':
    asyncio.run(main()) 