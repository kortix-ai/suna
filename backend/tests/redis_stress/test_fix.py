#!/usr/bin/env python3
"""
Comparative Test: Broken vs Fixed Redis Patterns

Runs the SAME workload against:
1. BROKEN: Single shared pool (current prod behavior)
2. FIXED: Split pools (general + stream)

Shows the fix eliminates connection starvation.

Usage:
    cd backend
    uv run python tests/redis_stress/test_fix.py
"""

import asyncio
import json
import logging
import time
from datetime import datetime
from pathlib import Path
from dataclasses import dataclass
from typing import Dict, Any, List

from redis.asyncio import Redis
from redis.asyncio.connection import BlockingConnectionPool
from redis.exceptions import ConnectionError as RedisConnectionError

from redis_fix import RedisFixedClient, PoolConfig

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)


@dataclass
class TestResult:
    name: str
    duration: float
    get_attempts: int = 0
    get_successes: int = 0
    get_timeouts: int = 0
    get_pool_failures: int = 0
    xread_ops: int = 0
    avg_latency_ms: float = 0
    max_latency_ms: float = 0

    def to_dict(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "duration_s": self.duration,
            "get": {
                "attempts": self.get_attempts,
                "successes": self.get_successes,
                "timeouts": self.get_timeouts,
                "pool_failures": self.get_pool_failures,
                "success_rate": self.get_successes / max(1, self.get_attempts),
            },
            "xread_ops": self.xread_ops,
            "latency": {
                "avg_ms": self.avg_latency_ms,
                "max_ms": self.max_latency_ms,
            }
        }


# =============================================================================
# TEST CONFIG - Same for both patterns
# =============================================================================

POOL_SIZE = 10          # Smaller pool to trigger faster
NUM_READERS = 25        # Way more than pool size
NUM_WORKERS = 10        # More workers competing
BLOCK_MS = 1000         # Longer block = hold connections longer
DURATION = 12           # Test duration


# =============================================================================
# BROKEN PATTERN TEST
# =============================================================================

async def test_broken_pattern() -> TestResult:
    """Test with single shared pool (current prod behavior)."""
    logger.info("=" * 60)
    logger.info("TESTING BROKEN PATTERN (single shared pool)")
    logger.info("=" * 60)

    # Single pool for everything - THIS IS THE BUG
    pool = BlockingConnectionPool(
        host="localhost",
        port=6379,
        max_connections=POOL_SIZE,
        timeout=0.2,
        socket_timeout=10.0,
        decode_responses=True,
    )
    redis = Redis(connection_pool=pool)
    await redis.ping()

    result = TestResult(name="broken_single_pool", duration=DURATION)
    latencies = []
    shutdown = False

    async def blocking_reader(stream_key: str):
        nonlocal shutdown
        last_id = "0"
        while not shutdown:
            try:
                result.xread_ops += 1
                # Uses SAME pool as GET/SET - starves them
                await asyncio.wait_for(
                    redis.xread({stream_key: last_id}, block=BLOCK_MS, count=100),
                    timeout=10.0
                )
            except Exception:
                await asyncio.sleep(0.1)

    async def getset_worker():
        nonlocal shutdown
        while not shutdown:
            result.get_attempts += 1
            start = time.time()
            try:
                await asyncio.wait_for(redis.get("test:key"), timeout=2.0)
                latencies.append(time.time() - start)
                result.get_successes += 1
            except asyncio.TimeoutError:
                result.get_timeouts += 1
            except RedisConnectionError as e:
                if "No connection" in str(e) or "Timeout" in str(e).lower():
                    result.get_pool_failures += 1
            except Exception:
                pass
            await asyncio.sleep(0.05)

    async def producer(stream_key: str):
        nonlocal shutdown
        await redis.xadd(stream_key, {"init": "1"})
        while not shutdown:
            try:
                await redis.xadd(stream_key, {"ts": str(time.time())}, maxlen=100)
            except Exception:
                pass
            await asyncio.sleep(0.5)

    stream_key = f"broken_test:{int(time.time())}"
    tasks = [asyncio.create_task(producer(stream_key))]

    # Start readers and let them FULLY grab all connections
    for _ in range(NUM_READERS):
        tasks.append(asyncio.create_task(blocking_reader(stream_key)))

    # Wait for readers to saturate the pool
    await asyncio.sleep(2)
    logger.info(f"  Pool after readers: in_use={len(getattr(pool, '_in_use_connections', []))}")

    # NOW start workers - they should fail to get connections
    for _ in range(NUM_WORKERS):
        tasks.append(asyncio.create_task(getset_worker()))

    await asyncio.sleep(DURATION)
    shutdown = True

    for t in tasks:
        t.cancel()
        try:
            await t
        except asyncio.CancelledError:
            pass

    await redis.delete(stream_key)
    await redis.aclose()
    await pool.aclose()

    if latencies:
        result.avg_latency_ms = (sum(latencies) / len(latencies)) * 1000
        result.max_latency_ms = max(latencies) * 1000

    logger.info(f"BROKEN: GET {result.get_successes}/{result.get_attempts}, "
                f"pool_failures={result.get_pool_failures}, timeouts={result.get_timeouts}")

    return result


# =============================================================================
# FIXED PATTERN TEST
# =============================================================================

async def test_fixed_pattern() -> TestResult:
    """Test with split pools (the fix)."""
    logger.info("=" * 60)
    logger.info("TESTING FIXED PATTERN (split pools)")
    logger.info("=" * 60)

    config = PoolConfig(
        general_max_connections=POOL_SIZE,  # Same size as broken test
        stream_max_connections=NUM_READERS + 10,  # Room for all readers
        general_pool_timeout=0.2,
        stream_pool_timeout=0.2,
    )

    client = RedisFixedClient(config)
    await client.initialize()

    result = TestResult(name="fixed_split_pools", duration=DURATION)
    latencies = []
    shutdown = False

    async def blocking_reader(stream_key: str):
        nonlocal shutdown
        last_id = "0"
        while not shutdown:
            try:
                result.xread_ops += 1
                # Uses STREAM pool - doesn't affect general pool
                await client.xread_blocking({stream_key: last_id}, block=BLOCK_MS)
            except Exception:
                await asyncio.sleep(0.1)

    async def getset_worker():
        nonlocal shutdown
        while not shutdown:
            result.get_attempts += 1
            start = time.time()
            try:
                # Uses GENERAL pool - isolated from blocking readers
                r = await client.get("test:key", timeout=2.0)
                latencies.append(time.time() - start)
                result.get_successes += 1
            except asyncio.TimeoutError:
                result.get_timeouts += 1
            except RedisConnectionError as e:
                if "No connection" in str(e) or "Timeout" in str(e).lower():
                    result.get_pool_failures += 1
            except Exception:
                pass
            await asyncio.sleep(0.05)

    async def producer(stream_key: str):
        nonlocal shutdown
        await client.xadd(stream_key, {"init": "1"})
        while not shutdown:
            try:
                await client.xadd(stream_key, {"ts": str(time.time())}, maxlen=100)
            except Exception:
                pass
            await asyncio.sleep(0.5)

    stream_key = f"fixed_test:{int(time.time())}"
    tasks = [asyncio.create_task(producer(stream_key))]

    for _ in range(NUM_READERS):
        tasks.append(asyncio.create_task(blocking_reader(stream_key)))

    await asyncio.sleep(1)

    for _ in range(NUM_WORKERS):
        tasks.append(asyncio.create_task(getset_worker()))

    await asyncio.sleep(DURATION)
    shutdown = True

    for t in tasks:
        t.cancel()
        try:
            await t
        except asyncio.CancelledError:
            pass

    await client.delete(stream_key)
    await client.close()

    if latencies:
        result.avg_latency_ms = (sum(latencies) / len(latencies)) * 1000
        result.max_latency_ms = max(latencies) * 1000

    logger.info(f"FIXED: GET {result.get_successes}/{result.get_attempts}, "
                f"pool_failures={result.get_pool_failures}, timeouts={result.get_timeouts}")

    return result


# =============================================================================
# MAIN
# =============================================================================

async def main():
    logger.info("=" * 70)
    logger.info("REDIS FIX COMPARISON TEST")
    logger.info("=" * 70)
    logger.info(f"Config: pool_size={POOL_SIZE}, readers={NUM_READERS}, "
                f"workers={NUM_WORKERS}, duration={DURATION}s")
    logger.info("")

    # Run broken pattern
    broken = await test_broken_pattern()

    await asyncio.sleep(2)  # Let connections settle

    # Run fixed pattern
    fixed = await test_fixed_pattern()

    # Results
    logger.info("")
    logger.info("=" * 70)
    logger.info("COMPARISON RESULTS")
    logger.info("=" * 70)
    logger.info("")

    logger.info("BROKEN (single pool):")
    logger.info(f"  GET success rate: {broken.get_successes}/{broken.get_attempts} "
                f"({broken.get_successes/max(1,broken.get_attempts)*100:.1f}%)")
    logger.info(f"  Pool failures: {broken.get_pool_failures}")
    logger.info(f"  Timeouts: {broken.get_timeouts}")
    logger.info(f"  Avg latency: {broken.avg_latency_ms:.1f}ms")

    logger.info("")
    logger.info("FIXED (split pools):")
    logger.info(f"  GET success rate: {fixed.get_successes}/{fixed.get_attempts} "
                f"({fixed.get_successes/max(1,fixed.get_attempts)*100:.1f}%)")
    logger.info(f"  Pool failures: {fixed.get_pool_failures}")
    logger.info(f"  Timeouts: {fixed.get_timeouts}")
    logger.info(f"  Avg latency: {fixed.avg_latency_ms:.1f}ms")

    logger.info("")
    logger.info("=" * 70)

    # Verdict
    broken_failures = broken.get_pool_failures + broken.get_timeouts
    fixed_failures = fixed.get_pool_failures + fixed.get_timeouts

    if broken_failures > 0 and fixed_failures == 0:
        logger.info("VERDICT: FIX WORKS!")
        logger.info(f"  Broken: {broken_failures} failures")
        logger.info(f"  Fixed: {fixed_failures} failures")
    elif broken_failures == 0:
        logger.info("NOTE: Broken pattern didn't fail - try smaller pool or more readers")
    else:
        logger.info(f"MIXED: Broken={broken_failures} failures, Fixed={fixed_failures} failures")

    logger.info("=" * 70)

    # Save results
    log_dir = Path("tests/redis_stress/logs")
    log_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    results_file = log_dir / f"fix_comparison_{timestamp}.json"

    results = {
        "timestamp": datetime.now().isoformat(),
        "config": {
            "pool_size": POOL_SIZE,
            "num_readers": NUM_READERS,
            "num_workers": NUM_WORKERS,
            "duration": DURATION,
        },
        "broken": broken.to_dict(),
        "fixed": fixed.to_dict(),
        "verdict": "FIX_WORKS" if (broken_failures > 0 and fixed_failures == 0) else "INCONCLUSIVE"
    }

    with open(results_file, "w") as f:
        json.dump(results, f, indent=2)

    logger.info(f"Results saved: {results_file}")


if __name__ == "__main__":
    asyncio.run(main())
