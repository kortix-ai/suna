#!/usr/bin/env python3
"""
Cleanup zombie runs from Redis runs:active set.
These are runs that were never properly released due to crashes/restarts.
"""
import asyncio
import time
import argparse
from typing import List, Dict, Any


async def get_zombie_runs(min_age_seconds: int = 300) -> List[Dict[str, Any]]:
    from core.services import redis

    zombies = []
    now = time.time()

    active = await redis.smembers("runs:active")
    if not active:
        print("No active runs found")
        return []

    run_ids = [r.decode() if isinstance(r, bytes) else r for r in active]
    print(f"Found {len(run_ids)} runs in runs:active set")

    client = await redis.get_client()

    for run_id in run_ids:
        try:
            owner = await client.get(f"run:{{{run_id}}}:owner")
            status = await client.get(f"run:{{{run_id}}}:status")
            heartbeat = await client.get(f"run:{{{run_id}}}:heartbeat")
            start = await client.get(f"run:{{{run_id}}}:start")

            owner = owner.decode() if owner and isinstance(owner, bytes) else owner
            status = status.decode() if status and isinstance(status, bytes) else status
            heartbeat = float(heartbeat.decode() if heartbeat and isinstance(heartbeat, bytes) else heartbeat) if heartbeat else None
            start = float(start.decode() if start and isinstance(start, bytes) else start) if start else None

            heartbeat_age = (now - heartbeat) if heartbeat else None
            run_age = (now - start) if start else None

            is_zombie = False
            reason = None

            if not heartbeat:
                is_zombie = True
                reason = "no_heartbeat"
            elif heartbeat_age and heartbeat_age > min_age_seconds:
                is_zombie = True
                reason = f"stale_heartbeat_{heartbeat_age:.0f}s"
            elif not owner and status == "running":
                is_zombie = True
                reason = "no_owner"
            elif run_age and run_age > 3600:
                is_zombie = True
                reason = f"very_old_{run_age:.0f}s"

            if is_zombie:
                zombies.append({
                    "run_id": run_id,
                    "owner": owner,
                    "status": status,
                    "heartbeat_age": heartbeat_age,
                    "run_age": run_age,
                    "reason": reason,
                })
        except Exception as e:
            print(f"Error checking {run_id}: {e}")
            zombies.append({
                "run_id": run_id,
                "reason": f"error: {e}",
            })

    return zombies


async def cleanup_zombie(run_id: str, dry_run: bool = True) -> bool:
    from core.services import redis

    if dry_run:
        print(f"  [DRY RUN] Would clean up {run_id}")
        return True

    try:
        client = await redis.get_client()

        await client.srem("runs:active", run_id)
        await client.delete(f"run:{{{run_id}}}:owner")
        await client.delete(f"run:{{{run_id}}}:status")
        await client.delete(f"run:{{{run_id}}}:heartbeat")
        await client.delete(f"run:{{{run_id}}}:start")

        print(f"  [CLEANED] {run_id}")
        return True
    except Exception as e:
        print(f"  [ERROR] Failed to clean {run_id}: {e}")
        return False


async def main(dry_run: bool = True, min_age: int = 300):
    from core.services.db import init_db
    from core.services import redis

    await init_db()
    await redis.init()

    print(f"\n{'='*60}")
    print(f"Zombie Run Cleanup - {'DRY RUN' if dry_run else 'LIVE MODE'}")
    print(f"Min age threshold: {min_age}s")
    print(f"{'='*60}\n")

    zombies = await get_zombie_runs(min_age_seconds=min_age)

    if not zombies:
        print("\nNo zombie runs found!")
        return

    print(f"\nFound {len(zombies)} zombie runs:\n")
    for z in zombies[:20]:
        print(f"  {z['run_id']}: {z.get('reason', 'unknown')}")
    if len(zombies) > 20:
        print(f"  ... and {len(zombies) - 20} more")

    print(f"\n{'='*60}")

    if dry_run:
        print(f"\nDRY RUN - No changes made. Run with --execute to clean up.")
    else:
        print(f"\nCleaning up {len(zombies)} zombie runs...")
        cleaned = 0
        for z in zombies:
            if await cleanup_zombie(z["run_id"], dry_run=False):
                cleaned += 1
        print(f"\nCleaned {cleaned}/{len(zombies)} zombie runs")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Cleanup zombie runs from Redis")
    parser.add_argument("--execute", action="store_true", help="Actually clean up (default is dry run)")
    parser.add_argument("--min-age", type=int, default=300, help="Min heartbeat age in seconds to consider zombie (default: 300)")
    args = parser.parse_args()

    asyncio.run(main(dry_run=not args.execute, min_age=args.min_age))
