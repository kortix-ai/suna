import asyncio
from typing import Optional
from core.utils.logger import logger
from core.services.convex_client import get_convex_client
from core.utils.suna_default_agent_service import SunaDefaultAgentService

_installation_cache = set()
_installation_in_progress = set()

async def ensure_suna_installed(account_id: str) -> None:
    if account_id in _installation_cache:
        return

    if account_id in _installation_in_progress:
        return

    try:
        _installation_in_progress.add(account_id)

        # Check if Suna agent already exists via Convex
        convex = get_convex_client()
        existing_agents = await convex.list_agents(account_id)

        # Check if any agent has is_suna_default metadata
        has_suna = any(
            agent.get('metadata', {}).get('is_suna_default') == True
            for agent in existing_agents
        )

        if has_suna:
            _installation_cache.add(account_id)
            logger.debug(f"Suna already installed for account {account_id}")
            return

        logger.info(f"Installing Suna agent for account {account_id}")
        service = SunaDefaultAgentService()
        agent_id = await service.install_suna_agent_for_user(account_id, replace_existing=False)

        if agent_id:
            _installation_cache.add(account_id)
            logger.info(f"Successfully installed Suna agent {agent_id} for account {account_id}")
        else:
            logger.warning(f"Failed to install Suna agent for account {account_id}")

    except Exception as e:
        logger.error(f"Error ensuring Suna installation for {account_id}: {e}")
    finally:
        _installation_in_progress.discard(account_id)


def trigger_suna_installation(account_id: str) -> None:
    try:
        asyncio.create_task(ensure_suna_installed(account_id))
    except RuntimeError:
        pass

