# Streaming Architecture

> Detailed documentation of the real-time streaming system, including SSE architecture, Redis streams, message types, and frontend integration.

**Related Documents:** [ARCHITECTURE.md](../ARCHITECTURE.md) | [BACKEND.md](./BACKEND.md) | [FRONTEND.md](./FRONTEND.md) | [API_REFERENCE.md](./API_REFERENCE.md)

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Backend: Redis Streams](#backend-redis-streams)
3. [Message Types](#message-types)
4. [SSE Endpoint](#sse-endpoint)
5. [Frontend: StreamConnection](#frontend-streamconnection)
6. [Reconnection Strategy](#reconnection-strategy)
7. [Error Handling](#error-handling)
8. [Performance Considerations](#performance-considerations)

---

## Architecture Overview

The streaming system enables real-time communication between the agent backend and frontend clients using Server-Sent Events (SSE) backed by Redis streams.

```
┌─────────────────────────────────────────────────────────────────────┐
│                     STREAMING ARCHITECTURE                          │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐ │
│  │                      BACKEND                                   │ │
│  │                                                                │ │
│  │  ┌─────────────┐    ┌─────────────┐    ┌─────────────────┐   │ │
│  │  │ AgentRunner │───▶│   Redis     │◀───│  SSE Endpoint   │   │ │
│  │  │             │    │   Stream    │    │ /agent-run/     │   │ │
│  │  │ Writes      │    │             │    │ {id}/stream     │   │ │
│  │  │ messages    │    │ Key:        │    │                 │   │ │
│  │  └─────────────┘    │ agent_run:  │    │ Reads &         │   │ │
│  │                     │ {id}:stream │    │ forwards        │   │ │
│  │                     └─────────────┘    └────────┬────────┘   │ │
│  │                                                  │            │ │
│  └──────────────────────────────────────────────────┼────────────┘ │
│                                                     │              │
│                              SSE (text/event-stream)│              │
│                                                     │              │
│  ┌──────────────────────────────────────────────────▼────────────┐ │
│  │                      FRONTEND                                  │ │
│  │                                                                │ │
│  │  ┌─────────────────┐    ┌─────────────┐    ┌───────────────┐ │ │
│  │  │ StreamConnection│───▶│ EventSource │───▶│  React State  │ │ │
│  │  │ Class           │    │ Browser API │    │  Updates      │ │ │
│  │  │                 │    │             │    │               │ │ │
│  │  │ • Reconnection  │    │ • Automatic │    │ • Messages    │ │ │
│  │  │ • Heartbeat     │    │   parsing   │    │ • Tool output │ │ │
│  │  │ • State mgmt    │    │             │    │ • Status      │ │ │
│  │  └─────────────────┘    └─────────────┘    └───────────────┘ │ │
│  │                                                                │ │
│  └────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Backend: Redis Streams

### Stream Key Format

```
agent_run:{agent_run_id}:stream
```

Example: `agent_run:550e8400-e29b-41d4-a716-446655440000:stream`

### Writing to Stream

**File:** `backend/core/agents/runner/agent_runner.py`

```python
# Write message to Redis stream
await redis.stream_add(
    stream_key,
    {"data": json.dumps(response)},
    maxlen=200,           # Keep last 200 messages
    approximate=True      # Allow approximate trimming for performance
)
```

### Stream TTL

```python
REDIS_STREAM_TTL_SECONDS = 600  # 10 minutes

# Set TTL on stream creation
await redis.expire(stream_key, REDIS_STREAM_TTL_SECONDS)
```

### Redis Service Methods

**File:** `backend/core/services/redis.py`

```python
async def stream_add(
    key: str,
    fields: Dict[str, str],
    maxlen: int = None,
    approximate: bool = True
) -> str:
    """Add entry to Redis stream."""
    client = await get_client()
    return await client.xadd(
        key,
        fields,
        maxlen=maxlen,
        approximate=approximate
    )

async def stream_read(
    key: str,
    last_id: str = "0",
    count: int = 100,
    block: int = None
) -> List[Tuple]:
    """Read entries from Redis stream."""
    client = await get_client()
    return await client.xread(
        {key: last_id},
        count=count,
        block=block
    )

async def verify_stream_writable(key: str) -> bool:
    """Verify stream is writable (create if needed)."""
    client = await get_client()
    # Write and immediately delete test entry
    test_id = await client.xadd(key, {"test": "1"})
    await client.xdel(key, test_id)
    return True
```

---

## Message Types

### 1. Assistant Messages

Text content from the LLM:

```json
{
  "type": "assistant",
  "content": "I'll help you with that. Let me search for information...",
  "metadata": {
    "stream_status": "chunk",
    "model": "claude-3-5-sonnet"
  }
}
```

**Stream Status Values:**
| Status | Description |
|--------|-------------|
| `chunk` | Streaming chunk (partial) |
| `complete` | Final message |

### 2. Tool Call Messages

When the LLM decides to call a tool:

```json
{
  "type": "assistant",
  "content": "",
  "metadata": {
    "tool_calls": [
      {
        "id": "call_abc123",
        "type": "function",
        "function": {
          "name": "web_search",
          "arguments": "{\"query\": \"latest AI news\"}"
        }
      }
    ]
  }
}
```

### 3. Tool Result Messages

Result of tool execution:

```json
{
  "type": "tool",
  "tool_call_id": "call_abc123",
  "content": "{\"results\": [...]}",
  "metadata": {
    "tool_name": "web_search",
    "success": true,
    "execution_time_ms": 1234
  }
}
```

### 4. Status Messages

Agent execution status updates:

```json
{
  "type": "status",
  "status": "completed",
  "message": "Agent completed successfully"
}
```

**Status Values:**
| Status | Description |
|--------|-------------|
| `initializing` | Agent is starting up |
| `ready` | Agent is ready to process |
| `llm_call` | Making LLM API call |
| `llm_streaming` | Receiving LLM response |
| `tool_executing` | Executing tool |
| `completed` | Successfully finished |
| `stopped` | Manually stopped |
| `error` | Error occurred |

### 5. Tool Output Stream

Real-time tool output (e.g., shell commands):

```json
{
  "type": "tool_output_stream",
  "tool_name": "execute_command",
  "tool_call_id": "call_xyz789",
  "output": "Installing packages...\n",
  "stream_type": "stdout"
}
```

### 6. Timing Messages

Performance metrics:

```json
{
  "type": "timing",
  "first_response_ms": 1234.5,
  "timestamp": "2024-01-15T12:00:00.000Z"
}
```

### 7. Ping/Keep-Alive

Heartbeat to maintain connection:

```json
{
  "type": "ping"
}
```

---

## SSE Endpoint

**File:** `backend/core/agents/api.py`

### Endpoint Definition

```python
@router.get("/agent-run/{agent_run_id}/stream")
async def stream_agent_run(
    agent_run_id: str,
    token: str = Query(..., description="JWT token")
) -> StreamingResponse:
    """
    Stream agent run events via Server-Sent Events.

    Connect to receive real-time updates for an agent run including:
    - Assistant messages (LLM responses)
    - Tool calls and results
    - Status updates
    - Tool output streams
    """
    # Verify token
    user_id = verify_jwt_token(token)

    # Verify access to agent run
    await verify_agent_run_access(agent_run_id, user_id)

    return StreamingResponse(
        event_generator(agent_run_id),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",  # Disable nginx buffering
        }
    )
```

### Event Generator

```python
async def event_generator(agent_run_id: str):
    stream_key = f"agent_run:{agent_run_id}:stream"
    last_id = "0"

    while True:
        try:
            # Read from Redis stream (blocking)
            entries = await redis.stream_read(
                stream_key,
                last_id=last_id,
                count=50,
                block=5000  # 5 second timeout
            )

            if entries:
                for stream_name, messages in entries:
                    for message_id, fields in messages:
                        data = fields.get(b"data", b"").decode()
                        yield f"data: {data}\n\n"
                        last_id = message_id.decode()

            else:
                # Send ping to keep connection alive
                yield f"data: {json.dumps({'type': 'ping'})}\n\n"

            # Check if agent run completed
            if await is_agent_run_complete(agent_run_id):
                break

        except asyncio.CancelledError:
            break
        except Exception as e:
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"
            break
```

---

## Frontend: StreamConnection

**File:** `apps/frontend/src/lib/streaming/stream-connection.ts`

### Class Definition

```typescript
export class StreamConnection {
  private eventSource: EventSource | null = null;
  private state: ConnectionState = 'idle';
  private reconnectAttempts = 0;
  private lastMessageTime = 0;
  private isDestroyed = false;

  constructor(private options: StreamConnectionOptions) {}

  async connect(): Promise<void> {
    if (this.isDestroyed) return;

    this.cleanup();
    this.setState('connecting');

    const token = await this.options.getAuthToken();
    const url = formatStreamUrl(
      this.options.apiUrl,
      this.options.runId,
      token
    );

    this.eventSource = new EventSource(url);
    this.setupEventHandlers();
  }
}
```

### Connection States

```typescript
type ConnectionState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'streaming'
  | 'reconnecting'
  | 'error'
  | 'closed';
```

### State Transitions

```
idle ──► connecting ──► connected ──► streaming
              │              │             │
              │              └──────┬──────┘
              │                     │
              └─────────────────────▼
                              reconnecting
                                    │
                    ┌───────────────┼───────────────┐
                    │               │               │
                    ▼               ▼               ▼
                connected       error           closed
```

### Event Handlers

```typescript
private setupEventHandlers(): void {
  if (!this.eventSource) return;

  // Connection opened
  this.eventSource.addEventListener('open', () => {
    this.reconnectAttempts = 0;
    this.lastMessageTime = Date.now();
    this.setState('connected');
    this.startHeartbeatMonitor();
    this.options.onOpen?.();
  });

  // Message received
  this.eventSource.addEventListener('message', (event) => {
    this.lastMessageTime = Date.now();

    if (this.state === 'connected') {
      this.setState('streaming');
    }

    this.options.onMessage(event.data);
  });

  // Error occurred
  this.eventSource.addEventListener('error', () => {
    this.handleConnectionError();
  });
}
```

---

## Reconnection Strategy

### Exponential Backoff

```typescript
// Constants
const STREAM_CONFIG = {
  RECONNECT_BASE_DELAY_MS: 1000,      // 1 second
  RECONNECT_MAX_DELAY_MS: 30000,       // 30 seconds
  RECONNECT_MAX_ATTEMPTS: 10,
  RECONNECT_BACKOFF_MULTIPLIER: 2,
  HEARTBEAT_TIMEOUT_MS: 30000,         // 30 seconds
  HEARTBEAT_CHECK_INTERVAL_MS: 5000,   // 5 seconds
};

// Calculation
function calculateExponentialBackoff(
  attempt: number,
  baseDelay: number,
  maxDelay: number,
  multiplier: number
): number {
  const delay = baseDelay * Math.pow(multiplier, attempt);
  return Math.min(delay, maxDelay);
}
```

### Reconnection Logic

```typescript
private shouldReconnect(): boolean {
  return (
    !this.isDestroyed &&
    this.reconnectAttempts < STREAM_CONFIG.RECONNECT_MAX_ATTEMPTS &&
    this.state !== 'closed'
  );
}

private scheduleReconnect(): void {
  if (this.isDestroyed) return;

  this.setState('reconnecting');
  this.reconnectAttempts++;

  const delay = calculateExponentialBackoff(
    this.reconnectAttempts - 1,
    STREAM_CONFIG.RECONNECT_BASE_DELAY_MS,
    STREAM_CONFIG.RECONNECT_MAX_DELAY_MS,
    STREAM_CONFIG.RECONNECT_BACKOFF_MULTIPLIER
  );

  setTimeout(() => {
    if (!this.isDestroyed) {
      this.connect();
    }
  }, delay);
}
```

### Heartbeat Monitoring

```typescript
private startHeartbeatMonitor(): void {
  this.heartbeatIntervalId = setInterval(() => {
    const timeSinceLastMessage = Date.now() - this.lastMessageTime;

    if (timeSinceLastMessage > STREAM_CONFIG.HEARTBEAT_TIMEOUT_MS) {
      console.warn(
        `No message received for ${timeSinceLastMessage}ms`
      );
      this.handleConnectionError();
    }
  }, STREAM_CONFIG.HEARTBEAT_CHECK_INTERVAL_MS);
}
```

---

## Error Handling

### Backend Errors

```python
# In event_generator
try:
    entries = await redis.stream_read(...)
except redis.ConnectionError as e:
    logger.error(f"Redis connection error: {e}")
    yield f"data: {json.dumps({
        'type': 'status',
        'status': 'error',
        'message': 'Connection error. Please reconnect.'
    })}\n\n"
except Exception as e:
    logger.error(f"Stream error: {e}")
    yield f"data: {json.dumps({
        'type': 'status',
        'status': 'error',
        'message': 'An error occurred.'
    })}\n\n"
```

### Frontend Error Handling

```typescript
// In useAgentStream hook
const handleMessage = (data: string) => {
  try {
    const parsed = JSON.parse(data);

    if (parsed.type === 'status' && parsed.status === 'error') {
      setError(parsed.message);
      // Decide whether to reconnect based on error
      if (parsed.metadata?.retryable) {
        connection.scheduleReconnect();
      }
    } else {
      onMessage(parsed);
    }
  } catch (e) {
    console.error('Failed to parse message:', e);
  }
};
```

### Error Recovery

| Error Type | Recovery Action |
|------------|-----------------|
| Network disconnect | Auto-reconnect with backoff |
| Token expired | Refresh token, reconnect |
| Agent run not found | Show error, don't reconnect |
| Rate limit | Wait, then reconnect |
| Server error | Auto-reconnect with backoff |

---

## Performance Considerations

### Redis Stream Settings

```python
# Trim stream to last 200 messages
maxlen = 200
approximate = True  # Faster, allows slight over-limit

# Stream TTL for cleanup
REDIS_STREAM_TTL_SECONDS = 600  # 10 minutes
```

### Frontend Optimizations

```typescript
// Batch message updates
const messageBuffer: Message[] = [];
let flushTimeout: number | null = null;

function bufferMessage(message: Message) {
  messageBuffer.push(message);

  if (!flushTimeout) {
    flushTimeout = setTimeout(() => {
      // Batch update state
      setMessages(prev => [...prev, ...messageBuffer]);
      messageBuffer.length = 0;
      flushTimeout = null;
    }, 50); // 50ms batching window
  }
}
```

### Memory Management

```typescript
// Cleanup on unmount
useEffect(() => {
  const connection = createStreamConnection({...});
  connection.connect();

  return () => {
    connection.destroy(); // Important!
  };
}, [runId]);
```

### Connection Limits

- Max concurrent SSE connections per client: 6 (browser limit)
- Backend: 5 concurrent streams per user (configurable)
- Redis: Connection pool size = 50

---

## Usage Examples

### Frontend Hook

```typescript
function useAgentStream({
  runId,
  onMessage,
  onStatusChange,
}: UseAgentStreamOptions) {
  const connectionRef = useRef<StreamConnection | null>(null);
  const [state, setState] = useState<ConnectionState>('idle');

  useEffect(() => {
    if (!runId) return;

    const connection = createStreamConnection({
      apiUrl: process.env.NEXT_PUBLIC_BACKEND_URL!,
      runId,
      getAuthToken: async () => {
        const { data } = await supabase.auth.getSession();
        return data.session?.access_token ?? null;
      },
      onMessage: (data) => {
        const parsed = JSON.parse(data);
        onMessage(parsed);
      },
      onStateChange: (newState) => {
        setState(newState);
        onStatusChange?.(newState);
      },
    });

    connection.connect();
    connectionRef.current = connection;

    return () => {
      connection.destroy();
    };
  }, [runId]);

  return { state, connection: connectionRef.current };
}
```

### React Component

```tsx
function AgentChat({ threadId, runId }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);

  const { state } = useAgentStream({
    runId,
    onMessage: (message) => {
      if (message.type === 'assistant') {
        setMessages(prev => [...prev, message]);
      } else if (message.type === 'status') {
        // Handle status updates
        if (message.status === 'completed') {
          // Agent finished
        }
      }
    },
  });

  return (
    <div>
      <ConnectionStatus state={state} />
      <MessageList messages={messages} />
    </div>
  );
}
```

---

## Key File Locations

| Component | Path |
|-----------|------|
| Redis Service | `backend/core/services/redis.py` |
| Agent API (SSE) | `backend/core/agents/api.py` |
| Stream Writing | `backend/core/agents/runner/agent_runner.py` |
| Frontend StreamConnection | `apps/frontend/src/lib/streaming/stream-connection.ts` |
| Stream Constants | `apps/frontend/src/lib/streaming/constants.ts` |
| Stream Types | `apps/frontend/src/lib/streaming/types.ts` |
| Stream Utils | `apps/frontend/src/lib/streaming/utils.ts` |

---

*For agent orchestration details, see [AGENT_ORCHESTRATION.md](./AGENT_ORCHESTRATION.md). For frontend patterns, see [FRONTEND.md](./FRONTEND.md).*
