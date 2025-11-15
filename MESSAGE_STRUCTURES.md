# Message Structures in the System

This document explains all the different message formats used throughout the system, from database storage to LLM API calls.

---

## Table of Contents

1. [Database Storage Format](#database-storage-format)
2. [LLM API Format](#llm-api-format)
3. [Message Types by Role](#message-types-by-role)
4. [Content Format Variations](#content-format-variations)
5. [Cached Blocks Format](#cached-blocks-format)
6. [Tool Call & Result Formats](#tool-call--result-formats)
7. [Message Transformation Flow](#message-transformation-flow)

---

## Database Storage Format

Messages are stored in the `messages` table with the following structure:

```python
{
    "message_id": "uuid-string",
    "thread_id": "uuid-string",
    "type": "user" | "assistant" | "tool" | "system" | "status" | "llm_response_end",
    "content": str | dict | list,  # Can be JSON string or object
    "is_llm_message": bool,  # True if this message should be sent to LLM
    "metadata": dict,  # Additional metadata (compression, tool_call_id, etc.)
    "agent_id": "uuid-string" | null,
    "agent_version_id": "uuid-string" | null,
    "created_at": "ISO timestamp",
    "updated_at": "ISO timestamp"
}
```

### Content Storage Variations

**1. JSON String Format** (most common):
```json
{
    "type": "user",
    "content": "{\"role\": \"user\", \"content\": \"Hello!\"}"
}
```

**2. Plain String Format** (compressed messages):
```json
{
    "type": "user",
    "content": "Hello! (truncated)...",
    "metadata": {
        "compressed": true,
        "compressed_content": "Hello! (truncated)..."
    }
}
```

**3. Direct Object Format** (some status messages):
```json
{
    "type": "status",
    "content": {
        "status_type": "thread_run_start",
        "thread_run_id": "uuid"
    }
}
```

---

## LLM API Format

When messages are sent to the LLM, they are transformed into a standardized format:

### Basic Message Structure

```python
{
    "role": "system" | "user" | "assistant" | "tool",
    "content": str | list[dict],  # Content format varies by role
    "message_id": "uuid-string"  # Optional, for tracking
}
```

---

## Message Types by Role

### 1. System Messages

**Database:**
```json
{
    "type": "system",
    "content": "{\"role\": \"system\", \"content\": \"You are Suna.so...\"}"
}
```

**LLM Format:**
```python
{
    "role": "system",
    "content": "You are Suna.so, an autonomous AI Worker..."
}
```

**Or with Anthropic format:**
```python
{
    "role": "system",
    "content": [
        {
            "type": "text",
            "text": "You are Suna.so, an autonomous AI Worker..."
        }
    ]
}
```

---

### 2. User Messages

**Database:**
```json
{
    "type": "user",
    "content": "{\"role\": \"user\", \"content\": \"research about larry ellison\"}"
}
```

**LLM Format (Simple):**
```python
{
    "role": "user",
    "content": "research about larry ellison"
}
```

**LLM Format (Anthropic List):**
```python
{
    "role": "user",
    "content": [
        {
            "type": "text",
            "text": "research about larry ellison"
        }
    ]
}
```

**Compressed User Message:**
```python
{
    "role": "user",
    "content": "research about larry ellison... (truncated)\n\nmessage_id \"uuid\"\nUse expand-message tool to see full content"
}
```

---

### 3. Assistant Messages

**Without Tool Calls:**
```python
{
    "role": "assistant",
    "content": "I'll conduct a comprehensive research on Larry Ellison for you.",
    "message_id": "uuid-string"
}
```

**With Tool Calls (Native Tool Calling):**
```python
{
    "role": "assistant",
    "content": "I'll conduct a comprehensive research on Larry Ellison for you.",
    "tool_calls": [
        {
            "id": "tooluse_FLTrjOjmSQmzWZCwoun-IA",
            "type": "function",
            "function": {
                "name": "web_search",
                "arguments": "{\"query\": \"Larry Ellison biography\", \"num_results\": 10}"
            }
        },
        {
            "id": "tooluse_5ZHGh5jGQLq0xSREXP7yWw",
            "type": "function",
            "function": {
                "name": "web_search",
                "arguments": "{\"query\": \"Larry Ellison Oracle founder\", \"num_results\": 10}"
            }
        }
    ],
    "message_id": "uuid-string"
}
```

**Key Points:**
- `tool_calls` is a list of tool call objects
- Each tool call has an `id` (unique identifier)
- `arguments` is a **JSON string**, not a dict (this is important!)
- Multiple tool calls can be in a single assistant message

---

### 4. Tool Result Messages

**Database:**
```json
{
    "type": "tool",
    "content": {
        "role": "tool",
        "tool_call_id": "tooluse_FLTrjOjmSQmzWZCwoun-IA",
        "name": "web_search",
        "content": "{\"query\": \"Larry Ellison biography\", \"answer\": \"...\", ...}"
    },
    "metadata": {
        "tool_call_id": "tooluse_FLTrjOjmSQmzWZCwoun-IA"
    }
}
```

**LLM Format:**
```python
{
    "role": "tool",
    "tool_call_id": "tooluse_FLTrjOjmSQmzWZCwoun-IA",
    "name": "web_search",
    "content": "{\"query\": \"Larry Ellison biography\", \"answer\": \"...\", ...}"
}
```

**Key Points:**
- `tool_call_id` must match the `id` from the corresponding assistant message's `tool_calls`
- `name` should match the function name from the tool call
- `content` is typically a JSON string with the tool result data

---

## Content Format Variations

### String Content (Simple)
```python
{
    "role": "user",
    "content": "Hello, how are you?"
}
```

### List Content (Anthropic Format)
```python
{
    "role": "user",
    "content": [
        {
            "type": "text",
            "text": "Hello, how are you?"
        }
    ]
}
```

### List Content with Cache Control (Cached Blocks)
```python
{
    "role": "user",
    "content": [
        {
            "type": "text",
            "text": "User: conduct a research of larry ellison\n\nAssistant: I'll conduct...\n\nTool: {...}",
            "cache_control": {
                "type": "ephemeral"
            }
        }
    ]
}
```

**Detection:** A message is a cached block if `content` is a list and any block has `cache_control`.

---

## Cached Blocks Format

Cached blocks are created by `format_conversation_for_cache()` which converts multiple messages into a single text block:

**Input Messages:**
```python
[
    {"role": "user", "content": "research about larry ellison"},
    {"role": "assistant", "content": "I'll conduct...", "tool_calls": [...]},
    {"role": "tool", "tool_call_id": "...", "content": "..."}
]
```

**Cached Block Output:**
```python
{
    "role": "user",
    "content": [
        {
            "type": "text",
            "text": "User: research about larry ellison\n\nAssistant: I'll conduct...\n\nTool: {...}",
            "cache_control": {"type": "ephemeral"}
        }
    ]
}
```

**Key Characteristics:**
- Always `role: "user"` (even though it contains assistant/tool content)
- Contains formatted conversation history as plain text
- Has `cache_control: {"type": "ephemeral"}` in content blocks
- May contain "Tool: {" patterns (this is why filtering was too aggressive before)

---

## Tool Call & Result Formats

### Tool Call Format (in Assistant Message)

```python
{
    "id": "tooluse_FLTrjOjmSQmzWZCwoun-IA",  # Unique identifier
    "type": "function",  # Always "function" for native tool calling
    "function": {
        "name": "web_search",  # Function name
        "arguments": "{\"query\": \"Larry Ellison\", \"num_results\": 10}"  # JSON STRING
    }
}
```

**Critical:** `arguments` is a **JSON string**, not a dict! This is how Bedrock/Anthropic APIs expect it.

### Tool Result Format

```python
{
    "role": "tool",
    "tool_call_id": "tooluse_FLTrjOjmSQmzWZCwoun-IA",  # Must match tool call id
    "name": "web_search",  # Function name
    "content": "{\"query\": \"Larry Ellison\", \"answer\": \"...\", \"images\": [...]}"  # Result as string
}
```

**Matching Rules:**
- `tool_call_id` in tool result must match `id` in tool call
- `name` should match `function.name` from tool call
- Tool result must come **after** the assistant message with tool calls

---

## Message Transformation Flow

### 1. Database → LLM Messages

**Step 1: Load from Database**
```python
# Database row
{
    "type": "user",
    "content": "{\"role\": \"user\", \"content\": \"Hello\"}",
    "is_llm_message": true
}
```

**Step 2: Parse Content**
```python
# If content is JSON string, parse it
parsed = json.loads(content)
# Result: {"role": "user", "content": "Hello"}
```

**Step 3: Handle Compression**
```python
# If compressed, use compressed_content
if metadata.get("compressed"):
    content = metadata.get("compressed_content")  # Plain string
    role = original_type  # Map "user" → "user", "assistant" → "assistant"
```

**Step 4: Format for LLM**
```python
{
    "role": "user",
    "content": "Hello",
    "message_id": "uuid"
}
```

### 2. After Caching

**Before Caching:**
```python
[
    {"role": "user", "content": "Hello"},
    {"role": "assistant", "content": "Hi!", "tool_calls": [...]},
    {"role": "tool", "tool_call_id": "...", "content": "..."}
]
```

**After Caching (with cached blocks):**
```python
[
    {"role": "system", "content": "..."},
    {
        "role": "user",
        "content": [{"type": "text", "text": "User: Hello\n\nAssistant: Hi!\n\nTool: {...}", "cache_control": {"type": "ephemeral"}}]
    },
    {"role": "user", "content": "New message"}  # New messages after cache
]
```

### 3. Filtering for Bedrock

**Before Filtering:**
```python
[
    {"role": "user", "content": [{"type": "text", "text": "Tool: {...}", "cache_control": {...}}]},  # Cached block
    {"role": "user", "content": "Tool: {...}"}  # New message with embedded tool result
]
```

**After Filtering:**
```python
[
    {"role": "user", "content": [{"type": "text", "text": "Tool: {...}", "cache_control": {...}}]},  # ✅ Preserved (cached block)
    # ❌ Second message filtered out (embedded tool result without matching tool call)
]
```

---

## Common Patterns & Gotchas

### 1. Content Type Confusion

**Problem:** Content can be `str`, `list`, or `dict` depending on context.

**Solution:** Always check type:
```python
if isinstance(content, str):
    # Handle string
elif isinstance(content, list):
    # Handle list (Anthropic format or cached blocks)
    for block in content:
        if block.get('cache_control'):
            # It's a cached block!
elif isinstance(content, dict):
    # Handle dict (rare, usually parsed from JSON string)
```

### 2. Tool Call Arguments Format

**Problem:** `arguments` in tool calls is a JSON **string**, not a dict.

**Correct:**
```python
"arguments": "{\"query\": \"Larry Ellison\", \"num_results\": 10}"
```

**Incorrect:**
```python
"arguments": {"query": "Larry Ellison", "num_results": 10}  # ❌ Wrong!
```

### 3. Cached Blocks vs New Messages

**Problem:** Cached blocks contain "Tool: {" patterns that look like embedded tool results.

**Solution:** Check for `cache_control`:
```python
def _is_cached_block(msg):
    content = msg.get('content', '')
    if isinstance(content, list):
        for block in content:
            if isinstance(block, dict) and block.get('cache_control'):
                return True
    return False
```

### 4. Tool Call ID Matching

**Problem:** Tool results must have matching `tool_call_id`.

**Solution:** Track pending tool calls:
```python
pending_tool_call_ids = {tc['id'] for tc in assistant_msg['tool_calls']}
# Later, check:
if tool_result['tool_call_id'] in pending_tool_call_ids:
    # ✅ Valid match
```

---

## Summary

| Aspect | Format | Notes |
|--------|--------|-------|
| **Database Storage** | JSON string or plain string | `content` field can be either |
| **LLM API** | Dict with `role` and `content` | Standardized format |
| **Content Types** | `str` \| `list[dict]` | List format for Anthropic/caching |
| **Tool Calls** | `arguments` is JSON **string** | Not a dict! |
| **Cached Blocks** | `role: "user"` with `cache_control` | Contains formatted conversation history |
| **Tool Results** | Must match `tool_call_id` | Comes after assistant message |

---

## Related Files

- `backend/core/agentpress/thread_manager.py` - Message loading and filtering
- `backend/core/agentpress/response_processor.py` - Tool call/result creation
- `backend/core/agentpress/prompt_caching.py` - Cached block creation
- `MESSAGE_STRUCTURES.md` - This document

