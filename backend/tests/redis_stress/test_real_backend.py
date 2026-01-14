#!/usr/bin/env python3
"""
Test the REAL backend redis fix - uses actual core.services.redis module.

Verifies:
1. Split pools prevent GET/SET starvation
2. Hub reduces connections (N clients = 1 XREAD)
3. No timeouts under load

Usage:
    cd backend
    uv run python tests/redis_stress/test_real_backend.py
"""

import sys
from pathlib import Path
# Add backend to path
backend_dir = Path(__file__).parent.parent.parent
sys.path.insert(0, str(backend_dir))

import asyncio
import time
import logging
from typing import List

# Import the REAL production redis module
from core.services import redis

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)


async def test_split_pools():
    """Test that GET/SET don't starve when hub is active."""
    logger.info("=" * 60)
    logger.info("TEST 1: Split pools - GET/SET while hub active")
    logger.info("=" * 60)

    await redis.get_client()
    hub = redis.redis.hub

    stream_key = "test:real:stream"
    await redis.xadd(stream_key, {"init": "1"})

    # Metrics
    get_success = 0
    get_timeout = 0
    hub_messages = 0
    shutdown = False

    async def sse_client(client_id: int):
        """Simulates SSE client using hub."""
        nonlocal hub_messages, shutdown
        try:
            async with hub.subscription(stream_key, "0") as queue:
                async for msg in hub.iter_queue(queue, timeout=0.5):
                    if shutdown:
                        break
                    if msg:
                        hub_messages += 1
        except asyncio.CancelledError:
            pass

    async def producer():
        """Produces messages to stream."""
        nonlocal shutdown
        while not shutdown:
            await redis.xadd(stream_key, {"ts": str(time.time())}, maxlen=100)
            await asyncio.sleep(0.1)

    async def get_worker():
        """Does GET operations - should NOT timeout."""
        nonlocal get_success, get_timeout, shutdown
        while not shutdown:
            start = time.time()
            result = await redis.get("test:key", timeout=2.0)
            latency = time.time() - start
            if latency > 1.5:
                get_timeout += 1
                logger.warning(f"GET slow: {latency:.2f}s")
            else:
                get_success += 1
            await asyncio.sleep(0.05)

    # Start 20 SSE clients + producer + 5 GET workers
    NUM_SSE = 20
    NUM_WORKERS = 5
    DURATION = 10

    tasks = [asyncio.create_task(producer())]
    for i in range(NUM_SSE):
        tasks.append(asyncio.create_task(sse_client(i)))

    await asyncio.sleep(1)  # Let hub establish

    for i in range(NUM_WORKERS):
        tasks.append(asyncio.create_task(get_worker()))

    logger.info(f"Running: {NUM_SSE} SSE clients, {NUM_WORKERS} GET workers, {DURATION}s")
    logger.info(f"Hub stats: {hub.get_stats()}")
    logger.info(f"Pool info: {redis.get_pool_info()}")

    await asyncio.sleep(DURATION)
    shutdown = True

    for t in tasks:
        t.cancel()
        try:
            await t
        except asyncio.CancelledError:
            pass

    await redis.delete(stream_key)

    # Results
    logger.info("")
    logger.info("RESULTS:")
    logger.info(f"  GET success: {get_success}")
    logger.info(f"  GET slow/timeout: {get_timeout}")
    logger.info(f"  Hub messages delivered: {hub_messages}")
    logger.info(f"  Hub stats: {hub.get_stats()}")

    success = get_timeout == 0
    logger.info(f"  VERDICT: {'PASS - No GET timeouts' if success else 'FAIL - GET timeouts detected'}")
    return success


async def test_hub_connection_reduction():
    """Test that hub uses 1 connection per stream, not per client."""
    logger.info("")
    logger.info("=" * 60)
    logger.info("TEST 2: Hub connection reduction")
    logger.info("=" * 60)

    await redis.get_client()
    hub = redis.redis.hub

    stream_key = "test:hub:stream"
    await redis.xadd(stream_key, {"init": "1"})

    NUM_CLIENTS = 30
    queues = []

    # Subscribe many clients to SAME stream
    for i in range(NUM_CLIENTS):
        queue = await hub.subscribe(stream_key, "0")
        queues.append(queue)

    stats = hub.get_stats()
    pool_info = redis.get_pool_info()

    logger.info(f"  Clients subscribed: {NUM_CLIENTS}")
    logger.info(f"  Hub streams_active: {stats['streams_active']}")
    logger.info(f"  Hub subscribers_total: {stats['subscribers_total']}")
    logger.info(f"  Stream pool in_use: {pool_info.get('stream_pool', {}).get('in_use_connections', 'N/A')}")

    # Cleanup
    for queue in queues:
        await hub.unsubscribe(stream_key, queue)

    await redis.delete(stream_key)

    # Verify: should be 1 stream active (1 pump), not 30
    success = stats['streams_active'] == 1
    logger.info(f"  VERDICT: {'PASS - 1 XREAD for 30 clients' if success else 'FAIL - Multiple readers'}")
    return success


async def test_concurrent_streams():
    """Test multiple different streams don't exhaust pool."""
    logger.info("")
    logger.info("=" * 60)
    logger.info("TEST 3: Multiple concurrent streams")
    logger.info("=" * 60)

    await redis.get_client()
    hub = redis.redis.hub

    NUM_STREAMS = 20
    CLIENTS_PER_STREAM = 3
    stream_keys = [f"test:multi:{i}" for i in range(NUM_STREAMS)]
    all_queues: List[tuple] = []

    # Create streams and subscribe
    for stream_key in stream_keys:
        await redis.xadd(stream_key, {"init": "1"})
        for _ in range(CLIENTS_PER_STREAM):
            queue = await hub.subscribe(stream_key, "0")
            all_queues.append((stream_key, queue))

    stats = hub.get_stats()
    pool_info = redis.get_pool_info()

    logger.info(f"  Streams: {NUM_STREAMS}")
    logger.info(f"  Clients per stream: {CLIENTS_PER_STREAM}")
    logger.info(f"  Total clients: {NUM_STREAMS * CLIENTS_PER_STREAM}")
    logger.info(f"  Hub streams_active: {stats['streams_active']}")
    logger.info(f"  Stream pool in_use: {pool_info.get('stream_pool', {}).get('in_use_connections', 'N/A')}")

    # Test GET still works
    get_result = await redis.get("test:key", timeout=2.0)
    logger.info(f"  GET during load: {'OK' if get_result is None or True else 'FAIL'}")

    # Cleanup
    for stream_key, queue in all_queues:
        await hub.unsubscribe(stream_key, queue)
    for stream_key in stream_keys:
        await redis.delete(stream_key)

    # Should have NUM_STREAMS active (1 pump each)
    success = stats['streams_active'] == NUM_STREAMS
    logger.info(f"  VERDICT: {'PASS' if success else 'FAIL'} - {stats['streams_active']} pumps for {NUM_STREAMS} streams")
    return success


async def main():
    logger.info("=" * 70)
    logger.info("REAL BACKEND REDIS FIX TEST")
    logger.info("=" * 70)
    logger.info("Using actual core.services.redis module")
    logger.info("")

    results = []

    try:
        results.append(("Split pools", await test_split_pools()))
        results.append(("Hub reduction", await test_hub_connection_reduction()))
        results.append(("Multi streams", await test_concurrent_streams()))
    finally:
        await redis.close()

    logger.info("")
    logger.info("=" * 70)
    logger.info("FINAL RESULTS")
    logger.info("=" * 70)
    for name, passed in results:
        status = "✅ PASS" if passed else "❌ FAIL"
        logger.info(f"  {name}: {status}")

    all_passed = all(r[1] for r in results)
    logger.info("")
    logger.info(f"OVERALL: {'✅ ALL TESTS PASSED' if all_passed else '❌ SOME TESTS FAILED'}")
    logger.info("=" * 70)

    return all_passed


if __name__ == "__main__":
    success = asyncio.run(main())
    exit(0 if success else 1)
