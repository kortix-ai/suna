# Redis Connection Management Analysis

## Current Architecture

### 1. **Application Redis Connection Pool** (`core/services/redis.py`)
- **Single shared connection pool** across all workers/threads
- **Max connections**: 128 (configurable via `REDIS_MAX_CONNECTIONS`)
- **Pool type**: `redis.asyncio.ConnectionPool`
- **Client**: Single `redis.Redis` instance shared via `get_client()`
- **Initialization**: Module-level singleton, initialized once per process

### 2. **Dramatiq Broker** (`run_agent_background.py`)
- **Separate connection**: Dramatiq's `RedisBroker` creates its own Redis connections
- **Not shared**: Independent from the application pool
- **Connection management**: Handled internally by Dramatiq

### 3. **Worker Configuration**
- **Processes**: 4 (`--processes 4`)
- **Threads**: 4 (`--threads 4`)
- **Total workers**: 16 concurrent worker threads
- **Each worker**: Can handle multiple agent runs simultaneously

## Current Connection Usage Patterns

### Per Agent Run:
1. **1 PubSub connection** - For listening to control channels
2. **Multiple publish operations** - Each response triggers 2 publishes (rpush + publish)
3. **Cleanup operations** - Multiple Redis operations in finally block

### Connection Leak Sources:

1. **Accumulated `pending_redis_operations`**:
   ```python
   # Each response creates 2 async tasks
   pending_redis_operations.append(asyncio.create_task(redis.rpush(...)))
   pending_redis_operations.append(asyncio.create_task(redis.publish(...)))
   ```
   - With 3776 responses (from logs), that's **7552 concurrent Redis operations**
   - All trying to get connections from the pool simultaneously
   - Can exhaust 128 connection limit quickly

2. **PubSub connections**:
   - Each agent run creates 1 pubsub connection
   - Uses 1 connection from the pool
   - Properly closed in finally block ✅

3. **Dramatiq broker**:
   - Creates its own connections (separate from app pool)
   - Managed internally by Dramatiq ✅

## The Problem

**"Too many connections" error occurs because:**

1. **Concurrent operation explosion**: 
   - 16 workers × multiple agent runs × hundreds of responses = thousands of concurrent Redis operations
   - All operations call `get_client()` which uses the shared pool
   - Pool gets exhausted before operations complete

2. **No concurrency limiting**:
   - All `pending_redis_operations` tasks run concurrently
   - No semaphore or batching mechanism

3. **Connection pool exhaustion**:
   - 128 connections shared across 16 workers
   - Each worker can have multiple agent runs
   - Each agent run can have hundreds of pending operations

## Best Practices & Recommendations

### ✅ What's Already Good:

1. **Single shared connection pool** - Correct approach
2. **Connection pooling** - Using `redis.ConnectionPool` ✅
3. **PubSub cleanup** - Properly closed in finally blocks ✅
4. **Health checks** - `health_check_interval: 30` ✅

### 🔧 What Needs Improvement:

#### 1. **Limit Concurrent Redis Operations**

**Current**: All operations run concurrently
```python
pending_redis_operations.append(asyncio.create_task(redis.rpush(...)))
pending_redis_operations.append(asyncio.create_task(redis.publish(...)))
```

**Recommended**: Use a semaphore to limit concurrency
```python
# In redis.py
_redis_semaphore = asyncio.Semaphore(50)  # Max 50 concurrent operations

async def publish(channel: str, message: str):
    async with _redis_semaphore:
        redis_client = await get_client()
        return await redis_client.publish(channel, message)
```

#### 2. **Batch Operations Instead of Accumulating Tasks**

**Current**: Accumulates thousands of tasks
```python
pending_redis_operations = []
for response in agent_gen:
    pending_redis_operations.append(asyncio.create_task(...))
await asyncio.gather(*pending_redis_operations)
```

**Recommended**: Execute immediately or batch in smaller chunks
```python
# Option A: Execute immediately (simpler)
for response in agent_gen:
    await redis.rpush(...)
    await redis.publish(...)

# Option B: Batch in chunks of 50
batch = []
for response in agent_gen:
    batch.append((rpush_task, publish_task))
    if len(batch) >= 50:
        await asyncio.gather(*[t for pair in batch for t in pair])
        batch = []
if batch:
    await asyncio.gather(*[t for pair in batch for t in pair])
```

#### 3. **Optimize Connection Pool Size**

**Current**: 128 connections for 16 workers = 8 per worker

**Recommended**: 
- **Per-process pool**: Since each process has its own pool
- **Formula**: `(threads × max_concurrent_runs × 2) + overhead`
- **Example**: `(4 threads × 2 runs × 2 ops) + 10 = 26 per process`
- **Total**: `26 × 4 processes = 104 connections`
- **Safe margin**: Keep at 128 or increase to 200

#### 4. **Use Pipeline for Batch Operations**

For multiple operations, use Redis pipeline:
```python
async def batch_publish(channel: str, messages: List[str]):
    redis_client = await get_client()
    async with redis_client.pipeline() as pipe:
        for msg in messages:
            pipe.publish(channel, msg)
        return await pipe.execute()
```

#### 5. **Monitor Connection Usage**

Add connection pool metrics:
```python
async def get_connection_info():
    # ... existing code ...
    if pool:
        pool_info.update({
            "available": len(pool._available_connections),
            "in_use": len(pool._in_use_connections),
            "created": pool.created_connections,
        })
```

## Recommended Implementation

### Priority 1: Add Concurrency Limiting
- Add semaphore to limit concurrent Redis operations
- Prevents connection pool exhaustion

### Priority 2: Batch Operations
- Instead of accumulating thousands of tasks, batch them
- Execute in chunks of 50-100 operations

### Priority 3: Optimize Pool Size
- Calculate based on actual usage patterns
- Monitor and adjust

### Priority 4: Use Pipelines
- For batch operations, use Redis pipelines
- Reduces round-trips and connection usage

## Dramatiq Best Practices

Dramatiq's RedisBroker manages its own connections:
- ✅ Already using connection pooling internally
- ✅ Separate from application pool (correct)
- ✅ No action needed

## Summary

**Current State:**
- ✅ Single shared connection pool (correct)
- ❌ No concurrency limiting (causes exhaustion)
- ❌ Accumulating thousands of concurrent operations
- ✅ Proper PubSub cleanup

**Best Practice:**
- ✅ Single shared connection pool per process
- ✅ Limit concurrent operations with semaphore
- ✅ Batch operations instead of accumulating
- ✅ Monitor connection usage
- ✅ Use pipelines for batch operations

