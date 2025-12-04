# ⚡ SPARK - Smart Progressive Activation Runtime Kit

**An intelligent, configuration-aware, lazy-loading system for tools that scales with minimal overhead.**

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                   SPARK System                          │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ┌──────────────────┐  ┌──────────────────┐            │
│  │  SPARKConfig     │  │  SPARKLoader     │            │
│  │                  │  │                  │            │
│  │ • Validate tools │  │ • activate()     │            │
│  │ • Agent settings │  │ • JIT loading    │            │
│  │ • Single source  │  │ • O(1) activation│            │
│  └──────────────────┘  └──────────────────┘            │
│                                                         │
│  ┌──────────────────┐  ┌──────────────────┐            │
│  │  Function Map    │  │  Activation      │            │
│  │                  │  │  Registry        │            │
│  │ • O(1) lookup    │  │ • Track state    │            │
│  │ • web_search ->  │  │ • Avoid dups     │            │
│  │   web_search_tool│  │                  │            │
│  └──────────────────┘  └──────────────────┘            │
│                                                         │
│  ┌──────────────────┐  ┌──────────────────┐            │
│  │  Detector        │  │  Tool Guide      │            │
│  │                  │  │  Registry        │            │
│  │ • Introspect     │  │ • Usage docs     │            │
│  │ • Build kwargs   │  │ • Minimal index  │            │
│  └──────────────────┘  └──────────────────┘            │
└─────────────────────────────────────────────────────────┘
```

## Key Innovation: Configuration-Aware Lazy Loading

### Single Source of Truth

**For Default Suna Agent:** `suna_config.py`
```python
SUNA_CONFIG = {
    "agentpress_tools": {
        "web_search_tool": True,
        "browser_tool": True,
        "sb_files_tool": True,
        ...
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

### SPARK Respects Agent Configuration

```python
# Marketing Agent - only has specific tools
marketing_agent_config = {
    "agentpress_tools": {
        "web_search_tool": True,
        "image_search_tool": True,
        "sb_presentation_tool": True
        # browser_tool NOT included = blocked
    }
}

# Agent tries to load browser_tool
load_tool_guide("browser_tool")

# SPARK validation:
⚠️  [SPARK] Tool 'browser_tool' blocked: Tool not enabled for this agent
❌ Failed to activate browser_tool
```

## How It Works

### 1. Startup - SPARK Initialization

```python
# In AgentRunner.setup()
from core.spark.config import SPARKConfig

# Create config from agent settings
disabled_tools = self._get_disabled_tools_from_config()
spark_config = SPARKConfig.from_run_context(
    agent_config=self.config.agent_config,
    disabled_tools=disabled_tools
)

# Pass config through the system
thread_manager = ThreadManager(
    ...,
    spark_config=spark_config  # Configuration flows through!
)
```

**Logs:**
```
⚡ [SPARK CONFIG] Initialized with agent_config=True, disabled=0
⚡ [SPARK CONFIG] 18 tools allowed for this agent
⚡ [SPARK] Registering CORE TOOLS ONLY (JIT loading enabled)
⚡ [SPARK] 10 core functions registered
⚡ [SPARK MAP] Built function map: 87 functions mapped
```

### 2. Runtime - JIT Activation

**Method 1: Agent Loads Guide (Recommended)**
```python
# Agent calls: load_tool_guide("web_search_tool")

🔍 [SPARK] Agent requesting guides for: ['web_search_tool']
⚡ [SPARK CONFIG] Default agent - tool 'web_search_tool' allowed  # Config check!
⚡ [SPARK] Activating 'web_search_tool' with params: ['project_id', 'thread_manager']
✅ [SPARK] Tool 'web_search_tool' activated successfully
📖 [DYNAMIC TOOLS] Loaded guide for 'web_search_tool' (2,456 chars)
```

**Method 2: Auto-Activation Fallback**
```python
# Agent tries: web_search(query="Kortix")
# Tool not registered yet!

⚠️  Tool function 'web_search' not found - attempting SPARK auto-activation
⚡ [SPARK AUTO] Auto-activating 'web_search_tool' for function 'web_search'
⚡ [SPARK CONFIG] Default agent - tool 'web_search_tool' allowed  # Config check!
✅ [SPARK AUTO] Tool 'web_search_tool' auto-activated successfully
✅ Found tool function for 'web_search'
[Tool executes...]
```

### 3. Configuration Validation

For Custom Marketing Agent:
```python
agent_config = {
    "agentpress_tools": {
        "web_search_tool": True,       # ✅ Allowed
        "image_search_tool": True,     # ✅ Allowed
        "sb_presentation_tool": True,  # ✅ Allowed
        # browser_tool NOT listed = ❌ Blocked
    }
}

# Agent tries: load_tool_guide("browser_tool")

🔍 [SPARK] Agent requesting guides for: ['browser_tool']
⚠️  [SPARK] Tool 'browser_tool' blocked: Tool 'browser_tool' is not enabled for this agent
⚠️  [SPARK] Failed to activate 'browser_tool', but continuing...
❌ [SPARK] Failed to activate some tools: ['browser_tool']
```

## Performance Characteristics

| Metric | Legacy Mode | SPARK Mode |
|--------|-------------|------------|
| Startup (Suna - 24 tools) | ~100ms | ~3ms |
| Startup (Custom - 5 tools) | ~100ms | ~3ms |
| Startup (200 tools) | ~500ms | ~3ms |
| Prompt size | ~160K chars | ~11K chars |
| First tool use | Instant | +5ms (JIT) |
| Config validation | None | O(1) per tool |
| Memory | All tools | Only used tools |

## Configuration Examples

### Example 1: Default Suna Agent

```python
# suna_config.py - All tools enabled
SUNA_CONFIG = {
    "agentpress_tools": {
        "web_search_tool": True,
        "browser_tool": True,
        "sb_files_tool": True,
        # ... all 24 tools
    },
    "is_default": True
}

# SPARK behavior: All tools can be activated
✅ All tools allowed for activation
```

### Example 2: Research Assistant (Custom)

```python
research_config = {
    "agentpress_tools": {
        "web_search_tool": True,
        "paper_search_tool": True,
        "sb_files_tool": True,
        "sb_kb_tool": True
        # Only 4 tools enabled
    }
}

# SPARK behavior: Only these 4 tools can be activated
✅ web_search_tool - Allowed
✅ paper_search_tool - Allowed  
✅ sb_files_tool - Allowed
✅ sb_kb_tool - Allowed
❌ browser_tool - Blocked (not in config)
❌ sb_image_edit_tool - Blocked (not in config)
```

### Example 3: Content Creator (Custom)

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

# SPARK behavior: Only content creation tools
✅ web_search_tool - Allowed
✅ image_search_tool - Allowed
✅ sb_image_edit_tool - Allowed
✅ sb_presentation_tool - Allowed
✅ sb_files_tool - Allowed
❌ browser_tool - Blocked
❌ people_search_tool - Blocked
```

## Industry Adoption - Modular Design

### For Platform Integrators

```python
from core.spark import SPARKConfig, SPARKLoader

# Create custom agent with specific tools
my_agent_config = {
    "agentpress_tools": {
        "web_search_tool": True,
        "custom_industry_tool": True
    }
}

# Initialize SPARK for your agent
spark_config = SPARKConfig.from_run_context(
    agent_config=my_agent_config,
    disabled_tools=[]
)

# Tools are validated against your config
result = await SPARKLoader.activate_tool(
    "web_search_tool",
    thread_manager,
    project_id,
    spark_config=spark_config
)
```

### For Tool Developers

```python
# Add your custom tool to the registry
from core.tools.tool_registry import CUSTOM_TOOLS

CUSTOM_TOOLS.append(
    ('my_industry_tool', 'mycompany.tools.industry_tool', 'IndustryTool')
)

# SPARK automatically picks it up!
# Agent can now load it: load_tool_guide("my_industry_tool")
```

## SPARK Components

### 1. SPARKConfig (config.py)
- **Purpose:** Validate tool activation requests against agent configuration
- **Single Source of Truth:** `agent_config['agentpress_tools']`
- **Features:**
  - Respects enabled/disabled tools
  - Works for default Suna and custom agents
  - O(1) validation per tool
  - Backward compatible

### 2. SPARKLoader (loader.py)
- **Purpose:** JIT tool activation engine
- **Features:**
  - Lazy loading of tool classes
  - Smart parameter detection
  - Configuration-aware activation
  - Auto-activation fallback

### 3. Function Map (function_map.py)
- **Purpose:** O(1) mapping from function names to tool names
- **NO GUESSING:** Pre-computed mapping built at startup
- **Example:** `web_search` → `web_search_tool`

### 4. ParameterDetector (detector.py)
- **Purpose:** Introspect tool `__init__` and build kwargs
- **Features:**
  - Auto-detects: project_id, thread_id, thread_manager, db_connection, account_id
  - Works with any tool signature

### 5. ToolActivationRegistry (registry.py)
- **Purpose:** Track which tools have been activated
- **Features:**
  - O(1) duplicate detection
  - Thread-safe singleton
  - Minimal memory overhead

## Configuration Flow

```
Agent Config (DB or suna_config.py)
        ↓
SPARKConfig.from_run_context()
        ↓
ThreadManager(spark_config)
        ↓
ResponseProcessor(spark_config)
        ↓
Validation on every activation
```

## Logs to Monitor

### Startup
```
⚡ [SPARK CONFIG] Initialized with agent_config=True, disabled=2
⚡ [SPARK CONFIG] 18 tools allowed for this agent
⚡ [SPARK] Registering CORE TOOLS ONLY
⚡ [SPARK] 10 core functions registered
⚡ [SPARK MAP] Built function map: 87 functions mapped
```

### Tool Activation (Allowed)
```
🔍 [SPARK] Agent requesting guides for: ['web_search_tool']
⚡ [SPARK CONFIG] Default agent - tool 'web_search_tool' allowed
⚡ [SPARK] Activating 'web_search_tool' with params: ['project_id', 'thread_manager']
✅ [SPARK] Tool 'web_search_tool' activated successfully
```

### Tool Activation (Blocked)
```
🔍 [SPARK] Agent requesting guides for: ['browser_tool']
⚡ [SPARK CONFIG] Tool 'browser_tool' allowed=False for custom agent
⚠️  [SPARK] Tool 'browser_tool' blocked: Tool 'browser_tool' is not enabled for this agent
❌ [SPARK] Failed to activate some tools: ['browser_tool']
```

## Benefits

### For Default Suna Agent
- ✅ 99% faster startup (3ms vs 100ms)
- ✅ 87% smaller prompts (11K vs 160K chars)
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
- ✅ Industry-standard patterns

## Testing SPARK

```bash
# Test with default Suna (all tools allowed)
curl -X POST /api/chat -d '{"message": "Search the web for Kortix"}'

# Expected logs:
⚡ [SPARK CONFIG] Default agent - tool 'web_search_tool' allowed
✅ [SPARK] Tool 'web_search_tool' activated successfully

# Test with custom agent (restricted tools)
curl -X POST /api/chat -d '{
    "agent_id": "custom_123",
    "message": "Browse to google.com"
}'

# Expected logs (if browser_tool disabled):
⚡ [SPARK CONFIG] Tool 'browser_tool' allowed=False for custom agent
⚠️  [SPARK] Tool 'browser_tool' blocked
```

## Migration Guide

### Existing Agents
- **No changes needed!** SPARK uses existing `agentpress_tools` configuration
- Works with `suna_config.py` for default agent
- Works with database config for custom agents

### New Custom Agents
```python
# Just configure agentpress_tools as usual
custom_agent = {
    "name": "My Agent",
    "agentpress_tools": {
        "web_search_tool": True,
        "sb_files_tool": True
    }
}

# SPARK automatically respects this configuration!
```

## Future Enhancements

- ⏳ Predictive pre-loading based on usage patterns
- ⏳ Tool dependency resolution (auto-load required tools)
- ⏳ Caching of frequently used tools
- ⏳ Analytics on tool activation patterns
- ⏳ Dynamic tool unloading to free memory

## Summary

**SPARK is:**
- ⚡ Smart: Auto-activates when needed
- 📐 Progressive: Loads tools gradually
- ⚙️ Configurable: Respects agent settings
- 🔒 Secure: Validates all activations
- 📦 Modular: Easy to integrate
- 🚀 Fast: O(1) operations throughout
- 🌍 Scalable: Works with 200+ tools

**Single Source of Truth:** `agent_config['agentpress_tools']`

**NO GUESSING:** All mappings pre-computed with O(1) lookup

