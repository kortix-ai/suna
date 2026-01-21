import time
from typing import Optional, Dict, Any

from core.utils.logger import logger


async def load_agent_config_fast(
    agent_id: Optional[str], 
    account_id: Optional[str], 
    user_id: Optional[str] = None
) -> Optional[Dict[str, Any]]:
    from core.cache.runtime_cache import (
        get_static_suna_config, 
        get_cached_user_mcps,
        get_cached_agent_config,
        get_cached_agent_type
    )
    
    t = time.time()
    logger.info(f"⏱️ [AGENT CONFIG FAST] Starting for agent_id={agent_id}")
    user_id = user_id or account_id
    
    try:
        if not agent_id:
            from core.agents import repo as agents_repo
            agent_id = await agents_repo.get_default_agent_id(account_id)
            if not agent_id:
                logger.warning(f"[AGENT CONFIG FAST] No default agent for {account_id}")
                return await load_agent_config(None, account_id, user_id)
        
        agent_type = await get_cached_agent_type(agent_id)
        
        if agent_type == "suna":
            static_config = get_static_suna_config()
            if static_config:
                cached_mcps = await get_cached_user_mcps(agent_id)
                agent_config = {
                    'agent_id': agent_id,
                    'system_prompt': static_config['system_prompt'],
                    'model': static_config['model'],
                    'agentpress_tools': static_config['agentpress_tools'],
                    'centrally_managed': static_config['centrally_managed'],
                    'is_suna_default': static_config['is_suna_default'],
                    'restrictions': static_config['restrictions'],
                    'configured_mcps': cached_mcps.get('configured_mcps', []) if cached_mcps else [],
                    'custom_mcps': cached_mcps.get('custom_mcps', []) if cached_mcps else [],
                    'triggers': cached_mcps.get('triggers', []) if cached_mcps else [],
                    '_mcps_need_loading': cached_mcps is None,
                }
                logger.info(f"⏱️ [AGENT CONFIG FAST] Suna (cached type): {(time.time() - t) * 1000:.1f}ms")
                return agent_config
        
        elif agent_type == "custom":
            # Custom agent: check full config cache
            cached_config = await get_cached_agent_config(agent_id)
            if cached_config:
                logger.info(f"⏱️ [AGENT CONFIG FAST] Custom (cached): {(time.time() - t) * 1000:.1f}ms")
                return cached_config
        
        # Cache miss - fall back to full DB load (will also populate cache)
        logger.info(f"⏱️ [AGENT CONFIG FAST] Cache miss (type={agent_type}), falling back to full load")
        return await load_agent_config(agent_id, account_id, user_id)
        
    except Exception as e:
        logger.warning(f"[AGENT CONFIG FAST] Error: {e}, falling back to full load")
        return await load_agent_config(agent_id, account_id, user_id)


async def load_agent_config(
    agent_id: Optional[str], 
    account_id: Optional[str], 
    user_id: Optional[str] = None,
    client = None,
    is_new_thread: bool = False
) -> Optional[Dict[str, Any]]:
    from core.agents import repo as agents_repo
    
    t = time.time()
    logger.info(f"⏱️ [AGENT CONFIG] Starting load_agent_config for agent_id={agent_id}")
    user_id = user_id or account_id
    
    try:
        if not agent_id:
            logger.debug(f"[AGENT LOAD] Loading default agent")
            
            if is_new_thread:
                from core.utils.ensure_suna import ensure_suna_installed
                await ensure_suna_installed(account_id)
            
            from core.agents.agent_loader import get_agent_loader
            loader = await get_agent_loader()
            
            default_agent_id = await agents_repo.get_default_agent_id(account_id)
            
            if default_agent_id:
                agent_data = await loader.load_agent(default_agent_id, user_id, load_config=True)
                logger.debug(f"Using default agent: {agent_data.name} ({agent_data.agent_id}) version {agent_data.version_name}")
                return agent_data.to_dict()
            else:
                logger.warning(f"[AGENT LOAD] No default agent found for account {account_id}, searching for shared Suna")
                agent_data = await _find_shared_suna_agent()
                
                if not agent_data:
                    any_agent_id = await agents_repo.get_any_agent_id(account_id)
                    
                    if any_agent_id:
                        agent_data = await loader.load_agent(any_agent_id, user_id, load_config=True)
                        logger.info(f"[AGENT LOAD] Using fallback agent: {agent_data.name} ({agent_data.agent_id})")
                        return agent_data.to_dict()
                    else:
                        logger.error(f"[AGENT LOAD] No agents found for account {account_id}")
                        from fastapi import HTTPException
                        raise HTTPException(status_code=404, detail="No agents available. Please create an agent first.")
                return agent_data.to_dict()
        
        from core.cache.runtime_cache import get_cached_agent_config
        
        t_cache = time.time()
        cached_config = await get_cached_agent_config(agent_id)
        
        if cached_config:
            agent_config = cached_config
            logger.info(f"⏱️ [AGENT CONFIG] get_cached_agent_config: {(time.time() - t_cache) * 1000:.1f}ms (CACHE HIT)")
        elif account_id:
            logger.info(f"⏱️ [AGENT CONFIG] Cache miss, loading from DB...")
            t_db = time.time()
            from core.agents.agent_loader import get_agent_loader
            loader = await get_agent_loader()
            agent_data = await loader.load_agent(agent_id, account_id, load_config=True)
            agent_config = agent_data.to_dict()
            logger.info(f"⏱️ [AGENT CONFIG] DB load: {(time.time() - t_db) * 1000:.1f}ms (CACHE MISS)")
        else:
            t_db = time.time()
            from core.agents.agent_loader import get_agent_loader
            loader = await get_agent_loader()
            agent_data = await loader.load_agent(agent_id, agent_id, load_config=True)
            agent_config = agent_data.to_dict()
            logger.info(f"⏱️ [AGENT CONFIG] DB load (no account): {(time.time() - t_db) * 1000:.1f}ms")
        
        if agent_config:
            logger.debug(f"Using agent {agent_config.get('agent_id')} for this agent run")
        
        return agent_config
    except Exception as e:
        logger.warning(f"Failed to fetch agent config for {agent_id}: {e}")
        return None


async def _find_shared_suna_agent():
    from core.agents.agent_loader import get_agent_loader
    from core.utils.config import config
    from core.agents import repo as agents_repo
    
    admin_user_id = config.SYSTEM_ADMIN_USER_ID
    
    shared_agent = await agents_repo.get_shared_suna_agent(admin_user_id)
    
    if shared_agent:
        loader = await get_agent_loader()
        agent_data = await loader.load_agent(
            shared_agent['agent_id'], 
            shared_agent['account_id'], 
            load_config=True
        )
        if admin_user_id and shared_agent['account_id'] == admin_user_id:
            logger.info(f"✅ Using system Suna agent from admin user: {agent_data.name} ({agent_data.agent_id})")
        else:
            logger.info(f"Using shared Suna agent: {agent_data.name} ({agent_data.agent_id})")
        return agent_data
    
    if admin_user_id:
        logger.warning(f"⚠️ SYSTEM_ADMIN_USER_ID configured but no Suna agent found for user {admin_user_id}")
    
    logger.error("❌ No Suna agent found! Set SYSTEM_ADMIN_USER_ID in .env")
    return None
