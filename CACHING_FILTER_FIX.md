# Caching/Filtering Fix Summary

## Problem

After prompt caching, the message filtering logic was **too aggressive** and removed cached conversation blocks that contained tool result text patterns. This caused:

1. **Loss of conversation context** - Cached blocks were filtered out
2. **Emergency fallback triggered** - Only one user message remained
3. **LLM received incomplete context** - Missing conversation history

### Root Cause

The `_filter_tool_results_for_bedrock` method was checking ALL user messages (including cached blocks) for embedded tool result patterns like `"Tool: {"`. 

**Cached blocks** are formatted conversation history that may contain these patterns as part of the cached conversation, but they are **validated conversation history** and should be trusted, not filtered.

## Solution

### Changes Made

**File**: `backend/core/agentpress/thread_manager.py`

1. **Added `_is_cached_block()` helper method** (lines 351-367)
   - Detects cached blocks by checking for `cache_control` in content structure
   - Cached blocks have `content: [{"type": "text", "text": "...", "cache_control": {"type": "ephemeral"}}]`

2. **Updated `_contains_embedded_tool_result()`** (lines 387-390)
   - Now skips cached blocks before checking for embedded tool results
   - Cached blocks are excluded from embedded tool result detection

3. **Updated `_filter_tool_results_for_bedrock()`** (lines 515-521)
   - Added early check for cached blocks in user message handling
   - Cached blocks are passed through unchanged without filtering
   - Added debug logging to track when cached blocks are preserved

## How It Works

### Before Fix
```
User message → Check for "Tool: {" pattern → Found! → Filter out → ❌ Lost context
```

### After Fix
```
User message → Is it a cached block? → Yes → Skip filtering → ✅ Preserve context
User message → Is it a cached block? → No → Check for "Tool: {" → Filter if needed
```

## Expected Behavior

1. ✅ **Cached blocks are preserved** - Conversation history remains intact
2. ✅ **New messages still filtered** - Embedded tool results in new messages are still caught
3. ✅ **No emergency fallback** - Full conversation context is maintained
4. ✅ **LLM receives complete context** - All cached history + new messages

## Testing

After this fix, you should see:
- ✅ Debug logs: `"Skipping filter for cached block at index X (validated conversation history)"`
- ✅ No more: `"CRITICAL: Filtering removed ALL non-system messages!"`
- ✅ No more: `"EMERGENCY: Keeping last user message to prevent Bedrock error"`
- ✅ Full conversation context preserved in subsequent LLM calls

## Related Files

- `backend/core/agentpress/thread_manager.py` - Main fix location
- `backend/core/agentpress/prompt_caching.py` - Creates cached blocks with `cache_control`
- `TOOL_CALLING_FLOW_ANALYSIS.md` - Original argument parsing fix

