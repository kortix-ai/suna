from typing import Dict, Any, Optional
from core.utils.logger import logger
from core.services.convex_client import get_convex_client
from datetime import datetime, timezone
import uuid


class SunaDefaultAgentService:
    """Simplified Suna agent management service using Convex backend."""

    def __init__(self):
        self._convex = get_convex_client()
        logger.debug("🔄 SunaDefaultAgentService initialized (Convex)")

    async def get_suna_default_config(self) -> Dict[str, Any]:
        """Get the current Suna configuration."""
        from core.config.suna_config import SUNA_CONFIG
        return SUNA_CONFIG.copy()

    async def install_for_all_users(self) -> Dict[str, Any]:
        """Install Suna agent for all users who don't have one.

        NOTE: This requires Supabase for listing all personal accounts (basejump schema).
        The agents themselves are stored in Convex.
        """
        logger.debug("🚀 Installing Suna agents for users who don't have them")

        try:
            # TODO: Need to get all personal accounts from Supabase basejump schema
            # For now, this functionality requires Supabase access for account listing
            # Agents are created in Convex
            logger.warning("install_for_all_users requires Supabase for account listing - not yet migrated")
            return {
                "installed_count": 0,
                "failed_count": 0,
                "details": ["Requires Supabase for basejump account listing - not migrated"]
            }

        except Exception as e:
            error_msg = f"Installation operation failed: {str(e)}"
            logger.error(error_msg)
            return {
                "installed_count": 0,
                "failed_count": 0,
                "details": [error_msg]
            }

    async def install_suna_agent_for_user(self, account_id: str, replace_existing: bool = False) -> Optional[str]:
        """Install Suna agent for a specific user."""
        logger.debug(f"🔄 Installing Suna agent for user: {account_id}")

        try:
            # Check for existing Suna agent via Convex
            existing_agents = await self._convex.list_agents(account_id)
            existing_suna = next(
                (a for a in existing_agents if a.get('metadata', {}).get('is_suna_default')),
                None
            )

            if existing_suna:
                existing_agent_id = existing_suna.get('agentId')

                if replace_existing:
                    # TODO: Add delete_agent method to Convex client
                    # For now, just update the existing one
                    logger.debug(f"Would delete existing Suna agent for replacement (not implemented)")
                else:
                    logger.debug(f"User {account_id} already has Suna agent: {existing_agent_id}")
                    return existing_agent_id

            # Create new agent via Convex
            agent_id = await self._create_suna_agent_for_user(account_id)
            logger.debug(f"Successfully installed Suna agent {agent_id} for user {account_id}")
            return agent_id

        except Exception as e:
            logger.error(f"Error in install_suna_agent_for_user: {e}")
            return None

    async def get_suna_agent_stats(self) -> Dict[str, Any]:
        """Get statistics about Suna agents.

        NOTE: This requires scanning all agents which is not efficiently
        supported by the current Convex API. Consider adding a dedicated
        stats endpoint if needed.
        """
        logger.warning("get_suna_agent_stats not yet migrated - requires Convex aggregation")
        return {
            "total_agents": "unknown",
            "recent_installs": "unknown",
            "note": "Stats aggregation not migrated to Convex"
        }

    async def _create_suna_agent_for_user(self, account_id: str) -> str:
        """Create a Suna agent for a user via Convex."""
        from core.config.suna_config import SUNA_CONFIG

        agent_id = str(uuid.uuid4())

        # Create agent via Convex
        await self._convex.create_agent(
            agent_id=agent_id,
            account_id=account_id,
            name=SUNA_CONFIG["name"],
            description=SUNA_CONFIG["description"],
            is_default=True,
            icon_name="sun",
            metadata={
                "is_suna_default": True,
                "centrally_managed": True,
                "installation_date": datetime.now(timezone.utc).isoformat()
            }
        )

        # Create initial version
        await self._create_initial_version(agent_id, account_id)

        return agent_id

    async def _create_initial_version(self, agent_id: str, account_id: str) -> None:
        """Create initial version for Suna agent.

        Note: We don't save system_prompt, model, or agentpress_tools for Suna agents
        since they're always loaded from SUNA_CONFIG in memory. We only save MCPs
        which are user-specific customizations.
        """
        try:
            from core.versioning.version_service import get_version_service
            from core.config.suna_config import SUNA_CONFIG

            version_service = await get_version_service()
            # For Suna agents, only save MCPs (user customizations)
            # System prompt, model, and tools are always loaded from SUNA_CONFIG
            await version_service.create_version(
                agent_id=agent_id,
                user_id=account_id,
                system_prompt="",  # Not saved for Suna - always from SUNA_CONFIG
                configured_mcps=SUNA_CONFIG["configured_mcps"],
                custom_mcps=SUNA_CONFIG["custom_mcps"],
                agentpress_tools={},  # Not saved for Suna - always from SUNA_CONFIG
                model=None,  # Not saved for Suna - always from SUNA_CONFIG
                version_name="v1",
                change_description="Initial Suna agent installation"
            )

            logger.debug(f"Created initial version for Suna agent {agent_id}")

        except Exception as e:
            logger.error(f"Failed to create initial version for Suna agent {agent_id}: {e}")
            raise

    async def _delete_agent(self, agent_id: str) -> bool:
        """Delete an agent and clean up related data.

        NOTE: Convex client does not have delete_agent method yet.
        TODO: Add delete_agent to Convex client and triggers cleanup.
        """
        logger.warning(f"Delete agent {agent_id} not implemented - requires Convex delete_agent method")
        return False

