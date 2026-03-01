#!/usr/bin/env python3
"""
Simple script to check what's in the credit_purchases table.

NOTE: This script is currently DISABLED pending Convex endpoint implementation.
"""

import asyncio
import sys
from pathlib import Path

# Add backend directory to path (go up 3 levels from scripts dir)
backend_dir = Path(__file__).parent.parent.parent
sys.path.insert(0, str(backend_dir))

from core.services.convex_client import get_convex_client
from core.utils.logger import logger
from decimal import Decimal

# CONVEX ENDPOINTS REQUIRED (not yet implemented):
# ================================
# 1. List credit purchases:
#    convex.rpc("billing:listCreditPurchases", {})
#    Returns: [{ purchaseId, userId, amountDollars, status, createdAt, ... }]
#
# 2. Get purchases by status:
#    convex.rpc("billing:listCreditPurchases", {"status": "completed"})
#    Returns: [{ purchaseId, ... }]
#
# NOTE: When endpoints are implemented, use:
#   from core.services.convex_client import get_convex_client
#   convex = get_convex_client()
#   result = await convex.rpc("endpoint:name", params)

async def check_purchases():
    """
    Check the credit_purchases table contents.

    Requires Convex endpoint:
    - billing:listCreditPurchases
    """
    print("="*60)
    print("THIS SCRIPT IS DISABLED")
    print("="*60)
    print("This script requires Convex endpoints that are not yet implemented.")
    print("Required endpoints:")
    print("  - convex.rpc('billing:listCreditPurchases', {})")
    print("="*60)

    # TODO: Implement when Convex billing endpoints are available
    # convex = get_convex_client()
    #
    # # Get all credit purchases
    # purchases = await convex.rpc("billing:listCreditPurchases", {})
    #
    # if not purchases:
    #     print("No entries found in credit_purchases")
    #     return
    #
    # print(f"Found {len(purchases)} entries in credit_purchases")
    #
    # # Show all entries
    # for i, purchase in enumerate(purchases, 1):
        #     print(f"\nEntry {i}:")
        #     print(f"  userId: {purchase.get('userId', 'N/A')}")
        #     print(f"  amountDollars: {purchase.get('amountDollars', 'N/A')}")
        #     print(f"  status: {purchase.get('status', 'N/A')}")
        #     print(f"  createdAt: {purchase.get('createdAt', 'N/A')}")
        #     print(f"  completedAt: {purchase.get('completedAt', 'N/A')}")
        #     print(f"  stripePaymentIntentId: {purchase.get('stripePaymentIntentId', 'N/A')}")
    #
    # # Group by status
    # status_counts = {}
    # for purchase in purchases:
        #     status = purchase.get('status', 'unknown')
        #     status_counts[status] = status_counts.get(status, 0) + 1
    #
    # print("\n" + "="*60)
    # print("STATUS SUMMARY:")
    # print("="*60)
    # for status, count in status_counts.items():
        #     print(f"  {status}: {count} entries")
    #
    # # Show completed purchases if any
    # completed = [p for p in purchases if p.get('status') == 'completed']
    # if completed:
        #     print(f"\n{len(completed)} COMPLETED purchases found")
        #     for purchase in completed:
        #         print(f"  User {purchase['userId'][:8]}...: ${purchase.get('amountDollars', 0)}")
        # else:
        #     print("\nNO purchases with status='completed' found")
    return

if __name__ == "__main__":
    asyncio.run(check_purchases())


async def check_purchases():
    """
    Check the credit_purchases table contents.

    Requires Convex endpoint:
    - billing:listCreditPurchases
    """
    print("="*60)
    print("THIS SCRIPT IS DISABLED")
    print("="*60)
    print("This script requires Convex endpoints that are not yet implemented.")
    print("Required endpoints:")
    print("  - convex.rpc('billing:listCreditPurchases', {})")
    print("="*60)

    # TODO: Implement when Convex billing endpoints are available
    # convex = get_convex_client()
    #
    # # Get all credit purchases
    # purchases = await convex.rpc("billing:listCreditPurchases", {})
    #
    # if not purchases:
    #     print("No entries found in credit_purchases")
    #     return
    #
    # print(f"Found {len(purchases)} entries in credit_purchases")
    #
    # # Show all entries
    # for i, purchase in enumerate(purchases, 1):
    #     print(f"\nEntry {i}:")
    #     print(f"  userId: {purchase.get('userId', 'N/A')}")
    #     print(f"  amountDollars: {purchase.get('amountDollars', 'N/A')}")
    #     print(f"  status: {purchase.get('status', 'N/A')}")
    #     print(f"  createdAt: {purchase.get('createdAt', 'N/A')}")
    #     print(f"  completedAt: {purchase.get('completedAt', 'N/A')}")
    #     print(f"  stripePaymentIntentId: {purchase.get('stripePaymentIntentId', 'N/A')}")
    #
    # # Group by status
    # status_counts = {}
    # for purchase in purchases:
    #     status = purchase.get('status', 'unknown')
    #     status_counts[status] = status_counts.get(status, 0) + 1
    #
    # print("\n" + "="*60)
    # print("STATUS SUMMARY:")
    # print("="*60)
    # for status, count in status_counts.items():
    #     print(f"  {status}: {count} entries")
    #
    # # Show completed purchases if any
    # completed = [p for p in purchases if p.get('status') == 'completed']
    # if completed:
    #     print(f"\n{len(completed)} COMPLETED purchases found")
    #     for purchase in completed:
    #         print(f"  User {purchase['userId'][:8]}...: ${purchase.get('amountDollars', 0)}")
    # else:
    #     print("\nNO purchases with status='completed' found")
    return

if __name__ == "__main__":
    asyncio.run(check_purchases())