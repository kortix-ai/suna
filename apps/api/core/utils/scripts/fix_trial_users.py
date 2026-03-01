#!/usr/bin/env python3
"""
Fix trial users with incorrect credit classification.

NOTE: This script is currently DISABLED pending Convex endpoint implementation.

Convex Endpoints Required:
==========================
1. admin:listCreditAccounts - List credit accounts by trial status
   Params: { trialStatus?: string[] }
   Returns: [{ accountId, trialStatus, nonExpiringCredits, ... }]

2. admin:updateCreditAccount - Update credit account
   Params: { accountId, nonExpiringCredits?, expiringCredits?, balance?, trialStatus? }
   Returns: { success: boolean }

3. admin:createLedgerEntry - Insert credit ledger entry
   Params: { accountId, amount, type, description, ... }
   Returns: { entryId }
"""
import asyncio
import sys
from pathlib import Path
from datetime import datetime, timezone
from decimal import Decimal

backend_dir = Path(__file__).parent.parent.parent
sys.path.insert(0, str(backend_dir))

from core.services.convex_client import get_convex_client
from core.utils.logger import logger

async def fix_trial_users():
    """
    Fix users who incorrectly have trial credits as non-expiring.

    Requires Convex admin endpoints:
    - admin:listCreditAccounts
    - admin:updateCreditAccount
    - admin:createLedgerEntry
    """
    convex = get_convex_client()

    print("\n" + "="*60)
    print("⚠️  THIS SCRIPT IS DISABLED")
    print("="*60)
    print("This script requires Convex admin endpoints that are not yet implemented.")
    print("Required endpoints:")
    print("  - admin:listCreditAccounts (with trialStatus filter)")
    print("  - admin:updateCreditAccount")
    print("  - admin:createLedgerEntry")
    print("="*60)

    # Find users on trial or recently converted from trial via Convex admin RPC
    accounts = await convex.admin_rpc("listCreditAccounts", {
        "trialStatus": ["active", "converted"]
    })

    fixed_count = 0
    for account in accounts:
        non_expiring = Decimal(str(account.get('nonExpiringCredits', 0)))
        trial_status = account.get('trialStatus')

        if non_expiring >= Decimal('5') and trial_status in ['active', 'converted']:
            # Convert non-expiring to expiring via Convex admin RPC
            await convex.admin_rpc("updateCreditAccount", {
                "accountId": account['accountId'],
                "nonExpiringCredits": 0,
                "expiringCredits": float(non_expiring),
                "trialStatus": "converted"
            })

            # Log to ledger via Convex admin RPC
            await convex.admin_rpc("createLedgerEntry", {
                "accountId": account['accountId'],
                "amount": float(-non_expiring),
                "type": "trial_conversion",
                "description": "Converted trial credits to expiring"
            })
            fixed_count += 1

    print(f"COMPLETED: Fixed {fixed_count} users")
    return

if __name__ == "__main__":
    asyncio.run(fix_trial_users())