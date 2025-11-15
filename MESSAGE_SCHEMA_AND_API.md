# Message Schema and API Documentation

This document provides a comprehensive overview of the message data schema and the GET/Stream messages APIs.

---

## Table of Contents

1. [Database Schema](#database-schema)
2. [Message Data Structure](#message-data-structure)
3. [GET Messages API](#get-messages-api)
4. [Stream Messages API](#stream-messages-api)
5. [Message Format Examples](#message-format-examples)

---

## Database Schema

### Messages Table

The `messages` table is defined in `backend/supabase/migrations/20250416133920_agentpress_schema.sql`:

```sql
CREATE TABLE messages (
    message_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    thread_id UUID NOT NULL REFERENCES threads(thread_id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    is_llm_message BOOLEAN NOT NULL DEFAULT TRUE,
    content JSONB NOT NULL,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL,
    agent_id UUID REFERENCES agents(agent_id) ON DELETE SET NULL,
    agent_version_id UUID REFERENCES agent_versions(version_id) ON DELETE SET NULL
);
```

### Schema Fields

| Field | Type | Description |
|-------|------|-------------|
| `message_id` | UUID | Primary key, auto-generated |
| `thread_id` | UUID | Foreign key to threads table |
| `type` | TEXT | Message type: `'user'`, `'assistant'`, `'tool'`, `'system'`, `'status'`, `'browser_state'`, `'image_context'`, `'llm_response_end'` |
| `is_llm_message` | BOOLEAN | Whether this message should be sent to the LLM |
| `content` | JSONB | Message content (can be JSON string, plain string, or object) |
| `metadata` | JSONB | Additional metadata (compression, tool_call_id, stream_status, etc.) |
| `created_at` | TIMESTAMP | Creation timestamp (UTC) |
| `updated_at` | TIMESTAMP | Last update timestamp (UTC) |
| `agent_id` | UUID (nullable) | ID of the agent associated with this message |
| `agent_version_id` | UUID (nullable) | Version ID of the agent |

---

## Message Data Structure

### Unified Message Interface

The frontend uses a `UnifiedMessage` interface that matches the backend/database schema:

```typescript
interface UnifiedMessage {
  sequence?: number;                    // Optional sequence number for streaming
  message_id: string | null;            // Can be null for transient stream events
  thread_id: string;
  type: 'user' | 'assistant' | 'tool' | 'system' | 'status' | 
        'browser_state' | 'image_context' | 'llm_response_end';
  is_llm_message: boolean;
  content: string;                      // ALWAYS a JSON string from the backend
  metadata: string;                     // ALWAYS a JSON string from the backend
  created_at: string;                    // ISO timestamp string
  updated_at: string;                    // ISO timestamp string
  agent_id?: string;                    // Optional agent ID
  agents?: {                            // Optional agent info from join
    name: string;
  };
}
```

### Content Format Variations

The `content` field can be stored in different formats:

1. **JSON String Format** (most common):
   ```json
   {
     "type": "user",
     "content": "{\"role\": \"user\", \"content\": \"Hello!\"}"
   }
   ```

2. **Plain String Format** (compressed messages):
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

3. **Direct Object Format** (some status messages):
   ```json
   {
     "type": "status",
     "content": {
       "status_type": "thread_run_start",
       "thread_run_id": "uuid"
     }
   }
   ```

### Parsed Content Structure

When parsing the JSON string in `content`, the structure depends on `message.type`:

```typescript
interface ParsedContent {
  role?: 'user' | 'assistant' | 'tool' | 'system';
  content?: any;                        // Can be string, object, etc.
  tool_calls?: any[];                   // For native tool calls
  tool_call_id?: string;                // For tool results
  name?: string;                        // For tool results
  status_type?: string;                 // For status messages
  usage?: {                             // For llm_response_end messages
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cache_read_tokens?: number;
    cache_creation_tokens?: number;
  };
  [key: string]: any;
}
```

### Parsed Metadata Structure

```typescript
interface ParsedMetadata {
  stream_status?: 'chunk' | 'complete'; // For streaming messages
  thread_run_id?: string;
  tool_index?: number;
  assistant_message_id?: string;       // Link tool results/statuses back
  linked_tool_result_message_id?: string;
  compressed?: boolean;                 // For compressed messages
  compressed_content?: string;
  tool_call_id?: string;                // For tool messages
  parsing_details?: any;
  [key: string]: any;
}
```

---

## GET Messages API

### Endpoint

```
GET /threads/{thread_id}/messages
```

### Implementation

**Location:** `backend/core/threads.py` (lines 357-392)

### Request Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `thread_id` | string (path) | Yes | - | Thread ID to fetch messages for |
| `order` | string (query) | No | `"desc"` | Order by `created_at`: `"asc"` or `"desc"` |

### Authentication

- Supports both authenticated and anonymous access
- For authenticated users: JWT token in `Authorization: Bearer <token>` header
- For public threads: Anonymous access is allowed
- Access is verified via `verify_and_authorize_thread_access()`

### Response Format

```json
{
  "messages": [
    {
      "message_id": "uuid-string",
      "thread_id": "uuid-string",
      "type": "user",
      "is_llm_message": true,
      "content": "{\"role\": \"user\", \"content\": \"Hello!\"}",
      "metadata": "{}",
      "created_at": "2024-01-01T00:00:00Z",
      "updated_at": "2024-01-01T00:00:00Z",
      "agent_id": "uuid-string" | null,
      "agent_version_id": "uuid-string" | null
    }
  ]
}
```

### Implementation Details

- **Batching:** Fetches messages in batches of 1000 to avoid large queries
- **Pagination:** Automatically handles pagination internally
- **Ordering:** Supports ascending (`asc`) or descending (`desc`) order by `created_at`
- **Error Handling:** Returns 500 error with detail message on failure

### Example Usage

**Frontend (TypeScript):**
```typescript
// From frontend/src/lib/api/threads.ts
const response = await fetch(`${API_URL}/threads/${threadId}/messages?order=asc`, {
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${session?.access_token}` // Optional
  },
  cache: 'no-store',
});

const data = await response.json();
const allMessages = data.messages || [];
```

**Mobile (React Native):**
```typescript
// From apps/mobile/lib/chat/hooks.ts
const res = await fetch(`${API_URL}/threads/${threadId}/messages?order=asc`, { 
  headers 
});
const data = await res.json();
const messages = Array.isArray(data) ? data : data.messages || [];
```

---

## Stream Messages API

### Endpoint

```
GET /agent-run/{agent_run_id}/stream
```

### Implementation

**Location:** `backend/core/agent_runs.py` (lines 905-1082)

### Request Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `agent_run_id` | string (path) | Yes | - | Agent run ID to stream |
| `token` | string (query) | No | - | Optional auth token (alternative to header) |

### Authentication

- Uses `get_user_id_from_stream_auth()` which accepts:
  - JWT token in `Authorization: Bearer <token>` header, OR
  - `token` query parameter
- Verifies access via `_get_agent_run_with_access_check()`

### Response Format

**Media Type:** `text/event-stream` (Server-Sent Events)

**Format:** Each message is sent as:
```
data: <json-encoded-message>\n\n
```

### Stream Message Structure

Each streamed message follows the `UnifiedMessage` format:

```json
{
  "sequence": 1,                        // Optional sequence number
  "message_id": "uuid-string" | null,  // null for transient chunks
  "thread_id": "uuid-string",
  "type": "assistant" | "tool" | "status" | ...,
  "is_llm_message": true,
  "content": "{\"role\": \"assistant\", \"content\": \"chunk text\"}",
  "metadata": "{\"stream_status\": \"chunk\", \"thread_run_id\": \"uuid\"}",
  "created_at": "2024-01-01T00:00:00Z",
  "updated_at": "2024-01-01T00:00:00Z"
}
```

### Stream Status Messages

Special status messages indicate stream lifecycle:

```json
{
  "type": "status",
  "status": "completed" | "failed" | "stopped" | "error",
  "message": "Optional status message"
}
```

### Implementation Details

**Architecture:**
- Uses **Redis Lists** to store responses: `agent_run:{agent_run_id}:responses`
- Uses **Redis Pub/Sub** for real-time notifications:
  - `agent_run:{agent_run_id}:new_response` - New response available
  - `agent_run:{agent_run_id}:control` - Control signals (STOP, END_STREAM, ERROR)

**Stream Flow:**
1. **Initial Load:** Fetches all existing responses from Redis list
2. **Real-time Updates:** Subscribes to Pub/Sub channels for new responses
3. **Completion Detection:** Monitors for status messages indicating completion
4. **Cleanup:** Gracefully unsubscribes and closes connections on termination

**Response Headers:**
```http
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no
Content-Type: text/event-stream
Access-Control-Allow-Origin: *
```

### Example Usage

**Frontend (TypeScript):**
```typescript
// From frontend/src/lib/api/agents.ts
const url = new URL(`${API_URL}/agent-run/${agentRunId}/stream`);
url.searchParams.append('token', session.access_token);

const eventSource = new EventSource(url.toString());

eventSource.onmessage = (event) => {
  const rawData = event.data;
  if (rawData.startsWith('data: ')) {
    const jsonData = JSON.parse(rawData.substring(6));
    // Handle message
  }
};
```

**Mobile (React Native):**
```typescript
// From apps/mobile/hooks/useAgentStream.ts
const eventSource = new EventSource(`${API_URL}/agent-run/${agentRunId}/stream?token=${token}`);

eventSource.onmessage = (event) => {
  const message = JSON.parse(event.data) as UnifiedMessage;
  // Process streamed message
};
```

### Stream Message Types

1. **Content Chunks** (`stream_status: "chunk"`):
   ```json
   {
     "type": "assistant",
     "content": "{\"role\": \"assistant\", \"content\": \"partial text\"}",
     "metadata": "{\"stream_status\": \"chunk\", \"thread_run_id\": \"uuid\"}",
     "message_id": null,
     "sequence": 1
   }
   ```

2. **Complete Messages** (`stream_status: "complete"`):
   ```json
   {
     "type": "assistant",
     "content": "{\"role\": \"assistant\", \"content\": \"full text\", \"tool_calls\": [...]}",
     "metadata": "{\"stream_status\": \"complete\", \"thread_run_id\": \"uuid\"}",
     "message_id": "uuid-string",
     "sequence": 2
   }
   ```

3. **Tool Call Chunks**:
   ```json
   {
     "type": "status",
     "content": "{\"role\": \"assistant\", \"status_type\": \"tool_call_chunk\", \"tool_call_chunk\": {...}}",
     "metadata": "{\"thread_run_id\": \"uuid\"}",
     "message_id": null
   }
   ```

4. **Tool Results**:
   ```json
   {
     "type": "tool",
     "content": "{\"role\": \"tool\", \"tool_call_id\": \"...\", \"name\": \"web_search\", \"content\": \"...\"}",
     "metadata": "{\"tool_call_id\": \"...\"}",
     "message_id": "uuid-string"
   }
   ```

---

## Message Format Examples

### User Message

**Database:**
```json
{
  "message_id": "123e4567-e89b-12d3-a456-426614174000",
  "thread_id": "123e4567-e89b-12d3-a456-426614174001",
  "type": "user",
  "is_llm_message": true,
  "content": "{\"role\": \"user\", \"content\": \"Hello, how are you?\"}",
  "metadata": "{}",
  "created_at": "2024-01-01T00:00:00Z",
  "updated_at": "2024-01-01T00:00:00Z"
}
```

### Assistant Message with Tool Calls

**Database:**
```json
{
  "message_id": "123e4567-e89b-12d3-a456-426614174002",
  "thread_id": "123e4567-e89b-12d3-a456-426614174001",
  "type": "assistant",
  "is_llm_message": true,
  "content": "{\"role\": \"assistant\", \"content\": \"I'll search for that.\", \"tool_calls\": [{\"id\": \"call_123\", \"type\": \"function\", \"function\": {\"name\": \"web_search\", \"arguments\": \"{\\\"query\\\": \\\"test\\\"}\"}}]}",
  "metadata": "{}",
  "agent_id": "123e4567-e89b-12d3-a456-426614174003",
  "created_at": "2024-01-01T00:00:01Z",
  "updated_at": "2024-01-01T00:00:01Z"
}
```

### Tool Result Message

**Database:**
```json
{
  "message_id": "123e4567-e89b-12d3-a456-426614174004",
  "thread_id": "123e4567-e89b-12d3-a456-426614174001",
  "type": "tool",
  "is_llm_message": true,
  "content": "{\"role\": \"tool\", \"tool_call_id\": \"call_123\", \"name\": \"web_search\", \"content\": \"{\\\"query\\\": \\\"test\\\", \\\"results\\\": [...]}\"}",
  "metadata": "{\"tool_call_id\": \"call_123\"}",
  "created_at": "2024-01-01T00:00:02Z",
  "updated_at": "2024-01-01T00:00:02Z"
}
```

### Streaming Chunk Message

**Stream (not saved to DB):**
```json
{
  "sequence": 1,
  "message_id": null,
  "thread_id": "123e4567-e89b-12d3-a456-426614174001",
  "type": "assistant",
  "is_llm_message": true,
  "content": "{\"role\": \"assistant\", \"content\": \"Hello\"}",
  "metadata": "{\"stream_status\": \"chunk\", \"thread_run_id\": \"uuid\"}",
  "created_at": "2024-01-01T00:00:03Z",
  "updated_at": "2024-01-01T00:00:03Z"
}
```

### Status Message

**Database:**
```json
{
  "message_id": "123e4567-e89b-12d3-a456-426614174005",
  "thread_id": "123e4567-e89b-12d3-a456-426614174001",
  "type": "status",
  "is_llm_message": false,
  "content": "{\"status_type\": \"thread_run_start\", \"thread_run_id\": \"uuid\"}",
  "metadata": "{}",
  "created_at": "2024-01-01T00:00:04Z",
  "updated_at": "2024-01-01T00:00:04Z"
}
```

---

## Related Files

### Backend
- `backend/core/threads.py` - GET messages endpoint
- `backend/core/agent_runs.py` - Stream messages endpoint
- `backend/core/agentpress/response_processor.py` - Message generation and streaming
- `backend/run_agent_background.py` - Background agent execution and Redis publishing
- `backend/supabase/migrations/20250416133920_agentpress_schema.sql` - Database schema

### Frontend
- `frontend/src/lib/api/threads.ts` - GET messages client
- `frontend/src/lib/api/agents.ts` - Stream messages client
- `frontend/src/components/thread/types.ts` - TypeScript type definitions
- `frontend/src/hooks/agents/useAgentStream.ts` - Stream hook implementation

### Mobile
- `apps/mobile/lib/chat/hooks.ts` - GET messages hook
- `apps/mobile/hooks/useAgentStream.ts` - Stream hook implementation
- `apps/mobile/api/types.ts` - TypeScript type definitions

### Documentation
- `MESSAGE_STRUCTURES.md` - Detailed message format documentation

---

## Summary

| Aspect | GET Messages | Stream Messages |
|--------|--------------|-----------------|
| **Endpoint** | `GET /threads/{thread_id}/messages` | `GET /agent-run/{agent_run_id}/stream` |
| **Response Format** | JSON array | Server-Sent Events (SSE) |
| **Data Source** | PostgreSQL (messages table) | Redis Lists + Pub/Sub |
| **Pagination** | Automatic batching (1000 per batch) | Real-time streaming |
| **Message Format** | Full `UnifiedMessage` with `message_id` | `UnifiedMessage` (may have `null` `message_id` for chunks) |
| **Use Case** | Loading existing messages | Real-time agent responses |

