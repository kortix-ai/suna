import json
from typing import Optional, Dict, Any, List
from uuid import uuid4
from core.agentpress.tool import Tool, ToolResult, openapi_schema, tool_metadata
from core.agentpress.thread_manager import ThreadManager
from core.utils.logger import logger
from core.utils.core_tools_helper import ensure_core_tools_enabled
from core.utils.config import config

@tool_metadata(
    display_name="Agent Builder",
    description="Create and configure new AI agents with custom capabilities",
    icon="Bot",
    color="bg-purple-100 dark:bg-purple-800/50",
    weight=190,
    visible=True
)
class AgentCreationTool(Tool):
    def __init__(self, thread_manager: ThreadManager, db_connection, account_id: str):
        super().__init__()
        self.thread_manager = thread_manager
        self.db = db_connection
        self.account_id = account_id

    async def _get_current_account_id(self) -> str:
        """Get account_id (already provided in constructor)."""
        if not self.account_id:
            raise ValueError("No account_id available")
        return self.account_id

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "create_new_agent",
            "description": "Create a completely new AI agent with custom configuration. CRITICAL: This tool requires explicit user permission before creating any agent. Always ask the user for confirmation first using the 'ask' tool, providing details about the agent you plan to create. Only proceed after the user explicitly approves. Use this when users want to create specialized agents for specific tasks or domains.",
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "The name of the new agent. Should be descriptive and indicate the agent's purpose (e.g. 'Research Assistant', 'Code Reviewer', 'Marketing Manager')."
                    },
                    "system_prompt": {
                        "type": "string",
                        "description": "Detailed system prompt that defines the agent's behavior, expertise, and approach. Should include specific instructions, personality, and domain expertise. Use imperative verbs and include 'Act as [role]' statement."
                    },
                    "icon_name": {
                        "type": "string",
                        "description": "Icon name from the available list. Choose from popular options: bot, brain, sparkles, zap, rocket, briefcase, code, database, globe, heart, lightbulb, message-circle, shield, star, user, cpu, terminal, settings, wand-2, layers, chart-bar, folder, search, mail, phone, camera, music, video, image, file-text, bookmark, calendar, clock, map, users, trending-up, trending-down, activity, pie-chart, bar-chart, line-chart, target, award, flag, tag, paperclip, link, external-link, download, upload, refresh, power, wifi, bluetooth, battery, volume-2, mic, headphones, monitor, smartphone, tablet, laptop, server, hard-drive, cloud, package, truck, shopping-cart, credit-card, dollar-sign, percent, calculator, scissors, pen-tool, edit-3, trash-2, archive, eye, eye-off, lock, unlock, key, fingerprint, shield-check, alert-triangle, alert-circle, info, help-circle, question-mark, plus, minus, x, check, arrow-right, arrow-left, arrow-up, arrow-down, chevron-right, chevron-left, chevron-up, chevron-down, play, pause, stop, skip-forward, skip-back, volume-x, maximize, minimize, copy, move, rotate-cw, zoom-in, zoom-out"
                    },
                    "icon_color": {
                        "type": "string", 
                        "description": "Hex color code for the icon (e.g. '#000000', '#FFFFFF', '#4F46E5', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#F97316')"
                    },
                    "icon_background": {
                        "type": "string", 
                        "description": "Hex color code for the icon background (e.g. '#F3F4F6', '#E5E7EB', '#DBEAFE', '#D1FAE5', '#FEF3C7', '#FEE2E2', '#EDE9FE', '#FED7AA')"
                    },
                    "agentpress_tools": {
                        "type": "object",
                        "description": "Configuration for AgentPress tools. Each key is a tool name, value is boolean for enabled/disabled. Available tools: sb_shell_tool, sb_files_tool, web_search_tool, browser_tool, sb_vision_tool, data_providers_tool, etc.",
                        "additionalProperties": {
                            "type": "boolean"
                        }
                    },
                    "configured_mcps": {
                        "type": "array",
                        "description": "List of configured MCP servers for external integrations (e.g. Gmail, Slack, GitHub). Leave empty if none needed initially.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "name": {"type": "string"},
                                "qualifiedName": {"type": "string"}, 
                                "config": {"type": "object"},
                                "enabledTools": {
                                    "type": "array",
                                    "items": {"type": "string"}
                                }
                            }
                        },
                        "default": []
                    },
                    "is_default": {
                        "type": "boolean",
                        "description": "Whether this agent should become the user's default agent. Only set to true if explicitly requested by the user.",
                        "default": False
                    }
                },
                "required": ["name", "system_prompt", "icon_name", "icon_color", "icon_background"]
            }
        }
    })
    async def create_new_agent(
        self,
        name: str,
        system_prompt: str,
        icon_name: str,
        icon_color: str,
        icon_background: str,
        agentpress_tools: Optional[Dict[str, bool]] = None,
        configured_mcps: Optional[List[Dict[str, Any]]] = None,
        is_default: bool = False
    ) -> ToolResult:
        try:
            account_id = self.account_id
            if not account_id:
                return self.fail_response("Unable to determine current account ID")

            client = await self.db.client
            
            
            from core.core_utils import check_agent_count_limit
            limit_check = await check_agent_count_limit(client, account_id)
            
            if not limit_check['can_create']:
                return self.fail_response(
                    f"Maximum of {limit_check['limit']} agents allowed for your current plan. "
                    f"You have {limit_check['current_count']} agents. "
                    f"Current tier: {limit_check['tier_name']}"
                )

            if agentpress_tools is None:
                from core.config_helper import _get_default_agentpress_tools
                agentpress_tools = _get_default_agentpress_tools()
            else:
                agent_builder_tools = {
                    "agent_config_tool": True,
                    "mcp_search_tool": True,
                    "credential_profile_tool": True,
                    "trigger_tool": True
                }
                
                for tool_name, enabled in agent_builder_tools.items():
                    if tool_name not in agentpress_tools:
                        agentpress_tools[tool_name] = enabled
            
            agentpress_tools = ensure_core_tools_enabled(agentpress_tools)
            
            if configured_mcps is None:
                configured_mcps = []

            if is_default:
                await client.table('agents').update({"is_default": False}).eq("account_id", account_id).eq("is_default", True).execute()

            insert_data = {
                "account_id": account_id,
                "name": name,
                "icon_name": icon_name,
                "icon_color": icon_color,
                "icon_background": icon_background,
                "is_default": is_default,
                "version_count": 1
            }

            new_agent = await client.table('agents').insert(insert_data).execute()
            
            if not new_agent.data:
                return self.fail_response("Failed to create agent record")
            
            agent = new_agent.data[0]
            agent_id = agent['agent_id']

            try:
                from core.versioning.version_service import get_version_service
                from core.ai_models import model_manager
                
                version_service = await get_version_service()
                
                default_model = await model_manager.get_default_model_for_user(client, account_id)
                
                version = await version_service.create_version(
                    agent_id=agent_id,
                    user_id=account_id,
                    system_prompt=system_prompt,
                    model=default_model,
                    configured_mcps=configured_mcps,
                    custom_mcps=[],
                    agentpress_tools=agentpress_tools,
                    version_name="v1",
                    change_description="Initial version"
                )
                
                await client.table('agents').update({
                    "current_version_id": version.version_id
                }).eq("agent_id", agent_id).execute()

                success_message = f"✅ Successfully created agent '{name}'!\n\n"
                success_message += f"**Icon**: {icon_name} ({icon_color} on {icon_background})\n"
                success_message += f"**Default Agent**: {'Yes' if is_default else 'No'}\n"
                success_message += f"**Tools Enabled**: {len([k for k, v in agentpress_tools.items() if v])}\n"
                success_message += f"**MCPs Configured**: {len(configured_mcps)}\n\n"
                success_message += "The agent is now available in your agent library and ready to use!\n\n"
                success_message += f"🔧 **For Advanced Configuration:**\n"
                success_message += f"Visit the agent configuration page to further customize:\n"
                success_message += f"• Set up triggers and schedules\n" 
                success_message += f"• Configure additional MCP integrations\n"
                success_message += f"• Fine-tune tool settings\n"
                success_message += f"• Create agent versions\n\n"
                success_message += f"You can access this from your agents dashboard."

                return self.success_response({
                    "message": success_message,
                    "agent_id": agent_id,
                    "agent_name": name,
                    "is_default": is_default
                })
                
            except Exception as e:
                logger.error(f"Failed to create agent version: {e}")
                try:
                    await client.table('agents').delete().eq("agent_id", agent_id).execute()
                except:
                    pass
                return self.fail_response("Failed to create agent configuration")

        except Exception as e:
            logger.error(f"Failed to create agent: {e}")
            return self.fail_response("Failed to create agent")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "search_mcp_servers_for_agent",
            "description": "Search for available MCP servers/integrations that can be added to a newly created agent. Use this to find integrations for services like Gmail, Slack, GitHub, etc.",
            "parameters": {
                "type": "object",
                "properties": {
                    "search_query": {
                        "type": "string",
                        "description": "The search term for finding MCP servers (e.g., 'gmail', 'slack', 'github', 'linear')"
                    }
                },
                "required": ["search_query"]
            }
        }
    })
    async def search_mcp_servers_for_agent(self, search_query: str) -> ToolResult:
        try:
            from core.composio_integration.composio_service import get_integration_service
            from core.composio_integration.toolkit_service import ToolkitService
            
            integration_service = get_integration_service()
            
            toolkits_response = await integration_service.search_toolkits(search_query)
            toolkits = toolkits_response.get("items", [])
            
            if not toolkits:
                return self.success_response({
                    "message": f"No MCP servers found matching '{search_query}'",
                    "toolkits": []
                })
            
            result_text = f"## MCP Servers matching '{search_query}'\n\n"
            for toolkit in toolkits:
                result_text += f"**{toolkit.name}**\n"
                result_text += f"- Slug: `{toolkit.slug}`\n"
                if toolkit.description:
                    result_text += f"- Description: {toolkit.description}\n"
                if toolkit.categories:
                    result_text += f"- Categories: {', '.join(toolkit.categories)}\n"
                result_text += "\n"
            
            result_text += f"\n💡 Use `create_credential_profile_for_agent` with the slug to set up authentication for any of these services."
            
            formatted_toolkits = []
            for toolkit in toolkits:
                formatted_toolkits.append({
                    "name": toolkit.name,
                    "slug": toolkit.slug,
                    "description": toolkit.description or f"Toolkit for {toolkit.name}",
                    "categories": toolkit.categories or []
                })
            
            return self.success_response({
                "message": result_text,
                "toolkits": formatted_toolkits,
                "total_found": len(toolkits)
            })
            
        except Exception as e:
            logger.error(f"Failed to search MCP servers: {e}")
            return self.fail_response("Failed to search MCP servers")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "get_mcp_server_details",
            "description": "Get detailed information about a specific MCP server/toolkit, including available authentication methods.",
            "parameters": {
                "type": "object",
                "properties": {
                    "toolkit_slug": {
                        "type": "string",
                        "description": "The toolkit slug to get details for (e.g., 'github', 'googlesheets', 'slack')"
                    }
                },
                "required": ["toolkit_slug"]
            }
        }
    })
    async def get_mcp_server_details(self, toolkit_slug: str) -> ToolResult:
        try:
            from core.composio_integration.toolkit_service import ToolkitService
            
            toolkit_service = ToolkitService()
            toolkit_data = await toolkit_service.get_toolkit_by_slug(toolkit_slug)
            
            if not toolkit_data:
                return self.fail_response(f"Could not find toolkit details for '{toolkit_slug}'")
            
            result_text = f"## {toolkit_data.name} Details\n\n"
            result_text += f"**Description**: {toolkit_data.description or f'Integration for {toolkit_data.name}'}\n"
            result_text += f"**Slug**: `{toolkit_data.slug}`\n"
            
            if toolkit_data.auth_schemes:
                result_text += f"**Authentication Methods**: {', '.join(toolkit_data.auth_schemes)}\n"
                result_text += f"**OAuth Support**: {'Yes' if 'OAUTH2' in toolkit_data.auth_schemes else 'No'}\n"
            
            if toolkit_data.categories:
                result_text += f"**Categories**: {', '.join(toolkit_data.categories)}\n"
            
            if toolkit_data.tags:
                result_text += f"**Tags**: {', '.join(toolkit_data.tags)}\n"
            
            result_text += f"\n✅ **Ready to integrate!**\n"
            result_text += f"Use `create_credential_profile_for_agent` with slug '{toolkit_data.slug}' to set up authentication."
            
            return self.success_response({
                "message": result_text,
                "toolkit": {
                    "name": toolkit_data.name,
                    "slug": toolkit_data.slug,
                    "description": toolkit_data.description or f"Toolkit for {toolkit_data.name}",
                    "auth_schemes": toolkit_data.auth_schemes,
                    "categories": toolkit_data.categories or [],
                    "tags": toolkit_data.tags or []
                },
                "supports_oauth": "OAUTH2" in toolkit_data.auth_schemes if toolkit_data.auth_schemes else False
            })
            
        except Exception as e:
            logger.error(f"Failed to get MCP server details: {e}")
            return self.fail_response("Failed to get toolkit details")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "create_credential_profile_for_agent",
            "description": "Create a credential profile for external service integration with a newly created agent. This generates an authentication link that the user must complete.",
            "parameters": {
                "type": "object",
                "properties": {
                    "toolkit_slug": {
                        "type": "string",
                        "description": "The toolkit/app slug (e.g., 'github', 'gmail', 'slack', 'linear')"
                    },
                    "profile_name": {
                        "type": "string",
                        "description": "A friendly name for this credential profile"
                    }
                },
                "required": ["toolkit_slug", "profile_name"]
            }
        }
    })
    async def create_credential_profile_for_agent(
        self,
        toolkit_slug: str,
        profile_name: str
    ) -> ToolResult:
        try:
            account_id = self.account_id
            if not account_id:
                return self.fail_response("Unable to determine current account ID")
            
            from core.composio_integration.composio_service import get_integration_service
            
            integration_user_id = str(uuid4())

            integration_service = get_integration_service(db_connection=self.db)
            result = await integration_service.integrate_toolkit(
                toolkit_slug=toolkit_slug,
                account_id=account_id,
                user_id=integration_user_id,
                profile_name=profile_name,
                display_name=profile_name,
                save_as_profile=True
            )
            
            if not result or not result.profile_id:
                return self.fail_response("Failed to create credential profile")
            
            auth_url = result.connected_account.redirect_url if result.connected_account else None
            
            if not auth_url:
                return self.fail_response("Failed to generate authentication URL")
            
            success_message = f"🔐 **AUTHENTICATION REQUIRED FOR {result.toolkit.name.upper()}**\n\n"
            success_message += f"I've created a credential profile for {result.toolkit.name}.\n\n"
            success_message += f"**⚠️ CRITICAL NEXT STEP - AUTHENTICATION REQUIRED:**\n"
            success_message += f"1. **Click this link to authenticate:** {auth_url}\n"
            success_message += f"2. Log in to your {result.toolkit.name} account\n"
            success_message += f"3. Authorize the connection\n"
            success_message += f"4. Return here and confirm you've completed authentication\n\n"
            success_message += f"**IMPORTANT:** The integration will NOT work without completing this authentication.\n\n"
            success_message += f"**Profile Details:**\n"
            success_message += f"- Profile Name: {profile_name}\n"
            success_message += f"- Service: {result.toolkit.name}\n\n"
            success_message += f"Once authenticated, use `discover_mcp_tools_for_agent` with the profile name to see available tools."
            
            return self.success_response({
                "message": success_message,
                "authentication_url": auth_url,
                "profile_name": profile_name,
                "toolkit_name": result.toolkit.name,
                "toolkit_slug": toolkit_slug,
                "requires_authentication": True
            })
            
        except Exception as e:
            logger.error(f"Failed to create credential profile: {e}")
            return self.fail_response("Failed to create credential profile")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "discover_mcp_tools_for_agent",
            "description": "Discover available MCP tools for a credential profile after authentication. Use this to see what tools are available for the authenticated service.",
            "parameters": {
                "type": "object",
                "properties": {
                    "profile_name": {
                        "type": "string",
                        "description": "The profile name from create_credential_profile_for_agent"
                    }
                },
                "required": ["profile_name"]
            }
        }
    })
    async def discover_mcp_tools_for_agent(self, profile_name: str) -> ToolResult:
        try:
            account_id = self.account_id
            if not account_id:
                return self.fail_response("Unable to determine current account ID")
            
            from core.composio_integration.composio_profile_service import ComposioProfileService
            from core.mcp_module.mcp_service import mcp_service
            
            profile_service = ComposioProfileService(self.db)
            profiles = await profile_service.get_profiles(account_id)
            
            profile = None
            for p in profiles:
                if p.profile_name == profile_name:
                    profile = p
                    break
            
            if not profile:
                return self.fail_response("Profile not found or access denied")
            
            if not profile.is_connected:
                return self.fail_response(
                    f"Profile is not authenticated yet. Please complete authentication first:\n"
                    f"1. Click the authentication link provided earlier\n"
                    f"2. Log in and authorize the connection\n"
                    f"3. Then try discovering tools again"
                )
            
            if not profile.mcp_url:
                return self.fail_response("Profile has no MCP URL configured")
            
            result = await mcp_service.discover_custom_tools(
                request_type="http",
                config={"url": profile.mcp_url}
            )
            
            if not result.success:
                return self.fail_response("Failed to discover tools")
            
            available_tools = result.tools or []
            
            if not available_tools:
                return self.fail_response("No tools found for this profile")
            
            response_text = f"## Available Tools for {profile.toolkit_name}\n\n"
            response_text += f"Found **{len(available_tools)} tools** available for {profile.profile_name}:\n\n"
            
            for i, tool in enumerate(available_tools, 1):
                response_text += f"**{i}. {tool['name']}**\n"
                if tool.get('description'):
                    response_text += f"   - {tool['description']}\n"
                response_text += "\n"
            
            response_text += f"\n✅ **Profile is authenticated and ready!**\n"
            response_text += f"Use `configure_agent_integration` with this profile name and selected tool names to add to your agent."
            
            return self.success_response({
                "message": response_text,
                "profile_name": profile.profile_name,
                "toolkit_name": profile.toolkit_name,
                "toolkit_slug": profile.toolkit_slug,
                "tools": available_tools,
                "tool_names": [tool['name'] for tool in available_tools],
                "total_tools": len(available_tools),
                "is_connected": True
            })
            
        except Exception as e:
            logger.error(f"Failed to discover MCP tools: {e}")
            return self.fail_response("Failed to discover tools")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "configure_agent_integration",
            "description": "Configure an authenticated integration for a newly created agent by adding it to the agent's version configuration.",
            "parameters": {
                "type": "object",
                "properties": {
                    "agent_id": {
                        "type": "string",
                        "description": "The ID of the agent to add the integration to"
                    },
                    "profile_name": {
                        "type": "string",
                        "description": "The authenticated profile name from create_credential_profile_for_agent"
                    },
                    "enabled_tools": {
                        "type": "array",
                        "description": "List of tool names to enable from this integration (from discover_mcp_tools_for_agent)",
                        "items": {"type": "string"}
                    },
                    "display_name": {
                        "type": "string",
                        "description": "Optional custom display name for this integration"
                    }
                },
                "required": ["agent_id", "profile_name", "enabled_tools"]
            }
        }
    })
    async def configure_agent_integration(
        self,
        agent_id: str,
        profile_name: str,
        enabled_tools: List[str],
        display_name: Optional[str] = None
    ) -> ToolResult:
        try:
            account_id = self.account_id
            if not account_id:
                return self.fail_response("Unable to determine current account ID")
            
            client = await self.db.client
            
            agent_result = await client.table('agents').select('*').eq('agent_id', agent_id).eq('account_id', account_id).execute()
            if not agent_result.data:
                return self.fail_response("Agent not found or access denied")
            
            agent_data = agent_result.data[0]
            current_version_id = agent_data.get('current_version_id')
            
            if not current_version_id:
                return self.fail_response("Agent has no current version configured")
            
            from core.composio_integration.composio_profile_service import ComposioProfileService
            profile_service = ComposioProfileService(self.db)
            profiles = await profile_service.get_profiles(account_id)
            
            profile = None
            for p in profiles:
                if p.profile_name == profile_name:
                    profile = p
                    break
            
            if not profile:
                return self.fail_response("Profile not found or access denied")
            
            if not profile.is_connected:
                return self.fail_response(
                    "Profile is not authenticated. Please complete authentication first:\n"
                    "1. Use create_credential_profile_for_agent to get the auth link\n"
                    "2. Complete authentication\n"
                    "3. Then configure the integration"
                )
            
            version_result = await client.table('agent_versions')\
                .select('config')\
                .eq('version_id', current_version_id)\
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
                    'profile_id': profile.profile_id,
                    'toolkit_slug': profile.toolkit_slug,
                    'mcp_qualified_name': profile.mcp_qualified_name
                },
                'enabledTools': enabled_tools
            }
            
            updated_mcps = [mcp for mcp in current_custom_mcps 
                          if mcp.get('config', {}).get('profile_id') != profile.profile_id]
            
            updated_mcps.append(new_mcp_config)
            
            current_tools['custom_mcp'] = updated_mcps
            current_config['tools'] = current_tools
            
            from core.versioning.version_service import get_version_service
            version_service = await get_version_service()
            
            new_version = await version_service.create_version(
                agent_id=agent_id,
                user_id=account_id,
                system_prompt=current_config.get('system_prompt', ''),
                model=current_config.get('model'),
                configured_mcps=current_config.get('tools', {}).get('mcp', []),
                custom_mcps=updated_mcps,
                agentpress_tools=current_config.get('tools', {}).get('agentpress', {}),
                change_description=f"Configured {display_name or profile.display_name} with {len(enabled_tools)} tools"
            )
            
            await client.table('agents').update({
                'current_version_id': new_version.version_id,
                'version_count': agent_data['version_count'] + 1
            }).eq('agent_id', agent_id).execute()
            
            try:
                from core.tools.mcp_tool_wrapper import MCPToolWrapper
                
                mcp_config_for_wrapper = {
                    'name': profile.toolkit_name,
                    'qualifiedName': f"composio.{profile.toolkit_slug}",
                    'config': {
                        'profile_id': profile.profile_id,
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
                logger.debug(f"Successfully registered MCP tools dynamically for {profile.toolkit_name}")
                
            except Exception as e:
                logger.warning(f"Could not dynamically register MCP tools in current runtime: {str(e)}. Tools will be available on next agent run.")
            
            success_message = f"✅ Successfully configured {profile.toolkit_name} integration for agent!\n\n"
            success_message += f"**Integration Details:**\n"
            success_message += f"- Service: {profile.toolkit_name}\n"
            success_message += f"- Profile: {profile.profile_name}\n"
            success_message += f"- Enabled Tools: {len(enabled_tools)}\n"
            success_message += f"- Tools: {', '.join(enabled_tools[:5])}"
            if len(enabled_tools) > 5:
                success_message += f" and {len(enabled_tools) - 5} more"
            success_message += "\n\n"
            success_message += f"The {profile.toolkit_name} integration is now active and ready to use!"
            
            return self.success_response({
                "message": success_message,
                "agent_id": agent_id,
                "profile_name": profile_name,
                "integration_name": profile.toolkit_name,
                "enabled_tools": enabled_tools,
                "enabled_tools_count": len(enabled_tools)
            })
            
        except Exception as e:
            logger.error(f"Failed to configure agent integration: {e}", exc_info=True)
            return self.fail_response("Failed to configure integration")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "create_agent_scheduled_trigger",
            "description": "Create a scheduled trigger for a newly created agent to run the agent with a specific prompt using cron expressions.",
            "parameters": {
                "type": "object",
                "properties": {
                    "agent_id": {
                        "type": "string",
                        "description": "The ID of the agent to create the trigger for"
                    },
                    "name": {
                        "type": "string",
                        "description": "Name of the scheduled trigger"
                    },
                    "description": {
                        "type": "string",
                        "description": "Description of what this trigger does and when it runs"
                    },
                    "cron_expression": {
                        "type": "string",
                        "description": "Cron expression defining when to run (e.g., '0 9 * * *' for daily at 9am, '*/30 * * * *' for every 30 minutes)"
                    },
                    "agent_prompt": {
                        "type": "string",
                        "description": "Prompt to send to the agent when triggered"
                    }
                },
                "required": ["agent_id", "name", "cron_expression", "agent_prompt"]
            }
        }
    })
    async def create_agent_scheduled_trigger(
        self,
        agent_id: str,
        name: str,
        cron_expression: str,
        agent_prompt: str,
        description: Optional[str] = None
    ) -> ToolResult:
        try:
            account_id = self.account_id
            if not account_id:
                return self.fail_response("Unable to determine current account ID")
            
            client = await self.db.client
            
            agent_result = await client.table('agents').select('*').eq('agent_id', agent_id).eq('account_id', account_id).execute()
            if not agent_result.data:
                return self.fail_response("Agent not found or access denied")
            
            if not agent_prompt:
                return self.fail_response("agent_prompt is required")
            
            trigger_config = {
                "cron_expression": cron_expression,
                "provider_id": "schedule",
                "agent_prompt": agent_prompt
            }
            
            from core.triggers import get_trigger_service
            trigger_svc = get_trigger_service(self.db)
            
            try:
                trigger = await trigger_svc.create_trigger(
                    agent_id=agent_id,
                    provider_id="schedule",
                    name=name,
                    config=trigger_config,
                    description=description
                )
                
                success_message = f"✅ Successfully created scheduled trigger '{name}' for agent!\n\n"
                success_message += f"**Trigger Details:**\n"
                success_message += f"- Name: {name}\n"
                success_message += f"- Schedule: `{cron_expression}`\n"
                success_message += f"- Type: Agent execution\n"
                success_message += f"- Prompt: {agent_prompt[:50]}{'...' if len(agent_prompt) > 50 else ''}\n"
                success_message += f"- Status: **Active**\n\n"
                success_message += f"The trigger is now active and will run according to the schedule."
                
                return self.success_response({
                    "message": success_message,
                    "trigger": {
                        "id": trigger.trigger_id,
                        "agent_id": agent_id,
                        "name": trigger.name,
                        "description": trigger.description,
                        "cron_expression": cron_expression,
                        "is_active": trigger.is_active,
                        "created_at": trigger.created_at.isoformat()
                    }
                })
            except ValueError as ve:
                return self.fail_response("Validation error: Invalid trigger configuration")
            except Exception as e:
                logger.error(f"Error creating trigger through manager: {str(e)}")
                return self.fail_response("Failed to create trigger")
                
        except Exception as e:
            logger.error(f"Failed to create scheduled trigger: {e}", exc_info=True)
            return self.fail_response("Failed to create scheduled trigger")
    
    @openapi_schema({
        "type": "function",
        "function": {
            "name": "list_agent_scheduled_triggers",
            "description": "List all scheduled triggers for a specific agent",
            "parameters": {
                "type": "object",
                "properties": {
                    "agent_id": {
                        "type": "string",
                        "description": "The ID of the agent to list triggers for"
                    }
                },
                "required": ["agent_id"]
            }
        }
    })
    async def list_agent_scheduled_triggers(self, agent_id: str) -> ToolResult:
        try:
            account_id = self.account_id
            if not account_id:
                return self.fail_response("Unable to determine current account ID")
            
            client = await self.db.client
            
            agent_result = await client.table('agents').select('*').eq('agent_id', agent_id).eq('account_id', account_id).execute()
            if not agent_result.data:
                return self.fail_response("Agent not found or access denied")
            
            from core.triggers import get_trigger_service, TriggerType
            trigger_svc = get_trigger_service(self.db)
            
            triggers = await trigger_svc.get_agent_triggers(agent_id)
            
            schedule_triggers = [t for t in triggers if t.trigger_type == TriggerType.SCHEDULE]
            
            if not schedule_triggers:
                return self.success_response({
                    "message": "No scheduled triggers found for this agent.",
                    "agent_id": agent_id,
                    "triggers": [],
                    "total_count": 0
                })
            
            formatted_triggers = []
            for trigger in schedule_triggers:
                formatted = {
                    "id": trigger.trigger_id,
                    "name": trigger.name,
                    "description": trigger.description,
                    "cron_expression": trigger.config.get("cron_expression"),
                    "is_active": trigger.is_active,
                    "created_at": trigger.created_at.isoformat()
                }
                
                formatted["agent_prompt"] = trigger.config.get("agent_prompt")
                
                formatted_triggers.append(formatted)
            
            return self.success_response({
                "message": f"Found {len(formatted_triggers)} scheduled trigger(s) for agent",
                "agent_id": agent_id,
                "triggers": formatted_triggers,
                "total_count": len(formatted_triggers)
            })
                
        except Exception as e:
            logger.error(f"Failed to list scheduled triggers: {e}", exc_info=True)
            return self.fail_response("Failed to list scheduled triggers")
    
    @openapi_schema({
        "type": "function",
        "function": {
            "name": "toggle_agent_scheduled_trigger",
            "description": "Enable or disable a scheduled trigger for an agent",
            "parameters": {
                "type": "object",
                "properties": {
                    "agent_id": {
                        "type": "string",
                        "description": "The ID of the agent that owns the trigger"
                    },
                    "trigger_id": {
                        "type": "string",
                        "description": "The ID of the trigger to toggle"
                    },
                    "is_active": {
                        "type": "boolean",
                        "description": "Whether to enable (true) or disable (false) the trigger"
                    }
                },
                "required": ["agent_id", "trigger_id", "is_active"]
            }
        }
    })
    async def toggle_agent_scheduled_trigger(self, agent_id: str, trigger_id: str, is_active: bool) -> ToolResult:
        try:
            account_id = self.account_id
            if not account_id:
                return self.fail_response("Unable to determine current account ID")
            
            client = await self.db.client
            
            agent_result = await client.table('agents').select('*').eq('agent_id', agent_id).eq('account_id', account_id).execute()
            if not agent_result.data:
                return self.fail_response("Agent not found or access denied")
            
            from core.triggers import get_trigger_service
            trigger_svc = get_trigger_service(self.db)
            
            trigger_config = await trigger_svc.get_trigger(trigger_id)
            
            if not trigger_config:
                return self.fail_response("Trigger not found or access denied")
            
            if trigger_config.agent_id != agent_id:
                return self.fail_response("Trigger not found or access denied")
            
            updated_config = await trigger_svc.update_trigger(
                trigger_id=trigger_id,
                is_active=is_active
            )
            
            if updated_config:
                status = "enabled" if is_active else "disabled"
                
                success_message = f"✅ Scheduled trigger '{updated_config.name}' has been {status}!\n\n"
                success_message += f"**Trigger Details:**\n"
                success_message += f"- Name: {updated_config.name}\n"
                success_message += f"- Status: **{'Active' if is_active else 'Inactive'}**\n\n"
                if is_active:
                    success_message += "The trigger is now active and will run according to its schedule."
                else:
                    success_message += "The trigger is now inactive and won't run until re-enabled."
                
                try:
                    await self._sync_triggers_to_version_config(agent_id)
                except Exception as e:
                    logger.warning(f"Failed to sync triggers to version config: {e}")
                
                return self.success_response({
                    "message": success_message,
                    "trigger": {
                        "name": updated_config.name,
                        "is_active": updated_config.is_active
                    }
                })
            else:
                return self.fail_response("Failed to update trigger")
                
        except Exception as e:
            logger.error(f"Failed to toggle scheduled trigger: {e}", exc_info=True)
            return self.fail_response("Failed to toggle scheduled trigger")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "delete_agent_scheduled_trigger",
            "description": "Delete a scheduled trigger from an agent. The agent will no longer run automatically at the scheduled time.",
            "parameters": {
                "type": "object",
                "properties": {
                    "agent_id": {
                        "type": "string",
                        "description": "The ID of the agent that owns the trigger"
                    },
                    "trigger_id": {
                        "type": "string",
                        "description": "The ID of the trigger to delete"
                    }
                },
                "required": ["agent_id", "trigger_id"]
            }
        }
    })
    async def delete_agent_scheduled_trigger(self, agent_id: str, trigger_id: str) -> ToolResult:
        try:
            account_id = self.account_id
            if not account_id:
                return self.fail_response("Unable to determine current account ID")
            
            client = await self.db.client
            
            agent_result = await client.table('agents').select('*').eq('agent_id', agent_id).eq('account_id', account_id).execute()
            if not agent_result.data:
                return self.fail_response("Agent not found or access denied")
            
            from core.triggers import get_trigger_service
            trigger_svc = get_trigger_service(self.db)
            
            trigger_config = await trigger_svc.get_trigger(trigger_id)
            
            if not trigger_config:
                return self.fail_response("Trigger not found or access denied")
            
            if trigger_config.agent_id != agent_id:
                return self.fail_response("Trigger not found or access denied")
            
            success = await trigger_svc.delete_trigger(trigger_id)
            
            if success:
                try:
                    await self._sync_triggers_to_version_config(agent_id)
                except Exception as e:
                    logger.warning(f"Failed to sync triggers to version config: {e}")
                
                return self.success_response({
                    "message": f"✅ Scheduled trigger '{trigger_config.name}' has been deleted successfully.",
                    "trigger_name": trigger_config.name
                })
            else:
                return self.fail_response("Failed to delete trigger")
                
        except Exception as e:
            logger.error(f"Failed to delete scheduled trigger: {e}", exc_info=True)
            return self.fail_response("Failed to delete scheduled trigger")
    
    @openapi_schema({
        "type": "function",
        "function": {
            "name": "update_agent_config",
            "description": "Update an existing agent's configuration including system prompt, name, description, icon, and tool settings. Creates a new version to preserve history.",
            "parameters": {
                "type": "object",
                "properties": {
                    "agent_id": {
                        "type": "string",
                        "description": "The ID of the agent to update"
                    },
                    "name": {
                        "type": "string",
                        "description": "New name for the agent (optional)"
                    },
                    "description": {
                        "type": "string",
                        "description": "New description for the agent (optional)"
                    },
                    "system_prompt": {
                        "type": "string",
                        "description": "New system prompt that defines the agent's behavior and expertise (optional)"
                    },
                    "icon_name": {
                        "type": "string",
                        "description": "New icon name from available options (optional)"
                    },
                    "icon_color": {
                        "type": "string",
                        "description": "New hex color code for the icon (optional)"
                    },
                    "icon_background": {
                        "type": "string",
                        "description": "New hex color code for the icon background (optional)"
                    },
                    "agentpress_tools": {
                        "type": "object",
                        "description": "Updated AgentPress tool configuration (optional). Each key is a tool name, value is boolean for enabled/disabled.",
                        "additionalProperties": {
                            "type": "boolean"
                        }
                    },
                    "model": {
                        "type": "string",
                        "description": "New model to use for this agent (optional)"
                    },
                    "change_description": {
                        "type": "string",
                        "description": "Description of what was changed in this update (optional)"
                    },
                    "is_default": {
                        "type": "boolean",
                        "description": "Whether this agent should become the user's default agent (optional)"
                    }
                },
                "required": ["agent_id"]
            }
        }
    })
    async def update_agent_config(
        self,
        agent_id: str,
        name: Optional[str] = None,
        description: Optional[str] = None,
        system_prompt: Optional[str] = None,
        icon_name: Optional[str] = None,
        icon_color: Optional[str] = None,
        icon_background: Optional[str] = None,
        agentpress_tools: Optional[Dict[str, bool]] = None,
        model: Optional[str] = None,
        change_description: Optional[str] = None,
        is_default: Optional[bool] = None
    ) -> ToolResult:
        try:
            account_id = self.account_id
            if not account_id:
                return self.fail_response("Unable to determine current account ID")

            client = await self.db.client
            
            agent_result = await client.table('agents').select('*').eq('agent_id', agent_id).eq('account_id', account_id).execute()
            if not agent_result.data:
                return self.fail_response("Agent not found or access denied")
            
            agent_data = agent_result.data[0]
            current_version_id = agent_data.get('current_version_id')
            
            if not current_version_id:
                return self.fail_response("Agent has no current version configured")
            
            version_result = await client.table('agent_versions').select('config').eq('version_id', current_version_id).single().execute()
            if not version_result.data:
                return self.fail_response("Current agent version not found")
            
            current_config = version_result.data.get('config', {})
            
            updates = []
            agent_updates = {}
            
            if name is not None:
                agent_updates['name'] = name
                updates.append(f"Name: '{name}'")
                
            if description is not None:
                agent_updates['description'] = description
                updates.append("Description updated")
                
            if icon_name is not None:
                agent_updates['icon_name'] = icon_name
                updates.append(f"Icon: {icon_name}")
                
            if icon_color is not None:
                agent_updates['icon_color'] = icon_color
                updates.append("Icon color updated")
                
            if icon_background is not None:
                agent_updates['icon_background'] = icon_background
                updates.append("Icon background updated")
                
            if is_default is not None:
                if is_default:
                    await client.table('agents').update({"is_default": False}).eq("account_id", account_id).eq("is_default", True).execute()
                agent_updates['is_default'] = is_default
                updates.append(f"Default agent: {'Yes' if is_default else 'No'}")
            
            if agent_updates:
                await client.table('agents').update(agent_updates).eq('agent_id', agent_id).execute()
            
            version_changes = False
            new_system_prompt = system_prompt if system_prompt is not None else current_config.get('system_prompt', '')
            new_model = model if model is not None else current_config.get('model')
            new_agentpress_tools = agentpress_tools if agentpress_tools is not None else current_config.get('tools', {}).get('agentpress', {})
            
            if system_prompt is not None:
                updates.append("System prompt updated")
                version_changes = True
                
            if model is not None:
                updates.append(f"Model: {model}")
                version_changes = True
                
            if agentpress_tools is not None:
                updates.append("Tool configuration updated")
                version_changes = True
            
            if version_changes:
                from core.versioning.version_service import get_version_service
                
                version_service = await get_version_service()
                
                current_tools = current_config.get('tools', {})
                configured_mcps = current_tools.get('mcp', [])
                custom_mcps = current_tools.get('custom_mcp', [])
                
                new_version = await version_service.create_version(
                    agent_id=agent_id,
                    user_id=account_id,
                    system_prompt=new_system_prompt,
                    model=new_model,
                    configured_mcps=configured_mcps,
                    custom_mcps=custom_mcps,
                    agentpress_tools=new_agentpress_tools,
                    change_description=change_description or f"Updated: {', '.join(updates)}"
                )
                
                await client.table('agents').update({
                    'current_version_id': new_version.version_id,
                    'version_count': agent_data['version_count'] + 1
                }).eq('agent_id', agent_id).execute()
                
                try:
                    await self._sync_triggers_to_version_config(agent_id)
                except Exception as e:
                    logger.warning(f"Failed to sync triggers to new version: {e}")
            
            updated_agent_result = await client.table('agents').select('*').eq('agent_id', agent_id).execute()
            updated_agent = updated_agent_result.data[0] if updated_agent_result.data else agent_data
            
            success_message = f"✅ Successfully updated agent '{updated_agent['name']}'!\n\n"
            success_message += f"**Changes Made:**\n"
            for update in updates:
                success_message += f"• {update}\n"
            
            if version_changes:
                success_message += f"\n📝 **New Version Created**\n"
                success_message += f"The agent now has version {updated_agent['version_count']} with your configuration changes.\n"
            
            success_message += f"\n🔧 **Current Configuration:**\n"
            success_message += f"• Name: {updated_agent['name']}\n"
            success_message += f"• Description: {updated_agent.get('description', 'No description')}\n"
            success_message += f"• Icon: {updated_agent['icon_name']} ({updated_agent['icon_color']} on {updated_agent['icon_background']})\n"
            success_message += f"• Default Agent: {'Yes' if updated_agent['is_default'] else 'No'}\n"
            if version_changes:
                success_message += f"• Model: {new_model}\n"
                success_message += f"• Tools Enabled: {len([k for k, v in new_agentpress_tools.items() if v])}\n"
            
            success_message += f"\nYour agent has been updated and is ready to use!"

            return self.success_response({
                "message": success_message,
                "agent_id": agent_id,
                "agent_name": updated_agent['name'],
                "updates_made": updates,
                "new_version_created": version_changes,
                "version_count": updated_agent['version_count']
            })
                
        except Exception as e:
            logger.error(f"Failed to update agent: {e}", exc_info=True)
            return self.fail_response("Failed to update agent configuration")
    
    async def _sync_triggers_to_version_config(self, agent_id: str) -> None:
        """Sync triggers to the current version config."""
        try:
            client = await self.db.client
            
            agent_result = await client.table('agents').select('current_version_id').eq('agent_id', agent_id).single().execute()
            if not agent_result.data or not agent_result.data.get('current_version_id'):
                logger.warning(f"No current version found for agent {agent_id}")
                return
            
            current_version_id = agent_result.data['current_version_id']
            
            triggers_result = await client.table('agent_triggers').select('*').eq('agent_id', agent_id).execute()
            triggers = []
            if triggers_result.data:
                import json
                for trigger in triggers_result.data:
                    trigger_copy = trigger.copy()
                    if 'config' in trigger_copy and isinstance(trigger_copy['config'], str):
                        try:
                            trigger_copy['config'] = json.loads(trigger_copy['config'])
                        except json.JSONDecodeError:
                            logger.warning(f"Failed to parse trigger config for {trigger_copy.get('trigger_id')}")
                            trigger_copy['config'] = {}
                    triggers.append(trigger_copy)
            
            version_result = await client.table('agent_versions').select('config').eq('version_id', current_version_id).single().execute()
            if not version_result.data:
                logger.warning(f"Version {current_version_id} not found")
                return
            
            config = version_result.data.get('config', {})
            config['triggers'] = triggers
            
            await client.table('agent_versions').update({'config': config}).eq('version_id', current_version_id).execute()
            
            logger.debug(f"Synced {len(triggers)} triggers to version config for agent {agent_id}")
            
        except Exception as e:
            logger.error(f"Failed to sync triggers to version config: {e}")
    
    @openapi_schema({
        "type": "function",
        "function": {
            "name": "load_agent_creation_instructions",
            "description": "REQUIRED FIRST STEP BEFORE CREATING AGENTS: Load detailed agent creation workflows, integration protocols, and best practices. You MUST call this before creating agents to understand customization options, mandatory authentication workflows, and trigger setup.",
            "parameters": {
                "type": "object",
                "properties": {},
                "required": []
            }
        }
    })
    async def load_agent_creation_instructions(self) -> ToolResult:
        """Load detailed agent creation workflow and requirements"""
        try:
            return self.success_response({
                "message": "Agent creation workflow and requirements loaded successfully",
                "instructions": """
                    # 🤖 AGENT CREATION CAPABILITIES
                    
                    You have advanced capabilities to create and configure custom AI agents for users! When users ask you to create agents, assistants, or specialized AI workers, you can build them seamlessly with full configuration.
                    
                    ## 🎯 Agent Creation Tools
                    
                    ### Core Agent Creation
                    - `create_new_agent`: Create a completely new AI agent with custom configuration
                      - **CRITICAL**: Always ask for user permission before creating any agent
                      - Set name, description, system prompt, icon, and tools
                      - Configure initial tool access (web search, files, browser, etc.)
                      - Set as default agent if requested
                    
                    ### Trigger Management Tools
                    - `create_agent_scheduled_trigger`: Set up scheduled triggers for automatic execution
                      - Configure cron schedules for regular runs
                      - Set up direct agent execution
                      - Create time-based automation
                    
                    - `list_agent_scheduled_triggers`: View all scheduled triggers for an agent
                      - List configured triggers and their schedules
                      - Check execution types and configurations
                      - Review trigger status
                    
                    - `toggle_agent_scheduled_trigger`: Enable or disable triggers
                      - Activate triggers for automatic execution
                      - Temporarily disable triggers
                      - Control trigger availability
                    
                    - `delete_agent_scheduled_trigger`: Remove triggers from agents
                      - Permanently delete scheduled triggers
                      - Stop automatic executions
                    
                    ### Agent Integration Tools (MCP/Composio)
                    - `search_mcp_servers_for_agent`: Search for available integrations (GitHub, Slack, Gmail, etc.)
                      - Find MCP servers by name or category
                      - Get app details and available toolkits
                      - Discover integration options
                    
                    - `get_mcp_server_details`: Get detailed information about a specific toolkit
                      - View authentication methods
                      - Check OAuth support
                      - See categories and tags
                    
                    - `create_credential_profile_for_agent`: Create authentication profile for services
                      - Generate authentication link for user
                      - Set up credential profile for integration
                      - **CRITICAL**: User MUST authenticate via the link
                    
                    - `discover_mcp_tools_for_agent`: Discover tools after authentication
                      - List all available tools for authenticated service
                      - Get tool descriptions and capabilities
                      - Verify authentication status
                    
                    - `configure_agent_integration`: Add authenticated integration to agent
                      - Configure selected tools from integration
                      - Create new agent version with integration
                      - Enable specific tool subsets
                    
                    - `get_agent_creation_suggestions`: Get ideas for agent types
                      - Business agents (Marketing, Support, Process Optimizer)
                      - Development agents (Code Reviewer, DevOps, API Documentation)
                      - Research agents (Academic, Market Intelligence, Data Scientist)
                      - Creative agents (Content Creator, Design Consultant, Script Writer)
                      - Automation agents (Workflow Automator, Pipeline Manager, Report Generator)
                    
                    ## 🚀 Agent Creation Workflow
                    
                    ### When Users Request Agent Creation
                    
                    **ALWAYS ASK CLARIFYING QUESTIONS FIRST:**
                    Before creating any agent, understand:
                    - What specific tasks will the agent perform?
                    - What domain expertise should it have?
                    - What tools and integrations does it need?
                    - Should it run on a schedule?
                    - What workflows should be pre-configured?
                    - What personality or communication style?
                    
                    ### Standard Agent Creation Process
                    
                    1. **Permission & Planning Phase:**
                       - Present agent details to user
                       - Get explicit permission to create
                       - Clarify any ambiguous requirements
                    
                    2. **Agent Creation Phase:**
                       ```
                       Step 1: Create base agent with create_new_agent
                       Step 2: Set up triggers (if needed):
                          a. Create scheduled triggers with create_agent_scheduled_trigger
                          b. Configure cron schedules for automatic execution
                       Step 4: Configure integrations (if needed):
                          a. Search with search_mcp_servers_for_agent
                          b. Create profile with create_credential_profile_for_agent
                          c. Have user authenticate via the link
                          d. Discover tools with discover_mcp_tools_for_agent
                          e. Configure with configure_agent_integration
                       ```
                    
                    3. **Configuration Examples:**
                       - **Research Assistant**: Web search + file tools + academic focus
                       - **Code Reviewer**: GitHub integration + code analysis tools
                       - **Marketing Analyst**: Data providers + report generation
                       - **Customer Support**: Email integration + knowledge base access
                       - **DevOps Engineer**: CI/CD tools + monitoring capabilities
                    
                    ### Seamless Setup Features
                    
                    **Ownership & Permissions:**
                    - All tools automatically verify agent ownership
                    - Ensures users can only modify their own agents
                    - Validates integration access rights
                    - Maintains security throughout setup
                    
                    **One-Flow Configuration:**
                    - Create agent → Set triggers → Configure integrations
                    - No context switching required
                    - All configuration in one conversation
                    - Immediate activation and readiness
                    
                    ### Agent Creation Examples
                    
                    **User: "Create a daily report generator"**
                    ```
                    You: "I'll help you create a daily report generator agent! Let me understand your needs:
                    - What type of reports? (sales, analytics, status updates?)
                    - What data sources should it access?
                    - When should it run daily?
                    - Where should reports be sent?
                    - Any specific format preferences?"
                    
                    [After clarification]
                    1. Create agent with reporting focus using create_new_agent
                    2. Set trigger: create_agent_scheduled_trigger(agent_id, "Daily 9AM", "0 9 * * *", "agent", agent_prompt)
                    3. Configure data integrations if needed
                    ```
                    
                    **User: "I need an agent to manage my GitHub issues"**
                    ```
                    You: "I'll create a GitHub issue management agent for you! First:
                    - What GitHub repositories?
                    - Should it create, update, or just monitor issues?
                    - Any automation rules? (auto-labeling, assignment?)
                    - Should it run on a schedule or be manual?
                    - Need Slack notifications?"
                    
                    [After clarification]
                    1. Create agent with create_new_agent
                    2. Search for GitHub: search_mcp_servers_for_agent("github")
                    3. Create profile: create_credential_profile_for_agent("github", "Work GitHub")
                    4. Send auth link and wait for user authentication
                    5. Discover tools: discover_mcp_tools_for_agent(profile_id)
                    6. Configure integration: configure_agent_integration(agent_id, profile_id, ["create_issue", "list_issues", ...])
                    7. Add trigger: create_agent_scheduled_trigger(agent_id, "Daily Issue Check", "0 10 * * *", "agent", "Check for new GitHub issues and triage them")
                    ```
                    
                    **User: "Build me a content creation assistant"**
                    ```
                    You: "Let's create your content creation assistant! I need to know:
                    - What type of content? (blog posts, social media, marketing?)
                    - Which platforms will it publish to?
                    - Any brand voice or style guidelines?
                    - Should it generate images too?
                    - Need scheduling capabilities?"
                    
                    [After clarification]
                    1. Create agent with creative focus
                    2. Enable image generation tools
                    3. Add content workflows
                    4. Configure publishing integrations
                    ```
                    
                    ## 🎨 Agent Customization Options
                    
                    ### Visual Identity
                    - **Icons**: 100+ icon options (bot, brain, sparkles, zap, rocket, etc.)
                    - **Colors**: Custom hex colors for icon and background
                    - **Branding**: Match company or personal brand aesthetics
                    
                    ### Tool Configuration
                    - **AgentPress Tools**: Shell, files, browser, vision, search, data providers
                    - **MCP Integrations**: GitHub, Slack, Gmail, Linear, etc.
                    - **Custom Tools**: Configure specific tool subsets
                    
                    ### Behavioral Customization
                    - **System Prompts**: Define expertise, personality, approach
                    - **Triggers**: Scheduled automation using `create_agent_scheduled_trigger`
                    - **Cron Schedules**: Time-based execution (hourly, daily, weekly, etc.)
                    
                    ## 🔑 Critical Agent Creation Rules
                    
                    1. **ALWAYS ASK PERMISSION**: Never create agents without explicit user approval
                    2. **CLARIFY REQUIREMENTS**: Ask 3-5 specific questions before starting
                    3. **EXPLAIN CAPABILITIES**: Tell users what the agent will be able to do
                    4. **VERIFY OWNERSHIP**: All operations check user permissions automatically
                    5. **TEST CONFIGURATIONS**: Verify integrations work after setup
                    6. **PROVIDE NEXT STEPS**: Guide users on how to use their new agent
                    
                    ## 🔐 Critical Integration Workflow (MANDATORY)
                    
                    When adding integrations to newly created agents, you MUST follow this exact sequence:
                    
                    1. **SEARCH** → `search_mcp_servers_for_agent` to find the integration
                    2. **DETAILS (Optional)** → `get_mcp_server_details` to view auth methods and details
                    3. **CREATE PROFILE** → `create_credential_profile_for_agent` to get auth link
                    4. **AUTHENTICATE** → User MUST click the link and complete authentication
                    5. **WAIT FOR CONFIRMATION** → Ask user: "Have you completed authentication?"
                    6. **DISCOVER TOOLS** → `discover_mcp_tools_for_agent` to get actual available tools
                    7. **CONFIGURE** → `configure_agent_integration` with discovered tool names
                    
                    **NEVER SKIP STEPS!** The integration will NOT work without proper authentication.
                    
                    ### Integration Example:
                    ```
                    User: "Add GitHub to my agent"
                    
                    You: 
                    1. Search: search_mcp_servers_for_agent("github")
                    2. Create: create_credential_profile_for_agent("github", "My GitHub")
                    3. Send auth link: "Please authenticate: [link]"
                    4. Wait for user: "Have you completed authentication?"
                    5. Discover: discover_mcp_tools_for_agent(profile_id)
                    6. Show tools: "Found 15 tools: create_issue, list_repos..."
                    7. Configure: configure_agent_integration(agent_id, profile_id, [tools])
                    ```
                    
                    ### Trigger Creation Example:
                    ```
                    User: "Make my agent run every morning at 9 AM"
                    
                    You:
                    1. Create trigger: create_agent_scheduled_trigger(
                       agent_id,
                       "Daily Morning Run",
                       "0 9 * * *",
                       "agent",
                       "Runs the agent every morning at 9 AM",
                       agent_prompt="Check for new tasks and generate daily summary"
                    )
                    2. Confirm: "✅ Your agent will now run automatically every morning at 9 AM!"
                    ```
                    
                    ## 🌟 Agent Creation Philosophy
                    
                    You are not just Suna - you are an agent creator! You can spawn specialized AI workers tailored to specific needs. Each agent you create becomes a powerful tool in the user's arsenal, capable of autonomous operation with the exact capabilities they need.
                    
                    When someone says:
                    - "I need an assistant for..." → Create a specialized agent
                    - "Can you automate..." → Build an agent with workflows and triggers
                    - "Help me manage..." → Design an agent with relevant integrations
                    - "Create something that..." → Craft a custom agent solution
                    
                    **Remember**: You're empowering users by creating their personal AI workforce. Each agent is a specialized worker designed for specific tasks, making their work more efficient and automated.
                    
                    **Agent Creation Best Practices:**
                    - Start with core functionality, then add enhancements
                    - Use descriptive names and clear descriptions
                    - Configure only necessary tools to maintain focus
                    - Set up workflows for common use cases
                    - Add triggers for truly autonomous operation
                    - Test integrations before declaring success
                    
                    **Your Agent Creation Superpowers:**
                    - Create unlimited specialized agents
                    - Configure complex workflows and automation
                    - Set up scheduled execution
                    - Integrate with external services
                    - Provide ongoing agent management
                    - Enable true AI workforce automation
                """
            })
        except Exception as e:
            return self.fail_response(f"Failed to load agent creation instructions: {str(e)}")
    