# 🧪 Test Harness - Ready to Test!

## ✅ Changes Made

1. **Emergency Stop Endpoint** - Added `/v1/admin/test-harness/emergency-stop` to cancel ALL active tests
2. **Mock LLM Integration** - Stress tests now use `model_name="mock-ai"` which routes through real API but uses mocked LLM responses (fast, no costs)
3. **Comprehensive Test Script** - Tests both stress mode and core mode with validation

## 🚀 How to Run Tests

### Step 1: Restart Backend API

**IMPORTANT:** You must restart the backend API to pick up the code changes!

```bash
# Stop your current backend API process (Ctrl+C or kill the process)
# Then restart it:
cd /Users/vukasinkubet/dev/suna/backend
# Use whatever command you normally use to start the API
# e.g., python api.py or uvicorn api:app, etc.
```

### Step 2: Run Comprehensive Tests

```bash
cd /Users/vukasinkubet/dev/suna/backend
export KORTIX_ADMIN_API_KEY="test_admin_key_for_local_testing_12345"
./test_harness_comprehensive.sh
```

This will run 3 tests:
- ✅ **Stress Mode** (10 executions with mock-ai - fast, no LLM costs)
- ✅ **Core Mode** (3 real prompts with kortix/basic - real LLM)
- ✅ **Emergency Stop** (start test then cancel it)

## 🎯 What Each Test Does

### Stress Test (mock-ai)
- Calls real `/agent/start` endpoint
- Uses `model_name="mock-ai"` 
- When agent tries to call LLM → intercepted by our mock provider
- Fast responses (~50-100ms per prompt)
- No LLM API costs!

### Core Test (real)
- Calls real `/agent/start` endpoint
- Uses real `kortix/basic` model (Claude Haiku 4.5)
- Real tool calls and streaming
- Full metrics tracking
- Validates actual system behavior

### Emergency Stop
- Starts a long-running test
- Triggers emergency stop
- Validates cancellation works

## 📊 Expected Output

```
✅ ALL TESTS COMPLETED SUCCESSFULLY!

📋 Summary:
  • Stress Mode (mock-ai): ✅ 10/10 executions
  • Core Mode (real LLM):  ✅ 3/3 prompts
  • Emergency Stop:        ✅ Working

🎉 Test harness is fully functional!
```

## 🆘 Emergency Stop API

If you need to stop all tests in emergency:

```bash
curl -X POST http://localhost:8000/v1/admin/test-harness/emergency-stop \
  -H "X-Admin-Api-Key: test_admin_key_for_local_testing_12345"
```

## 📝 Quick Manual Tests

### Test Stress Mode Only:
```bash
curl -X POST http://localhost:8000/v1/admin/test-harness/run \
  -H "X-Admin-Api-Key: test_admin_key_for_local_testing_12345" \
  -H "Content-Type: application/json" \
  -d '{
    "mode": "stress_test",
    "prompt_ids": ["shell_1", "file_ops_1"],
    "concurrency": 10,
    "num_executions": 50
  }'
```

### Test Core Mode Only:
```bash
curl -X POST http://localhost:8000/v1/admin/test-harness/run \
  -H "X-Admin-Api-Key: test_admin_key_for_local_testing_12345" \
  -H "Content-Type: application/json" \
  -d '{
    "mode": "core_test",
    "prompt_ids": ["shell_1", "file_ops_1", "multi_tool_1"],
    "concurrency": 2,
    "model": "kortix/basic"
  }'
```

## 🔍 Check Results:

```bash
# List all runs
curl -s http://localhost:8000/v1/admin/test-harness/runs \
  -H "X-Admin-Api-Key: test_admin_key_for_local_testing_12345" | jq '.runs[0:3]'

# Get specific run details
curl -s http://localhost:8000/v1/admin/test-harness/runs/{RUN_ID} \
  -H "X-Admin-Api-Key: test_admin_key_for_local_testing_12345" | jq '.summary'
```

---

**Ready to run?** → Restart API, then run `./test_harness_comprehensive.sh`! 🚀
