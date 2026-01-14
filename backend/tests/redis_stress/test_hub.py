#!/usr/bin/env python3
"""
Hub Pattern Test: 1 Redis reader per stream, fan-out to N clients

Demonstrates:
- WITHOUT HUB: 50 clients = 50 XREAD BLOCK = 50 held connections
- WITH HUB: 50 clients = 1 XREAD BLOCK + 50 bounded queues

Usage:
    cd backend
    uv run python tests/redis_stress/test_hub.py
"""

import asyncio
import time
import logging
from datetime import datetime
from pathlib import Path
import json

from redis.asyncio import Redis
from redis.asyncio.connection import BlockingConnectionPool

from redis_fix import RedisFixedClient, PoolConfig

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)


NUM_CLIENTS = 50  # Simulating 50 SSE clients watching same stream
DURATION = 10
BLOCK_MS = 500


async def test_without_hub():
    """Each client does its own XREAD - 50 clients = 50 blocked connections."""
    logger.info("=" * 60)
    logger.info("WITHOUT HUB: Each client does own XREAD")
    logger.info("=" * 60)

    pool = BlockingConnectionPool(
        host="localhost",
        port=6379,
        max_connections=NUM_CLIENTS + 10,  # Enough for all
        timeout=1.0,
        socket_timeout=10.0,
        decode_responses=True,
    )
    redis = Redis(connection_pool=pool)
    await redis.ping()

    stream_key = f"hub_test_without:{int(time.time())}"
    await redis.xadd(stream_key, {"init": "1"})

    shutdown = False
    messages_received = [0] * NUM_CLIENTS

    async def client_reader(client_id: int):
        nonlocal shutdown
        last_id = "0"
        while not shutdown:
            try:
                # Each client blocks on Redis - holds a connection
                result = await asyncio.wait_for(
                    redis.xread({stream_key: last_id}, block=BLOCK_MS, count=10),
                    timeout=5.0
                )
                if result:
                    for _, entries in result:
                        for msg_id, _ in entries:
                            last_id = msg_id
                            messages_received[client_id] += 1
            except asyncio.TimeoutError:
                pass
            except Exception:
                await asyncio.sleep(0.1)

    async def producer():
        nonlocal shutdown
        while not shutdown:
            try:
                await redis.xadd(stream_key, {"ts": str(time.time())}, maxlen=100)
            except Exception:
                pass
            await asyncio.sleep(0.1)

    # Start producer
    tasks = [asyncio.create_task(producer())]

    # Start all client readers
    for i in range(NUM_CLIENTS):
        tasks.append(asyncio.create_task(client_reader(i)))

    await asyncio.sleep(1)

    # Check connections in use
    in_use = len(getattr(pool, '_in_use_connections', []))
    logger.info(f"Connections in use: {in_use} (expected ~{NUM_CLIENTS})")

    await asyncio.sleep(DURATION)
    shutdown = True

    for t in tasks:
        t.cancel()
        try:
            await t
        except asyncio.CancelledError:
            pass

    total_msgs = sum(messages_received)
    await redis.delete(stream_key)
    await redis.aclose()
    await pool.aclose()

    logger.info(f"Total messages delivered: {total_msgs}")
    logger.info(f"Max connections used: {in_use}")

    return {
        "pattern": "without_hub",
        "clients": NUM_CLIENTS,
        "max_connections_used": in_use,
        "total_messages": total_msgs,
    }


async def test_with_hub():
    """All clients share 1 XREAD via hub - 50 clients = 1 blocked connection."""
    logger.info("=" * 60)
    logger.info("WITH HUB: 1 reader, fan-out to all clients")
    logger.info("=" * 60)

    config = PoolConfig(
        general_max_connections=20,
        stream_max_connections=10,  # Hub needs only ~1-2 per stream
        general_pool_timeout=1.0,
        stream_pool_timeout=1.0,
    )

    client = RedisFixedClient(config)
    await client.initialize()

    stream_key = f"hub_test_with:{int(time.time())}"
    await client.xadd(stream_key, {"init": "1"})

    shutdown = False
    messages_received = [0] * NUM_CLIENTS
    queues = []

    async def client_reader_with_context(client_id: int):
        """
        Uses context manager (GUARDRAIL #4) - unsubscribe always called.
        """
        nonlocal shutdown
        try:
            async with client.hub.subscription(stream_key, last_id="0") as queue:
                queues.append(queue)
                while not shutdown:
                    try:
                        async for msg in client.hub.iter_queue(queue, timeout=0.5):
                            if msg is None:
                                continue
                            if shutdown:
                                break
                            messages_received[client_id] += 1
                    except Exception:
                        await asyncio.sleep(0.1)
        except asyncio.CancelledError:
            pass  # Context manager handles cleanup

    async def producer():
        nonlocal shutdown
        while not shutdown:
            try:
                # Note: xadd now uses DEFAULT_STREAM_MAXLEN automatically (GUARDRAIL #5)
                await client.xadd(stream_key, {"ts": str(time.time())})
            except Exception:
                pass
            await asyncio.sleep(0.1)

    # Start producer
    tasks = [asyncio.create_task(producer())]

    # Subscribe all clients using context manager (GUARDRAIL #4)
    for i in range(NUM_CLIENTS):
        tasks.append(asyncio.create_task(client_reader_with_context(i)))

    await asyncio.sleep(1)

    # Check hub stats
    hub_stats = client.hub.get_stats()
    logger.info(f"Hub streams_active: {hub_stats['streams_active']} (expected 1)")
    logger.info(f"Hub subscribers_total: {hub_stats['subscribers_total']} (expected {NUM_CLIENTS})")

    pool_info = client.get_pool_info()
    stream_in_use = pool_info['stream_pool'].get('in_use', 0)
    logger.info(f"Stream pool connections in use: {stream_in_use} (expected ~1)")

    await asyncio.sleep(DURATION)
    shutdown = True

    # Context managers handle unsubscribe automatically (GUARDRAIL #4)
    # Just cancel the tasks
    for t in tasks:
        t.cancel()
        try:
            await t
        except asyncio.CancelledError:
            pass

    total_msgs = sum(messages_received)
    final_stats = client.hub.get_stats()

    await client.delete(stream_key)
    await client.close()

    logger.info(f"Total messages delivered: {total_msgs}")
    logger.info(f"Messages dropped (slow clients): {final_stats['messages_dropped']}")

    return {
        "pattern": "with_hub",
        "clients": NUM_CLIENTS,
        "streams_active": hub_stats['streams_active'],
        "stream_connections_used": stream_in_use,
        "total_messages": total_msgs,
        "messages_dropped": final_stats['messages_dropped'],
    }


async def main():
    logger.info("=" * 70)
    logger.info("HUB PATTERN COMPARISON TEST")
    logger.info("=" * 70)
    logger.info(f"Config: clients={NUM_CLIENTS}, duration={DURATION}s")
    logger.info("")

    # Test without hub
    without_hub = await test_without_hub()

    await asyncio.sleep(2)

    # Test with hub
    with_hub = await test_with_hub()

    # Results
    logger.info("")
    logger.info("=" * 70)
    logger.info("COMPARISON RESULTS")
    logger.info("=" * 70)
    logger.info("")

    logger.info("WITHOUT HUB (direct XREAD per client):")
    logger.info(f"  Clients: {without_hub['clients']}")
    logger.info(f"  Connections used: {without_hub['max_connections_used']}")
    logger.info(f"  Messages delivered: {without_hub['total_messages']}")

    logger.info("")
    logger.info("WITH HUB (1 reader, fan-out):")
    logger.info(f"  Clients: {with_hub['clients']}")
    logger.info(f"  Active streams: {with_hub['streams_active']}")
    logger.info(f"  Stream connections: {with_hub['stream_connections_used']}")
    logger.info(f"  Messages delivered: {with_hub['total_messages']}")
    logger.info(f"  Messages dropped: {with_hub['messages_dropped']}")

    logger.info("")
    logger.info("=" * 70)

    # Verdict
    conn_reduction = without_hub['max_connections_used'] - with_hub['stream_connections_used']
    if with_hub['streams_active'] == 1 and conn_reduction >= (NUM_CLIENTS - 5):
        logger.info("VERDICT: HUB PATTERN WORKS!")
        logger.info(f"  Connection reduction: {without_hub['max_connections_used']} -> {with_hub['stream_connections_used']}")
        logger.info(f"  ({NUM_CLIENTS} clients use 1 XREAD instead of {NUM_CLIENTS})")
    else:
        logger.info("MIXED: Check results manually")

    logger.info("=" * 70)

    # Save results
    log_dir = Path("tests/redis_stress/logs")
    log_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    results_file = log_dir / f"hub_comparison_{timestamp}.json"

    results = {
        "timestamp": datetime.now().isoformat(),
        "config": {
            "num_clients": NUM_CLIENTS,
            "duration": DURATION,
        },
        "without_hub": without_hub,
        "with_hub": with_hub,
        "verdict": "HUB_WORKS" if (with_hub['streams_active'] == 1 and conn_reduction >= (NUM_CLIENTS - 5)) else "CHECK_MANUALLY"
    }

    with open(results_file, "w") as f:
        json.dump(results, f, indent=2)

    logger.info(f"Results saved: {results_file}")


if __name__ == "__main__":
    asyncio.run(main())
