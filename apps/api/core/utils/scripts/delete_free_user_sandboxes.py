#!/usr/bin/env python3
"""
Script to delete sandboxes for free tier users based on sandbox IDs.

NOTE: This script is currently DISABLED pending Convex endpoint implementation.

For each SANDBOX_ID provided:
1. Finds matching project by checking JSONB data in projects table
2. Gets account_id from the matching project row
3. Checks user's Stripe subscription status via billing system
4. If user is on free tier, deletes the sandbox via Daytona API

Usage:
    python delete_free_user_sandboxes.py [--dry-run] [--sandbox-ids ID1,ID2,ID3] [--use-json file.json]
"""

import dotenv
import os
dotenv.load_dotenv(".env")

import sys
import argparse
import json
import re
from datetime import datetime
from typing import List, Optional, Dict, Set
from core.utils.config import config
from core.utils.logger import logger
from core.services.convex_client import get_convex_client

# CONVEX ENDPOINTS REQUIRED (not yet implemented):
# ================================
# 1. Project lookup by sandbox_resource_id:
#    convex.rpc("projects:bySandbox", {"sandboxId": sandbox_id})
#    Returns: { projectId, accountId, ... }
#
# 2. Resources table operations:
#    convex.rpc("resources:getByExternalId", {"externalId": external_id})
#    Returns: { resourceId, type, status, ... }
#
# 3. Subscription service integration:
#    convex.rpc("billing:getSubscription", {"accountId": account_id})
#    Returns: { tier, status, stripeSubscriptionId, ... }
#
# 4. For subscription_service, see: core/billing/subscriptions/services/
#    These need to be updated to use Convex instead of Supabase
#
# NOTE: When endpoints are implemented, use:
#   from core.services.convex_client import get_convex_client
#   convex = get_convex_client()
#   result = await convex.rpc("endpoint:name", params)

try:
    from daytona import Daytona
except ImportError:
    print("Error: Daytona Python SDK not found. Please install it with: pip install daytona")
    sys.exit(1)


def parse_sandbox_string(sandbox_str: str) -> Optional[str]:
    """Parse sandbox string representation to extract ID."""
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


async def find_project_by_sandbox_id(convex, sandbox_id: str) -> Optional[Dict]:
    """
    Find project by sandbox resource ID.

    Requires Convex endpoint: projects:bySandbox
    """
    # TODO: Implement when Convex endpoint is available
    # return await convex.rpc("projects:bySandbox", {"sandboxId": sandbox_id})
    print(f"DISABLED: find_project_by_sandbox_id() needs Convex endpoint")
    print(f"   Required: convex.rpc('projects:bySandbox', {{'sandboxId': '{sandbox_id}'}})")
    return None


async def is_user_free_tier(account_id: str) -> tuple:
    """
    Check if user is on free tier by querying subscription status.

    Requires Convex endpoint: billing:getSubscription
    """
    # TODO: Implement when Convex billing endpoints are available
    # convex = get_convex_client()
    # subscription = await convex.rpc("billing:getSubscription", {"accountId": account_id})
    # tier = subscription.get("tier", "none")
    # return tier == "none" or tier == "free", tier
    print(f"DISABLED: is_user_free_tier() needs Convex endpoint")
    print(f"   Required: convex.rpc('billing:getSubscription', {{'accountId': '{account_id}'}})")
    return False, "disabled"


async def delete_sandbox_if_free_user(
    daytona_client,
    convex,
    sandbox_id: str,
    dry_run: bool = False
) -> tuple:
    """
    Delete sandbox if the owning user is on free tier.

    Requires Convex endpoints:
    - projects:bySandbox
    - billing:getSubscription
    """
    # TODO: Implement when Convex billing endpoints are available
    # 1. Find project by sandbox_id
    # project = await find_project_by_sandbox_id(convex, sandbox_id)
    # if not project:
    #     return False, "project_not_found"
    #
    # 2. Check subscription tier
    # is_free, tier = await is_user_free_tier(project["accountId"])
    # if not is_free:
    #     return False, f"paid_user_{tier}"
    #
    # 3. Delete sandbox via Daytona API
    # if not dry_run:
    #     await daytona_client.delete(sandbox_id)
    #     return True, "deleted"
    # return True, "would_delete"
    return False, "disabled - needs Convex endpoints"


async def delete_free_user_sandboxes(
    sandbox_ids: List[str],
    dry_run: bool = False
) -> Dict[str, int]:
    """
    Main function to delete sandboxes for free tier users.
    """
    print("\n" + "="*60)
    print("⚠️  THIS SCRIPT IS DISABLED")
    print("="*60)
    print("This script requires Convex endpoints that are not yet implemented.")
    print("Required endpoints:")
    print("  - projects table with sandbox_resource_id lookup")
    print("  - resources table operations")
    print("  - subscription_service integration")
    print("="*60)
    
    return {
        "total_processed": 0,
        "deleted": 0,
        "skipped_paid_user": 0,
        "skipped_project_not_found": 0,
        "errors": 0,
        "disabled": 1
    }


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
    parser.add_argument('--use-json', type=str, help='JSON file containing sandbox data')
    parser.add_argument('--limit', type=int, help='Limit the number of sandboxes to process')
    parser.add_argument('--force', action='store_true', help='Required for processing more than 50 sandboxes without dry-run')
    
    args = parser.parse_args()
    
    print("="*60)
    print("⚠️  THIS SCRIPT IS DISABLED")
    print("="*60)
    print("Required Convex endpoints not yet implemented.")
    print("="*60)
    
    # Get sandbox IDs for reference
    sandbox_ids = []
    if args.sandbox_ids:
        sandbox_ids = [sid.strip() for sid in args.sandbox_ids.split(',') if sid.strip()]
    elif args.use_json:
        sandbox_ids = get_sandbox_ids_from_json(args.use_json)
    
    if sandbox_ids:
        print(f"\nFound {len(sandbox_ids)} sandbox IDs in input.")
        print("These would be processed once Convex endpoints are available.")


if __name__ == "__main__":
    main()
