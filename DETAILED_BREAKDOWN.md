# Detailed Analysis: Why It's Still Breaking

## The Three Critical Issues

### Issue 1: Detection Function Doesn't Handle Cached Message Format ❌

**Problem:**
- After caching, messages have content as a **list**: `[{"type": "text", "text": "Tool: {...}"}]`
- But `_contains_embedded_tool_result()` only checks for **string** content
- So it returns `False` immediately when it sees a list, never detecting the embedded tool results!

**Evidence from logs:**
```
Message 2: {
  "role": "user",
  "content": [
    {
      "type": "text",
      "text": "Tool: {\"query\": \"{\\\"query\\\"\", ..."
    }
  ]
}
```

**Root Cause:**
```python
# OLD CODE (BROKEN):
content = msg.get('content', '')
if not isinstance(content, str):  # ← FAILS HERE for cached messages!
    return False
```

**Fix Applied:** ✅
- Now extracts text from list format
- Handles both string and list content formats
- Checks the actual text content for tool result patterns

---

### Issue 2: Filtering Happens BEFORE Caching, But Caching Reintroduces Problems ❌

**Problem Flow:**
1. Messages filtered after compression (line 642) ✅
2. **Caching applied** (line 667) - loads cached blocks from database
3. **Cached blocks may contain problematic messages** that were cached before the fix!
4. No filtering after caching → problematic messages get through

**Evidence:**
- Logs show messages [2] and [3] are USER messages with embedded tool results
- These messages passed through because they came from cached blocks
- The filtering happened BEFORE caching, so it never saw these messages

**Root Cause:**
- Caching loads previously stored blocks that may have embedded tool results
- These blocks bypass the post-compression filtering

**Fix Applied:** ✅
- Added filtering **AFTER caching** as well
- Filters cached blocks to remove embedded tool results
- Ensures clean messages even when loading from cache

---

### Issue 3: Tool Parameters Are Malformed - "query" Instead of "larry ellison" ❌

**Problem:**
The tool is receiving malformed arguments:
```json
{"query": "{\"query\""}
```

Instead of:
```json
{"query": "larry ellison"}
```

**Evidence from logs:**
```
Tool: {"query": "{\"query\"", "follow_up_questions": null, "answer": "A query is a request to retrieve..."
```

The tool result shows it searched for "query" (the word) instead of "larry ellison".

**Root Cause Analysis:**

Looking at `response_processor.py` line 459:
```python
tool_calls_buffer[idx]['function']['arguments'] += tool_call_chunk.function.arguments
```

Arguments are accumulated by **string concatenation**. If Bedrock streams malformed JSON chunks, this creates invalid JSON.

**Possible Causes:**

1. **Bedrock Streaming Issue:**
   - Bedrock may be streaming incomplete/malformed JSON chunks
   - String concatenation of partial JSON creates invalid JSON
   - Example: `{"query": "lar` + `ry ellison"}` → `{"query": "larry ellison"}` ✅
   - But if chunks are malformed: `{"query": "{\"qu` + `ery\""}` → `{"query": "{\"query\""}` ❌

2. **Double Encoding:**
   - Arguments might be JSON-encoded twice
   - First encoding: `{"query": "larry ellison"}` → `"{\"query\": \"larry ellison\"}"`
   - Second encoding: `"{\"query\": \"larry ellison\"}"` → `"{\"query\": \"{\\\"query\\\": \\\"larry ellison\\\"}\"}"`
   - When parsed: `{"query": "{\"query\": \"larry ellison\"}"}`

3. **LLM Generating Malformed JSON:**
   - The LLM might be generating invalid JSON in the first place
   - Bedrock's native tool calling might have a bug

**Where to Investigate:**

1. **Check streaming argument accumulation** (`response_processor.py:458-459`):
   ```python
   # Append 'arguments' incrementally (they come as partial JSON strings)
   if hasattr(tool_call_chunk, 'function') and hasattr(tool_call_chunk.function, 'arguments') and tool_call_chunk.function.arguments:
       tool_calls_buffer[idx]['function']['arguments'] += tool_call_chunk.function.arguments
   ```
   - Add logging to see what chunks are being received
   - Check if chunks are valid JSON fragments

2. **Check argument parsing** (`response_processor.py:468`):
   ```python
   parsed_args = safe_json_parse(tool_calls_buffer[idx]['function']['arguments'])
   ```
   - Add logging to see the raw arguments string before parsing
   - Check if `safe_json_parse` is handling edge cases correctly

3. **Check tool execution** (`response_processor.py:1487`):
   ```python
   parsed_args = safe_json_parse(arguments)
   ```
   - Add logging to see what arguments the tool actually receives
   - Verify the arguments are correct before tool execution

**Recommended Fixes:**

1. **Add comprehensive logging:**
   ```python
   logger.info(f"🔍 TOOL ARGS DEBUG: Raw arguments string: {tool_calls_buffer[idx]['function']['arguments']}")
   logger.info(f"🔍 TOOL ARGS DEBUG: Parsed arguments: {parsed_args}")
   logger.info(f"🔍 TOOL ARGS DEBUG: Tool function: {function_name}")
   ```

2. **Validate arguments before execution:**
   ```python
   if isinstance(parsed_args, dict) and 'query' in parsed_args:
       query_value = parsed_args['query']
       if isinstance(query_value, str) and query_value.startswith('{"'):
           logger.error(f"❌ DOUBLE-ENCODED ARGUMENTS DETECTED: {query_value}")
           # Try to fix it
           try:
               fixed_value = json.loads(query_value)
               parsed_args['query'] = fixed_value
           except:
               pass
   ```

3. **Check Bedrock's tool calling format:**
   - Verify Bedrock is sending arguments in the correct format
   - Check if there's a mismatch between expected and actual format

---

## Summary of Fixes Applied

### ✅ Fix 1: Handle Cached Message Format
- Updated `_contains_embedded_tool_result()` to handle list content format
- Extracts text from Anthropic caching format: `[{"type": "text", "text": "..."}]`

### ✅ Fix 2: Filter After Caching
- Added post-caching filtering step
- Removes problematic messages from cached blocks
- Ensures clean messages even when loading from cache

### ⚠️ Fix 3: Tool Parameter Issue (Needs Investigation)
- Need to add logging to trace argument accumulation
- Need to check for double-encoding
- Need to validate arguments before tool execution

---

## Next Steps

1. **Deploy Fixes 1 & 2** - These will fix the Bedrock error
2. **Add logging for tool arguments** - To diagnose the "query" issue
3. **Investigate Bedrock streaming** - Check if chunks are malformed
4. **Add argument validation** - Catch and fix malformed arguments before tool execution

