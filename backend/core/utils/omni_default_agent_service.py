from typing import Dict, Any, Optional, List
from core.utils.logger import logger
from core.services.supabase import DBConnection
from core.omni_config import OMNI_CONFIG
import uuid
from datetime import datetime


class OmniDefaultAgentService:
    def __init__(self, db: DBConnection = None):
        self._db = db or DBConnection()
        logger.info("OmniDefaultAgentService initialized")
    
    async def get_omni_default_config(self) -> Dict[str, Any]:
        """Get the current Omni default configuration"""
        return OMNI_CONFIG.copy()
    
    async def sync_all_omni_agents(self) -> Dict[str, Any]:
        """Sync all Omni agents to current configuration"""
        logger.info("Syncing all Omni agents")
        
        try:
            # Get all Omni default agents (direct query to avoid broken function)
            client = await self._db.client
            result = await client.table('agents').select('agent_id, account_id, name, description, created_at, updated_at, current_version_id, is_default, metadata, config, version_count').eq('metadata->>is_omni_default', True).order('created_at', desc=True).execute()
            result = result.data
            
            if not result:
                return {
                    "updated_count": 0,
                    "failed_count": 0,
                    "details": []
                }
            
            config = await self.get_omni_default_config()
            updated_count = 0
            failed_count = 0
            details = []
            
            for agent_row in result:
                try:
                    agent_id = agent_row['agent_id']
                    # Update agent with current config
                    client = await self._db.client
                    
                    # Prepare updated metadata
                    updated_metadata = agent_row.get('metadata', {}).copy() if agent_row.get('metadata') else {}
                    updated_metadata['last_central_update'] = datetime.now().isoformat()
                    
                    # Update the agent record
                    result = await client.table('agents').update({
                        'name': config.get("name", agent_row.get('name')),
                        'description': config.get("description", agent_row.get('description')),
                        'metadata': updated_metadata
                    }).eq('agent_id', agent_id).execute()
                    
                    # Update the current version with new config
                    current_version_id = agent_row.get('current_version_id')
                    if current_version_id:
                        await client.table('agent_versions').update({
                            'system_prompt': config.get("system_prompt", ""),
                            'configured_mcps': config.get("tools", {}).get("mcp", []),
                            'custom_mcps': config.get("tools", {}).get("custom_mcp", []),
                            'agentpress_tools': config.get("tools", {}).get("agentpress", {}),
                            'config': config
                        }).eq('version_id', current_version_id).execute()
                    updated_count += 1
                    details.append({
                        "agent_id": str(agent_id),
                        "account_id": str(agent_row['account_id']),
                        "status": "updated"
                    })
                except Exception as e:
                    logger.error(f"Failed to update agent {agent_id}: {e}")
                    failed_count += 1
                    details.append({
                        "agent_id": str(agent_id) if 'agent_id' in locals() else "unknown",
                        "status": "failed",
                        "error": str(e)
                    })
            
            return {
                "updated_count": updated_count,
                "failed_count": failed_count,
                "details": details
            }
        except Exception as e:
            logger.error(f"Error syncing Omni agents: {e}")
            return {
                "updated_count": 0,
                "failed_count": 0,
                "details": [],
                "error": str(e)
            }
    
    async def update_all_omni_agents(self, target_version: Optional[str] = None) -> Dict[str, Any]:
        """Update all Omni agents (alias for sync)"""
        logger.info("Updating all Omni agents")
        return await self.sync_all_omni_agents()
    
    async def install_for_all_users(self) -> Dict[str, Any]:
        """Install Omni agent for all users who don't have it"""
        logger.info("Installing Omni agents for all missing users")
        
        try:
            client = await self._db.client
            
            # Get all personal accounts
            accounts_result = await client.schema('basejump').table('accounts').select('id').eq('personal_account', True).execute()
            all_account_ids = {row['id'] for row in accounts_result.data} if accounts_result.data else set()
            
            # Get existing Omni agents
            existing_result = await client.table('agents').select('account_id').eq('metadata->>is_omni_default', True).execute()
            existing_account_ids = {row['account_id'] for row in existing_result.data} if existing_result.data else set()
            
            # Find accounts without Omni agents
            missing_accounts = all_account_ids - existing_account_ids
            
            if not missing_accounts:
                return {
                    "installed_count": 0,
                    "failed_count": 0,
                    "details": ["All users already have Omni agents"]
                }
            
            logger.info(f"Installing Omni agents for {len(missing_accounts)} users")
            
            installed_count = 0
            failed_count = 0
            details = []
            
            for account_id in missing_accounts:
                try:
                    agent_id = await self.install_omni_agent_for_user(str(account_id))
                    if agent_id:
                        installed_count += 1
                        details.append({
                            "account_id": str(account_id),
                            "agent_id": agent_id,
                            "status": "installed"
                        })
                        logger.debug(f"✅ Installed Omni agent for user {account_id}")
                    else:
                        failed_count += 1
                        details.append({
                            "account_id": str(account_id),
                            "status": "failed",
                            "error": "Installation returned None"
                        })
                except Exception as e:
                    failed_count += 1
                    error_msg = f"Failed to install for user {account_id}: {str(e)}"
                    details.append({
                        "account_id": str(account_id),
                        "status": "failed",
                        "error": str(e)
                    })
                    logger.error(error_msg)
            
            return {
                "installed_count": installed_count,
                "failed_count": failed_count,
                "details": details if details and isinstance(details[0], dict) else [f"Successfully installed for {installed_count} users"] if installed_count > 0 else []
            }
            
        except Exception as e:
            error_msg = f"Installation operation failed: {str(e)}"
            logger.error(error_msg)
            return {
                "installed_count": 0,
                "failed_count": 0,
                "details": [error_msg]
            }
    
    async def install_omni_agent_for_user(self, account_id: str, replace_existing: bool = False) -> Optional[str]:
        """Install Omni agent for a specific user"""
        logger.info(f"Installing Omni agent for user: {account_id}")
        
        try:
            logger.debug(f"Starting installation process for user {account_id}, replace_existing={replace_existing}")
            if replace_existing:
                logger.debug(f"Deleting existing Omni agent for replacement")
                # Delete existing Omni agent if it exists
                client = await self._db.client
                await client.table('agents').delete().eq('account_id', account_id).eq('metadata->>is_omni_default', True).execute()
                logger.info(f"Deleted existing Omni agent for replacement")
            else:
                logger.debug(f"Checking if user already has a default agent")
                # Check if user already has a default agent (this is what the constraint is on)
                client = await self._db.client
                existing = await client.table('agents').select('agent_id').eq('account_id', account_id).eq('is_default', True).limit(1).execute()
                existing = existing.data
                if existing:
                    logger.info(f"User {account_id} already has a default agent: {existing[0]['agent_id']}")
                    return str(existing[0]['agent_id'])
                logger.debug(f"User does not have an existing default agent, proceeding with installation")
            
            # Get the Omni configuration
            logger.debug(f"Getting Omni default config")
            config = await self.get_omni_default_config()
            logger.debug(f"Config retrieved: {list(config.keys())}")
            
            # Generate new agent ID
            agent_id = str(uuid.uuid4())
            logger.debug(f"Generated agent ID: {agent_id}")
            
            # Create the agent (updated for new schema)
            
            metadata = {
                "is_omni_default": True,
                "centrally_managed": True,
                "installation_date": datetime.now().isoformat(),
                "management_version": "1.0.0"
            }
            
            logger.debug(f"Creating agent in database")
            try:
                client = await self._db.client
                result = await client.table('agents').insert({
                    'agent_id': agent_id,
                    'account_id': account_id,
                    'name': config["name"],
                    'description': config["description"],
                    'is_default': config.get("is_default", True),
                    'version_count': 1,
                    'metadata': metadata
                }).execute()
                logger.debug(f"Agent created successfully")
            except Exception as e:
                logger.error(f"Failed to create agent: {e}")
                raise
            
            # Create initial agent version (updated for new schema)
            version_id = str(uuid.uuid4())
            
            # Restructure config to match database constraint requirements
            structured_config = {
                "name": config.get("name", "Omni"),
                "description": config.get("description", ""),
                "system_prompt": config.get("system_prompt", ""),
                "model": config.get("model", "openrouter/anthropic/sonnet-4"),
                "tools": {
                    "agentpress": config.get("agentpress_tools", {}),
                    "mcp": config.get("configured_mcps", []),
                    "custom_mcp": config.get("custom_mcps", [])
                },
                "metadata": {
                    "avatar": config.get("avatar", "🌟"),
                    "avatar_color": config.get("avatar_color", "#8B5CF6"),
                    "is_omni_default": True,
                    "centrally_managed": True,
                    "installation_date": datetime.now().isoformat(),
                    "management_version": "1.0.0"
                }
            }
            
            logger.debug(f"Creating agent version")
            try:
                client = await self._db.client
                result = await client.table('agent_versions').insert({
                    'version_id': version_id,
                    'agent_id': agent_id,
                    'version_number': 1,
                    'version_name': "v1",
                    'config': structured_config,
                    'is_active': True,
                    'created_by': account_id
                }).execute()
                logger.debug(f"Version created successfully")
            except Exception as e:
                logger.error(f"Failed to create version: {e}")
                raise
            
            # Update agent with current version
            logger.debug(f"Updating agent with version reference")
            try:
                client = await self._db.client
                result = await client.table('agents').update({
                    'current_version_id': version_id,
                    'version_count': 1
                }).eq('agent_id', agent_id).execute()
                logger.debug(f"Agent updated with version successfully")
            except Exception as e:
                logger.error(f"Failed to update agent with version: {e}")
                raise
            
            logger.info(f"Successfully installed Omni agent {agent_id} for user: {account_id}")
            return agent_id
                
        except Exception as e:
            logger.error(f"Error installing Omni agent for user {account_id}: {e}")
            return None
    
    async def get_agent_for_user(self, account_id: str) -> Optional[Dict[str, Any]]:
        """Get the Omni agent for a specific user"""
        try:
            client = await self._db.client
            result = await client.table('agents').select('*').eq('account_id', account_id).eq('metadata->>is_omni_default', True).limit(1).execute()
            result = result.data
            
            if result:
                agent = result[0]
                return {
                    "agent_id": str(agent['agent_id']),
                    "name": agent['name'],
                    "account_id": str(agent['account_id']),
                    "description": agent.get('description'),
                    "created_at": agent['created_at'].isoformat() if agent['created_at'] else None,
                    "updated_at": agent['updated_at'].isoformat() if agent['updated_at'] else None,
                    "is_default": agent['is_default'],
                    "current_version_id": agent.get('current_version_id'),
                    "version_count": agent.get('version_count', 1),
                    "metadata": agent.get('metadata', {})
                }
            return None
            
        except Exception as e:
            logger.error(f"Error getting Omni agent for user {account_id}: {e}")
            return None

    async def get_stats(self) -> Dict[str, Any]:
        """Get statistics about Omni agents"""
        try:
            client = await self._db.client
            
            # Get total count of Omni agents
            result = await client.table('agents').select('agent_id', count='exact').eq('metadata->>is_omni_default', True).execute()
            total_agents = result.count or 0
            
            return {
                "total_agents": total_agents,
                "active_agents": total_agents,  # All Omni agents are considered active
                "inactive_agents": 0,
                "version_breakdown": {"1.0.0": total_agents},  # Simplified
                "monthly_breakdown": {}  # Could be implemented later if needed
            }
        except Exception as e:
            logger.error(f"Error getting Omni agent stats: {e}")
            return {
                "total_agents": 0,
                "active_agents": 0,
                "inactive_agents": 0,
                "version_breakdown": [],
                "monthly_breakdown": [],
                "error": str(e)
            }

    async def _delete_agent(self, agent_id: str) -> bool:
        """Delete an agent and clean up related data."""
        try:
            client = await self._db.client
            
            # Clean up triggers first
            try:
                from core.triggers.trigger_service import get_trigger_service
                trigger_service = get_trigger_service(self._db)
                
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

    async def get_detailed_stats(self) -> Dict[str, Any]:
        """Get detailed statistics about Omni agents with time-based breakdown."""
        try:
            client = await self._db.client
            
            # Get total count
            total_result = await client.table('agents').select('agent_id', count='exact').eq('metadata->>is_omni_default', True).execute()
            total_count = total_result.count or 0
            
            # Get creation dates for last 30 days
            from datetime import timedelta
            thirty_days_ago = (datetime.now() - timedelta(days=30)).isoformat()
            recent_result = await client.table('agents').select('created_at').eq('metadata->>is_omni_default', True).gte('created_at', thirty_days_ago).execute()
            recent_count = len(recent_result.data) if recent_result.data else 0
            
            return {
                "total_agents": total_count,
                "recent_installs": recent_count,
                "active_agents": total_count,  # All Omni agents are considered active
                "inactive_agents": 0,
                "note": "Omni agents always use current central configuration"
            }
            
        except Exception as e:
            logger.error(f"Failed to get detailed agent stats: {e}")
            return {"error": str(e)}

    async def _create_initial_version_enhanced(self, agent_id: str, account_id: str) -> None:
        """Create initial version for Omni agent with versioning service integration."""
        try:
            from core.versioning.version_service import get_version_service
            config = await self.get_omni_default_config()
            
            version_service = await get_version_service()
            await version_service.create_version(
                agent_id=agent_id,
                user_id=account_id,
                system_prompt=config.get("system_prompt", ""),
                configured_mcps=config.get("tools", {}).get("mcp", []),
                custom_mcps=config.get("tools", {}).get("custom_mcp", []),
                agentpress_tools=config.get("tools", {}).get("agentpress", {}),
                model=config.get("model", "claude-3-5-sonnet-20241022"),
                version_name="v1",
                change_description="Initial Omni agent installation"
            )
            
            logger.debug(f"Created initial version for Omni agent {agent_id}")
            
        except Exception as e:
            logger.error(f"Failed to create initial version for Omni agent {agent_id}: {e}")
            # Don't raise here - agent creation should still succeed even if versioning fails
            logger.warning("Continuing with agent creation despite versioning error")

    async def replace_existing_agent(self, account_id: str) -> Optional[str]:
        """Replace existing Omni agent for a user with fresh installation."""
        logger.info(f"Replacing existing Omni agent for user: {account_id}")
        return await self.install_omni_agent_for_user(account_id, replace_existing=True)
