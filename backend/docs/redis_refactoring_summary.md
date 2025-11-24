# Redis Connection Management Refactoring

## Problem Analysis

You correctly identified that the shared connection pool approach was inefficient:

1. **API Process** (`api.py`): Light Redis usage (caching, occasional pubsub)
2. **Worker Process** (`run_agent_background.py`): Heavy Redis usage (thousands of operations per agent run)
3. **Separate Processes**: API and workers run in different processes, so they don't share pools anyway
4. **Connection Exhaustion**: Workers were accumulating thousands of concurrent Redis operations, exhausting the 128-connection pool

## Solution: Separate Redis Modules

### Architecture

```
┌─────────────────┐         ┌──────────────────┐
│   API Process   │         │  Worker Process  │
│                 │         │                  │
│  redis.py       │         │  redis_worker.py │
│  (128 conns)    │         │  (200 conns)     │
│  Light usage    │         │  Heavy usage      │
└─────────────────┘         └──────────────────┘
         │                            │
         └────────────┬───────────────┘
                      │
              ┌───────▼───────┐
              │  Redis Server │
              └───────────────┘
```

### Key Changes

#### 1. **New Module: `redis_worker.py`**
- **Purpose**: Worker-optimized Redis connection management
- **Features**:
  - Higher connection pool (200 vs 128)
  - Concurrency limiting via semaphore (100 concurrent ops)
  - Batch operation support (`batch_rpush`, `batch_publish`)
  - All operations wrapped with semaphore to prevent exhaustion

#### 2. **Updated: `run_agent_background.py`**
- **Changed**: Uses `redis_worker` instead of `redis`
- **Optimized**: Batch operations instead of accumulating thousands of tasks
  - Processes responses in batches of 50
  - Uses `batch_rpush` for efficient bulk operations
  - Reduces concurrent operations from thousands to manageable batches

#### 3. **Unchanged: `redis.py`**
- **Purpose**: API process Redis (light usage)
- **No changes needed**: Still works for API's light Redis usage

## Configuration

### Environment Variables

```bash
# Worker-specific (new)
REDIS_WORKER_MAX_CONNECTIONS=200      # Default: 200
REDIS_WORKER_MAX_CONCURRENT_OPS=100  # Default: 100

# Shared (existing)
REDIS_MAX_CONNECTIONS=128              # For API process
REDIS_HOST=redis
REDIS_PORT=6379
REDIS_PASSWORD=
REDIS_USERNAME=
```

## Benefits

1. **Prevents Connection Exhaustion**
   - Semaphore limits concurrent operations to 100
   - Batch operations reduce total operation count
   - Higher pool size (200) for worker load

2. **Better Resource Management**
   - API process: Smaller pool (128) for light usage
   - Worker process: Larger pool (200) for heavy usage
   - Each process optimized for its workload

3. **Improved Performance**
   - Batch operations use Redis pipelines (fewer round-trips)
   - Concurrency limiting prevents connection pool thrashing
   - Better connection reuse

4. **Maintainability**
   - Clear separation: API vs Worker Redis management
   - Worker-specific optimizations don't affect API
   - Easier to tune each independently

## Migration Notes

- ✅ **No breaking changes**: API still uses `redis.py`
- ✅ **Worker automatically uses**: `redis_worker.py` via import alias
- ✅ **Shared config**: Both use `get_redis_config()` from `redis.py`
- ✅ **Backward compatible**: Existing code continues to work

## Monitoring

Check connection usage:
```python
from core.services import redis_worker
info = await redis_worker.get_connection_info()
# Returns: pool stats, server stats, semaphore info
```

## Best Practices Going Forward

1. **API Process**: Use `from core.services import redis` (light usage)
2. **Worker Process**: Use `from core.services import redis_worker as redis` (heavy usage)
3. **Batch Operations**: Use `batch_rpush`/`batch_publish` for multiple operations
4. **Monitor**: Check `get_connection_info()` regularly
5. **Tune**: Adjust `REDIS_WORKER_MAX_CONNECTIONS` and `REDIS_WORKER_MAX_CONCURRENT_OPS` based on load

