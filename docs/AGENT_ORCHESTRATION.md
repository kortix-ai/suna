# Agent Orchestration System

> Detailed documentation of the agent execution lifecycle, including AgentRunner, ThreadManager, ResponseProcessor, and the auto-continue mechanism.

**Related Documents:** [ARCHITECTURE.md](../ARCHITECTURE.md) | [BACKEND.md](./BACKEND.md) | [STREAMING.md](./STREAMING.md) | [DATABASE.md](./DATABASE.md)

---

## Table of Contents

1. [Execution Lifecycle Overview](#execution-lifecycle-overview)
2. [Stateless Pipeline](#stateless-pipeline)
3. [Component Details](#component-details)
4. [AgentRunner](#agentrunner)
5. [ThreadManager](#threadmanager)
6. [ResponseProcessor](#responseprocessor)
7. [ContextManager](#contextmanager)
8. [Prompt Caching](#prompt-caching)
9. [Auto-Continue Mechanism](#auto-continue-mechanism)
10. [Error Handling](#error-handling)
11. [Cancellation & Cleanup](#cancellation--cleanup)

---

## Execution Lifecycle Overview

When a user sends a message to an agent, the following flow occurs:

```
┌──────────────────────────────────────────────────────────────────────┐
│                      AGENT EXECUTION FLOW                            │
│                                                                      │
│  1. POST /agent/start                                                │
│         │                                                            │
│         ▼                                                            │
│  ┌─────────────────┐                                                 │
│  │ Validate & Auth │ JWT verification, billing check                 │
│  └────────┬────────┘                                                 │
│           │                                                          │
│           ▼                                                          │
│  ┌─────────────────┐                                                 │
│  │ Create/Get      │ Thread, Project, Agent Run records              │
│  │ Resources       │                                                 │
│  └────────┬────────┘                                                 │
│           │                                                          │
│           ▼                                                          │
│  ┌─────────────────┐                                                 │
│  │ Spawn Background│ asyncio.create_task(execute_agent_run(...))     │
│  │ Task            │                                                 │
│  └────────┬────────┘                                                 │
│           │                                                          │
│           ▼                                                          │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │                    AgentRunner.run()                         │    │
│  │  ┌────────────┐   ┌────────────┐   ┌────────────┐           │    │
│  │  │   setup()  │──▶│ _run_loop()│──▶│  cleanup() │           │    │
│  │  └────────────┘   └─────┬──────┘   └────────────┘           │    │
│  │                         │                                    │    │
│  │              ┌──────────▼──────────┐                        │    │
│  │              │ _execute_single_turn │ (iterates)            │    │
│  │              └──────────┬──────────┘                        │    │
│  │                         │                                    │    │
│  │              ┌──────────▼──────────┐                        │    │
│  │              │ ThreadManager       │                        │    │
│  │              │   .run_thread()     │                        │    │
│  │              └──────────┬──────────┘                        │    │
│  │                         │                                    │    │
│  │              ┌──────────▼──────────┐                        │    │
│  │              │ ResponseProcessor   │                        │    │
│  │              │ • Parse LLM chunks  │                        │    │
│  │              │ • Detect tool calls │                        │    │
│  │              │ • Execute tools     │                        │    │
│  │              └──────────┬──────────┘                        │    │
│  │                         │                                    │    │
│  │              ┌──────────▼──────────┐                        │    │
│  │              │ Stream to Redis     │                        │    │
│  │              │ → Frontend SSE      │                        │    │
│  │              └─────────────────────┘                        │    │
│  └─────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Stateless Pipeline

> **New Architecture** - The stateless pipeline provides enterprise-grade reliability for agent execution.

**Location:** `backend/core/agents/pipeline/stateless/`

**Status:** Opt-in via `USE_STATELESS_PIPELINE=true` environment variable. Default is "Fast Pipeline" (`PipelineCoordinator`).

The `StatelessCoordinator` is a new execution engine that enables:

- **Horizontal Scalability**: Agents can run across multiple workers
- **Crash Recovery**: Run state is persisted, allowing recovery from failures
- **Fault Tolerance**: Circuit breakers, retries, and dead letter queues

### StatelessCoordinator Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                   STATELESS COORDINATOR FLOW                         │
│                                                                      │
│  1. claim_ownership(run_id)     ─▶  Distributed lock via Redis      │
│           │                                                          │
│           ▼                                                          │
│  2. RunState.create(ctx)        ─▶  Initialize in-memory state      │
│           │                                                          │
│           ▼                                                          │
│  3. start_heartbeat()           ─▶  Background TTL refresh          │
│           │                                                          │
│           ▼                                                          │
│  4. _execution_loop():                                               │
│      ├── Build LLM messages                                          │
│      ├── Call LLM (streaming)                                        │
│      ├── Process response chunks                                     │
│      ├── Execute tool calls                                          │
│      └── Queue writes to WriteBuffer                                 │
│           │                                                          │
│           ▼                                                          │
│  5. WriteBuffer.flush()         ─▶  Batch persist to database       │
│           │                                                          │
│           ▼                                                          │
│  6. release_ownership()         ─▶  Clean up resources              │
└─────────────────────────────────────────────────────────────────────┘
```

### Key Features

| Feature | Description |
|---------|-------------|
| **Ownership Claims** | Only one worker can execute a run at a time (TTL-based) |
| **Heartbeat** | Workers renew claim every 15s (45s TTL) |
| **Write Buffer** | Batches DB writes every 5 seconds |
| **WAL** | Write-ahead log for durability |
| **DLQ** | Failed writes go to dead letter queue |
| **Circuit Breaker** | Fails fast when dependencies are down |
| **Recovery** | Detects orphaned runs and re-queues them |

### Configuration

```python
# stateless/config.py
MAX_STEPS = 100                    # Max execution steps
MAX_DURATION_SECONDS = 3600        # 1 hour timeout
HEARTBEAT_INTERVAL_SECONDS = 15    # Heartbeat frequency
ORPHAN_THRESHOLD_SECONDS = 90      # Orphan detection
```

See [BACKEND.md](./BACKEND.md#stateless-pipeline-architecture) for detailed architecture documentation.

---

## Component Details

| Component | File | Responsibility |
|-----------|------|----------------|
| **PipelineCoordinator** | `agents/pipeline/coordinator.py` | Default fast pipeline execution |
| **StatelessCoordinator** | `agents/pipeline/stateless/coordinator/` | Opt-in stateless execution with resilience |
| **AgentRunner** | `agents/runner/agent_runner.py` | Legacy execution (fallback) |
| **ThreadManager** | `agentpress/thread_manager.py` | Manages messages, LLM calls |
| **ResponseProcessor** | `agentpress/response_processor.py` | Parses responses, executes tools |
| **ContextManager** | `agentpress/context_manager.py` | Token counting, context compression |
| **ToolRegistry** | `agentpress/tool_registry.py` | Tool registration and discovery |
| **ToolManager** | `agents/runner/tool_manager.py` | Registers tools for agent runs |
| **PromptManager** | `agents/runner/prompt_manager.py` | Builds system prompts |
| **MCPManager** | `agents/runner/mcp_manager.py` | Manages MCP tool integration |

---

## AgentRunner

**File:** `backend/core/agents/runner/agent_runner.py`

The AgentRunner is the main orchestrator for agent execution.

### Class Structure

```python
class AgentRunner:
    def __init__(self, config: AgentConfig):
        self.config = config
        self.cancellation_event = None
        self.turn_number = 0
        self.stream_key = None

    async def setup(self):
        """Initialize agent: thread manager, tools, MCP, caching."""

    async def run(self, cancellation_event) -> AsyncGenerator:
        """Main execution: setup, then run loop, then cleanup."""

    async def _prepare_execution(self) -> dict:
        """Prepare system message and initialize tools."""

    async def _run_loop(self, system_message, cancellation_event) -> AsyncGenerator:
        """Main execution loop with auto-continue."""

    async def _execute_single_turn(self, system_message, cancellation_event) -> AsyncGenerator:
        """Execute single turn: billing check, LLM call, process response."""

    async def _cleanup(self):
        """Cleanup resources after execution."""
```

### Setup Phase

```python
async def setup(self):
    # 1. Create ThreadManager with JIT config
    self.thread_manager = ThreadManager(
        trace=self.config.trace,
        agent_config=self.config.agent_config,
        project_id=self.config.project_id,
        thread_id=self.config.thread_id,
        account_id=self.config.account_id,
        jit_config=jit_config
    )

    # 2. Initialize MCP (parallel with project metadata cache)
    await asyncio.gather(init_mcp(), cache_project_metadata())

    # 3. Warm tool cache in background
    asyncio.create_task(tool_cache.warm_cache(allowed_tools))
```

### Execution Loop

```python
async def _run_loop(self, system_message, cancellation_event):
    iteration_count = 0

    while iteration_count < self.config.max_iterations:
        self.turn_number += 1
        iteration_count += 1

        should_continue = True
        async for chunk in self._execute_single_turn(system_message, cancellation_event):
            yield chunk

            # Check for termination signals
            if chunk.get('status') == 'stopped':
                should_continue = False
                break

            # Check finish_reason
            finish_reason = extract_finish_reason(chunk)
            if finish_reason in ('stop', 'agent_terminated'):
                should_continue = False
                break

        if not should_continue:
            break
```

---

## ThreadManager

**File:** `backend/core/agentpress/thread_manager.py`

Manages conversation threads, message persistence, and LLM orchestration.

### Key Methods

| Method | Purpose |
|--------|---------|
| `create_thread()` | Creates new conversation thread |
| `add_message()` | Persists message to database |
| `get_llm_messages()` | Retrieves formatted message history |
| `run_thread()` | Main LLM execution entry point |
| `add_tool()` | Registers a tool class |

### Message Retrieval (2-Layer Cache)

```python
async def get_llm_messages(self, thread_id: str) -> List[Dict]:
    # Layer 1: Redis cache (fast)
    cached = await redis.get(f"messages:{thread_id}")
    if cached:
        return json.loads(cached)

    # Layer 2: Database query
    messages = await self._fetch_messages_from_db(thread_id)

    # Update cache
    await redis.set(f"messages:{thread_id}", json.dumps(messages), ex=60)

    return messages
```

### run_thread() Flow

```python
async def run_thread(
    self,
    thread_id: str,
    system_prompt: dict,
    stream: bool = True,
    llm_model: str = None,
    processor_config: ProcessorConfig = None,
    cancellation_event: asyncio.Event = None,
    **kwargs
) -> AsyncGenerator:
    # 1. Get message history
    messages = await self.get_llm_messages(thread_id)

    # 2. Apply context compression if needed
    messages = await self.context_manager.compress_if_needed(messages)

    # 3. Apply prompt caching (Anthropic)
    messages = self.apply_prompt_caching(messages)

    # 4. Get tool schemas
    tools = self.tool_registry.get_openapi_schemas()

    # 5. Make LLM API call
    response = await make_llm_api_call(
        messages=messages,
        model_name=llm_model,
        tools=tools,
        stream=stream
    )

    # 6. Process response
    async for chunk in self.response_processor.process(response):
        yield chunk
```

---

## ResponseProcessor

**File:** `backend/core/agentpress/response_processor.py`

Processes LLM responses, detects tool calls, and orchestrates tool execution.

### Processing Flow

```
LLM Stream
    │
    ▼
Parse Chunks
    │
    ├─ Text Content ──────► Stream to client
    │
    ├─ Tool Call (Native) ─► Parse function + args
    │                           │
    └─ Tool Call (XML) ────► Parse <tool> blocks
                                │
                                ▼
                        ┌───────────────┐
                        │ Execute Tool  │
                        │ (ToolRegistry)│
                        └───────┬───────┘
                                │
                                ▼
                        Tool Result
                                │
                                ▼
                        Feed back to LLM
                        (if auto-continue)
```

### Tool Call Detection

```python
class ResponseProcessor:
    async def process(self, response: AsyncGenerator) -> AsyncGenerator:
        accumulated_content = ""
        tool_calls = []

        async for chunk in response:
            # Check for native tool calls
            if chunk.get('tool_calls'):
                tool_calls.extend(chunk['tool_calls'])

            # Check for XML tool calls in content
            content = chunk.get('content', '')
            accumulated_content += content

            if self.config.xml_tool_calling:
                xml_tools = self._extract_xml_tools(accumulated_content)
                if xml_tools:
                    tool_calls.extend(xml_tools)

            yield chunk

        # Execute detected tools
        if tool_calls and self.config.execute_tools:
            async for result in self._execute_tools(tool_calls):
                yield result
```

### Tool Call Formats

**Native (OpenAI-style):**
```json
{
  "tool_calls": [
    {
      "id": "call_abc123",
      "type": "function",
      "function": {
        "name": "web_search",
        "arguments": "{\"query\": \"latest news\"}"
      }
    }
  ]
}
```

**XML (Claude-style):**
```xml
<tool>
<name>web_search</name>
<arguments>
{"query": "latest news"}
</arguments>
</tool>
```

### Tool Execution Strategies

```python
class ProcessorConfig:
    xml_tool_calling: bool = True
    native_tool_calling: bool = True
    execute_tools: bool = True
    execute_on_stream: bool = True
    tool_execution_strategy: str = "sequential"  # or "parallel"
```

---

## ContextManager

**File:** `backend/core/agentpress/context_manager.py`

Handles token counting and context compression to fit within model limits.

### Token Counting

```python
def count_tokens(self, messages: List[Dict], model: str) -> int:
    # Uses provider-specific tokenizers
    if "claude" in model:
        return self._count_anthropic_tokens(messages)
    elif "gpt" in model:
        return self._count_openai_tokens(messages)
    else:
        return self._count_litellm_tokens(messages, model)
```

### Compression Strategy (Multi-Tier)

```python
async def compress_if_needed(self, messages: List[Dict], max_tokens: int) -> List[Dict]:
    current_tokens = self.count_tokens(messages)

    if current_tokens <= max_tokens * self.compression_target_ratio:
        return messages  # No compression needed

    # Tier 1: Remove old tool outputs
    messages = self._remove_old_tool_outputs(messages)
    if self.count_tokens(messages) <= max_tokens * self.compression_target_ratio:
        return messages

    # Tier 2: Compress user messages
    messages = self._compress_user_messages(messages)
    if self.count_tokens(messages) <= max_tokens * self.compression_target_ratio:
        return messages

    # Tier 3: Compress assistant messages
    messages = self._compress_assistant_messages(messages)
    if self.count_tokens(messages) <= max_tokens * self.compression_target_ratio:
        return messages

    # Tier 4: Message omission from middle
    return self._omit_middle_messages(messages, max_tokens)
```

### Configuration

```python
# Keep recent messages uncompressed
keep_recent_tool_outputs = 5
keep_recent_user_messages = 10
keep_recent_assistant_messages = 10

# Target compression ratio
compression_target_ratio = 0.6  # 60% of max context
```

---

## Prompt Caching

**File:** `backend/core/agentpress/prompt_caching.py`

Implements Anthropic-specific prompt caching for cost reduction.

### 4-Block Cache Strategy

```
┌─────────────────────────────────────────────────────────┐
│                    MESSAGE STRUCTURE                     │
│                                                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │ Block 1: System Prompt                            │   │
│  │ (cached if ≥1024 tokens)                          │   │
│  │ cache_control: {"type": "ephemeral"}              │   │
│  └──────────────────────────────────────────────────┘   │
│                                                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │ Blocks 2-4: Conversation Chunks                   │   │
│  │ Adaptively distributed based on conversation      │   │
│  │ length and token distribution                     │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

### Implementation

```python
def apply_prompt_caching(self, messages: List[Dict]) -> List[Dict]:
    if not self._is_anthropic_model():
        return messages

    # Add cache control to system message
    if messages and messages[0].get('role') == 'system':
        system_tokens = self.count_tokens([messages[0]])
        if system_tokens >= 1024:
            messages[0]['cache_control'] = {"type": "ephemeral"}

    # Distribute cache breakpoints across conversation
    conversation_messages = messages[1:]
    breakpoints = self._calculate_cache_breakpoints(conversation_messages)

    for idx in breakpoints:
        if idx < len(conversation_messages):
            conversation_messages[idx]['cache_control'] = {"type": "ephemeral"}

    return [messages[0]] + conversation_messages
```

### Cost Savings

| Operation | Cost per Million Tokens |
|-----------|------------------------|
| Fresh Input | $3.00 (Sonnet) |
| Cache Write | $3.75 (one-time) |
| Cache Read | $0.30 (90% savings) |

---

## Auto-Continue Mechanism

The auto-continue mechanism allows agents to execute multiple turns autonomously.

### Triggers

```
LLM Response
    │
    ▼
finish_reason?
    │
    ├─ "tool_calls" ──────► Execute tools, Continue loop
    │
    ├─ "length" ──────────► Continue loop (response truncated)
    │
    ├─ "stop" ────────────► STOP (normal completion)
    │
    └─ "agent_terminated" ─► STOP (ask/complete tool called)
```

### Implementation

```python
async def _execute_single_turn(self, system_message, cancellation_event):
    # Check for termination signals
    terminating = check_terminating_tool_call(response)
    if terminating in ['ask', 'complete']:
        yield {"type": "status", "status": "stopped"}
        return

    # Process response
    async for chunk in self.thread_manager.run_thread(...):
        yield chunk

        # Check finish reason
        if chunk.get('finish_reason') == 'tool_calls':
            # Will auto-continue to next turn
            pass
        elif chunk.get('finish_reason') in ['stop', 'agent_terminated']:
            yield {"type": "status", "status": "stopped"}
            return
```

### Limits

```python
# Maximum auto-continue iterations
max_iterations = 25  # Configurable via AgentConfig

# Error recovery
max_consecutive_errors = 3
```

---

## Error Handling

**File:** `backend/core/agentpress/error_processor.py`

### Error Classification

```python
class ErrorProcessor:
    @staticmethod
    def process_system_error(error: Exception, context: dict) -> ProcessedError:
        # Rate limit errors
        if "rate_limit" in str(error).lower():
            return ProcessedError(
                type="rate_limit",
                message="Rate limit reached. Please wait...",
                retryable=True,
                retry_after=60
            )

        # Context length errors
        if "context_length" in str(error).lower():
            return ProcessedError(
                type="context_length",
                message="Conversation too long. Try starting a new thread.",
                retryable=False
            )

        # Default internal error
        return ProcessedError(
            type="internal",
            message="An unexpected error occurred.",
            retryable=True
        )
```

### Error Response Format

```python
@dataclass
class ProcessedError:
    type: str
    message: str
    retryable: bool
    retry_after: Optional[int] = None

    def to_stream_dict(self) -> Dict:
        return {
            "type": "status",
            "status": "error",
            "message": self.message,
            "metadata": {
                "error_type": self.type,
                "retryable": self.retryable,
                "retry_after": self.retry_after
            }
        }
```

---

## Cancellation & Cleanup

### Cancellation Flow

```python
# In execute_agent_run()
async def check_stop():
    while not stop_state['received']:
        # Check in-memory event (immediate)
        if cancellation_event.is_set():
            stop_state['received'] = True
            break

        # Check Redis stop signal (cross-instance)
        if await redis.check_stop_signal(agent_run_id):
            stop_state['received'] = True
            cancellation_event.set()
            break

        await asyncio.sleep(2.0)

# Start stop checker
stop_checker = asyncio.create_task(check_stop())
```

### Cleanup Sequence

```python
async def _cleanup(self):
    # 1. Cancel prefetch tasks
    for task in prefetch_tasks:
        task.cancel()

    # 2. Cleanup ThreadManager
    await self.thread_manager.cleanup()

    # 3. Flush Langfuse traces
    asyncio.create_task(asyncio.to_thread(langfuse.flush))

# In execute_agent_run() finally block:
finally:
    # Clear streaming context
    clear_tool_output_streaming_context()

    # Cancel stop checker
    stop_checker.cancel()

    # Set Redis stream TTL
    await redis.expire(stream_key, REDIS_STREAM_TTL_SECONDS)
```

### Graceful Shutdown (Application Level)

```python
# In api.py lifespan()
async def lifespan(app: FastAPI):
    # ... startup ...

    yield

    # Shutdown: Set flag for health checks
    _is_shutting_down = True

    # Give K8s readiness probe time
    await asyncio.sleep(2)

    # Stop all active agent runs
    for agent_run_id in _cancellation_events:
        event = _cancellation_events[agent_run_id]
        event.set()

        await update_agent_run_status(
            agent_run_id,
            "stopped",
            error=f"Instance shutdown: {instance_id}"
        )
```

---

## Key File Locations

| Component | Path |
|-----------|------|
| AgentRunner | `backend/core/agents/runner/agent_runner.py` |
| ThreadManager | `backend/core/agentpress/thread_manager.py` |
| ResponseProcessor | `backend/core/agentpress/response_processor.py` |
| ContextManager | `backend/core/agentpress/context_manager.py` |
| PromptCaching | `backend/core/agentpress/prompt_caching.py` |
| ErrorProcessor | `backend/core/agentpress/error_processor.py` |
| ToolRegistry | `backend/core/agentpress/tool_registry.py` |
| Agent API | `backend/core/agents/api.py` |

---

*For streaming details, see [STREAMING.md](./STREAMING.md). For backend overview, see [BACKEND.md](./BACKEND.md).*
