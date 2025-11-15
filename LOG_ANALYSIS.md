# Log Analysis: Bedrock Tool Calling Error - Step by Step

## The Problem Flow

### Step 1: Initial Setup (Lines 351-352)
```
✅ Cache validation passed: 4 conversation blocks
🔧 NATIVE TOOL CALLING: Passing 87 tools to LLM
```
- System is ready, tools are configured
- **Status**: ✅ Normal

---

### Step 2: Langfuse Validation Errors (Lines 353-533)
```
90 validation errors for UpdateGenerationBody
modelParameters -> tools -> str type expected
```
- **What's happening**: Langfuse (observability tool) is complaining about tool format
- **Impact**: ⚠️ Non-critical - just a logging/observability issue
- **Status**: Can be ignored for now

---

### Step 3: Message Preparation (Line 720)
```
📤 Sending 6 prepared messages to LLM
```
- **What's happening**: About to send 6 messages to Bedrock
- **Status**: ✅ Normal

---

### Step 4: Message Breakdown Analysis (Lines 721-731)

#### Message [0] - SYSTEM (Line 722)
```
[0] SYSTEM: [{'type': 'text', 'text': 'You are Suna.so...'}]
```
- **Status**: ✅ Normal system prompt

#### Message [1] - USER (Line 723)
```
[1] USER: [{'type': 'text', 'text': "User: research about larry ellison\n\nAssistant: I'll research..."}]
```
- **What's happening**: This is COMPRESSED content from context compression
- The compression merged multiple messages into one USER message
- **Status**: ⚠️ This contains conversation history

#### Message [2] - USER (Line 724) ⚠️ **PROBLEM HERE**
```
[2] USER: [{'type': 'text', 'text': 'Tool: {"query": "{\\"query\\":", "follow_up_questions": null, "answer": "A query is..."}'}]
```
- **What's happening**: This USER message contains **tool result text embedded in it**
- This came from context compression converting tool result messages into USER messages
- **Status**: ❌ **THIS IS THE PROBLEM**

#### Message [3] - USER (Line 725) ⚠️ **PROBLEM HERE**
```
[3] USER: [{'type': 'text', 'text': 'Tool: {"query": "{\\"quer", "follow_up_questions": null...}'}]
```
- **What's happening**: Another USER message with embedded tool result text
- **Status**: ❌ **THIS IS ALSO THE PROBLEM**

#### Message [4] - TOOL RESULT (Lines 726-727)
```
[4] TOOL RESULT: tool_call_id=tooluse_kV5wJbJwQtGRG9KgtcIGHA, name=web_search
Full tool message structure: {"name": "web_search", "role": "tool", "content": "Error performing web search...", "tool_call_id": "tooluse_kV5wJbJwQtGRG9KgtcIGHA"}
```
- **What's happening**: This is a proper tool result message
- **Status**: ✅ Correct format, but...

#### Message [5] - TOOL RESULT (Lines 728-729)
```
[5] TOOL RESULT: tool_call_id=tooluse_GN4zO81ETiqeAvYlyNJwbw, name=web_search
```
- **What's happening**: Another proper tool result message
- **Status**: ✅ Correct format, but...

---

### Step 5: The Critical Summary (Line 730-731)
```
📊 NATIVE TOOL CALLING: Summary - 0 assistant msgs, 0 tool_calls, 2 tool results
⚠️ NATIVE TOOL CALLING: MISMATCH! tool_calls=0 but tool_results=2
```

**THIS IS THE ROOT CAUSE:**

1. **0 assistant msgs with tool_calls**: The assistant message that made the tool calls was **compressed away** or **not included**
2. **2 tool results**: We have 2 tool result messages (messages [4] and [5])
3. **Plus 2 USER messages with embedded tool results**: Messages [2] and [3] contain tool result text

**What Bedrock sees:**
- Messages [2] and [3] are USER messages, but LiteLLM converts them to Bedrock format
- When LiteLLM sees tool result content in USER messages, it creates `toolResult` blocks
- Messages [4] and [5] are also converted to `toolResult` blocks
- **But there's NO assistant message with `toolUse` blocks** because it was compressed away!

---

### Step 6: Bedrock Debug Output (Lines 732-756)

Shows the exact structure being sent:
- Message 0: System prompt ✅
- Message 1: Compressed user content ✅
- Message 2: USER message with tool result text embedded ❌

---

### Step 7: The Error (Line 762)
```
BedrockException - {"message":"The number of toolResult blocks at messages.2.content exceeds the number of toolUse blocks of previous turn."}
```

**What Bedrock is saying:**
- "In message [2], I see `toolResult` blocks in the content"
- "But the previous assistant message doesn't have matching `toolUse` blocks"
- "This violates my requirement that tool results must match tool calls exactly"

---

## Root Cause Analysis

### The Problem Chain:

1. **Context Compression** (happens AFTER filtering, line 499-526)
   - Compresses old messages to save tokens
   - Converts tool result messages into USER messages with embedded text
   - May remove assistant messages with tool_calls if they're old

2. **Filtering Happens Too Early** (line 441-492)
   - Filters tool results BEFORE compression
   - But compression creates NEW tool result content in USER messages
   - Filtering doesn't catch these embedded tool results

3. **LiteLLM Conversion**
   - Sees USER messages with tool result text → creates `toolResult` blocks
   - Sees tool result messages → creates `toolResult` blocks
   - But no assistant message with `toolUse` blocks → ERROR

### The Fix Needed:

**Option 1: Filter AFTER compression**
- Move filtering to after compression
- Remove USER messages that contain tool result text if there's no matching assistant message

**Option 2: Don't compress tool results into USER messages**
- Modify compression to skip tool result messages
- Or convert them differently

**Option 3: Remove tool results if no matching assistant message**
- After compression, check if we have tool results without matching tool calls
- Remove them before sending to Bedrock

---

## What's Actually Happening:

```
Original Messages (from DB):
1. USER: "research about larry ellison"
2. ASSISTANT: [with tool_calls for web_search]
3. TOOL RESULT: web_search result 1
4. TOOL RESULT: web_search result 2

After Compression:
1. USER: "research about larry ellison" (compressed)
2. USER: "Tool: {...}" (compressed tool result 1) ← PROBLEM
3. USER: "Tool: {...}" (compressed tool result 2) ← PROBLEM
4. TOOL RESULT: web_search result 1 ← Still here!
5. TOOL RESULT: web_search result 2 ← Still here!

Missing: ASSISTANT message with tool_calls (was compressed away)

Result: Bedrock sees tool results but no tool calls → ERROR
```

