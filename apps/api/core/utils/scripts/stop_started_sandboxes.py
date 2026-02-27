#!/usr/bin/env python3
"""
Script to stop all Daytona sandboxes in "STARTED" state.

This script connects to Daytona API, lists all sandboxes, filters for those
in "STARTED" state, and stops them. Useful for cleanup operations or
resource management.

Usage:
    python stop_started_sandboxes.py [--dry-run] [--save-json] [--json-file filename]

Examples:
    # Dry run to see what would be stopped
    python stop_started_sandboxes.py --dry-run
    
    # Actually stop all started sandboxes
    python stop_started_sandboxes.py
    
    # Save list of sandboxes to JSON file before stopping
    python stop_started_sandboxes.py --save-json --json-file started_sandboxes.json
"""

PROD_DAYTONA_API_KEY = ""  # Your production Daytona API key

import dotenv
import os
dotenv.load_dotenv(".env")

# Override with production credentials if provided
if PROD_DAYTONA_API_KEY:
    os.environ['DAYTONA_API_KEY'] = PROD_DAYTONA_API_KEY

import sys
import argparse
import json
from datetime import datetime
from typing import List, Dict, Optional
from core.utils.config import config
from core.utils.logger import logger

try:
    from daytona import Daytona
except ImportError:
    print("Error: Daytona Python SDK not found. Please install it with: pip install daytona")
    sys.exit(1)

def save_sandboxes_as_json(sandboxes_list: List, filename: Optional[str] = None) -> Optional[str]:
    """Save sandboxes list as JSON file for debugging/auditing."""
    if filename is None:
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"started_sandboxes_{timestamp}.json"
    
    logger.info(f"Saving sandboxes list to {filename}")
    
    try:
        # Convert sandbox objects to serializable format
        serializable_data = []
        for sandbox in sandboxes_list:
            sandbox_data = {
                'id': getattr(sandbox, 'id', 'unknown'),
                'name': getattr(sandbox, 'name', 'unknown'),
                'state': getattr(sandbox, 'state', 'unknown'),
                'created_at': str(getattr(sandbox, 'created_at', 'unknown')),
                'updated_at': str(getattr(sandbox, 'updated_at', 'unknown')),
            }
            serializable_data.append(sandbox_data)
        
        with open(filename, 'w') as f:
            json.dump(serializable_data, f, indent=2, default=str)
        
        logger.info(f"✓ Successfully saved sandboxes list to {filename}")
        return filename
    except Exception as e:
        logger.error(f"✗ Failed to save JSON file: {e}")
        return None

def stop_started_sandboxes(dry_run: bool = False, save_json: bool = False, json_filename: Optional[str] = None) -> Dict[str, int]:
    """
    Stop all sandboxes in STARTED state.
    
    Args:
        dry_run: If True, only simulate the action without actually stopping
        save_json: If True, save the list of sandboxes to JSON file
        json_filename: Custom filename for JSON output
        
    Returns:
        Dictionary with statistics about the operation
    """
    # Initialize Daytona client
    try:
        daytona = Daytona()
        logger.info("✓ Connected to Daytona")
    except Exception as e:
        logger.error(f"✗ Failed to connect to Daytona: {e}")
        return {"error": 1}
    
    # Get all sandboxes
    try:
        all_sandboxes = daytona.list()
        logger.info(f"✓ Found {len(all_sandboxes)} total sandboxes")
        
        # Print sample sandbox data for debugging
        if all_sandboxes:
            logger.info("Sample sandbox data structure:")
            sample_sandbox = all_sandboxes[0]
            logger.info(f"  - ID: {getattr(sample_sandbox, 'id', 'N/A')}")
            logger.info(f"  - State: {getattr(sample_sandbox, 'state', 'N/A')}")
            logger.info(f"  - Name: {getattr(sample_sandbox, 'name', 'N/A')}")
            
            # Show a few more samples to see different states
            logger.info("Additional samples:")
            for i, sb in enumerate(all_sandboxes[1:6]):  # Show next 5 samples
                logger.info(f"  Sample {i+2}: State='{getattr(sb, 'state', 'N/A')}', ID={getattr(sb, 'id', 'N/A')[:20]}...")
            
    except Exception as e:
        logger.error(f"✗ Failed to list sandboxes: {e}")
        return {"error": 1}
    
    # Filter for STARTED sandboxes
    started_sandboxes = [sb for sb in all_sandboxes if getattr(sb, 'state', None) == 'started']
    logger.info(f"✓ Found {len(started_sandboxes)} sandboxes in STARTED state")
    
    # Save to JSON if requested
    if save_json and started_sandboxes:
        save_sandboxes_as_json(started_sandboxes, json_filename)
    
    if not started_sandboxes:
        logger.info("No sandboxes to stop")
        return {
            "total_sandboxes": len(all_sandboxes),
            "started_sandboxes": 0,
            "stopped": 0,
            "errors": 0
        }
    
    # Track statistics
    stats = {
        "total_sandboxes": len(all_sandboxes),
        "started_sandboxes": len(started_sandboxes),
        "stopped": 0,
        "errors": 0
    }
    
    # Log some sample IDs for verification
    sample_ids = [getattr(sb, 'id', 'unknown') for sb in started_sandboxes[:5]]
    logger.info(f"Sample STARTED sandbox IDs: {sample_ids}...")
    
    # Stop each started sandbox
    for i, sandbox in enumerate(started_sandboxes):
        sandbox_id = getattr(sandbox, 'id', 'unknown')
        sandbox_name = getattr(sandbox, 'name', 'unknown')
        
        logger.info(f"[{i+1}/{len(started_sandboxes)}] Processing sandbox: {sandbox_id} ({sandbox_name})")
        
        try:
            if dry_run:
                logger.info(f"  [DRY RUN] Would stop sandbox: {sandbox_id}")
                stats["stopped"] += 1
            else:
                logger.info(f"  Stopping sandbox: {sandbox_id}")
                
                # Stop the sandbox
                sandbox.stop()
                
                # Wait for sandbox to stop (with timeout)
                try:
                    sandbox.wait_for_sandbox_stop()
                    logger.info(f"  ✓ Successfully stopped sandbox: {sandbox_id}")
                    stats["stopped"] += 1
                except Exception as wait_error:
                    logger.warning(f"  ⚠ Sandbox {sandbox_id} stop command sent, but wait failed: {wait_error}")
                    # Still count as success since stop command was sent
                    stats["stopped"] += 1
                
        except Exception as e:
            logger.error(f"  ✗ Failed to stop sandbox {sandbox_id}: {e}")
            stats["errors"] += 1
    
    return stats

def main():
    parser = argparse.ArgumentParser(
        description="Stop all Daytona sandboxes in STARTED state",
        epilog="""
Examples:
  # Dry run to see what would be stopped
  python stop_started_sandboxes.py --dry-run
  
  # Actually stop all started sandboxes
  python stop_started_sandboxes.py
  
  # Save list to JSON and stop sandboxes
  python stop_started_sandboxes.py --save-json --json-file started_sandboxes.json
        """,
        formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument('--dry-run', action='store_true', help='Show what would be stopped without actually stopping')
    parser.add_argument('--save-json', action='store_true', help='Save list of started sandboxes as JSON file')
    parser.add_argument('--json-file', type=str, help='Custom filename for JSON output (default: started_sandboxes_TIMESTAMP.json)')
    
    args = parser.parse_args()
    
    # Verify configuration
    logger.info("Configuration check:")
    logger.info(f"  Daytona API Key: {'✓ Configured' if config.DAYTONA_API_KEY else '✗ Missing'}")
    logger.info(f"  Daytona API URL: {config.DAYTONA_SERVER_URL}")
    logger.info("")
    
    if args.dry_run:
        logger.info("=== DRY RUN MODE ===")
        logger.info("No sandboxes will actually be stopped")
        logger.info("")
    
    # Run the stop operation
    try:
        stats = stop_started_sandboxes(
            dry_run=args.dry_run,
            save_json=args.save_json,
            json_filename=args.json_file
        )
        
        # Print summary
        logger.info("")
        logger.info("=== SUMMARY ===")
        logger.info(f"Total sandboxes: {stats.get('total_sandboxes', 0)}")
        logger.info(f"Started sandboxes: {stats.get('started_sandboxes', 0)}")
        logger.info(f"Stopped: {stats.get('stopped', 0)}")
        logger.info(f"Errors: {stats.get('errors', 0)}")
        
        if args.dry_run and stats.get('started_sandboxes', 0) > 0:
            logger.info("")
            logger.info("To actually stop these sandboxes, run the script without --dry-run")
        
        success = stats.get('errors', 0) == 0 and 'error' not in stats
        sys.exit(0 if success else 1)
        
    except KeyboardInterrupt:
        logger.warning("\n⚠️  Operation cancelled by user")
        sys.exit(1)
    except Exception as e:
        logger.error(f"Script failed: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()


# Usage examples:
# 
# 1. Dry run to see what would be stopped:
# uv run python -m utils.scripts.stop_started_sandboxes --dry-run
#
# 2. Actually stop all started sandboxes:
# uv run python -m utils.scripts.stop_started_sandboxes
#
# 3. Save list to JSON and stop sandboxes:
# uv run python -m utils.scripts.stop_started_sandboxes --save-json --json-file started_sandboxes.json
