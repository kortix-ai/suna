#!/usr/bin/env python3
"""
STANDALONE Redis Stress Test Script

Replicates PRODUCTION Redis issues:
1. CONNECTION STARVATION - XREAD BLOCK holding connections, starving GET/SET
2. POOL EXHAUSTION - Single pool shared between blocking and non-blocking ops
3. 1:1 CLIENT:READER - Each SSE client = 1 Redis XREAD (doesn't scale)

Usage:
    cd backend
    uv run python tests/redis_stress/stress_test.py

    # Quick test
    uv run python tests/redis_stress/stress_test.py --quick

    # Specific test
    uv run python tests/redis_stress/stress_test.py --test starvation

    # Custom Redis
    uv run python tests/redis_stress/stress_test.py --host localhost --port 6379
"""

import asyncio
import argparse
import json
import logging
import time
import random
from datetime import datetime
from pathlib import Path
from dataclasses import dataclass
from typing import Dict, Any, List

try:
    from redis.asyncio import Redis
    from redis.asyncio.connection import BlockingConnectionPool
    from redis.exceptions import ConnectionError as RedisConnectionError
except ImportError:
    print("ERROR: redis-py not installed. Run: uv add redis")
    exit(1)


# ============================================================================
# CONFIGURATION
# ============================================================================

@dataclass
class Config:
    # Redis
    host: str = "localhost"
    port: int = 6379
    password: str = None

    # Pool settings - INTENTIONALLY SMALL to replicate prod issue
    # Your prod shows: POOL STATUS {'max_connections': 15 ...}
    pool_size: int = 15
    pool_timeout: float = 0.2  # How long to wait for a free connection (fail fast)

    socket_timeout: float = 10.0
    op_timeout: float = 2.0  # Your prod uses 2s timeout for GET

    # Stream settings - matches prod
    block_ms: int = 500  # XREAD BLOCK duration (prod uses 500ms)

    quick: bool = False


# ============================================================================
# UTILITIES
# ============================================================================

def setup_logging(log_dir: str) -> str:
    """Setup logging to file and console."""
    log_path = Path(log_dir)
    log_path.mkdir(parents=True, exist_ok=True)

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    log_file = log_path / f"redis_stress_{timestamp}.log"

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s - %(levelname)s - %(message)s",
        handlers=[
            logging.FileHandler(log_file),
            logging.StreamHandler(),
        ]
    )

    return str(log_file)


def save_results(results: Dict[str, Any], log_dir: str) -> str:
    """Save results to JSON file."""
    log_path = Path(log_dir)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    results_file = log_path / f"redis_stress_{timestamp}_results.json"

    with open(results_file, "w") as f:
        json.dump(results, f, indent=2, default=str)

    return str(results_file)


# ============================================================================
# TEST 1: CONNECTION STARVATION (THE MAIN PROD ISSUE)
# ============================================================================

async def test_connection_starvation(config: Config) -> Dict[str, Any]:
    """
    Replicates the exact production issue:

    YOUR PROD SHOWS:
    - blocked_clients: 30 (XREAD BLOCK holding connections)
    - connected_clients: 131 (total across all workers)
    - POOL STATUS max_connections: 15 (per-process pool is TINY)

    THE PROBLEM:
    - SSE clients do XREAD BLOCK 500 (holds connection for 500ms)
    - Each XREAD eats a connection from the pool
    - When pool is exhausted, GET/SET operations timeout waiting for a free connection
    - Your "GET timed out after 2s" is NOT Redis being slow - it's pool starvation!

    This test spawns:
    - N blocking readers (XREAD BLOCK) - more than pool size
    - M GET/SET workers trying to use the same pool
    - Measures how many GET/SET operations timeout

    EXPECTED: GET operations will timeout when readers exhaust the pool.
    """
    logging.info("=" * 70)
    logging.info("TEST 1: CONNECTION STARVATION (MAIN PROD ISSUE)")
    logging.info("=" * 70)
    logging.info("")
    logging.info("Simulating your production scenario:")
    logging.info("  - XREAD BLOCK operations holding connections")
    logging.info("  - GET/SET operations starving for connections")
    logging.info("  - Pool too small to handle both")
    logging.info("")

    # Create pool with SAME settings as prod (small pool, shared for everything)
    pool = BlockingConnectionPool(
        host=config.host,
        port=config.port,
        password=config.password,
        max_connections=config.pool_size,
        timeout=config.pool_timeout,  # How long to wait for free connection
        socket_timeout=config.socket_timeout,
        decode_responses=True,
    )
    redis = Redis(connection_pool=pool)

    # Verify connection
    try:
        await redis.ping()
        logging.info(f"Connected to Redis at {config.host}:{config.port}")
    except Exception as e:
        logging.error(f"Failed to connect to Redis: {e}")
        return {"test": "connection_starvation", "error": str(e)}

    # Metrics
    xread_ops = 0
    xread_blocked = 0
    get_attempts = 0
    get_successes = 0
    get_timeouts = 0
    get_pool_waits = 0  # Failed to get connection from pool
    get_latencies = []
    set_attempts = 0
    set_successes = 0
    set_timeouts = 0
    shutdown = False
    pool_snapshots = []

    async def blocking_reader(reader_id: int, stream_key: str):
        """
        Simulates SSE client doing XREAD BLOCK.
        This is what your prod does - holds a connection for block duration.

        From your CLIENT LIST: flags=b (blocked), cmd=xread
        """
        nonlocal xread_ops, xread_blocked, shutdown
        last_id = "0"

        while not shutdown:
            try:
                xread_ops += 1
                xread_blocked += 1

                # This holds a connection for block_ms duration
                # Just like: XREAD BLOCK 500 STREAMS agent_run:...:stream
                result = await asyncio.wait_for(
                    redis.xread({stream_key: last_id}, block=config.block_ms, count=100),
                    timeout=config.socket_timeout,
                )

                xread_blocked -= 1

                if result:
                    for stream_name, messages in result:
                        if messages:
                            last_id = messages[-1][0]

            except asyncio.TimeoutError:
                xread_blocked -= 1
            except RedisConnectionError as e:
                xread_blocked -= 1
                logging.debug(f"Reader {reader_id}: Connection error - {e}")
                await asyncio.sleep(0.1)
            except Exception as e:
                xread_blocked -= 1
                logging.debug(f"Reader {reader_id}: Error - {e}")
                await asyncio.sleep(0.1)

    async def getset_worker(worker_id: int, key_prefix: str):
        """
        Simulates normal operations that need connections.
        These are your GET/SET that timeout in prod.

        From your logs: [REDIS TIMEOUT] get(...) timed out after 2.0s
        """
        nonlocal get_attempts, get_successes, get_timeouts, get_pool_waits
        nonlocal set_attempts, set_successes, set_timeouts, shutdown

        while not shutdown:
            # GET operation
            get_attempts += 1
            start = time.time()

            try:
                # Uses same pool as XREAD - this is the problem!
                result = await asyncio.wait_for(
                    redis.get(f"{key_prefix}:key:{worker_id}"),
                    timeout=config.op_timeout,  # Your prod uses 2s
                )
                latency = time.time() - start
                get_latencies.append(latency)
                get_successes += 1

                if latency > 0.5:
                    logging.warning(f"Worker {worker_id}: Slow GET - {latency*1000:.0f}ms (pool wait?)")

            except asyncio.TimeoutError:
                get_timeouts += 1
                logging.error(
                    f"Worker {worker_id}: GET TIMEOUT after {config.op_timeout}s - "
                    f"Pool starved! (blocked readers: ~{xread_blocked})"
                )
            except RedisConnectionError as e:
                if "No connection available" in str(e) or "Timeout" in str(e).lower():
                    get_pool_waits += 1
                    logging.error(f"Worker {worker_id}: Pool exhausted - couldn't get connection")
                else:
                    logging.debug(f"Worker {worker_id}: GET error - {e}")

            # SET operation
            set_attempts += 1
            try:
                await asyncio.wait_for(
                    redis.set(f"{key_prefix}:key:{worker_id}", f"value_{time.time()}", ex=60),
                    timeout=config.op_timeout,
                )
                set_successes += 1
            except asyncio.TimeoutError:
                set_timeouts += 1
                logging.error(f"Worker {worker_id}: SET TIMEOUT")
            except Exception as e:
                logging.debug(f"Worker {worker_id}: SET error - {e}")

            await asyncio.sleep(0.05)  # ~20 ops/sec per worker

    async def stream_producer(stream_key: str):
        """Produces messages to keep readers active."""
        nonlocal shutdown
        msg_id = 0
        while not shutdown:
            try:
                await redis.xadd(
                    stream_key,
                    {"data": json.dumps({"msg_id": msg_id, "ts": time.time()})},
                    maxlen=100,
                    approximate=True,
                )
                msg_id += 1
            except Exception as e:
                logging.debug(f"Producer: {e}")
            await asyncio.sleep(0.5)

    async def pool_monitor():
        """Monitor pool status - shows starvation in action."""
        nonlocal shutdown
        while not shutdown:
            in_use = len(getattr(pool, '_in_use_connections', []))
            available = len(getattr(pool, '_available_connections', []))
            max_conns = getattr(pool, 'max_connections', 'unknown')

            snapshot = {
                "ts": time.time(),
                "in_use": in_use,
                "available": available,
                "max": max_conns,
                "blocked_readers": xread_blocked,
            }
            pool_snapshots.append(snapshot)

            # This is what you should see in prod!
            logging.info(
                f"POOL: in_use={in_use}/{max_conns}, available={available}, "
                f"blocked_readers={xread_blocked} | "
                f"GET: {get_successes}/{get_attempts} "
                f"(timeouts: {get_timeouts}, pool_waits: {get_pool_waits})"
            )

            await asyncio.sleep(1)

    # Test configuration
    # More readers than pool size = guaranteed starvation
    num_readers = config.pool_size + 5  # e.g., 20 readers for pool of 15
    num_workers = 5  # GET/SET workers competing for remaining connections
    duration = 15 if config.quick else 30
    stream_key = f"stress_test:starvation:{int(time.time())}"

    logging.info("")
    logging.info(f"Configuration:")
    logging.info(f"  Pool size: {config.pool_size} (same as your prod)")
    logging.info(f"  Blocking readers (XREAD): {num_readers}")
    logging.info(f"  GET/SET workers: {num_workers}")
    logging.info(f"  XREAD block time: {config.block_ms}ms")
    logging.info(f"  GET/SET timeout: {config.op_timeout}s")
    logging.info(f"  Duration: {duration}s")
    logging.info("")
    logging.info("Starting test... watch for GET TIMEOUT messages!")
    logging.info("")

    # Initialize stream
    await redis.xadd(stream_key, {"init": "true"})

    tasks = []

    # Start pool monitor
    tasks.append(asyncio.create_task(pool_monitor()))

    # Start producer
    tasks.append(asyncio.create_task(stream_producer(stream_key)))

    # Start blocking readers - they will eat up connections
    for i in range(num_readers):
        tasks.append(asyncio.create_task(blocking_reader(i, stream_key)))

    # Wait for readers to grab connections
    await asyncio.sleep(1)

    # Start GET/SET workers - they will fight for remaining connections
    for i in range(num_workers):
        tasks.append(asyncio.create_task(getset_worker(i, "starvation_test")))

    # Let it run
    await asyncio.sleep(duration)

    # Shutdown
    shutdown = True
    for task in tasks:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    # Cleanup
    try:
        await redis.delete(stream_key)
        keys = await redis.keys("starvation_test:*")
        if keys:
            await redis.delete(*keys)
    except Exception:
        pass

    await redis.close()
    await pool.disconnect()

    # Calculate results
    timeout_rate = get_timeouts / max(1, get_attempts)
    avg_latency = (sum(get_latencies) / max(1, len(get_latencies))) * 1000 if get_latencies else 0
    max_latency = max(get_latencies) * 1000 if get_latencies else 0
    p95_latency = sorted(get_latencies)[int(len(get_latencies) * 0.95)] * 1000 if len(get_latencies) > 10 else 0

    results = {
        "test": "connection_starvation",
        "description": "XREAD BLOCK operations starving GET/SET operations",
        "config": {
            "pool_size": config.pool_size,
            "blocking_readers": num_readers,
            "getset_workers": num_workers,
            "block_ms": config.block_ms,
            "op_timeout_s": config.op_timeout,
            "duration_s": duration,
        },
        "xread": {
            "total_ops": xread_ops,
        },
        "get": {
            "attempts": get_attempts,
            "successes": get_successes,
            "timeouts": get_timeouts,
            "pool_wait_failures": get_pool_waits,
            "timeout_rate": timeout_rate,
            "avg_latency_ms": avg_latency,
            "p95_latency_ms": p95_latency,
            "max_latency_ms": max_latency,
        },
        "set": {
            "attempts": set_attempts,
            "successes": set_successes,
            "timeouts": set_timeouts,
        },
        "pool_snapshots": pool_snapshots[-10:],  # Last 10
    }

    # Conclusion
    if get_timeouts > 0 or get_pool_waits > 0:
        results["conclusion"] = (
            f"CONNECTION STARVATION REPLICATED! "
            f"GET timeouts: {get_timeouts} ({timeout_rate*100:.1f}%), "
            f"Pool wait failures: {get_pool_waits}. "
            f"This matches your prod issue!"
        )
        results["issue_confirmed"] = True
    else:
        results["conclusion"] = (
            "No starvation observed. Try: smaller --pool-size or more readers"
        )
        results["issue_confirmed"] = False

    logging.info("")
    logging.info("=" * 70)
    logging.info("TEST COMPLETE")
    logging.info("=" * 70)
    logging.info(f"Result: {results['conclusion']}")

    return results


# ============================================================================
# TEST 2: MIXED WORKLOAD (REALISTIC PROD TRAFFIC)
# ============================================================================

async def test_mixed_workload(config: Config) -> Dict[str, Any]:
    """
    Simulates realistic production traffic:

    YOUR PROD HAS:
    - Multiple agent runs, each with their own stream
    - SSE clients reading from streams (XREAD BLOCK)
    - Stop signal checks (fast GET operations - should be 2s max)
    - Cache operations (GET/SET)
    - Stream writes (XADD)

    ALL SHARING THE SAME POOL!

    This test shows how different operation types compete for connections.
    """
    logging.info("=" * 70)
    logging.info("TEST 2: MIXED WORKLOAD (REALISTIC PROD TRAFFIC)")
    logging.info("=" * 70)
    logging.info("")
    logging.info("Simulating realistic production traffic:")
    logging.info("  - Multiple agent runs with streams")
    logging.info("  - SSE clients (XREAD BLOCK)")
    logging.info("  - Stop signal checks (fast GET)")
    logging.info("  - Cache operations (GET/SET)")
    logging.info("  - All sharing ONE pool!")
    logging.info("")

    pool = BlockingConnectionPool(
        host=config.host,
        port=config.port,
        password=config.password,
        max_connections=config.pool_size,
        timeout=config.pool_timeout,
        socket_timeout=config.socket_timeout,
        decode_responses=True,
    )
    redis = Redis(connection_pool=pool)

    try:
        await redis.ping()
    except Exception as e:
        return {"test": "mixed_workload", "error": str(e)}

    # Metrics per operation type
    metrics = {
        "xread": {"attempts": 0, "successes": 0, "timeouts": 0, "latencies": []},
        "xadd": {"attempts": 0, "successes": 0, "timeouts": 0, "latencies": []},
        "get_cache": {"attempts": 0, "successes": 0, "timeouts": 0, "latencies": []},
        "get_stop_signal": {"attempts": 0, "successes": 0, "timeouts": 0, "latencies": []},
        "set": {"attempts": 0, "successes": 0, "timeouts": 0, "latencies": []},
    }
    shutdown = False

    async def sse_client(run_id: str, client_id: int):
        """SSE client doing XREAD BLOCK - like your streaming endpoint."""
        nonlocal shutdown
        stream_key = f"agent_run:{run_id}:stream"
        last_id = "0"

        while not shutdown:
            metrics["xread"]["attempts"] += 1
            start = time.time()
            try:
                result = await asyncio.wait_for(
                    redis.xread({stream_key: last_id}, block=config.block_ms, count=100),
                    timeout=config.socket_timeout,
                )
                latency = time.time() - start
                metrics["xread"]["successes"] += 1
                metrics["xread"]["latencies"].append(latency)

                if result:
                    for _, msgs in result:
                        if msgs:
                            last_id = msgs[-1][0]
            except asyncio.TimeoutError:
                metrics["xread"]["timeouts"] += 1
            except Exception:
                await asyncio.sleep(0.1)

    async def agent_runner(run_id: str):
        """Agent runner doing XADD - writes to stream."""
        nonlocal shutdown
        stream_key = f"agent_run:{run_id}:stream"

        # Initialize stream
        await redis.xadd(stream_key, {"init": "true"}, maxlen=200, approximate=True)

        iteration = 0
        while not shutdown:
            metrics["xadd"]["attempts"] += 1
            start = time.time()
            try:
                await asyncio.wait_for(
                    redis.xadd(
                        stream_key,
                        {"data": json.dumps({"iteration": iteration, "ts": time.time()})},
                        maxlen=200,
                        approximate=True,
                    ),
                    timeout=config.op_timeout,
                )
                latency = time.time() - start
                metrics["xadd"]["successes"] += 1
                metrics["xadd"]["latencies"].append(latency)
                iteration += 1
            except asyncio.TimeoutError:
                metrics["xadd"]["timeouts"] += 1
                logging.warning(f"Agent {run_id}: XADD timeout!")
            except Exception:
                pass

            await asyncio.sleep(0.1)  # ~10 writes/sec

    async def stop_signal_checker(run_id: str):
        """
        Checks stop signal - this is a FAST operation that should never timeout!

        From your code: await self.get(key, timeout=2.0)
        If this times out, graceful shutdown is broken.
        """
        nonlocal shutdown
        key = f"agent_run:{run_id}:stop"
        check_interval = 2.0  # Your AGENT_STOP_CHECK_INTERVAL

        while not shutdown:
            metrics["get_stop_signal"]["attempts"] += 1
            start = time.time()
            try:
                await asyncio.wait_for(
                    redis.get(key),
                    timeout=2.0,  # Fast timeout - same as prod
                )
                latency = time.time() - start
                metrics["get_stop_signal"]["successes"] += 1
                metrics["get_stop_signal"]["latencies"].append(latency)
            except asyncio.TimeoutError:
                metrics["get_stop_signal"]["timeouts"] += 1
                logging.error(
                    f"STOP SIGNAL CHECK TIMEOUT for {run_id} - "
                    f"Graceful shutdown would FAIL!"
                )
            except Exception:
                pass

            await asyncio.sleep(check_interval)

    async def cache_worker(worker_id: int):
        """Generic cache GET/SET operations."""
        nonlocal shutdown

        while not shutdown:
            key = f"cache:test:{worker_id}:{random.randint(1, 100)}"

            # GET
            metrics["get_cache"]["attempts"] += 1
            start = time.time()
            try:
                await asyncio.wait_for(
                    redis.get(key),
                    timeout=config.op_timeout,
                )
                latency = time.time() - start
                metrics["get_cache"]["successes"] += 1
                metrics["get_cache"]["latencies"].append(latency)
            except asyncio.TimeoutError:
                metrics["get_cache"]["timeouts"] += 1
                logging.warning(f"Cache GET timeout - worker {worker_id}")
            except Exception:
                pass

            # SET
            metrics["set"]["attempts"] += 1
            start = time.time()
            try:
                await asyncio.wait_for(
                    redis.set(key, f"value_{time.time()}", ex=60),
                    timeout=config.op_timeout,
                )
                latency = time.time() - start
                metrics["set"]["successes"] += 1
                metrics["set"]["latencies"].append(latency)
            except asyncio.TimeoutError:
                metrics["set"]["timeouts"] += 1
            except Exception:
                pass

            await asyncio.sleep(0.05)

    async def pool_monitor():
        nonlocal shutdown
        while not shutdown:
            in_use = len(getattr(pool, '_in_use_connections', []))
            available = len(getattr(pool, '_available_connections', []))
            logging.info(
                f"POOL: in_use={in_use}, available={available} | "
                f"XREAD: {metrics['xread']['attempts']} | "
                f"STOP_CHECK: {metrics['get_stop_signal']['attempts']} "
                f"(timeouts: {metrics['get_stop_signal']['timeouts']}) | "
                f"CACHE_GET: {metrics['get_cache']['attempts']} "
                f"(timeouts: {metrics['get_cache']['timeouts']})"
            )
            await asyncio.sleep(1)

    # Test configuration
    num_runs = 3 if config.quick else 5
    clients_per_run = 3 if config.quick else 4
    num_cache_workers = 5
    duration = 15 if config.quick else 30

    total_xread_clients = num_runs * clients_per_run

    logging.info(f"Configuration:")
    logging.info(f"  Agent runs: {num_runs}")
    logging.info(f"  SSE clients per run: {clients_per_run}")
    logging.info(f"  Total XREAD clients: {total_xread_clients}")
    logging.info(f"  Cache workers: {num_cache_workers}")
    logging.info(f"  Pool size: {config.pool_size}")
    logging.info(f"  Duration: {duration}s")
    logging.info("")

    tasks = [asyncio.create_task(pool_monitor())]

    # For each agent run
    for i in range(num_runs):
        run_id = f"mixed_test_{i}_{int(time.time())}"

        # Agent runner (XADD)
        tasks.append(asyncio.create_task(agent_runner(run_id)))

        # Stop signal checker (fast GET)
        tasks.append(asyncio.create_task(stop_signal_checker(run_id)))

        # SSE clients (XREAD BLOCK)
        for j in range(clients_per_run):
            tasks.append(asyncio.create_task(sse_client(run_id, j)))

    # Cache workers
    for i in range(num_cache_workers):
        tasks.append(asyncio.create_task(cache_worker(i)))

    await asyncio.sleep(duration)

    shutdown = True
    for task in tasks:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    # Cleanup
    try:
        keys = await redis.keys("agent_run:mixed_test_*")
        if keys:
            await redis.delete(*keys)
        keys = await redis.keys("cache:test:*")
        if keys:
            await redis.delete(*keys)
    except Exception:
        pass

    await redis.close()
    await pool.disconnect()

    # Format results
    def format_metrics(m):
        lats = m.get("latencies", [])
        return {
            "attempts": m["attempts"],
            "successes": m["successes"],
            "timeouts": m["timeouts"],
            "timeout_rate": m["timeouts"] / max(1, m["attempts"]),
            "avg_latency_ms": (sum(lats) / max(1, len(lats))) * 1000 if lats else 0,
            "max_latency_ms": max(lats) * 1000 if lats else 0,
        }

    results = {
        "test": "mixed_workload",
        "description": "Realistic production traffic - all ops sharing one pool",
        "config": {
            "agent_runs": num_runs,
            "sse_clients_per_run": clients_per_run,
            "total_xread_clients": total_xread_clients,
            "cache_workers": num_cache_workers,
            "pool_size": config.pool_size,
        },
        "operations": {
            "xread": format_metrics(metrics["xread"]),
            "xadd": format_metrics(metrics["xadd"]),
            "get_cache": format_metrics(metrics["get_cache"]),
            "get_stop_signal": format_metrics(metrics["get_stop_signal"]),
            "set": format_metrics(metrics["set"]),
        },
    }

    # Conclusion
    issues = []
    if metrics["get_stop_signal"]["timeouts"] > 0:
        issues.append(
            f"STOP_CHECK timeouts: {metrics['get_stop_signal']['timeouts']} "
            f"(graceful shutdown BROKEN!)"
        )
    if metrics["get_cache"]["timeouts"] > 0:
        issues.append(f"Cache GET timeouts: {metrics['get_cache']['timeouts']}")
    if metrics["xadd"]["timeouts"] > 0:
        issues.append(f"XADD timeouts: {metrics['xadd']['timeouts']}")

    if issues:
        results["conclusion"] = "MIXED WORKLOAD ISSUES: " + "; ".join(issues)
        results["issues_found"] = True
    else:
        results["conclusion"] = "Mixed workload handled OK - no timeouts observed"
        results["issues_found"] = False

    logging.info("")
    logging.info("=" * 70)
    logging.info("TEST COMPLETE")
    logging.info("=" * 70)
    logging.info(f"Result: {results['conclusion']}")

    return results


# ============================================================================
# TEST 3: POOL EXHAUSTION (BURST TRAFFIC)
# ============================================================================

async def test_pool_exhaustion(config: Config) -> Dict[str, Any]:
    """
    Tests pool behavior under burst traffic.

    Sends simultaneous requests that exceed pool capacity.
    Shows what happens when pool.timeout is too short or too long.
    """
    logging.info("=" * 70)
    logging.info("TEST 3: POOL EXHAUSTION (BURST TRAFFIC)")
    logging.info("=" * 70)
    logging.info("")
    logging.info("Sending burst traffic that exceeds pool capacity")
    logging.info("Shows pool wait timeout behavior")
    logging.info("")

    pool = BlockingConnectionPool(
        host=config.host,
        port=config.port,
        password=config.password,
        max_connections=config.pool_size,
        timeout=config.pool_timeout,
        socket_timeout=config.socket_timeout,
        decode_responses=True,
    )
    redis = Redis(connection_pool=pool)

    try:
        await redis.ping()
    except Exception as e:
        return {"test": "pool_exhaustion", "error": str(e)}

    total_requests = 0
    total_successes = 0
    total_pool_timeouts = 0
    total_op_timeouts = 0
    latencies = []
    burst_results = []

    async def single_request(req_id: int) -> tuple:
        """Single request - returns (success, latency, was_pool_timeout)."""
        nonlocal total_requests, total_successes, total_pool_timeouts, total_op_timeouts
        total_requests += 1
        start = time.time()

        try:
            await asyncio.wait_for(
                redis.set(f"burst_test:{req_id}", f"value_{time.time()}", ex=60),
                timeout=config.op_timeout,
            )
            latency = time.time() - start
            total_successes += 1
            latencies.append(latency)
            return (True, latency, False)

        except asyncio.TimeoutError:
            total_op_timeouts += 1
            return (False, time.time() - start, False)

        except RedisConnectionError as e:
            if "No connection available" in str(e) or "Timeout" in str(e).lower():
                total_pool_timeouts += 1
                return (False, time.time() - start, True)
            return (False, time.time() - start, False)

        except Exception:
            return (False, time.time() - start, False)

    # Test configuration
    num_bursts = 5 if config.quick else 10
    burst_size = config.pool_size * 2  # 2x pool size per burst

    logging.info(f"Configuration:")
    logging.info(f"  Bursts: {num_bursts}")
    logging.info(f"  Requests per burst: {burst_size}")
    logging.info(f"  Pool size: {config.pool_size}")
    logging.info(f"  Pool timeout: {config.pool_timeout}s")
    logging.info("")

    for i in range(num_bursts):
        # Fire all requests at once
        tasks = [asyncio.create_task(single_request(i * 1000 + j)) for j in range(burst_size)]
        results = await asyncio.gather(*tasks)

        successes = sum(1 for r in results if r[0])
        pool_timeouts = sum(1 for r in results if r[2])
        avg_latency = sum(r[1] for r in results if r[0]) / max(1, successes) * 1000

        burst_results.append({
            "burst": i + 1,
            "successes": successes,
            "total": burst_size,
            "pool_timeouts": pool_timeouts,
            "avg_latency_ms": avg_latency,
        })

        logging.info(
            f"Burst {i+1}/{num_bursts}: {successes}/{burst_size} succeeded, "
            f"pool_timeouts: {pool_timeouts}, avg_latency: {avg_latency:.1f}ms"
        )

        await asyncio.sleep(0.5)  # Brief pause between bursts

    # Cleanup
    try:
        keys = await redis.keys("burst_test:*")
        if keys:
            await redis.delete(*keys)
    except Exception:
        pass

    await redis.close()
    await pool.disconnect()

    results = {
        "test": "pool_exhaustion",
        "description": "Burst traffic exceeding pool capacity",
        "config": {
            "bursts": num_bursts,
            "burst_size": burst_size,
            "pool_size": config.pool_size,
            "pool_timeout_s": config.pool_timeout,
        },
        "totals": {
            "requests": total_requests,
            "successes": total_successes,
            "pool_timeouts": total_pool_timeouts,
            "op_timeouts": total_op_timeouts,
            "success_rate": total_successes / max(1, total_requests),
        },
        "latency": {
            "avg_ms": (sum(latencies) / max(1, len(latencies))) * 1000 if latencies else 0,
            "max_ms": max(latencies) * 1000 if latencies else 0,
        },
        "bursts": burst_results,
    }

    if total_pool_timeouts > 0:
        results["conclusion"] = (
            f"POOL EXHAUSTION CONFIRMED: {total_pool_timeouts} pool wait timeouts. "
            f"Pool timeout of {config.pool_timeout}s was exceeded."
        )
        results["issue_confirmed"] = True
    else:
        results["conclusion"] = "Pool handled burst traffic OK"
        results["issue_confirmed"] = False

    logging.info("")
    logging.info("=" * 70)
    logging.info("TEST COMPLETE")
    logging.info("=" * 70)
    logging.info(f"Result: {results['conclusion']}")

    return results


# ============================================================================
# TEST 4: SPLIT POOL SOLUTION VERIFICATION
# ============================================================================

async def test_split_pool_solution(config: Config) -> Dict[str, Any]:
    """
    Tests the FIX: separate pools for blocking vs non-blocking ops.

    THE FIX:
    - STREAM_POOL for XREAD/XREADGROUP (blocking ops)
    - GENERAL_POOL for GET/SET/XADD (non-blocking ops)

    This should ELIMINATE the starvation issue.
    """
    logging.info("=" * 70)
    logging.info("TEST 4: SPLIT POOL SOLUTION (THE FIX)")
    logging.info("=" * 70)
    logging.info("")
    logging.info("Testing the fix: separate pools for blocking vs non-blocking ops")
    logging.info("  - STREAM_POOL: for XREAD BLOCK")
    logging.info("  - GENERAL_POOL: for GET/SET/XADD")
    logging.info("")

    # GENERAL POOL - for non-blocking ops (GET/SET/XADD)
    general_pool = BlockingConnectionPool(
        host=config.host,
        port=config.port,
        password=config.password,
        max_connections=config.pool_size,
        timeout=config.pool_timeout,
        socket_timeout=config.socket_timeout,
        decode_responses=True,
    )
    redis_general = Redis(connection_pool=general_pool)

    # STREAM POOL - for blocking ops (XREAD)
    stream_pool = BlockingConnectionPool(
        host=config.host,
        port=config.port,
        password=config.password,
        max_connections=config.pool_size + 10,  # Larger for blocking ops
        timeout=config.pool_timeout,
        socket_timeout=config.socket_timeout,
        decode_responses=True,
    )
    redis_stream = Redis(connection_pool=stream_pool)

    try:
        await redis_general.ping()
        await redis_stream.ping()
    except Exception as e:
        return {"test": "split_pool_solution", "error": str(e)}

    # Metrics
    get_attempts = 0
    get_successes = 0
    get_timeouts = 0
    get_latencies = []
    xread_ops = 0
    shutdown = False

    async def blocking_reader(reader_id: int, stream_key: str):
        """XREAD using STREAM pool - won't affect general pool."""
        nonlocal xread_ops, shutdown
        last_id = "0"

        while not shutdown:
            try:
                xread_ops += 1
                await asyncio.wait_for(
                    redis_stream.xread({stream_key: last_id}, block=config.block_ms, count=100),
                    timeout=config.socket_timeout,
                )
            except Exception:
                await asyncio.sleep(0.1)

    async def getset_worker(worker_id: int):
        """GET/SET using GENERAL pool - isolated from blocking ops."""
        nonlocal get_attempts, get_successes, get_timeouts, get_latencies, shutdown

        while not shutdown:
            get_attempts += 1
            start = time.time()

            try:
                # Uses GENERAL pool - not affected by XREAD blocking!
                await asyncio.wait_for(
                    redis_general.get(f"split_test:key:{worker_id}"),
                    timeout=config.op_timeout,
                )
                latency = time.time() - start
                get_latencies.append(latency)
                get_successes += 1

            except asyncio.TimeoutError:
                get_timeouts += 1
                logging.warning(f"Worker {worker_id}: GET timeout (shouldn't happen with split pools!)")
            except Exception:
                pass

            await asyncio.sleep(0.05)

    async def producer(stream_key: str):
        nonlocal shutdown
        while not shutdown:
            try:
                await redis_general.xadd(stream_key, {"data": str(time.time())}, maxlen=100)
            except Exception:
                pass
            await asyncio.sleep(0.5)

    async def monitor():
        nonlocal shutdown
        while not shutdown:
            general_in_use = len(getattr(general_pool, '_in_use_connections', []))
            stream_in_use = len(getattr(stream_pool, '_in_use_connections', []))
            logging.info(
                f"GENERAL_POOL: in_use={general_in_use}/{config.pool_size} | "
                f"STREAM_POOL: in_use={stream_in_use}/{config.pool_size+10} | "
                f"GET: {get_successes}/{get_attempts} (timeouts: {get_timeouts})"
            )
            await asyncio.sleep(1)

    # Same test config as starvation test
    num_readers = config.pool_size + 5
    num_workers = 5
    duration = 15 if config.quick else 30
    stream_key = f"stress_test:split:{int(time.time())}"

    logging.info(f"Configuration (same as starvation test):")
    logging.info(f"  Blocking readers: {num_readers}")
    logging.info(f"  GET/SET workers: {num_workers}")
    logging.info(f"  General pool size: {config.pool_size}")
    logging.info(f"  Stream pool size: {config.pool_size + 10}")
    logging.info("")

    await redis_general.xadd(stream_key, {"init": "true"})

    tasks = [
        asyncio.create_task(monitor()),
        asyncio.create_task(producer(stream_key)),
    ]

    for i in range(num_readers):
        tasks.append(asyncio.create_task(blocking_reader(i, stream_key)))

    await asyncio.sleep(1)

    for i in range(num_workers):
        tasks.append(asyncio.create_task(getset_worker(i)))

    await asyncio.sleep(duration)

    shutdown = True
    for task in tasks:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    # Cleanup
    try:
        await redis_general.delete(stream_key)
        keys = await redis_general.keys("split_test:*")
        if keys:
            await redis_general.delete(*keys)
    except Exception:
        pass

    await redis_general.close()
    await redis_stream.close()
    await general_pool.disconnect()
    await stream_pool.disconnect()

    timeout_rate = get_timeouts / max(1, get_attempts)
    avg_latency = (sum(get_latencies) / max(1, len(get_latencies))) * 1000 if get_latencies else 0

    results = {
        "test": "split_pool_solution",
        "description": "Testing fix: separate pools for blocking vs non-blocking ops",
        "config": {
            "blocking_readers": num_readers,
            "getset_workers": num_workers,
            "general_pool_size": config.pool_size,
            "stream_pool_size": config.pool_size + 10,
        },
        "get": {
            "attempts": get_attempts,
            "successes": get_successes,
            "timeouts": get_timeouts,
            "timeout_rate": timeout_rate,
            "avg_latency_ms": avg_latency,
        },
        "xread_ops": xread_ops,
    }

    if get_timeouts == 0:
        results["conclusion"] = (
            f"SPLIT POOL FIX WORKS! "
            f"0 GET timeouts with {num_readers} blocking readers. "
            f"Avg latency: {avg_latency:.1f}ms"
        )
        results["fix_verified"] = True
    else:
        results["conclusion"] = (
            f"Unexpected: {get_timeouts} GET timeouts even with split pools"
        )
        results["fix_verified"] = False

    logging.info("")
    logging.info("=" * 70)
    logging.info("TEST COMPLETE")
    logging.info("=" * 70)
    logging.info(f"Result: {results['conclusion']}")

    return results


# ============================================================================
# MAIN
# ============================================================================

async def main(args):
    config = Config(
        host=args.host,
        port=args.port,
        password=args.password,
        pool_size=args.pool_size,
        pool_timeout=args.pool_timeout,
        op_timeout=args.op_timeout,
        quick=args.quick,
    )

    log_file = setup_logging(args.log_dir)

    logging.info("=" * 70)
    logging.info("REDIS STRESS TEST SUITE")
    logging.info("=" * 70)
    logging.info("")
    logging.info("Replicating production Redis issues:")
    logging.info("  1. Connection starvation from XREAD BLOCK")
    logging.info("  2. Pool exhaustion (single pool for all ops)")
    logging.info("  3. Testing the fix: split pools")
    logging.info("")
    logging.info(f"Redis: {config.host}:{config.port}")
    logging.info(f"Pool size: {config.pool_size}")
    logging.info(f"Pool timeout: {config.pool_timeout}s")
    logging.info(f"Op timeout: {config.op_timeout}s")
    logging.info(f"Mode: {'quick' if config.quick else 'normal'}")
    logging.info(f"Log file: {log_file}")
    logging.info("=" * 70)

    all_results = {
        "timestamp": datetime.now().isoformat(),
        "config": {
            "host": config.host,
            "port": config.port,
            "pool_size": config.pool_size,
            "pool_timeout": config.pool_timeout,
            "op_timeout": config.op_timeout,
            "mode": "quick" if config.quick else "normal",
        },
        "tests": [],
    }

    tests = {
        "starvation": test_connection_starvation,
        "mixed": test_mixed_workload,
        "pool": test_pool_exhaustion,
        "split": test_split_pool_solution,
    }

    if args.test == "all":
        tests_to_run = ["starvation", "mixed", "pool", "split"]
    else:
        tests_to_run = [args.test]

    for test_name in tests_to_run:
        logging.info(f"\n{'='*70}\nRunning: {test_name}\n{'='*70}")
        try:
            result = await tests[test_name](config)
            all_results["tests"].append(result)
        except Exception as e:
            logging.error(f"Test {test_name} failed with exception: {e}")
            import traceback
            traceback.print_exc()
            all_results["tests"].append({"test": test_name, "error": str(e)})

    # Save results
    results_file = save_results(all_results, args.log_dir)

    logging.info("")
    logging.info("=" * 70)
    logging.info("ALL TESTS COMPLETE")
    logging.info("=" * 70)
    logging.info(f"Log file: {log_file}")
    logging.info(f"Results file: {results_file}")
    logging.info("")
    logging.info("SUMMARY:")
    for test in all_results["tests"]:
        test_name = test.get("test", "unknown")
        conclusion = test.get("conclusion", test.get("error", "N/A"))
        status = "ISSUE FOUND" if test.get("issue_confirmed") or test.get("issues_found") else "OK"
        if test.get("fix_verified"):
            status = "FIX VERIFIED"
        logging.info(f"  [{status}] {test_name}")
        logging.info(f"      {conclusion}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Redis Stress Tests - Replicate Production Issues",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Run all tests
  uv run python tests/redis_stress/stress_test.py

  # Quick mode
  uv run python tests/redis_stress/stress_test.py --quick

  # Specific test
  uv run python tests/redis_stress/stress_test.py --test starvation

  # Custom pool size (smaller = faster starvation)
  uv run python tests/redis_stress/stress_test.py --pool-size 10

Tests:
  starvation  XREAD BLOCK starving GET/SET (main prod issue)
  mixed       Realistic production traffic simulation
  pool        Burst traffic pool exhaustion
  split       Verify split pool fix works
        """
    )

    parser.add_argument("--host", default="localhost", help="Redis host")
    parser.add_argument("--port", type=int, default=6379, help="Redis port")
    parser.add_argument("--password", default=None, help="Redis password")
    parser.add_argument("--pool-size", type=int, default=15, help="Pool size (default: 15, same as prod)")
    parser.add_argument("--pool-timeout", type=float, default=0.2, help="Pool wait timeout (secs)")
    parser.add_argument("--op-timeout", type=float, default=2.0, help="Operation timeout (secs, same as prod)")
    parser.add_argument("--test", choices=["all", "starvation", "mixed", "pool", "split"], default="all")
    parser.add_argument("--quick", action="store_true", help="Quick mode - shorter durations")
    parser.add_argument("--log-dir", default="tests/redis_stress/logs", help="Log directory")

    args = parser.parse_args()
    asyncio.run(main(args))
