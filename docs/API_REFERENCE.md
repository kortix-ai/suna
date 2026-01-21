# API Reference

> REST API endpoints, authentication, request/response formats, and error handling for the SprintLab/Suna backend.

**Related Documents:** [ARCHITECTURE.md](../ARCHITECTURE.md) | [BACKEND.md](./BACKEND.md) | [STREAMING.md](./STREAMING.md)

---

## Table of Contents

1. [Overview](#overview)
2. [Authentication](#authentication)
3. [Agent Endpoints](#agent-endpoints)
4. [Thread Endpoints](#thread-endpoints)
5. [Sandbox Endpoints](#sandbox-endpoints)
6. [Billing Endpoints](#billing-endpoints)
7. [Voice Endpoints](#voice-endpoints)
8. [Streaming Endpoints](#streaming-endpoints)
9. [Error Handling](#error-handling)
10. [Rate Limiting](#rate-limiting)

---

## Overview

**Base URL:** `https://api.sprintlab.id/v1` (production) or `http://localhost:8000/v1` (local)

**Content Type:** `application/json` (unless otherwise noted)

**API Documentation:** Available at `/docs` (Swagger UI) and `/redoc` (ReDoc)

---

## Authentication

### JWT Bearer Token

All authenticated endpoints require a JWT token in the `Authorization` header:

```http
Authorization: Bearer <jwt_token>
```

The JWT is obtained from Supabase Auth after user login.

### API Key (Alternative)

For programmatic access, API keys can be used:

```http
X-API-Key: <api_key>
```

### Authentication Errors

| Status | Error | Description |
|--------|-------|-------------|
| 401 | `missing_auth` | No authentication provided |
| 401 | `invalid_token` | Token is malformed or expired |
| 403 | `insufficient_permissions` | User lacks required role |

---

## Agent Endpoints

### Start Agent Run

Initiates an agent execution on a thread.

```http
POST /v1/agent/start
Content-Type: multipart/form-data
```

**Query Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `thread_id` | UUID | No | Existing thread ID (creates new if omitted) |
| `project_id` | UUID | No | Project to associate with thread |

**Form Data:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `message` | string | Yes | User message to send |
| `agent_id` | UUID | No | Agent to use (uses default if omitted) |
| `model_name` | string | No | Model override |
| `files` | File[] | No | Files to attach |

**Response:**
```json
{
  "thread_id": "uuid",
  "agent_run_id": "uuid",
  "status": "running",
  "project_id": "uuid"
}
```

### Stop Agent Run

Stops an active agent execution.

```http
POST /v1/agent-run/{agent_run_id}/stop
```

**Path Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `agent_run_id` | UUID | Agent run to stop |

**Response:**
```json
{
  "status": "stopped",
  "message": "Agent run stopped successfully"
}
```

### Get Agent Run Status

Retrieves status of an agent run.

```http
GET /v1/agent-run/{agent_run_id}
```

**Response:**
```json
{
  "id": "uuid",
  "thread_id": "uuid",
  "agent_id": "uuid",
  "status": "running",
  "started_at": "2024-01-15T12:00:00Z",
  "completed_at": null,
  "error": null
}
```

### List Agents

Lists all agents for the authenticated user.

```http
GET /v1/agents
```

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `include_public` | boolean | false | Include public agents |
| `limit` | integer | 50 | Maximum results |
| `offset` | integer | 0 | Pagination offset |

**Response:**
```json
{
  "agents": [
    {
      "agent_id": "uuid",
      "name": "My Agent",
      "description": "Agent description",
      "avatar_url": "https://...",
      "is_default": false,
      "is_public": false,
      "created_at": "2024-01-15T12:00:00Z"
    }
  ],
  "total": 10
}
```

### Create Agent

Creates a new agent configuration.

```http
POST /v1/agents
Content-Type: application/json
```

**Request Body:**
```json
{
  "name": "My Agent",
  "description": "Agent description",
  "system_prompt": "You are a helpful assistant...",
  "agentpress_tools": {
    "web_search_tool": true,
    "browser_tool": {
      "enabled": true,
      "methods": ["navigate_to", "extract_content"]
    }
  },
  "custom_mcps": [],
  "is_public": false
}
```

**Response:**
```json
{
  "agent_id": "uuid",
  "name": "My Agent",
  "created_at": "2024-01-15T12:00:00Z"
}
```

### Update Agent

Updates an existing agent.

```http
PATCH /v1/agents/{agent_id}
Content-Type: application/json
```

**Request Body:** Same as create (partial updates supported)

### Delete Agent

Deletes an agent.

```http
DELETE /v1/agents/{agent_id}
```

**Response:**
```json
{
  "message": "Agent deleted successfully"
}
```

---

## Thread Endpoints

### List Threads

Lists threads for the authenticated user.

```http
GET /v1/threads
```

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `project_id` | UUID | - | Filter by project |
| `limit` | integer | 50 | Maximum results |
| `cursor` | string | - | Pagination cursor |

**Response:**
```json
{
  "threads": [
    {
      "thread_id": "uuid",
      "project_id": "uuid",
      "name": "Thread Name",
      "created_at": "2024-01-15T12:00:00Z",
      "updated_at": "2024-01-15T12:30:00Z"
    }
  ],
  "next_cursor": "cursor_string"
}
```

### Get Thread

Retrieves a single thread with messages.

```http
GET /v1/threads/{thread_id}
```

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `include_messages` | boolean | true | Include message history |
| `message_limit` | integer | 100 | Max messages to return |

**Response:**
```json
{
  "thread_id": "uuid",
  "project_id": "uuid",
  "name": "Thread Name",
  "messages": [
    {
      "message_id": "uuid",
      "type": "user",
      "content": "Hello",
      "created_at": "2024-01-15T12:00:00Z"
    },
    {
      "message_id": "uuid",
      "type": "assistant",
      "content": "Hi there!",
      "metadata": {},
      "created_at": "2024-01-15T12:00:01Z"
    }
  ]
}
```

### Create Thread

Creates a new thread.

```http
POST /v1/threads
Content-Type: application/json
```

**Request Body:**
```json
{
  "name": "New Thread",
  "project_id": "uuid",
  "metadata": {}
}
```

### Delete Thread

Deletes a thread and all its messages.

```http
DELETE /v1/threads/{thread_id}
```

### Add Message

Adds a message to a thread (without triggering agent).

```http
POST /v1/threads/{thread_id}/messages
Content-Type: application/json
```

**Request Body:**
```json
{
  "type": "user",
  "content": "Message content",
  "metadata": {}
}
```

---

## Sandbox Endpoints

### Get Sandbox Status

Retrieves sandbox status for a project.

```http
GET /v1/sandbox/{project_id}/status
```

**Response:**
```json
{
  "sandbox_id": "sandbox-123",
  "status": "running",
  "urls": {
    "vnc": "https://vnc.sandbox.sprintlab.id/sandbox-123",
    "http": "https://sandbox-123.sprintlab.id"
  }
}
```

### List Files

Lists files in the sandbox filesystem.

```http
GET /v1/sandbox/{project_id}/files
```

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `path` | string | `/workspace` | Directory path |

**Response:**
```json
{
  "path": "/workspace",
  "files": [
    {
      "name": "main.py",
      "type": "file",
      "size": 1234,
      "modified": "2024-01-15T12:00:00Z"
    },
    {
      "name": "src",
      "type": "directory",
      "modified": "2024-01-15T12:00:00Z"
    }
  ]
}
```

### Download File

Downloads a file from the sandbox.

```http
GET /v1/sandbox/{project_id}/files/download
```

**Query Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | Yes | File path |

**Response:** File content with appropriate Content-Type header.

### Upload File

Uploads a file to the sandbox.

```http
POST /v1/sandbox/{project_id}/files/upload
Content-Type: multipart/form-data
```

**Form Data:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | File | Yes | File to upload |
| `path` | string | Yes | Destination path |

### Execute Command

Executes a shell command in the sandbox.

```http
POST /v1/sandbox/{project_id}/execute
Content-Type: application/json
```

**Request Body:**
```json
{
  "command": "ls -la",
  "working_directory": "/workspace",
  "timeout": 30
}
```

**Response:**
```json
{
  "exit_code": 0,
  "stdout": "total 4\n...",
  "stderr": ""
}
```

### Start/Stop Sandbox

```http
POST /v1/sandbox/{project_id}/start
POST /v1/sandbox/{project_id}/stop
```

---

## Billing Endpoints

### Get Credit Balance

Retrieves user's credit balance.

```http
GET /v1/billing/credits
```

**Response:**
```json
{
  "balance": 1000.50,
  "currency": "credits"
}
```

### Get Usage History

Retrieves credit usage history.

```http
GET /v1/billing/usage
```

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `start_date` | ISO date | 30 days ago | Start date |
| `end_date` | ISO date | now | End date |
| `limit` | integer | 100 | Maximum results |

**Response:**
```json
{
  "usage": [
    {
      "id": "uuid",
      "amount": -0.05,
      "type": "usage",
      "description": "LLM tokens (claude-3-5-sonnet)",
      "created_at": "2024-01-15T12:00:00Z"
    }
  ],
  "total_used": 50.25
}
```

### Purchase Credits

Initiates a credit purchase (returns Stripe checkout URL).

```http
POST /v1/billing/purchase
Content-Type: application/json
```

**Request Body:**
```json
{
  "amount": 100,
  "success_url": "https://app.sprintlab.id/settings/billing?success=true",
  "cancel_url": "https://app.sprintlab.id/settings/billing"
}
```

**Response:**
```json
{
  "checkout_url": "https://checkout.stripe.com/..."
}
```

---

## Voice Endpoints

### Generate Voice

Generates speech from text using AI voice synthesis.

```http
POST /v1/voice/generate
Content-Type: application/json
```

**Request Body:**
```json
{
  "text": "Hello, this is a test message.",
  "voice": "Andy",
  "reference_audio": "https://example.com/voice-sample.mp3",
  "temperature": 0.8,
  "top_p": 0.95,
  "top_k": 1000,
  "repetition_penalty": 1.2,
  "paralinguistic": false
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `text` | string | Yes | Text to convert to speech (max 3000 chars) |
| `voice` | string | No | Voice name (default: "Andy") |
| `reference_audio` | string | No | URL to reference audio for voice cloning |
| `temperature` | float | No | Generation temperature (default: 0.8) |
| `top_p` | float | No | Top-p sampling (default: 0.95) |
| `top_k` | integer | No | Top-k sampling (default: 1000) |
| `repetition_penalty` | float | No | Repetition penalty (default: 1.2) |
| `paralinguistic` | boolean | No | Add natural speech sounds via LLM (default: false) |

**Response:**
```json
{
  "audio_urls": [
    "https://replicate.delivery/...",
    "https://replicate.delivery/..."
  ],
  "char_count": 500,
  "chunk_count": 2,
  "cost": 0.02
}
```

**Notes:**
- Text exceeding 500 characters is automatically split into chunks
- Multiple audio URLs are returned for long texts (play sequentially)
- Pricing: ~$0.03 per 1000 characters
- Requires sufficient credit balance (returns 402 if insufficient)

### Generate Voice (Streaming)

Streaming version that returns audio URLs as they're generated.

```http
POST /v1/voice/generate/stream
Content-Type: application/json
```

**Request Body:** Same as `/voice/generate`

**Response:** Newline-delimited JSON (NDJSON)

```
{"chunk": 1, "total": 3, "url": "https://..."}
{"chunk": 2, "total": 3, "url": "https://..."}
{"chunk": 3, "total": 3, "url": "https://..."}
{"done": true, "char_count": 500, "chunk_count": 3, "cost": 0.02}
```

**Notes:**
- Client can start playing first chunk while subsequent chunks generate
- Each line is a complete JSON object
- Final line contains summary with `done: true`

---

## Streaming Endpoints

### Agent Run Stream

Server-Sent Events (SSE) stream for agent run updates.

```http
GET /v1/agent-run/{agent_run_id}/stream
```

**Query Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `token` | string | Yes | JWT token for auth |

**Event Types:**

See [STREAMING.md](./STREAMING.md) for detailed event documentation.

```
event: message
data: {"type": "assistant", "content": "...", "metadata": {...}}

event: message
data: {"type": "tool", "tool_name": "web_search", "output": "..."}

event: message
data: {"type": "status", "status": "completed"}
```

**Connection Headers:**
```http
Accept: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
```

---

## Error Handling

### Error Response Format

```json
{
  "detail": {
    "code": "error_code",
    "message": "Human-readable error message",
    "params": {}
  }
}
```

### Common Error Codes

| HTTP Status | Code | Description |
|-------------|------|-------------|
| 400 | `bad_request` | Invalid request parameters |
| 400 | `validation_error` | Request validation failed |
| 401 | `unauthorized` | Authentication required |
| 403 | `forbidden` | Permission denied |
| 404 | `not_found` | Resource not found |
| 409 | `conflict` | Resource conflict |
| 422 | `unprocessable_entity` | Business logic error |
| 429 | `rate_limited` | Too many requests |
| 500 | `internal_error` | Server error |
| 503 | `service_unavailable` | Service temporarily unavailable |

### Validation Errors

```json
{
  "detail": {
    "code": "validation_error",
    "message": "Validation failed",
    "params": {
      "errors": [
        {
          "field": "message",
          "message": "Field is required"
        }
      ]
    }
  }
}
```

### Credit Errors

```json
{
  "detail": {
    "code": "insufficient_credits",
    "message": "Insufficient credits to perform this operation",
    "params": {
      "required": 10.0,
      "available": 5.0
    }
  }
}
```

---

## Rate Limiting

### Limits

| Endpoint Category | Rate Limit |
|-------------------|------------|
| Agent Start | 10 requests/minute |
| API General | 100 requests/minute |
| Streaming | 5 concurrent connections |
| File Upload | 20 MB/request |

### Rate Limit Headers

```http
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 95
X-RateLimit-Reset: 1705320000
```

### Rate Limit Response

```json
{
  "detail": {
    "code": "rate_limited",
    "message": "Too many requests. Please try again later.",
    "params": {
      "retry_after": 60
    }
  }
}
```

---

## Request Examples

### cURL: Start Agent

```bash
curl -X POST "https://api.sprintlab.id/v1/agent/start?thread_id=uuid" \
  -H "Authorization: Bearer <token>" \
  -F "message=Hello, help me create a Python script" \
  -F "agent_id=uuid"
```

### cURL: List Threads

```bash
curl -X GET "https://api.sprintlab.id/v1/threads?limit=10" \
  -H "Authorization: Bearer <token>"
```

### JavaScript: Start Agent

```javascript
const formData = new FormData();
formData.append('message', 'Hello, help me create a Python script');
formData.append('agent_id', agentId);

const response = await fetch(`${API_URL}/agent/start?thread_id=${threadId}`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
  },
  body: formData,
});

const { agent_run_id, thread_id } = await response.json();
```

### JavaScript: Connect to Stream

```javascript
const eventSource = new EventSource(
  `${API_URL}/agent-run/${agentRunId}/stream?token=${token}`
);

eventSource.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log('Received:', data);
};

eventSource.onerror = (error) => {
  console.error('Stream error:', error);
  eventSource.close();
};
```

---

## Webhooks

### Stripe Webhook

Receives Stripe payment events.

```http
POST /v1/webhooks/stripe
```

Handled events:
- `checkout.session.completed`
- `invoice.paid`
- `customer.subscription.updated`
- `customer.subscription.deleted`

---

## SDK Support

### Python SDK

```python
from sprintlab import SprintLabClient

client = SprintLabClient(api_key="your-api-key")

# Start agent
run = client.agents.start(
    thread_id="uuid",
    message="Hello!",
    agent_id="uuid"
)

# Stream responses
for event in run.stream():
    print(event)
```

---

*For streaming details, see [STREAMING.md](./STREAMING.md). For backend architecture, see [BACKEND.md](./BACKEND.md).*
