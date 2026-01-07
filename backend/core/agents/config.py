"""
Agent configuration loading utilities.
"""

import time
from typing import Optional, Dict, Any

from core.utils.logger import logger
from core.services.supabase import DBConnection


async def load_agent_config(
    agent_id: Optional[str], 
    account_id: Optional[str], 
    user_id: Optional[str] = None,
    client = None,
    is_new_thread: bool = False
) -> Optional[Dict[str, Any]]:
    """Load agent configuration from cache or database."""
    t = time.time()
    logger.info(f"⏱️ [AGENT CONFIG] Starting load_agent_config for agent_id={agent_id}")
    user_id = user_id or account_id
    
    try:
        # Handle default agent loading (agent_id is None)
        if not agent_id:
            if not client:
                logger.warning("Cannot load default agent: client not provided")
                return None
                
            logger.debug(f"[AGENT LOAD] Loading default agent")
            
            if is_new_thread:
                from core.utils.ensure_suna import ensure_suna_installed
                await ensure_suna_installed(account_id)
            
            from core.agents.agent_loader import get_agent_loader
            loader = await get_agent_loader()
            
            default_agent = await client.table('agents').select('agent_id').eq('account_id', account_id).eq('metadata->>is_suna_default', 'true').maybe_single().execute()
            
            if default_agent and default_agent.data:
                agent_data = await loader.load_agent(default_agent.data['agent_id'], user_id, load_config=True)
                logger.debug(f"Using default agent: {agent_data.name} ({agent_data.agent_id}) version {agent_data.version_name}")
                return agent_data.to_dict()
            else:
                logger.warning(f"[AGENT LOAD] No default agent found for account {account_id}, searching for shared Suna")
                agent_data = await _find_shared_suna_agent(client)
                
                if not agent_data:
                    any_agent = await client.table('agents').select('agent_id').eq('account_id', account_id).limit(1).maybe_single().execute()
                    
                    if any_agent and any_agent.data:
                        agent_data = await loader.load_agent(any_agent.data['agent_id'], user_id, load_config=True)
                        logger.info(f"[AGENT LOAD] Using fallback agent: {agent_data.name} ({agent_data.agent_id})")
                        return agent_data.to_dict()
                    else:
                        logger.error(f"[AGENT LOAD] No agents found for account {account_id}")
                        from fastapi import HTTPException
                        raise HTTPException(status_code=404, detail="No agents available. Please create an agent first.")
                return agent_data.to_dict()
        
        # Handle specific agent loading
        from core.cache.runtime_cache import (
            get_static_suna_config, 
            get_cached_user_mcps,
            get_cached_agent_config
        )
        
        static_config = get_static_suna_config()
        cached_mcps = await get_cached_user_mcps(agent_id)
        
        if static_config and cached_mcps is not None:
            agent_config = {
                'agent_id': agent_id,
                'system_prompt': static_config['system_prompt'],
                'model': static_config['model'],
                'agentpress_tools': static_config['agentpress_tools'],
                'centrally_managed': static_config['centrally_managed'],
                'is_suna_default': static_config['is_suna_default'],
                'restrictions': static_config['restrictions'],
                'configured_mcps': cached_mcps.get('configured_mcps', []),
                'custom_mcps': cached_mcps.get('custom_mcps', []),
                'triggers': cached_mcps.get('triggers', []),
            }
            logger.info(f"⏱️ [AGENT CONFIG] memory + Redis MCPs: {(time.time() - t) * 1000:.1f}ms (CACHE HIT)")
        else:
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


async def _find_shared_suna_agent(client):
    """Find shared Suna agent (helper for default agent loading)."""
    from core.agents.agent_loader import get_agent_loader
    from core.utils.config import config
    
    admin_user_id = config.SYSTEM_ADMIN_USER_ID
    
    if admin_user_id:
        admin_suna = await client.table('agents').select('agent_id').eq('account_id', admin_user_id).eq('metadata->>is_suna_default', 'true').maybe_single().execute()
        
        if admin_suna and admin_suna.data:
            loader = await get_agent_loader()
            agent_data = await loader.load_agent(admin_suna.data['agent_id'], admin_user_id, load_config=True)
            logger.info(f"✅ Using system Suna agent from admin user: {agent_data.name} ({agent_data.agent_id})")
            return agent_data
        else:
            logger.warning(f"⚠️ SYSTEM_ADMIN_USER_ID configured but no Suna agent found for user {admin_user_id}")
    
    any_suna = await client.table('agents').select('agent_id, account_id').eq('metadata->>is_suna_default', 'true').limit(1).maybe_single().execute()
    
    if any_suna and any_suna.data:
        loader = await get_agent_loader()
        agent_data = await loader.load_agent(any_suna.data['agent_id'], any_suna.data['account_id'], load_config=True)
        logger.info(f"Using shared Suna agent: {agent_data.name} ({agent_data.agent_id})")
        return agent_data
    
    logger.error("❌ No Suna agent found! Set SYSTEM_ADMIN_USER_ID in .env")
    return None

