# Scalability Analysis

## Current Architecture: Direct Execution Model

Agent runs execute directly in the API process as async background tasks - no separate worker processes.

## Concurrency Limits

### 1. Per API Instance (Semaphore) - AUTO-DETECTED
```python
# Auto-detects CPU count and memory, sets: min(CPU_COUNT × 10, RAM / 200MB, 2000)
MAX_CONCURRENT_RUNS = int(os.getenv('MAX_CONCURRENT_AGENT_RUNS', str(_calculate_optimal_concurrency())))
```
- **Default**: Auto-detected based on CPU count and available memory
- **32 vCPU, 128GB RAM VPS**: 320 concurrent runs (auto-detected)
- **Maximum possible**: 640 concurrent runs (memory-limited)
- **Configurable**: Set `MAX_CONCURRENT_AGENT_RUNS` env var to override
- **Bottleneck**: Memory (200MB per run), DB connections, LLM rate limits

### 2. Per Account (Tier-Based)
- **Free Tier**: 1 concurrent run
- **Paid Tiers**: Configurable (typically 1-10+ concurrent runs)
- **Enforced**: Database-level checks prevent exceeding limits

### 3. Database Connection Pool - AUTO-SCALED
```python
# Auto-scales based on concurrency: (concurrent_runs * 20 * 1.5) capped at 500
SUPABASE_MAX_CONNECTIONS = int(os.getenv('SUPABASE_MAX_CONNECTIONS', str(_calculate_db_connections())))
SUPABASE_POOL_TIMEOUT = 30.0
```
- **Default**: Auto-detected based on CPU count
- **32 vCPU VPS**: 500 max connections (handles 64 concurrent × 20 DB calls)
- **Designed for**: High concurrency workloads
- **Reality**: Connection pooling handles this efficiently

### 4. Thread Pool Executors - AUTO-SCALED
```python
# Auto-scales with CPU count: max(CPU_COUNT, 16)
_SETUP_TOOLS_EXECUTOR = ThreadPoolExecutor(max_workers=_calculate_thread_pool_size())
```
- **Default**: Auto-detected based on CPU count (min 16, scales with CPU)
- **32 vCPU VPS**: 32 threads
- **Purpose**: Blocking I/O operations (tool setup, file parsing)
- **Separate**: Prevents queue saturation

## Asyncio Scalability

### Theoretical Limits
- **asyncio tasks**: Thousands to tens of thousands per process
- **Real bottleneck**: I/O operations, not asyncio overhead
- **Memory**: ~1-5KB per task (very lightweight)

### Current Usage Pattern
```python
# Each agent run creates:
asyncio.create_task(execute_with_semaphore())
# + internal async operations (DB queries, LLM calls, tool execution)
```

**Per agent run:**
- 1 main task
- ~10-50 async DB queries
- ~5-20 LLM API calls
- ~10-100 tool execution tasks
- **Total**: ~50-200 concurrent async operations per agent run

## Horizontal Scaling

### Current Setup
- **Stateless**: Each API instance is independent
- **Shared state**: Redis (streaming), Database (persistence)
- **Load balancer**: Routes requests across instances

### Scaling Formula
```
Total Concurrent Runs = (Number of API Instances) × MAX_CONCURRENT_RUNS
```

**Example:**
- 5 API instances × 10 concurrent = **50 total concurrent runs**
- 10 API instances × 20 concurrent = **200 total concurrent runs**

### Recommended Limits Per Instance

| Instance Size | MAX_CONCURRENT_RUNS | Reason |
|--------------|---------------------|--------|
| Small (1 CPU, 2GB RAM) | 5-10 | CPU-bound LLM calls |
| Medium (2 CPU, 4GB RAM) | 10-20 | Balanced |
| Large (4 CPU, 8GB RAM) | 20-50 | More CPU/memory |
| XLarge (8+ CPU, 16GB+ RAM) | 50-100 | High-end |

## Bottlenecks & Optimization

### 1. LLM API Calls (Biggest Bottleneck)
- **Synchronous**: Each LLM call blocks until response
- **Rate limits**: Provider-specific (OpenAI, Anthropic, etc.)
- **Solution**: Multiple API keys, request queuing

### 2. Database Connections
- **Current**: 250 max connections
- **Usage**: ~10-20 connections per concurrent agent run
- **Math**: 10 concurrent × 20 connections = 200 connections (safe)

### 3. Memory Usage
- **Per agent run**: ~50-200MB (depends on context size)
- **10 concurrent**: ~500MB-2GB
- **Monitor**: Memory leaks, large context windows

### 4. Redis Streaming
- **Per run**: 1 stream key
- **TTL**: 600 seconds (10 minutes)
- **Capacity**: Thousands of concurrent streams

## Performance Characteristics

### Current Architecture Strengths
✅ **Low latency**: No dispatch overhead (50-100ms saved)
✅ **Simple**: Direct execution, easy to debug
✅ **Scalable**: Horizontal scaling via multiple instances
✅ **Efficient**: asyncio handles thousands of concurrent operations

### Potential Improvements
1. **Increase semaphore**: If CPU/memory allows
2. **Connection pooling**: Already optimized (250 connections)
3. **Caching**: Already implemented (Redis, runtime cache)
4. **Batch operations**: Already implemented (batch searches, parallel queries)

## Real-World Capacity

### Single Instance (32 vCPU, 128GB RAM VPS)
- **1 API instance** × **320 concurrent** = **320 concurrent agent runs** (auto-detected)
- **Maximum**: 640 concurrent runs (memory-limited)
- **Each run**: ~2-5 minutes average
- **Throughput**: ~3,840-7,680 runs/hour (auto-detected)
- **Maximum throughput**: ~7,680-15,360 runs/hour (at 640 concurrent)
- **Set**: `MAX_CONCURRENT_AGENT_RUNS=640` to use maximum

### Multi-Instance Estimate
- **5 API instances** × **64 concurrent** = **320 concurrent agent runs**
- **Each run**: ~2-5 minutes average
- **Throughput**: ~3,840-9,600 runs/hour

### Aggressive Estimate
- **10 API instances** × **128 concurrent** = **1,280 concurrent agent runs**
- **Each run**: ~2-5 minutes average
- **Throughput**: ~15,360-38,400 runs/hour

### Bottleneck Analysis
1. **LLM API rate limits**: Usually the limiting factor
2. **Database**: Well-optimized, not a bottleneck
3. **Redis**: Can handle 10,000+ concurrent streams
4. **asyncio**: Can handle 10,000+ concurrent tasks

## Recommendations

### For Production
1. **Auto-detected**: System automatically detects CPU count and sets optimal defaults
2. **32 vCPU VPS**: Defaults to 64 concurrent runs (can increase to 128+)
3. **Monitor**: CPU, memory, DB connections, LLM rate limits
4. **Scale horizontally**: Add more API instances before increasing per-instance concurrency
5. **Override if needed**: Set `MAX_CONCURRENT_AGENT_RUNS` env var to override auto-detection

### For High Load
1. **Multiple API keys**: Distribute LLM calls across keys
2. **Regional deployment**: Deploy instances closer to users
3. **Caching**: Aggressive caching of agent configs, prompts
4. **Connection pooling**: Already optimized, monitor usage

## Conclusion

**The architecture can scale to:**
- **Hundreds** of concurrent agent runs (with multiple instances)
- **Thousands** of concurrent async operations (asyncio handles this easily)
- **Limited by**: LLM API rate limits, CPU/memory per instance, not asyncio itself

**Current setup is well-optimized for:**
- 50-200 concurrent agent runs (5-10 instances)
- 10,000+ concurrent async operations
- High-throughput, low-latency execution

