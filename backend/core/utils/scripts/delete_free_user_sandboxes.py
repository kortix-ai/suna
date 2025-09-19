#!/usr/bin/env python3
"""
Script to delete sandboxes for free tier users based on sandbox IDs.

For each SANDBOX_ID provided:
1. Finds matching project by checking JSONB data in projects table
2. Gets account_id from the matching project row
3. Checks user's Stripe subscription status via billing system
4. If user is on free tier, deletes the sandbox via Daytona API

Usage:
    python delete_free_user_sandboxes.py [--dry-run] [--sandbox-ids ID1,ID2,ID3] [--use-json file.json]
"""

PROD_SUPABASE_URL = "https://jbriwassebxdwoieikga.supabase.co"  # Your production Supabase URL
PROD_SUPABASE_KEY = ""  # Your production Supabase service role key  
PROD_STRIPE_SECRET_KEY = ""  # Your production Stripe secret key

import dotenv
import os
dotenv.load_dotenv(".env")

# Override with production credentials if provided
if PROD_SUPABASE_URL:
    os.environ['SUPABASE_URL'] = PROD_SUPABASE_URL
if PROD_SUPABASE_KEY:
    os.environ['SUPABASE_SERVICE_ROLE_KEY'] = PROD_SUPABASE_KEY  
if PROD_STRIPE_SECRET_KEY:
    os.environ['STRIPE_SECRET_KEY'] = PROD_STRIPE_SECRET_KEY

import sys
import argparse
import json
import re
from datetime import datetime
from typing import List, Optional, Dict, Set
from core.utils.config import config
from core.utils.logger import logger
from core.services.supabase import DBConnection
from core.services.billing import get_user_subscription, get_subscription_tier

try:
    from daytona import Daytona
except ImportError:
    print("Error: Daytona Python SDK not found. Please install it with: pip install daytona")
    sys.exit(1)

def parse_sandbox_string(sandbox_str: str) -> Optional[str]:
    """Parse sandbox string representation to extract ID."""
    # Extract ID using regex
    id_match = re.search(r"id='([^']+)'", sandbox_str)
    return id_match.group(1) if id_match else None

def get_sandbox_ids_from_json(json_file: str) -> List[str]:
    """Extract all sandbox IDs from JSON file."""
    try:
        with open(json_file, 'r') as f:
            sandboxes_data = json.load(f)
        
        sandbox_ids = []
        for sandbox_str in sandboxes_data:
            sandbox_id = parse_sandbox_string(sandbox_str)
            if sandbox_id:
                sandbox_ids.append(sandbox_id)
        
        return sandbox_ids
        
    except Exception as e:
        logger.error(f"Failed to parse JSON file: {e}")
        return []

async def find_project_by_sandbox_id(client, sandbox_id: str) -> Optional[Dict]:
    """
    Find project that contains the given sandbox_id in its JSONB data.
    
    Args:
        client: Supabase client
        sandbox_id: The sandbox ID to search for
        
    Returns:
        Project row dict if found, None otherwise
    """
    try:
        # Query projects table for JSONB data containing the sandbox ID
        # The JSONB structure is like: {"id": "sandbox_id", "pass": "...", ...}
        result = await client.table('projects') \
            .select('project_id, account_id, sandbox') \
            .eq('sandbox->>id', sandbox_id) \
            .execute()
        
        if result.data and len(result.data) > 0:
            project = result.data[0]
            logger.debug(f"Found project {project['project_id']} for sandbox {sandbox_id}")
            return project
        
        return None
        
    except Exception as e:
        logger.error(f"Error searching for project with sandbox {sandbox_id}: {e}")
        return None

async def is_user_free_tier(user_id: str) -> tuple[bool, str]:
    """
    Check if user is on free tier.
    
    Args:
        user_id: The user ID to check
        
    Returns:
        Tuple of (is_free_tier, subscription_info)
    """
    try:
        # Get user's subscription
        subscription = await get_user_subscription(user_id)
        
        if not subscription:
            # No subscription = free tier
            return True, "no_subscription"
        
        # Extract price ID from subscription
        price_id = None
        if subscription.get('items') and subscription['items'].get('data') and len(subscription['items']['data']) > 0:
            price_id = subscription['items']['data'][0]['price']['id']
        else:
            price_id = subscription.get('price_id', config.STRIPE_FREE_TIER_ID)
        
        # Check if price ID matches free tier
        is_free = price_id == config.STRIPE_FREE_TIER_ID
        subscription_info = f"price_id={price_id}, free_tier_id={config.STRIPE_FREE_TIER_ID}"
        
        return is_free, subscription_info
        
    except Exception as e:
        logger.error(f"Error checking subscription for user {user_id}: {e}")
        # Default to false (don't delete) if we can't determine subscription
        return False, f"error: {str(e)}"

async def delete_sandbox_if_free_user(
    daytona_client, 
    supabase_client, 
    sandbox_id: str, 
    dry_run: bool = False
) -> tuple[bool, str]:
    """
    Delete sandbox if the associated user is on free tier.
    
    Args:
        daytona_client: Daytona API client
        supabase_client: Supabase database client
        sandbox_id: The sandbox ID to potentially delete
        dry_run: If True, only simulate the action
        
    Returns:
        Tuple of (action_taken, reason)
    """
    try:
        # Find project associated with this sandbox
        project = await find_project_by_sandbox_id(supabase_client, sandbox_id)
        if not project:
            return False, "project_not_found"
        
        account_id = project['account_id']
        project_id = project['project_id']
        
        # Check if user is on free tier
        is_free, subscription_info = await is_user_free_tier(account_id)
        
        if not is_free:
            return False, f"paid_user ({subscription_info})"
        
        # User is on free tier - delete sandbox
        if dry_run:
            return True, f"would_delete (project: {project_id}, user: {account_id}, {subscription_info})"
        else:
            # Actually delete the sandbox
            try:
                sandbox = daytona_client.get(sandbox_id)
                sandbox.delete()
                logger.info(f"Successfully deleted sandbox {sandbox_id} for free user {account_id}")
                return True, f"deleted (project: {project_id}, user: {account_id}, {subscription_info})"
            except Exception as delete_error:
                logger.error(f"Failed to delete sandbox {sandbox_id}: {delete_error}")
                return False, f"delete_failed: {str(delete_error)}"
    
    except Exception as e:
        logger.error(f"Error processing sandbox {sandbox_id}: {e}")
        return False, f"error: {str(e)}"

async def delete_free_user_sandboxes(
    sandbox_ids: List[str],
    dry_run: bool = False
) -> Dict[str, int]:
    """
    Main function to delete sandboxes for free tier users.
    
    Args:
        sandbox_ids: List of sandbox IDs to process
        dry_run: If True, only simulate actions
        
    Returns:
        Dictionary with statistics
    """
    # Initialize clients
    try:
        daytona = Daytona()
        logger.info("✓ Connected to Daytona")
    except Exception as e:
        logger.error(f"✗ Failed to connect to Daytona: {e}")
        return {"error": 1}
    
    try:
        db = DBConnection()
        await db.initialize()
        supabase_client = await db.client
        logger.info("✓ Connected to Supabase")
    except Exception as e:
        logger.error(f"✗ Failed to connect to Supabase: {e}")
        return {"error": 1}
    
    # Track statistics
    stats = {
        "total_processed": 0,
        "deleted": 0,
        "skipped_paid_user": 0,
        "skipped_project_not_found": 0,
        "errors": 0
    }
    
    logger.info(f"Processing {len(sandbox_ids)} sandbox IDs...")
    
    # Process each sandbox ID
    for i, sandbox_id in enumerate(sandbox_ids):
        stats["total_processed"] += 1
        
        logger.info(f"[{i+1}/{len(sandbox_ids)}] Processing sandbox: {sandbox_id}")
        
        action_taken, reason = await delete_sandbox_if_free_user(
            daytona, supabase_client, sandbox_id, dry_run
        )
        
        if action_taken:
            stats["deleted"] += 1
            status = "WOULD DELETE" if dry_run else "DELETED"
            logger.info(f"  ✓ {status}: {reason}")
        elif "paid_user" in reason:
            stats["skipped_paid_user"] += 1
            logger.info(f"  → SKIPPED (paid user): {reason}")
        elif "project_not_found" in reason:
            stats["skipped_project_not_found"] += 1
            logger.info(f"  → SKIPPED (no project): {reason}")
        else:
            stats["errors"] += 1
            logger.warning(f"  ✗ ERROR: {reason}")
    
    # Cleanup database connection
    try:
        await db.disconnect()
        logger.debug("✓ Database connection closed")
    except Exception as e:
        logger.warning(f"Error closing database connection: {e}")
    
    return stats

def main():
    parser = argparse.ArgumentParser(
        description="Delete sandboxes for free tier users",
        epilog="""
Examples:
  # Dry run with specific sandbox IDs
  python delete_free_user_sandboxes.py --dry-run --sandbox-ids "id1,id2,id3"
  
  # Process sandboxes from JSON file (limited to 10 for testing)
  python delete_free_user_sandboxes.py --dry-run --use-json raw_sandboxes_20250817_194448.json --limit 10
  
  # Actually delete sandboxes (remove --dry-run when ready)
  python delete_free_user_sandboxes.py --use-json raw_sandboxes_20250817_194448.json --limit 100
        """,
        formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument('--dry-run', action='store_true', help='Show what would be deleted without actually deleting')
    parser.add_argument('--sandbox-ids', type=str, help='Comma-separated list of sandbox IDs to process')
    parser.add_argument('--use-json', type=str, help='JSON file containing sandbox data (e.g., raw_sandboxes_20250817_194448.json)')
    parser.add_argument('--limit', type=int, help='Limit the number of sandboxes to process (for testing)')
    parser.add_argument('--force', action='store_true', help='Required for processing more than 50 sandboxes without dry-run')
    
    args = parser.parse_args()
    
    # Verify configuration
    logger.info("Configuration check:")
    logger.info(f"  Daytona API Key: {'✓ Configured' if config.DAYTONA_API_KEY else '✗ Missing'}")
    logger.info(f"  Daytona API URL: {config.DAYTONA_SERVER_URL}")
    logger.info(f"  Daytona Target: {config.DAYTONA_TARGET}")
    logger.info(f"  Supabase URL: {'✓ Configured' if config.SUPABASE_URL else '✗ Missing'}")
    logger.info(f"  Stripe Free Tier ID: {config.STRIPE_FREE_TIER_ID}")
    logger.info("")
    
    if args.dry_run:
        logger.info("=== DRY RUN MODE ===")
        logger.info("No actual deletions will be performed")
        logger.info("")
    
    # Get sandbox IDs to process
    sandbox_ids = []
    
    if args.sandbox_ids:
        sandbox_ids = [sid.strip() for sid in args.sandbox_ids.split(',') if sid.strip()]
        logger.info(f"Using {len(sandbox_ids)} sandbox IDs from command line")
    elif args.use_json:
        sandbox_ids = get_sandbox_ids_from_json(args.use_json)
        logger.info(f"Extracted {len(sandbox_ids)} sandbox IDs from {args.use_json}")
    else:
        logger.error("Error: Must specify either --sandbox-ids or --use-json")
        parser.print_help()
        sys.exit(1)
    
    if not sandbox_ids:
        logger.error("No sandbox IDs to process")
        sys.exit(1)
    
    # Apply limit if specified
    if args.limit and args.limit > 0:
        original_count = len(sandbox_ids)
        sandbox_ids = sandbox_ids[:args.limit]
        logger.info(f"Limited processing to {len(sandbox_ids)} sandboxes (from {original_count})")
    
    # Safety check - prevent accidental mass deletion
    if not args.dry_run and len(sandbox_ids) > 50 and not args.force:
        logger.error(f"Safety check: Attempting to delete {len(sandbox_ids)} sandboxes without --dry-run")
        logger.error("This operation would delete many sandboxes. Please:")
        logger.error("1. First run with --dry-run to see what would be deleted")
        logger.error("2. Use --limit to process a smaller batch")
        logger.error("3. Use --force flag if you really want to delete more than 50 sandboxes")
        sys.exit(1)
    
    # Log some sample IDs
    logger.info(f"Sample sandbox IDs: {sandbox_ids[:5]}...")
    logger.info("")
    
    # Run the deletion process
    import asyncio
    
    async def run():
        stats = await delete_free_user_sandboxes(sandbox_ids, dry_run=args.dry_run)
        
        # Print summary
        logger.info("")
        logger.info("=== SUMMARY ===")
        logger.info(f"Total processed: {stats.get('total_processed', 0)}")
        logger.info(f"Deleted: {stats.get('deleted', 0)}")
        logger.info(f"Skipped (paid users): {stats.get('skipped_paid_user', 0)}")
        logger.info(f"Skipped (no project): {stats.get('skipped_project_not_found', 0)}")
        logger.info(f"Errors: {stats.get('errors', 0)}")
        
        success = stats.get('errors', 0) == 0
        return success
    
    try:
        success = asyncio.run(run())
        sys.exit(0 if success else 1)
    except Exception as e:
        logger.error(f"Script failed: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()


# Usage examples:
# 
# 1. Dry run with specific sandbox IDs:
# uv run python -m utils.scripts.delete_free_user_sandboxes --dry-run --sandbox-ids "id1,id2,id3"
#
# 2. Test with JSON file (limit to 10 sandboxes):
# uv run python -m utils.scripts.delete_free_user_sandboxes --dry-run --use-json raw_sandboxes_20250817_194448.json --limit 10
#
# 3. Actually delete free user sandboxes (remove --dry-run when ready):
# uv run python -m utils.scripts.delete_free_user_sandboxes --use-json raw_sandboxes_20250817_194448.json --limit 100 --force
