# Backend Memory Analysis & Optimization Report

## 🔴 Critical Memory Leaks

### 1. **MCP Connections Never Cleaned Up** ⚠️ HIGHEST PRIORITY
**Location:** `core/mcp_module/mcp_service.py:101`
```python
class MCPService:
    def __init__(self):
        self._connections: Dict[str, MCPConnection] = {}  # ❌ Grows forever
```

**Problem:**
- Global singleton `mcp_service` stores MCP connections in memory
- Connections are created per agent run but **never cleaned up**
- Each connection holds:
  - `ClientSession` (HTTP/SSE streams)
  - Tool schemas
  - Connection metadata
- With many users/agents, this accumulates indefinitely

**Impact:** 
- **~50-200 KB per connection**
- 1000 users = **50-200 MB** just for MCP connections
- Connections hold open HTTP streams → memory + file descriptors

**Fix:**
```python
from collections import OrderedDict
from time import time

class MCPService:
    def __init__(self):
        self._connections: OrderedDict[str, tuple[MCPConnection, float]] = OrderedDict()
        self._max_connections = 100  # LRU limit
        self._connection_ttl = 3600  # 1 hour
    
    async def _cleanup_old_connections(self):
        """Remove connections older than TTL or if over limit"""
        now = time()
        # Remove expired connections
        expired = [
            name for name, (conn, created_at) in self._connections.items()
            if now - created_at > self._connection_ttl
        ]
        for name in expired:
            await self.disconnect_server(name)
        
        # Enforce LRU limit
        while len(self._connections) > self._max_connections:
            oldest_name = next(iter(self._connections))
            await self.disconnect_server(oldest_name)
    
    async def _connect_server_internal(self, request: MCPConnectionRequest) -> MCPConnection:
        # ... existing connection logic ...
        self._connections[request.qualified_name] = (connection, time())
        await self._cleanup_old_connections()  # Cleanup after adding
        return connection
```

**Alternative:** Use Redis for connection metadata, only keep active sessions in memory

---

### 2. **API Key Throttle Cache Grows Unbounded** ⚠️ MEDIUM PRIORITY
**Location:** `core/services/api_keys.py:107`
```python
class APIKeyService:
    _throttle_cache: Dict[str, float] = {}  # ❌ Class-level, never pruned
```

**Problem:**
- Only cleans up when cache exceeds **1000 entries**
- Only during Redis fallback (rare)
- Can grow to 1000+ entries before cleanup
- Each entry: `key_id: timestamp` (~50 bytes)

**Impact:**
- **~50 KB** at 1000 entries (acceptable but inefficient)
- Wastes memory on stale entries

**Fix:**
```python
from collections import OrderedDict
from time import time

class APIKeyService:
    _throttle_cache: OrderedDict[str, float] = OrderedDict()
    _max_cache_size = 500  # Lower threshold
    
    async def _update_last_used_throttled(self, key_id: str):
        # ... existing Redis logic ...
        
        except Exception as redis_error:
            # Cleanup more aggressively
            current_time = time()
            cutoff_time = current_time - (throttle_interval * 2)
            
            # Remove expired entries
            expired = [k for k, v in self._throttle_cache.items() if v < cutoff_time]
            for k in expired:
                self._throttle_cache.pop(k, None)
            
            # Enforce LRU limit
            while len(self._throttle_cache) > self._max_cache_size:
                self._throttle_cache.popitem(last=False)  # Remove oldest
            
            # ... rest of logic ...
```

**Better Fix:** Use Redis exclusively (remove in-memory fallback)

---

### 3. **MCPConnectionManager Stores Server Info** ⚠️ MEDIUM PRIORITY
**Location:** `core/tools/utils/mcp_connection_manager.py:12`
```python
class MCPConnectionManager:
    def __init__(self):
        self.connected_servers: Dict[str, Dict[str, Any]] = {}  # ❌ Never cleaned
```

**Problem:**
- Stores server connection info (tools, schemas) in memory
- Never cleaned up
- Can accumulate across agent runs

**Impact:** Similar to MCPService but less critical (metadata only, no active connections)

**Fix:** Same LRU + TTL approach as MCPService

---

## 🟡 Memory Optimization Opportunities

### 4. **Composio Trigger Cache** 🟡 LOW PRIORITY
**Location:** `core/composio_integration/composio_trigger_service.py:18`
```python
self._triggers_cache: Dict[str, Dict[str, Any]] = {}
self._triggers_ttl = 60  # ✅ Has TTL but no cleanup logic
```

**Problem:**
- Cache has TTL concept but no cleanup mechanism
- Can grow unbounded if keys aren't accessed

**Fix:** Add periodic cleanup or use Redis

---

### 5. **IP Tracker in API** 🟡 LOW PRIORITY
**Location:** `api.py:48`
```python
ip_tracker = OrderedDict()
MAX_CONCURRENT_IPS = 25
```

**Problem:**
- Used for rate limiting but no cleanup
- Should be fine if `MAX_CONCURRENT_IPS` is enforced, but verify

**Fix:** Ensure LRU behavior when adding new IPs

---

## ✅ Already Optimized (No Changes Needed)

### 6. **Tool Discovery Cache** ✅ GOOD
**Location:** `core/utils/tool_discovery.py:24`
```python
_SCHEMA_CACHE: Dict[Type[Tool], Dict[str, List[ToolSchema]]] = {}
_STATELESS_TOOL_INSTANCES: Dict[Type[Tool], Tool] = {}
```

**Status:** ✅ Fixed size at startup, doesn't grow

---

### 7. **Model Registry** ✅ GOOD
**Location:** `core/ai_models/registry.py:25`
```python
self._models: Dict[str, Model] = {}
self._aliases: Dict[str, str] = {}
```

**Status:** ✅ Fixed size, populated at startup

---

### 8. **Runtime Cache (Redis-based)** ✅ GOOD
**Location:** `core/runtime_cache.py`

**Status:** ✅ Uses Redis with TTLs, not in-memory

---

## 📊 Summary & Recommendations

### Priority Fixes (Do First):
1. **MCP Connections** → Add LRU cache with TTL (1 hour) and max size (100)
2. **API Key Throttle** → Use Redis exclusively or add aggressive LRU cleanup
3. **MCPConnectionManager** → Add cleanup similar to MCPService

### Where to Use LRU Cache:
- ✅ MCP connections (active sessions)
- ✅ API key throttle cache (fallback only)
- ✅ Composio trigger cache
- ✅ IP tracker (if not already LRU)

### Where to Use Redis:
- ✅ API key throttle (primary, remove in-memory fallback)
- ✅ Composio trigger cache (better than in-memory)
- ✅ MCP connection metadata (keep active sessions in memory, metadata in Redis)

### Where In-Memory is Fine:
- ✅ Tool schemas (fixed size at startup)
- ✅ Model registry (fixed size)
- ✅ Static Suna config (loaded once)

---

## Estimated Memory Savings

| Fix | Current | After Fix | Savings |
|-----|---------|-----------|---------|
| MCP Connections | ~50-200 MB (unbounded) | ~5-10 MB (LRU 100) | **40-190 MB** |
| API Key Throttle | ~50 KB (1000 entries) | ~25 KB (500 entries) | **25 KB** |
| MCPConnectionManager | ~10-50 MB (unbounded) | ~1-5 MB (LRU) | **9-45 MB** |
| **Total** | **~60-250 MB** | **~6-15 MB** | **~50-235 MB** |

---

## Implementation Priority

1. **Week 1:** Fix MCP connections (biggest impact)
2. **Week 2:** Fix API key throttle cache
3. **Week 3:** Fix MCPConnectionManager
4. **Week 4:** Monitor and optimize Composio cache if needed

