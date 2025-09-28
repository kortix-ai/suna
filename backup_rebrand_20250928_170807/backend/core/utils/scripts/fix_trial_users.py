#!/usr/bin/env python3
import asyncio
import sys
from pathlib import Path
from datetime import datetime, timezone, timedelta
from decimal import Decimal

backend_dir = Path(__file__).parent.parent.parent
sys.path.insert(0, str(backend_dir))

from core.services.supabase import DBConnection
from core.utils.logger import logger
from billing.credit_manager import credit_manager

async def fix_trial_users():
    """Fix users who incorrectly have trial credits as non-expiring"""
    db = DBConnection()
    await db.initialize()
    client = await db.client
    
    print("\n" + "="*60)
    print("FIXING TRIAL USERS WITH INCORRECT NON-EXPIRING CREDITS")
    print("="*60)
    
    # Find users on trial or recently converted from trial
    result = await client.from_('credit_accounts')\
        .select('*')\
        .in_('trial_status', ['active', 'converted'])\
        .execute()
    
    if not result.data:
        print("No trial users found")
        return
    
    fixed_count = 0
    
    for account in result.data:
        account_id = account['account_id']
        tier = account.get('tier', 'none')
        trial_status = account.get('trial_status')
        non_expiring = Decimal(str(account.get('non_expiring_credits', 0)))
        expiring = Decimal(str(account.get('expiring_credits', 0)))
        balance = Decimal(str(account.get('balance', 0)))
        

        if non_expiring >= Decimal('5') and trial_status in ['active', 'converted']:
            print(f"\nUser {account_id[:8]}... has incorrect trial credits:")
            print(f"  Trial Status: {trial_status}")
            print(f"  Current Balance: ${balance}")
            print(f"  Non-expiring: ${non_expiring} (INCORRECT - includes trial credits)")
            print(f"  Expiring: ${expiring}")
            
            # Calculate the correction
            trial_amount = Decimal('5')
            corrected_non_expiring = non_expiring - trial_amount
            corrected_expiring = expiring + trial_amount
            
            # The total balance should remain the same
            print(f"\n  Correcting to:")
            print(f"  Non-expiring: ${corrected_non_expiring} (removed trial credits)")
            print(f"  Expiring: ${corrected_expiring} (added trial credits)")
            print(f"  Total Balance: ${balance} (unchanged)")
            
            # Update the credit account
            update_result = await client.from_('credit_accounts').update({
                'non_expiring_credits': float(corrected_non_expiring),
                'expiring_credits': float(corrected_expiring),
                'updated_at': datetime.now(timezone.utc).isoformat()
            }).eq('account_id', account_id).execute()
            
            if update_result.data:
                # Add ledger entry for audit trail
                await client.from_('credit_ledger').insert({
                    'account_id': account_id,
                    'amount': 0,  # No balance change, just reclassification
                    'balance_after': float(balance),
                    'type': 'adjustment',
                    'description': 'Fixed trial credits: moved $5 from non-expiring to expiring'
                }).execute()
                
                print(f"  ✅ Fixed credits for user {account_id[:8]}...")
                fixed_count += 1
            else:
                print(f"  ❌ Failed to fix user {account_id[:8]}...")
    
    print(f"\n{'='*60}")
    print(f"COMPLETED: Fixed {fixed_count} users")
    print("="*60)

if __name__ == "__main__":
    asyncio.run(fix_trial_users()) 