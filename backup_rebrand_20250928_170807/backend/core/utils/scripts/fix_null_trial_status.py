#!/usr/bin/env python3
import asyncio
import sys
from pathlib import Path
from datetime import datetime, timezone

backend_dir = Path(__file__).parent.parent.parent
sys.path.insert(0, str(backend_dir))

from core.services.supabase import DBConnection
from core.utils.logger import logger

async def fix_null_trial_status():
    print("\n" + "="*60)
    print("FIX NULL TRIAL STATUS VALUES")
    print("="*60)
    
    db = DBConnection()
    await db.initialize()
    client = await db.client
    
    print("\n🔧 Finding users with NULL trial_status...")
    
    offset = 0
    batch_size = 500
    total_fixed = 0
    
    while True:
        result = await client.from_('credit_accounts')\
            .select('account_id, tier, stripe_subscription_id, trial_status')\
            .is_('trial_status', 'null')\
            .range(offset, offset + batch_size - 1)\
            .execute()
        
        if not result.data:
            break
        
        print(f"\nProcessing batch with {len(result.data)} users...")
        
        none_status_users = []
        converted_status_users = []
        
        for user in result.data:
            account_id = user['account_id']
            tier = user.get('tier')
            has_stripe = bool(user.get('stripe_subscription_id'))
            
            paid_tiers = ['tier_2_20', 'tier_6_50', 'tier_12_100', 'tier_25_200', 'tier_50_400', 'tier_150_1200']
            
            if tier in paid_tiers or has_stripe:
                converted_status_users.append(account_id)
                print(f"  - {account_id}: tier={tier}, has_stripe={has_stripe} -> 'converted'")
            else:
                none_status_users.append(account_id)
                print(f"  - {account_id}: tier={tier}, has_stripe={has_stripe} -> 'none'")
        
        if none_status_users:
            try:
                await client.from_('credit_accounts')\
                    .update({
                        'trial_status': 'none',
                        'updated_at': datetime.now(timezone.utc).isoformat()
                    })\
                    .in_('account_id', none_status_users)\
                    .execute()
                
                print(f"  ✅ Fixed {len(none_status_users)} users to 'none'")
                total_fixed += len(none_status_users)
            except Exception as e:
                logger.error(f"Error fixing 'none' status batch: {e}")
                print(f"  ❌ Error: {e}")
        
        if converted_status_users:
            try:
                await client.from_('credit_accounts')\
                    .update({
                        'trial_status': 'converted',
                        'updated_at': datetime.now(timezone.utc).isoformat()
                    })\
                    .in_('account_id', converted_status_users)\
                    .execute()
                
                print(f"  ✅ Fixed {len(converted_status_users)} users to 'converted'")
                total_fixed += len(converted_status_users)
            except Exception as e:
                logger.error(f"Error fixing 'converted' status batch: {e}")
                print(f"  ❌ Error: {e}")
        
        offset += batch_size
        
        if len(result.data) < batch_size:
            break
    
    print("\n" + "="*60)
    print(f"✅ COMPLETE: Fixed {total_fixed} users with NULL trial_status")
    print("="*60)

async def main():
    try:
        await fix_null_trial_status()
    except Exception as e:
        print(f"\n❌ FATAL ERROR: {e}")
        logger.error(f"Fix failed: {e}", exc_info=True)
        sys.exit(1)

if __name__ == "__main__":
    print("Starting fix for NULL trial_status values...")
    asyncio.run(main()) 