# Redis Stress Tests

Replicates **PRODUCTION** Redis issues locally. Redis-only - no Supabase or Daytona.

## The Problem (from your prod)

```
blocked_clients: 30           <- XREAD BLOCK holding connections
connected_clients: 131        <- Total across workers
POOL STATUS max_connections: 15   <- Per-process pool is TINY
```

**Result**: GET operations timeout waiting for a free connection. Redis is fine (~0.3ms latency), but your app is **connection-starving itself**.

## Quick Start

```bash
# Make sure Redis is running locally
docker run -d --name redis-test -p 6379:6379 redis:7

# From backend directory
cd backend

# Run all tests (quick mode)
uv run python tests/redis_stress/stress_test.py --quick

# Run all tests (full mode)
uv run python tests/redis_stress/stress_test.py

# Run specific test
uv run python tests/redis_stress/stress_test.py --test starvation
```

## Tests

### 1. Connection Starvation (`--test starvation`)
**THE MAIN PROD ISSUE**

- Spawns N XREAD BLOCK readers (more than pool size)
- Each reader holds a connection for 500ms (like your SSE clients)
- GET/SET operations timeout waiting for connections

```
Expected output:
CONNECTION STARVATION REPLICATED! GET timeouts: 47 (15.3%), Pool wait failures: 12
```

### 2. Mixed Workload (`--test mixed`)
Realistic production traffic:
- Multiple agent runs with streams
- SSE clients (XREAD BLOCK)
- Stop signal checks (fast GET - if these timeout, graceful shutdown breaks!)
- Cache operations (GET/SET)
- All sharing ONE pool

### 3. Pool Exhaustion (`--test pool`)
Burst traffic handling:
- Sends simultaneous requests exceeding pool capacity
- Shows pool wait timeout behavior

### 4. Split Pool Solution (`--test split`)
**VERIFIES THE FIX**

Tests separate pools:
- `STREAM_POOL` for XREAD BLOCK
- `GENERAL_POOL` for GET/SET/XADD

Should show **0 GET timeouts** with same number of blocking readers.

## Options

```bash
uv run python tests/redis_stress/stress_test.py [OPTIONS]

--host          Redis host (default: localhost)
--port          Redis port (default: 6379)
--password      Redis password
--pool-size     Pool size (default: 15, same as prod)
--pool-timeout  Pool wait timeout (default: 0.2s - fail fast)
--op-timeout    Operation timeout (default: 2.0s, same as prod)
--test          starvation | mixed | pool | split | all
--quick         Shorter durations
--log-dir       Log directory (default: tests/redis_stress/logs)
```

## Output

Results saved to `logs/`:
- `redis_stress_TIMESTAMP.log` - Detailed logs
- `redis_stress_TIMESTAMP_results.json` - JSON results

## Interpreting Results

### Starvation Test
```json
{
  "get": {
    "timeouts": 47,
    "timeout_rate": 0.153,
    "pool_wait_failures": 12
  },
  "conclusion": "CONNECTION STARVATION REPLICATED!"
}
```
- `timeouts > 0` = issue replicated
- `pool_wait_failures > 0` = pool exhausted (couldn't even get a connection)

### Mixed Workload
```json
{
  "get_stop_signal": {
    "timeouts": 3
  },
  "conclusion": "STOP_CHECK timeouts: 3 (graceful shutdown BROKEN!)"
}
```
- Stop signal check timeouts = graceful shutdown would fail in prod

### Split Pool Test
```json
{
  "get": {
    "timeouts": 0,
    "avg_latency_ms": 0.8
  },
  "conclusion": "SPLIT POOL FIX WORKS! 0 GET timeouts"
}
```
- `timeouts == 0` with same blocking readers = fix verified

## Trigger Issues Faster

```bash
# Smaller pool = faster starvation
uv run python tests/redis_stress/stress_test.py --pool-size 10

# Shorter pool timeout = more failures
uv run python tests/redis_stress/stress_test.py --pool-timeout 0.1
```

## Docker Redis

```bash
# Start Redis
docker run -d --name redis-stress-test -p 6379:6379 redis:7

# Monitor during test (in another terminal)
docker exec -it redis-stress-test redis-cli INFO clients
docker exec -it redis-stress-test redis-cli CLIENT LIST | grep -c "flags=b"

# Stop Redis
docker stop redis-stress-test && docker rm redis-stress-test
```

## The Fix

Based on test results, implement in your codebase:

```python
# core/services/redis.py
from redis.asyncio import Redis
from redis.asyncio.connection import BlockingConnectionPool

GENERAL_POOL = BlockingConnectionPool(
    host=REDIS_HOST, port=6379, db=0,
    max_connections=200, timeout=0.2,
    health_check_interval=30,
)
STREAM_POOL = BlockingConnectionPool(
    host=REDIS_HOST, port=6379, db=0,
    max_connections=500, timeout=0.2,
    health_check_interval=30,
)

redis = Redis(connection_pool=GENERAL_POOL, decode_responses=True)
redis_stream = Redis(connection_pool=STREAM_POOL, decode_responses=True)
```

Use:
- `redis_stream` for `xread/xreadgroup` only
- `redis` for everything else (get/set/xadd/etc)
