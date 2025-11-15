# Complete End-to-End Flow: LLM Streaming → Native Tool Calling → Results

## Table of Contents
1. [High-Level Overview](#high-level-overview)
2. [Phase 1: Request Preparation](#phase-1-request-preparation)
3. [Phase 2: LLM API Call](#phase-2-llm-api-call)
4. [Phase 3: Streaming Response Processing](#phase-3-streaming-response-processing)
5. [Phase 4: Delta/Chunk Handling](#phase-4-deltachunk-handling)
6. [Phase 5: Native Tool Call Accumulation](#phase-5-native-tool-call-accumulation)
7. [Phase 6: Tool Execution](#phase-6-tool-execution)
8. [Phase 7: Tool Result Handling](#phase-7-tool-result-handling)
9. [Phase 8: Message Saving & Thread Management](#phase-8-message-saving--thread-management)
10. [Phase 9: Auto-Continue & Loop](#phase-9-auto-continue--loop)

---

## High-Level Overview

```
User Request
    ↓
ThreadManager._execute_run()
    ↓
1. Fetch & Filter Messages
2. Apply Compression
3. Apply Caching
4. Filter Again (post-caching)
    ↓
make_llm_api_call() → Streaming Response
    ↓
ResponseProcessor.process_streaming_response()
    ↓
For Each Chunk:
    - Extract content deltas → accumulate text
    - Extract tool_call deltas → accumulate tool calls
    - When tool call complete → execute tool (parallel)
    ↓
After Stream Ends:
    - Save assistant message with tool_calls
    - Wait for pending tool executions
    - Save tool results
    - Yield all messages
    ↓
Auto-Continue? → Loop back to _execute_run()
```

---

## Phase 1: Request Preparation

**Location:** `thread_manager.py` → `_execute_run()`

### Step 1.1: Fetch Messages from Database
```python
messages = await self.get_llm_messages(thread_id)
```
- Fetches all messages for the thread
- **CRITICAL:** Preserves original message types (`tool`, `assistant`, `user`)
- Extracts `tool_call_id` from metadata for compressed tool messages
- Maps database `type` to LLM `role` correctly

### Step 1.2: Pre-Compression Filtering
```python
messages = self._filter_tool_results_for_bedrock(messages, llm_model, stage="before compression")
```
- Removes orphaned tool results (no matching tool calls)
- Removes USER messages with embedded tool results (no matching tool calls)
- Reduces token count before compression

### Step 1.3: Context Compression
```python
compressed_messages = await context_manager.compress_messages(...)
```
- Compresses old messages to save tokens
- May embed tool results into USER messages as text
- May remove assistant messages with tool_calls
- **Preserves `tool_call_id` in metadata** for tool messages

### Step 1.4: Post-Compression Filtering
```python
messages = self._filter_tool_results_for_bedrock(messages, llm_model, stage="after compression")
```
- **CRITICAL:** Catches issues created by compression
- Removes embedded tool results in USER messages
- Removes orphaned tool results

### Step 1.5: Apply Prompt Caching
```python
prepared_messages = await apply_anthropic_caching_strategy(...)
```
- Groups messages into cacheable blocks
- Converts content to Anthropic format: `[{"type": "text", "text": "..."}]`
- Loads cached blocks from database if available

### Step 1.6: Post-Caching Filtering
```python
filtered_messages = self._filter_tool_results_for_bedrock(messages_to_filter, llm_model, stage="after caching")
```
- **CRITICAL:** Filters cached blocks
- Cached blocks may contain problematic messages from before the fix
- Detection handles list content format: `[{"type": "text", "text": "Tool: {...}"}]`

### Step 1.7: Prepare Tool Schemas
```python
openapi_tool_schemas = self.tool_registry.get_openapi_schemas()
```
- Gets OpenAPI schemas for all available tools
- These are passed to the LLM so it knows what tools it can call

---

## Phase 2: LLM API Call

**Location:** `services/llm.py` → `make_llm_api_call()`

### Step 2.1: Prepare Parameters
```python
params = model_manager.get_litellm_params(resolved_model_name, ...)
_add_tools_config(params, tools, tool_choice)
```
- Configures LiteLLM parameters
- Adds tools and tool_choice to params
- Sets `stream=True` and `stream_options={"include_usage": True}`

### Step 2.2: Make Streaming Call
```python
response = await provider_router.acompletion(**params)
return _wrap_streaming_response(response)
```
- Calls LiteLLM router (handles multiple providers)
- Returns async generator that yields chunks
- Each chunk contains deltas (content, tool_calls, etc.)

---

## Phase 3: Streaming Response Processing

**Location:** `response_processor.py` → `process_streaming_response()`

### Step 3.1: Initialize State
```python
accumulated_content = ""  # Text content from LLM
tool_calls_buffer = {}    # Index → partial tool call data
executed_tool_call_indices = set()  # Track which tools executed
pending_tool_executions = []  # Async tasks for tool execution
```

### Step 3.2: Start Events
```python
# Yield thread_run_start
# Yield llm_response_start
```
- Sends status messages to frontend
- Tracks thread_run_id and llm_response_id

### Step 3.3: Process Chunks Loop
```python
async for chunk in llm_response:
    # Process each chunk...
```

---

## Phase 4: Delta/Chunk Handling

**Location:** `response_processor.py` → `process_streaming_response()` → chunk loop

### Step 4.1: Extract Delta
```python
delta = chunk.choices[0].delta
```
- Each chunk contains a `delta` object
- Delta has: `content`, `tool_calls`, `reasoning_content`, etc.

### Step 4.2: Handle Content Delta
```python
if delta and hasattr(delta, 'content') and delta.content:
    chunk_content = delta.content
    accumulated_content += chunk_content
    
    # Yield content chunk to frontend
    yield {
        "type": "assistant",
        "content": {"role": "assistant", "content": chunk_content},
        "metadata": {"stream_status": "chunk"}
    }
```
- Accumulates text content character by character
- Yields each chunk immediately to frontend (for real-time display)
- **Note:** Content chunks are NOT saved to DB (only final message is saved)

### Step 4.3: Handle Reasoning Content (Anthropic Thinking)
```python
if delta and hasattr(delta, 'reasoning_content'):
    reasoning_content = delta.reasoning_content
    accumulated_content += reasoning_content
```
- Anthropic models can output "thinking" content
- This is appended to the main content

---

## Phase 5: Native Tool Call Accumulation

**Location:** `response_processor.py` → `process_streaming_response()` → chunk loop

### Step 5.1: Detect Tool Call Chunks
```python
if delta and hasattr(delta, 'tool_calls') and delta.tool_calls:
    for tool_call_chunk in delta.tool_calls:
        # Process tool call chunk...
```

### Step 5.2: Extract Chunk Data
```python
idx = tool_call_chunk.index  # Which tool call (0, 1, 2, ...)
tool_call_chunk.id           # Partial ID (e.g., "tooluse_")
tool_call_chunk.function.name  # Partial name (e.g., "web_sea")
tool_call_chunk.function.arguments  # Partial JSON (e.g., '{"query":')
```

**Key Insight:** Tool calls come in **multiple chunks**:
- Chunk 1: `id="tooluse_"`, `name="web_sea"`, `arguments='{"query":'`
- Chunk 2: `id="Cv-DQ"`, `name="rch"`, `arguments=' "larry'`
- Chunk 3: `id="MVLSD"`, `name=""`, `arguments=' ellison"}'`
- Final: `id="tooluse_Cv-DQMVLSD"`, `name="web_search"`, `arguments='{"query": "larry ellison"}'`

### Step 5.3: Initialize Buffer Entry
```python
if idx not in tool_calls_buffer:
    tool_calls_buffer[idx] = {
        'id': '',
        'type': 'function',
        'function': {
            'name': '',
            'arguments': ''
        }
    }
```

### Step 5.4: Accumulate Chunks
```python
# Append ID chunks
tool_calls_buffer[idx]['id'] += tool_call_chunk.id

# Append name chunks
tool_calls_buffer[idx]['function']['name'] += tool_call_chunk.function.name

# Append arguments chunks (CRITICAL: string concatenation)
tool_calls_buffer[idx]['function']['arguments'] += tool_call_chunk.function.arguments
```

**Critical Point:** Arguments are accumulated by **string concatenation**. If Bedrock sends malformed chunks, this creates invalid JSON.

### Step 5.5: Yield Tool Call Chunk (for frontend)
```python
yield {
    "type": "status",
    "content": {
        "role": "assistant",
        "status_type": "tool_call_chunk",
        "tool_call_chunk": tool_call_data_chunk
    }
}
```
- Frontend can show "Calling web_search..." in real-time
- This is **transient** (not saved to DB)

### Step 5.6: Detect Complete Tool Call
```python
if (tool_calls_buffer[idx]['id'] and
    tool_calls_buffer[idx]['function']['name'] and
    tool_calls_buffer[idx]['function']['arguments']):
    try:
        parsed_args = safe_json_parse(raw_args_str)
        has_complete_tool_call = True
        
        # CRITICAL: Check for malformed arguments
        if isinstance(parsed_args, dict):
            for key, value in parsed_args.items():
                if isinstance(value, str) and value.startswith('{"'):
                    # Double-encoded JSON detected!
                    fixed_value = json.loads(value)
                    parsed_args[key] = fixed_value
```

**Validation Logic:**
1. Check if we have ID, name, and arguments
2. Try to parse arguments as JSON
3. If parse succeeds → tool call is complete
4. **Check for double-encoding** (e.g., `{"query": "{\"query\""}`)
5. **Auto-fix** double-encoded values

---

## Phase 6: Tool Execution

**Location:** `response_processor.py` → `process_streaming_response()` → chunk loop

### Step 6.1: Execute on Stream (if enabled)
```python
if has_complete_tool_call and config.execute_on_stream:
    tool_call_data = {
        "function_name": current_tool['function']['name'],
        "arguments": final_args,  # Fixed arguments
        "id": current_tool['id']
    }
    
    # Create async task
    execution_task = asyncio.create_task(self._execute_tool(tool_call_data))
    pending_tool_executions.append({
        "task": execution_task,
        "tool_call": tool_call_data,
        "tool_index": tool_index
    })
```

**Key Points:**
- Tools execute **in parallel** (async tasks)
- Execution happens **during streaming** (don't wait for stream to end)
- Multiple tools can execute simultaneously

### Step 6.2: Tool Execution Details
**Location:** `response_processor.py` → `_execute_tool()`

```python
async def _execute_tool(self, tool_call: Dict[str, Any]) -> ToolResult:
    function_name = tool_call['function_name']
    arguments = tool_call['arguments']
    
    # Get tool function from registry
    tool_fn = available_functions[function_name]
    
    # Parse arguments
    if isinstance(arguments, str):
        parsed_args = safe_json_parse(arguments)
        # Check for double-encoding again
        # Fix if needed
    
    # Execute tool
    result = await tool_fn(**parsed_args)
    
    # Validate result
    if not isinstance(result, ToolResult):
        result = ToolResult(success=False, output="Invalid result")
    
    return result
```

**Tool Execution Flow:**
1. Look up tool function from registry
2. Parse arguments (handle string/dict)
3. **Check for double-encoding** (same check as during accumulation)
4. Call tool function with parsed arguments
5. Return `ToolResult` object

### Step 6.3: Save Tool Started Status
```python
started_msg_obj = await self._yield_and_save_tool_started(context, thread_id, thread_run_id)
yield format_for_yield(started_msg_obj)
```
- Saves `tool_started` status message to DB
- Yields to frontend (shows "Executing web_search...")

---

## Phase 7: Tool Result Handling

**Location:** `response_processor.py` → `process_streaming_response()` → after stream ends

### Step 7.1: Wait for Pending Executions
```python
if pending_tool_executions:
    pending_tasks = [execution["task"] for execution in pending_tool_executions]
    done, _ = await asyncio.wait(pending_tasks)
    
    for execution in pending_tool_executions:
        if execution["task"].done():
            result = execution["task"].result()
            tool_results_buffer.append((tool_call, result, tool_idx, context))
```

- Waits for all async tool execution tasks to complete
- Collects results into `tool_results_buffer`

### Step 7.2: Save Tool Results
```python
for tool_call, result, tool_idx, context in tool_results_buffer:
    # Save tool result message
    tool_message = {
        "role": "tool",
        "tool_call_id": tool_call["id"],
        "name": function_name,
        "content": result.output
    }
    
    message_obj = await self.add_message(
        thread_id=thread_id,
        type="tool",
        content=tool_message,
        is_llm_message=True,
        metadata={"assistant_message_id": assistant_message_id}
    )
    
    # Yield to frontend
    yield format_for_yield(message_obj)
```

**Tool Result Message Structure:**
```json
{
  "role": "tool",
  "tool_call_id": "tooluse_Cv-DQMVLSD",
  "name": "web_search",
  "content": "{\"query\": \"larry ellison\", \"answer\": \"...\"}"
}
```

### Step 7.3: Save Tool Completed Status
```python
completed_msg_obj = await self._yield_and_save_tool_completed(context, ...)
yield format_for_yield(completed_msg_obj)
```
- Saves `tool_completed` status message
- Yields to frontend (shows "web_search completed")

---

## Phase 8: Message Saving & Thread Management

**Location:** `response_processor.py` → `process_streaming_response()` → after stream ends

### Step 8.1: Extract Complete Tool Calls from Buffer
```python
complete_native_tool_calls = []
for idx, tc_buf in tool_calls_buffer.items():
    if tc_buf['id'] and tc_buf['function']['name'] and tc_buf['function']['arguments']:
        args = safe_json_parse(tc_buf['function']['arguments'])
        tool_call_obj = {
            "id": tc_buf['id'],
            "type": "function",
            "function": {
                "name": tc_buf['function']['name'],
                "arguments": args  # Parsed object, not string
            }
        }
        complete_native_tool_calls.append(tool_call_obj)
```

**Why Extract Again?**
- Some tool calls may not have executed during streaming
- Need complete list for saving assistant message
- Arguments are parsed as objects (not strings)

### Step 8.2: Save Assistant Message
```python
message_data = {
    "role": "assistant",
    "content": accumulated_content,
    "tool_calls": complete_native_tool_calls if complete_native_tool_calls else None
}

last_assistant_message_object = await self._add_message_with_agent_info(
    thread_id=thread_id,
    type="assistant",
    content=message_data,
    is_llm_message=True,
    metadata={"thread_run_id": thread_run_id}
)
```

**Assistant Message Structure:**
```json
{
  "role": "assistant",
  "content": "I'll research Larry Ellison for you.",
  "tool_calls": [
    {
      "id": "tooluse_Cv-DQMVLSD",
      "type": "function",
      "function": {
        "name": "web_search",
        "arguments": {"query": "larry ellison"}
      }
    }
  ]
}
```

### Step 8.3: Save LLM Response End
```python
llm_end_content = {
    "llm_response_id": llm_response_id,
    "usage": final_llm_response.usage,
    "model": final_llm_response.model,
    "finish_reason": finish_reason
}

await self.add_message(
    thread_id=thread_id,
    type="llm_response_end",
    content=llm_end_content,
    is_llm_message=False
)
```
- Saves token usage and model info
- Used for fast-path compression checks

---

## Phase 9: Auto-Continue & Loop

**Location:** `response_processor.py` → `process_streaming_response()` → end

### Step 9.1: Check if Auto-Continue Needed
```python
should_auto_continue = (can_auto_continue and finish_reason == 'length')
```

**Auto-Continue Triggers:**
- `finish_reason == 'length'` (hit token limit)
- `can_auto_continue == True` (enabled in config)
- Not cancelled by user

### Step 9.2: Prepare Next Turn
```python
if should_auto_continue:
    continuous_state = {
        'accumulated_content': accumulated_content,
        'thread_run_id': thread_run_id,
        'sequence': __sequence
    }
    
    # Add tool results to messages
    for tool_call, result, tool_idx, context in tool_results_buffer:
        await self._add_tool_result(...)
    
    # Recursively call process_streaming_response again
    async for msg in self.process_streaming_response(...):
        yield msg
```

**Auto-Continue Flow:**
1. Save accumulated content (partial response)
2. Add tool results to conversation
3. Call `_execute_run()` again with same thread_id
4. LLM continues from where it left off

---

## Critical Details & Edge Cases

### 1. Double-Encoding Detection
**Problem:** Bedrock may send malformed arguments:
```json
{"query": "{\"query\""}  // Invalid!
```

**Solution:** Detect and fix:
```python
if isinstance(value, str) and value.startswith('{"'):
    fixed_value = json.loads(value)
    parsed_args[key] = fixed_value
```

### 2. Tool Call Accumulation
**Problem:** Arguments come in chunks, need to concatenate:
```python
tool_calls_buffer[idx]['function']['arguments'] += chunk.arguments
```

**Validation:** Try parsing JSON to detect completeness:
```python
try:
    parsed_args = safe_json_parse(raw_args_str)
    has_complete_tool_call = True
except json.JSONDecodeError:
    # Still accumulating...
```

### 3. Parallel Tool Execution
**Implementation:** Use async tasks:
```python
execution_task = asyncio.create_task(self._execute_tool(tool_call_data))
pending_tool_executions.append({"task": execution_task, ...})
```

**Wait for completion:**
```python
done, _ = await asyncio.wait(pending_tasks)
```

### 4. Message Filtering (Bedrock Compatibility)
**Problem:** Bedrock requires 1:1 matching between `toolUse` and `toolResult` blocks.

**Solution:** Filter at multiple stages:
1. **Pre-compression:** Remove obvious orphans
2. **Post-compression:** Catch compression-created issues
3. **Post-caching:** Filter cached blocks

**Detection:** Check for embedded tool results in USER messages:
```python
def _contains_embedded_tool_result(self, msg):
    content = msg.get('content', '')
    # Handle list format: [{"type": "text", "text": "Tool: {...}"}]
    if isinstance(content, list):
        content_text = ' '.join(block.get('text', '') for block in content)
    # Check for patterns
    if re.search(r'Tool:\s*\{', content_text):
        return True
```

### 5. Tool Result Matching
**Problem:** Tool results must match tool calls by `tool_call_id`.

**Solution:** Track pending tool calls:
```python
pending_tool_call_ids = {tc.get('id') for tc in tool_calls}

# When processing tool result:
if tool_call_id in pending_tool_call_ids:
    # Match! Include this result
    filtered_messages.append(msg)
else:
    # Orphan! Filter out
    logger.warning("Filtering out orphaned tool result")
```

---

## Data Flow Summary

```
LLM Stream Chunks
    ↓
Delta Extraction
    ├─ Content → accumulated_content
    └─ Tool Calls → tool_calls_buffer[idx]
         ↓
    Complete Tool Call Detected
         ↓
    Execute Tool (async task)
         ↓
    Tool Result
         ↓
    Save Tool Message (type="tool")
         ↓
    Yield to Frontend

After Stream Ends:
    accumulated_content → Save Assistant Message
    tool_calls_buffer → Extract complete_native_tool_calls
    tool_results_buffer → Save Tool Result Messages
         ↓
    All Messages Saved to DB
         ↓
    Auto-Continue? → Loop back
```

---

## Key Data Structures

### `tool_calls_buffer`
```python
{
    0: {
        'id': 'tooluse_Cv-DQMVLSD',
        'type': 'function',
        'function': {
            'name': 'web_search',
            'arguments': '{"query": "larry ellison"}'
        }
    },
    1: {
        'id': 'tooluse_iSUeHzwST',
        'type': 'function',
        'function': {
            'name': 'web_search',
            'arguments': '{"query": "..."}'
        }
    }
}
```

### `pending_tool_executions`
```python
[
    {
        "task": <asyncio.Task>,
        "tool_call": {
            "function_name": "web_search",
            "arguments": {"query": "larry ellison"},
            "id": "tooluse_Cv-DQMVLSD"
        },
        "tool_index": 0,
        "context": <ToolExecutionContext>
    }
]
```

### `tool_results_buffer`
```python
[
    (
        tool_call,  # Original tool call dict
        result,     # ToolResult object
        tool_idx,   # Index (0, 1, 2, ...)
        context     # ToolExecutionContext
    ),
    ...
]
```

---

## Error Handling

### Streaming Errors
- Wrapped in `_wrap_streaming_response()`
- Converted to `LLMError`
- Logged via `ErrorProcessor`

### Tool Execution Errors
- Caught in `_execute_tool()`
- Return `ToolResult(success=False, output=error_message)`
- Saved as `tool_failed` status message

### Argument Parsing Errors
- Double-encoding detected and fixed
- Invalid JSON logged but tool still executes with raw string
- Fallback to string arguments if parsing fails

---

## Performance Optimizations

1. **Parallel Tool Execution:** Tools execute simultaneously, not sequentially
2. **Streaming Execution:** Tools execute during streaming, not after
3. **Fast-Path Compression:** Skip compression if under token threshold
4. **Prompt Caching:** Reuse cached blocks to save tokens
5. **Incremental Accumulation:** Process chunks as they arrive

---

This is the complete end-to-end flow! Every piece fits together to handle streaming LLM responses, accumulate tool calls, execute tools in parallel, and manage the conversation thread.

