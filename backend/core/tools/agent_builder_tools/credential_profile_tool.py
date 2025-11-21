from typing import Optional, List
from uuid import uuid4
from core.agentpress.tool import ToolResult, openapi_schema, tool_metadata
from core.agentpress.thread_manager import ThreadManager
from .base_tool import AgentBuilderBaseTool
from core.composio_integration.composio_service import get_integration_service
from core.composio_integration.composio_profile_service import ComposioProfileService
from core.mcp_module.mcp_service import mcp_service
from .mcp_search_tool import MCPSearchTool
from core.utils.logger import logger

@tool_metadata(
    display_name="Credentials Manager",
    description="Manage API keys and authentication for external services",
    icon="Key",
    color="bg-red-100 dark:bg-red-800/50",
    weight=180,
    visible=True
)
class CredentialProfileTool(AgentBuilderBaseTool):
    def __init__(self, thread_manager: ThreadManager, db_connection, agent_id: str):
        super().__init__(thread_manager, db_connection, agent_id)
        self.composio_search = MCPSearchTool(thread_manager, db_connection, agent_id)

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
            profile_service = ComposioProfileService(self.db)
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
            "description": "Create a new Composio credential profile for a specific toolkit. This will create the integration and return an authentication link that the user needs to visit to connect their account.",
            "parameters": {
                "type": "object",
                "properties": {
                    "toolkit_slug": {
                        "type": "string",
                        "description": "The toolkit slug to create the profile for (e.g., 'github', 'linear', 'slack')"
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
            integration_user_id = str(uuid4())
            logger.debug(f"Generated integration user_id: {integration_user_id} for account: {account_id}")

            integration_service = get_integration_service(db_connection=self.db)
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
                "profile": {
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

After connecting, you'll be able to use {result.toolkit.name} tools in your agent."""
            else:
                response_data["instructions"] = f"This {result.toolkit.name} profile has been created and is ready to use."
            
            return self.success_response(response_data)
            
        except Exception as e:
            return self.fail_response("Error creating credential profile")

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
                        "description": "The ID of the connected credential profile"
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
        profile_id: str, 
        enabled_tools: List[str],
        display_name: Optional[str] = None
    ) -> ToolResult:
        try:
            account_id = await self._get_current_account_id()
            client = await self.db.client

            profile_service = ComposioProfileService(self.db)
            profiles = await profile_service.get_profiles(account_id)
            
            profile = None
            for p in profiles:
                if p.profile_id == profile_id:
                    profile = p
                    break
            
            if not profile:
                return self.fail_response("Credential profile not found")
            if not profile.is_connected:
                return self.fail_response("Profile is not connected yet. Please connect the profile first.")

            agent_result = await client.table('agents').select('current_version_id').eq('agent_id', self.agent_id).execute()
            if not agent_result.data or not agent_result.data[0].get('current_version_id'):
                return self.fail_response("Agent configuration not found")

            version_result = await client.table('agent_versions')\
                .select('config')\
                .eq('version_id', agent_result.data[0]['current_version_id'])\
                .maybe_single()\
                .execute()
            
            if not version_result.data or not version_result.data.get('config'):
                return self.fail_response("Agent version configuration not found")

            current_config = version_result.data['config']
            current_tools = current_config.get('tools', {})
            current_custom_mcps = current_tools.get('custom_mcp', [])
            
            new_mcp_config = {
                'name': profile.toolkit_name,
                'type': 'composio',
                'config': {
                    'profile_id': profile_id,
                    'toolkit_slug': profile.toolkit_slug,
                    'mcp_qualified_name': profile.mcp_qualified_name
                },
                'enabledTools': enabled_tools
            }
            
            updated_mcps = [mcp for mcp in current_custom_mcps 
                          if mcp.get('config', {}).get('profile_id') != profile_id]
            
            updated_mcps.append(new_mcp_config)
            
            current_tools['custom_mcp'] = updated_mcps
            current_config['tools'] = current_tools
            
            from core.versioning.version_service import get_version_service
            version_service = await get_version_service()
            new_version = await version_service.create_version(
                agent_id=self.agent_id,
                user_id=account_id,
                system_prompt=current_config.get('system_prompt', ''),
                configured_mcps=current_config.get('tools', {}).get('mcp', []),
                custom_mcps=updated_mcps,
                agentpress_tools=current_config.get('tools', {}).get('agentpress', {}),
                change_description=f"Configured {display_name or profile.display_name} with {len(enabled_tools)} tools"
            )

            # Dynamically register the MCP tools in the current runtime
            try:
                from core.tools.mcp_tool_wrapper import MCPToolWrapper
                
                mcp_config_for_wrapper = {
                    'name': profile.toolkit_name,
                    'qualifiedName': f"composio.{profile.toolkit_slug}",
                    'config': {
                        'profile_id': profile_id,
                        'toolkit_slug': profile.toolkit_slug,
                        'mcp_qualified_name': profile.mcp_qualified_name
                    },
                    'enabledTools': enabled_tools,
                    'instructions': '',
                    'isCustom': True,
                    'customType': 'composio'
                }
                
                mcp_wrapper_instance = MCPToolWrapper(mcp_configs=[mcp_config_for_wrapper])
                await mcp_wrapper_instance.initialize_and_register_tools()
                updated_schemas = mcp_wrapper_instance.get_schemas()
                
                for method_name, schema_list in updated_schemas.items():
                    for schema in schema_list:
                        self.thread_manager.tool_registry.tools[method_name] = {
                            "instance": mcp_wrapper_instance,
                            "schema": schema
                        }
                        logger.debug(f"Dynamically registered MCP tool: {method_name}")
                
                logger.debug(f"Successfully registered {len(updated_schemas)} MCP tools dynamically for {profile.toolkit_name}")
                
            except Exception as e:
                logger.warning(f"Could not dynamically register MCP tools in current runtime: {str(e)}. Tools will be available on next agent run.")

            return self.success_response({
                "message": f"Profile '{profile.profile_name}' configured with {len(enabled_tools)} tools and registered in current runtime",
                "enabled_tools": enabled_tools,
                "total_tools": len(enabled_tools),
                "runtime_registration": "success"
            })
            
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
                        "description": "The ID of the credential profile to delete"
                    }
                },
                "required": ["profile_id"]
            }
        }
    })
    async def delete_credential_profile(self, profile_id: str) -> ToolResult:
        try:
            account_id = await self._get_current_account_id()
            client = await self.db.client
            
            profile_service = ComposioProfileService(self.db)
            profiles = await profile_service.get_profiles(account_id)
            
            profile = None
            for p in profiles:
                if p.profile_id == profile_id:
                    profile = p
                    break
            
            if not profile:
                return self.fail_response("Credential profile not found")
            
            # Remove from agent configuration if it exists
            agent_result = await client.table('agents').select('current_version_id').eq('agent_id', self.agent_id).execute()
            if agent_result.data and agent_result.data[0].get('current_version_id'):
                version_result = await client.table('agent_versions')\
                    .select('config')\
                    .eq('version_id', agent_result.data[0]['current_version_id'])\
                    .maybe_single()\
                    .execute()
                
                if version_result.data and version_result.data.get('config'):
                    current_config = version_result.data['config']
                    current_tools = current_config.get('tools', {})
                    current_custom_mcps = current_tools.get('custom_mcp', [])
                    
                    updated_mcps = [mcp for mcp in current_custom_mcps if mcp.get('config', {}).get('profile_id') != profile_id]
                    
                    if len(updated_mcps) != len(current_custom_mcps):
                        from core.versioning.version_service import get_version_service
                        try:
                            current_tools['custom_mcp'] = updated_mcps
                            current_config['tools'] = current_tools
                            
                            version_service = await get_version_service()
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
            await profile_service.delete_profile(profile_id)
            
            return self.success_response({
                "message": f"Successfully deleted credential profile '{profile.display_name}' for {profile.toolkit_name}",
                "deleted_profile": {
                    "profile_name": profile.profile_name,
                    "toolkit_name": profile.toolkit_name
                }
            })
            
        except Exception as e:
            return self.fail_response("Error deleting credential profile")
    
    @openapi_schema({
        "type": "function",
        "function": {
            "name": "load_self_config_instructions",
            "description": "REQUIRED FIRST STEP BEFORE SELF-CONFIGURATION: Load detailed self-configuration workflows, MCP integration protocols, and mandatory authentication requirements. You MUST call this before configuring integrations to understand the complete authentication flow and critical restrictions.",
            "parameters": {
                "type": "object",
                "properties": {},
                "required": []
            }
        }
    })
    async def load_self_config_instructions(self) -> ToolResult:
        """Load detailed self-configuration workflow and requirements"""
        try:
            return self.success_response({
                "message": "Self-configuration workflow and requirements loaded successfully",
                "instructions": """
                    # 🔧 SELF-CONFIGURATION CAPABILITIES
                    
                    You have the ability to configure and enhance yourself! When users ask you to modify your capabilities, add integrations, or set up automation, you can use these advanced tools:
                    
                    ## 🛠️ Available Self-Configuration Tools
                    
                    ### Agent Configuration (`configure_profile_for_agent` ONLY)
                    - **CRITICAL RESTRICTION: DO NOT USE `update_agent` FOR ADDING INTEGRATIONS**
                    - **ONLY USE `configure_profile_for_agent`** to add connected services to your configuration
                    - The `update_agent` tool is PROHIBITED for integration purposes
                    - You can only configure credential profiles for secure service connections
                    
                    ### MCP Integration Tools
                    - `search_mcp_servers`: Find integrations for specific services (Gmail, Slack, GitHub, etc.). NOTE: SEARCH ONLY ONE APP AT A TIME
                    - `discover_user_mcp_servers`: **CRITICAL** - Fetch actual authenticated tools available after user authentication
                    - `configure_profile_for_agent`: Add connected services to your configuration
                    
                    ### Credential Management
                    - `get_credential_profiles`: List available credential profiles for external services
                    - `create_credential_profile`: Set up new service connections with authentication links
                    - `configure_profile_for_agent`: Add connected services to agent configuration
                    
                    ### Automation
                    - **RESTRICTED**: Do not use `create_scheduled_trigger` through `update_agent`
                    - Use only existing automation capabilities without modifying agent configuration
                    - `get_scheduled_triggers`: Review existing automation
                    
                    ## 🎯 When Users Request Configuration Changes
                    
                    **CRITICAL: ASK CLARIFYING QUESTIONS FIRST**
                    Before implementing any configuration changes, ALWAYS ask detailed questions to understand:
                    - What specific outcome do they want to achieve?
                    - What platforms/services are they using?
                    - How often do they need this to happen?
                    - What data or information needs to be processed?
                    - Do they have existing accounts/credentials for relevant services?
                    - What should trigger the automation (time, events, manual)?
                    
                    **🔴 MANDATORY AUTHENTICATION PROTOCOL - CRITICAL FOR SYSTEM VALIDITY 🔴**
                    **THE ENTIRE INTEGRATION IS INVALID WITHOUT PROPER AUTHENTICATION!**
                    
                    When setting up ANY new integration or service connection:
                    1. **ALWAYS SEND AUTHENTICATION LINK FIRST** - This is NON-NEGOTIABLE
                    2. **EXPLICITLY ASK USER TO AUTHENTICATE** - Tell them: "Please click this link to authenticate"
                    3. **WAIT FOR CONFIRMATION** - Ask: "Have you completed the authentication?"
                    4. **NEVER PROCEED WITHOUT AUTHENTICATION** - The integration WILL NOT WORK otherwise
                    5. **EXPLAIN WHY** - Tell users: "This authentication is required for the integration to function"
                    
                    **AUTHENTICATION FAILURE = SYSTEM FAILURE**
                    - Without proper authentication, ALL subsequent operations will fail
                    - The integration becomes completely unusable
                    - User experience will be broken
                    - The entire workflow becomes invalid
                    
                    **MANDATORY MCP TOOL ADDITION FLOW - NO update_agent ALLOWED:**
                    1. **Search** → Use `search_mcp_servers` to find relevant integrations
                    2. **Explore** → Use `get_mcp_server_tools` to see available capabilities  
                    3. **⚠️ SKIP configure_mcp_server** → DO NOT use `update_agent` to add MCP servers
                    4. **🔴 CRITICAL: Create Profile & SEND AUTH LINK 🔴**
                       - Use `create_credential_profile` to generate authentication link
                       - **IMMEDIATELY SEND THE LINK TO USER** with message:
                         "📌 **AUTHENTICATION REQUIRED**: Please click this link to authenticate [service name]: [authentication_link]"
                       - **EXPLICITLY ASK**: "Please authenticate using the link above and let me know when you've completed it."
                       - **WAIT FOR USER CONFIRMATION** before proceeding
                    5. **VERIFY AUTHENTICATION** → Ask user: "Have you successfully authenticated? (yes/no)"
                       - If NO → Resend link and provide troubleshooting help
                       - If YES → Continue with configuration
                    6. **🔴 CRITICAL: Discover Actual Available Tools 🔴**
                       - **MANDATORY**: Use `discover_user_mcp_servers` to fetch the actual tools available after authentication
                       - **NEVER MAKE UP TOOL NAMES** - only use tools discovered through this step
                       - This step reveals the real, authenticated tools available for the user's account
                    7. **Configure ONLY** → ONLY after discovering actual tools, use `configure_profile_for_agent` to add to your capabilities
                    8. **Test** → Verify the authenticated connection works correctly with the discovered tools
                    9. **Confirm Success** → Tell user the integration is now active and working with the specific tools discovered
                    
                    **AUTHENTICATION LINK MESSAGING TEMPLATE:**
                    ```
                    🔐 **AUTHENTICATION REQUIRED FOR [SERVICE NAME]**
                    
                    I've generated an authentication link for you. **This step is MANDATORY** - the integration will not work without it.
                    
                    **Please follow these steps:**
                    1. Click this link: [authentication_link]
                    2. Log in to your [service] account
                    3. Authorize the connection
                    4. Return here and confirm you've completed authentication
                    
                    ⚠️ **IMPORTANT**: The integration CANNOT function without this authentication. Please complete it before we continue.
                    
                    Let me know once you've authenticated successfully!
                    ```
                    
                    **If a user asks you to:**
                    - "Add Gmail integration" → Ask: What Gmail tasks? Read/send emails? Manage labels? Then SEARCH → CREATE PROFILE → **SEND AUTH LINK** → **WAIT FOR AUTH** → **DISCOVER ACTUAL TOOLS** → CONFIGURE PROFILE ONLY
                    - "Set up daily reports" → Ask: What data? What format? Where to send? Then SEARCH for needed tools → CREATE PROFILE → **SEND AUTH LINK** → **WAIT FOR AUTH** → **DISCOVER ACTUAL TOOLS** → CONFIGURE PROFILE
                    - "Connect to Slack" → Ask: What Slack actions? Send messages? Read channels? Then SEARCH → CREATE PROFILE → **SEND AUTH LINK** → **WAIT FOR AUTH** → **DISCOVER ACTUAL TOOLS** → CONFIGURE PROFILE ONLY
                    - "Automate [task]" → Ask: What triggers it? What steps? What outputs? Then SEARCH → CREATE PROFILE → **SEND AUTH LINK** → **WAIT FOR AUTH** → **DISCOVER ACTUAL TOOLS** → CONFIGURE PROFILE
                    - "Add [service] capabilities" → Ask: What specific actions? Then SEARCH → CREATE PROFILE → **SEND AUTH LINK** → **WAIT FOR AUTH** → **DISCOVER ACTUAL TOOLS** → CONFIGURE PROFILE ONLY
                    
                    **ABSOLUTE REQUIREMENTS:**
                    - **🔴 ALWAYS SEND AUTHENTICATION LINKS - NO EXCEPTIONS 🔴**
                    - **🔴 ALWAYS WAIT FOR USER AUTHENTICATION CONFIRMATION 🔴**
                    - **🔴 NEVER PROCEED WITHOUT VERIFIED AUTHENTICATION 🔴**
                    - **🔴 NEVER USE update_agent TO ADD MCP SERVERS 🔴**
                    - **🔴 ALWAYS USE discover_user_mcp_servers AFTER AUTHENTICATION 🔴**
                    - **🔴 NEVER MAKE UP TOOL NAMES - ONLY USE DISCOVERED TOOLS 🔴**
                    - **NEVER automatically add MCP servers** - only create profiles and configure existing capabilities
                    - **ASK 3-5 SPECIFIC QUESTIONS** before starting any configuration
                    - **ONLY USE configure_profile_for_agent** for adding integration capabilities
                    - **MANDATORY**: Use `discover_user_mcp_servers` to fetch real, authenticated tools before configuration
                    - **EXPLICITLY COMMUNICATE** that authentication is mandatory for the system to work
                    - Guide users through connection processes step-by-step with clear instructions
                    - Explain that WITHOUT authentication, the integration is COMPLETELY INVALID
                    - Test connections ONLY AFTER authentication is confirmed AND actual tools are discovered
                    - **SEARCH FOR INTEGRATIONS** but do not automatically add them to the agent configuration
                    - **CREATE CREDENTIAL PROFILES** and configure them for the agent, but do not modify the agent's core configuration
                    - **WAIT FOR discover_user_mcp_servers RESPONSE** before proceeding with any tool configuration
                    
                    **AUTHENTICATION ERROR HANDLING:**
                    If user reports authentication issues:
                    1. **Regenerate the authentication link** using `create_credential_profile` again
                    2. **Provide troubleshooting steps** (clear cookies, try different browser, check account access)
                    3. **Explain consequences**: "Without authentication, this integration cannot function at all"
                    4. **Offer alternatives** if authentication continues to fail
                    5. **Never skip authentication** - it's better to fail setup than have a broken integration
                    
                    ## 🌟 Self-Configuration Philosophy
                    
                    You are Suna, and you can now evolve and adapt based on user needs through credential profile configuration only. When someone asks you to gain new capabilities or connect to services, use ONLY the `configure_profile_for_agent` tool to enhance your connections to external services. **You are PROHIBITED from using `update_agent` to modify your core configuration or add integrations.**
                    
                    **CRITICAL RESTRICTIONS:**
                    - **NEVER use `update_agent`** for adding integrations, MCP servers, or triggers
                    - **ONLY use `configure_profile_for_agent`** to add authenticated service connections
                    - You can search for and explore integrations but cannot automatically add them to your configuration
                    - Focus on credential-based connections rather than core agent modifications
                    - **MANDATORY**: Always use `discover_user_mcp_servers` after authentication to fetch real, available tools
                    - **NEVER MAKE UP TOOL NAMES** - only use tools discovered through the authentication process
                    
                    Remember: You maintain all your core Suna capabilities while gaining the power to connect to external services through authenticated profiles only. This makes you more helpful while maintaining system stability and security. **Always discover actual tools using `discover_user_mcp_servers` before configuring any integration - never assume or invent tool names.**
                """
            })
        except Exception as e:
            return self.fail_response(f"Failed to load self-configuration instructions: {str(e)}") 