import json
from typing import Optional, Dict, Any, List
from uuid import uuid4
from core.agentpress.tool import Tool, ToolResult, openapi_schema, usage_example
from core.agentpress.thread_manager import ThreadManager
from core.utils.logger import logger
from core.utils.config import config


class AgentCreationTool(Tool):
    def __init__(self, thread_manager: ThreadManager, db_connection, account_id: str):
        super().__init__()
        self.thread_manager = thread_manager
        self.db = db_connection
        self.account_id = account_id

    async def _get_current_account_id(self) -> Optional[str]:
        return self.account_id

    async def _sync_workflows_to_version_config(self, agent_id: str) -> None:
        try:
            account_id = self.account_id
            if not account_id:
                logger.warning(f"No account ID available for sync operation on agent {agent_id}")
                return
                
            client = await self.db.client

            agent_result = await client.table('agents').select('current_version_id').eq('agent_id', agent_id).eq('account_id', account_id).single().execute()
            if not agent_result.data or not agent_result.data.get('current_version_id'):
                logger.warning(f"No current version found for agent {agent_id} or access denied")
                return
            
            current_version_id = agent_result.data['current_version_id']
            
            workflows_result = await client.table('agent_workflows').select('*').eq('agent_id', agent_id).execute()
            workflows = workflows_result.data if workflows_result.data else []
            
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
            
            config['workflows'] = workflows
            config['triggers'] = triggers

            await client.table('agent_versions').update({'config': config}).eq('version_id', current_version_id).execute()
            
            logger.debug(f"Synced {len(workflows)} workflows and {len(triggers)} triggers to version config for agent {agent_id}")
            
        except Exception as e:
            logger.error(f"Failed to sync workflows and triggers to version config: {e}")

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
                    "description": {
                        "type": "string", 
                        "description": "A comprehensive description of what the agent does, its capabilities, and its intended use cases."
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
                "required": ["name", "description", "system_prompt", "icon_name", "icon_color", "icon_background"]
            }
        }
    })
    @usage_example('''
        <function_calls>
        <invoke name="ask">
        <parameter name="text">I'd like to create a specialized Research Assistant agent for you. Here are the details:

**Agent Details:**
- **Name**: Research Assistant
- **Purpose**: Conduct thorough research, analyze information, and provide comprehensive reports
- **Capabilities**: Web search, document analysis, data compilation, source verification
- **Tools**: Web search, file management, vision analysis
- **Icon**: Brain icon with blue background

This agent will be optimized for research tasks and will have access to search tools and document processing capabilities. 

Would you like me to proceed with creating this Research Assistant agent?</parameter>
        </invoke>
        </function_calls>

        <!-- After user confirms -->
        <function_calls>
        <invoke name="create_new_agent">
        <parameter name="name">Research Assistant</parameter>
        <parameter name="description">An AI assistant specialized in conducting thorough research, analyzing information from multiple sources, and providing comprehensive reports with verified sources</parameter>
        <parameter name="system_prompt">Act as a research analyst and information specialist. Your primary role is to conduct thorough research on any topic, analyze information from multiple sources, and provide comprehensive, well-structured reports.

Key responsibilities:
- Always verify information from multiple credible sources
- Provide clear citations and source references
- Structure findings in a logical, easy-to-understand format
- Identify potential biases or limitations in sources
- Suggest areas for further research when relevant
- Present balanced perspectives on controversial topics

Approach each research task methodically, starting with broad searches and then drilling down into specific aspects. Always prioritize accuracy and thoroughness over speed.</parameter>
        <parameter name="icon_name">brain</parameter>
        <parameter name="icon_color">#4F46E5</parameter>
        <parameter name="icon_background">#DBEAFE</parameter>
        <parameter name="agentpress_tools">{"web_search_tool": true, "sb_files_tool": true, "sb_vision_tool": true, "browser_tool": true, "sb_shell_tool": false, "data_providers_tool": true}</parameter>
        <parameter name="configured_mcps">[]</parameter>
        <parameter name="is_default">false</parameter>
        </invoke>
        </function_calls>
        ''')
    async def create_new_agent(
        self,
        name: str,
        description: str,
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
                    "workflow_tool": True,
                    "trigger_tool": True
                }
                
                for tool_name, enabled in agent_builder_tools.items():
                    if tool_name not in agentpress_tools:
                        agentpress_tools[tool_name] = enabled
            
            if configured_mcps is None:
                configured_mcps = []

            if is_default:
                await client.table('agents').update({"is_default": False}).eq("account_id", account_id).eq("is_default", True).execute()

            insert_data = {
                "account_id": account_id,
                "name": name,
                "description": description,
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
                success_message += f"**Description**: {description}\n"
                success_message += f"**Icon**: {icon_name} ({icon_color} on {icon_background})\n"
                success_message += f"**Default Agent**: {'Yes' if is_default else 'No'}\n"
                success_message += f"**Tools Enabled**: {len([k for k, v in agentpress_tools.items() if v])}\n"
                success_message += f"**MCPs Configured**: {len(configured_mcps)}\n\n"
                success_message += "The agent is now available in your agent library and ready to use!\n\n"
                success_message += f"🔧 **For Advanced Configuration:**\n"
                success_message += f"Visit the agent configuration page to further customize:\n"
                success_message += f"• Add workflows and automation\n"
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
    @usage_example('''
        <function_calls>
        <invoke name="search_mcp_servers_for_agent">
        <parameter name="search_query">github</parameter>
        </invoke>
        </function_calls>
        ''')
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
    @usage_example('''
        <function_calls>
        <invoke name="get_mcp_server_details">
        <parameter name="toolkit_slug">googlesheets</parameter>
        </invoke>
        </function_calls>
        ''')
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
    @usage_example('''
        <function_calls>
        <invoke name="create_credential_profile_for_agent">
        <parameter name="toolkit_slug">github</parameter>
        <parameter name="profile_name">My GitHub Account</parameter>
        </invoke>
        </function_calls>
        ''')
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
    @usage_example('''
        <function_calls>
        <invoke name="discover_mcp_tools_for_agent">
        <parameter name="profile_name">My GitHub Account</parameter>
        </invoke>
        </function_calls>
        ''')
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
    @usage_example('''
        <function_calls>
        <invoke name="configure_agent_integration">
        <parameter name="agent_id">agent-uuid-123</parameter>
        <parameter name="profile_name">My GitHub Account</parameter>
        <parameter name="enabled_tools">["create_issue", "list_repositories", "get_pull_requests"]</parameter>
        <parameter name="display_name">GitHub Integration</parameter>
        </invoke>
        </function_calls>
        ''')
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
            "name": "create_agent_workflow",
            "description": "Create a workflow/playbook for a newly created agent. This stores a Start node with a single child that contains config.playbook { template, variables }.",
            "parameters": {
                "type": "object",
                "properties": {
                    "agent_id": {
                        "type": "string",
                        "description": "The ID of the agent to create the workflow for"
                    },
                    "name": {
                        "type": "string",
                        "description": "Name of the workflow"
                    },
                    "template": {
                        "type": "string",
                        "description": "Workflow/playbook instructions text. Use {{variable}} tokens for dynamic values."
                    },
                    "variables": {
                        "type": "array",
                        "description": "Optional variable specifications",
                        "items": {
                            "type": "object",
                            "properties": {
                                "key": {"type": "string"},
                                "label": {"type": "string"},
                                "required": {"type": "boolean", "default": True}
                            },
                            "required": ["key"]
                        },
                        "default": []
                    },
                    "description": {
                        "type": "string",
                        "description": "Optional short description (auto-summarized from template if omitted)"
                    },
                    "is_default": {
                        "type": "boolean",
                        "description": "Whether this should be the default workflow",
                        "default": False
                    }
                },
                "required": ["agent_id", "name", "template"]
            }
        }
    })
    @usage_example('''
        <function_calls>
        <invoke name="create_agent_workflow">
        <parameter name="agent_id">agent-uuid-123</parameter>
        <parameter name="name">Daily Report Generator</parameter>
        <parameter name="template">Generate a daily report for {{department}} including metrics from {{start_date}} to {{end_date}}</parameter>
        <parameter name="variables">[{"key":"department","label":"Department Name","required":true},{"key":"start_date","label":"Start Date","required":true},{"key":"end_date","label":"End Date","required":true}]</parameter>
        </invoke>
        </function_calls>
        ''')
    async def create_agent_workflow(
        self,
        agent_id: str,
        name: str,
        template: str,
        variables: Optional[List[Dict[str, Any]]] = None,
        description: Optional[str] = None,
        is_default: bool = False
    ) -> ToolResult:
        try:
            account_id = self.account_id
            if not account_id:
                return self.fail_response("Unable to determine current account ID")
            
            client = await self.db.client
            
            agent_result = await client.table('agents').select('*').eq('agent_id', agent_id).eq('account_id', account_id).execute()
            if not agent_result.data:
                return self.fail_response("Agent not found or access denied")
            
            variables = variables or []
            
            playbook_step = {
                'id': 'workflow-exec',
                'name': 'Execute Workflow Template',
                'description': 'Execute the workflow/playbook template using provided variables.',
                'type': 'instruction',
                'config': {
                    'playbook': {
                        'template': template,
                        'variables': variables,
                    }
                },
                'order': 1,
                'children': []
            }
            
            start_node = {
                'id': 'start-node',
                'name': 'Start',
                'description': 'Click to add steps or use the Add Node button',
                'type': 'instruction',
                'config': {},
                'order': 0,
                'children': [playbook_step]
            }
            
            steps_json = self._convert_steps_to_json([start_node])
            
            def _summarize(text: str) -> str:
                s = (text or '').strip().replace('\n', ' ')
                return s[:160] + ('…' if len(s) > 160 else '')
            
            workflow_data = {
                'agent_id': agent_id,
                'name': name,
                'description': description if description is not None else _summarize(template),
                'trigger_phrase': None,
                'is_default': is_default,
                'status': 'draft',
                'steps': steps_json,
            }
            
            result = await client.table('agent_workflows').insert(workflow_data).execute()
            if not result.data:
                return self.fail_response("Failed to create workflow")
            
            workflow = result.data[0]
            
            success_message = f"✅ Successfully created workflow '{name}' for agent!\n\n"
            success_message += f"**Workflow Details:**\n"
            success_message += f"- Name: {workflow['name']}\n"
            success_message += f"- Description: {workflow.get('description', 'No description')}\n"
            success_message += f"- Status: {workflow['status']}\n"
            success_message += f"- Default: {'Yes' if workflow['is_default'] else 'No'}\n"
            if variables:
                success_message += f"- Variables: {len(variables)} configured\n"
                for var in variables[:3]:
                    success_message += f"  • {{{{**{var['key']}**}}}}: {var.get('label', var['key'])} {'(required)' if var.get('required', True) else '(optional)'}\n"
                if len(variables) > 3:
                    success_message += f"  • ...and {len(variables) - 3} more\n"
            success_message += f"\nThe workflow has been created in **draft** status. You can activate it when ready to use."
            
            try:
                await self._sync_workflows_to_version_config(agent_id)
            except Exception as e:
                logger.warning(f"Failed to sync workflows to version config: {e}")
            
            return self.success_response({
                    "message": success_message,
                    "workflow": {
                        "id": workflow["id"],
                        "agent_id": agent_id,
                        "name": workflow["name"],
                        "description": workflow.get("description"),
                        "is_default": workflow["is_default"],
                        "status": workflow["status"],
                        "steps_count": len(steps_json),
                        "variables_count": len(variables),
                        "created_at": workflow["created_at"]
                    }
                })
            
        except Exception as e:
            logger.error(f"Failed to create workflow: {e}", exc_info=True)
            return self.fail_response("Failed to create workflow")
    
    @openapi_schema({
        "type": "function",
        "function": {
            "name": "list_agent_workflows",
            "description": "List all workflows for a specific agent",
            "parameters": {
                "type": "object",
                "properties": {
                    "agent_id": {
                        "type": "string",
                        "description": "The ID of the agent to list workflows for"
                    },
                    "include_steps": {
                        "type": "boolean",
                        "description": "Whether to include detailed step information",
                        "default": False
                    }
                },
                "required": ["agent_id"]
            }
        }
    })
    @usage_example('''
        <function_calls>
        <invoke name="list_agent_workflows">
        <parameter name="agent_id">agent-uuid-123</parameter>
        </invoke>
        </function_calls>
        ''')
    async def list_agent_workflows(self, agent_id: str, include_steps: bool = False) -> ToolResult:
        try:
            account_id = self.account_id
            if not account_id:
                return self.fail_response("Unable to determine current account ID")
            
            client = await self.db.client
            
            agent_result = await client.table('agents').select('*').eq('agent_id', agent_id).eq('account_id', account_id).execute()
            if not agent_result.data:
                return self.fail_response("Agent not found or access denied")
            
            result = await client.table('agent_workflows').select('*').eq('agent_id', agent_id).order('created_at', desc=True).execute()
            
            workflows = []
            for workflow_data in result.data:
                workflow_info = {
                    "id": workflow_data["id"],
                    "name": workflow_data["name"],
                    "description": workflow_data.get("description"),
                    "trigger_phrase": workflow_data.get("trigger_phrase"),
                    "is_default": workflow_data["is_default"],
                    "status": workflow_data["status"],
                    "created_at": workflow_data["created_at"],
                    "updated_at": workflow_data["updated_at"]
                }
                
                if include_steps:
                    steps_json = workflow_data.get("steps", [])
                    workflow_info["steps"] = steps_json
                    workflow_info["steps_count"] = len(steps_json)
                else:
                    workflow_info["steps_count"] = len(workflow_data.get("steps", []))
                
                workflows.append(workflow_info)
            
            return self.success_response({
                "message": f"Found {len(workflows)} workflow(s) for agent",
                "agent_id": agent_id,
                "workflows": workflows,
                "total_count": len(workflows)
            })
            
        except Exception as e:
            logger.error(f"Failed to list workflows: {e}", exc_info=True)
            return self.fail_response("Failed to list workflows")
    
    @openapi_schema({
        "type": "function",
        "function": {
            "name": "activate_agent_workflow",
            "description": "Activate or deactivate a workflow for an agent. Only active workflows can be executed.",
            "parameters": {
                "type": "object",
                "properties": {
                    "agent_id": {
                        "type": "string",
                        "description": "The ID of the agent that owns the workflow"
                    },
                    "workflow_id": {
                        "type": "string",
                        "description": "The ID of the workflow to activate/deactivate"
                    },
                    "active": {
                        "type": "boolean",
                        "description": "Whether to activate (true) or deactivate (false) the workflow",
                        "default": True
                    }
                },
                "required": ["agent_id", "workflow_id"]
            }
        }
    })
    @usage_example('''
        <function_calls>
        <invoke name="activate_agent_workflow">
        <parameter name="agent_id">agent-uuid-123</parameter>
        <parameter name="workflow_id">workflow-456</parameter>
        <parameter name="active">true</parameter>
        </invoke>
        </function_calls>
        ''')
    async def activate_agent_workflow(self, agent_id: str, workflow_id: str, active: bool = True) -> ToolResult:
        try:
            account_id = self.account_id
            if not account_id:
                return self.fail_response("Unable to determine current account ID")
            
            client = await self.db.client
            
            agent_result = await client.table('agents').select('*').eq('agent_id', agent_id).eq('account_id', account_id).execute()
            if not agent_result.data:
                return self.fail_response("Agent not found or access denied")
            
            workflow_result = await client.table('agent_workflows').select('*').eq('id', workflow_id).eq('agent_id', agent_id).execute()
            if not workflow_result.data:
                return self.fail_response("Workflow not found or access denied")
            
            workflow_name = workflow_result.data[0]['name']
            new_status = 'active' if active else 'inactive'
            
            result = await client.table('agent_workflows').update({'status': new_status}).eq('id', workflow_id).execute()
            
            if not result.data:
                return self.fail_response("Failed to update workflow status")
            
            action = "activated" if active else "deactivated"
            
            success_message = f"✅ Workflow '{workflow_name}' has been {action}!\n\n"
            success_message += f"**Workflow Details:**\n"
            success_message += f"- Name: {workflow_name}\n"
            success_message += f"- Status: **{new_status}**\n\n"
            if active:
                success_message += "The workflow is now active and can be executed."
            else:
                success_message += "The workflow is now inactive and won't be executed until reactivated."
            

            try:
                await self._sync_workflows_to_version_config(agent_id)
            except Exception as e:
                logger.warning(f"Failed to sync workflows to version config: {e}")
            
            return self.success_response({
                "message": success_message,
                "workflow_name": workflow_name,
                "status": new_status
            })
            
        except Exception as e:
            logger.error(f"Failed to update workflow status: {e}", exc_info=True)
            return self.fail_response("Failed to update workflow status")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "delete_agent_workflow",
            "description": "Delete a workflow from an agent. This action cannot be undone.",
            "parameters": {
                "type": "object",
                "properties": {
                    "agent_id": {
                        "type": "string",
                        "description": "The ID of the agent that owns the workflow"
                    },
                    "workflow_id": {
                        "type": "string",
                        "description": "The ID of the workflow to delete"
                    }
                },
                "required": ["agent_id", "workflow_id"]
            }
        }
    })
    @usage_example('''
        <function_calls>
        <invoke name="delete_agent_workflow">
        <parameter name="agent_id">agent-uuid-123</parameter>
        <parameter name="workflow_id">workflow-456</parameter>
        </invoke>
        </function_calls>
        ''')
    async def delete_agent_workflow(self, agent_id: str, workflow_id: str) -> ToolResult:
        try:
            account_id = self.account_id
            if not account_id:
                return self.fail_response("Unable to determine current account ID")
            
            client = await self.db.client

            agent_result = await client.table('agents').select('*').eq('agent_id', agent_id).eq('account_id', account_id).execute()
            if not agent_result.data:
                return self.fail_response("Agent not found or access denied")

            workflow_result = await client.table('agent_workflows').select('*').eq('id', workflow_id).eq('agent_id', agent_id).execute()
            if not workflow_result.data:
                return self.fail_response("Workflow not found or access denied")
            
            workflow_name = workflow_result.data[0]['name']
            
            result = await client.table('agent_workflows').delete().eq('id', workflow_id).execute()
            
            try:
                await self._sync_workflows_to_version_config(agent_id)
            except Exception as e:
                logger.warning(f"Failed to sync workflows to version config: {e}")
            
            return self.success_response({
                "message": f"✅ Workflow '{workflow_name}' has been deleted successfully.",
                "workflow_name": workflow_name
            })
            
        except Exception as e:
            logger.error(f"Failed to delete workflow: {e}", exc_info=True)
            return self.fail_response("Failed to delete workflow")
    
    def _convert_steps_to_json(self, steps: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        if not steps:
            return []
        
        result = []
        for step in steps:
            step_dict = {
                'name': step.get('name', ''),
                'description': step.get('description'),
                'type': step.get('type', 'instruction'),
                'config': step.get('config', {}),
                'conditions': step.get('conditions'),
                'order': step.get('order', 0)
            }
            
            if 'id' in step and step.get('id'):
                step_dict['id'] = step['id']
            if 'parentConditionalId' in step and step.get('parentConditionalId'):
                step_dict['parentConditionalId'] = step['parentConditionalId']
            
            if step.get('children'):
                step_dict['children'] = self._convert_steps_to_json(step['children'])
            
            result.append(step_dict)
        
        return result

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "create_agent_scheduled_trigger",
            "description": "Create a scheduled trigger for a newly created agent to execute workflows or run the agent directly using cron expressions.",
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
                    "execution_type": {
                        "type": "string",
                        "enum": ["workflow", "agent"],
                        "description": "Whether to execute a workflow or run the agent directly",
                        "default": "agent"
                    },
                    "workflow_id": {
                        "type": "string",
                        "description": "ID of the workflow to execute (required if execution_type is 'workflow')"
                    },
                    "workflow_input": {
                        "type": "object",
                        "description": "Input data to pass to the workflow (optional, only for workflow execution)",
                        "additionalProperties": True
                    },
                    "agent_prompt": {
                        "type": "string",
                        "description": "Prompt to send to the agent when triggered (required if execution_type is 'agent')"
                    }
                },
                "required": ["agent_id", "name", "cron_expression", "execution_type"]
            }
        }
    })
    @usage_example('''
        <function_calls>
        <invoke name="create_agent_scheduled_trigger">
        <parameter name="agent_id">agent-uuid-123</parameter>
        <parameter name="name">Daily Report Generation</parameter>
        <parameter name="description">Generates daily reports every morning at 9 AM</parameter>
        <parameter name="cron_expression">0 9 * * *</parameter>
        <parameter name="execution_type">workflow</parameter>
        <parameter name="workflow_id">workflow-123</parameter>
        <parameter name="workflow_input">{"report_type": "daily", "include_charts": true}</parameter>
        </invoke>
        </function_calls>
        ''')
    async def create_agent_scheduled_trigger(
        self,
        agent_id: str,
        name: str,
        cron_expression: str,
        execution_type: str = "agent",
        description: Optional[str] = None,
        workflow_id: Optional[str] = None,
        workflow_input: Optional[Dict[str, Any]] = None,
        agent_prompt: Optional[str] = None
    ) -> ToolResult:
        try:
            account_id = self.account_id
            if not account_id:
                return self.fail_response("Unable to determine current account ID")
            
            client = await self.db.client
            
            agent_result = await client.table('agents').select('*').eq('agent_id', agent_id).eq('account_id', account_id).execute()
            if not agent_result.data:
                return self.fail_response("Agent not found or access denied")
            
            if execution_type not in ["workflow", "agent"]:
                return self.fail_response("execution_type must be either 'workflow' or 'agent'")
            
            if execution_type == "workflow" and not workflow_id:
                return self.fail_response("workflow_id is required when execution_type is 'workflow'")
            
            if execution_type == "agent" and not agent_prompt:
                return self.fail_response("agent_prompt is required when execution_type is 'agent'")
            
            if execution_type == "workflow":
                workflow_result = await client.table('agent_workflows').select('*').eq('id', workflow_id).eq('agent_id', agent_id).execute()
                if not workflow_result.data:
                    return self.fail_response("Workflow not found or access denied")
                
                workflow = workflow_result.data[0]
                if workflow['status'] != 'active':
                    return self.fail_response("Workflow is not active. Please activate it first.")
            
            trigger_config = {
                "cron_expression": cron_expression,
                "execution_type": execution_type,
                "provider_id": "schedule"
            }
            
            if execution_type == "workflow":
                trigger_config["workflow_id"] = workflow_id
                if workflow_input:
                    trigger_config["workflow_input"] = workflow_input
            else:
                trigger_config["agent_prompt"] = agent_prompt
            
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
                success_message += f"- Type: {execution_type.capitalize()} execution\n"
                
                if execution_type == "workflow":
                    success_message += f"- Workflow: {workflow['name']}\n"
                    if workflow_input:
                        success_message += f"- Input Data: Configured with {len(workflow_input)} parameters\n"
                else:
                    success_message += f"- Prompt: {agent_prompt[:50]}{'...' if len(agent_prompt) > 50 else ''}\n"
                
                success_message += f"- Status: **Active**\n\n"
                success_message += f"The trigger is now active and will run according to the schedule."

                try:
                    await self._sync_workflows_to_version_config(agent_id)
                except Exception as e:
                    logger.warning(f"Failed to sync triggers to version config: {e}")
                
                return self.success_response({
                    "message": success_message,
                    "trigger": {
                        "id": trigger.trigger_id,
                        "agent_id": agent_id,
                        "name": trigger.name,
                        "description": trigger.description,
                        "cron_expression": cron_expression,
                        "execution_type": execution_type,
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
    @usage_example('''
        <function_calls>
        <invoke name="list_agent_scheduled_triggers">
        <parameter name="agent_id">agent-uuid-123</parameter>
        </invoke>
        </function_calls>
        ''')
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
            
            workflows = {}
            for trigger in schedule_triggers:
                if trigger.config.get("execution_type") == "workflow" and trigger.config.get("workflow_id"):
                    workflow_id = trigger.config["workflow_id"]
                    if workflow_id not in workflows:
                        workflow_result = await client.table('agent_workflows').select('name').eq('id', workflow_id).execute()
                        if workflow_result.data:
                            workflows[workflow_id] = workflow_result.data[0]['name']
            
            formatted_triggers = []
            for trigger in schedule_triggers:
                formatted = {
                    "id": trigger.trigger_id,
                    "name": trigger.name,
                    "description": trigger.description,
                    "cron_expression": trigger.config.get("cron_expression"),
                    "execution_type": trigger.config.get("execution_type", "agent"),
                    "is_active": trigger.is_active,
                    "created_at": trigger.created_at.isoformat()
                }
                
                if trigger.config.get("execution_type") == "workflow":
                    workflow_id = trigger.config.get("workflow_id")
                    formatted["workflow_name"] = workflows.get(workflow_id, "Unknown Workflow")
                    formatted["workflow_input"] = trigger.config.get("workflow_input")
                else:
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
    @usage_example('''
        <function_calls>
        <invoke name="toggle_agent_scheduled_trigger">
        <parameter name="agent_id">agent-uuid-123</parameter>
        <parameter name="trigger_id">trigger-456</parameter>
        <parameter name="is_active">false</parameter>
        </invoke>
        </function_calls>
        ''')
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
                    await self._sync_workflows_to_version_config(agent_id)
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
    @usage_example('''
        <function_calls>
        <invoke name="delete_agent_scheduled_trigger">
        <parameter name="agent_id">agent-uuid-123</parameter>
        <parameter name="trigger_id">trigger-456</parameter>
        </invoke>
        </function_calls>
        ''')
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
                    await self._sync_workflows_to_version_config(agent_id)
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
    @usage_example('''
        <function_calls>
        <invoke name="update_agent_config">
        <parameter name="agent_id">agent-uuid-123</parameter>
        <parameter name="system_prompt">Act as a senior software engineer and code reviewer. Your role is to analyze code, suggest improvements, identify bugs, and ensure best practices are followed.

Key responsibilities:
- Review code for bugs, security issues, and performance problems
- Suggest architectural improvements and design patterns
- Ensure code follows established conventions and standards
- Provide constructive feedback with specific examples
- Help optimize code for maintainability and readability

When reviewing code:
1. Check for potential bugs and edge cases
2. Verify error handling and input validation
3. Assess code organization and structure
4. Recommend performance optimizations
5. Ensure proper documentation and comments

Always provide actionable feedback with code examples when possible.</parameter>
        <parameter name="change_description">Updated system prompt to focus more on code review and best practices</parameter>
        </invoke>
        </function_calls>
        ''')
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
                    await self._sync_workflows_to_version_config(agent_id)
                except Exception as e:
                    logger.warning(f"Failed to sync workflows and triggers to new version: {e}")
            
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
    