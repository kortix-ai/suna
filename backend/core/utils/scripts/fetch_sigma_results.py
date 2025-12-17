#!/usr/bin/env python3
"""
Fetch Stripe Sigma scheduled query results.

Usage:
  python fetch_sigma_results.py              # Get latest result
  python fetch_sigma_results.py --list       # List all scheduled query runs
  python fetch_sigma_results.py --query "Monthly Subscribers"  # Get specific query by title
"""

import argparse
import json
import sys
from pathlib import Path

import requests

# Add backend directory to path
backend_dir = Path(__file__).parent.parent.parent.parent
sys.path.insert(0, str(backend_dir))

from core.utils.config import get_config

STRIPE_API_BASE = "https://api.stripe.com"


def get_api_key():
    config = get_config()
    api_key = config.STRIPE_SECRET_KEY
    if not api_key:
        print("Error: STRIPE_SECRET_KEY not configured")
        sys.exit(1)
    return api_key


def download_file(api_key: str, file_obj: dict) -> str | None:
    """Download CSV results from a Sigma file object."""
    file_id = file_obj.get("id") if isinstance(file_obj, dict) else file_obj
    
    # Create a file link
    resp = requests.post(
        f"{STRIPE_API_BASE}/v1/file_links",
        auth=(api_key, ""),
        data={"file": file_id},
    )
    
    if resp.status_code != 200:
        print(f"Failed to create file link: {resp.status_code}")
        return None
    
    download_url = resp.json().get("url")
    
    # Download CSV
    csv_resp = requests.get(download_url)
    if csv_resp.status_code == 200:
        return csv_resp.text
    return None


def list_scheduled_runs(api_key: str, limit: int = 20):
    """List all scheduled query runs."""
    print("Scheduled Query Runs:")
    print("=" * 70)
    
    resp = requests.get(
        f"{STRIPE_API_BASE}/v1/sigma/scheduled_query_runs",
        auth=(api_key, ""),
        params={"limit": limit},
    )
    
    if resp.status_code != 200:
        print(f"Error: {resp.status_code} - {resp.text}")
        return
    
    runs = resp.json().get("data", [])
    
    if not runs:
        print("\nNo scheduled queries found.")
        print("\nTo create one:")
        print("  1. Go to https://dashboard.stripe.com/sigma/queries/new")
        print("  2. Paste your SQL and save")
        print("  3. Click 'Schedule' to set frequency")
        return
    
    for run in runs:
        status_icon = "✅" if run.get("status") == "completed" else "⏳"
        print(f"\n{status_icon} {run.get('title', 'Untitled')}")
        print(f"   ID: {run.get('id')}")
        print(f"   Status: {run.get('status')}")
        if run.get("file"):
            print(f"   File: {run['file'].get('id')}")


def get_latest_result(api_key: str, query_title: str = None):
    """Get the latest scheduled query result."""
    resp = requests.get(
        f"{STRIPE_API_BASE}/v1/sigma/scheduled_query_runs",
        auth=(api_key, ""),
        params={"limit": 50},
    )
    
    if resp.status_code != 200:
        print(f"Error: {resp.status_code}")
        return None
    
    runs = resp.json().get("data", [])
    
    if not runs:
        print("No scheduled query runs found.")
        print("\nCreate one at: https://dashboard.stripe.com/sigma/queries/new")
        return None
    
    # Filter by title if specified
    if query_title:
        runs = [r for r in runs if query_title.lower() in (r.get("title") or "").lower()]
        if not runs:
            print(f"No query matching '{query_title}' found.")
            return None
    
    # Get the first completed run
    for run in runs:
        if run.get("status") == "completed" and run.get("file"):
            print(f"Query: {run.get('title', 'Untitled')}")
            print(f"Status: {run.get('status')}")
            print(f"Run ID: {run.get('id')}")
            print("-" * 70)
            
            csv_content = download_file(api_key, run["file"])
            if csv_content:
                print("\nRESULTS:")
                print("=" * 70)
                print(csv_content)
                return csv_content
    
    print("No completed query runs with results found.")
    return None


def main():
    parser = argparse.ArgumentParser(description="Fetch Stripe Sigma scheduled query results")
    parser.add_argument("--list", action="store_true", help="List all scheduled query runs")
    parser.add_argument("--query", type=str, help="Filter by query title (partial match)")
    parser.add_argument("--output", type=str, help="Save results to file")
    args = parser.parse_args()
    
    api_key = get_api_key()
    
    if args.list:
        list_scheduled_runs(api_key)
    else:
        result = get_latest_result(api_key, args.query)
        if result and args.output:
            with open(args.output, "w") as f:
                f.write(result)
            print(f"\nSaved to: {args.output}")


if __name__ == "__main__":
    main()

