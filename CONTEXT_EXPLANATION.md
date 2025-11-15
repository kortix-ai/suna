# Complete Context: Compression, Filtering, and Bedrock

## 1. What is Context Compression?

### The Problem It Solves

LLMs have **context windows** - a maximum number of tokens (words/characters) they can process at once. For example:
- Claude Sonnet 4: ~200,000 tokens
- GPT-4: ~128,000 tokens
- Older models: ~4,000-8,000 tokens

When a conversation gets too long, you hit this limit and can't send all messages to the LLM.

### What Compression Does

**Context Compression** reduces the size of old messages while preserving important information. Think of it like summarizing a long conversation.

#### How It Works in Your Code:

1. **Token Counting** (lines 49-100 in `context_manager.py`)
   - Counts tokens in all messages
   - Checks if total exceeds the model's limit

2. **Compression Strategy** (lines 723-749 in `context_manager.py`)
   - Keeps recent messages intact (last 10 user + 10 assistant messages)
   - Compresses older messages by:
     - **Truncating** long tool outputs
     - **Summarizing** multiple messages into one
     - **Embedding** tool results into USER messages as text

3. **Example:**

   **Before Compression:**
   ```
   Message 1: USER: "What is Python?"
   Message 2: ASSISTANT: "Python is a programming language..." (500 tokens)
   Message 3: TOOL RESULT: web_search result (2000 tokens)
   Message 4: ASSISTANT: "Based on the search..." (300 tokens)
   Message 5: TOOL RESULT: file_read result (1500 tokens)
   ```

   **After Compression:**
   ```
   Message 1: USER: "What is Python? [compressed: previous conversation about Python, web search results, file contents]"
   Message 2: ASSISTANT: "Based on the search..." (300 tokens - kept recent)
   Message 3: TOOL RESULT: file_read result (1500 tokens - kept recent)
   ```

### The Problem in Your Case

Compression is **embedding tool results into USER messages as plain text**. For example:

```
USER: "Tool: {"query": "...", "answer": "..."}"
```

This creates a problem because:
1. LiteLLM (the library that talks to Bedrock) sees this text
2. It recognizes it as a tool result
3. It converts it to Bedrock's `toolResult` format
4. But there's no matching `toolUse` block (because the assistant message was compressed away)
5. Bedrock errors: "toolResult without matching toolUse"

---

## 2. What is Filtering?

### The Problem It Solves

Bedrock requires **exact 1:1 matching** between tool calls and tool results:
- Every `toolUse` block must have a matching `toolResult` block
- Every `toolResult` block must have a matching `toolUse` block
- No orphaned tool results

### What Filtering Does

**Filtering** removes tool result messages that don't have matching tool calls.

#### How It Works in Your Code:

1. **Track Tool Calls** (lines 535-547 in `thread_manager.py`)
   - Scans messages for assistant messages with `tool_calls`
   - Records all `tool_call_id`s from those calls

2. **Validate Tool Results** (lines 553-567 in `thread_manager.py`)
   - For each tool result message:
     - Checks if it has a `tool_call_id`
     - Verifies the `tool_call_id` matches a pending tool call
     - If no match → **FILTERS IT OUT**

3. **Example:**

   **Before Filtering:**
   ```
   Message 1: USER: "Hello"
   Message 2: TOOL RESULT: tool_call_id="abc123" (but no matching tool call!)
   Message 3: TOOL RESULT: tool_call_id="def456" (but no matching tool call!)
   ```

   **After Filtering:**
   ```
   Message 1: USER: "Hello"
   (Messages 2 and 3 removed - no matching tool calls)
   ```

### Why Filtering Order Matters

**Before (WRONG):**
```
1. Filter messages (removes orphaned tool results)
2. Compress messages (creates NEW orphaned tool results in USER messages)
3. Send to Bedrock → ERROR (compression created new problems)
```

**After (CORRECT):**
```
1. Compress messages (may embed tool results into USER messages)
2. Filter messages (removes orphaned tool results)
3. Send to Bedrock → SUCCESS (filtering catches problems after compression)
```

---

## 3. What is AWS Bedrock?

### Overview

**Amazon Bedrock** is AWS's managed service for running large language models (LLMs). Think of it as AWS's version of OpenAI's API, but with access to multiple AI models.

### Key Features

1. **Multiple Models**: Access to Claude, Llama, Titan, and other models
2. **Serverless**: No infrastructure to manage
3. **Secure**: Data stays in AWS, encrypted
4. **Cost-Effective**: Pay per use

### Bedrock Converse API

Bedrock has a special API called **Converse API** that's designed for chat applications. It uses a different message format than OpenAI.

#### OpenAI Format (What You Store):
```json
[
  {
    "role": "assistant",
    "content": "I'll search for that",
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
    "content": "Search results..."
  }
]
```

#### Bedrock Converse Format (What Bedrock Expects):
```json
[
  {
    "role": "assistant",
    "content": [
      {"text": "I'll search for that"},
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
          "content": [{"text": "Search results..."}]
        }
      }
    ]
  }
]
```

### Key Differences

1. **Content Structure**: Bedrock uses arrays of content blocks, not plain strings
2. **Tool Calls**: Embedded in `content` array as `toolUse` blocks
3. **Tool Results**: Use `role="user"` with `toolResult` blocks in `content` array
4. **Strict Matching**: Bedrock requires exact 1:1 matching between `toolUse` and `toolResult`

### The Error You're Seeing

```
"The number of toolResult blocks at messages.2.content exceeds the number of toolUse blocks of previous turn."
```

**What Bedrock is saying:**
- "In message [2], I see `toolResult` blocks"
- "But the previous assistant message doesn't have matching `toolUse` blocks"
- "This violates my requirement - I can't process this"

**Why it happens:**
1. Compression embedded tool results into USER messages as text
2. LiteLLM converts that text to `toolResult` blocks
3. But the assistant message with `toolUse` blocks was compressed away
4. Result: `toolResult` blocks without matching `toolUse` blocks → ERROR

---

## 4. The Complete Flow

### Step-by-Step Process

```
1. GET MESSAGES FROM DATABASE
   ↓
   [USER: "research larry ellison"]
   [ASSISTANT: with tool_calls for web_search]
   [TOOL RESULT: web_search result 1]
   [TOOL RESULT: web_search result 2]
   [ASSISTANT: "Based on results..."]
   [TOOL RESULT: another tool result]
   
2. FILTERING (OLD - BEFORE COMPRESSION) ❌
   ↓
   (Removes orphaned tool results)
   [USER: "research larry ellison"]
   [ASSISTANT: with tool_calls]
   [TOOL RESULT: web_search result 1]
   [TOOL RESULT: web_search result 2]
   [ASSISTANT: "Based on results..."]
   
3. COMPRESSION
   ↓
   (Compresses old messages, embeds tool results into USER messages)
   [USER: "research larry ellison [compressed: tool results embedded as text]"]
   [USER: "Tool: {...}" ← PROBLEM: tool result text in USER message]
   [USER: "Tool: {...}" ← PROBLEM: tool result text in USER message]
   [ASSISTANT: "Based on results..."]
   [TOOL RESULT: another tool result]
   
4. SEND TO BEDROCK
   ↓
   LiteLLM converts:
   - USER messages with tool result text → toolResult blocks
   - TOOL RESULT messages → toolResult blocks
   - But no toolUse blocks (assistant message compressed away)
   ↓
   ERROR: toolResult without toolUse

---

NEW FLOW (AFTER FIX):

1. GET MESSAGES FROM DATABASE
   ↓
   [Same as before]
   
2. COMPRESSION (FIRST)
   ↓
   [USER: "research larry ellison [compressed]"]
   [USER: "Tool: {...}" ← tool result text]
   [USER: "Tool: {...}" ← tool result text]
   [ASSISTANT: "Based on results..."]
   [TOOL RESULT: another tool result]
   
3. FILTERING (AFTER COMPRESSION) ✅
   ↓
   (Removes tool results without matching tool calls)
   [USER: "research larry ellison [compressed]"]
   [USER: "Tool: {...}" ← Still here (can't easily detect)]
   [USER: "Tool: {...}" ← Still here (can't easily detect)]
   [ASSISTANT: "Based on results..."]
   (TOOL RESULT removed - no matching tool call)
   
4. SEND TO BEDROCK
   ↓
   Still may have issues with USER messages containing tool result text
   But standalone tool result messages are filtered out
```

---

## 5. Why This Matters

### Without Proper Filtering:
- Bedrock receives orphaned tool results
- Bedrock errors and refuses to process
- Your agent stops working

### With Proper Filtering:
- Tool results without matching calls are removed
- Bedrock receives valid message structure
- Your agent continues working

### Remaining Challenge:
- USER messages with embedded tool result text (from compression)
- These are harder to detect and filter
- May still cause issues if LiteLLM converts them to toolResult blocks

---

## 6. Technical Details

### Compression Settings (from `context_manager.py`):

```python
self.keep_recent_tool_outputs = 5  # Keep last 5 tool outputs uncompressed
self.compression_target_ratio = 0.6  # Compress to 60% of max tokens
self.keep_recent_user_messages = 10  # Keep last 10 user messages
self.keep_recent_assistant_messages = 10  # Keep last 10 assistant messages
```

### Filtering Logic (from `thread_manager.py`):

```python
# Track pending tool calls
pending_tool_call_ids = {tc.get('id') for tc in tool_calls}

# For each tool result:
if tool_call_id in pending_tool_call_ids:
    # Keep it - has matching tool call
    filtered_messages.append(msg)
else:
    # Remove it - no matching tool call
    logger.warning("FILTERING OUT")
```

### Bedrock Requirements:

1. **Strict 1:1 Matching**: Every `toolUse` must have exactly one `toolResult`
2. **Order Matters**: `toolResult` must come after its matching `toolUse`
3. **No Orphans**: Can't have `toolResult` without `toolUse` or vice versa

---

## Summary

- **Compression**: Reduces message size by summarizing/embedding old messages
- **Filtering**: Removes tool results that don't have matching tool calls
- **Bedrock**: AWS's LLM service with strict requirements for tool calling
- **The Fix**: Filter AFTER compression to catch problems compression creates

The key insight: **Compression can create new problems** (embedding tool results into USER messages), so filtering must happen **after** compression to catch these issues.

