#!/usr/bin/env python3
"""
Script to stop, archive, and delete sandboxes from the sandbox pool.

Usage:
    uv run python scripts/archive_pool_sandboxes.py <count> [--dry-run] [--batch-size=5]

Example:
    uv run python scripts/archive_pool_sandboxes.py 100 --dry-run
    uv run python scripts/archive_pool_sandboxes.py 100
    uv run python scripts/archive_pool_sandboxes.py 100 --batch-size=3
"""
import asyncio
import argparse
import sys
import os

# Add backend to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from daytona_sdk import SandboxState
from core.utils.logger import logger
from core.sandbox.sandbox import daytona, delete_sandbox
from core.sandbox import pool_repo
from core.services.db import init_db, close_db


async def stop_archive_and_delete_sandbox(sandbox_id: str, dry_run: bool = False) -> bool:
    """Stop, archive, and delete a single sandbox from the pool."""
    try:
        if dry_run:
            logger.info(f"[DRY RUN] Would stop, archive, and delete sandbox: {sandbox_id}")
            return True
        
        # Get sandbox
        sandbox = await daytona.get(sandbox_id)
        logger.debug(f"Sandbox {sandbox_id} current state: {sandbox.state}")
        
        # If already archived, just delete it
        if sandbox.state == SandboxState.ARCHIVED:
            logger.info(f"Sandbox {sandbox_id} already archived, deleting...")
            await delete_sandbox(sandbox_id)
            logger.info(f"✓ Successfully deleted already-archived sandbox: {sandbox_id}")
            return True
        
        # If currently archiving, wait for it to finish
        if sandbox.state == SandboxState.ARCHIVING:
            logger.info(f"Sandbox {sandbox_id} is already archiving, waiting...")
            for i in range(60):
                await asyncio.sleep(2)
                sandbox = await daytona.get(sandbox_id)
                if sandbox.state == SandboxState.ARCHIVED:
                    logger.info(f"Sandbox {sandbox_id} archiving completed")
                    await delete_sandbox(sandbox_id)
                    logger.info(f"✓ Successfully deleted: {sandbox_id}")
                    return True
            logger.warning(f"Sandbox {sandbox_id} did not finish archiving within 120 seconds")
            return False
        
        # Stop sandbox if it's running
        if sandbox.state == SandboxState.STARTED:
            logger.info(f"Stopping sandbox: {sandbox_id}")
            await daytona.stop(sandbox)
            
            # Wait for sandbox to stop (increased timeout)
            for i in range(60):
                await asyncio.sleep(2)
                sandbox = await daytona.get(sandbox_id)
                if sandbox.state == SandboxState.STOPPED:
                    logger.debug(f"Sandbox {sandbox_id} stopped successfully")
                    break
                elif sandbox.state == SandboxState.STOPPING:
                    logger.debug(f"Sandbox {sandbox_id} still stopping... ({i+1}/60)")
                    continue
            else:
                logger.error(f"Sandbox {sandbox_id} did not stop within 120 seconds, current state: {sandbox.state}")
                return False
        
        # Make sure we're in STOPPED state before archiving
        if sandbox.state != SandboxState.STOPPED:
            logger.error(f"Sandbox {sandbox_id} is not in STOPPED state: {sandbox.state}")
            return False
        
        # Archive the sandbox
        logger.info(f"Archiving sandbox: {sandbox_id}")
        await sandbox.archive()
        
        # Wait for archive to complete
        for i in range(60):
            await asyncio.sleep(2)
            sandbox = await daytona.get(sandbox_id)
            if sandbox.state == SandboxState.ARCHIVED:
                logger.debug(f"Sandbox {sandbox_id} archived successfully")
                break
            elif sandbox.state == SandboxState.ARCHIVING:
                logger.debug(f"Sandbox {sandbox_id} still archiving... ({i+1}/60)")
                continue
        else:
            logger.warning(f"Sandbox {sandbox_id} did not finish archiving within 120 seconds")
            # Continue anyway to try deletion
        
        # Delete the sandbox from Daytona
        logger.info(f"Deleting sandbox from Daytona: {sandbox_id}")
        await delete_sandbox(sandbox_id)
        
        logger.info(f"✓ Successfully stopped, archived, and deleted: {sandbox_id}")
        return True
        
    except Exception as e:
        logger.error(f"✗ Failed to stop/archive/delete {sandbox_id}: {e}")
        return False


async def archive_pool_sandboxes(count: int, batch_size: int, dry_run: bool = False):
    """Archive and delete pooled sandboxes in batches."""
    
    logger.info(f"Starting pool sandbox archival and deletion: {count} sandboxes, batch_size={batch_size}, dry_run={dry_run}")
    
    # Initialize database
    await init_db()
    
    total_processed = 0
    total_success = 0
    total_failed = 0
    
    try:
        # First, check what sandboxes exist
        check_sql = """
        SELECT status, COUNT(*) as count
        FROM resources
        WHERE type = 'sandbox'
        GROUP BY status
        """
        from core.services.db import execute
        status_counts = await execute(check_sql, {})
        logger.info(f"Sandbox status breakdown: {status_counts}")
        
        # Get pooled sandboxes from database
        pooled = await pool_repo.get_pooled_sandboxes(limit=count)
        
        if not pooled:
            logger.warning("No pooled sandboxes found in database")
            logger.warning("Run the query above to see what statuses your sandboxes have")
            return total_success, total_failed
        
        actual_count = min(count, len(pooled))
        logger.info(f"Found {len(pooled)} pooled sandboxes, will process {actual_count}")
        
        # Process in batches
        batches = (actual_count + batch_size - 1) // batch_size
        
        for batch_num in range(batches):
            batch_start = batch_num * batch_size
            batch_end = min(batch_start + batch_size, actual_count)
            batch_items = pooled[batch_start:batch_end]
            
            logger.info(f"[Batch {batch_num + 1}/{batches}] Processing {len(batch_items)} sandboxes...")
            
            # Process batch in parallel
            tasks = []
            for item in batch_items:
                sandbox_id = item['external_id']
                tasks.append(stop_archive_and_delete_sandbox(sandbox_id, dry_run))
            
            results = await asyncio.gather(*tasks, return_exceptions=True)
            
            # Count results
            batch_success = 0
            batch_failed = 0
            for i, result in enumerate(results):
                total_processed += 1
                if isinstance(result, Exception):
                    logger.error(f"Exception processing sandbox: {result}")
                    batch_failed += 1
                    total_failed += 1
                elif result:
                    batch_success += 1
                    total_success += 1
                    
                    # Mark as deleted in database if not dry run
                    if not dry_run:
                        resource_id = batch_items[i]['id']
                        await pool_repo.mark_sandbox_deleted(resource_id)
                else:
                    batch_failed += 1
                    total_failed += 1
            
            logger.info(
                f"[Batch {batch_num + 1}/{batches}] "
                f"Success: {batch_success}, Failed: {batch_failed} "
                f"(Total: {total_success}/{total_processed})"
            )
            
            # Delay between batches to avoid rate limiting and let operations complete
            if batch_num < batches - 1:
                logger.info(f"Waiting 5 seconds before next batch...")
                await asyncio.sleep(5)
        
        logger.info(
            f"✅ Pool sandbox archival and deletion complete: "
            f"{total_success} succeeded, {total_failed} failed out of {total_processed} total"
        )
        
    except Exception as e:
        logger.error(f"Fatal error during pool archival and deletion: {e}")
        raise
    finally:
        await close_db()
    
    return total_success, total_failed


def main():
    parser = argparse.ArgumentParser(description="Stop, archive, and delete sandboxes from the pool")
    parser.add_argument("count", type=int, help="Number of sandboxes to archive and delete")
    parser.add_argument("--batch-size", type=int, default=5, help="Sandboxes per batch (default: 5)")
    parser.add_argument("--dry-run", action="store_true", help="Show what would be done without actually doing it")
    
    args = parser.parse_args()
    
    if args.count <= 0:
        print("Error: count must be positive")
        sys.exit(1)
    
    if args.batch_size <= 0:
        print("Error: batch-size must be positive")
        sys.exit(1)
    
    if args.dry_run:
        print("=== DRY RUN MODE ===")
        print("No changes will be made to sandboxes or pool")
        print()
    
    print(f"This will stop, archive, and DELETE {args.count} sandboxes from the pool")
    print()
    
    success, failed = asyncio.run(archive_pool_sandboxes(args.count, args.batch_size, args.dry_run))
    
    sys.exit(0 if failed == 0 else 1)


if __name__ == "__main__":
    main()


# Example usage:
# uv run python scripts/archive_pool_sandboxes.py 100 --dry-run
# uv run python scripts/archive_pool_sandboxes.py 100
# uv run python scripts/archive_pool_sandboxes.py 100 --batch-size=3  # Smaller batches for better stability
