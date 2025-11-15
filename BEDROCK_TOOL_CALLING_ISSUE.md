# Bedrock Tool Calling Error Analysis

## The Error
```
BedrockException - {"message":"The number of toolResult blocks at messages.2.content exceeds the number of toolUse blocks of previous turn."}
```

## Root Cause Analysis

### 1. **Message Format Mismatch**

Bedrock Converse API uses a **different message format** than OpenAI:

**OpenAI Format (what we're storing):**
```json
[
  {
    "role": "assistant",
    "content": "text",
    "tool_calls": [
      {
        "id": "call_123",
        "function": {"name": "web_search", "arguments": "{}"}
      }
    ]
  },
  {
    "role": "tool",
    "tool_call_id": "call_123",
    "name": "web_search",
    "content": "result..."
  }
]
```

**Bedrock Converse Format (what Bedrock expects):**
```json
[
  {
    "role": "assistant",
    "content": [
      {
        "text": "text"
      },
      {
        "toolUse": {
          "toolUseId": "call_123",
          "name": "web_search",
          "input": {}
        }
      }
    ]
  },
  {
    "role": "user",  // Note: Bedrock uses "user" role for tool results!
    "content": [
      {
        "toolResult": {
          "toolUseId": "call_123",
          "content": [{"text": "result..."}]
        }
      }
    ]
  }
]
```

### 2. **Key Differences**

1. **Tool calls**: Bedrock embeds them in `content` array as `toolUse` blocks, not `tool_calls` array
2. **Tool results**: Bedrock uses `role="user"` with `toolResult` blocks in `content` array, not `role="tool"` messages
3. **Content structure**: Bedrock uses arrays of content blocks, not plain strings

### 3. **Where the Problem Occurs**

The error says `messages.2.content` - meaning message at index 2 has tool results in its content, but the previous assistant message doesn't have matching tool calls.

**Flow:**
1. Messages are stored in DB with OpenAI format (`type="tool"`, `content={"role": "tool", ...}`)
2. `get_llm_messages()` retrieves them and parses JSON
3. Messages are filtered for tool call/result matching
4. Messages are sent to LiteLLM
5. **LiteLLM should convert** OpenAI format → Bedrock format
6. **But conversion fails** if there's a mismatch

### 4. **Why Filtering Isn't Enough**

Our current filtering (lines 441-492 in `thread_manager.py`) checks:
- Tool results have matching `tool_call_id` in previous assistant's `tool_calls`
- But this assumes OpenAI format

**The real issue:** LiteLLM's conversion might be:
- Including tool results that don't match
- Converting format incorrectly
- Not handling edge cases

### 5. **Code Flow**

```
1. Tool executed → _add_tool_result() (response_processor.py:1782)
   └─> Stores: type="tool", content={"role": "tool", "tool_call_id": "...", ...}

2. Next LLM call → get_llm_messages() (thread_manager.py:176)
   └─> Retrieves: [{"role": "assistant", "tool_calls": [...]}, {"role": "tool", ...}]

3. Filtering → Lines 441-492 (thread_manager.py)
   └─> Checks: tool_call_id matches previous assistant's tool_calls

4. Send to LiteLLM → make_llm_api_call() (services/llm.py:168)
   └─> LiteLLM converts format for Bedrock

5. Bedrock receives → Expects Bedrock format
   └─> ERROR if tool results don't match tool calls
```

## Files Involved

### 1. **`backend/core/agentpress/thread_manager.py`**
- **Line 176-239**: `get_llm_messages()` - Retrieves messages from DB
- **Line 441-492**: Tool result filtering logic
- **Line 588-644**: Message logging before sending to LLM

### 2. **`backend/core/agentpress/response_processor.py`**
- **Line 1782-1867**: `_add_tool_result()` - Stores tool results
- **Line 1848-1853**: Creates tool message format: `{"role": "tool", "tool_call_id": "...", ...}`

### 3. **`backend/core/services/llm.py`**
- **Line 168-259**: `make_llm_api_call()` - Sends to LiteLLM
- LiteLLM handles format conversion internally

## Potential Solutions

### Solution 1: **Fix Filtering Logic** (Current Approach)
- Ensure tool results only appear after matching assistant messages
- Reset tracking when assistant message has no tool_calls
- **Status**: Already implemented, but error persists

### Solution 2: **Check LiteLLM Conversion**
- LiteLLM might not be converting correctly
- May need to manually format messages for Bedrock
- Check if LiteLLM version supports Bedrock Converse properly

### Solution 3: **Remove Orphaned Tool Results**
- Tool results might be from previous turns
- Need to ensure only the most recent tool results are included
- May need to filter by timestamp or turn number

### Solution 4: **Bedrock-Specific Message Formatting**
- Detect Bedrock models
- Manually convert messages to Bedrock format before sending
- Bypass LiteLLM's conversion if it's buggy

## Debugging Steps

1. **Check logs** for:
   - `🔍 NATIVE TOOL CALLING: Final message breakdown`
   - `📊 NATIVE TOOL CALLING: Summary`
   - `🔍 BEDROCK DEBUG: Full prepared_messages structure`

2. **Verify message structure**:
   - Are tool results appearing without matching tool calls?
   - Are tool_call_ids matching correctly?
   - Is LiteLLM converting format correctly?

3. **Check database**:
   - Query messages table for the thread
   - Verify tool messages have correct `tool_call_id`
   - Check if there are duplicate or orphaned tool results

## Next Steps

1. **Add more detailed logging** to see exact message structure sent to Bedrock
2. **Check LiteLLM version** and Bedrock Converse support
3. **Consider manual format conversion** for Bedrock models
4. **Verify tool_call_id matching** is working correctly

