# JIT - Just-In-Time Tool Loading

A lazy-loading system for agent tools that loads them on-demand instead of at startup.

## Why?

**Problem:** Loading all 24 tools at startup takes ~100ms and generates ~160K chars in prompts.

**Solution:** Load only core tools at startup (3ms), load other tools when first used (+5ms per tool).

**Result:** 97% faster startup, 93% smaller prompts, same functionality.

## How It Works

### 1. Startup
```python
# Only register 3 core tools
core_tools = ['expand_msg_tool', 'message_tool', 'task_list_tool']
```

**Logs:**
```
⚡ [JIT CONFIG] Initialized with agent_config=True, disabled=0
⚡ [JIT CONFIG] 18 tools allowed for this agent
⚡ [JIT] Registering CORE TOOLS ONLY
⚡ [JIT MAP] Built function map: 87 functions mapped
```

### 2. Runtime - Tool Loading

**Method 1: Agent Loads Guide**
```python
# Agent calls: initialize_tools(["web_search_tool"])

🔍 [JIT] Agent requesting guides for: ['web_search_tool']
⚡ [JIT CONFIG] Default agent - tool 'web_search_tool' allowed
⚡ [JIT] Activating 'web_search_tool' with params: ['project_id', 'thread_manager']
✅ [JIT] Tool 'web_search_tool' activated successfully
📖 [DYNAMIC TOOLS] Loaded guide for 'web_search_tool' (2,456 chars)
```

**Method 2: Auto-Activation Fallback**
```python
# Agent tries: web_search(query="Kortix")
# Tool not registered yet!

⚠️  Tool function 'web_search' not found - attempting JIT auto-activation
⚡ [JIT AUTO] Auto-activating 'web_search_tool' for function 'web_search'
⚡ [JIT CONFIG] Default agent - tool 'web_search_tool' allowed
✅ [JIT AUTO] Tool 'web_search_tool' auto-activated successfully
[Tool executes...]
```

### 3. Configuration Validation

For Custom Marketing Agent:
```python
agent_config = {
    "agentpress_tools": {
        "web_search_tool": True,       # ✅ Allowed
        "image_search_tool": True,     # ✅ Allowed
        # browser_tool NOT listed = ❌ Blocked
    }
}

# Agent tries: initialize_tools(["browser_tool"])

🔍 [JIT] Agent requesting guides for: ['browser_tool']
⚠️  [JIT] Tool 'browser_tool' blocked: Tool 'browser_tool' is not enabled for this agent
❌ [JIT] Failed to activate some tools: ['browser_tool']
```

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                   JIT System                            │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ┌──────────────────┐  ┌──────────────────┐            │
│  │  JITConfig       │  │  JITLoader       │            │
│  │                  │  │                  │            │
│  │ • Validate tools │  │ • activate()     │            │
│  │ • Agent settings │  │ • JIT loading    │            │
│  │ • Single source  │  │ • O(1) activation│            │
│  └──────────────────┘  └──────────────────┘            │
│                                                         │
│  ┌──────────────────┐  ┌──────────────────┐            │
│  │  Function Map    │  │  Parameter       │            │
│  │                  │  │  Detector        │            │
│  │ • O(1) lookup    │  │ • Introspect     │            │
│  │ • web_search ->  │  │ • Build kwargs   │            │
│  │   web_search_tool│  │                  │            │
│  └──────────────────┘  └──────────────────┘            │
└─────────────────────────────────────────────────────────┘
```

## Performance

| Metric | Eager Loading | JIT Loading |
|--------|--------------|-------------|
| Startup (24 tools) | ~100ms | ~3ms |
| Prompt size | ~160K chars | ~11K chars |
| First tool use | Instant | +5ms |
| Memory | All tools | Only used tools |

## Configuration

### Single Source of Truth

**For Default Suna Agent:** `suna_config.py`
```python
SUNA_CONFIG = {
    "agentpress_tools": {
        "web_search_tool": True,
        "browser_tool": True,
        "sb_files_tool": True,
        # ... all 24 tools
    }
}
```

**For Custom Agents:** Database `agent_config.agentpress_tools`
```python
{
    "agentpress_tools": {
        "web_search_tool": True,      # Enabled
        "browser_tool": False,         # Disabled  
        "sb_files_tool": {
            "enabled": True,
            "methods": ["create_file", "read_file"]  # Granular control
        }
    }
}
```

### Configuration Flow

```
Agent Config (DB or suna_config.py)
        ↓
JITConfig.from_run_context()
        ↓
ThreadManager(jit_config)
        ↓
ResponseProcessor(jit_config)
        ↓
Validation on every activation
```

## Components

### 1. JITConfig (`config.py`)
- Validates tool activation against agent configuration
- Respects enabled/disabled tools
- O(1) validation per tool

### 2. JITLoader (`loader.py`)
- JIT tool activation engine
- Lazy loading of tool classes
- Smart parameter detection
- Auto-activation fallback
- **Dependency resolution with topological sort**

### 3. DependencyResolver (`dependencies.py`)
- Defines tool dependency graph (DAG)
- Topological sort for correct loading order
- Auto-loads required dependencies
- Prioritizes user-selected tools
- Respects agent config (skips blocked dependencies)

### 4. Function Map (`function_map.py`)
- O(1) mapping from function names to tool names
- Pre-computed mapping built at startup
- Example: `web_search` → `web_search_tool`

### 5. ParameterDetector (`detector.py`)
- Introspects tool `__init__` signatures
- Auto-detects: `project_id`, `thread_id`, `thread_manager`, `db_connection`, `account_id`
- Builds kwargs automatically

## Dependency Resolution

JIT automatically resolves tool dependencies using a Directed Acyclic Graph (DAG).

### How It Works

Some tools depend on other tools to function:

```python
# Dependency graph
TOOL_DEPENDENCIES = {
    'sb_presentation_tool': ['sb_files_tool'],  # Needs files to save
    'sb_image_edit_tool': ['sb_files_tool'],    # Needs files to read/write
    'sb_image_gen_tool': ['sb_files_tool'],     # Needs files to save
    'sb_upload_file_tool': ['sb_files_tool'],   # Needs files to prepare
}
```

### Example: Auto-Loading Dependencies

```python
# User requests presentation tool
initialize_tools(["sb_presentation_tool"])

# JIT automatically:
# 1. Detects sb_presentation_tool needs sb_files_tool
# 2. Checks if sb_files_tool is allowed by agent config
# 3. Loads in correct order: sb_files_tool → sb_presentation_tool

**Logs:**
⚡ [JIT] Activating 1 tools (with dependency resolution)
⚡ [JIT DEP] Auto-loading 1 dependencies: ['sb_files_tool']
⚡ [JIT DEP] Loading order: ['sb_files_tool', 'sb_presentation_tool']
⚡ [JIT] Tool 'sb_files_tool' activated successfully
⚡ [JIT] Tool 'sb_presentation_tool' activated successfully
```

### Priority System

**User-selected tools load first (within their dependency layer):**

```python
# User requests: ['presentation_tool', 'web_search_tool', 'image_edit_tool']
# Dependencies: image_edit needs files, presentation needs files

Loading order:
1. sb_files_tool           # Dependency (loaded first)
2. sb_presentation_tool    # User-selected (priority)
3. sb_image_edit_tool      # User-selected (priority)
4. web_search_tool         # User-selected (no deps, loads last)
```

### Config Validation

Dependencies respect agent configuration:

```python
# Custom agent with restricted tools
agent_config = {
    "agentpress_tools": {
        "sb_presentation_tool": True,
        # sb_files_tool NOT listed = blocked
    }
}

# User tries: initialize_tools(["sb_presentation_tool"])

⚠️  [JIT DEP] Dependency 'sb_files_tool' blocked by agent config
⚠️  [JIT DEP] Skipped 1 blocked dependencies: ['sb_files_tool']
❌ [JIT] Tool 'sb_presentation_tool' may not work correctly
```

### Adding New Dependencies

Edit `backend/core/jit/dependencies.py`:

```python
TOOL_DEPENDENCIES = {
    'your_new_tool': ['dependency1', 'dependency2'],
    'sb_presentation_tool': ['sb_files_tool'],
    # ... existing dependencies
}
```

## Usage

### Initialization

```python
from core.jit.config import JITConfig

# Create config from agent settings
disabled_tools = self._get_disabled_tools_from_config()
jit_config = JITConfig.from_run_context(
    agent_config=self.config.agent_config,
    disabled_tools=disabled_tools
)

# Pass config through the system
thread_manager = ThreadManager(
    ...,
    jit_config=jit_config
)
```

### Activating Tools

```python
from core.jit import JITLoader

# Activate a single tool
result = await JITLoader.activate_tool(
    "web_search_tool",
    thread_manager,
    project_id,
    jit_config=jit_config
)

# Activate multiple tools
result = await JITLoader.activate_multiple(
    ["web_search_tool", "sb_files_tool"],
    thread_manager,
    project_id,
    jit_config=jit_config
)
```

## Benefits

### For Default Suna Agent
- ✅ 97% faster startup (3ms vs 100ms)
- ✅ 93% smaller prompts (11K vs 160K chars)
- ✅ All tools available on-demand
- ✅ Auto-activation fallback works seamlessly

### For Custom Agents
- ✅ Only enabled tools can be activated
- ✅ Configuration enforced automatically
- ✅ Same performance benefits
- ✅ Security through tool restrictions

### For Platform Adoption
- ✅ Modular design - easy to integrate
- ✅ Configuration-driven - no code changes needed
- ✅ Scales to unlimited tools

## Examples

### Example 1: Default Suna Agent (All Tools)

```python
# All tools enabled
✅ All tools allowed for activation
```

### Example 2: Research Assistant (4 Tools)

```python
research_config = {
    "agentpress_tools": {
        "web_search_tool": True,
        "paper_search_tool": True,
        "sb_files_tool": True,
        "sb_kb_tool": True
    }
}

# Only these 4 tools can be activated
✅ web_search_tool - Allowed
✅ paper_search_tool - Allowed  
✅ sb_files_tool - Allowed
✅ sb_kb_tool - Allowed
❌ browser_tool - Blocked (not in config)
```

### Example 3: Content Creator (5 Tools)

```python
content_creator_config = {
    "agentpress_tools": {
        "web_search_tool": True,
        "image_search_tool": True,
        "sb_image_edit_tool": True,
        "sb_presentation_tool": True,
        "sb_files_tool": True
    }
}

✅ Content creation tools only
❌ Browser and people search blocked
```

## Migration

**Existing agents:** No changes needed! JIT uses existing `agentpress_tools` configuration.

**New custom agents:**
```python
custom_agent = {
    "name": "My Agent",
    "agentpress_tools": {
        "web_search_tool": True,
        "sb_files_tool": True
    }
}
# JIT automatically respects this configuration
```

## Tool Guide Caching - Preserving Anthropic's Prompt Cache

JIT uses Redis to cache tool guides, ensuring **byte-for-byte identical text** across requests. This maximizes Anthropic's prompt caching, saving costs and improving speed.

### The Problem

Claude's prompt caching requires **exact text matching**. If tool guides change even slightly between requests, the cache misses:

```python
# Request 1: Fetch guide → "## Tool\nDescription..."
# Request 2: Fetch guide → "## Tool\nDescription... "  ← Extra space = cache miss!
```

### The Solution: Two-Layer Caching

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          REQUEST FLOW WITH CACHING                           │
└─────────────────────────────────────────────────────────────────────────────┘

REQUEST 1: User says "Search for Kortix"
═══════════════════════════════════════════

Suna API
    │ initialize_tools(["web_search_tool"])
    ▼
┌─────────────────────────────────────────────────────────────┐
│  LAYER 1: Redis Cache (Our System)                         │
│  ─────────────────────────────────────────────────────────  │
│  Key: "tool_guide:v1:web_search_tool"                      │
│  redis.get() → None ❌ (Cache MISS)                         │
│                                                             │
│  Fetch from DB/File: "## web_search_tool\n..."             │
│  redis.setex(key, 3600, guide) 💾 Store for 1 hour         │
└─────────────────────────────────────────────────────────────┘
    │ Guide: "## web_search_tool\nSearch..." (2,456 chars)
    ▼
┌─────────────────────────────────────────────────────────────┐
│  Build Prompt:                                              │
│  System: You are Suna...                                   │
│  ## Available Tools:                                        │
│  ## web_search_tool                                         │
│  Search the web... [2,456 chars]                            │
│  User: Search for Kortix                                    │
└─────────────────────────────────────────────────────────────┘
    │ POST to Anthropic API
    ▼
┌─────────────────────────────────────────────────────────────┐
│  LAYER 2: Anthropic's Prompt Caching (Their System)        │
│  ───────────────────────────────────────────────────────── │
│  Hash: sha256(prompt) = "a3f5..."                          │
│  Check cache: "a3f5..." → None ❌ (MISS)                    │
│  Process full prompt → Cache for 5 min                     │
│  💾 Cached internally (Anthropic's servers)                 │
└─────────────────────────────────────────────────────────────┘
    ▼
Response: "Here are search results..."


REQUEST 2: User says "Now search for OpenAI" (30 seconds later)
═══════════════════════════════════════════════════════════════

Suna API
    │ initialize_tools(["web_search_tool"]) ← Same tool!
    ▼
┌─────────────────────────────────────────────────────────────┐
│  LAYER 1: Redis Cache                                       │
│  ─────────────────────────────────────────────────────────  │
│  Key: "tool_guide:v1:web_search_tool"                      │
│  redis.get() → ✅ HIT!                                       │
│  Returns: "## web_search_tool\n..." (IDENTICAL to Req 1)   │
│  🔑 Byte-for-byte same text!                                │
└─────────────────────────────────────────────────────────────┘
    │ IDENTICAL guide from Redis
    ▼
┌─────────────────────────────────────────────────────────────┐
│  Build Prompt (character-for-character same system prompt): │
│  System: You are Suna...                                   │
│  ## Available Tools:                                        │
│  ## web_search_tool                                         │
│  Search the web... [IDENTICAL to Request 1]                 │
│  User: Now search for OpenAI ← Only this changed           │
└─────────────────────────────────────────────────────────────┘
    │ POST to Anthropic API (same system prompt hash)
    ▼
┌─────────────────────────────────────────────────────────────┐
│  LAYER 2: Anthropic's Prompt Caching                       │
│  ───────────────────────────────────────────────────────── │
│  Hash: sha256(system_prompt) = "a3f5..." ← SAME HASH!      │
│  Check cache: "a3f5..." → ✅ HIT!                           │
│  Reuse cached embeddings, skip processing                  │
│  💰 90% cost reduction (cached tokens = 10% price)          │
│  ⚡ 2x faster (skip embedding generation)                   │
└─────────────────────────────────────────────────────────────┘
    ▼
Response: "Here are search results for OpenAI..."
```

### How Redis Enables Anthropic Cache Hits

**Without Redis:**
```python
fetch() → "text v1" → Anthropic: hash_1 → cache
fetch() → "text v2" → Anthropic: hash_2 → MISS! ❌
```

**With Redis:**
```python
redis.get() → "text v1" → Anthropic: hash_1 → cache
redis.get() → "text v1" → Anthropic: hash_1 → HIT! ✅
```

### Cache Configuration

**TTL Strategy:**
```python
Redis TTL: 1 hour       # Long enough for conversations
Anthropic TTL: ~5 min   # Managed by Anthropic

# Within 5 min: Both caches hit ✅✅
# After 5 min: Anthropic expires, but Redis ensures identical re-cache ✅
# After 1 hour: Redis expires, fetch fresh guide
```

**Version Control:**
```python
CACHE_KEY_PREFIX = "tool_guide:"
CACHE_VERSION = "v1"  # Increment when guides change

# Key format: "tool_guide:v1:web_search_tool"
# Changing version invalidates all caches
```

### Cache Operations

**Batch Operations:**
```python
# Efficient pipeline for multiple tools
cache.get_multiple(["tool1", "tool2", "tool3"])
cache.set_multiple({"tool1": "guide1", "tool2": "guide2"})
```

**Cache Management:**
```python
from core.jit.tool_cache import get_tool_cache

cache = get_tool_cache()

# Invalidate single tool (after guide update)
cache.invalidate("web_search_tool")

# Invalidate all (after deployment)
cache.invalidate_all()

# Pre-warm cache
cache.warm_cache(["web_search_tool", "sb_files_tool"])

# Get statistics
stats = cache.get_stats()
# {'enabled': True, 'cached_tools': 18, 'ttl': '1:00:00', 'version': 'v1'}
```

### Benefits

✅ **Cost Savings** - 90% reduction on cached tokens  
✅ **Speed** - 2x faster response times  
✅ **Reliability** - Identical text guarantees cache hits  
✅ **Scalability** - Works across all conversations  
✅ **Graceful Fallback** - Works without Redis (just logs warning)  

### Example Logs

```
⚡ [TOOL CACHE] Connected to Redis: redis://localhost:6379
⚡ [TOOL CACHE] Enabled with TTL=1:00:00
🔥 [CACHE WARM] Warming cache for 18 tools...
💾 [TOOL CACHE] Batch stored: 18 guides

# Later, on tool load:
⚡ [TOOL CACHE] Batch fetch: 3/3 hits
✅ [CACHE HIT] web_search_tool
✅ [CACHE HIT] sb_files_tool
✅ [CACHE HIT] browser_tool
```

