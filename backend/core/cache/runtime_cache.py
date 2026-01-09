"""
Runtime caching layer for latency optimization.

This module provides Redis-based caching for frequently accessed data:
- Agent configs (Suna static + user MCPs, custom agent configs)
- Project metadata (sandbox info)
- Running runs count (concurrent limit checks)
- Thread count (thread limit checks)

All caches use explicit invalidation on data changes, with TTL as safety net.
"""
import json
import time
from typing import Dict, Any, Optional, Union
from core.utils.logger import logger

# Use orjson for cache operations (3-5x faster than stdlib json)
try:
    import orjson
    _HAS_ORJSON = True
except ImportError:
    _HAS_ORJSON = False

def _json_dumps(value: Any) -> str:
    """Fast JSON serialization using orjson when available."""
    if _HAS_ORJSON:
        return orjson.dumps(value).decode('utf-8')
    return json.dumps(value)

def _json_loads(value: Union[str, bytes]) -> Any:
    """Fast JSON deserialization using orjson when available."""
    if _HAS_ORJSON:
        if isinstance(value, str):
            return orjson.loads(value.encode('utf-8'))
        return orjson.loads(value)
    if isinstance(value, bytes):
        return json.loads(value.decode('utf-8'))
    return json.loads(value)

# ============================================================================
# STATIC SUNA CONFIG - Loaded once at startup, never expires
# This is Python code that's identical across all workers - safe to keep in memory
# ============================================================================
_SUNA_STATIC_CONFIG: Optional[Dict[str, Any]] = None
_SUNA_STATIC_LOADED = False

def get_static_suna_config() -> Optional[Dict[str, Any]]:
    """Get the static Suna config (loaded once at startup)."""
    return _SUNA_STATIC_CONFIG

def load_static_suna_config() -> Dict[str, Any]:
    """
    Load Suna's static config into memory ONCE.
    This includes: system_prompt, model, agentpress_tools, restrictions.
    
    This is safe to cache in memory because it's Python code - identical across all workers.
    """
    global _SUNA_STATIC_CONFIG, _SUNA_STATIC_LOADED
    
    if _SUNA_STATIC_LOADED:
        return _SUNA_STATIC_CONFIG
    
    from core.config.suna_config import SUNA_CONFIG
    from core.config.config_helper import _extract_agentpress_tools_for_run
    
    _SUNA_STATIC_CONFIG = {
        'system_prompt': SUNA_CONFIG['system_prompt'],
        'model': SUNA_CONFIG['model'],
        'agentpress_tools': _extract_agentpress_tools_for_run(SUNA_CONFIG['agentpress_tools']),
        'centrally_managed': True,
        'is_suna_default': True,
        'restrictions': {
            'system_prompt_editable': False,
            'tools_editable': False,
            'name_editable': False,
            'description_editable': False,
            'mcps_editable': True
        }
    }
    
    _SUNA_STATIC_LOADED = True
    logger.info(f"✅ Loaded static Suna config into memory (prompt: {len(_SUNA_STATIC_CONFIG['system_prompt'])} chars)")
    return _SUNA_STATIC_CONFIG

# ============================================================================
# AGENT CONFIG CACHE - Redis, invalidated on version changes
# ============================================================================
AGENT_CONFIG_TTL = 3600  # 1 hour (was 24h - reduced to save Redis memory)

def _get_cache_key(agent_id: str, version_id: Optional[str] = None) -> str:
    """Generate Redis cache key for agent config."""
    if version_id:
        return f"agent_config:{agent_id}:{version_id}"
    return f"agent_config:{agent_id}:current"

def _get_user_mcps_key(agent_id: str) -> str:
    """Generate cache key for user-specific MCPs."""
    return f"agent_mcps:{agent_id}"


async def get_cached_user_mcps(agent_id: str) -> Optional[Dict[str, Any]]:
    """
    Get user-specific MCPs from Redis cache.
    
    Returns dict with configured_mcps, custom_mcps, triggers.
    """
    cache_key = _get_user_mcps_key(agent_id)
    
    try:
        from core.services import redis as redis_service
        
        cached = await redis_service.get(cache_key)
        if cached:
            data = _json_loads(cached) if isinstance(cached, (str, bytes)) else cached
            logger.debug(f"⚡ Redis cache hit for user MCPs: {agent_id}")
            return data
    except Exception as e:
        logger.warning(f"Failed to get user MCPs from cache: {e}")
    
    return None


async def set_cached_user_mcps(
    agent_id: str,
    configured_mcps: list,
    custom_mcps: list,
    triggers: list = None
) -> None:
    """Cache user-specific MCPs in Redis."""
    cache_key = _get_user_mcps_key(agent_id)
    data = {
        'configured_mcps': configured_mcps,
        'custom_mcps': custom_mcps,
        'triggers': triggers or []
    }
    
    try:
        from core.services import redis as redis_service
        await redis_service.set(cache_key, _json_dumps(data), ex=AGENT_CONFIG_TTL)
        logger.debug(f"✅ Cached user MCPs in Redis: {agent_id}")
    except Exception as e:
        logger.warning(f"Failed to cache user MCPs: {e}")


MCP_VERSION_CONFIG_TTL = 300

def _get_mcp_version_config_key(agent_id: str) -> str:
    return f"mcp_version_config:{agent_id}"


async def get_cached_mcp_version_config(agent_id: str) -> Optional[Dict[str, Any]]:
    cache_key = _get_mcp_version_config_key(agent_id)
    
    try:
        from core.services import redis as redis_service
        
        cached = await redis_service.get(cache_key)
        if cached:
            data = _json_loads(cached) if isinstance(cached, (str, bytes)) else cached
            logger.debug(f"⚡ Redis cache hit for MCP version config: {agent_id}")
            return data
    except Exception as e:
        logger.warning(f"Failed to get MCP version config from cache: {e}")
    
    return None


async def set_cached_mcp_version_config(agent_id: str, config: Dict[str, Any]) -> None:
    cache_key = _get_mcp_version_config_key(agent_id)
    
    try:
        from core.services import redis as redis_service
        await redis_service.set(cache_key, _json_dumps(config), ex=MCP_VERSION_CONFIG_TTL)
        logger.debug(f"✅ Cached MCP version config in Redis: {agent_id}")
    except Exception as e:
        logger.warning(f"Failed to cache MCP version config: {e}")


async def invalidate_mcp_version_config(agent_id: str) -> None:
    cache_key = _get_mcp_version_config_key(agent_id)
    
    try:
        from core.services import redis as redis_service
        await redis_service.delete(cache_key)
        logger.debug(f"🗑️ Invalidated MCP version config cache: {agent_id}")
    except Exception as e:
        logger.warning(f"Failed to invalidate MCP version config: {e}")


async def get_cached_agent_config(
    agent_id: str,
    version_id: Optional[str] = None
) -> Optional[Dict[str, Any]]:
    """
    Get agent config from Redis cache.
    
    For custom agents only - Suna uses get_static_suna_config() + get_cached_user_mcps().
    """
    cache_key = _get_cache_key(agent_id, version_id)
    
    try:
        from core.services import redis as redis_service
        
        cached = await redis_service.get(cache_key)
        if cached:
            data = _json_loads(cached) if isinstance(cached, (str, bytes)) else cached
            logger.debug(f"⚡ Redis cache hit for agent config: {agent_id}")
            return data
    except Exception as e:
        logger.warning(f"Failed to get agent config from cache: {e}")
    
    return None


async def set_cached_agent_config(
    agent_id: str,
    config: Dict[str, Any],
    version_id: Optional[str] = None,
    is_suna_default: bool = False
) -> None:
    """Cache full agent config in Redis."""
    if is_suna_default:
        # For Suna, only cache the MCPs (static config is in memory from Python code)
        await set_cached_user_mcps(
            agent_id,
            config.get('configured_mcps', []),
            config.get('custom_mcps', []),
            config.get('triggers', [])
        )
        return
    
    cache_key = _get_cache_key(agent_id, version_id)
    
    try:
        from core.services import redis as redis_service
        await redis_service.set(cache_key, _json_dumps(config), ex=AGENT_CONFIG_TTL)
        logger.debug(f"✅ Cached custom agent config in Redis: {agent_id}")
    except Exception as e:
        logger.warning(f"Failed to cache agent config: {e}")


async def invalidate_agent_config_cache(agent_id: str) -> None:
    """Invalidate cached configs for an agent in Redis using batch delete."""
    try:
        from core.services.redis import delete_multiple
        keys = [
            f"agent_config:{agent_id}:current",
            f"agent_mcps:{agent_id}"
        ]
        deleted = await delete_multiple(keys, timeout=5.0)
        logger.info(f"🗑️ Invalidated Redis cache for agent: {agent_id} ({deleted} keys)")
    except Exception as e:
        logger.warning(f"Failed to invalidate cache: {e}")


async def warm_up_suna_config_cache() -> None:
    """
    Load static Suna config into memory at worker startup.
    
    This is instant since it just reads from SUNA_CONFIG (Python code).
    No DB calls needed for the static parts.
    """
    t_start = time.time()
    
    # Load static Suna config (system prompt, model, tools) - instant
    load_static_suna_config()
    
    elapsed = (time.time() - t_start) * 1000
    logger.info(f"✅ Suna static config loaded in {elapsed:.1f}ms (zero DB calls)")


# ============================================================================
# PROJECT METADATA CACHE - Invalidated on sandbox changes
# ============================================================================
PROJECT_CACHE_TTL = 300  # 5 minutes (invalidated on sandbox change)

def _get_project_cache_key(project_id: str) -> str:
    """Generate Redis cache key for project metadata."""
    return f"project_meta:{project_id}"


async def get_cached_project_metadata(project_id: str) -> Optional[Dict[str, Any]]:
    """
    Get project metadata (sandbox info) from Redis cache.
    Eliminates ~300ms DB query on repeated agent runs.
    """
    cache_key = _get_project_cache_key(project_id)
    
    try:
        from core.services import redis as redis_service
        
        cached = await redis_service.get(cache_key)
        if cached:
            data = _json_loads(cached) if isinstance(cached, (str, bytes)) else cached
            logger.debug(f"⚡ Redis cache hit for project metadata: {project_id}")
            return data
    except Exception as e:
        logger.warning(f"Failed to get project metadata from cache: {e}")
    
    return None


async def set_cached_project_metadata(project_id: str, sandbox: Dict[str, Any]) -> None:
    """Cache project metadata in Redis."""
    cache_key = _get_project_cache_key(project_id)
    data = {'project_id': project_id, 'sandbox': sandbox}
    
    try:
        from core.services import redis as redis_service
        await redis_service.set(cache_key, _json_dumps(data), ex=PROJECT_CACHE_TTL)
        logger.debug(f"✅ Cached project metadata in Redis: {project_id}")
    except Exception as e:
        logger.warning(f"Failed to cache project metadata: {e}")


async def invalidate_project_cache(project_id: str) -> None:
    """Invalidate cached project metadata."""
    try:
        from core.services import redis as redis_service
        await redis_service.delete(_get_project_cache_key(project_id))
        logger.debug(f"🗑️ Invalidated project cache: {project_id}")
    except Exception as e:
        logger.warning(f"Failed to invalidate project cache: {e}")


# Alias for backwards compatibility
invalidate_project_metadata = invalidate_project_cache


# ============================================================================
# RUNNING RUNS CACHE - Short TTL for concurrent runs limit checks
# ============================================================================
RUNNING_RUNS_TTL = 5  # 5 seconds - needs fresh data for limit accuracy

def _get_running_runs_key(account_id: str) -> str:
    """Generate Redis cache key for running runs count."""
    return f"running_runs:{account_id}"


async def get_cached_running_runs(account_id: str) -> Optional[Dict[str, Any]]:
    """
    Get running runs data from Redis cache.
    Short TTL to balance freshness and latency.
    """
    cache_key = _get_running_runs_key(account_id)
    
    try:
        from core.services import redis as redis_service
        
        cached = await redis_service.get(cache_key)
        if cached:
            data = _json_loads(cached) if isinstance(cached, (str, bytes)) else cached
            logger.debug(f"⚡ Redis cache hit for running runs: {account_id}")
            return data
    except Exception as e:
        logger.warning(f"Failed to get running runs from cache: {e}")
    
    return None


async def set_cached_running_runs(
    account_id: str, 
    running_count: int, 
    running_thread_ids: list
) -> None:
    """Cache running runs data in Redis."""
    cache_key = _get_running_runs_key(account_id)
    # Convert UUIDs to strings for JSON serialization
    thread_ids_str = [str(tid) for tid in running_thread_ids] if running_thread_ids else []
    data = {
        'running_count': running_count,
        'running_thread_ids': thread_ids_str,
        'cached_at': time.time()
    }
    
    try:
        from core.services import redis as redis_service
        await redis_service.set(cache_key, _json_dumps(data), ex=RUNNING_RUNS_TTL)
        logger.debug(f"✅ Cached running runs in Redis: {account_id} ({running_count} runs)")
    except Exception as e:
        logger.warning(f"Failed to cache running runs: {e}")


async def invalidate_running_runs_cache(account_id: str) -> None:
    """Invalidate cached running runs when agent starts/stops."""
    try:
        from core.services import redis as redis_service
        await redis_service.delete(_get_running_runs_key(account_id))
        logger.debug(f"🗑️ Invalidated running runs cache: {account_id}")
    except Exception as e:
        logger.warning(f"Failed to invalidate running runs cache: {e}")


# ============================================================================
# THREAD COUNT CACHE - Invalidated on thread create/delete
# ============================================================================
THREAD_COUNT_TTL = 300  # 5 minutes (invalidated on create/delete)

def _get_thread_count_key(account_id: str) -> str:
    """Generate Redis cache key for thread count."""
    return f"thread_count:{account_id}"


async def get_cached_thread_count(account_id: str) -> Optional[int]:
    """Get thread count from Redis cache."""
    cache_key = _get_thread_count_key(account_id)
    
    try:
        from core.services import redis as redis_service
        
        cached = await redis_service.get(cache_key)
        if cached is not None:
            count = int(cached) if isinstance(cached, (str, bytes)) else cached
            logger.debug(f"⚡ Redis cache hit for thread count: {account_id} ({count} threads)")
            return count
    except Exception as e:
        logger.warning(f"Failed to get thread count from cache: {e}")
    
    return None


async def set_cached_thread_count(account_id: str, count: int) -> None:
    """Cache thread count in Redis."""
    cache_key = _get_thread_count_key(account_id)
    
    try:
        from core.services import redis as redis_service
        await redis_service.set(cache_key, str(count), ex=THREAD_COUNT_TTL)
        logger.debug(f"✅ Cached thread count in Redis: {account_id} ({count} threads)")
    except Exception as e:
        logger.warning(f"Failed to cache thread count: {e}")


async def increment_thread_count_cache(account_id: str) -> None:
    """Increment cached thread count when a new thread is created."""
    cache_key = _get_thread_count_key(account_id)
    
    try:
        from core.services import redis as redis_service
        # Use INCR for atomic increment, but only if key exists
        current = await redis_service.get(cache_key)
        if current is not None:
            await redis_service.incr(cache_key)
            logger.debug(f"✅ Incremented thread count cache: {account_id}")
    except Exception as e:
        logger.warning(f"Failed to increment thread count cache: {e}")


async def invalidate_thread_count_cache(account_id: str) -> None:
    """Invalidate cached thread count when thread is deleted."""
    try:
        from core.services import redis as redis_service
        await redis_service.delete(_get_thread_count_key(account_id))
        logger.debug(f"🗑️ Invalidated thread count cache: {account_id}")
    except Exception as e:
        logger.warning(f"Failed to invalidate thread count cache: {e}")


# ============================================================================
# KNOWLEDGE BASE CONTEXT CACHE - Short TTL, invalidated on KB mutations
# ============================================================================
KB_CONTEXT_TTL = 300  # 5 minutes

def _get_kb_context_key(agent_id: str) -> str:
    """Generate Redis cache key for knowledge base context."""
    return f"kb_context:{agent_id}"


async def get_cached_kb_context(agent_id: str) -> Optional[str]:
    """
    Get knowledge base context from Redis cache.
    Returns None on cache miss, empty string if cached as "no entries".
    """
    cache_key = _get_kb_context_key(agent_id)
    
    try:
        from core.services import redis as redis_service
        
        cached = await redis_service.get(cache_key)
        if cached is not None:
            # Empty string means "no entries", None means cache miss
            data = cached.decode() if isinstance(cached, bytes) else cached
            logger.debug(f"⚡ Redis cache hit for KB context: {agent_id}")
            return data if data else None  # Return None for empty string (no entries)
    except Exception as e:
        logger.warning(f"Failed to get KB context from cache: {e}")
    
    return None  # Cache miss


async def set_cached_kb_context(agent_id: str, context: str) -> None:
    """
    Cache knowledge base context in Redis.
    Use empty string to cache "no entries" result.
    """
    cache_key = _get_kb_context_key(agent_id)
    
    try:
        from core.services import redis as redis_service
        # Store empty string as empty string (to distinguish from cache miss)
        await redis_service.set(cache_key, context, ex=KB_CONTEXT_TTL)
        logger.debug(f"✅ Cached KB context in Redis: {agent_id} ({len(context)} chars)")
    except Exception as e:
        logger.warning(f"Failed to cache KB context: {e}")


async def invalidate_kb_context_cache(agent_id: str) -> None:
    """Invalidate cached knowledge base context when KB entries change."""
    try:
        from core.services import redis as redis_service
        await redis_service.delete(_get_kb_context_key(agent_id))
        logger.debug(f"🗑️ Invalidated KB context cache: {agent_id}")
    except Exception as e:
        logger.warning(f"Failed to invalidate KB context cache: {e}")


# ============================================================================
# USER CONTEXT CACHE - Locale + username, invalidated on profile updates
# ============================================================================
USER_CONTEXT_TTL = 900  # 15 minutes

def _get_user_context_key(user_id: str) -> str:
    """Generate Redis cache key for user context."""
    return f"user_context:{user_id}"


async def get_cached_user_context(user_id: str) -> Optional[str]:
    """
    Get user context (locale + username) from Redis cache.
    Returns None on cache miss, empty string if cached as "no context".
    """
    cache_key = _get_user_context_key(user_id)
    
    try:
        from core.services import redis as redis_service
        
        cached = await redis_service.get(cache_key)
        if cached is not None:
            data = cached.decode() if isinstance(cached, bytes) else cached
            logger.debug(f"⚡ Redis cache hit for user context: {user_id}")
            return data if data else None  # Return None for empty string (no context)
    except Exception as e:
        logger.warning(f"Failed to get user context from cache: {e}")
    
    return None  # Cache miss


async def set_cached_user_context(user_id: str, context: str) -> None:
    """
    Cache user context in Redis.
    Use empty string to cache "no context" result.
    """
    cache_key = _get_user_context_key(user_id)
    
    try:
        from core.services import redis as redis_service
        await redis_service.set(cache_key, context, ex=USER_CONTEXT_TTL)
        logger.debug(f"✅ Cached user context in Redis: {user_id} ({len(context)} chars)")
    except Exception as e:
        logger.warning(f"Failed to cache user context: {e}")


async def invalidate_user_context_cache(user_id: str) -> None:
    """Invalidate cached user context when profile is updated."""
    try:
        from core.services import redis as redis_service
        await redis_service.delete(_get_user_context_key(user_id))
        logger.debug(f"🗑️ Invalidated user context cache: {user_id}")
    except Exception as e:
        logger.warning(f"Failed to invalidate user context cache: {e}")


# ============================================================================
# MESSAGE HISTORY CACHE - Short TTL for repeated turns in same thread
# ============================================================================
MESSAGE_HISTORY_TTL = 60  # 1 minute - very short since messages change frequently

def _get_message_history_key(thread_id: str) -> str:
    """Generate Redis cache key for message history."""
    return f"message_history:{thread_id}"


async def get_cached_message_history(thread_id: str) -> Optional[list]:
    """Get message history from Redis cache."""
    cache_key = _get_message_history_key(thread_id)
    
    try:
        from core.services import redis as redis_service
        
        cached = await redis_service.get(cache_key)
        if cached:
            data = _json_loads(cached) if isinstance(cached, (str, bytes)) else cached
            logger.debug(f"⚡ Redis cache hit for message history: {thread_id} ({len(data)} messages)")
            return data
    except Exception as e:
        logger.warning(f"Failed to get message history from cache: {e}")
    
    return None


async def set_cached_message_history(thread_id: str, messages: list) -> None:
    """Cache message history in Redis."""
    cache_key = _get_message_history_key(thread_id)
    
    try:
        from core.services import redis as redis_service
        await redis_service.set(cache_key, _json_dumps(messages), ex=MESSAGE_HISTORY_TTL)
        logger.debug(f"✅ Cached message history in Redis: {thread_id} ({len(messages)} messages)")
    except Exception as e:
        logger.warning(f"Failed to cache message history: {e}")


async def invalidate_message_history_cache(thread_id: str) -> None:
    """Invalidate cached message history when new message is added."""
    try:
        from core.services import redis as redis_service
        await redis_service.delete(_get_message_history_key(thread_id))
        logger.debug(f"🗑️ Invalidated message history cache: {thread_id}")
    except Exception as e:
        logger.warning(f"Failed to invalidate message history cache: {e}")


# ============================================================================
# SUBSCRIPTION TIER CACHE - Long TTL since tiers only change on upgrade/downgrade
# We invalidate explicitly when subscription changes, so safe to cache longer
# ============================================================================
TIER_INFO_TTL = 3600  # 1 hour - invalidated on subscription change

def _get_tier_info_key(account_id: str) -> str:
    """Generate Redis cache key for subscription tier info."""
    return f"tier_info:{account_id}"


async def get_cached_tier_info(account_id: str) -> Optional[Dict[str, Any]]:
    """
    Get subscription tier info from Redis cache.
    Extended TTL since tiers rarely change mid-session.
    """
    cache_key = _get_tier_info_key(account_id)
    
    try:
        from core.services import redis as redis_service
        
        cached = await redis_service.get(cache_key)
        if cached:
            data = _json_loads(cached) if isinstance(cached, (str, bytes)) else cached
            logger.debug(f"⚡ Redis cache hit for tier info: {account_id}")
            return data
    except Exception as e:
        logger.warning(f"Failed to get tier info from cache: {e}")
    
    return None


async def set_cached_tier_info(account_id: str, tier_info: Dict[str, Any]) -> None:
    """Cache subscription tier info in Redis."""
    cache_key = _get_tier_info_key(account_id)
    
    try:
        from core.services import redis as redis_service
        await redis_service.set(cache_key, _json_dumps(tier_info), ex=TIER_INFO_TTL)
        logger.debug(f"✅ Cached tier info in Redis: {account_id} (tier: {tier_info.get('name', 'unknown')})")
    except Exception as e:
        logger.warning(f"Failed to cache tier info: {e}")


async def invalidate_tier_info_cache(account_id: str) -> None:
    """Invalidate cached tier info when subscription changes."""
    try:
        from core.services import redis as redis_service
        await redis_service.delete(_get_tier_info_key(account_id))
        logger.debug(f"🗑️ Invalidated tier info cache: {account_id}")
    except Exception as e:
        logger.warning(f"Failed to invalidate tier info cache: {e}")

