from typing import Dict, Any, Optional
from core.utils.logger import logger
from core.services.supabase import DBConnection
from core.utils.omni_default_agent_service import OmniDefaultAgentService
from datetime import datetime, timezone


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
    
    def get_suna_config_direct(self) -> Dict[str, Any]:
        """Direct access to Suna config for compatibility (falls back to Omni)"""
        try:
            from core.suna_config import SUNA_CONFIG
            return SUNA_CONFIG.copy()
        except ImportError:
            # Fallback to Omni config if SUNA_CONFIG doesn't exist
            logger.warning("SUNA_CONFIG not found, falling back to Omni config")
            import asyncio
            return asyncio.create_task(self.get_suna_default_config())
    
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
        """Get statistics about default agents with enhanced details (compatibility alias)"""
        # Use the detailed stats method that matches PRODUCTION functionality
        return await self._omni_service.get_detailed_stats()

    # New methods from PRODUCTION that need Omni implementation
    async def _create_suna_agent_for_user(self, account_id: str) -> str:
        """Create a Suna agent for a user (now creates Omni agent)."""
        logger.info(f"🔄 Creating agent for user {account_id} (Suna→Omni compatibility layer)")
        result = await self._omni_service.install_omni_agent_for_user(account_id, replace_existing=False)
        if result is None:
            raise Exception("Failed to create agent record")
        return result
    
    async def _create_initial_version(self, agent_id: str, account_id: str) -> None:
        """Create initial version for agent (handled by Omni service)."""
        # This is handled automatically by the Omni service in install_omni_agent_for_user
        logger.debug(f"Initial version creation delegated to Omni service for agent {agent_id}")
    
    async def _delete_agent(self, agent_id: str) -> bool:
        """Delete an agent and clean up related data."""
        try:
            # Initialize DB connection for cleanup operations
            db = DBConnection()
            client = await db.client
            
            # Clean up triggers first
            try:
                from core.triggers.trigger_service import get_trigger_service
                trigger_service = get_trigger_service(db)
                
                triggers_result = await client.table('agent_triggers').select('trigger_id').eq('agent_id', agent_id).execute()
                
                if triggers_result.data:
                    for trigger_record in triggers_result.data:
                        try:
                            await trigger_service.delete_trigger(trigger_record['trigger_id'])
                        except Exception as e:
                            logger.warning(f"Failed to clean up trigger: {str(e)}")
            except Exception as e:
                logger.warning(f"Failed to clean up triggers for agent {agent_id}: {str(e)}")
            
            # Delete agent
            result = await client.table('agents').delete().eq('agent_id', agent_id).execute()
            return bool(result.data)
            
        except Exception as e:
            logger.error(f"Failed to delete agent {agent_id}: {e}")
            raise

    async def replace_existing_suna_agent(self, account_id: str) -> Optional[str]:
        """Replace existing agent for a user with fresh installation (now Omni)."""
        logger.info(f"🔄 Replacing agent for user {account_id} (Suna→Omni compatibility layer)")
        return await self._omni_service.replace_existing_agent(account_id)

