import json
import time
from typing import Dict, Any, Optional, Union
from core.utils.logger import logger

try:
    import orjson
    _HAS_ORJSON = True
except ImportError:
    _HAS_ORJSON = False

def _json_dumps(value: Any) -> str:
    if _HAS_ORJSON:
        return orjson.dumps(value).decode('utf-8')
    return json.dumps(value)

def _json_loads(value: Union[str, bytes]) -> Any:
    if _HAS_ORJSON:
        if isinstance(value, str):
            return orjson.loads(value.encode('utf-8'))
        return orjson.loads(value)
    if isinstance(value, bytes):
        return json.loads(value.decode('utf-8'))
    return json.loads(value)

_SUNA_STATIC_CONFIG: Optional[Dict[str, Any]] = None
_SUNA_STATIC_LOADED = False

def get_static_suna_config() -> Optional[Dict[str, Any]]:
    return _SUNA_STATIC_CONFIG

def load_static_suna_config() -> Dict[str, Any]:
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

AGENT_CONFIG_TTL = 3600

def _get_cache_key(agent_id: str, version_id: Optional[str] = None) -> str:
    if version_id:
        return f"agent_config:{agent_id}:{version_id}"
    return f"agent_config:{agent_id}:current"

def _get_user_mcps_key(agent_id: str) -> str:
    return f"agent_mcps:{agent_id}"


async def get_cached_user_mcps(agent_id: str) -> Optional[Dict[str, Any]]:
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
    await set_cached_agent_type(agent_id, is_suna_default)
    
    if is_suna_default:
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


def _get_agent_type_key(agent_id: str) -> str:
    return f"agent_type:{agent_id}"


async def get_cached_agent_type(agent_id: str) -> Optional[str]:
    cache_key = _get_agent_type_key(agent_id)
    try:
        from core.services import redis as redis_service
        return await redis_service.get(cache_key)
    except Exception as e:
        logger.warning(f"Failed to get agent type from cache: {e}")
    return None


async def set_cached_agent_type(agent_id: str, is_suna: bool) -> None:
    cache_key = _get_agent_type_key(agent_id)
    try:
        from core.services import redis as redis_service
        await redis_service.set(cache_key, "suna" if is_suna else "custom", ex=AGENT_CONFIG_TTL)
    except Exception as e:
        logger.warning(f"Failed to cache agent type: {e}")


async def invalidate_agent_config_cache(agent_id: str) -> None:
    try:
        from core.services.redis import delete_multiple
        keys = [
            f"agent_config:{agent_id}:current",
            f"agent_mcps:{agent_id}",
            f"agent_type:{agent_id}"
        ]
        deleted = await delete_multiple(keys, timeout=5.0)
        logger.info(f"🗑️ Invalidated Redis cache for agent: {agent_id} ({deleted} keys)")
    except Exception as e:
        logger.warning(f"Failed to invalidate cache: {e}")


async def warm_up_suna_config_cache() -> None:
    t_start = time.time()
    load_static_suna_config()
    
    elapsed = (time.time() - t_start) * 1000
    logger.info(f"✅ Suna static config loaded in {elapsed:.1f}ms (zero DB calls)")


async def prewarm_user_agents(user_id: str) -> dict:
    import asyncio
    t_start = time.time()
    
    try:
        from core.agents import repo as agents_repo
        from core.agents.agent_loader import get_agent_loader
        from core.services.supabase import DBConnection
        
        agent_ids = await agents_repo.get_user_agent_ids(user_id)
        
        if not agent_ids:
            try:
                from core.utils.ensure_suna import ensure_suna_installed
                await ensure_suna_installed(user_id)
                agent_ids = await agents_repo.get_user_agent_ids(user_id)
                if agent_ids:
                    logger.info(f"[PREWARM] Installed Suna for new user {user_id[:8]}...")
            except Exception as e:
                logger.debug(f"[PREWARM] Could not ensure Suna for {user_id[:8]}...: {e}")
        
        if not agent_ids:
            logger.debug(f"[PREWARM] No agents for user {user_id[:8]}...")
            return {"prewarmed": 0, "errors": 0, "skipped": 0}
        
        loader = await get_agent_loader()
        db = DBConnection()
        client = await db.client
        prewarmed = 0
        errors = 0
        skipped = 0
        
        async def prewarm_single(agent_id: str) -> bool:
            try:
                agent_type = await get_cached_agent_type(agent_id)
                if agent_type == "suna":
                    mcps = await get_cached_user_mcps(agent_id)
                    if mcps is not None:
                        return None 
                elif agent_type == "custom":
                    cached = await get_cached_agent_config(agent_id)
                    if cached:
                        return None 
                
                agent_data = await loader.load_agent(agent_id, user_id, load_config=True)
                if agent_data:
                    asyncio.create_task(warm_kb_context_for_agent(agent_id, client))
                    return True
                return False
            except Exception as e:
                logger.warning(f"[PREWARM] Failed for agent {agent_id}: {e}")
                return False
        
        batch_size = 5
        for i in range(0, len(agent_ids), batch_size):
            batch = agent_ids[i:i + batch_size]
            results = await asyncio.gather(*[prewarm_single(aid) for aid in batch], return_exceptions=True)
            
            for result in results:
                if result is None:
                    skipped += 1
                elif result is True:
                    prewarmed += 1
                else:
                    errors += 1
        
        elapsed = (time.time() - t_start) * 1000
        logger.info(f"✅ [PREWARM] User {user_id[:8]}...: {prewarmed} loaded, {skipped} cached, {errors} errors ({elapsed:.0f}ms)")
        
        return {"prewarmed": prewarmed, "errors": errors, "skipped": skipped}
        
    except Exception as e:
        elapsed = (time.time() - t_start) * 1000
        logger.error(f"[PREWARM] User {user_id[:8]}... failed after {elapsed:.0f}ms: {e}")
        return {"prewarmed": 0, "errors": 1, "skipped": 0, "error": str(e)}


PROJECT_CACHE_TTL = 300

def _get_project_cache_key(project_id: str) -> str:
    return f"project_meta:{project_id}"


async def get_cached_project_metadata(project_id: str) -> Optional[Dict[str, Any]]:
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
    cache_key = _get_project_cache_key(project_id)
    data = {'project_id': project_id, 'sandbox': sandbox}
    
    try:
        from core.services import redis as redis_service
        await redis_service.set(cache_key, _json_dumps(data), ex=PROJECT_CACHE_TTL)
        logger.debug(f"✅ Cached project metadata in Redis: {project_id}")
    except Exception as e:
        logger.warning(f"Failed to cache project metadata: {e}")


async def invalidate_project_cache(project_id: str) -> None:
    try:
        from core.services import redis as redis_service
        await redis_service.delete(_get_project_cache_key(project_id))
        logger.debug(f"🗑️ Invalidated project cache: {project_id}")
    except Exception as e:
        logger.warning(f"Failed to invalidate project cache: {e}")


invalidate_project_metadata = invalidate_project_cache

RUNNING_RUNS_TTL = 5

def _get_running_runs_key(account_id: str) -> str:
    return f"running_runs:{account_id}"


async def get_cached_running_runs(account_id: str) -> Optional[Dict[str, Any]]:
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
    cache_key = _get_running_runs_key(account_id)
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
    try:
        from core.services import redis as redis_service
        await redis_service.delete(_get_running_runs_key(account_id))
        logger.debug(f"🗑️ Invalidated running runs cache: {account_id}")
    except Exception as e:
        logger.warning(f"Failed to invalidate running runs cache: {e}")


THREAD_COUNT_TTL = 300

def _get_thread_count_key(account_id: str) -> str:
    return f"thread_count:{account_id}"


async def get_cached_thread_count(account_id: str) -> Optional[int]:
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
    cache_key = _get_thread_count_key(account_id)
    
    try:
        from core.services import redis as redis_service
        await redis_service.set(cache_key, str(count), ex=THREAD_COUNT_TTL)
        logger.debug(f"✅ Cached thread count in Redis: {account_id} ({count} threads)")
    except Exception as e:
        logger.warning(f"Failed to cache thread count: {e}")


async def increment_thread_count_cache(account_id: str) -> None:
    cache_key = _get_thread_count_key(account_id)   
    
    try:
        from core.services import redis as redis_service
        current = await redis_service.get(cache_key)
        if current is not None:
            await redis_service.incr(cache_key)
            logger.debug(f"✅ Incremented thread count cache: {account_id}")
    except Exception as e:
        logger.warning(f"Failed to increment thread count cache: {e}")


async def invalidate_thread_count_cache(account_id: str) -> None:
    try:
        from core.services import redis as redis_service
        await redis_service.delete(_get_thread_count_key(account_id))
        logger.debug(f"🗑️ Invalidated thread count cache: {account_id}")
    except Exception as e:
        logger.warning(f"Failed to invalidate thread count cache: {e}")


KB_CONTEXT_TTL = 300

def _get_kb_context_key(agent_id: str) -> str:
    return f"kb_context:{agent_id}"


async def get_cached_kb_context(agent_id: str) -> Optional[str]:
    cache_key = _get_kb_context_key(agent_id)
    
    try:
        from core.services import redis as redis_service
        
        cached = await redis_service.get(cache_key)
        if cached is not None:
            data = cached.decode() if isinstance(cached, bytes) else cached
            logger.debug(f"⚡ Redis cache hit for KB context: {agent_id}")
            return data if data else None
    except Exception as e:
        logger.warning(f"Failed to get KB context from cache: {e}")
    
    return None


async def set_cached_kb_context(agent_id: str, context: str) -> None:
    cache_key = _get_kb_context_key(agent_id)
    
    try:
        from core.services import redis as redis_service
        await redis_service.set(cache_key, context, ex=KB_CONTEXT_TTL)
        logger.debug(f"✅ Cached KB context in Redis: {agent_id} ({len(context)} chars)")
    except Exception as e:
        logger.warning(f"Failed to cache KB context: {e}")


async def invalidate_kb_context_cache(agent_id: str) -> None:
    try:
        from core.services import redis as redis_service
        await redis_service.delete(_get_kb_context_key(agent_id))
        logger.debug(f"🗑️ Invalidated KB context cache: {agent_id}")
    except Exception as e:
        logger.warning(f"Failed to invalidate KB context cache: {e}")


async def warm_kb_context_for_agent(agent_id: str, client) -> None:
    try:
        from core.utils.config import config
        if not config.ENABLE_KNOWLEDGE_BASE:
            return
        if not client:
            return
        cached = await get_cached_kb_context(agent_id)
        if cached is not None:
            return
        from core.threads import repo as threads_repo
        entry_count = await threads_repo.get_kb_entry_count(agent_id)
        if entry_count == 0:
            await set_cached_kb_context(agent_id, "")
            return
        kb_result = await client.rpc("get_agent_knowledge_base_context", {"p_agent_id": agent_id}).execute()
        kb_data = kb_result.data if kb_result and kb_result.data else None
        if kb_data and kb_data.strip():
            await set_cached_kb_context(agent_id, kb_data)
            logger.debug(f"✅ [PREWARM] Warmed KB cache for agent {agent_id} ({len(kb_data)} chars)")
        else:
            await set_cached_kb_context(agent_id, "")
    except Exception as e:
        logger.debug(f"[PREWARM] KB warm skipped for {agent_id}: {e}")


USER_CONTEXT_TTL = 900

def _get_user_context_key(user_id: str) -> str:
    return f"user_context:{user_id}"


async def get_cached_user_context(user_id: str) -> Optional[str]:
    cache_key = _get_user_context_key(user_id)
    
    try:
        from core.services import redis as redis_service
        
        cached = await redis_service.get(cache_key)
        if cached is not None:
            data = cached.decode() if isinstance(cached, bytes) else cached
            logger.debug(f"⚡ Redis cache hit for user context: {user_id}")
            return data if data else None
    except Exception as e:
        logger.warning(f"Failed to get user context from cache: {e}")
    
    return None


async def set_cached_user_context(user_id: str, context: str) -> None:
    cache_key = _get_user_context_key(user_id)
    
    try:
        from core.services import redis as redis_service
        await redis_service.set(cache_key, context, ex=USER_CONTEXT_TTL)
        logger.debug(f"✅ Cached user context in Redis: {user_id} ({len(context)} chars)")
    except Exception as e:
        logger.warning(f"Failed to cache user context: {e}")


async def invalidate_user_context_cache(user_id: str) -> None:
    try:
        from core.services import redis as redis_service
        await redis_service.delete(_get_user_context_key(user_id))
        logger.debug(f"🗑️ Invalidated user context cache: {user_id}")
    except Exception as e:
        logger.warning(f"Failed to invalidate user context cache: {e}")


MESSAGE_HISTORY_TTL = 60

def _get_message_history_key(thread_id: str) -> str:
    return f"message_history:{thread_id}"


async def get_cached_message_history(thread_id: str) -> Optional[list]:
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
    cache_key = _get_message_history_key(thread_id)
    
    try:
        from core.services import redis as redis_service
        await redis_service.set(cache_key, _json_dumps(messages), ex=MESSAGE_HISTORY_TTL)
        logger.debug(f"✅ Cached message history in Redis: {thread_id} ({len(messages)} messages)")
    except Exception as e:
        logger.warning(f"Failed to cache message history: {e}")


async def invalidate_message_history_cache(thread_id: str) -> None:
    try:
        from core.services import redis as redis_service
        await redis_service.delete(_get_message_history_key(thread_id))
        logger.debug(f"🗑️ Invalidated message history cache: {thread_id}")
    except Exception as e:
        logger.warning(f"Failed to invalidate message history cache: {e}")


async def append_to_cached_message_history(thread_id: str, message: dict) -> bool:
    cache_key = _get_message_history_key(thread_id)
    
    try:
        from core.services import redis as redis_service
        
        cached = await redis_service.get(cache_key)
        if cached:
            messages = _json_loads(cached) if isinstance(cached, (str, bytes)) else cached
            messages.append(message)
            await redis_service.set(cache_key, _json_dumps(messages), ex=MESSAGE_HISTORY_TTL)
            logger.debug(f"✅ Appended message to cached history: {thread_id} ({len(messages)} messages)")
            return True
    except Exception as e:
        logger.warning(f"Failed to append to message history cache: {e}")
    
    return False


TIER_INFO_TTL = 600

def _get_tier_info_key(account_id: str) -> str:
    return f"tier_info:{account_id}"


async def get_cached_tier_info(account_id: str) -> Optional[Dict[str, Any]]:
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
    cache_key = _get_tier_info_key(account_id)
    
    try:
        from core.services import redis as redis_service
        await redis_service.set(cache_key, _json_dumps(tier_info), ex=TIER_INFO_TTL)
        logger.debug(f"✅ Cached tier info in Redis: {account_id} (tier: {tier_info.get('name', 'unknown')})")
    except Exception as e:
        logger.warning(f"Failed to cache tier info: {e}")


async def invalidate_tier_info_cache(account_id: str) -> None:
    try:
        from core.services import redis as redis_service
        await redis_service.delete(_get_tier_info_key(account_id))
        logger.debug(f"🗑️ Invalidated tier info cache: {account_id}")
    except Exception as e:
        logger.warning(f"Failed to invalidate tier info cache: {e}")

    try:
        from core.agents.pipeline.slot_manager import invalidate_tier_cache
        await invalidate_tier_cache(account_id)
    except Exception as e:
        logger.warning(f"Failed to invalidate slot_manager tier cache: {e}")

    try:
        await invalidate_user_context_cache(account_id)
        logger.debug(f"🗑️ Also invalidated user context cache for tier change: {account_id}")
    except Exception as e:
        logger.warning(f"Failed to invalidate user context cache on tier change: {e}")


AGENT_RUN_STREAM_TTL = 3600

def _get_agent_run_stream_key(agent_run_id: str) -> str:
    return f"agent_run_stream:{agent_run_id}"


async def set_agent_run_stream_data(
    agent_run_id: str,
    thread_id: str,
    account_id: str,
    status: str = "running",
    metadata: Optional[Dict[str, Any]] = None
) -> None:
    cache_key = _get_agent_run_stream_key(agent_run_id)
    
    try:
        from core.services import redis as redis_service
        
        stream_data = {
            "id": agent_run_id,
            "thread_id": thread_id,
            "thread_account_id": account_id,
            "status": status,
            "metadata": metadata or {},
        }
        await redis_service.set(cache_key, _json_dumps(stream_data), ex=AGENT_RUN_STREAM_TTL)
        logger.debug(f"✅ Cached agent run stream data: {agent_run_id}")
    except Exception as e:
        logger.warning(f"Failed to cache agent run stream data: {e}")


async def get_agent_run_stream_data(agent_run_id: str) -> Optional[Dict[str, Any]]:
    cache_key = _get_agent_run_stream_key(agent_run_id)
    
    try:
        from core.services import redis as redis_service
        
        cached = await redis_service.get(cache_key)
        if cached:
            data = _json_loads(cached) if isinstance(cached, (str, bytes)) else cached
            logger.debug(f"⚡ Redis cache hit for agent run stream: {agent_run_id}")
            return data
    except Exception as e:
        logger.warning(f"Failed to get agent run stream data from cache: {e}")
    
    return None


async def delete_agent_run_stream_data(agent_run_id: str) -> None:
    try:
        from core.services import redis as redis_service
        await redis_service.delete(_get_agent_run_stream_key(agent_run_id))
        logger.debug(f"🗑️ Deleted agent run stream cache: {agent_run_id}")
    except Exception as e:
        logger.warning(f"Failed to delete agent run stream cache: {e}")


PENDING_THREAD_TTL = 60

def _get_pending_thread_key(thread_id: str) -> str:
    return f"pending_thread:{thread_id}"


async def set_pending_thread(
    thread_id: str, 
    project_id: str, 
    account_id: str,
    agent_run_id: str,
    prompt: str
) -> None:
    cache_key = _get_pending_thread_key(thread_id)
    
    try:
        from core.services import redis as redis_service
        from datetime import datetime, timezone
        
        pending_data = {
            "thread_id": thread_id,
            "project_id": project_id,
            "account_id": account_id,
            "agent_run_id": agent_run_id,
            "name": prompt[:50] + "..." if len(prompt) > 50 else prompt,
            "status": "pending",
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        await redis_service.set(cache_key, _json_dumps(pending_data), ex=PENDING_THREAD_TTL)
        logger.debug(f"✅ Cached pending thread: {thread_id}")
    except Exception as e:
        logger.warning(f"Failed to cache pending thread: {e}")


async def get_pending_thread(thread_id: str) -> Optional[Dict[str, Any]]:
    cache_key = _get_pending_thread_key(thread_id)
    
    try:
        from core.services import redis as redis_service
        
        cached = await redis_service.get(cache_key)
        if cached:
            data = _json_loads(cached) if isinstance(cached, (str, bytes)) else cached
            logger.debug(f"⚡ Redis cache hit for pending thread: {thread_id}")
            return data
    except Exception as e:
        logger.warning(f"Failed to get pending thread from cache: {e}")
    
    return None


async def delete_pending_thread(thread_id: str) -> None:
    try:
        from core.services import redis as redis_service
        await redis_service.delete(_get_pending_thread_key(thread_id))
        logger.debug(f"🗑️ Deleted pending thread cache: {thread_id}")
    except Exception as e:
        logger.warning(f"Failed to delete pending thread cache: {e}")
