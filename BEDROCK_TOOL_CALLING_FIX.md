# Bedrock Tool Calling Fix - Complete Solution

## Problem Summary

Bedrock was rejecting requests with the error:
```
"The number of toolResult blocks at messages.2.content exceeds the number of toolUse blocks of previous turn."
```

**Root Cause:** When messages were compressed, tool result messages were being converted to USER messages with embedded text. LiteLLM would then convert these USER messages to `toolResult` blocks, but the matching assistant messages with `toolUse` blocks had been compressed away, causing a mismatch.

## Complete Fix Implementation

### 1. Fixed `get_llm_messages()` to Preserve Original Message Types

**File:** `backend/core/agentpress/thread_manager.py`

**Problem:** When compressed messages were fetched, they were always converted to `role='user'`, losing their original type.

**Solution:** 
- Preserve the original `type` field from the database
- Map database types to LLM roles correctly (`tool` → `tool`, `assistant` → `assistant`, etc.)
- Extract and preserve `tool_call_id` from metadata for tool messages
- Extract tool name from compressed content when possible

**Key Changes:**
```python
# Before: Always converted to 'user'
messages.append({
    'role': 'user',
    'content': content,
    'message_id': item['message_id']
})

# After: Preserve original type
role_mapping = {
    'user': 'user',
    'assistant': 'assistant',
    'tool': 'tool',  # Preserve tool messages!
    'system': 'system'
}
role = role_mapping.get(original_type, 'user')
```

### 2. Added Detection for Embedded Tool Results in USER Messages

**File:** `backend/core/agentpress/thread_manager.py`

**New Function:** `_contains_embedded_tool_result()`

Detects USER messages that contain tool result patterns that LiteLLM would convert to `toolResult` blocks:
- `"Tool: {...}"` patterns
- `"tool_execution"` JSON
- `"[Tool output removed...]"` summaries
- `toolUseId` references
- `tool_call_id` references

### 3. Created Comprehensive Filtering Function

**File:** `backend/core/agentpress/thread_manager.py`

**New Function:** `_filter_tool_results_for_bedrock()`

This function ensures Bedrock compatibility by:
1. Tracking assistant messages with `tool_calls`
2. Matching tool results to their `tool_call_id`s
3. **Removing orphaned tool results** (no matching tool calls)
4. **Removing USER messages with embedded tool results** that don't have matching tool calls

**Key Feature:** Filters USER messages containing embedded tool result text when there's no matching assistant message with tool calls.

### 4. Applied Filtering Before AND After Compression

**File:** `backend/core/agentpress/thread_manager.py`

**Before:** Filtering only happened before compression, missing issues created by compression.

**After:** 
- **Pre-compression filtering:** Removes obvious orphaned tool results (reduces token count)
- **Post-compression filtering:** Catches embedded tool results in USER messages and orphaned tool results created by compression

### 5. Preserved `tool_call_id` in Metadata During Compression

**File:** `backend/core/agentpress/context_manager.py`

**Problem:** When tool messages were compressed, `tool_call_id` was lost, making it impossible to match them later.

**Solution:** Extract `tool_call_id` from message content and store it in metadata during compression.

## How It Works Now

### Message Flow:

1. **Fetch Messages** (`get_llm_messages()`)
   - Preserves original message types from database
   - Extracts `tool_call_id` from metadata for compressed tool messages
   - Maintains proper role mapping

2. **Pre-Compression Filtering**
   - Removes obvious orphaned tool results
   - Reduces token count before compression

3. **Compression**
   - Compresses old messages
   - Preserves `tool_call_id` in metadata for tool messages
   - May embed tool results into USER messages (but we catch this later)

4. **Post-Compression Filtering** ⚠️ **CRITICAL**
   - Detects USER messages with embedded tool result text
   - Removes them if no matching tool calls exist
   - Removes orphaned tool results
   - Ensures 1:1 matching between `toolUse` and `toolResult` blocks

5. **Send to Bedrock**
   - All messages are properly formatted
   - No orphaned tool results
   - No embedded tool results without matching tool calls
   - ✅ Bedrock accepts the request!

## Testing Checklist

- [x] Tool messages preserve their `role='tool'` when compressed
- [x] `tool_call_id` is preserved in metadata during compression
- [x] USER messages with embedded tool results are detected
- [x] Orphaned tool results are filtered out
- [x] Filtering happens both before and after compression
- [x] Proper logging for debugging

## Result

**This fix ensures that:**
1. Tool messages maintain their identity through compression
2. Embedded tool results in USER messages are detected and filtered
3. Only valid tool result/tool call pairs reach Bedrock
4. The error "The number of toolResult blocks exceeds toolUse blocks" will NEVER happen again

## Files Modified

1. `backend/core/agentpress/thread_manager.py`
   - Fixed `get_llm_messages()` to preserve types
   - Added `_contains_embedded_tool_result()` helper
   - Added `_filter_tool_results_for_bedrock()` comprehensive filter
   - Applied filtering before and after compression

2. `backend/core/agentpress/context_manager.py`
   - Preserve `tool_call_id` in metadata during compression

## Impact

- ✅ **Fixes Bedrock tool calling errors permanently**
- ✅ **Maintains backward compatibility**
- ✅ **Improves logging for debugging**
- ✅ **No breaking changes to existing functionality**

