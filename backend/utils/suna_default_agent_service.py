from typing import Dict, Any, Optional
from utils.logger import logger
from utils.omni_default_agent_service import OmniDefaultAgentService


class SunaDefaultAgentService:
    """
    Compatibility layer for the old Suna branding while using the new Omni service underneath.
    This service provides the interface expected by legacy scripts while delegating to OmniDefaultAgentService.
    """
    
    def __init__(self):
        self._omni_service = OmniDefaultAgentService()
        logger.info("🔄 SunaDefaultAgentService initialized (compatibility layer for Omni)")
    
    async def get_suna_default_config(self) -> Dict[str, Any]:
        """Get the current default configuration (rebranded as Omni)"""
        config = await self._omni_service.get_omni_default_config()
        # For compatibility, also return it under the old Suna name for scripts that expect it
        return config
    
    async def sync_all_suna_agents(self) -> Dict[str, Any]:
        """Sync all default agents (now Omni agents)"""
        logger.info("🔄 Syncing all agents (Suna→Omni compatibility layer)")
        return await self._omni_service.sync_all_omni_agents()
    
    async def update_all_suna_agents(self, target_version: Optional[str] = None) -> Dict[str, Any]:
        """Update all default agents (now Omni agents)"""
        logger.info("🔄 Updating all agents (Suna→Omni compatibility layer)")
        return await self._omni_service.update_all_omni_agents(target_version)
    
    async def install_for_all_users(self) -> Dict[str, Any]:
        """Install default agent for all users who don't have it"""
        logger.info("🔄 Installing agents for all missing users (Suna→Omni compatibility layer)")
        return await self._omni_service.install_for_all_users()
    
    async def install_suna_agent_for_user(self, account_id: str, replace_existing: bool = False) -> Optional[str]:
        """Install default agent for a specific user (now installs Omni agent)"""
        logger.info(f"🔄 Installing agent for user {account_id} (Suna→Omni compatibility layer)")
        return await self._omni_service.install_omni_agent_for_user(account_id, replace_existing)
    
    async def get_agent_for_user(self, account_id: str) -> Optional[Dict[str, Any]]:
        """Get the default agent for a specific user"""
        return await self._omni_service.get_agent_for_user(account_id)
    
    async def get_stats(self) -> Dict[str, Any]:
        """Get statistics about default agents"""
        return await self._omni_service.get_stats()

    # Alias for compatibility with scripts that expect the old name
    async def get_suna_agent_stats(self) -> Dict[str, Any]:
        """Get statistics about default agents (compatibility alias)"""
        return await self.get_stats()

