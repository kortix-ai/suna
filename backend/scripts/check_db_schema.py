#!/usr/bin/env python3
import asyncio
import sys
from pathlib import Path
sys.path.append(str(Path(__file__).parent.parent))

from core.services.supabase import DBConnection
from core.utils.logger import logger

async def check_schema():
    db = DBConnection()
    await db.initialize()
    client = await db.client
    
    print("\n" + "="*60)
    print("CHECKING DATABASE SCHEMA")
    print("="*60)
    
    # Check if credit_accounts table exists
    try:
        result = await client.from_('credit_accounts').select('*').limit(1).execute()
        print("\n✓ credit_accounts table exists")
        if result.data and len(result.data) > 0:
            print("  Columns found:", list(result.data[0].keys()))
        else:
            # Try to insert a dummy record to see what columns exist
            try:
                await client.from_('credit_accounts').insert({
                    'user_id': '00000000-0000-0000-0000-000000000000',
                    'balance': '0'
                }).execute()
            except Exception as e:
                print(f"  Table structure check error: {e}")
    except Exception as e:
        print(f"\n✗ credit_accounts table issue: {e}")
    
    # Check if credit_ledger table exists
    try:
        result = await client.from_('credit_ledger').select('*').limit(1).execute()
        print("\n✓ credit_ledger table exists")
        if result.data and len(result.data) > 0:
            print("  Columns found:", list(result.data[0].keys()))
    except Exception as e:
        print(f"\n✗ credit_ledger table issue: {e}")
    
    # Check if credit_grants table exists
    try:
        result = await client.from_('credit_grants').select('*').limit(1).execute()
        print("\n✓ credit_grants table exists")
        if result.data and len(result.data) > 0:
            print("  Columns found:", list(result.data[0].keys()))
    except Exception as e:
        print(f"\n✗ credit_grants table issue: {e}")
    
    # Check if user_roles table exists
    try:
        result = await client.from_('user_roles').select('*').limit(1).execute()
        print("\n✓ user_roles table exists")
        if result.data and len(result.data) > 0:
            print("  Columns found:", list(result.data[0].keys()))
    except Exception as e:
        print(f"\n✗ user_roles table issue: {e}")
    
    # Check if admin_actions_log table exists
    try:
        result = await client.from_('admin_actions_log').select('*').limit(1).execute()
        print("\n✓ admin_actions_log table exists")
        if result.data and len(result.data) > 0:
            print("  Columns found:", list(result.data[0].keys()))
    except Exception as e:
        print(f"\n✗ admin_actions_log table issue: {e}")
    
    # Check if the RPC functions exist
    print("\n" + "="*60)
    print("CHECKING RPC FUNCTIONS")
    print("="*60)
    
    try:
        # This will fail but the error will tell us if the function exists
        await client.rpc('deduct_credits', {
            'p_user_id': '00000000-0000-0000-0000-000000000000',
            'p_amount': '0',
            'p_description': 'test'
        }).execute()
        print("✓ deduct_credits function exists")
    except Exception as e:
        if 'Could not find the function' in str(e):
            print("✗ deduct_credits function NOT FOUND")
        else:
            print("✓ deduct_credits function exists (execution test failed as expected)")
    
    try:
        await client.rpc('add_credits', {
            'p_user_id': '00000000-0000-0000-0000-000000000000',
            'p_amount': '0',
            'p_description': 'test'
        }).execute()
        print("✓ add_credits function exists")
    except Exception as e:
        if 'Could not find the function' in str(e):
            print("✗ add_credits function NOT FOUND")
        else:
            print("✓ add_credits function exists (execution test failed as expected)")
    
    print("\n" + "="*60)
    print("SCHEMA CHECK COMPLETE")
    print("="*60)
    print("\nIf tables or columns are missing, you need to run the migrations:")
    print("1. Check that migration files exist in backend/supabase/migrations/")
    print("2. Run: supabase db push")
    print("3. Or manually apply migrations in Supabase SQL editor")

if __name__ == "__main__":
    asyncio.run(check_schema()) 