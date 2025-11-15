# Fix Summary: Tool Call Argument Parsing Bug

## Problem Identified

Tool calls were being executed with **incomplete/truncated JSON arguments** (e.g., `{"ur` instead of `{"urls": "https://..."}`), causing tool execution failures.

## Root Cause

The completion check logic in `response_processor.py` was using `safe_json_parse()`, which returns the original string when JSON parsing fails. This meant:

1. Incomplete JSON strings like `{"ur` would fail to parse
2. `safe_json_parse()` would return the string `{"ur` instead of raising an error
3. The code would mark the tool call as "complete" even though arguments were incomplete
4. Tools would execute with malformed string arguments instead of proper dicts

## Fix Applied

**File**: `backend/core/agentpress/response_processor.py`  
**Lines**: 461-521

### Changes:

1. **Replaced `safe_json_parse()` with `json.loads()`** (line 471)
   - `json.loads()` raises `JSONDecodeError` on incomplete/invalid JSON
   - This properly detects when arguments are still accumulating

2. **Added strict dict validation** (lines 473-475)
   - Only mark tool call as complete if `parsed_args` is a valid dict
   - If parsing succeeds but result is not a dict, continue accumulating

3. **Improved error handling** (lines 495-500)
   - Explicitly set `has_complete_tool_call = False` and `parsed_args = None` on parse failure
   - Prevents using incomplete data

4. **Added safety check before execution** (lines 504-508)
   - Double-check that `parsed_args` is a valid dict before executing
   - Skip execution if somehow invalid data gets through

## Expected Behavior After Fix

1. ✅ Tool calls will only execute when arguments are **complete, valid JSON dicts**
2. ✅ Incomplete JSON will continue accumulating until complete
3. ✅ No more execution with truncated strings like `{"ur`
4. ✅ Tools receive properly formatted dict arguments

## Testing Recommendations

1. Test with streaming tool calls that have long argument strings
2. Verify tools execute only after arguments are complete
3. Check logs for `⏳ NATIVE TOOL CALL INCOMPLETE` messages during accumulation
4. Verify `✅ NATIVE TOOL CALL COMPLETE` only appears with valid dicts

## Related Files

- `backend/core/agentpress/response_processor.py` - Main fix location
- `backend/core/utils/json_helpers.py` - Contains `safe_json_parse()` (now avoided for completion check)
- `TOOL_CALLING_FLOW_ANALYSIS.md` - Detailed flow analysis

