#!/usr/bin/env python3
"""
Fix NULL trial status values.

NOTE: This script is currently DISABLED pending Convex endpoint implementation.
"""

import asyncio
import sys
from pathlib import Path
from datetime import datetime, timezone

backend_dir = Path(__file__).parent.parent.parent
sys.path.insert(0, str(backend_dir))

from core.services.convex_client import get_convex_client
from core.utils.logger import logger

# CONVEX ENDPOINTS REQUIRED (not yet implemented):
# ================================
# 1. List credit accounts with NULL filter:
#    convex.rpc("billing:listCreditAccounts", {"trialStatus": None})
#    Returns: [{ accountId, tier, trialStatus, ... }]
#
# 2. Batch update credit accounts:
#    convex.rpc("billing:batchUpdateCreditAccounts", {"accounts": [...]})
#    Body: { accounts: [{ accountId, trialStatus, ... }] }
#
# NOTE: When endpoints are implemented, use:
#   from core.services.convex_client import get_convex_client
#   convex = get_convex_client()
#   result = await convex.rpc("endpoint:name", params)

async def fix_null_trial_status():
    """
    Fix NULL trial_status values in credit_accounts.

    Requires Convex endpoints:
    - billing:listCreditAccounts with trialStatus filter
    - billing:batchUpdateCreditAccounts
    """
    print("\n" + "="*60)
    print("THIS SCRIPT IS DISABLED")
    print("="*60)
    print("This script requires Convex endpoints that are not yet implemented.")
    print("Required endpoints:")
    print("  - convex.rpc('billing:listCreditAccounts', {'trialStatus': None})")
    print("  - convex.rpc('billing:batchUpdateCreditAccounts', {'accounts': [...]})")
    print("="*60)

    # TODO: Implement when Convex billing endpoints are available
    # convex = get_convex_client()
    #
    # # Find all accounts with NULL trial_status
    # accounts = await convex.rpc("billing:listCreditAccounts", {
    #     "trialStatus": None  # NULL filter
    # })
    #
    # print(f"Found {len(accounts)} accounts with NULL trial_status")
    #
    # # Prepare batch update
    # updates = []
    # for account in accounts:
    #     # Determine appropriate trial_status based on tier
    #     if account['tier'] == 'none':
    #         new_status = 'not_started'
    #     elif account['tier'] in ['pro', 'team', 'enterprise']:
    #         new_status = 'converted'
    #     else:
    #         new_status = 'not_started'
    #
    #     updates.append({
    #         "accountId": account['accountId'],
    #         "trialStatus": new_status
    #     })
    #
    # # Batch update
    # if updates:
    #     await convex.rpc("billing:batchUpdateCreditAccounts", {"accounts": updates})
    #     print(f"Fixed {len(updates)} accounts")
    return

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
