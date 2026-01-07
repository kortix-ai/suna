# E2E Test Harness

Comprehensive API-based E2E testing system for benchmarking the Kortix agent system.

## Features

- **Core Test Mode**: Real LLM calls with full performance metrics
- **Stress Test Mode**: Mocked LLM for high-concurrency validation
- **Detailed Metrics**: Cold start time, tool call performance, streaming metrics
- **Concurrent Execution**: Configurable concurrency levels
- **Database Storage**: All results stored in Supabase for analysis
- **GitHub Actions**: Manual workflow for CI/CD integration

## Quick Start

### 1. Run Database Migration

```bash
cd backend
supabase db push
```

### 2. Start the API

```bash
python api.py
```

**Note**: The test harness automatically creates a test user (`testuser@kortix.ai`) if it doesn't exist. No manual user setup required!

### 3. Run a Test

#### Via API:

```bash
# Core test (real LLM)
curl -X POST http://localhost:8000/v1/admin/test-harness/run \
  -H "X-Admin-Api-Key: $KORTIX_ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "mode": "core_test",
    "concurrency": 3,
    "model": "kortix/basic"
  }'

# Get results
curl http://localhost:8000/v1/admin/test-harness/runs/{run_id} \
  -H "X-Admin-Api-Key: $KORTIX_ADMIN_API_KEY"
```

#### Via GitHub Actions:

1. Go to GitHub Actions tab
2. Select "E2E Benchmark Tests"
3. Click "Run workflow"
4. Choose mode and settings
5. View results in artifacts

## Test Prompts

The test harness includes 13 deterministic test prompts covering:

- **File Operations** (3 prompts): List files, create files, check existence
- **Shell Commands** (3 prompts): Echo, pwd, date commands
- **Web Search** (2 prompts): Search and summarization
- **Multi-Tool Chains** (2 prompts): File creation + execution, search + file
- **Edge Cases** (3 prompts): Short prompts, conversational, long requests

View all prompts:
```bash
curl http://localhost:8000/v1/admin/test-harness/prompts \
  -H "X-Admin-Api-Key: $KORTIX_ADMIN_API_KEY"
```

## API Endpoints

### POST /v1/admin/test-harness/run
Start a new benchmark test

**Request:**
```json
{
  "mode": "core_test",
  "prompt_ids": ["file_ops_1", "shell_1"],
  "concurrency": 5,
  "model": "kortix/basic",
  "num_executions": 100,
  "metadata": {"branch": "main", "commit": "abc123"}
}
```

**Response:**
```json
{
  "run_id": "uuid",
  "status": "running",
  "message": "Test started successfully"
}
```

### GET /v1/admin/test-harness/runs/{run_id}
Get test results and summary

**Response:**
```json
{
  "run_id": "uuid",
  "status": "completed",
  "summary": {
    "total_prompts": 10,
    "successful": 9,
    "failed": 1,
    "avg_duration_ms": 5234,
    "avg_cold_start_ms": 450,
    "avg_tool_call_time_ms": 1200,
    "tool_call_breakdown": {...},
    "slowest_tool_calls": [...]
  },
  "results": [...]
}
```

### GET /v1/admin/test-harness/runs
List recent test runs

**Query Parameters:**
- `limit`: Max results (default: 20)
- `run_type`: Filter by 'core_test' or 'stress_test'

### POST /v1/admin/test-harness/runs/{run_id}/cancel
Cancel an active test run

### POST /v1/admin/test-harness/emergency-stop
🚨 Emergency stop - cancel ALL active test runs

Use this in emergency situations to immediately stop all running tests.

**Response:**
```json
{
  "message": "Emergency stop completed - cancelled 2 test runs",
  "cancelled_count": 2,
  "cancelled_runs": ["run_id_1", "run_id_2"],
  "errors": null
}
```

### GET /v1/admin/test-harness/prompts
List all available test prompts

## Metrics Collected

For each test run:
- **Cold Start Time**: Time from API call to first stream chunk
- **Total Duration**: Complete execution time
- **Tool Call Count**: Number of tool invocations
- **Tool Call Times**: Individual and average tool execution times
- **Stream Metrics**: Chunk count and intervals
- **Tool Breakdown**: Usage by tool name
- **Success Rate**: Percentage of successful completions

## Database Schema

### benchmark_runs
- Stores test run metadata
- Tracks concurrency, model, status
- Contains aggregated timing data

### benchmark_results
- Individual prompt execution results
- Detailed metrics per prompt
- Tool call timing and streaming data

## Architecture

```
GitHub Actions → Admin API → TestHarnessRunner → /agent/start
                                                 ↓
                                           SSE Stream Parser
                                                 ↓
                                           MetricsCollector
                                                 ↓
                                         Supabase Storage
```

## Development

### Adding New Test Prompts

Edit `prompts.py`:

```python
TestPrompt(
    id="my_test_1",
    text="Your test prompt here",
    category="custom",
    expected_tools=["tool_name"],
    min_tool_calls=1,
    max_duration_ms=30000,
    description="What this tests"
)
```

### Customizing Metrics

Extend `BenchmarkResult` in `metrics.py` to track additional metrics.

### Mock LLM for Stress Tests

The `mock_llm.py` module provides deterministic responses. Customize `_determine_tool_calls()` to add new tool patterns.

## Security

- All endpoints require `X-Admin-Api-Key` header
- Uses existing admin authentication system
- No public access to test harness
- Test user (`testuser@kortix.ai`) is automatically created with minimal permissions

## Performance

- Supports up to 100 concurrent requests
- Stress test mode can handle 10,000+ executions
- Configurable timeouts per prompt
- Efficient SSE streaming parsing
- Database-backed result storage

## Troubleshooting

**Test hangs indefinitely:**
- Check if agent/start endpoint is responding
- Verify streaming endpoint connectivity
- Review logs for errors

**High failure rate:**
- Check test account has proper permissions
- Verify model access and credits
- Review individual prompt errors in results

**Timeout errors:**
- Increase `max_duration_ms` for prompts
- Check system load and concurrency
- Review tool execution times

## Future Enhancements

- [ ] Add performance regression detection
- [ ] Generate trend reports over time
- [ ] Add email notifications for failures
- [ ] Create dashboard for visualizing results
- [ ] Support custom test suites
- [ ] Add memory/CPU profiling

