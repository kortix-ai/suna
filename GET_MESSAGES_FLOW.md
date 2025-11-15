# GET Messages Flow: Backend to Frontend

This document traces the complete data flow for GET messages from the PostgreSQL database through the backend API to the frontend React components, including all schema transformations and post-processing at each stage.

---

## Flow Overview

```
PostgreSQL Database
    ↓ (Supabase Client)
Backend API (FastAPI)
    ↓ (HTTP/JSON)
Frontend API Client (fetch)
    ↓ (TypeScript types)
Frontend Hooks (React Query + transformation)
    ↓ (UnifiedMessage format)
React Components (parsing + display)
```

---

## Stage 1: PostgreSQL Database

### Schema

**Table:** `messages`

```sql
CREATE TABLE messages (
    message_id UUID PRIMARY KEY,
    thread_id UUID NOT NULL,
    type TEXT NOT NULL,
    is_llm_message BOOLEAN NOT NULL DEFAULT TRUE,
    content JSONB NOT NULL,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE,
    updated_at TIMESTAMP WITH TIME ZONE,
    agent_id UUID,
    agent_version_id UUID
);
```

### Raw Data Example

```json
{
  "message_id": "123e4567-e89b-12d3-a456-426614174000",
  "thread_id": "123e4567-e89b-12d3-a456-426614174001",
  "type": "user",
  "is_llm_message": true,
  "content": "{\"role\": \"user\", \"content\": \"Hello!\"}",
  "metadata": "{}",
  "created_at": "2024-01-01T00:00:00.000Z",
  "updated_at": "2024-01-01T00:00:00.000Z",
  "agent_id": null,
  "agent_version_id": null
}
```

**Key Points:**
- `content` is stored as **JSONB** (PostgreSQL JSON type)
- `metadata` is stored as **JSONB**
- Both can be strings or objects in the database
- Supabase returns them as **strings** when fetched via the client

---

## Stage 2: Backend API (FastAPI)

### Location
`backend/core/threads.py` (lines 357-392)

### Endpoint
```python
@router.get("/threads/{thread_id}/messages")
async def get_thread_messages(
    thread_id: str,
    request: Request,
    order: str = Query("desc")
):
```

### Processing Steps

#### Step 1: Authentication Check
**Purpose:** Ensure the user has permission to access the thread's messages.

**Process:**
- Extracts `user_id` from JWT token in the `Authorization` header
- For public threads, authentication is optional (anonymous access allowed)
- Calls `verify_and_authorize_thread_access()` which:
  - Checks if thread exists
  - Verifies user has access (owner, project member, or public thread)
  - Raises 403/404 if access denied

**Why:** Security layer to prevent unauthorized access to private conversations.

#### Step 2: Database Query (Batched)
**Purpose:** Efficiently fetch all messages without overwhelming the database.

**Process:**
```python
batch_size = 1000
offset = 0
all_messages = []
while True:
    query = client.table('messages').select('*').eq('thread_id', thread_id)
    query = query.order('created_at', desc=(order == "desc"))
    query = query.range(offset, offset + batch_size - 1)
    messages_result = await query.execute()
    batch = messages_result.data or []
    all_messages.extend(batch)
    if len(batch) < batch_size:
        break
    offset += batch_size
```

**Why Batching:**
- Prevents memory issues with very long threads (10,000+ messages)
- Avoids database query timeouts
- More efficient than loading everything at once
- Each batch is 1000 messages, continues until no more data

**Ordering:**
- Default: `desc` (newest first) - useful for pagination
- Frontend requests: `asc` (oldest first) - for chronological display
- Backend respects the `order` query parameter

#### Step 3: Response Format
**Purpose:** Return data in a consistent JSON structure.

**Process:**
```python
return {"messages": all_messages}
```

**Why Wrapped:**
- Consistent API response format
- Allows future metadata (pagination, counts, etc.)
- Easy to extend without breaking changes

### Output Schema

**HTTP Response:**
```json
{
  "messages": [
    {
      "message_id": "123e4567-e89b-12d3-a456-426614174000",
      "thread_id": "123e4567-e89b-12d3-a456-426614174001",
      "type": "user",
      "is_llm_message": true,
      "content": "{\"role\": \"user\", \"content\": \"Hello!\"}",
      "metadata": "{}",
      "created_at": "2024-01-01T00:00:00.000Z",
      "updated_at": "2024-01-01T00:00:00.000Z",
      "agent_id": null,
      "agent_version_id": null
    }
  ]
}
```

**Key Points:**
- No transformation happens here
- Supabase client returns JSONB fields as **strings**
- All fields are returned as-is from the database
- Response is wrapped in `{"messages": [...]}`

---

## Stage 3: Network Transport (HTTP/JSON)

### Request

```http
GET /threads/{thread_id}/messages?order=asc HTTP/1.1
Host: api.example.com
Authorization: Bearer <jwt_token>
Content-Type: application/json
```

### Response

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "messages": [...]
}
```

**Key Points:**
- Standard HTTP/JSON transport
- No schema changes during transport
- Content is UTF-8 encoded JSON

---

## Stage 4: Frontend API Client

### Location
`frontend/src/lib/api/threads.ts` (lines 249-317)

### Function
```typescript
export const getMessages = async (threadId: string): Promise<Message[]>
```

### Processing Steps

#### Step 1: Authentication Setup
**Purpose:** Attach user credentials to the API request.

**Process:**
```typescript
const { data: { session } } = await supabase.auth.getSession();
const headers: Record<string, string> = {
  'Content-Type': 'application/json',
};
if (session?.access_token) {
  headers['Authorization'] = `Bearer ${session?.access_token}`;
}
```

**Why:**
- Backend requires JWT for authenticated requests
- Optional for public threads (anonymous access)
- Session token obtained from Supabase Auth client

#### Step 2: HTTP Request
**Purpose:** Fetch messages from the backend API.

**Process:**
```typescript
const response = await fetch(`${API_URL}/threads/${threadId}/messages?order=asc`, {
  headers,
  cache: 'no-store',  // Always fetch fresh data
});
```

**Why `order=asc`:**
- Frontend needs chronological order (oldest → newest)
- Matches user's mental model of conversation flow
- Easier to render in UI (top to bottom)

**Why `cache: 'no-store'`:**
- Messages are dynamic (new ones added in real-time)
- Prevents stale data from browser cache
- Ensures users see latest messages

#### Step 3: Response Parsing
**Purpose:** Convert HTTP response to JavaScript objects.

**Process:**
```typescript
const data = await response.json();
const allMessages = data.messages || [];
```

**Why:**
- HTTP returns JSON string, needs parsing
- Extract `messages` array from response wrapper
- Fallback to empty array if missing

#### Step 4: Post-Processing - Filtering
**Purpose:** Remove internal/system messages that shouldn't be shown to users.

**Process:**
```typescript
const filteredMessages = allMessages.filter(
  (msg: Message) => msg.type !== 'cost' && msg.type !== 'summary'
);
```

**Filtered Types:**
- `cost`: Internal billing/usage tracking messages
- `summary`: System-generated summaries (if any)

**Why Filter:**
- These are backend-internal messages
- Not part of the actual conversation
- Would clutter the UI if shown
- Backend doesn't filter them (frontend responsibility)

#### Step 5: Post-Processing - Context Usage Extraction
**Purpose:** Extract token usage information for display in UI.

**Process:**
```typescript
const llmResponseEndMessages = filteredMessages.filter(
  (msg: Message) => msg.type === 'llm_response_end'
);
if (llmResponseEndMessages.length > 0) {
  const latestMsg = llmResponseEndMessages[llmResponseEndMessages.length - 1];
  const content = typeof latestMsg.content === 'string' 
    ? JSON.parse(latestMsg.content) 
    : latestMsg.content;
  if (content?.usage?.total_tokens) {
    useContextUsageStore.getState().setUsage(threadId, {
      current_tokens: content.usage.total_tokens
    });
  }
}
```

**Why:**
- `llm_response_end` messages contain token usage stats
- Used to show "Context: X tokens" in UI
- Stored in Zustand store for global access
- Only latest message matters (most recent usage)

### Output Schema

**TypeScript Type:**
```typescript
type Message = {
  role: string;
  content: string;
  type: string;
  agent_id?: string;
  agents?: { name: string; };
  // ... other fields from database
};
```

**Actual Data:**
```typescript
[
  {
    message_id: "123e4567-e89b-12d3-a456-426614174000",
    thread_id: "123e4567-e89b-12d3-a456-426614174001",
    type: "user",
    is_llm_message: true,
    content: "{\"role\": \"user\", \"content\": \"Hello!\"}",  // Still a string
    metadata: "{}",  // Still a string
    created_at: "2024-01-01T00:00:00.000Z",
    updated_at: "2024-01-01T00:00:00.000Z",
    agent_id: null,
    agent_version_id: null
  }
]
```

**Key Points:**
- Messages filtered: `cost` and `summary` types removed
- `content` and `metadata` are still **JSON strings** (not parsed yet)
- Context usage extracted and stored separately
- Returns array of `Message` objects

---

## Stage 5: Frontend Hooks (React Query + Transformation)

### Location
`frontend/src/hooks/threads/page/use-thread-data.ts` (lines 90-126)

### Processing Steps

#### Step 1: React Query Fetch
**Purpose:** Use React Query for caching, refetching, and state management.

**Process:**
```typescript
const messagesQuery = useQuery({
  queryKey: threadKeys.messages(threadId),
  queryFn: () => getMessages(threadId),
});
```

**Why React Query:**
- Automatic caching (prevents duplicate requests)
- Background refetching (keeps data fresh)
- Loading/error states handled automatically
- Query invalidation when messages change
- Optimistic updates support

**Query Key:**
- `threadKeys.messages(threadId)` - unique key per thread
- Allows cache invalidation per thread
- Enables parallel queries for different threads

#### Step 2: Transformation to UnifiedMessage
**Purpose:** Normalize messages to a consistent format used throughout the frontend.

**Process:**
```typescript
const unifiedMessages = (messagesQuery.data || [])
  .filter((msg) => msg.type !== 'status')  // Additional filtering
  .map((msg: ApiMessageType) => ({
    message_id: msg.message_id || null,
    thread_id: msg.thread_id || threadId,
    type: (msg.type || 'system') as UnifiedMessage['type'],
    is_llm_message: Boolean(msg.is_llm_message),
    content: msg.content || '',  // Still a JSON string
    metadata: msg.metadata || '{}',  // Still a JSON string
    created_at: msg.created_at || new Date().toISOString(),
    updated_at: msg.updated_at || new Date().toISOString(),
    agent_id: (msg as any).agent_id,
    agents: (msg as any).agents,
  }));
```

**Transformations:**
1. **Filter `status` messages**: Internal status updates (e.g., "thinking...", "processing...")
2. **Normalize `message_id`**: Convert `undefined` to `null` (consistent nullability)
3. **Ensure `thread_id`**: Fallback to current thread if missing
4. **Type casting**: Ensure `type` matches `UnifiedMessage['type']` union
5. **Boolean conversion**: `is_llm_message` explicitly converted to boolean
6. **Default values**: Empty strings for missing `content`/`metadata`
7. **ISO timestamps**: Ensure valid ISO format (fallback to current time)

**Why:**
- Consistent data structure across components
- Type safety (TypeScript enforces `UnifiedMessage` shape)
- Prevents runtime errors from missing fields
- Easier to work with in components

#### Step 3: Merge with Local Messages
**Purpose:** Combine server messages with optimistic local updates (e.g., user just sent a message).

**Process:**
```typescript
// Get all server message IDs
const serverIds = new Set(
  unifiedMessages.map((m) => m.message_id).filter(Boolean) as string[]
);

// Find local messages not yet on server
const localExtras = (messages || []).filter(
  (m) => !m.message_id ||                    // No ID yet
         m.message_id.startsWith('temp-') ||  // Temporary ID
         !serverIds.has(m.message_id as string)  // Not in server response
);

// Merge and sort chronologically
const mergedMessages = [...unifiedMessages, ...localExtras].sort((a, b) => {
  const aTime = new Date(a.created_at).getTime();
  const bTime = new Date(b.created_at).getTime();
  return aTime - bTime;  // Ascending (oldest first)
});
```

**Why Merge:**
- **Optimistic Updates**: User sends message → shows immediately with `temp-123` ID
- **Server Sync**: When server responds with real message, replace temp one
- **Real-time**: Streaming messages might arrive before server fetch completes
- **UX**: Users see their actions immediately (no waiting for server)

**Why Sort:**
- Ensure chronological order regardless of merge
- Server might return in different order
- Local messages might have different timestamps
- UI expects messages in time order

### Output Schema

**TypeScript Type:**
```typescript
interface UnifiedMessage {
  sequence?: number;
  message_id: string | null;
  thread_id: string;
  type: 'user' | 'assistant' | 'tool' | 'system' | 'status' | 
        'browser_state' | 'image_context' | 'llm_response_end';
  is_llm_message: boolean;
  content: string;  // JSON string
  metadata: string;  // JSON string
  created_at: string;
  updated_at: string;
  agent_id?: string;
  agents?: { name: string; };
}
```

**Actual Data:**
```typescript
[
  {
    message_id: "123e4567-e89b-12d3-a456-426614174000",
    thread_id: "123e4567-e89b-12d3-a456-426614174001",
    type: "user",
    is_llm_message: true,
    content: "{\"role\": \"user\", \"content\": \"Hello!\"}",  // JSON string
    metadata: "{}",  // JSON string
    created_at: "2024-01-01T00:00:00.000Z",
    updated_at: "2024-01-01T00:00:00.000Z",
    agent_id: undefined,
    agents: undefined
  }
]
```

**Key Points:**
- Additional filtering: `status` messages removed
- Normalized to `UnifiedMessage` format
- `content` and `metadata` remain **JSON strings**
- Merged with local optimistic updates
- Sorted by `created_at` ascending

---

## Stage 6: React Components (Parsing + Display)

### Location
`frontend/src/components/thread/content/ThreadContent.tsx` (lines 620-850)

### Processing Steps

#### Step 1: Content Parsing (On-Demand)
**Purpose:** Parse JSON string content into usable objects, only when needed for rendering.

**Process:**
```typescript
const messageContent = (() => {
  try {
    const parsed = safeJsonParse<ParsedContent>(message.content, { 
      content: message.content 
    });
    return parsed.content || message.content;
  } catch {
    return message.content;  // Fallback to raw string
  }
})();
```

**Why Lazy Parsing:**
- Performance: Only parse when actually rendering
- Not all messages need parsing (some are plain text)
- Parsing is expensive for large messages
- Components can skip parsing if not needed

**Why `safeJsonParse`:**
- Handles malformed JSON gracefully
- Returns fallback value instead of throwing
- Prevents UI crashes from bad data
- Logs errors for debugging

#### Step 2: Metadata Parsing (On-Demand)
**Purpose:** Extract metadata for linking messages (e.g., tool results → assistant messages).

**Process:**
```typescript
const meta = safeJsonParse<ParsedMetadata>(msg.metadata, {});
const assistantId = meta.assistant_message_id || null;
```

**Why:**
- Links tool result messages to their assistant messages
- Enables grouping (assistant message + its tool calls)
- Used for tool call side panel navigation
- Tracks message relationships

#### Step 3: Tool Call Parsing (Native Format)
**Purpose:** Extract tool calls from assistant messages for display.

**Process:**
```typescript
const parsedContent = safeJsonParse<ParsedContent>(message.content, {});
if (parsedContent.tool_calls && Array.isArray(parsedContent.tool_calls)) {
  parsedContent.tool_calls.forEach((toolCall: any) => {
    // Parse arguments (double-encoded JSON string)
    const toolCallArgs = typeof toolCall.function?.arguments === 'string'
      ? JSON.parse(toolCall.function.arguments)
      : toolCall.function?.arguments || {};
    
    // Extract tool name
    const toolName = (toolCall.function?.name || toolCall.name || '')
      .replace(/_/g, '-');
  });
}
```

**Why Double Parsing:**
- `message.content` is JSON string → parse to get `tool_calls` array
- `toolCall.function.arguments` is also JSON string → parse again to get actual args
- This is how native tool calling format works (Anthropic/Bedrock)

**Tool Call Structure:**
```typescript
{
  role: "assistant",
  content: "...",
  tool_calls: [
    {
      id: "call_123",
      type: "function",
      function: {
        name: "web_search",
        arguments: "{\"query\": \"test\"}"  // JSON string!
      }
    }
  ]
}
```

#### Step 4: XML Tool Call Parsing (Legacy Format)
**Purpose:** Parse XML-formatted tool calls (old format, still supported).

**Location:** `frontend/src/components/thread/tool-views/xml-parser.ts`

**Process:**
```typescript
// Check if content contains XML tool calls
if (isNewXmlFormat(content)) {
  const toolCalls = parseXmlToolCalls(content);
  // toolCalls is array of { functionName, parameters, rawXml }
}
```

**XML Format:**
```xml
<function_calls>
  <invoke name="web_search">
    <parameter name="query">test search</parameter>
    <parameter name="num_results">10</parameter>
  </invoke>
</function_calls>
```

**Parsing Logic:**
1. **Detect Format**: `isNewXmlFormat()` checks for `<function_calls>` tag
2. **Extract Blocks**: Regex finds all `<function_calls>...</function_calls>` blocks
3. **Parse Invokes**: Extract `<invoke name="...">` tags
4. **Parse Parameters**: Extract `<parameter name="...">value</parameter>` tags
5. **Type Conversion**: Convert parameter values (JSON, numbers, booleans)

**Where Used:**
- `renderMarkdownContent()` - Renders XML tool calls as clickable buttons
- `use-thread-tool-calls.ts` - Extracts tool calls for side panel
- `extractFileContent()` - Extracts file content from XML tool calls

#### Step 5: Content Extraction for Display
**Purpose:** Extract and clean content for rendering in UI.

**Process:**
```typescript
// For user messages
const parsed = safeJsonParse<ParsedContent>(message.content, {});
const displayContent = parsed.content || message.content;

// Extract attachments (regex pattern)
const attachmentsMatch = displayContent.match(/\[Uploaded File: (.*?)\]/g);
const attachments = attachmentsMatch
  ? attachmentsMatch.map(match => {
      const pathMatch = match.match(/\[Uploaded File: (.*?)\]/);
      return pathMatch ? pathMatch[1] : null;
    }).filter(Boolean)
  : [];

// Remove attachment markers from text
const cleanContent = displayContent.replace(/\[Uploaded File: .*?\]/g, '').trim();
```

**Why:**
- User messages may contain attachment markers
- Extract file paths for file viewer
- Clean text for display (remove markers)
- Support both plain text and structured content

### Parsed Content Schema

**TypeScript Type:**
```typescript
interface ParsedContent {
  role?: 'user' | 'assistant' | 'tool' | 'system';
  content?: any;  // Can be string, object, etc.
  tool_calls?: any[];
  tool_call_id?: string;
  name?: string;
  status_type?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cache_read_tokens?: number;
    cache_creation_tokens?: number;
  };
  [key: string]: any;
}
```

**Example Parsed Content:**
```typescript
// For user message
{
  role: "user",
  content: "Hello!"
}

// For assistant message with tool calls
{
  role: "assistant",
  content: "I'll search for that.",
  tool_calls: [
    {
      id: "call_123",
      type: "function",
      function: {
        name: "web_search",
        arguments: "{\"query\": \"test\"}"  // Still a JSON string!
      }
    }
  ]
}

// For tool result
{
  role: "tool",
  tool_call_id: "call_123",
  name: "web_search",
  content: "{\"query\": \"test\", \"results\": [...]}"  // JSON string
}
```

### Parsed Metadata Schema

**TypeScript Type:**
```typescript
interface ParsedMetadata {
  stream_status?: 'chunk' | 'complete';
  thread_run_id?: string;
  tool_index?: number;
  assistant_message_id?: string;
  linked_tool_result_message_id?: string;
  parsing_details?: any;
  [key: string]: any;
}
```

**Example Parsed Metadata:**
```typescript
{
  stream_status: "complete",
  thread_run_id: "uuid",
  assistant_message_id: "message-uuid",
  tool_call_id: "call_123"
}
```

**Key Points:**
- Parsing happens **lazily** (only when needed for display)
- Uses `safeJsonParse` utility (returns fallback on error)
- Tool call `arguments` are **still JSON strings** (need second parse)
- Content extraction handles nested structures
- Attachments extracted via regex patterns

---

## Complete Flow Example

### Input (Database)
```json
{
  "message_id": "123e4567-e89b-12d3-a456-426614174000",
  "thread_id": "123e4567-e89b-12d3-a456-426614174001",
  "type": "assistant",
  "is_llm_message": true,
  "content": "{\"role\": \"assistant\", \"content\": \"Hello!\", \"tool_calls\": [{\"id\": \"call_123\", \"type\": \"function\", \"function\": {\"name\": \"web_search\", \"arguments\": \"{\\\"query\\\": \\\"test\\\"}\"}}]}",
  "metadata": "{\"assistant_message_id\": \"msg-123\", \"thread_run_id\": \"run-456\"}",
  "created_at": "2024-01-01T00:00:00.000Z",
  "updated_at": "2024-01-01T00:00:00.000Z",
  "agent_id": "agent-789",
  "agent_version_id": null
}
```

### Stage 2-3: Backend API Response
```json
{
  "messages": [
    {
      "message_id": "123e4567-e89b-12d3-a456-426614174000",
      "thread_id": "123e4567-e89b-12d3-a456-426614174001",
      "type": "assistant",
      "is_llm_message": true,
      "content": "{\"role\": \"assistant\", \"content\": \"Hello!\", \"tool_calls\": [{\"id\": \"call_123\", \"type\": \"function\", \"function\": {\"name\": \"web_search\", \"arguments\": \"{\\\"query\\\": \\\"test\\\"}\"}}]}",
      "metadata": "{\"assistant_message_id\": \"msg-123\", \"thread_run_id\": \"run-456\"}",
      "created_at": "2024-01-01T00:00:00.000Z",
      "updated_at": "2024-01-01T00:00:00.000Z",
      "agent_id": "agent-789",
      "agent_version_id": null
    }
  ]
}
```

### Stage 4: Frontend API Client
```typescript
// After filtering (no cost/summary messages)
[
  {
    message_id: "123e4567-e89b-12d3-a456-426614174000",
    thread_id: "123e4567-e89b-12d3-a456-426614174001",
    type: "assistant",
    is_llm_message: true,
    content: "{\"role\": \"assistant\", \"content\": \"Hello!\", \"tool_calls\": [{\"id\": \"call_123\", \"type\": \"function\", \"function\": {\"name\": \"web_search\", \"arguments\": \"{\\\"query\\\": \\\"test\\\"}\"}}]}",
    metadata: "{\"assistant_message_id\": \"msg-123\", \"thread_run_id\": \"run-456\"}",
    created_at: "2024-01-01T00:00:00.000Z",
    updated_at: "2024-01-01T00:00:00.000Z",
    agent_id: "agent-789",
    agent_version_id: null
  }
]
```

### Stage 5: Frontend Hooks (UnifiedMessage)
```typescript
[
  {
    message_id: "123e4567-e89b-12d3-a456-426614174000",
    thread_id: "123e4567-e89b-12d3-a456-426614174001",
    type: "assistant",
    is_llm_message: true,
    content: "{\"role\": \"assistant\", \"content\": \"Hello!\", \"tool_calls\": [{\"id\": \"call_123\", \"type\": \"function\", \"function\": {\"name\": \"web_search\", \"arguments\": \"{\\\"query\\\": \\\"test\\\"}\"}}]}",
    metadata: "{\"assistant_message_id\": \"msg-123\", \"thread_run_id\": \"run-456\"}",
    created_at: "2024-01-01T00:00:00.000Z",
    updated_at: "2024-01-01T00:00:00.000Z",
    agent_id: "agent-789"
  }
]
```

### Stage 6: React Component (Parsed)
```typescript
// Parsed content
{
  role: "assistant",
  content: "Hello!",
  tool_calls: [
    {
      id: "call_123",
      type: "function",
      function: {
        name: "web_search",
        arguments: "{\"query\": \"test\"}"  // Still needs parsing!
      }
    }
  ]
}

// Parsed metadata
{
  assistant_message_id: "msg-123",
  thread_run_id: "run-456"
}

// Tool call arguments (second parse)
{
  query: "test"
}
```

---

## Key Transformations Summary

| Stage | Content Format | Metadata Format | Filtering | Sorting |
|-------|---------------|-----------------|-----------|---------|
| **Database** | JSONB (string/object) | JSONB (string/object) | None | None |
| **Backend API** | JSON string | JSON string | None | By `order` param |
| **Frontend API Client** | JSON string | JSON string | Remove `cost`, `summary` | None |
| **Frontend Hooks** | JSON string | JSON string | Remove `status` | Ascending by `created_at` |
| **React Components** | Parsed object | Parsed object | None | None |

---

## XML Parsing and Tool Call Conversion

### Overview

The frontend supports **two formats** for tool calls:
1. **Native Tool Calling** (modern): JSON format with `tool_calls` array
2. **XML Tool Calling** (legacy): XML tags embedded in text content

### XML Parsing Flow

#### Step 1: Detection
**Location:** `frontend/src/components/thread/tool-views/xml-parser.ts`

```typescript
export function isNewXmlFormat(content: string): boolean {
  return /<function_calls>[\s\S]*<invoke\s+name=/.test(content);
}
```

**Purpose:** Check if content contains XML tool calls before parsing.

#### Step 2: Parsing
**Location:** `frontend/src/components/thread/tool-views/xml-parser.ts` (lines 19-55)

```typescript
export function parseXmlToolCalls(content: string): ParsedToolCall[] {
  const toolCalls: ParsedToolCall[] = [];
  
  // Find all <function_calls> blocks
  const functionCallsRegex = /<function_calls>([\s\S]*?)<\/function_calls>/gi;
  let functionCallsMatch;
  
  while ((functionCallsMatch = functionCallsRegex.exec(content)) !== null) {
    const functionCallsContent = functionCallsMatch[1];
    
    // Find all <invoke> tags
    const invokeRegex = /<invoke\s+name=["']([^"']+)["']>([\s\S]*?)<\/invoke>/gi;
    let invokeMatch;
    
    while ((invokeMatch = invokeRegex.exec(functionCallsContent)) !== null) {
      const functionName = invokeMatch[1].replace(/_/g, '-');
      const invokeContent = invokeMatch[2];
      const parameters: Record<string, any> = {};
      
      // Extract parameters
      const paramRegex = /<parameter\s+name=["']([^"']+)["']>([\s\S]*?)<\/parameter>/gi;
      let paramMatch;
      
      while ((paramMatch = paramRegex.exec(invokeContent)) !== null) {
        const paramName = paramMatch[1];
        const paramValue = paramMatch[2].trim();
        parameters[paramName] = parseParameterValue(paramValue);
      }
      
      toolCalls.push({
        functionName,
        parameters,
        rawXml: invokeMatch[0]
      });
    }
  }
  
  return toolCalls;
}
```

**Process:**
1. **Regex Extraction**: Uses regex to find XML tags (not a full XML parser)
2. **Nested Parsing**: Extracts `<function_calls>` → `<invoke>` → `<parameter>`
3. **Name Normalization**: Converts underscores to hyphens (`web_search` → `web-search`)
4. **Parameter Parsing**: Converts string values to appropriate types (JSON, numbers, booleans)

**Parameter Value Parsing:**
```typescript
function parseParameterValue(value: string): any {
  const trimmed = value.trim();
  
  // Try JSON parsing
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed);
    } catch {}
  }
  
  // Boolean conversion
  if (trimmed.toLowerCase() === 'true') return true;
  if (trimmed.toLowerCase() === 'false') return false;
  
  // Number conversion
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    const num = parseFloat(trimmed);
    if (!isNaN(num)) return num;
  }
  
  // Default: return as string
  return value;
}
```

#### Step 3: Conversion to Tool Call Objects
**Location:** `frontend/src/components/thread/content/ThreadContent.tsx` (lines 58-151)

**In `renderMarkdownContent()`:**
```typescript
if (isNewXmlFormat(content)) {
  const contentParts: React.ReactNode[] = [];
  let lastIndex = 0;
  
  // Find all function_calls blocks
  const functionCallsRegex = /<function_calls>([\s\S]*?)<\/function_calls>/gi;
  let match: RegExpExecArray | null = null;
  
  while ((match = functionCallsRegex.exec(content)) !== null) {
    // Add text before the function_calls block as markdown
    if (match.index > lastIndex) {
      const textBeforeBlock = content.substring(lastIndex, match.index);
      if (textBeforeBlock.trim()) {
        contentParts.push(
          <ComposioUrlDetector 
            key={`md-${lastIndex}`} 
            content={textBeforeBlock} 
            className="..." 
          />
        );
      }
    }
    
    // Parse the tool calls in this block
    const toolCalls = parseXmlToolCalls(match[0]);
    
    // Render each tool call as a clickable button
    toolCalls.forEach((toolCall, index) => {
      const toolName = toolCall.functionName.replace(/_/g, '-');
      
      contentParts.push(
        <button
          key={`tool-${index}`}
          onClick={() => handleToolClick(messageId, toolName)}
          className="..."
        >
          <IconComponent />
          <span>{getUserFriendlyToolName(toolName)}</span>
          {paramDisplay && <span>{paramDisplay}</span>}
        </button>
      );
    });
    
    lastIndex = functionCallsRegex.lastIndex;
  }
  
  // Add remaining text after last function_calls block
  if (lastIndex < content.length) {
    contentParts.push(
      <ComposioUrlDetector 
        content={content.substring(lastIndex)} 
        className="..." 
      />
    );
  }
  
  return contentParts;
}
```

**Why This Approach:**
- Preserves text content around XML tags
- Renders XML tool calls as interactive buttons
- Maintains markdown formatting for text
- Allows clicking tool calls to open side panel

#### Step 4: Tool Call Extraction for Side Panel
**Location:** `frontend/src/hooks/threads/page/use-thread-tool-calls.ts` (lines 115-350)

**Process:**
```typescript
// Extract tool calls from assistant messages
assistantMessages.forEach(assistantMsg => {
  // Try native format first
  const assistantContentParsed = safeJsonParse<ParsedContent>(assistantMsg.content, {});
  if (assistantContentParsed.tool_calls && Array.isArray(assistantContentParsed.tool_calls)) {
    // Native tool calls found
    assistantToolCalls = assistantContentParsed.tool_calls;
  } else {
    // Fall back to XML parsing
    const assistantContent = parsed.content || assistantMsg.content;
    const extractedToolName = extractToolName(assistantContent);
    if (extractedToolName) {
      // XML format detected
      toolName = extractedToolName;
    }
  }
  
  // Match tool results to tool calls
  // ... (matching logic)
});
```

**Why Both Formats:**
- **Backward Compatibility**: Old messages use XML format
- **Forward Compatibility**: New messages use native format
- **Flexibility**: Supports both during transition period

### XML vs Native Tool Calls

| Aspect | XML Format | Native Format |
|--------|-----------|---------------|
| **Location** | Embedded in `content` text | Separate `tool_calls` array |
| **Parsing** | Regex-based XML parsing | Direct JSON parsing |
| **Structure** | `<function_calls><invoke>...</invoke></function_calls>` | `{ tool_calls: [{ id, function: {...} }] }` |
| **Arguments** | `<parameter name="...">value</parameter>` | `function.arguments` (JSON string) |
| **Detection** | `isNewXmlFormat()` regex check | `parsedContent.tool_calls` array check |
| **Rendering** | Extracted and rendered as buttons | Rendered from `tool_calls` array |
| **Status** | Legacy (still supported) | Modern (preferred) |

### Where XML Parsing Happens

1. **Content Rendering** (`ThreadContent.tsx`):
   - `renderMarkdownContent()` - Detects and renders XML tool calls
   - Line 58: `if (isNewXmlFormat(content))`
   - Line 78: `const toolCalls = parseXmlToolCalls(match[0])`

2. **Tool Call Extraction** (`use-thread-tool-calls.ts`):
   - Line 280: `extractToolName(assistantContent)` - Fallback for XML
   - Extracts tool name from XML tags when native format not found

3. **File Content Extraction** (`utils.ts`):
   - `extractFileContent()` - Extracts file content from XML tool calls
   - Line 529: `const toolCalls = parseXmlToolCalls(parsedContent.content)`

4. **Streaming** (`ShowToolStream.tsx`):
   - Detects XML tags in streaming content
   - Converts to tool call objects for display

### Example: XML Tool Call Flow

**Input (Database):**
```json
{
  "type": "assistant",
  "content": "{\"role\": \"assistant\", \"content\": \"I'll search for that.\\n\\n<function_calls>\\n<invoke name=\\\"web_search\\\">\\n<parameter name=\\\"query\\\">test</parameter>\\n</invoke>\\n</function_calls>\"}"
}
```

**After Parsing `content`:**
```typescript
{
  role: "assistant",
  content: "I'll search for that.\n\n<function_calls>\n<invoke name=\"web_search\">\n<parameter name=\"query\">test</parameter>\n</invoke>\n</function_calls>"
}
```

**After XML Parsing:**
```typescript
parseXmlToolCalls(content) = [
  {
    functionName: "web-search",  // normalized
    parameters: {
      query: "test"
    },
    rawXml: "<invoke name=\"web_search\">\n<parameter name=\"query\">test</parameter>\n</invoke>"
  }
]
```

**Rendered As:**
- Text: "I'll search for that."
- Button: [🔍 Web Search: test] (clickable)

---

## Native Tool Call Processing

### Overview

Native tool calls use the modern JSON format with a `tool_calls` array, following the Anthropic/Bedrock API standard. This is the preferred format for new messages, while XML format is maintained for backward compatibility.

### Native Tool Call Structure

**In Database (as JSON string in `content`):**
```json
{
  "role": "assistant",
  "content": "I'll search for that information.",
  "tool_calls": [
    {
      "id": "call_abc123",
      "type": "function",
      "function": {
        "name": "web_search",
        "arguments": "{\"query\": \"test search\", \"num_results\": 10}"
      }
    },
    {
      "id": "call_def456",
      "type": "function",
      "function": {
        "name": "create_file",
        "arguments": "{\"file_path\": \"/path/to/file.txt\", \"content\": \"Hello\"}"
      }
    }
  ]
}
```

**Key Characteristics:**
- `tool_calls` is an **array** (can have multiple tool calls per message)
- Each tool call has a unique `id` (used to match with tool results)
- `function.arguments` is a **JSON string** (not an object!)
- `type` is always `"function"` for native tool calling

### Processing Flow

#### Step 1: Detection
**Location:** `frontend/src/components/thread/content/ThreadContent.tsx` (lines 732-739)

**Process:**
```typescript
const parsedContent = safeJsonParse<ParsedContent>(message.content, {});
const hasToolCalls = parsedContent.tool_calls && Array.isArray(parsedContent.tool_calls) && parsedContent.tool_calls.length > 0;
```

**Purpose:** Check if the assistant message contains native tool calls.

**Why Array Check:**
- Ensures `tool_calls` exists and is an array
- Prevents errors if `tool_calls` is `null`, `undefined`, or not an array
- Validates that there are actually tool calls to process

#### Step 2: Extraction and Rendering
**Location:** `frontend/src/components/thread/content/ThreadContent.tsx` (lines 754-807)

**Process:**
```typescript
if (hasToolCalls) {
  const nativeToolCalls: React.ReactNode[] = [];
  
  parsedContent.tool_calls.forEach((toolCall: any, toolIndex: number) => {
    // 1. Extract tool name
    const toolName = (toolCall.function?.name || toolCall.name || '')
      .replace(/_/g, '-');  // Normalize: web_search → web-search
    
    if (!toolName) return;  // Skip if no name
    
    // 2. Get icon for tool
    const IconComponent = getToolIcon(toolName);
    
    // 3. Parse arguments (double-encoded JSON string)
    let paramDisplay = '';
    try {
      const args = typeof toolCall.function?.arguments === 'string'
        ? JSON.parse(toolCall.function.arguments)  // Parse JSON string
        : toolCall.function?.arguments || toolCall.arguments || {};
      
      // Extract primary parameter for display
      if (args.file_path) {
        paramDisplay = args.file_path;
      } else if (args.command) {
        paramDisplay = args.command;
      } else if (args.query) {
        paramDisplay = args.query;
      } else if (args.url) {
        paramDisplay = args.url;
      } else if (args.text) {
        paramDisplay = args.text;
      }
    } catch (e) {
      // Fallback: try regex extraction from string
      const argsStr = toolCall.function?.arguments || '';
      if (typeof argsStr === 'string') {
        const queryMatch = argsStr.match(/"query"\s*:\s*"([^"]+)"/);
        if (queryMatch) paramDisplay = queryMatch[1];
      }
    }
    
    // 4. Render as clickable button
    nativeToolCalls.push(
      <div key={`native-tool-${toolCall.id || toolIndex}`} className="my-1">
        <button
          onClick={() => handleToolClick(message.message_id, toolName)}
          className="..."
        >
          <IconComponent />
          <span>{getUserFriendlyToolName(toolName)}</span>
          {paramDisplay && <span>{paramDisplay}</span>}
        </button>
      </div>
    );
  });
}
```

**Why This Approach:**
- **Separate from Text**: Tool calls are rendered separately from text content
- **Multiple Tool Calls**: Each tool call gets its own button
- **Clickable**: Buttons open the tool call side panel
- **Visual Feedback**: Icons and parameter previews

**Argument Parsing:**
- **First Parse**: `message.content` (JSON string) → `parsedContent` object
- **Second Parse**: `toolCall.function.arguments` (JSON string) → `args` object
- **Extraction**: Pull out primary parameter (file_path, query, etc.) for display

#### Step 3: Tool Result Matching
**Location:** `frontend/src/hooks/threads/page/use-thread-tool-calls.ts` (lines 133-235)

**Purpose:** Match tool result messages to their corresponding tool calls.

**Process:**
```typescript
// 1. Parse assistant message to get tool_calls array
const assistantContentParsed = safeJsonParse<ParsedContent>(assistantMsg.content, {});
let assistantToolCalls = [];
if (assistantContentParsed.tool_calls && Array.isArray(assistantContentParsed.tool_calls)) {
  assistantToolCalls = assistantContentParsed.tool_calls;
}

// 2. Find all tool result messages for this assistant message
const resultMessages = messages.filter(toolMsg => {
  if (toolMsg.type !== 'tool' || !toolMsg.metadata || !assistantMsg.message_id) return false;
  try {
    const metadata = safeJsonParse<ParsedMetadata>(toolMsg.metadata, {});
    return metadata.assistant_message_id === assistantMsg.message_id;
  } catch {
    return false;
  }
});

// 3. Match each tool call to its result by tool_call_id
if (assistantToolCalls.length > 0 && resultMessages.length > 0) {
  assistantToolCalls.forEach((toolCall, toolCallIndex) => {
    const toolCallId = toolCall.id;  // e.g., "call_abc123"
    
    // Find matching tool result by tool_call_id
    const resultMessage = toolCallId
      ? resultMessages.find(toolMsg => {
          try {
            const parsedContent = safeJsonParse<ParsedContent>(toolMsg.content, {});
            return parsedContent.tool_call_id === toolCallId;  // Match by ID
          } catch {
            return false;
          }
        })
      : resultMessages[toolCallIndex];  // Fallback: match by index
    
    if (resultMessage) {
      // Extract tool result content
      let extractedToolContent = resultMessage.content;
      try {
        const parsed = safeJsonParse<ParsedContent>(resultMessage.content, {});
        // Native tool results format: {"role": "tool", "tool_call_id": "...", "name": "...", "content": "actual output"}
        if (parsed.role === 'tool' && parsed.content !== undefined) {
          extractedToolContent = typeof parsed.content === 'string'
            ? parsed.content
            : JSON.stringify(parsed.content);
        }
      } catch {
        // Use original content if parsing fails
      }
      
      // Create tool call pair for side panel
      historicalToolPairs.push({
        assistantCall: {
          name: toolName,
          content: assistantMsg.content,
          timestamp: assistantMsg.created_at,
        },
        toolResult: {
          content: extractedToolContent,
          isSuccess: isSuccess,
          timestamp: resultMessage.created_at,
        },
      });
    }
  });
}
```

**Matching Strategy:**
1. **Primary**: Match by `tool_call_id` (most reliable)
   - Tool call has `id: "call_abc123"`
   - Tool result has `tool_call_id: "call_abc123"`
   - Exact match ensures correct pairing
2. **Fallback**: Match by index if no ID
   - First tool call → first tool result
   - Second tool call → second tool result
   - Used for legacy messages without IDs

**Why ID Matching:**
- **Reliability**: IDs are unique and guaranteed to match
- **Order Independence**: Tool results can arrive in any order
- **Multiple Tool Calls**: One assistant message can have multiple tool calls
- **Parallel Execution**: Tools can execute in parallel, results arrive out of order

#### Step 4: Tool Result Content Extraction
**Location:** `frontend/src/hooks/threads/page/use-thread-tool-calls.ts` (lines 163-176)

**Purpose:** Extract the actual tool output from the native tool result format.

**Native Tool Result Format:**
```json
{
  "role": "tool",
  "tool_call_id": "call_abc123",
  "name": "web_search",
  "content": "{\"query\": \"test\", \"results\": [...]}"
}
```

**Process:**
```typescript
let extractedToolContent = resultMessage.content;

try {
  const parsed = safeJsonParse<ParsedContent>(resultMessage.content, {});
  
  // Check if it's native tool format
  if (parsed.role === 'tool' && parsed.content !== undefined) {
    // The actual tool output is in parsed.content
    extractedToolContent = typeof parsed.content === 'string'
      ? parsed.content
      : JSON.stringify(parsed.content);
  }
} catch {
  // If parsing fails, use original content
}
```

**Why Extract:**
- Native format wraps the actual output in a `content` field
- Need to unwrap to get the real tool result
- Supports both string and object content
- Falls back to original if parsing fails

#### Step 5: Side Panel Display
**Location:** `frontend/src/hooks/threads/page/use-thread-tool-calls.ts` (lines 216-233)

**Purpose:** Create tool call pairs for display in the side panel.

**Process:**
```typescript
const toolIndex = historicalToolPairs.length;
historicalToolPairs.push({
  assistantCall: {
    name: toolName,  // e.g., "web-search"
    content: assistantMsg.content,  // Full assistant message with tool_calls
    timestamp: assistantMsg.created_at,
  },
  toolResult: {
    content: extractedToolContent,  // Actual tool output
    isSuccess: isSuccess,  // Whether tool succeeded
    timestamp: resultMessage.created_at,
  },
});

// Map assistant message ID to tool index for navigation
if (assistantMsg.message_id && toolCallIndex === 0) {
  messageIdToIndex.set(assistantMsg.message_id, toolIndex);
}
```

**Why Store Pairs:**
- Side panel shows tool call + result together
- Enables navigation between tool calls
- Tracks success/failure status
- Maintains chronological order

### Complete Example: Native Tool Call Flow

#### Input (Database)
```json
{
  "message_id": "msg-123",
  "type": "assistant",
  "content": "{\"role\": \"assistant\", \"content\": \"I'll search for that.\", \"tool_calls\": [{\"id\": \"call_abc\", \"type\": \"function\", \"function\": {\"name\": \"web_search\", \"arguments\": \"{\\\"query\\\": \\\"test\\\"}\"}}]}"
}
```

#### Step 1: Parse Content
```typescript
const parsedContent = JSON.parse(message.content);
// Result:
{
  role: "assistant",
  content: "I'll search for that.",
  tool_calls: [
    {
      id: "call_abc",
      type: "function",
      function: {
        name: "web_search",
        arguments: "{\"query\": \"test\"}"  // Still a JSON string!
      }
    }
  ]
}
```

#### Step 2: Extract Tool Calls
```typescript
const hasToolCalls = parsedContent.tool_calls && parsedContent.tool_calls.length > 0;  // true
const toolCall = parsedContent.tool_calls[0];

// Parse arguments
const args = JSON.parse(toolCall.function.arguments);
// Result: { query: "test" }

// Extract tool name
const toolName = toolCall.function.name.replace(/_/g, '-');  // "web-search"

// Extract primary parameter
const paramDisplay = args.query;  // "test"
```

#### Step 3: Render Button
```tsx
<button onClick={() => handleToolClick("msg-123", "web-search")}>
  <SearchIcon />
  <span>Web Search</span>
  <span>test</span>
</button>
```

#### Step 4: Match Tool Result
```typescript
// Tool result message
{
  message_id: "msg-456",
  type: "tool",
  content: "{\"role\": \"tool\", \"tool_call_id\": \"call_abc\", \"name\": \"web_search\", \"content\": \"{\\\"results\\\": [...]}\"}",
  metadata: "{\"assistant_message_id\": \"msg-123\"}"
}

// Match by tool_call_id
const parsedResult = JSON.parse(resultMessage.content);
// parsedResult.tool_call_id === "call_abc" ✅ Matches!

// Extract actual content
const extractedContent = parsedResult.content;  // "{\"results\": [...]}"
```

#### Step 5: Create Tool Pair
```typescript
{
  assistantCall: {
    name: "web-search",
    content: assistantMsg.content,
    timestamp: "2024-01-01T00:00:00Z"
  },
  toolResult: {
    content: "{\"results\": [...]}",
    isSuccess: true,
    timestamp: "2024-01-01T00:00:01Z"
  }
}
```

### Native vs XML Tool Calls Comparison

| Aspect | Native Format | XML Format |
|--------|---------------|------------|
| **Structure** | `tool_calls` array in JSON | XML tags in text content |
| **Parsing** | Direct JSON parsing | Regex-based XML parsing |
| **Multiple Tools** | Array of tool calls | Multiple `<invoke>` tags |
| **ID Matching** | `tool_call_id` field | No IDs (index-based) |
| **Arguments** | JSON string in `function.arguments` | `<parameter>` tags |
| **Rendering** | Separate buttons below text | Inline buttons in text |
| **Tool Results** | Structured format with `tool_call_id` | Various formats |
| **Matching** | By `tool_call_id` (reliable) | By index (fragile) |

### Where Native Tool Calls Are Processed

1. **Content Rendering** (`ThreadContent.tsx`):
   - Line 732: `parsedContent.tool_calls` check
   - Lines 754-807: Render native tool calls as buttons
   - Separate from text content rendering

2. **Tool Call Extraction** (`use-thread-tool-calls.ts`):
   - Line 136: Parse assistant message for `tool_calls` array
   - Line 145: Match tool results by `tool_call_id`
   - Line 159: Extract tool name from `function.name`

3. **Tool Result Processing** (`use-thread-tool-calls.ts`):
   - Line 166: Parse tool result content
   - Line 168: Extract content from native format
   - Line 151: Match by `tool_call_id`

4. **Streaming** (`useAgentStream.ts`):
   - Line 392: Detect `tool_calls` in streaming messages
   - Logs native tool calls for debugging
   - Handles tool call chunks during streaming

### Key Differences from XML Format

1. **Location**: Native tool calls are in a separate `tool_calls` array, not embedded in text
2. **Rendering**: Native tool calls render below text content, XML renders inline
3. **Matching**: Native uses `tool_call_id` for reliable matching, XML uses index
4. **Multiple Tools**: Native handles multiple tools better (each has unique ID)
5. **Structure**: Native follows API standard, XML is custom format

---

## Important Notes

### 1. JSON String Parsing
- `content` and `metadata` are **always JSON strings** until parsed in components
- Parsing happens **lazily** (only when needed)
- Use `safeJsonParse` utility for safe parsing with fallbacks

### 2. Double JSON Encoding
- Tool call `arguments` are **double-encoded**:
  - First: `content` is a JSON string containing `tool_calls`
  - Second: Each `tool_call.function.arguments` is also a JSON string
- Requires **two levels of parsing**:
  ```typescript
  const parsedContent = JSON.parse(message.content);
  const toolCallArgs = JSON.parse(parsedContent.tool_calls[0].function.arguments);
  ```

### 3. Filtering Layers
- **Backend**: No filtering
- **Frontend API Client**: Filters `cost` and `summary`
- **Frontend Hooks**: Filters `status`
- **React Components**: No filtering

### 4. Sorting
- **Backend**: Configurable (`asc` or `desc`, default `desc`)
- **Frontend API Client**: Requests `asc` order
- **Frontend Hooks**: Re-sorts ascending by `created_at`
- **React Components**: Uses sorted order from hooks

### 5. Type Safety
- Database: No types (raw JSONB)
- Backend: Python dicts
- Frontend API Client: `Message` type (loose)
- Frontend Hooks: `UnifiedMessage` type (strict)
- React Components: `ParsedContent` and `ParsedMetadata` types

---

## Related Files

### Backend
- `backend/core/threads.py` - GET messages endpoint
- `backend/supabase/migrations/20250416133920_agentpress_schema.sql` - Database schema

### Frontend
- `frontend/src/lib/api/threads.ts` - API client
- `frontend/src/hooks/threads/page/use-thread-data.ts` - React Query hook
- `frontend/src/components/thread/types.ts` - TypeScript types
- `frontend/src/components/thread/content/ThreadContent.tsx` - Component rendering
- `frontend/src/components/thread/utils.ts` - `safeJsonParse` utility

