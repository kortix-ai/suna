#!/usr/bin/env python3
"""
Free Tier Cleanup Service

NOTE: This script is currently DISABLED pending Convex endpoint implementation.
The Supabase database operations have been removed and need to be replaced with Convex calls.
"""
import asyncio
import sys
from pathlib import Path
from datetime import datetime, timezone
from decimal import Decimal
import time

backend_dir = Path(__file__).parent.parent.parent
sys.path.insert(0, str(backend_dir))

from core.services.convex_client import get_convex_client
from core.utils.logger import logger

# CONVEX ENDPOINTS REQUIRED (not yet implemented):
# ================================
# 1. List credit accounts by tier:
#    convex.rpc("billing:listCreditAccounts", {"tier": "free"})
#    Returns: [{ accountId, tier, balance, ... }]
#
# 2. Batch update credit accounts:
#    convex.rpc("billing:batchUpdateCreditAccounts", {"accounts": [...]})
#    Body: { accounts: [{ accountId, tier, balance, ... }] }
#
# 3. Batch insert credit ledger entries:
#    convex.rpc("billing:batchCreateLedgerEntries", {"entries": [...]})
#    Body: { entries: [{ accountId, amount, type, description, ... }] }
#
# NOTE: When endpoints are implemented, use:
#   from core.services.convex_client import get_convex_client
#   convex = get_convex_client()
#   result = await convex.rpc("endpoint:name", params)

class CleanupFreeTierService:
    def __init__(self):
        # TODO: Initialize when Convex billing endpoints are available
        # self.convex = get_convex_client()
        self.convex = None
        self.stats = {
            'total_free_users': 0,
            'converted': 0,
            'errors': 0,
            'start_time': time.time()
        }

    async def run(self):
        """
        Clean up free tier users by converting to 'none' tier with 0 credits.

        Requires Convex endpoints:
        - billing:listCreditAccounts with tier filter
        - billing:batchUpdateCreditAccounts
        - billing:batchCreateLedgerEntries
        """
        print("\n" + "="*60)
        print("THIS SCRIPT IS DISABLED")
        print("="*60)
        print("This script requires Convex endpoints that are not yet implemented.")
        print("Required endpoints:")
        print("  - convex.rpc('billing:listCreditAccounts', {'tier': 'free'})")
        print("  - convex.rpc('billing:batchUpdateCreditAccounts', {'accounts': [...]})")
        print("  - convex.rpc('billing:batchCreateLedgerEntries', {'entries': [...]})")
        print("="*60)

        # TODO: Implement when Convex billing endpoints are available
        # convex = get_convex_client()
        #
        # # Get all free tier users
        # accounts = await convex.rpc("billing:listCreditAccounts", {"tier": "free"})
        # self.stats['total_free_users'] = len(accounts)
        #
        # # Prepare batch updates
        # updates = []
        # ledger_entries = []
        #
        # for account in accounts:
        #     updates.append({
        #         "accountId": account['accountId'],
        #         "tier": "none",
        #         "balance": 0,
        #         "expiringCredits": 0,
        #         "nonExpiringCredits": 0
        #     })
        #
        #     if account.get('balance', 0) > 0:
        #         ledger_entries.append({
        #             "accountId": account['accountId'],
        #             "amount": -account['balance'],
        #             "type": "cleanup",
        #             "description": "Free tier cleanup - credits removed"
        #         })
        #
        # # Batch update
        # await convex.rpc("billing:batchUpdateCreditAccounts", {"accounts": updates})
        # await convex.rpc("billing:batchCreateLedgerEntries", {"entries": ledger_entries})
        #
        # self.stats['converted'] = len(updates)
        # self.print_stats()
        return
    
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