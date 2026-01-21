# Backend Architecture Deep-Dive

> Detailed documentation of the FastAPI backend architecture, including entry points, directory structure, core components, and service organization.

**Related Documents:** [ARCHITECTURE.md](../ARCHITECTURE.md) | [API_REFERENCE.md](./API_REFERENCE.md) | [AGENT_ORCHESTRATION.md](./AGENT_ORCHESTRATION.md) | [DATABASE.md](./DATABASE.md)

---

## Table of Contents

1. [Entry Point](#entry-point)
2. [Directory Structure](#directory-structure)
3. [Core Components](#core-components)
4. [Router Organization](#router-organization)
5. [Middleware Stack](#middleware-stack)
6. [Background Tasks](#background-tasks)
7. [Configuration Patterns](#configuration-patterns)
8. [Service Layer](#service-layer)
9. [Stateless Pipeline Architecture](#stateless-pipeline-architecture)
10. [Authentication](#authentication)

---

## Entry Point

**File:** `backend/api.py`

The FastAPI application initializes with:

```python
app = FastAPI(
    lifespan=lifespan,
    swagger_ui_parameters={"persistAuthorization": True}
)
```

### Application Lifecycle

The `lifespan` context manager handles:

1. **Startup:**
   - Database connection initialization (`DBConnection`)
   - Direct Postgres pool initialization (`init_db`)
   - Tool cache warm-up (`warm_up_tools_cache`)
   - Static Suna config loading (`load_static_suna_config`)
   - Sandbox API initialization
   - Redis connection initialization
   - Orphaned agent run cleanup
   - Trigger/credential/template API initialization
   - Background task spawning (CloudWatch metrics, memory watchdog, stream cleanup)

2. **Shutdown:**
   - Set shutdown flag for health checks
   - Stop all active agent runs
   - Cancel background tasks
   - Close Redis connection
   - Disconnect from database
   - Close direct Postgres pool

### Health Endpoints

| Endpoint | Purpose |
|----------|---------|
| `GET /v1/health` | Basic health check (returns unhealthy during shutdown) |
| `GET /v1/health-docker` | Docker health check (verifies Redis + DB connectivity) |
| `GET /v1/metrics` | System metrics (active runs, Redis streams, orphaned streams) |
| `GET /v1/debug` | Debug info (instance ID, active runs, shutdown status) |
| `GET /v1/debug/redis` | Redis health and pool diagnostics |

---

## Directory Structure

```
backend/
├── api.py                    # FastAPI application entry point
├── pyproject.toml            # Python dependencies (106 packages)
├── core/                     # Core application logic
│   ├── agentpress/           # Agent orchestration engine
│   │   ├── thread_manager.py    # Conversation orchestration
│   │   ├── context_manager.py   # Token counting & compression
│   │   ├── response_processor.py # LLM response parsing
│   │   ├── tool_registry.py     # Tool registration (agentpress)
│   │   ├── prompt_caching.py    # Anthropic cache strategy
│   │   └── error_processor.py   # Error handling
│   │
│   ├── agents/               # Agent management
│   │   ├── api.py               # Agent run endpoints
│   │   ├── agent_crud.py        # Agent CRUD operations
│   │   ├── agent_tools.py       # Agent tool configuration
│   │   ├── repo.py              # Agent repository
│   │   ├── runner/              # Execution subsystem
│   │   │   ├── agent_runner.py     # Main execution loop
│   │   │   ├── config.py           # AgentConfig dataclass
│   │   │   ├── tool_manager.py     # Tool registration
│   │   │   ├── mcp_manager.py      # MCP integration
│   │   │   └── prompt_manager.py   # System prompt building
│   │   └── pipeline/            # Execution pipelines
│   │       ├── coordinator.py      # PipelineCoordinator (default)
│   │       ├── context.py          # PipelineContext
│   │       └── stateless/          # Stateless architecture (opt-in)
│   │           ├── coordinator/    # StatelessCoordinator
│   │           ├── persistence/    # WAL, DLQ, batch writer
│   │           └── resilience/     # Circuit breaker, rate limiter
│   │
│   ├── tools/                # 32+ tool implementations
│   │   ├── tool_registry.py     # Tool categories & discovery
│   │   ├── tool_guide_registry.py # Tool usage guides
│   │   ├── sb_*.py              # Sandbox tools
│   │   ├── *_search_tool.py     # Search tools
│   │   ├── browser_tool.py      # Browser automation
│   │   ├── vapi_voice_tool.py   # Voice calls
│   │   └── agent_builder_tools/ # Agent configuration tools
│   │
│   ├── sandbox/              # Docker sandbox management
│   │   ├── sandbox.py           # Daytona SDK wrapper
│   │   ├── api.py               # Sandbox endpoints
│   │   └── tool_base.py         # SandboxToolsBase class
│   │
│   ├── services/             # External integrations
│   │   ├── llm.py               # Multi-provider LLM calls
│   │   ├── redis.py             # Redis client & streams
│   │   ├── supabase.py          # Supabase client
│   │   ├── db.py                # Direct Postgres pool
│   │   ├── langfuse.py          # Observability
│   │   ├── voice_generation.py  # Text-to-speech service
│   │   └── http_client.py       # HTTP client factory
│   │
│   ├── threads/              # Thread/message management
│   │   ├── api.py               # Thread endpoints
│   │   └── repo.py              # Thread repository
│   │
│   ├── prompts/              # System prompts
│   │   └── core_prompt.py       # Main agent prompt
│   │
│   ├── billing/              # Credit system
│   │   ├── api.py               # Billing endpoints
│   │   └── credits/             # Credit management
│   │
│   ├── auth/                 # Authentication
│   │   └── auth.py              # JWT verification
│   │
│   ├── jit/                  # Just-In-Time tool loading
│   │   ├── config.py            # JIT configuration
│   │   └── tool_cache.py        # Tool cache
│   │
│   ├── ai_models/            # Model registry
│   │   └── registry.py          # Model definitions
│   │
│   ├── cache/                # Runtime caching
│   │   └── runtime_cache.py     # Project/run caching
│   │
│   ├── admin/                # Admin dashboards
│   ├── endpoints/            # Public API endpoints
│   ├── mcp_module/           # MCP integration
│   ├── credentials/          # Credential management
│   ├── triggers/             # Automated triggers
│   ├── notifications/        # Notification system
│   ├── knowledge_base/       # Knowledge base
│   ├── memory/               # Agent memory
│   └── utils/                # Utilities
│       ├── config.py            # Configuration loading
│       ├── logger.py            # Structured logging
│       └── auth.py              # Auth utilities
│
├── supabase/                 # Database
│   ├── migrations/           # SQL migrations
│   └── config.toml           # Supabase config
│
└── tests/                    # Test suite
```

---

## Core Components

| Component | File | Purpose |
|-----------|------|---------|
| **FastAPI App** | `api.py` | Application entry point, middleware, routers |
| **ThreadManager** | `agentpress/thread_manager.py` | Conversation orchestration, LLM calls |
| **ContextManager** | `agentpress/context_manager.py` | Token counting, context compression |
| **ResponseProcessor** | `agentpress/response_processor.py` | LLM response parsing, tool detection |
| **ToolRegistry** | `agentpress/tool_registry.py` | Tool registration & schema management |
| **AgentRunner** | `agents/runner/agent_runner.py` | Agent execution loop |
| **ToolManager** | `agents/runner/tool_manager.py` | Tool registration for runs |
| **PromptManager** | `agents/runner/prompt_manager.py` | System prompt building |
| **MCPManager** | `agents/runner/mcp_manager.py` | MCP tool integration |
| **LLM Service** | `services/llm.py` | Multi-provider LLM API calls |
| **Redis Service** | `services/redis.py` | Redis client, streams, caching |
| **Supabase Service** | `services/supabase.py` | Database client |
| **ErrorProcessor** | `agentpress/error_processor.py` | Error classification & handling |

### Component Relationships

```
┌─────────────────────────────────────────────────────────────────┐
│                        api.py (FastAPI)                         │
│                              │                                  │
│         ┌────────────────────┼────────────────────┐            │
│         │                    │                    │            │
│    ┌────▼────┐         ┌─────▼─────┐        ┌────▼────┐       │
│    │ Routers │         │Background │        │Middleware│       │
│    │ (40+)   │         │  Tasks    │        │  Stack   │       │
│    └────┬────┘         └───────────┘        └──────────┘       │
│         │                                                       │
│    ┌────▼──────────────────────────────────────────────┐       │
│    │                 agents/api.py                      │       │
│    │           POST /agent/start                        │       │
│    └────┬───────────────────────────────────────────────┘       │
│         │                                                       │
│    ┌────▼──────────────────────────────────────────────┐       │
│    │              AgentRunner                           │       │
│    │    setup() → run() → _run_loop() → cleanup()      │       │
│    └────┬───────────────────────────────────────────────┘       │
│         │                                                       │
│    ┌────▼──────────────────────────────────────────────┐       │
│    │              ThreadManager                         │       │
│    │    run_thread() → LLM call → ResponseProcessor    │       │
│    └────┬───────────────────────────────────────────────┘       │
│         │                                                       │
│    ┌────▼───────┬───────────┬───────────┬──────────────┐       │
│    │ToolRegistry│LLM Service│  Redis    │  Supabase    │       │
│    │  (32+ tools)│(LiteLLM) │ (Streams) │ (PostgreSQL) │       │
│    └────────────┴───────────┴───────────┴──────────────┘       │
└─────────────────────────────────────────────────────────────────┘
```

---

## Router Organization

All routers are included under the `/v1` prefix:

```python
app.include_router(api_router, prefix="/v1")
```

### Router Categories

#### Core Routers

| Router | File | Prefix | Purpose |
|--------|------|--------|---------|
| `agent_runs_router` | `agents/api.py` | `/agent` | Agent run management |
| `agent_crud_router` | `agents/agent_crud.py` | `/agents` | Agent CRUD |
| `agent_tools_router` | `agents/agent_tools.py` | `/agent-tools` | Tool configuration |
| `threads_router` | `threads/api.py` | `/threads` | Thread management |
| `sandbox_api.router` | `sandbox/api.py` | `/sandbox` | Sandbox operations |
| `billing_router` | `billing/api.py` | `/billing` | Credits & billing |

#### Admin Routers

| Router | File | Prefix | Purpose |
|--------|------|--------|---------|
| `admin_router` | `admin/admin_api.py` | `/admin` | Admin operations |
| `billing_admin_router` | `admin/billing_admin_api.py` | `/admin/billing` | Billing admin |
| `feedback_admin_router` | `admin/feedback_admin_api.py` | `/admin/feedback` | Feedback admin |
| `analytics_admin_router` | `admin/analytics_admin_api.py` | `/admin/analytics` | Analytics |

#### Feature Routers

| Router | File | Prefix | Purpose |
|--------|------|--------|---------|
| `mcp_api.router` | `mcp_module/api.py` | `/mcp` | MCP integration |
| `credentials_api.router` | `credentials/api.py` | `/secure-mcp` | Credentials |
| `template_api.router` | `templates/api.py` | `/templates` | Templates |
| `triggers_api.router` | `triggers/api.py` | `/triggers` | Triggers |
| `notifications_api.router` | `notifications/api.py` | `/notifications` | Notifications |
| `knowledge_base_api.router` | `knowledge_base/api.py` | `/kb` | Knowledge base |
| `memory_router` | `memory/api.py` | `/memory` | Agent memory |

---

## Middleware Stack

```python
# Request logging middleware
@app.middleware("http")
async def log_requests_middleware(request: Request, call_next):
    # Clears and binds structlog context
    # Logs request start/completion/failure
    # Captures timing information

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=[...],  # Environment-specific
    allow_origin_regex=r"...",  # Vercel preview deployments
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization", "X-Project-Id", ...]
)
```

### Environment-Specific CORS

| Environment | Origins |
|-------------|---------|
| Production | `https://www.sprintlab.id`, `https://sprintlab.id` |
| Staging | `https://staging.suna.so`, `localhost:3000`, Vercel preview regex |
| Local | `http://localhost:3000`, `http://127.0.0.1:3000` |

---

## Background Tasks

Started during application lifecycle:

### 1. Worker Metrics Publisher (Production)

```python
# File: core/services/worker_metrics.py
# Publishes metrics to CloudWatch every 60 seconds
_worker_metrics_task = asyncio.create_task(worker_metrics.start_cloudwatch_publisher())
```

### 2. Memory Watchdog

```python
# File: api.py
# Monitors worker memory, detects stale agent runs
# Thresholds calculated per-worker based on total RAM
_memory_watchdog_task = asyncio.create_task(_memory_watchdog())
```

Tracks:
- Memory usage (info/warning/critical thresholds)
- `_cancellation_events` count
- Active runs from lifecycle tracker
- Stale runs (> 1 hour old)

### 3. Stream Cleanup

```python
# File: core/services/worker_metrics.py
# Cleans orphaned Redis streams without TTL
_stream_cleanup_task = asyncio.create_task(worker_metrics.start_stream_cleanup_task())
```

---

## Configuration Patterns

### Config Class

**File:** `core/utils/config.py`

```python
class Config:
    # Environment
    ENV_MODE: EnvMode  # LOCAL, STAGING, PRODUCTION

    # Supabase
    SUPABASE_URL: str
    SUPABASE_SERVICE_ROLE_KEY: str
    SUPABASE_JWT_SECRET: str

    # Redis
    REDIS_URL: str

    # LLM Providers
    ANTHROPIC_API_KEY: Optional[str]
    OPENAI_API_KEY: Optional[str]
    OPENROUTER_API_KEY: Optional[str]

    # Sandbox
    DAYTONA_API_KEY: str
    DAYTONA_SERVER_URL: str
    SANDBOX_SNAPSHOT_NAME: str

    # Tool-specific keys
    TAVILY_API_KEY: Optional[str]
    FIRECRAWL_API_KEY: Optional[str]
    VAPI_PRIVATE_KEY: Optional[str]

    # Agent behavior
    AGENT_XML_TOOL_CALLING: bool
    AGENT_NATIVE_TOOL_CALLING: bool
    AGENT_EXECUTE_ON_STREAM: bool
    AGENT_TOOL_EXECUTION_STRATEGY: str
```

### Configuration Loading

```python
# Environment variables loaded from .env
from dotenv import load_dotenv
load_dotenv()

# Accessed via singleton
from core.utils.config import config
api_key = config.TAVILY_API_KEY
```

---

## Service Layer

### LLM Service

**File:** `core/services/llm.py`

```python
async def make_llm_api_call(
    messages: List[Dict],
    model_name: str,
    temperature: float = 0,
    max_tokens: Optional[int] = None,
    tools: Optional[List[Dict]] = None,
    tool_choice: str = "auto",
    stream: bool = True,
) -> Union[Dict, AsyncGenerator]:
    # 1. Clean messages (strip internal properties)
    # 2. Configure LiteLLM parameters
    # 3. Call litellm.acompletion()
    # 4. Return streaming generator or response
```

### Redis Service

**File:** `core/services/redis.py`

Key operations:
- `stream_add()` - Add to Redis stream
- `stream_read()` - Read from stream
- `get()` / `set()` - Key-value operations
- `check_stop_signal()` - Agent cancellation
- `set_stop_signal()` - Request agent stop
- `expire()` - Set TTL on keys
- `health_check()` - Pool diagnostics

### Supabase Service

**File:** `core/services/supabase.py`

```python
class DBConnection:
    async def initialize(self):
        # Initialize HTTP/2 connection pool

    @property
    async def client(self) -> AsyncClient:
        # Returns Supabase client with service role
```

Connection pool configuration:
```python
SUPABASE_MAX_CONNECTIONS = 50
SUPABASE_HTTP2_ENABLED = True
SUPABASE_POOL_TIMEOUT = 45.0  # seconds
```

### Voice Generation Service

**File:** `core/services/voice_generation.py`

Text-to-speech service using Replicate's resemble-ai/chatterbox-turbo model.

```python
# Endpoints
POST /voice/generate          # Generate speech (returns audio URLs)
POST /voice/generate/stream   # Streaming generation (NDJSON)

# Key features
MAX_CHARS_PER_CHUNK = 500    # Text split at natural boundaries
MAX_TEXT_LENGTH = 3000       # Maximum input text length
```

**Features:**
- Automatic text chunking at sentence/word boundaries
- Rate-limited chunk generation (max 3 concurrent)
- Optional paralinguistic tag processing via LLM
- Billing integration (credits deducted per character)

---

## Stateless Pipeline Architecture

> **New** - Enterprise-grade stateless agent execution with resilience and recovery features.

**Location:** `backend/core/agents/pipeline/stateless/`

**Status:** Opt-in via environment variable `USE_STATELESS_PIPELINE=true`

The Stateless Pipeline enables agents to run across distributed workers without maintaining in-memory state, providing crash recovery, fault tolerance, and horizontal scalability. The default pipeline is currently "Fast" (`PipelineCoordinator`).

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    STATELESS PIPELINE                            │
│                                                                  │
│  ┌──────────────────┐    ┌──────────────────┐                   │
│  │ StatelessCoord.  │───▶│    RunState      │                   │
│  │  (Execution)     │    │  (In-memory)     │                   │
│  └────────┬─────────┘    └────────┬─────────┘                   │
│           │                       │                              │
│  ┌────────▼─────────┐    ┌────────▼─────────┐                   │
│  │  Tool Executor   │    │   WriteBuffer    │                   │
│  │  Response Proc.  │    │    (Flusher)     │                   │
│  └──────────────────┘    └────────┬─────────┘                   │
│                                   │                              │
│  ┌────────────────────────────────▼────────────────────────────┐│
│  │                    PERSISTENCE LAYER                         ││
│  │  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────────────┐ ││
│  │  │   WAL   │  │   DLQ   │  │ Batch   │  │ Retry Policies  │ ││
│  │  │  (Log)  │  │ (Dead   │  │ Writer  │  │ (Exp Backoff)   │ ││
│  │  └─────────┘  │ Letter) │  └─────────┘  └─────────────────┘ ││
│  │               └─────────┘                                    ││
│  └──────────────────────────────────────────────────────────────┘│
│                                                                  │
│  ┌──────────────────────────────────────────────────────────────┐│
│  │                    RESILIENCE LAYER                          ││
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  ││
│  │  │  Circuit    │  │    Rate     │  │   Backpressure      │  ││
│  │  │  Breaker    │  │   Limiter   │  │   Controller        │  ││
│  │  └─────────────┘  └─────────────┘  └─────────────────────┘  ││
│  └──────────────────────────────────────────────────────────────┘│
│                                                                  │
│  ┌──────────────────────────────────────────────────────────────┐│
│  │  Ownership │ Recovery │ Lifecycle │ Metrics │ Idempotency   ││
│  └──────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

### Key Components

| Component | File | Purpose |
|-----------|------|---------|
| `StatelessCoordinator` | `coordinator/stateless.py` | Main execution coordinator |
| `RunState` | `state.py` | In-memory state for active runs |
| `WriteBuffer` | `flusher.py` | Batched write operations |
| `RunOwnership` | `ownership.py` | Distributed run claims with TTL |
| `RunRecovery` | `recovery.py` | Orphan run detection & recovery |
| `WorkerLifecycle` | `lifecycle.py` | Graceful shutdown handling |
| `Metrics` | `metrics.py` | Observability (counters, gauges, histograms) |

### Persistence Layer

**Write-Ahead Log (WAL):** `persistence/wal.py`
- Ensures durability before acknowledging writes
- Redis-backed with configurable retention

**Dead Letter Queue (DLQ):** `persistence/dlq.py`
- Captures failed writes for manual inspection
- Prevents data loss on persistent failures

**Batch Writer:** `persistence/batch.py`
- Aggregates writes for efficient database operations
- Configurable flush intervals and batch sizes

**Retry Policies:** `persistence/retry.py`
- Exponential backoff with jitter
- Configurable max attempts and delays

### Resilience Layer

**Circuit Breaker:** `resilience/circuit_breaker.py`
```python
# States: CLOSED → OPEN → HALF_OPEN → CLOSED
CircuitConfig(
    failure_threshold=5,      # Opens after 5 failures
    success_threshold=3,      # Closes after 3 successes
    timeout_seconds=30.0,     # Time before half-open
)
```

**Rate Limiter:** `resilience/rate_limiter.py`
- Token Bucket algorithm for burst handling
- Sliding Window for smooth rate limiting

**Backpressure Controller:** `resilience/backpressure.py`
- Monitors system load (CPU, memory, queue depth)
- Dynamically adjusts acceptance rates

### Configuration

**File:** `stateless/config.py`

```python
@dataclass
class StatelessConfig:
    MAX_MESSAGES = 50              # Max messages in state
    MAX_STEPS = 100                # Max execution steps
    MAX_DURATION_SECONDS = 3600    # 1 hour max run time

    FLUSH_INTERVAL_SECONDS = 5.0   # Write buffer flush interval
    HEARTBEAT_INTERVAL_SECONDS = 15
    HEARTBEAT_TTL_SECONDS = 45     # Heartbeat expiry

    ORPHAN_THRESHOLD_SECONDS = 90  # Orphan detection threshold
    STUCK_RUN_THRESHOLD_SECONDS = 7200  # 2 hours
```

### Usage

The StatelessCoordinator is used internally by the agent execution pipeline:

```python
from core.agents.pipeline.stateless import StatelessCoordinator

coordinator = StatelessCoordinator()
async for chunk in coordinator.execute(ctx, max_steps=25):
    yield chunk  # Stream to client
```

---

## Authentication

**File:** `core/utils/auth.py`

### JWT Verification

```python
async def verify_and_get_user_id_from_jwt(
    authorization: str = Header(None)
) -> str:
    # Extracts Bearer token
    # Verifies JWT signature
    # Returns user_id from claims
```

### Role Hierarchy

```
user → admin → super_admin
```

### Usage in Routes

```python
@router.post("/threads")
async def create_thread(
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    # user_id is verified
```

---

## Error Handling

**File:** `core/agentpress/error_processor.py`

### Error Classification

```python
class ErrorProcessor:
    @staticmethod
    def process_system_error(error: Exception, context: dict) -> ProcessedError:
        # Classifies error type
        # Determines if retryable
        # Returns user-friendly message
```

### Error Types

| Type | Description | Retryable |
|------|-------------|-----------|
| `rate_limit` | Provider rate limiting | Yes |
| `timeout` | Request timeout | Yes |
| `context_length` | Token limit exceeded | No |
| `auth` | Authentication failure | No |
| `server` | Provider server error | Yes |
| `internal` | Internal error | Maybe |

---

## Key File Locations

| Purpose | Path |
|---------|------|
| FastAPI Entry | `backend/api.py` |
| Thread Manager | `backend/core/agentpress/thread_manager.py` |
| Context Manager | `backend/core/agentpress/context_manager.py` |
| Response Processor | `backend/core/agentpress/response_processor.py` |
| Tool Registry | `backend/core/tools/tool_registry.py` |
| Pipeline Coordinator | `backend/core/agents/pipeline/coordinator.py` |
| Stateless Coordinator | `backend/core/agents/pipeline/stateless/` |
| Agent Runner (Legacy) | `backend/core/agents/runner/agent_runner.py` |
| LLM Service | `backend/core/services/llm.py` |
| Redis Service | `backend/core/services/redis.py` |
| Voice Generation | `backend/core/services/voice_generation.py` |
| Configuration | `backend/core/utils/config.py` |
| System Prompt | `backend/core/prompts/core_prompt.py` |

---

*For API endpoint details, see [API_REFERENCE.md](./API_REFERENCE.md). For agent execution flow, see [AGENT_ORCHESTRATION.md](./AGENT_ORCHESTRATION.md).*
