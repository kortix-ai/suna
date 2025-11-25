# Redis Connection Pool Sizing - Rationale

## The Real Problem

**It's not about pool size - it's about concurrency limiting.**

The "Too many connections" error happens when:
- Thousands of concurrent operations try to get connections simultaneously
- Pool gets exhausted before operations complete
- Operations queue up waiting for connections

## The Solution

**Semaphore-based concurrency limiting** prevents this:
- Limits concurrent operations to a manageable number (e.g., 100)
- Pool size only needs to match: `semaphore_limit + overhead`
- No need for huge pools (200+ connections)

## Pool Sizing Formula

```
Pool Size = Max Concurrent Operations + Overhead

Where:
- Max Concurrent Operations = Semaphore limit (e.g., 100)
- Overhead = PubSub connections + safety margin (~20)
```

## Recommended Sizes

### API Process (`redis.py`)
- **Concurrent ops**: < 20 (light usage: caching, occasional pubsub)
- **Pool size**: 50 connections
- **Rationale**: Light usage, small pool is sufficient

### Worker Process (`redis_worker.py`)
- **Concurrent ops**: Limited to 100 (via semaphore)
- **Pool size**: 120 connections (100 + 20 overhead)
- **Rationale**: Matches semaphore limit + overhead for pubsub

## Why Not 200 Connections?

**Unnecessary!** With semaphore limiting to 100 concurrent operations:
- Maximum connections needed = 100 (active ops) + ~20 (overhead)
- 200 connections would just sit idle
- Wastes resources and doesn't solve the problem

## The Key Insight

**Pool size doesn't prevent exhaustion - concurrency limiting does.**

- ❌ **Wrong**: Increase pool to 200+ connections
- ✅ **Right**: Limit concurrent operations to 100, pool size = 100 + overhead

## Configuration

```bash
# Worker: Semaphore limit (this is what matters!)
REDIS_WORKER_MAX_CONCURRENT_OPS=100

# Worker: Pool size (auto-calculated as semaphore + 20)
REDIS_WORKER_MAX_CONNECTIONS=120  # Optional override

# API: Smaller pool for light usage
REDIS_MAX_CONNECTIONS=50
```

## Summary

- **API**: 50 connections (light usage)
- **Worker**: 120 connections (matches 100 concurrent ops + overhead)
- **Key**: Semaphore limits concurrency, pool size just needs to match that limit

