# SprintLab (Suna) - Comprehensive Architecture Documentation

> This documentation provides a complete understanding of how the SprintLab/Suna repository works, including architecture, backend systems, AI services, frontend integration, and end-to-end workflows.

**Last Updated:** January 2026

---

## Detailed Documentation

For in-depth information on specific topics, see the detailed documentation in the `docs/` folder:

| Document | Description |
|----------|-------------|
| [docs/README.md](docs/README.md) | Documentation index and navigation guide |
| [docs/BACKEND.md](docs/BACKEND.md) | Backend architecture deep-dive |
| [docs/FRONTEND.md](docs/FRONTEND.md) | Frontend architecture deep-dive |
| [docs/DATABASE.md](docs/DATABASE.md) | Database schema and Supabase integration |
| [docs/API_REFERENCE.md](docs/API_REFERENCE.md) | REST API endpoints and contracts |
| [docs/TOOL_IMPLEMENTATION_GUIDE.md](docs/TOOL_IMPLEMENTATION_GUIDE.md) | Complete guide to implementing new tools |
| [docs/AGENT_ORCHESTRATION.md](docs/AGENT_ORCHESTRATION.md) | Agent execution lifecycle and orchestration |
| [docs/STREAMING.md](docs/STREAMING.md) | Real-time streaming architecture |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | Development setup and workflows |

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Repository Structure](#2-repository-structure)
3. [Architecture Overview](#3-architecture-overview)
4. [Backend Architecture](#4-backend-architecture)
5. [Agent Orchestration System](#5-agent-orchestration-system)
6. [Tools System](#6-tools-system)
7. [LLM Integration](#7-llm-integration)
8. [Sandbox System](#8-sandbox-system)
9. [Frontend Architecture](#9-frontend-architecture)
10. [Frontend-Backend Connection](#10-frontend-backend-connection)
11. [Supabase Integration](#11-supabase-integration)
12. [End-to-End Workflows](#12-end-to-end-workflows)
13. [Configuration & Environment](#13-configuration--environment)
14. [Development Commands](#14-development-commands)

---

## 1. Project Overview

**SprintLab** (repository name: `suna`) is a platform for creating and running autonomous AI agents. The core product is the "SprintLab Super Worker" - a generalist AI agent capable of:

- **Browser automation** - Web navigation, form filling, data extraction
- **File management** - Create, edit, read files in isolated sandboxes
- **Web intelligence** - Search, research, data gathering
- **System operations** - Shell commands, Git operations
- **API integrations** - Third-party services via MCP and native tools
- **Document processing** - PDFs, spreadsheets, presentations

### Key Capabilities

| Capability | Description |
|------------|-------------|
| Autonomous Execution | Agents run multi-step tasks without human intervention |
| Tool Ecosystem | 32+ built-in tools with JIT (Just-In-Time) loading |
| Sandbox Isolation | Each project runs in isolated Docker containers |
| Real-time Streaming | SSE-based streaming for live UI updates |
| Multi-provider LLM | Supports Anthropic, OpenAI, OpenRouter, Bedrock |
| Prompt Caching | Anthropic-specific caching for cost reduction |
| Voice Generation | Text-to-speech for reading assistant messages aloud |
| Stateless Pipeline | Enterprise-grade execution with resilience & recovery |

---

## 2. Repository Structure

### Monorepo Layout

```
suna/
├── backend/                  # Python FastAPI backend
│   ├── api.py               # Main FastAPI application entry point
│   ├── core/                # Core application logic
│   │   ├── agentpress/      # Agent orchestration engine
│   │   ├── agents/          # Agent management & execution
│   │   ├── tools/           # 32+ tool implementations
│   │   ├── sandbox/         # Docker sandbox management
│   │   ├── services/        # External service integrations
│   │   ├── prompts/         # System prompts
│   │   └── ...              # Other modules
│   ├── supabase/            # Database migrations
│   └── tests/               # Test suite
│
├── apps/
│   ├── frontend/            # Next.js 15 web dashboard
│   ├── mobile/              # React Native/Expo mobile app
│   └── desktop/             # Electron desktop app
│
├── packages/
│   └── shared/              # Shared TypeScript utilities
│
├── sdk/                     # Python SDK (early development)
│
├── docker-compose.yaml      # Local development services
├── setup.py                 # Interactive setup wizard
└── start.py                 # Service startup helper
```

### Key Configuration Files

| File | Purpose |
|------|---------|
| `pnpm-workspace.yaml` | Monorepo workspace definition |
| `mise.toml` | Tool versions (Node 20, Python 3.11, uv 0.6.5) |
| `backend/pyproject.toml` | Python dependencies (106 packages) |
| `apps/frontend/package.json` | Frontend dependencies (200+ packages) |

---

## 3. Architecture Overview

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         FRONTEND LAYER                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │   Next.js    │  │ React Native │  │   Electron   │          │
│  │   Web App    │  │  Mobile App  │  │  Desktop App │          │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘          │
└─────────┼─────────────────┼─────────────────┼───────────────────┘
          │                 │                 │
          └─────────────────┼─────────────────┘
                            │
          ┌─────────────────▼─────────────────┐
          │         API GATEWAY (FastAPI)      │
          │  • REST API  • SSE Streaming       │
          │  • JWT Auth  • Rate Limiting       │
          └─────────────────┬─────────────────┘
                            │
┌───────────────────────────┼───────────────────────────┐
│                    BACKEND LAYER                       │
│  ┌────────────────────────▼────────────────────────┐  │
│  │              AGENT ORCHESTRATION                 │  │
│  │  ThreadManager → ResponseProcessor → ToolRegistry│  │
│  └────────────────────────┬────────────────────────┘  │
│                           │                           │
│  ┌────────────┬───────────┼───────────┬────────────┐ │
│  │            │           │           │            │ │
│  ▼            ▼           ▼           ▼            ▼ │
│ ┌────┐    ┌──────┐    ┌──────┐   ┌───────┐   ┌────┐ │
│ │LLM │    │Tools │    │Sandbox│   │ MCP   │   │JIT │ │
│ │API │    │(32+) │    │Docker │   │Servers│   │Load│ │
│ └────┘    └──────┘    └──────┘   └───────┘   └────┘ │
└───────────────────────────────────────────────────────┘
                            │
┌───────────────────────────┼───────────────────────────┐
│                    DATA LAYER                          │
│  ┌──────────────┐  ┌──────────────┐  ┌─────────────┐  │
│  │   Supabase   │  │    Redis     │  │   Daytona   │  │
│  │  PostgreSQL  │  │   Streams    │  │  Sandboxes  │  │
│  └──────────────┘  └──────────────┘  └─────────────┘  │
└───────────────────────────────────────────────────────┘
```

### Request Flow Summary

1. **User sends message** → Frontend captures input
2. **API call** → `POST /agent/start` with JWT auth
3. **Agent run created** → Background task spawned
4. **LLM called** → Streaming response with tools
5. **Tools executed** → In sandbox environment
6. **Response streamed** → Via Redis → SSE to frontend
7. **Messages persisted** → To Supabase PostgreSQL

---

## 4. Backend Architecture

> **See [docs/BACKEND.md](docs/BACKEND.md) for detailed backend documentation.**

### Entry Point

**File:** `backend/api.py`

The FastAPI application initializes with:
- **40+ routers** for different API domains
- **CORS middleware** with environment-specific origins
- **Request logging** via structlog
- **Graceful shutdown** handling for Kubernetes

### Directory Structure

```
backend/core/
├── agentpress/          # Core orchestration (ThreadManager, ContextManager)
├── agents/              # Agent CRUD, loading, execution
│   └── runner/          # AgentRunner, PromptManager, ToolManager
├── tools/               # 32+ tool implementations
├── sandbox/             # Docker sandbox management (Daytona SDK)
├── services/            # External integrations (LLM, Redis, Supabase)
├── threads/             # Thread/message management
├── prompts/             # System prompts (core_prompt.py)
├── billing/             # Credit system
├── auth/                # JWT & role-based access
├── endpoints/           # Public API endpoints
├── admin/               # Admin dashboards
└── utils/               # Utilities (config, logging, auth)
```

### Key Backend Components

| Component | File | Purpose |
|-----------|------|---------|
| FastAPI App | `api.py` | Application entry point |
| ThreadManager | `agentpress/thread_manager.py` | Conversation orchestration |
| ContextManager | `agentpress/context_manager.py` | Token counting & compression |
| ResponseProcessor | `agentpress/response_processor.py` | LLM response parsing |
| ToolRegistry | `agentpress/tool_registry.py` | Tool registration & discovery |
| AgentRunner | `agents/runner/agent_runner.py` | Agent execution loop |
| LLM Service | `services/llm.py` | Multi-provider LLM calls |

### Authentication

**JWT-based authentication** with Supabase Auth:

```python
# Dependency injection pattern
@router.post("/threads")
async def create_thread(
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    # user_id is verified
```

**Role hierarchy:** `user` → `admin` → `super_admin`

---

## 5. Agent Orchestration System

> **See [docs/AGENT_ORCHESTRATION.md](docs/AGENT_ORCHESTRATION.md) for detailed orchestration documentation.**

### Execution Modes

| Mode | Component | Default | Description |
|------|-----------|---------|-------------|
| **Fast** | `PipelineCoordinator` | ✅ Yes | Optimized parallel prep, direct execution |
| **Stateless** | `StatelessCoordinator` | Opt-in | Enterprise-grade with WAL, DLQ, circuit breakers |
| **Legacy** | `AgentRunner` | Fallback | Original implementation |

Enable stateless mode with env: `USE_STATELESS_PIPELINE=true`

### Core Components

```
┌─────────────────────────────────────────────────────────────┐
│                    AGENT ORCHESTRATION                       │
│                                                              │
│  ┌──────────────┐     ┌──────────────┐     ┌─────────────┐  │
│  │ AgentRunner  │────▶│ThreadManager │────▶│ LLM Service │  │
│  │              │     │              │     │  (LiteLLM)  │  │
│  └──────┬───────┘     └──────┬───────┘     └─────────────┘  │
│         │                    │                              │
│         │             ┌──────▼───────┐                      │
│         │             │  Response    │                      │
│         │             │  Processor   │                      │
│         │             └──────┬───────┘                      │
│         │                    │                              │
│         │             ┌──────▼───────┐                      │
│         └────────────▶│ToolRegistry  │                      │
│                       │  (32+ tools) │                      │
│                       └──────────────┘                      │
└─────────────────────────────────────────────────────────────┘
```

### ThreadManager (`thread_manager.py`)

**Responsibilities:**
- Manages conversation threads and message lifecycle
- Orchestrates LLM API calls with error handling
- Implements auto-continue logic (up to 25 iterations)
- Handles prompt caching and context compression
- Manages billing/credit deductions

**Key Methods:**
- `create_thread()` - Creates new conversation threads
- `add_message()` - Persists messages to database
- `get_llm_messages()` - Retrieves message history (2-layer cache)
- `run_thread()` - Main execution entry point

### ContextManager (`context_manager.py`)

**Token Counting:**
- Uses provider-specific tokenizers (Anthropic, Bedrock, LiteLLM)
- Accurate token counting per model

**Context Compression Strategy (Multi-tier):**
1. **Tier 1:** Remove old tool output messages
2. **Tier 2:** Compress user messages
3. **Tier 3:** Compress assistant messages
4. **Fallback:** Message omission from middle

**Configuration:**
```python
keep_recent_tool_outputs = 5
keep_recent_user_messages = 10
keep_recent_assistant_messages = 10
compression_target_ratio = 0.6  # 60% of max
```

### ResponseProcessor (`response_processor.py`)

**Responsibilities:**
- Processes LLM streaming/non-streaming responses
- Detects and parses tool calls (XML and native formats)
- Orchestrates tool execution (sequential/parallel)
- Handles message formatting and persistence

**Tool Call Formats:**
1. **Native (OpenAI-style):** `function` objects with `arguments` JSON
2. **XML (Claude-style):** `<tool>...</tool>` blocks

### Auto-Continue Mechanism

```
LLM Response
    │
    ▼
finish_reason?
    │
    ├─ "tool_calls" ──▶ Execute tools ──▶ Continue loop
    │
    ├─ "length" ──────▶ Continue loop
    │
    └─ "agent_terminated" ──▶ Stop (ask/complete tool)
```

- Maximum 25 auto-continue iterations (configurable)
- Error recovery with max retry limit

---

## 6. Tools System

> **See [docs/TOOL_IMPLEMENTATION_GUIDE.md](docs/TOOL_IMPLEMENTATION_GUIDE.md) for complete tool implementation guide.**

### Tool Categories

```python
CORE_TOOLS = [
    'expand_msg_tool',    # Tool loading & MCP integration
    'message_tool',       # User communication
    'task_list_tool',     # Task management
    'sb_git_sync',        # Git operations
]

SANDBOX_TOOLS = [
    'sb_shell_tool',      # Terminal/shell commands
    'sb_files_tool',      # File operations
    'sb_file_reader_tool',# File reading/search
    'sb_vision_tool',     # Image understanding
    'sb_image_edit_tool', # Image generation
    'sb_spreadsheet_tool',# Spreadsheet operations
    'sb_presentation_tool',# Presentation creation
    'sb_document_parser', # Document parsing
    'sb_upload_file_tool',# File uploads
    'sb_expose_tool',     # Port exposure
    'sb_designer_tool',   # Design tools
    'sb_kb_tool',         # Knowledge base
]

SEARCH_TOOLS = [
    'web_search_tool',    # Web search (Tavily/Firecrawl)
    'image_search_tool',  # Image search
    'paper_search_tool',  # Academic papers (Semantic Scholar)
    'people_search_tool', # People search
    'company_search_tool',# Company information
]

UTILITY_TOOLS = [
    'browser_tool',       # Web automation (Playwright)
    'vapi_voice_tool',    # Voice integration
    'reality_defender',   # Content verification
    'apify_tool',         # Web scraping
]

AGENT_BUILDER_TOOLS = [
    'agent_config_tool',  # Agent configuration
    'agent_creation_tool',# Agent creation
    'mcp_search_tool',    # MCP tool discovery
    'trigger_tool',       # Automated triggers
    'credential_profile_tool', # Credential management
]
```

### Tool Implementation Pattern

```python
from core.agentpress.tool import Tool, tool_metadata, openapi_schema, ToolResult

@tool_metadata(
    display_name="Files & Folders",
    description="Create, edit, and organize files",
    icon="FolderOpen",
    color="bg-blue-100 dark:bg-blue-800/50",
    is_core=True,
    weight=10,
    visible=True,
    usage_guide="### FILE OPERATIONS\n..."
)
class SandboxFilesTool(SandboxToolsBase):

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "create_file",
            "description": "Create a new file",
            "parameters": {
                "type": "object",
                "properties": {
                    "file_path": {"type": "string"},
                    "file_contents": {"type": "string"}
                },
                "required": ["file_path", "file_contents"]
            }
        }
    })
    async def create_file(self, file_path: str, file_contents: str) -> ToolResult:
        sandbox = await self._ensure_sandbox()
        # Implementation...
        return self.success_response({"path": file_path})
```

### Tool Registration Flow

```
Agent Start
    │
    ▼
ToolManager.register_core_tools()
    │
    ├─ Always: ExpandMessageTool, MessageTool, TaskListTool
    │
    ├─ If API key: web_search_tool, image_search_tool
    │
    └─ If enabled in agent config: browser_tool, etc.
    │
    ▼
ToolRegistry stores {function_name: callable_method}
    │
    ▼
get_openapi_schemas() returns schemas for LLM
```

### JIT (Just-In-Time) Tool Loading

The `initialize_tools` function allows agents to load detailed usage guides on-demand:

```python
# Agent determines needed tools
# Calls initialize_tools once with all tool names
await initialize_tools(["browser_tool", "web_search_tool", "sb_files_tool"])
# Agent receives detailed usage guides
# Can now use those tools effectively
```

---

## 7. LLM Integration

### Supported Providers

| Provider | Models | Capabilities |
|----------|--------|--------------|
| **OpenRouter** | MiniMax, Grok, GLM-4 | Chat, Functions, Thinking |
| **Anthropic (Bedrock)** | Claude 3.5 Haiku | Chat, Functions, Vision, Caching |
| **OpenAI** | GPT-4, etc. | Chat, Functions |
| **MiniMax** | minimax-01 | Chat, Functions, Thinking |

### Model Registry

**File:** `backend/core/ai_models/registry.py`

```python
# Registered models (examples)
"sprintlab/basic"  # OpenRouter/MiniMax - $0.30M input / $1.20M output
"sprintlab/power"  # OpenRouter/MiniMax with Thinking
"sprintlab/haiku"  # Bedrock/Anthropic Claude Haiku
```

### LLM Call Flow

**File:** `backend/core/services/llm.py`

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

### Prompt Caching (Anthropic)

**File:** `backend/core/agentpress/prompt_caching.py`

**Cache Strategy (4-Block Distribution):**
1. **Block 1:** System prompt (cached if ≥1024 tokens)
2. **Blocks 2-4:** Adaptive conversation chunks

**Cost Savings:** 70-90% reduction via:
- Cache hits: $0.10 per million (vs $1.00 fresh)
- Cache writes: $1.25-$2.00 per million (one-time)

### Token Tracking & Billing

```python
usage = {
    "prompt_tokens": int,
    "completion_tokens": int,
    "cache_read_input_tokens": int,      # Cache hits
    "cache_creation_input_tokens": int,  # Cache writes
    "total_tokens": int
}

# Credits deducted after each LLM response
await billing_integration.deduct_usage(
    account_id=account_id,
    prompt_tokens=prompt_tokens,
    completion_tokens=completion_tokens,
    model=model_name,
    cache_read_tokens=cache_read_tokens
)
```

---

## 8. Sandbox System

### Architecture

The sandbox system uses **Daytona SDK** to manage isolated Docker containers per project.

```
┌─────────────────────────────────────────────────────────┐
│                    SANDBOX ARCHITECTURE                  │
│                                                          │
│  ┌─────────────────────────────────────────────────────┐│
│  │              Docker Container                        ││
│  │  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌──────────┐  ││
│  │  │  Xvfb   │ │   VNC   │ │ noVNC   │ │ Browser  │  ││
│  │  │ Display │ │ Server  │ │  Web    │ │   API    │  ││
│  │  └─────────┘ └─────────┘ └─────────┘ └──────────┘  ││
│  │                                                      ││
│  │  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌──────────┐  ││
│  │  │  HTTP   │ │  File   │ │  Shell  │ │ Process  │  ││
│  │  │ Server  │ │ System  │ │  Exec   │ │ Manager  │  ││
│  │  └─────────┘ └─────────┘ └─────────┘ └──────────┘  ││
│  └─────────────────────────────────────────────────────┘│
│                                                          │
│  Workspace: /workspace (persistent storage)              │
└─────────────────────────────────────────────────────────┘
```

### Sandbox Lifecycle

**File:** `backend/core/sandbox/sandbox.py`

```python
# Creation (lazy, per project)
async def create_sandbox(password: str, project_id: str) -> AsyncSandbox:
    # Creates from snapshot: sprintlab/suna:0.1.3.28
    # Auto-stop: 15 minutes
    # Auto-archive: 30 minutes

# Retrieval/Start
async def get_or_start_sandbox(sandbox_id: str) -> AsyncSandbox:
    # Gets existing or starts stopped sandbox
    # Handles ARCHIVED, STOPPED, ARCHIVING states

# Deletion
async def delete_sandbox(sandbox_id: str) -> bool:
    # Complete removal for cleanup
```

### Docker Image Capabilities

**Base:** `python:3.11-slim-bookworm`

**Installed:**
- Browser: Playwright, Chrome, Chromium
- Display: Xvfb, VNC server, noVNC web client
- File Tools: PDF (poppler-utils, wkhtmltopdf), Office docs
- Text: grep, sed, awk, jq, csvkit
- OCR: Tesseract
- Languages: Node.js, npm, pnpm, Python
- VCS: Git
- Process: Supervisor, tmux

### Command Execution

```python
# Session-based execution
await sandbox.process.create_session(session_id)
await sandbox.process.execute_session_command(
    session_id,
    SessionExecuteRequest(
        command=f"bash -lc {shlex.quote(full_cmd)}",
        var_async=False
    )
)
```

**Security:**
- Shell escaping via `shlex.quote()`
- Session isolation
- 30-second timeout
- Working directory control

### File Operations

```python
# Via Daytona SDK
await sandbox.fs.upload_file(content, path)
content = await sandbox.fs.download_file(path)
files = await sandbox.fs.list_files(path)
await sandbox.fs.delete_file(path)
```

---

## 9. Frontend Architecture

> **See [docs/FRONTEND.md](docs/FRONTEND.md) for detailed frontend documentation.**

### Tech Stack

| Technology | Purpose |
|------------|---------|
| **Next.js 15** | React framework with App Router |
| **TypeScript** | Type safety |
| **Tailwind CSS 4** | Styling |
| **Radix UI** | Accessible components |
| **Zustand** | State management |
| **TanStack Query** | Server state |
| **TipTap** | Rich text editor |

### Directory Structure

```
apps/frontend/src/
├── app/                 # Next.js App Router pages
├── components/
│   ├── thread/          # Chat/conversation components
│   │   └── tool-views/  # Tool-specific visualizations
│   ├── ui/              # Base UI components
│   └── ...
├── hooks/               # Custom React hooks
├── stores/              # Zustand state stores
├── lib/
│   ├── api/             # API client functions
│   ├── streaming/       # SSE streaming utilities
│   └── supabase/        # Supabase client
└── utils/               # Utilities
```

### Key Stores (Zustand)

| Store | Purpose |
|-------|---------|
| `agent-selection-store` | Currently selected agent |
| `sprintlab-computer-store` | Sandbox view state (files, browser, tools) |
| `message-queue-store` | Message buffering during streaming |
| `tool-stream-store` | Real-time tool output |
| `subscription-store` | Billing/subscription state |
| `voice-player-store` | Text-to-speech playback |

### React Query Configuration

```typescript
defaultOptions: {
  queries: {
    staleTime: 20_000,        // 20 seconds
    gcTime: 120_000,          // 2 minutes
    refetchOnWindowFocus: false,
    refetchOnReconnect: 'always'
  }
}
```

---

## 10. Frontend-Backend Connection

> **See [docs/STREAMING.md](docs/STREAMING.md) for detailed streaming documentation and [docs/API_REFERENCE.md](docs/API_REFERENCE.md) for API details.**

### API Client

**File:** `apps/frontend/src/lib/api-client.ts`

```typescript
const backendApi = {
  get: <T>(url, options?) => fetch(baseUrl + url, {...}),
  post: <T>(url, body, options?) => fetch(...),
  // ... put, patch, delete, upload
}

// Every request includes JWT
const { data: { session } } = await supabase.auth.getSession();
headers['Authorization'] = `Bearer ${session.access_token}`;
```

### Real-Time Streaming (SSE)

**File:** `apps/frontend/src/lib/streaming/stream-connection.ts`

```typescript
class StreamConnection {
  // URL: /agent-run/{runId}/stream?token={token}
  private eventSource: EventSource;

  connect(): void {
    this.eventSource = new EventSource(url);
    this.eventSource.onmessage = (event) => {
      // Parse JSON from Redis stream
      this.options.onMessage(event.data);
    };
  }
}
```

**Features:**
- Automatic reconnection with exponential backoff (1s → 30s)
- Heartbeat monitoring (30s timeout)
- Deduplication across reconnections

### Message Types from Backend

```typescript
// Text chunks
{"type": "assistant", "content": "...", "metadata": "{\"stream_status\": \"chunk\"}"}

// Tool calls
{"type": "assistant", "metadata": "{\"tool_calls\": [...]}"}

// Tool results
{"type": "tool", "metadata": "{\"tool_call_id\": \"...\"}"}

// Status updates
{"type": "status", "status": "completed|stopped|error"}

// Tool output streaming
{"type": "tool_output_stream", "tool_name": "...", "output": "..."}

// Keep-alive
{"type": "ping"}
```

### Data Flow Hooks

```typescript
// Thread data
useThreadData(threadId) // Fetches thread, messages, agent runs

// Agent streaming
useAgentStream({
  runId,
  onMessage: (msg) => {...},
  onStatusChange: (status) => {...}
})

// Mutations
useStartAgentMutation() // POST /agent/start
useStopAgentMutation()  // POST /agent-run/{id}/stop
```

---

## 11. Supabase Integration

> **See [docs/DATABASE.md](docs/DATABASE.md) for complete database documentation.**

### Database Schema (Key Tables)

```sql
-- Conversations
threads (thread_id, account_id, project_id, name, metadata)
messages (message_id, thread_id, type, content, is_llm_message)
projects (project_id, account_id, name, sandbox_resource_id)

-- Agents
agents (agent_id, account_id, name, system_prompt, agentpress_tools)
agent_runs (id, thread_id, agent_id, status, started_at, completed_at)

-- Billing
credit_accounts (user_id, balance)
credit_ledger (user_id, amount, type, created_at)

-- Users
basejump.accounts (account_id, ...)
user_roles (user_id, role)  -- user, admin, super_admin
```

### Row Level Security (RLS)

**85+ tables** with RLS enabled. Key patterns:

```sql
-- Account-based access (most common)
CREATE POLICY "Account members can access" ON table_name
    FOR ALL USING (basejump.has_role_on_account(account_id) = true);

-- Self-access only
CREATE POLICY "Users view own credits" ON credit_accounts
    FOR SELECT USING (auth.uid() = user_id);

-- Service role override
CREATE POLICY "Service manages all" ON table_name
    FOR ALL USING (auth.role() = 'service_role');
```

### Storage Buckets

| Bucket | Purpose | Limit |
|--------|---------|-------|
| `file-uploads` | User file uploads | 50MB |
| `agent-profile-images` | Agent avatars | 5MB |
| `browser-screenshots` | Screenshot storage | - |
| `recordings` | Agent recordings | - |
| `knowledge-base` | KB entry files | - |

### Realtime Subscriptions

```sql
-- Enabled for projects table
ALTER PUBLICATION supabase_realtime ADD TABLE projects;
```

Used for live sandbox status updates.

### Connection Pool (Backend)

```python
# Per-worker singleton with HTTP/2 multiplexing
SUPABASE_MAX_CONNECTIONS = 50
SUPABASE_HTTP2_ENABLED = True
SUPABASE_POOL_TIMEOUT = 45.0  # seconds
```

- 8-16 Gunicorn workers × 100 streams = 800+ concurrent requests

---

## 12. End-to-End Workflows

### Complete Message Flow

```
┌──────────────────────────────────────────────────────────────┐
│ 1. USER SENDS MESSAGE                                        │
│    Frontend: ChatInput → handleSubmit()                      │
│    API: POST /agent/start with FormData                      │
└────────────────────────┬─────────────────────────────────────┘
                         │
┌────────────────────────▼─────────────────────────────────────┐
│ 2. BACKEND RECEIVES REQUEST                                   │
│    • JWT verification                                         │
│    • Billing check                                            │
│    • Create/get thread & project                              │
│    • Store user message in messages table                     │
│    • Create agent_run record (status: pending)                │
│    • Spawn background task                                    │
│    • Return {thread_id, agent_run_id, status: running}        │
└────────────────────────┬─────────────────────────────────────┘
                         │
┌────────────────────────▼─────────────────────────────────────┐
│ 3. AGENT EXECUTION (Background)                               │
│    AgentRunner.setup():                                       │
│    • Create ThreadManager                                     │
│    • Register tools (32+)                                     │
│    • Build system prompt                                      │
│    • Setup Redis stream                                       │
└────────────────────────┬─────────────────────────────────────┘
                         │
┌────────────────────────▼─────────────────────────────────────┐
│ 4. LLM CALL                                                   │
│    ThreadManager.run_thread():                                │
│    • Fetch message history (Redis cache → DB)                 │
│    • Apply context compression if needed                      │
│    • Apply prompt caching (Anthropic)                         │
│    • Call litellm.acompletion(stream=True)                    │
└────────────────────────┬─────────────────────────────────────┘
                         │
┌────────────────────────▼─────────────────────────────────────┐
│ 5. RESPONSE PROCESSING                                        │
│    ResponseProcessor:                                         │
│    • Parse streaming chunks                                   │
│    • Detect tool calls (XML or native)                        │
│    • Execute tools in sandbox                                 │
│    • Feed results back to LLM                                 │
│    • Auto-continue loop (up to 25 iterations)                 │
└────────────────────────┬─────────────────────────────────────┘
                         │
┌────────────────────────▼─────────────────────────────────────┐
│ 6. STREAMING TO FRONTEND                                      │
│    • Chunks written to Redis stream                           │
│    • Frontend EventSource receives via SSE                    │
│    • Messages accumulated and displayed                       │
│    • Tool outputs shown in real-time                          │
└────────────────────────┬─────────────────────────────────────┘
                         │
┌────────────────────────▼─────────────────────────────────────┐
│ 7. PERSISTENCE                                                │
│    • Assistant message saved to messages table                │
│    • Tool results saved as tool messages                      │
│    • Usage/billing deducted                                   │
│    • agent_run status updated to completed                    │
└──────────────────────────────────────────────────────────────┘
```

### Tool Execution Example

```
User: "Create a Python file that prints Hello World"
                    │
                    ▼
LLM decides to use sb_files_tool.create_file
                    │
                    ▼
ResponseProcessor detects tool call
                    │
                    ▼
ToolRegistry.execute("create_file", {
    "file_path": "hello.py",
    "file_contents": "print('Hello World')"
})
                    │
                    ▼
SandboxFilesTool._ensure_sandbox()  # Lazy init
                    │
                    ▼
sandbox.fs.upload_file(content, "/workspace/hello.py")
                    │
                    ▼
ToolResult returned to LLM
                    │
                    ▼
LLM continues or terminates
```

---

## 13. Configuration & Environment

### Required Environment Variables

**Backend (.env):**
```bash
# Supabase
SUPABASE_URL=https://[project].supabase.co
SUPABASE_SERVICE_ROLE_KEY=[secret]
SUPABASE_JWT_SECRET=[secret]

# Redis
REDIS_URL=redis://localhost:6379

# LLM Providers
ANTHROPIC_API_KEY=[key]
OPENAI_API_KEY=[key]
OPENROUTER_API_KEY=[key]

# Sandbox
DAYTONA_API_KEY=[key]
DAYTONA_SERVER_URL=[url]
SANDBOX_SNAPSHOT_NAME=sprintlab/suna:0.1.3.28

# Search (Optional)
TAVILY_API_KEY=[key]
FIRECRAWL_API_KEY=[key]

# Billing
STRIPE_API_KEY=[key]
STRIPE_WEBHOOK_SECRET=[secret]

# Observability (Optional)
LANGFUSE_PUBLIC_KEY=[key]
LANGFUSE_SECRET_KEY=[secret]
```

**Frontend (.env.local):**
```bash
NEXT_PUBLIC_BACKEND_URL=http://localhost:8000
NEXT_PUBLIC_SUPABASE_URL=https://[project].supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=[public-key]
```

### Configuration Files

| File | Purpose |
|------|---------|
| `backend/core/utils/config.py` | Backend configuration loading |
| `backend/supabase/config.toml` | Supabase local config |
| `mise.toml` | Tool versions |

---

## 14. Development Commands

> **See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for complete development setup and workflows.**

### Setup & Start

```bash
# Interactive setup wizard
python setup.py

# Start all services
python start.py

# Or with Docker
docker compose up -d
```

### Backend Development

```bash
cd backend

# Install dependencies
uv sync

# Start FastAPI server (localhost:8000)
uv run api.py

# Run tests
pytest
pytest -m e2e         # End-to-end tests
pytest -m slow        # Slow tests

# Linting
make lint
make lint-fix
```

### Frontend Development

```bash
cd apps/frontend

# Install dependencies
pnpm install

# Start dev server (localhost:3000)
pnpm run dev

# Build for production
pnpm run build

# Lint & format
pnpm run lint
pnpm run format
```

### Docker Services

```bash
# Start all
docker compose up -d

# Specific services
docker compose up -d redis backend frontend

# View logs
docker compose logs -f backend

# Stop
docker compose down
```

---

## Appendix: Key File Locations

| Purpose | File Path |
|---------|-----------|
| FastAPI Entry | `backend/api.py` |
| Thread Manager | `backend/core/agentpress/thread_manager.py` |
| Context Manager | `backend/core/agentpress/context_manager.py` |
| Response Processor | `backend/core/agentpress/response_processor.py` |
| Tool Registry | `backend/core/tools/tool_registry.py` |
| Agent Runner | `backend/core/agents/runner/agent_runner.py` |
| Pipeline Coordinator | `backend/core/agents/pipeline/coordinator.py` |
| Stateless Pipeline | `backend/core/agents/pipeline/stateless/` |
| LLM Service | `backend/core/services/llm.py` |
| Voice Generation | `backend/core/services/voice_generation.py` |
| Sandbox Manager | `backend/core/sandbox/sandbox.py` |
| System Prompt | `backend/core/prompts/core_prompt.py` |
| Frontend API Client | `apps/frontend/src/lib/api-client.ts` |
| Stream Connection | `apps/frontend/src/lib/streaming/stream-connection.ts` |
| Database Migrations | `backend/supabase/migrations/` |

---

## Assumptions & Notes

1. **Model Registry:** The exact models and pricing may change; the registry (`backend/core/ai_models/registry.py`) is the source of truth.

2. **Tool Availability:** Some tools require API keys (e.g., `TAVILY_API_KEY` for web search). Tools are conditionally loaded based on configuration.

3. **Sandbox Provider:** The system uses Daytona SDK for sandbox management. The specific provider and pricing depend on deployment configuration.

4. **Billing System:** Credit pricing and tier structures are managed via Stripe and database configuration.

5. **MCP Integration:** Model Context Protocol (MCP) allows external tool integrations but requires additional configuration per MCP server.

---

*This documentation was generated by analyzing the codebase structure and implementation files. For the most current information, refer to the source code directly.*
