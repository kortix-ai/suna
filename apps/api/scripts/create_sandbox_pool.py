#!/usr/bin/env python3
"""
Script to manually create sandboxes for the pool.
Usage: python scripts/create_sandbox_pool.py <count> [--batch-size=5] [--delay=10]

Example:
    python scripts/create_sandbox_pool.py 20 --batch-size=3 --delay=15
"""
import asyncio
import argparse
import sys
import os

# Add backend to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from core.utils.logger import logger
from core.sandbox.pool_service import SandboxPoolService
from core.services.db import init_db, close_db


async def create_sandboxes(count: int, batch_size: int, delay_seconds: int):
    """Create sandboxes in batches with delays to avoid rate limits."""
    
    logger.info(f"Starting sandbox pool creation: {count} sandboxes, batch_size={batch_size}, delay={delay_seconds}s")
    
    # Initialize database
    await init_db()
    
    service = SandboxPoolService()
    created_total = 0
    failed_total = 0
    
    try:
        batches = (count + batch_size - 1) // batch_size  # ceiling division
        
        for batch_num in range(batches):
            batch_start = batch_num * batch_size
            batch_end = min(batch_start + batch_size, count)
            current_batch_size = batch_end - batch_start
            
            logger.info(f"[Batch {batch_num + 1}/{batches}] Creating {current_batch_size} sandboxes...")
            
            # Create sandboxes in parallel within batch
            tasks = [service.create_pooled_sandbox() for _ in range(current_batch_size)]
            results = await asyncio.gather(*tasks, return_exceptions=True)
            
            batch_created = 0
            batch_failed = 0
            for result in results:
                if isinstance(result, Exception):
                    logger.error(f"Failed to create sandbox: {result}")
                    batch_failed += 1
                elif result is None:
                    batch_failed += 1
                else:
                    batch_created += 1
            
            created_total += batch_created
            failed_total += batch_failed
            
            logger.info(f"[Batch {batch_num + 1}/{batches}] Created {batch_created}/{current_batch_size} sandboxes (total: {created_total}/{count})")
            
            # Delay between batches (except after last batch)
            if batch_num < batches - 1:
                logger.info(f"Waiting {delay_seconds}s before next batch...")
                await asyncio.sleep(delay_seconds)
        
        logger.info(f"✅ Sandbox pool creation complete: {created_total} created, {failed_total} failed")
        
    finally:
        await close_db()
    
    return created_total, failed_total


def main():
    parser = argparse.ArgumentParser(description="Create sandboxes for the pool")
    parser.add_argument("count", type=int, help="Number of sandboxes to create")
    parser.add_argument("--batch-size", type=int, default=5, help="Sandboxes per batch (default: 5)")
    parser.add_argument("--delay", type=int, default=10, help="Seconds between batches (default: 10)")
    
    args = parser.parse_args()
    
    if args.count <= 0:
        print("Error: count must be positive")
        sys.exit(1)
    
    if args.batch_size <= 0:
        print("Error: batch-size must be positive")
        sys.exit(1)
    
    created, failed = asyncio.run(create_sandboxes(args.count, args.batch_size, args.delay))
    
    sys.exit(0 if failed == 0 else 1)


if __name__ == "__main__":
    main()
