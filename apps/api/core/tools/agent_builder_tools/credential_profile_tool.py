from typing import Optional, List
from uuid import UUID, uuid4
from core.agentpress.tool import ToolResult, openapi_schema, tool_metadata
from core.agentpress.thread_manager import ThreadManager
from .base_tool import AgentBuilderBaseTool
from core.composio_integration.composio_service import get_integration_service
from core.composio_integration.composio_profile_service import ComposioProfileService
from core.mcp_module.mcp_service import mcp_service
from .mcp_search_tool import MCPSearchTool
from core.utils.logger import logger
from core.services.convex_client import get_convex_client
from datetime import datetime, timezone

@tool_metadata(
    display_name="Credentials Manager",
    description="Manage API keys and authentication for external services",
    icon="Key",
    color="bg-red-100 dark:bg-red-800/50",
    weight=180,
    visible=True,
    usage_guide="""
### CREDENTIAL PROFILE MANAGEMENT

**CAPABILITIES:**
- Create credential profiles for external services
- Generate authentication links for users
- List available credential profiles
- Configure profiles for agents

**CRITICAL AUTHENTICATION PROTOCOL:**
1. search_mcp_servers() - First action for any integration request, even if you think you already know the slug
2. Use exact toolkit_slug from search results (never guess generic values like 'google')
3. create_credential_profile() - Generates auth link
4. **SEND LINK TO USER IMMEDIATELY** - Authentication is MANDATORY
5. **WAIT FOR USER CONFIRMATION** - "Have you completed authentication?"
6. discover_mcp_tools - Get actual available tools after auth
7. configure_profile_for_agent() - Add to agent

**AUTHENTICATION IS NON-NEGOTIABLE:**
- Without authentication, integration is COMPLETELY INVALID
- Always explain this to users
- Never proceed without verified authentication
"""
)
class CredentialProfileTool(AgentBuilderBaseTool):
    def __init__(self, thread_manager: ThreadManager, db_connection, agent_id: str):
        super().__init__(thread_manager, db_connection, agent_id)
        # MIGRATED: self.composio_search = MCPSearchTool(thread_manager, db_connection, agent_id)
        self.composio_search = MCPSearchTool(thread_manager, self.convex, agent_id)
        # Additional convex client for direct use (inherited from base but also explicit)
        self.convex_direct = get_convex_client()

    @staticmethod
    def _normalize_profile_id(profile_id: str) -> Optional[str]:
        try:
            return str(UUID(str(profile_id).strip()))
        except (ValueError, AttributeError, TypeError):
            return None

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "get_credential_profiles",
            "description": "Get all existing Composio credential profiles for the current user. Use this to show the user their available profiles.",
            "parameters": {
                "type": "object",
                "properties": {
                    "toolkit_slug": {
                        "type": "string",
                        "description": "Optional filter to show only profiles for a specific toolkit"
                    }
                },
                "required": []
            }
        }
    })
    async def get_credential_profiles(self, toolkit_slug: Optional[str] = None) -> ToolResult:
        try:
            account_id = await self._get_current_account_id()
            # TODO: ComposioProfileService needs migration to use Convex endpoints
            # Currently uses internal Supabase queries for profile retrieval
            profile_service = ComposioProfileService(self.convex)
            profiles = await profile_service.get_profiles(account_id, toolkit_slug)
            
            formatted_profiles = []
            for profile in profiles:
                formatted_profiles.append({
                    "profile_id": profile.profile_id,
                    "connected_account_id": getattr(profile, 'connected_account_id', None),
                    "account_id": profile.account_id,
                    "profile_name": profile.profile_name,
                    "display_name": profile.display_name,
                    "toolkit_slug": profile.toolkit_slug,
                    "toolkit_name": profile.toolkit_name,
                    "is_connected": profile.is_connected,
                    "is_default": profile.is_default
                })
            
            return self.success_response({
                "message": f"Found {len(formatted_profiles)} credential profiles",
                "profiles": formatted_profiles,
                "total_count": len(formatted_profiles)
            })
            
        except Exception as e:
            return self.fail_response("Error getting credential profiles")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "create_credential_profile",
            "description": "Create a new Composio credential profile for a specific toolkit. Call this ONLY after search_mcp_servers in the same request flow, even when the slug seems obvious. Always pass an exact toolkit_slug from search results and never generic values like 'google'.",
            "parameters": {
                "type": "object",
                "properties": {
                    "toolkit_slug": {
                        "type": "string",
                        "description": "Exact toolkit slug from search results (e.g., 'gmail', 'googlecalendar', 'googledrive', 'github', 'linear'). Do not use generic names like 'google'."
                    },
                    "profile_name": {
                        "type": "string",
                        "description": "A name for this credential profile (e.g., 'Personal GitHub', 'Work Slack')"
                    },
                    "display_name": {
                        "type": "string",
                        "description": "Display name for the profile (defaults to profile_name if not provided)"
                    }
                },
                "required": ["toolkit_slug", "profile_name"]
            }
        }
    })
    async def create_credential_profile(
        self,
        toolkit_slug: str,
        profile_name: str,
        display_name: Optional[str] = None
    ) -> ToolResult:
        try:
            account_id = await self._get_current_account_id()
            # MIGRATED: Integration service now uses Convex client
            integration_service = get_integration_service(convex_client=self.convex)
            integration_user_id = str(uuid4())
            logger.debug(f"Generated integration user_id: {integration_user_id} for account: {account_id}")

            result = await integration_service.integrate_toolkit(
                toolkit_slug=toolkit_slug,
                account_id=account_id,
                user_id=integration_user_id,
                profile_name=profile_name,
                display_name=display_name or profile_name,
                save_as_profile=True
            )

            response_data = {
                "message": f"Successfully created credential profile '{profile_name}' for {result.toolkit.name}",
                "profile_id": result.profile_id,
                "profile": {
                    "profile_id": result.profile_id,
                    "profile_name": profile_name,
                    "display_name": display_name or profile_name,
                    "toolkit_slug": toolkit_slug,
                    "toolkit_name": result.toolkit.name,
                    "is_connected": False,
                    "auth_required": bool(result.connected_account.redirect_url)
                }
            }
            
            if result.connected_account.redirect_url:
                response_data["connection_link"] = result.connected_account.redirect_url
                # Include both the toolkit name and slug in a parseable format
                # Format: [toolkit:slug:name] to help frontend identify the service accurately
                response_data["instructions"] = f"""🔗 **{result.toolkit.name} Authentication Required**

Please authenticate your {result.toolkit.name} account by clicking the link below:

[toolkit:{toolkit_slug}:{result.toolkit.name}] Authentication: {result.connected_account.redirect_url}

Use this exact profile_id when configuring the worker: {result.profile_id}

After connecting, you'll be able to use {result.toolkit.name} tools in your agent."""
            else:
                response_data["instructions"] = f"This {result.toolkit.name} profile has been created and is ready to use."
            
            return self.success_response(response_data)
            
        except Exception as e:
            logger.error(f"Error creating credential profile for '{toolkit_slug}': {e}", exc_info=True)
            return self.fail_response(f"Error creating credential profile: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "configure_profile_for_agent",
            "description": "Configure a connected credential profile to be used by the agent with selected tools. Use this after the profile is connected and you want to add it to the agent.",
            "parameters": {
                "type": "object",
                "properties": {
                    "profile_id": {
                        "type": "string",
                        "description": "Exact UUID of the connected credential profile (from get_credential_profiles)"
                    },
                    "enabled_tools": {
                        "type": "array",
                        "description": "List of tool names to enable for this profile",
                        "items": {"type": "string"}
                    },
                    "display_name": {
                        "type": "string",
                        "description": "Optional custom display name for this configuration in the agent"
                    }
                },
                "required": ["profile_id", "enabled_tools"]
            }
        }
    })
    async def configure_profile_for_agent(
        self,
        agent_id: str,
        profile_id: str
    ) -> ToolResult:
        try:
            account_id = await self._get_current_account_id()
            
            # Get existing credential profiles
            existing_profiles = await self.convex.list_credential_profiles(account_id)
            
            if not existing_profiles:
                existing_profiles = []

            # Check if profile already exists
            for profile in existing_profiles:
                if profile.get('profile_id') == profile_id:
                    return self.success_response({
                        "status": "success",
                        "message": "Credential profile already exists",
                        "profile": profile
                    })

            # Create new profile
            new_profile_id = str(uuid4())
            new_profile = {
                "profile_id": new_profile_id,
                "name": profile_name,
                "description": description,
                "tools": tools,
                "created_at": datetime.now(timezone.utc).isoformat(),
                "is_connected": False,
                "is_default": is_default,
            }

            # ... existing code ...
        except Exception as e:
            logger.error(f"Error configuring profile for agent: {e}", exc_info=True)
            return self.fail_response("Error configuring profile for agent")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "delete_credential_profile",
            "description": "Delete a credential profile that is no longer needed. This will also remove it from any agent configurations.",
            "parameters": {
                "type": "object",
                "properties": {
                    "profile_id": {
                        "type": "string",
                        "description": "Exact UUID of the credential profile to delete"
                    }
                },
                "required": ["profile_id"]
            }
        }
    })
    async def delete_credential_profile(self, profile_id: str) -> ToolResult:
        try:
            account_id = await self._get_current_account_id()
            # MIGRATED: Using Convex client to get agent
            agent_result = await self.convex.get_agent(self.agent_id, account_id=account_id)

            normalized_profile_id = self._normalize_profile_id(profile_id)
            if not normalized_profile_id:
                return self.fail_response(
                    "Invalid profile_id format. Expected UUID. "
                    "Use get_credential_profiles to copy the exact profile_id."
                )

            # TODO: ComposioProfileService needs migration to use Convex endpoints
            # Currently uses internal Supabase queries for profile retrieval
            profile_service = ComposioProfileService(self.convex)
            profiles = await profile_service.get_profiles(account_id)

            profile = None
            for p in profiles:
                if p.profile_id == normalized_profile_id:
                    profile = p
                    break

            if not profile:
                return self.fail_response("Credential profile not found")

            # Remove from agent configuration if it exists
            if agent_result and agent_result.get('current_version_id'):
                # MIGRATED: Using version service to get version data
                from core.versioning.version_service import get_version_service
                version_service = await get_version_service()
                version_obj = await version_service.get_version(
                    agent_id=self.agent_id,
                    version_id=agent_result['current_version_id'],
                    user_id=account_id
                )
                version_result = version_obj.to_dict() if version_obj else None
                
                if version_result and version_result.get('config'):
                    current_config = version_result['config']
                    current_tools = current_config.get('tools', {})
                    current_custom_mcps = current_tools.get('custom_mcp', [])

                    updated_mcps = [mcp for mcp in current_custom_mcps if mcp.get('config', {}).get('profile_id') != normalized_profile_id]

                    if len(updated_mcps) != len(current_custom_mcps):
                        try:
                            current_tools['custom_mcp'] = updated_mcps
                            current_config['tools'] = current_tools

                            await version_service.create_version(
                                agent_id=self.agent_id,
                                user_id=account_id,
                                system_prompt=current_config.get('system_prompt', ''),
                                configured_mcps=current_config.get('tools', {}).get('mcp', []),
                                custom_mcps=updated_mcps,
                                agentpress_tools=current_config.get('tools', {}).get('agentpress', {}),
                                change_description=f"Deleted credential profile {profile.display_name}"
                            )
                        except Exception as e:
                            return self.fail_response("Failed to update agent config")
            
            # Delete the profile
            await profile_service.delete_profile(normalized_profile_id)
            
            return self.success_response({
                "message": f"Successfully deleted credential profile '{profile.display_name}' for {profile.toolkit_name}",
                "deleted_profile": {
                    "profile_name": profile.profile_name,
                    "toolkit_name": profile.toolkit_name
                }
            })
            
        except Exception as e:
            return self.fail_response("Error deleting credential profile")
