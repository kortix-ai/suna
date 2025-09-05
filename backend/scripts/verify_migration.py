#!/usr/bin/env python3
import asyncio
import sys
from pathlib import Path
sys.path.append(str(Path(__file__).parent.parent))

from decimal import Decimal
from core.services.supabase import DBConnection
from core.utils.logger import logger

async def verify_migration():
    db = DBConnection()
    await db.initialize()
    client = await db.client
    
    print("\n" + "="*60)
    print("CREDIT SYSTEM MIGRATION VERIFICATION")
    print("="*60)

    accounts = await client.from_('credit_accounts').select('*').execute()
    
    if not accounts.data:
        print("❌ No credit accounts found!")
        return
    
    print(f"\n✅ Found {len(accounts.data)} credit accounts")
    print("\nUser Credit Summary:")
    print("-" * 60)
    
    total_balance = Decimal('0')
    tier_counts = {}
    
    for account in accounts.data:
        user_id = account['user_id']
        balance = Decimal(str(account['balance']))
        tier = account.get('tier', 'unknown')
        last_grant = account.get('last_grant_date', 'Never')
        
        total_balance += balance
        tier_counts[tier] = tier_counts.get(tier, 0) + 1
        
        print(f"User: {user_id[:8]}...")
        print(f"  Balance: ${balance:.2f}")
        print(f"  Tier: {tier}")
        print(f"  Last Grant: {last_grant}")
        print()
    
    print("="*60)
    print("SUMMARY STATISTICS")
    print("="*60)
    print(f"Total Users: {len(accounts.data)}")
    print(f"Total Credits in System: ${total_balance:.2f}")
    print(f"Average Balance: ${(total_balance / len(accounts.data)):.2f}")
    print("\nUsers by Tier:")
    for tier, count in sorted(tier_counts.items()):
        print(f"  {tier}: {count} users")
    
    # Check ledger entries
    ledger = await client.from_('credit_ledger').select('type').execute()
    if ledger.data:
        type_counts = {}
        for entry in ledger.data:
            entry_type = entry['type']
            type_counts[entry_type] = type_counts.get(entry_type, 0) + 1
        
        print("\nLedger Entry Types:")
        for entry_type, count in sorted(type_counts.items()):
            print(f"  {entry_type}: {count} entries")
    
    # Check grants
    grants = await client.from_('credit_grants').select('*').execute()
    if grants.data:
        print(f"\nCredit Grants Recorded: {len(grants.data)}")
    
    print("\n" + "="*60)
    print("✅ MIGRATION VERIFICATION COMPLETE")
    print("="*60)

if __name__ == "__main__":
    asyncio.run(verify_migration()) 