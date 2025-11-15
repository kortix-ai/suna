# Tool Result Display Fix

## Problem
Tool results were not displaying properly in the side panel for native tool calling format. The issue was that tool result content was stored as a JSON wrapper object, but the frontend was passing the entire JSON string to tool views instead of extracting the actual content.

## Root Cause
For native tool calls, the backend stores tool results in this format:
```json
{
  "role": "tool",
  "tool_call_id": "tooluse_123",
  "name": "web_search",
  "content": "actual tool output here"
}
```

The frontend was storing `resultMessage.content` (the entire JSON string) instead of extracting the `content` field value. This caused tool views to receive:
```json
"{\"role\": \"tool\", \"tool_call_id\": \"...\", \"name\": \"...\", \"content\": \"actual output\"}"
```

Instead of just:
```
"actual output"
```

## Solution

### 1. Updated Tool Result Content Extraction
**Files Modified:**
- `frontend/src/hooks/threads/page/use-thread-tool-calls.ts`
- `frontend/src/app/share/[threadId]/page.tsx`

**Changes:**
- Added logic to extract the actual `content` field from native tool result format
- Check if the parsed content has `role === 'tool'` and extract the `content` field
- Use the extracted content instead of the raw JSON string when building tool pairs

**Code Pattern:**
```typescript
let extractedToolContent = resultMessage.content;

// Extract actual content from native tool result format
try {
  const parsed = safeJsonParse<ParsedContent>(resultMessage.content, {});
  // If it's a native tool format with role and content, extract the content
  if (parsed.role === 'tool' && parsed.content !== undefined) {
    // The content field contains the actual tool output
    extractedToolContent = typeof parsed.content === 'string' 
      ? parsed.content 
      : JSON.stringify(parsed.content);
  }
} catch {
  // If parsing fails, use original content
}

// Use extractedToolContent instead of resultMessage.content
toolResult: {
  content: extractedToolContent, // ✅ Extracted content
  isSuccess: isSuccess,
  timestamp: resultMessage.created_at,
}
```

### 2. Enhanced Tool Result Parser
**File Modified:**
- `frontend/src/components/thread/tool-views/tool-result-parser.ts`

**Changes:**
- Added specific handling for native tool format: `{"role": "tool", "tool_call_id": "...", "name": "...", "content": "..."}`
- Extracts the `content` field and recursively parses it if it's nested JSON
- Preserves tool name and tool_call_id from the wrapper

## Result

✅ **Tool results now display correctly in the side panel**
- Native tool call results show their actual output
- Tool views receive the correct content format
- Backward compatible with old format
- Works for both single and multiple tool calls

## Testing

Verify that:
- [x] Tool results display their output in the side panel
- [x] Native tool calling format is properly parsed
- [x] Legacy format still works
- [x] Multiple tool calls all show their results
- [x] Tool result content is readable (not JSON wrapper)

## Files Changed

1. `frontend/src/hooks/threads/page/use-thread-tool-calls.ts`
   - Extract content from native tool format (2 locations)

2. `frontend/src/app/share/[threadId]/page.tsx`
   - Extract content from native tool format (2 locations)

3. `frontend/src/components/thread/tool-views/tool-result-parser.ts`
   - Added native tool format parsing

