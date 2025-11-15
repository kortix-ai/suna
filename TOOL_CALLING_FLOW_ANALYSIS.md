# Tool Calling Flow Analysis - Root Cause Investigation

## Executive Summary

The root problem is that **tool call arguments are being executed before they are fully accumulated**, resulting in truncated/incomplete JSON strings being passed to tool functions. The `safe_json_parse` function returns the original string when JSON parsing fails, which masks the problem and allows execution with malformed data.

---

## Complete Flow Trace

### Phase 1: LLM Token Emission & Chunk Reception

**Location**: `response_processor.py:408-431`

```python
# Line 408-409: Native tool call chunks arrive
if config.native_tool_calling and delta and hasattr(delta, 'tool_calls') and delta.tool_calls:
    logger.debug(f"🔵 NATIVE TOOL CALL: Received {len(delta.tool_calls)} tool call chunk(s) in delta")
```

**What happens**: The LLM streams tool call chunks incrementally. Each chunk contains:
- Partial `id` (e.g., `tooluse_tAFX6g_0Ru6Jz_qjTiETag`)
- Partial `function.name` (e.g., `scrape_webpage`)
- Partial `function.arguments` (e.g., `{"ur`, then `{"urls"`, then `{"urls": "https://...`)

**Log Evidence**:
- Line 5: `🔵 NATIVE TOOL CALL: Received 1 tool call chunk(s) in delta`
- Line 6: `✅ NATIVE TOOL CALL COMPLETE: id=tooluse_tAFX6g_0Ru6Jz_qjTiETag, name=scrape_webpage, args={"ur`
- Line 7: `⚠️ Parsed arguments are not a dict: <class 'str'>`

---

### Phase 2: Argument Accumulation

**Location**: `response_processor.py:456-459`

```python
# Append 'arguments' incrementally (they come as partial JSON strings)
if hasattr(tool_call_chunk, 'function') and hasattr(tool_call_chunk.function, 'arguments') and tool_call_chunk.function.arguments:
    tool_calls_buffer[idx]['function']['arguments'] += tool_call_chunk.function.arguments
```

**What happens**: Arguments are accumulated by string concatenation. Each chunk appends to the buffer:
- Chunk 1: `{"ur`
- Chunk 2: `{"urls"`
- Chunk 3: `{"urls": "https://...`
- etc.

**Problem**: The buffer accumulates correctly, but the completion check happens **too early**.

---

### Phase 3: Premature Completion Detection

**Location**: `response_processor.py:461-492`

```python
# Check if tool call is complete (has id, name, and valid JSON arguments)
has_complete_tool_call = False
parsed_args = None
if (tool_calls_buffer[idx]['id'] and
    tool_calls_buffer[idx]['function']['name'] and
    tool_calls_buffer[idx]['function']['arguments']):
    try:
        raw_args_str = tool_calls_buffer[idx]['function']['arguments']
        parsed_args = safe_json_parse(raw_args_str)  # ⚠️ PROBLEM HERE
        has_complete_tool_call = True  # ⚠️ MARKED AS COMPLETE TOO EARLY
```

**The Critical Bug**: 

1. **Line 470**: `parsed_args = safe_json_parse(raw_args_str)` is called on incomplete JSON like `{"ur`

2. **`safe_json_parse` behavior** (`json_helpers.py:88-118`):
   ```python
   def safe_json_parse(value, default=None):
       if isinstance(value, str):
           try:
               return json.loads(value)  # Fails on incomplete JSON
           except (json.JSONDecodeError, TypeError):
               return value  # ⚠️ RETURNS THE ORIGINAL STRING!
   ```

3. **Result**: When JSON parsing fails (because JSON is incomplete), `safe_json_parse` returns the original string `{"ur` instead of raising an error.

4. **Line 471**: `has_complete_tool_call = True` is set even though `parsed_args` is a string, not a dict!

5. **Line 487**: The warning `⚠️ Parsed arguments are not a dict: <class 'str'>` is logged, but execution continues anyway.

**Log Evidence**:
- Line 6: `✅ NATIVE TOOL CALL COMPLETE: ... args={"ur` (truncated)
- Line 7: `⚠️ Parsed arguments are not a dict: <class 'str'>`
- Line 9: `✅ NATIVE TOOL CALL COMPLETE: ... args={"urls": "htt` (still truncated)
- Line 10: `⚠️ Parsed arguments are not a dict: <class 'str'>`

---

### Phase 4: Tool Execution Triggered

**Location**: `response_processor.py:495-508`

```python
if has_complete_tool_call and config.execute_tools and config.execute_on_stream and idx not in executed_tool_call_indices:
    executed_tool_call_indices.add(idx)  # Prevents re-execution
    
    current_tool = tool_calls_buffer[idx]
    final_args = parsed_args if parsed_args is not None else safe_json_parse(current_tool['function']['arguments'])
    tool_call_data = {
        "function_name": current_tool['function']['name'],
        "arguments": final_args,  # ⚠️ THIS IS A STRING LIKE "{"ur", NOT A DICT!
        "id": current_tool['id']
    }
    logger.info(f"🚀 NATIVE TOOL CALL EXECUTING: {tool_call_data['function_name']} (id={tool_call_data['id']}, index={idx})")
```

**What happens**: 
- Line 501: `final_args` is set to `parsed_args`, which is the string `{"ur` (not a dict)
- Line 504: This string is passed as `arguments` to the tool execution
- Line 522: `_execute_tool(tool_call_data)` is called with malformed arguments

**Log Evidence**:
- Line 38: `🔧 EXECUTING TOOL: scrape_webpage`
- Line 39: `📝 RAW ARGUMENTS VALUE: {"ur` (truncated string)

---

### Phase 5: Tool Execution Attempt

**Location**: `response_processor.py:1515-1562`

```python
# Handle arguments - if it's a string, try to parse it, otherwise pass as-is
if isinstance(arguments, str):
    logger.debug(f"🔄 Parsing string arguments for {function_name}")
    try:
        parsed_args = safe_json_parse(arguments)  # Tries to parse "{"ur"
        # ...
        if isinstance(parsed_args, dict):
            result = await tool_fn(**parsed_args)
        else:
            logger.debug(f"🔄 Arguments parsed as non-dict, passing as single argument")
            result = await tool_fn(arguments)  # ⚠️ CALLS TOOL WITH STRING "{"ur"
```

**What happens**:
1. Line 1516: Detects arguments is a string `{"ur`
2. Line 1520: Tries `safe_json_parse("{"ur")` which returns `"{"ur"` (the string itself)
3. Line 1536: Checks if it's a dict - **it's not**, so goes to line 1540
4. Line 1540: Passes the string `"{"ur"` as a single argument to `tool_fn(arguments)`
5. **Tool function expects a dict with keys like `urls`, but receives a string instead**

**Log Evidence**:
- Line 42: `🔄 Parsing string arguments for scrape_webpage`
- Line 43: `🔍 TOOL ARGS DEBUG [scrape_webpage]: Raw arguments string: {"ur`
- Line 44: `🔍 TOOL ARGS DEBUG [scrape_webpage]: Parsed arguments: {"ur` (still a string)
- Line 45: `🔄 Arguments parsed as non-dict, passing as single argument`
- Line 46: `Starting to scrape webpages: {"ur` (tool receives malformed input)
- Line 75: `Processing 1 URLs: ['{"ur']` (tool tries to process malformed URL)
- Line 79: `Error scraping URL '{"ur': Client error '400 Bad Request'`

---

### Phase 6: Tool Failure

**Location**: Tool execution (e.g., `scrape_webpage`)

**What happens**: The tool receives `"{"ur"` as a single string argument instead of a dict like `{"urls": "https://..."}`. The tool tries to process this as a URL, which fails.

**Log Evidence**:
- Line 79: `Error during scraping: Client error '400 Bad Request'`
- Line 81: `Error scraping URL '{"ur': Client error '400 Bad Request'`
- Line 84: `📤 Result: ToolResult(success=False, output='Failed to scrape all 1 URLs...')`

---

## Root Cause Analysis

### Primary Root Cause

**The completion check logic is flawed**: It marks a tool call as "complete" when `safe_json_parse()` succeeds OR when it returns the original string (which happens on parse failure). This means incomplete JSON strings are treated as "complete" and executed.

### Secondary Issues

1. **`safe_json_parse` is too forgiving**: It returns the original string on parse failure, which masks incomplete JSON errors.

2. **No validation after parsing**: The code checks `isinstance(parsed_args, dict)` but doesn't prevent execution when it's not a dict.

3. **Execution happens too early**: Tools are executed as soon as JSON parsing "succeeds" (even if it actually failed and returned a string), rather than waiting for truly complete JSON.

---

## The Fix Strategy

### Option 1: Strict JSON Validation (Recommended)

**Change the completion check to require a valid dict**:

```python
# In response_processor.py:461-492
if (tool_calls_buffer[idx]['id'] and
    tool_calls_buffer[idx]['function']['name'] and
    tool_calls_buffer[idx]['function']['arguments']):
    try:
        raw_args_str = tool_calls_buffer[idx]['function']['arguments']
        parsed_args = json.loads(raw_args_str)  # Use json.loads directly, not safe_json_parse
        # ✅ ONLY mark as complete if we get a dict
        if isinstance(parsed_args, dict):
            has_complete_tool_call = True
            logger.info(f"✅ NATIVE TOOL CALL COMPLETE: ...")
        else:
            # Not a dict, keep accumulating
            logger.debug(f"⏳ Arguments parsed but not a dict, still accumulating...")
            has_complete_tool_call = False
    except json.JSONDecodeError as e:
        # JSON incomplete, keep accumulating
        logger.debug(f"⏳ NATIVE TOOL CALL INCOMPLETE: JSON parse failed, still accumulating")
        has_complete_tool_call = False
```

### Option 2: Wait for Stream Completion

**Don't execute tools during streaming** - wait until the stream is complete and all chunks are accumulated:

```python
# Only execute tools after stream completes
# Move execution logic to after line 529 (Stream complete)
```

### Option 3: Better Completion Detection

**Check for complete JSON structure** (balanced braces, valid JSON):

```python
def is_complete_json(s: str) -> bool:
    """Check if string is complete, valid JSON."""
    try:
        parsed = json.loads(s)
        return isinstance(parsed, dict)  # Require dict for tool arguments
    except json.JSONDecodeError:
        return False
```

---

## Code Locations Summary

| Phase | File | Lines | Issue |
|-------|------|-------|-------|
| Chunk Reception | `response_processor.py` | 408-431 | ✅ Working correctly |
| Argument Accumulation | `response_processor.py` | 456-459 | ✅ Working correctly |
| **Completion Check** | `response_processor.py` | 461-492 | ❌ **BUG: Marks incomplete as complete** |
| Execution Trigger | `response_processor.py` | 495-508 | ⚠️ Executes with bad data |
| Tool Execution | `response_processor.py` | 1515-1562 | ⚠️ Tries to handle but fails |
| JSON Parser | `json_helpers.py` | 88-118 | ⚠️ Too forgiving (returns string on failure) |

---

## Recommended Fix

**File**: `backend/core/agentpress/response_processor.py`  
**Lines**: 461-492

Replace the completion check logic to require a valid dict before marking as complete:

```python
# Check if tool call is complete (has id, name, and valid JSON arguments)
has_complete_tool_call = False
parsed_args = None
if (tool_calls_buffer[idx]['id'] and
    tool_calls_buffer[idx]['function']['name'] and
    tool_calls_buffer[idx]['function']['arguments']):
    try:
        raw_args_str = tool_calls_buffer[idx]['function']['arguments']
        # Use json.loads directly - it will raise on incomplete JSON
        parsed_args = json.loads(raw_args_str)
        # CRITICAL: Only mark as complete if we have a valid dict
        if isinstance(parsed_args, dict):
            has_complete_tool_call = True
            logger.info(f"✅ NATIVE TOOL CALL COMPLETE: id={tool_calls_buffer[idx]['id']}, name={tool_calls_buffer[idx]['function']['name']}, args={parsed_args}")
        else:
            # Parsed but not a dict - keep accumulating
            logger.debug(f"⏳ Arguments parsed but not a dict (got {type(parsed_args)}), still accumulating...")
            has_complete_tool_call = False
    except json.JSONDecodeError as e:
        # JSON incomplete or invalid - keep accumulating
        logger.debug(f"⏳ NATIVE TOOL CALL INCOMPLETE (idx={idx}): JSON parse failed, still accumulating: {str(e)[:100]}")
        logger.debug(f"   Raw arguments so far: {tool_calls_buffer[idx]['function']['arguments'][:200]}")
        has_complete_tool_call = False
        parsed_args = None  # Don't use incomplete parse
```

This ensures:
1. ✅ Only valid, complete JSON dicts trigger execution
2. ✅ Incomplete JSON continues accumulating
3. ✅ No execution with malformed string arguments

