#!/usr/bin/env python3
"""
Script to fix credit balance issues and ensure consistency between:
1. Total balance = expiring_credits + non_expiring_credits
2. Ledger history matches account balances
3. Proper categorization of credits based on their source
"""

import asyncio
import sys
from pathlib import Path
sys.path.append(str(Path(__file__).parent.parent.parent))

from decimal import Decimal
from datetime import datetime, timezone
from typing import Dict, Optional, Tuple
import argparse
from core.services.supabase import DBConnection
from core.utils.logger import logger
from billing.config import get_tier_by_price_id, get_monthly_credits

class CreditBalanceFixer:
    def __init__(self, dry_run: bool = True):
        self.dry_run = dry_run
        self.db = DBConnection()
        self.fixes_applied = 0
        self.errors = []
        
    async def initialize(self):
        await self.db.initialize()
        self.client = await self.db.client
    
    async def analyze_user_credits(self, user_id: str) -> Dict:
        """
        Analyze a user's credit situation from ledger history.
        Returns detailed breakdown of credits.
        """
        # Get current account state
        account_result = await self.client.from_('credit_accounts')\
            .select('*')\
            .eq('user_id', user_id)\
            .maybe_single()\
            .execute()
        
        if not account_result.data:
            return None
        
        account = account_result.data
        current_balance = Decimal(str(account['balance']))
        current_expiring = Decimal(str(account.get('expiring_credits', 0)))
        current_non_expiring = Decimal(str(account.get('non_expiring_credits', 0)))
        
        # Get all ledger entries
        ledger_result = await self.client.from_('credit_ledger')\
            .select('*')\
            .eq('user_id', user_id)\
            .order('created_at')\
            .execute()
        
        # Calculate from ledger history
        total_tier_grants = Decimal('0')
        total_purchases = Decimal('0')
        total_usage = Decimal('0')
        
        for entry in ledger_result.data or []:
            amount = Decimal(str(entry['amount']))
            entry_type = entry['type']
            description = (entry.get('description') or '').lower()
            is_expiring = entry.get('is_expiring', None)
            
            # Categorize credits
            if entry_type == 'purchase' or 'purchased' in description:
                total_purchases += amount
            elif entry_type in ('tier_grant', 'tier_upgrade', 'subscription_renewal'):
                total_tier_grants += amount if amount > 0 else 0
            elif entry_type == 'usage' and amount < 0:
                total_usage += abs(amount)
        
        # Calculate what should remain (usage applied to expiring first)
        if total_usage > total_tier_grants:
            # All tier credits used, some purchases used
            calculated_expiring = Decimal('0')
            calculated_non_expiring = max(Decimal('0'), total_purchases - (total_usage - total_tier_grants))
        else:
            # Some tier credits remain
            calculated_expiring = total_tier_grants - total_usage
            calculated_non_expiring = total_purchases
        
        # Ensure values don't exceed current balance
        if calculated_expiring + calculated_non_expiring > current_balance:
            # Scale down proportionally
            total_calculated = calculated_expiring + calculated_non_expiring
            if total_calculated > 0:
                scale_factor = current_balance / total_calculated
                calculated_expiring = calculated_expiring * scale_factor
                calculated_non_expiring = calculated_non_expiring * scale_factor
        
        return {
            'user_id': user_id,
            'tier': account['tier'],
            'current': {
                'balance': current_balance,
                'expiring': current_expiring,
                'non_expiring': current_non_expiring,
                'sum': current_expiring + current_non_expiring
            },
            'calculated': {
                'expiring': calculated_expiring,
                'non_expiring': calculated_non_expiring,
                'sum': calculated_expiring + calculated_non_expiring
            },
            'ledger_totals': {
                'tier_grants': total_tier_grants,
                'purchases': total_purchases,
                'usage': total_usage
            },
            'needs_fix': abs((current_expiring + current_non_expiring) - current_balance) > Decimal('0.01')
        }
    
    async def fix_user_credits(self, user_id: str) -> bool:
        """
        Fix credit balance issues for a single user.
        """
        try:
            analysis = await self.analyze_user_credits(user_id)
            
            if not analysis:
                logger.warning(f"User {user_id} not found")
                return False
            
            current = analysis['current']
            calculated = analysis['calculated']
            
            # Check if fix is needed
            balance_mismatch = abs(current['sum'] - current['balance']) > Decimal('0.01')
            split_mismatch = (
                abs(current['expiring'] - calculated['expiring']) > Decimal('0.01') or
                abs(current['non_expiring'] - calculated['non_expiring']) > Decimal('0.01')
            )
            
            if not balance_mismatch and not split_mismatch:
                logger.info(f"User {user_id}: No fix needed, credits are consistent")
                return True
            
            # Determine what to fix
            logger.info(f"User {user_id} needs fixing:")
            logger.info(f"  Current: Balance=${current['balance']}, Expiring=${current['expiring']}, Non-expiring=${current['non_expiring']}")
            logger.info(f"  Calculated: Expiring=${calculated['expiring']:.2f}, Non-expiring=${calculated['non_expiring']:.2f}")
            
            # Use calculated values but ensure they sum to current balance
            fixed_expiring = calculated['expiring']
            fixed_non_expiring = calculated['non_expiring']
            
            # Adjust to match current balance exactly
            calculated_sum = fixed_expiring + fixed_non_expiring
            if abs(calculated_sum - current['balance']) > Decimal('0.01'):
                if calculated_sum > 0:
                    scale = current['balance'] / calculated_sum
                    fixed_expiring = fixed_expiring * scale
                    fixed_non_expiring = fixed_non_expiring * scale
                else:
                    # If no calculated credits, treat all as expiring
                    fixed_expiring = current['balance']
                    fixed_non_expiring = Decimal('0')
            
            # Round to 2 decimal places
            fixed_expiring = fixed_expiring.quantize(Decimal('0.01'))
            fixed_non_expiring = fixed_non_expiring.quantize(Decimal('0.01'))
            
            # Final adjustment to ensure exact match
            final_sum = fixed_expiring + fixed_non_expiring
            if final_sum != current['balance']:
                diff = current['balance'] - final_sum
                if fixed_expiring > 0:
                    fixed_expiring += diff
                else:
                    fixed_non_expiring += diff
            
            logger.info(f"  Fixed values: Expiring=${fixed_expiring}, Non-expiring=${fixed_non_expiring}")
            
            if self.dry_run:
                logger.info(f"  [DRY RUN] Would update user {user_id}")
                return True
            
            # Apply the fix
            update_result = await self.client.from_('credit_accounts').update({
                'expiring_credits': float(fixed_expiring),
                'non_expiring_credits': float(fixed_non_expiring),
                'updated_at': datetime.now(timezone.utc).isoformat()
            }).eq('user_id', user_id).execute()
            
            if update_result.data:
                logger.info(f"  ✅ Successfully fixed user {user_id}")
                self.fixes_applied += 1
                
                # Add audit ledger entry
                await self.client.from_('credit_ledger').insert({
                    'user_id': user_id,
                    'amount': '0',
                    'balance_after': str(current['balance']),
                    'type': 'adjustment',
                    'description': f"Balance fix: Adjusted split to ${fixed_expiring} expiring, ${fixed_non_expiring} non-expiring",
                    'metadata': {
                        'fix_type': 'credit_split_adjustment',
                        'old_expiring': str(current['expiring']),
                        'old_non_expiring': str(current['non_expiring']),
                        'new_expiring': str(fixed_expiring),
                        'new_non_expiring': str(fixed_non_expiring)
                    }
                }).execute()
                
                return True
            else:
                logger.error(f"  ❌ Failed to update user {user_id}")
                return False
                
        except Exception as e:
            logger.error(f"Error fixing user {user_id}: {e}")
            self.errors.append(f"User {user_id}: {str(e)}")
            return False
    
    async def find_and_fix_all_issues(self):
        """
        Find and fix all users with credit balance issues.
        """
        logger.info("Scanning for credit balance issues...")
        
        # Get all credit accounts
        accounts_result = await self.client.from_('credit_accounts')\
            .select('user_id, balance, expiring_credits, non_expiring_credits, tier')\
            .execute()
        
        if not accounts_result.data:
            logger.info("No credit accounts found")
            return
        
        issues_found = []
        
        for account in accounts_result.data:
            user_id = account['user_id']
            balance = Decimal(str(account['balance']))
            expiring = Decimal(str(account.get('expiring_credits', 0)))
            non_expiring = Decimal(str(account.get('non_expiring_credits', 0)))
            
            # Check for issues
            sum_credits = expiring + non_expiring
            if abs(sum_credits - balance) > Decimal('0.01'):
                issues_found.append({
                    'user_id': user_id,
                    'balance': balance,
                    'expiring': expiring,
                    'non_expiring': non_expiring,
                    'sum': sum_credits,
                    'diff': sum_credits - balance
                })
        
        if not issues_found:
            logger.info("✅ No balance issues found! All accounts are consistent.")
            return
        
        logger.warning(f"Found {len(issues_found)} accounts with balance issues")
        
        # Show summary
        for issue in issues_found[:10]:  # Show first 10
            logger.warning(
                f"  User {issue['user_id'][:8]}...: "
                f"Balance=${issue['balance']}, "
                f"Sum=${issue['sum']} "
                f"(diff=${issue['diff']:.2f})"
            )
        
        if len(issues_found) > 10:
            logger.info(f"  ... and {len(issues_found) - 10} more")
        
        if self.dry_run:
            logger.info("\n[DRY RUN] Would fix these issues")
            # Analyze a few in detail
            for issue in issues_found[:3]:
                await self.fix_user_credits(issue['user_id'])
        else:
            logger.info(f"\nFixing {len(issues_found)} accounts...")
            
            for issue in issues_found:
                await self.fix_user_credits(issue['user_id'])
            
            logger.info(f"\n✅ Fixed {self.fixes_applied} accounts")
            
            if self.errors:
                logger.error(f"❌ {len(self.errors)} errors occurred:")
                for error in self.errors[:10]:
                    logger.error(f"  - {error}")
    
    async def fix_specific_user(self, user_id: str):
        """
        Fix a specific user's credit balance.
        """
        logger.info(f"Analyzing user {user_id}...")
        
        analysis = await self.analyze_user_credits(user_id)
        
        if not analysis:
            logger.error(f"User {user_id} not found")
            return
        
        # Show detailed analysis
        logger.info("\n" + "="*60)
        logger.info(f"USER: {user_id}")
        logger.info(f"TIER: {analysis['tier']}")
        logger.info("="*60)
        
        logger.info("\nCURRENT STATE:")
        logger.info(f"  Balance: ${analysis['current']['balance']}")
        logger.info(f"  Expiring: ${analysis['current']['expiring']}")
        logger.info(f"  Non-expiring: ${analysis['current']['non_expiring']}")
        logger.info(f"  Sum: ${analysis['current']['sum']}")
        
        logger.info("\nCALCULATED FROM HISTORY:")
        logger.info(f"  Expiring: ${analysis['calculated']['expiring']:.2f}")
        logger.info(f"  Non-expiring: ${analysis['calculated']['non_expiring']:.2f}")
        logger.info(f"  Sum: ${analysis['calculated']['sum']:.2f}")
        
        logger.info("\nLEDGER TOTALS:")
        logger.info(f"  Tier grants: ${analysis['ledger_totals']['tier_grants']}")
        logger.info(f"  Purchases: ${analysis['ledger_totals']['purchases']}")
        logger.info(f"  Usage: ${analysis['ledger_totals']['usage']}")
        
        if analysis['needs_fix']:
            logger.warning("\n⚠️  This account needs fixing!")
            
            if not self.dry_run:
                success = await self.fix_user_credits(user_id)
                if success:
                    logger.info("✅ Account fixed successfully")
                else:
                    logger.error("❌ Failed to fix account")
        else:
            logger.info("\n✅ Account is already consistent")

async def main():
    parser = argparse.ArgumentParser(description='Fix credit balance issues')
    parser.add_argument('user_id', nargs='?', help='Specific user ID to fix')
    parser.add_argument('--dry-run', action='store_true', help='Run without making changes')
    parser.add_argument('--all', action='store_true', help='Fix all users with issues')
    
    args = parser.parse_args()
    
    if args.dry_run:
        logger.info("🔍 Running in DRY RUN mode - no changes will be made")
    else:
        logger.warning("⚠️  Running in PRODUCTION mode - changes will be made")
        if not args.user_id:
            response = input("Are you sure you want to proceed? (yes/no): ")
            if response.lower() != 'yes':
                logger.info("Operation cancelled")
                return
    
    fixer = CreditBalanceFixer(dry_run=args.dry_run)
    await fixer.initialize()
    
    if args.user_id:
        await fixer.fix_specific_user(args.user_id)
    elif args.all:
        await fixer.find_and_fix_all_issues()
    else:
        logger.info("Please specify either a user_id or use --all flag")
        logger.info("Usage: python fix_credit_balance_issue.py [user_id] [--dry-run] [--all]")

if __name__ == "__main__":
    asyncio.run(main()) 