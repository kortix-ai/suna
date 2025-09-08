#!/usr/bin/env python3
"""
Debug basejump account creation issues
Run with: python test_basejump_debug.py
"""
import os
import asyncio
from supabase import create_client, Client
from core.services.supabase import DBConnection
import uuid

async def test_basejump_debug():
    print("=" * 60)
    print("DEBUGGING BASEJUMP ACCOUNT CREATION")
    print("=" * 60)
    
    db = DBConnection()
    client = await db.client
    
    print("\n1. CHECKING BASEJUMP SCHEMA:")
    try:
        result = await client.rpc('sql', {'query': """
            SELECT 
                table_name,
                column_name,
                data_type,
                is_nullable
            FROM information_schema.columns
            WHERE table_schema = 'basejump'
            AND table_name IN ('accounts', 'account_user')
            ORDER BY table_name, ordinal_position
        """}).execute()
        
        print("   Basejump tables structure:")
        current_table = None
        for row in result.data:
            if row['table_name'] != current_table:
                current_table = row['table_name']
                print(f"\n   Table: {current_table}")
            print(f"     - {row['column_name']}: {row['data_type']} (nullable: {row['is_nullable']})")
    except Exception as e:
        print(f"   ❌ Failed to check schema: {e}")
    
    print("\n2. CHECKING BASEJUMP TRIGGER:")
    try:
        result = await client.rpc('sql', {'query': """
            SELECT 
                trigger_name,
                event_manipulation,
                event_object_table,
                action_statement
            FROM information_schema.triggers
            WHERE trigger_schema = 'auth'
            AND event_object_table = 'users'
        """}).execute()
        
        print("   Triggers on auth.users:")
        for row in result.data:
            print(f"     - {row['trigger_name']}: {row['event_manipulation']} -> {row['action_statement']}")
    except Exception as e:
        print(f"   ❌ Failed to check triggers: {e}")
    
    print("\n3. TESTING DIRECT BASEJUMP ACCOUNT CREATION:")
    test_user_id = str(uuid.uuid4())
    print(f"   Test user ID: {test_user_id}")
    
    try:
        result = await client.rpc('sql', {'query': f"""
            -- Try to create a basejump account directly
            INSERT INTO basejump.accounts (id, name, primary_owner_user_id, personal_account)
            VALUES ('{test_user_id}', 'test_user', '{test_user_id}', true)
            ON CONFLICT (id) DO NOTHING
            RETURNING id;
        """}).execute()
        
        if result.data:
            print(f"   ✅ Successfully created basejump account: {result.data}")
            
            await client.rpc('sql', {'query': f"""
                DELETE FROM basejump.accounts WHERE id = '{test_user_id}'
            """}).execute()
            print("   ✅ Cleaned up test account")
        else:
            print("   ⚠️  Account creation returned no data (might already exist)")
    except Exception as e:
        print(f"   ❌ Failed to create basejump account: {e}")
    
    print("\n4. CHECKING FOR CONSTRAINT VIOLATIONS:")
    try:
        result = await client.rpc('sql', {'query': """
            SELECT 
                conname,
                pg_get_constraintdef(oid) as definition
            FROM pg_constraint
            WHERE connamespace = 'basejump'::regnamespace
            AND contype IN ('c', 'u', 'f')
        """}).execute()
        
        print("   Basejump constraints:")
        for row in result.data:
            print(f"     - {row['conname']}: {row['definition']}")
    except Exception as e:
        print(f"   ❌ Failed to check constraints: {e}")
    
    print("\n5. CHECKING EXISTING ACCOUNT COUNT:")
    try:
        result = await client.table('accounts').select('count', count='exact').execute()
        print(f"   Total accounts in basejump.accounts: {result.count}")
    except Exception as e:
        print(f"   ❌ Failed to count accounts: {e}")
        
        try:
            result = await client.schema('basejump').table('accounts').select('count', count='exact').execute()
            print(f"   Total accounts (retry with schema): {result.count}")
        except Exception as e2:
            print(f"   ❌ Failed again: {e2}")
    
    print("\n" + "=" * 60)
    print("DIAGNOSIS COMPLETE")
    print("=" * 60)

if __name__ == "__main__":
    asyncio.run(test_basejump_debug()) 