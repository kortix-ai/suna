#!/usr/bin/env python3
"""
Simple script to archive all Daytona sandboxes with "STOPPED" state.

Usage:
    python archive_stopped_sandboxes.py [--dry-run]
"""

import sys
import argparse
import json
import re
from datetime import datetime
from core.utils.config import config

try:
    from daytona import Daytona
except ImportError:
    print("Error: Daytona Python SDK not found. Please install it with: pip install daytona")
    sys.exit(1)

def save_raw_list_as_json(raw_list, filename=None):
    """Save raw list output as JSON file."""
    if filename is None:
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"raw_sandboxes_{timestamp}.json"
    
    print(f"Saving raw list output to {filename}")
    
    try:
        with open(filename, 'w') as f:
            json.dump(raw_list, f, indent=2, default=str)
        print(f"✓ Successfully saved raw list to {filename}")
        return filename
    except Exception as e:
        print(f"✗ Failed to save JSON file: {e}")
        return None

def parse_sandbox_string(sandbox_str):
    """Parse sandbox string representation to extract ID and state."""
    # Extract ID using regex
    id_match = re.search(r"id='([^']+)'", sandbox_str)
    sandbox_id = id_match.group(1) if id_match else None
    
    # Extract state using regex
    state_match = re.search(r"state=<SandboxState\.([^:]+):", sandbox_str)
    state = state_match.group(1) if state_match else None
    
    return sandbox_id, state

def get_stopped_sandboxes_from_json(json_file):
    """Extract STOPPED sandbox IDs from JSON file."""
    try:
        with open(json_file, 'r') as f:
            sandboxes_data = json.load(f)
        
        stopped_ids = []
        
        for sandbox_str in sandboxes_data:
            sandbox_id, state = parse_sandbox_string(sandbox_str)
            if state == 'STOPPED' and sandbox_id:
                stopped_ids.append(sandbox_id)
        
        return stopped_ids
        
    except Exception as e:
        print(f"✗ Failed to parse JSON file: {e}")
        return []

def archive_stopped_sandboxes(dry_run=False, save_json=False, json_filename=None, use_existing_json=None):
    """Archive all sandboxes in STOPPED state."""
    
    # Initialize Daytona client using config
    try:
        daytona = Daytona()
        print("✓ Connected to Daytona")
    except Exception as e:
        print(f"✗ Failed to connect to Daytona: {e}")
        return False
    
    stopped_sandbox_ids = []
    
    if use_existing_json:
        # Parse existing JSON file for STOPPED sandboxes
        print(f"🔍 Parsing existing JSON file: {use_existing_json}")
        stopped_sandbox_ids = get_stopped_sandboxes_from_json(use_existing_json)
        print(f"✓ Found {len(stopped_sandbox_ids)} STOPPED sandboxes in JSON file")
        
        # Log some sample IDs for verification
        if stopped_sandbox_ids:
            print(f"📋 Sample STOPPED sandbox IDs: {stopped_sandbox_ids[:5]}...")
    else:
        # Get all sandboxes from API
        try:
            sandboxes = daytona.list()
            print(f"✓ Found {len(sandboxes)} total sandboxes")
            
            # Print sandbox data for debugging
            print("\nSandbox data structure:")
            for i, sandbox in enumerate(sandboxes[:2]):  # Show first 2 for debugging
                print(f"Sandbox {i+1}: {sandbox}")
                print(f"  - ID: {getattr(sandbox, 'id', 'N/A')}")
                print(f"  - State: {getattr(sandbox, 'state', 'N/A')}")
                print(f"  - Name: {getattr(sandbox, 'name', 'N/A')}")
                
        except Exception as e:
            print(f"✗ Failed to list sandboxes: {e}")
            return False
        
        # Save raw list as JSON if requested
        if save_json:
            save_raw_list_as_json(sandboxes, json_filename)
        
        # Filter for STOPPED sandboxes
        stopped_sandboxes = [sb for sb in sandboxes if getattr(sb, 'state', None) == 'STOPPED']
        stopped_sandbox_ids = [getattr(sb, 'id', 'unknown') for sb in stopped_sandboxes]
        print(f"✓ Found {len(stopped_sandbox_ids)} sandboxes in STOPPED state")
    
    if not stopped_sandbox_ids:
        print("No sandboxes to archive")
        return True
    
    # Archive each stopped sandbox
    success_count = 0
    for sandbox_id in stopped_sandbox_ids:
        try:
            if dry_run:
                print(f"[DRY RUN] Would archive: {sandbox_id}")
                success_count += 1
            else:
                print(f"Archiving: {sandbox_id}")
                # Get the sandbox object and archive it
                sandbox = daytona.get(sandbox_id)
                sandbox.archive()
                print(f"✓ Archived: {sandbox_id}")
                success_count += 1
                
        except Exception as e:
            print(f"✗ Failed to archive {sandbox_id}: {e}")
    
    print(f"\nSummary: {success_count}/{len(stopped_sandbox_ids)} sandboxes processed")
    return success_count == len(stopped_sandbox_ids)

def main():
    parser = argparse.ArgumentParser(description="Archive stopped Daytona sandboxes and optionally save list as JSON")
    parser.add_argument('--dry-run', action='store_true', help='Show what would be archived')
    parser.add_argument('--save-json', action='store_true', help='Save sandboxes list as JSON file')
    parser.add_argument('--json-file', type=str, help='Custom filename for JSON output (default: sandboxes_TIMESTAMP.json)')
    parser.add_argument('--use-json', type=str, help='Use existing JSON file to get STOPPED sandbox IDs (e.g., raw_sandboxes_20250817_194448.json)')
    parser.add_argument('--json-only', action='store_true', help='Only save JSON, skip archiving')
    args = parser.parse_args()
    
    print("Daytona API Key:", "✓ Configured" if config.DAYTONA_API_KEY else "✗ Missing")
    print("Daytona API URL:", config.DAYTONA_SERVER_URL)
    print("Daytona Target:", config.DAYTONA_TARGET)
    print()
    
    if args.dry_run:
        print("=== DRY RUN MODE ===")
    
    if args.json_only:
        print("=== JSON ONLY MODE ===")
        # Just save JSON without archiving
        try:
            from daytona import Daytona
            daytona = Daytona()
            sandboxes = daytona.list()
            print(f"RAW SANDBOXES DATA: {sandboxes}")
            save_raw_list_as_json(sandboxes, args.json_file)
            sys.exit(0)
        except Exception as e:
            print(f"✗ Failed to save JSON: {e}")
            sys.exit(1)
    
    success = archive_stopped_sandboxes(
        dry_run=args.dry_run,
        save_json=args.save_json,
        json_filename=args.json_file,
        use_existing_json=args.use_json
    )
    sys.exit(0 if success else 1)

if __name__ == "__main__":
    main()


#uv run python -m utils.scripts.archive_stopped_sandboxes --use-json raw_sandboxes_20250817_194448.json