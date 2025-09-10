#!/usr/bin/env python3
import asyncio
import sys
from pathlib import Path
from datetime import datetime, timezone
from decimal import Decimal
import time

backend_dir = Path(__file__).parent.parent.parent
sys.path.insert(0, str(backend_dir))

from core.services.supabase import DBConnection
from core.utils.logger import logger

class CleanupFreeTierService:
    def __init__(self):
        self.db = DBConnection()
        self.stats = {
            'total_free_users': 0,
            'converted': 0,
            'errors': 0,
            'start_time': time.time()
        }
    
    async def initialize(self):
        await self.db.initialize()
        self.client = await self.db.client
    
    async def run(self):
        print("\n" + "="*60)
        print("FREE TIER CLEANUP SERVICE")
        print("="*60)
        print("🧹 Converting ALL free tier users to 'none' with 0 credits")
        print("="*60)
        
        await self.initialize()
        await self.cleanup_free_tier()
        self.print_stats()
    
    async def cleanup_free_tier(self):
        print("\n🔄 CONVERTING FREE TIER USERS...")
        
        offset = 0
        batch_size = 100
        
        while True:
            free_users = await self.client.from_('credit_accounts')\
                .select('account_id, balance')\
                .eq('tier', 'free')\
                .range(offset, offset + batch_size - 1)\
                .execute()
            
            if not free_users.data:
                break
            
            self.stats['total_free_users'] += len(free_users.data)
            print(f"  Processing batch {offset//batch_size + 1} ({len(free_users.data)} users)...")
            
            account_ids = []
            ledger_entries = []
            
            for user in free_users.data:
                account_id = user['account_id']
                old_balance = Decimal(str(user.get('balance', 0)))
                
                account_ids.append(account_id)
                
                if old_balance > 0:
                    ledger_entries.append({
                        'account_id': account_id,
                        'amount': float(-old_balance),
                        'balance_after': 0,
                        'type': 'adjustment',
                        'description': 'Free tier discontinued - please start a trial to continue',
                        'created_at': datetime.now(timezone.utc).isoformat()
                    })
            
            if account_ids:
                try:
                    update_chunk_size = 20
                    
                    for i in range(0, len(account_ids), update_chunk_size):
                        chunk_ids = account_ids[i:i+update_chunk_size]
                        
                        await self.client.from_('credit_accounts')\
                            .update({
                                'tier': 'none',
                                'balance': 0,
                                'expiring_credits': 0,
                                'non_expiring_credits': 0,
                                'trial_status': None,
                                'updated_at': datetime.now(timezone.utc).isoformat()
                            })\
                            .in_('account_id', chunk_ids)\
                            .execute()
                        
                        self.stats['converted'] += len(chunk_ids)
                        print(f"    ✅ Converted {len(chunk_ids)} users")
                    
                    if ledger_entries:
                        for i in range(0, len(ledger_entries), 50):
                            chunk = ledger_entries[i:i+50]
                            await self.client.from_('credit_ledger').insert(chunk).execute()
                    
                except Exception as e:
                    logger.error(f"Error converting batch: {e}")
                    self.stats['errors'] += 1
                    print(f"    ❌ Error: {e}")
            
            offset += batch_size
            
            if len(free_users.data) < batch_size:
                break
        
        remaining = await self.client.from_('credit_accounts')\
            .select('account_id', count='exact')\
            .eq('tier', 'free')\
            .execute()
        
        if remaining.count and remaining.count > 0:
            print(f"\n⚠️  WARNING: {remaining.count} free tier users still remain!")
            print("  Run the script again to convert them.")
        else:
            print("\n✅ All free tier users successfully converted!")
    
    def print_stats(self):
        elapsed = time.time() - self.stats['start_time']
        
        print("\n" + "="*60)
        print("CLEANUP COMPLETE")
        print("="*60)
        print(f"⏱️  Time taken: {elapsed:.2f} seconds")
        print(f"👥 Total free users found: {self.stats['total_free_users']}")
        print(f"✅ Successfully converted: {self.stats['converted']}")
        print(f"❌ Errors: {self.stats['errors']}")
        print("="*60)

async def main():
    service = CleanupFreeTierService()
    try:
        await service.run()
    except Exception as e:
        print(f"\n❌ FATAL ERROR: {e}")
        logger.error(f"Cleanup failed: {e}", exc_info=True)
        sys.exit(1)

if __name__ == "__main__":
    print("Starting free tier cleanup service...")
    asyncio.run(main()) 