#!/usr/bin/env python3
"""
Script to debug and fix credit balance issues.

This script analyzes the credit ledger to understand what happened
and can optionally fix the balance.
"""

import asyncio
import sys
from datetime import datetime, timezone, timedelta
from decimal import Decimal
from typing import Dict, List, Optional
import logging

# Add parent directory to path for imports
sys.path.append('/Users/saumya/Desktop/suna/backend')

from core.services.supabase import DBConnection
from core.utils.logger import setup_logger

logger = setup_logger(__name__)


class CreditDebugger:
    """Debug and fix credit balance issues."""
    
    def __init__(self):
        self.db = DBConnection()
    
    async def analyze_user_credits(self, user_id: str, hours_back: int = 24):
        """Analyze recent credit transactions for a user."""
        client = await self.db.client
        
        print(f"\n{'='*60}")
        print(f"CREDIT ANALYSIS FOR USER: {user_id}")
        print(f"{'='*60}\n")
        
        # Get current state
        account_result = await client.from_('credit_accounts').select(
            'balance, expiring_credits, non_expiring_credits, tier, last_grant_date, next_credit_grant'
        ).eq('user_id', user_id).execute()
        
        if not account_result.data:
            print("❌ No credit account found for this user")
            return
        
        account = account_result.data[0]
        print("📊 CURRENT ACCOUNT STATE:")
        print(f"  Total Balance: ${account['balance']}")
        print(f"  Expiring Credits: ${account['expiring_credits']}")
        print(f"  Non-expiring Credits: ${account['non_expiring_credits']}")
        print(f"  Tier: {account['tier']}")
        print(f"  Last Grant: {account.get('last_grant_date', 'Never')}")
        print(f"  Next Grant: {account.get('next_credit_grant', 'Unknown')}")
        
        # Check for discrepancy
        calculated_total = float(account['expiring_credits']) + float(account['non_expiring_credits'])
        actual_total = float(account['balance'])
        
        if abs(calculated_total - actual_total) > 0.01:
            print(f"\n⚠️  BALANCE MISMATCH DETECTED!")
            print(f"  Calculated Total: ${calculated_total:.2f}")
            print(f"  Actual Total: ${actual_total:.2f}")
            print(f"  Difference: ${abs(calculated_total - actual_total):.2f}")
        else:
            print(f"\n✅ Balance is consistent")
        
        # Get recent transactions
        since = datetime.now(timezone.utc) - timedelta(hours=hours_back)
        
        ledger_result = await client.from_('credit_ledger').select(
            'amount, balance_after, type, description, created_at, metadata, is_expiring'
        ).eq('user_id', user_id).gte('created_at', since.isoformat()).order('created_at', desc=False).execute()
        
        print(f"\n📜 RECENT TRANSACTIONS (last {hours_back} hours):")
        print("-" * 60)
        
        if not ledger_result.data:
            print("No transactions found in this period")
        else:
            for txn in ledger_result.data:
                created_at = datetime.fromisoformat(txn['created_at'].replace('Z', '+00:00'))
                amount = float(txn['amount'])
                balance_after = float(txn['balance_after'])
                
                # Determine credit type
                if txn['type'] == 'purchase':
                    credit_type = "NON-EXPIRING"
                    emoji = "💰"
                elif txn['type'] in ('tier_grant', 'tier_upgrade'):
                    credit_type = "EXPIRING"
                    emoji = "📅"
                elif txn['type'] == 'usage':
                    credit_type = "USAGE"
                    emoji = "🔻"
                else:
                    credit_type = txn['type'].upper()
                    emoji = "❓"
                
                print(f"\n{emoji} {created_at.strftime('%Y-%m-%d %H:%M:%S UTC')}")
                print(f"  Type: {txn['type']} ({credit_type})")
                print(f"  Amount: ${amount:+.2f}")
                print(f"  Balance After: ${balance_after:.2f}")
                print(f"  Description: {txn['description']}")
                
                if txn.get('metadata'):
                    metadata = txn['metadata']
                    if isinstance(metadata, dict):
                        if metadata.get('from_expiring') or metadata.get('from_non_expiring'):
                            print(f"  Deducted from: Expiring=${metadata.get('from_expiring', 0)}, Non-expiring=${metadata.get('from_non_expiring', 0)}")
                        if metadata.get('renewal'):
                            print(f"  ⚠️ RENEWAL - Non-expiring preserved: ${metadata.get('non_expiring_preserved', 0)}")
        
        # Calculate what the balance should be based on transactions
        print(f"\n🔍 TRANSACTION ANALYSIS:")
        print("-" * 40)
        
        # Sum up different transaction types
        purchase_total = Decimal('0')
        tier_grant_total = Decimal('0')
        usage_total = Decimal('0')
        
        all_ledger = await client.from_('credit_ledger').select(
            'amount, type'
        ).eq('user_id', user_id).execute()
        
        for entry in all_ledger.data:
            amount = Decimal(str(entry['amount']))
            if entry['type'] == 'purchase' and amount > 0:
                purchase_total += amount
            elif entry['type'] in ('tier_grant', 'tier_upgrade') and amount > 0:
                tier_grant_total += amount
            elif entry['type'] == 'usage' and amount < 0:
                usage_total += abs(amount)
        
        print(f"  Total Purchased (non-expiring): ${purchase_total:.2f}")
        print(f"  Total Tier Grants (expiring): ${tier_grant_total:.2f}")
        print(f"  Total Usage: ${usage_total:.2f}")
        
        # Calculate expected balances
        if usage_total > tier_grant_total:
            expected_expiring = Decimal('0')
            expected_non_expiring = purchase_total - (usage_total - tier_grant_total)
        else:
            expected_expiring = tier_grant_total - usage_total
            expected_non_expiring = purchase_total
        
        expected_non_expiring = max(Decimal('0'), expected_non_expiring)
        expected_expiring = max(Decimal('0'), expected_expiring)
        
        print(f"\n📐 EXPECTED BALANCES (based on all transactions):")
        print(f"  Expected Expiring: ${expected_expiring:.2f}")
        print(f"  Expected Non-expiring: ${expected_non_expiring:.2f}")
        print(f"  Expected Total: ${(expected_expiring + expected_non_expiring):.2f}")
        
        print(f"\n🆚 COMPARISON:")
        print(f"  Actual Expiring: ${account['expiring_credits']} (Expected: ${expected_expiring:.2f})")
        print(f"  Actual Non-expiring: ${account['non_expiring_credits']} (Expected: ${expected_non_expiring:.2f})")
        
        return {
            'account': account,
            'expected_expiring': expected_expiring,
            'expected_non_expiring': expected_non_expiring,
            'purchase_total': purchase_total,
            'tier_grant_total': tier_grant_total,
            'usage_total': usage_total
        }
    
    async def fix_user_balance(self, user_id: str, dry_run: bool = True):
        """Fix user's credit balance based on transaction history."""
        analysis = await self.analyze_user_credits(user_id, hours_back=720)  # Look back 30 days
        
        if not analysis:
            return
        
        account = analysis['account']
        expected_expiring = analysis['expected_expiring']
        expected_non_expiring = analysis['expected_non_expiring']
        expected_total = expected_expiring + expected_non_expiring
        
        current_expiring = Decimal(str(account['expiring_credits']))
        current_non_expiring = Decimal(str(account['non_expiring_credits']))
        current_total = Decimal(str(account['balance']))
        
        print(f"\n{'='*60}")
        print(f"FIX CREDIT BALANCE")
        print(f"{'='*60}\n")
        
        if (abs(current_expiring - expected_expiring) < 0.01 and 
            abs(current_non_expiring - expected_non_expiring) < 0.01):
            print("✅ Balance is already correct, no fix needed")
            return
        
        print(f"🔧 PROPOSED FIX:")
        print(f"  Expiring: ${current_expiring:.2f} → ${expected_expiring:.2f}")
        print(f"  Non-expiring: ${current_non_expiring:.2f} → ${expected_non_expiring:.2f}")
        print(f"  Total: ${current_total:.2f} → ${expected_total:.2f}")
        
        if dry_run:
            print(f"\n⚠️  DRY RUN - No changes will be made")
            print(f"Run with --fix to apply these changes")
        else:
            client = await self.db.client
            
            # Update the account
            await client.from_('credit_accounts').update({
                'expiring_credits': float(expected_expiring),
                'non_expiring_credits': float(expected_non_expiring),
                'balance': float(expected_total),
                'updated_at': datetime.now(timezone.utc).isoformat()
            }).eq('user_id', user_id).execute()
            
            # Add audit entry to ledger
            await client.from_('credit_ledger').insert({
                'user_id': user_id,
                'amount': 0,
                'balance_after': float(expected_total),
                'type': 'adjustment',
                'description': f"Balance correction: Fixed expiring/non-expiring split based on transaction history",
                'metadata': {
                    'fix_applied': True,
                    'old_expiring': float(current_expiring),
                    'old_non_expiring': float(current_non_expiring),
                    'new_expiring': float(expected_expiring),
                    'new_non_expiring': float(expected_non_expiring)
                }
            }).execute()
            
            print(f"\n✅ Balance fixed successfully!")


async def main():
    """Main entry point."""
    import argparse
    
    parser = argparse.ArgumentParser(description='Debug and fix credit balance issues')
    parser.add_argument('user_id', help='User ID to analyze')
    parser.add_argument('--hours', type=int, default=24, help='Hours to look back for recent transactions')
    parser.add_argument('--fix', action='store_true', help='Apply the fix (default is dry run)')
    
    args = parser.parse_args()
    
    debugger = CreditDebugger()
    
    try:
        if args.fix:
            await debugger.fix_user_balance(args.user_id, dry_run=False)
        else:
            await debugger.analyze_user_credits(args.user_id, hours_back=args.hours)
            print(f"\n💡 To fix any issues, run with --fix flag")
    except Exception as e:
        logger.error(f"Error: {e}", exc_info=True)
        sys.exit(1)


if __name__ == '__main__':
    asyncio.run(main()) 