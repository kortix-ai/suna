#!/usr/bin/env python3
import asyncio
import sys
from pathlib import Path
sys.path.append(str(Path(__file__).parent.parent))

from core.services.supabase import DBConnection
from core.billing_config import get_tier_by_price_id
from core.utils.logger import logger

async def verify_and_fix_tiers():
    """Verify that all users have the correct tier in credit_accounts"""
    db = DBConnection()
    await db.initialize()
    client = await db.client
    
    print("\n" + "="*60)
    print("VERIFYING USER TIERS")
    print("="*60)
    
    # Get all active/trialing subscriptions
    subs_result = await client.schema('basejump').from_('billing_subscriptions')\
        .select('*')\
        .in_('status', ['active', 'trialing'])\
        .execute()
    
    if not subs_result.data:
        print("No active subscriptions found")
        return
    
    print(f"Found {len(subs_result.data)} active/trialing subscriptions")
    
    fixed = 0
    already_correct = 0
    errors = 0
    
    for sub in subs_result.data:
        user_id = sub['account_id']
        price_id = sub.get('price_id')
        
        if not price_id:
            print(f"\nUser {user_id[:8]}... has no price_id in subscription")
            continue
        
        # Get the tier from price_id
        tier = get_tier_by_price_id(price_id)
        if not tier:
            print(f"\nUser {user_id[:8]}... has unknown price_id: {price_id}")
            continue
        
        expected_tier = tier.name
        
        # Get current credit account
        credit_result = await client.from_('credit_accounts')\
            .select('tier')\
            .eq('user_id', user_id)\
            .single()\
            .execute()
        
        if not credit_result.data:
            print(f"\nUser {user_id[:8]}... has no credit account!")
            errors += 1
            continue
        
        current_tier = credit_result.data['tier']
        
        if current_tier != expected_tier:
            print(f"\nUser {user_id[:8]}...")
            print(f"  Current tier: {current_tier}")
            print(f"  Expected tier: {expected_tier}")
            print(f"  Price ID: {price_id}")
            
            # Fix the tier
            update_result = await client.from_('credit_accounts')\
                .update({'tier': expected_tier})\
                .eq('user_id', user_id)\
                .execute()
            
            if update_result.data:
                print(f"  ✓ Fixed tier to: {expected_tier}")
                fixed += 1
            else:
                print(f"  ✗ Failed to update tier")
                errors += 1
        else:
            already_correct += 1
    
    print("\n" + "="*60)
    print("SUMMARY")
    print("="*60)
    print(f"Already correct: {already_correct}")
    print(f"Fixed: {fixed}")
    print(f"Errors: {errors}")
    print(f"Total: {already_correct + fixed + errors}")

if __name__ == "__main__":
    asyncio.run(verify_and_fix_tiers()) 