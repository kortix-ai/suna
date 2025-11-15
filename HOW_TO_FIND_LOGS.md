# Where to Find Logs

## Log Output Locations

### 1. **Console/Terminal (Most Common)**
If you're running the backend locally, logs appear in **the terminal where you started the backend server**.

**Look for:**
- The terminal/console where you ran `uvicorn api:app` or similar
- Logs are colored and formatted for easy reading (LOCAL/STAGING mode)

### 2. **Docker Logs**
If running in Docker, use:

```bash
# View logs from the API container
docker-compose logs -f api

# Or if using docker directly
docker logs -f <container_name>

# View only recent logs
docker-compose logs --tail=100 api
```

### 3. **Log Files (if configured)**
Check if log files exist:
```bash
# Check for log directories
ls -la backend/logs/
ls -la backend/worker-logs/
```

## What to Look For

### Key Log Messages for Bedrock Debugging:

1. **Message Validation:**
   ```
   🔍 NATIVE TOOL CALLING: Validating and filtering X messages for Bedrock compatibility
   ```

2. **Tool Call Detection:**
   ```
   🔍 NATIVE TOOL CALLING: Found assistant message at index X with Y tool_calls
   🔍 NATIVE TOOL CALLING: Expecting Y tool results with IDs: [...]
   ```

3. **Tool Result Matching:**
   ```
   ✅ NATIVE TOOL CALLING: Tool result at index X matches tool_call_id Y
   ⚠️ NATIVE TOOL CALLING: Tool result at index X ... FILTERING OUT
   ```

4. **Final Summary:**
   ```
   📊 NATIVE TOOL CALLING: Summary - X assistant msgs, Y tool_calls, Z tool results
   ⚠️ NATIVE TOOL CALLING: MISMATCH! tool_calls=X but tool_results=Y
   ```

5. **Bedrock Debug (Detailed):**
   ```
   🔍 BEDROCK DEBUG: Full prepared_messages structure (first 3 messages)
   ```

6. **Message Breakdown:**
   ```
   🔍 NATIVE TOOL CALLING: Final message breakdown before sending to LLM
   ```

## How to Filter Logs

### In Terminal:
```bash
# If running locally, logs appear directly in terminal
# Use grep to filter:
python backend/api.py | grep "NATIVE TOOL CALLING"
python backend/api.py | grep "BEDROCK DEBUG"
```

### In Docker:
```bash
# Filter Docker logs
docker-compose logs -f api | grep "NATIVE TOOL CALLING"
docker-compose logs -f api | grep "BEDROCK DEBUG"
docker-compose logs -f api | grep "MISMATCH"
```

### Save Logs to File:
```bash
# Save all logs
docker-compose logs api > bedrock_debug.log

# Save filtered logs
docker-compose logs api | grep -E "(NATIVE TOOL CALLING|BEDROCK DEBUG|MISMATCH)" > filtered_logs.log
```

## Log Levels

The logger uses **DEBUG** level by default, so you should see all the detailed logs.

If you don't see logs, check:
1. **Environment variable:** `LOGGING_LEVEL=DEBUG` (should be set)
2. **ENV_MODE:** Should be `LOCAL` or `STAGING` for colored console output

## Quick Test

To verify logs are working, trigger a tool call and look for:
1. `🔍 NATIVE TOOL CALLING: Validating...` - Shows filtering is running
2. `📊 NATIVE TOOL CALLING: Summary...` - Shows final counts
3. `🔍 BEDROCK DEBUG: Full prepared_messages...` - Shows exact structure (if Bedrock model)

## Example Log Output

You should see something like:
```
[2025-11-06 18:08:50] [INFO] 🔍 NATIVE TOOL CALLING: Validating and filtering 6 messages for Bedrock compatibility
[2025-11-06 18:08:50] [INFO] 🔍 NATIVE TOOL CALLING: Found assistant message at index 1 with 3 tool_calls: ['web_search', 'web_search', 'web_search']
[2025-11-06 18:08:50] [INFO] 🔍 NATIVE TOOL CALLING: Expecting 3 tool results with IDs: ['call_123', 'call_456', 'call_789']
[2025-11-06 18:08:50] [INFO] ✅ NATIVE TOOL CALLING: Tool result at index 2 matches tool_call_id call_123
[2025-11-06 18:08:50] [INFO] 📊 NATIVE TOOL CALLING: Summary - 2 assistant msgs, 3 tool_calls, 3 tool results
[2025-11-06 18:08:50] [INFO] 🔍 BEDROCK DEBUG: Full prepared_messages structure (first 3 messages)
```

