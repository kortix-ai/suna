#!/usr/bin/env python3
"""
Simple script to check what's in the credit_purchases table.
"""

import asyncio
import sys
from pathlib import Path

# Add backend directory to path (go up 3 levels from scripts dir)
backend_dir = Path(__file__).parent.parent.parent
sys.path.insert(0, str(backend_dir))

from core.services.supabase import DBConnection
from core.utils.logger import logger
from decimal import Decimal

async def check_purchases():
    db = DBConnection()
    await db.initialize()
    client = await db.client
    
    logger.info("="*60)
    logger.info("CHECKING CREDIT_PURCHASES TABLE")
    logger.info("="*60)
    
    # Get ALL entries without any filter
    result = await client.from_('credit_purchases').select('*').execute()
    
    if not result.data:
        logger.info("No entries found in credit_purchases table")
        return
    
    logger.info(f"Found {len(result.data)} entries in credit_purchases")
    
    # Show all entries
    for i, purchase in enumerate(result.data, 1):
        logger.info(f"\nEntry {i}:")
        logger.info(f"  user_id: {purchase.get('user_id', 'N/A')}")
        logger.info(f"  amount_dollars: {purchase.get('amount_dollars', 'N/A')}")
        logger.info(f"  status: {purchase.get('status', 'N/A')}")
        logger.info(f"  created_at: {purchase.get('created_at', 'N/A')}")
        logger.info(f"  completed_at: {purchase.get('completed_at', 'N/A')}")
        logger.info(f"  stripe_payment_intent_id: {purchase.get('stripe_payment_intent_id', 'N/A')}")
        
    # Group by status
    status_counts = {}
    for purchase in result.data:
        status = purchase.get('status', 'unknown')
        status_counts[status] = status_counts.get(status, 0) + 1
    
    logger.info("\n" + "="*60)
    logger.info("STATUS SUMMARY:")
    logger.info("="*60)
    for status, count in status_counts.items():
        logger.info(f"  {status}: {count} entries")
    
    # Show completed purchases if any
    completed = [p for p in result.data if p.get('status') == 'completed']
    if completed:
        logger.info(f"\n{len(completed)} COMPLETED purchases found")
        for purchase in completed:
            logger.info(f"  User {purchase['user_id'][:8]}...: ${purchase.get('amount_dollars', 0)}")
    else:
        logger.info("\nNO purchases with status='completed' found")
        logger.info("This is why fix_missing_topups.py isn't finding anything!")

if __name__ == "__main__":
    asyncio.run(check_purchases()) 