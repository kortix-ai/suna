import json
from typing import Optional, Dict, Any, List
from uuid import uuid4
from core.agentpress.tool import Tool, ToolResult, openapi_schema, tool_metadata
from core.agentpress.thread_manager import ThreadManager
from core.utils.logger import logger
from core.utils.core_tools_helper import ensure_core_tools_enabled
from core.utils.config import config
from core.services.convex_client import get_convex_client

@tool_metadata(
    display_name="Agent Builder",
    description="Create and configure new AI agents with custom capabilities",
    icon="Bot",
    color="bg-purple-100 dark:bg-purple-800/50",
    weight=190,
    visible=True,
    usage_guide="""
## ADDITIONAL CAPABILITY: SELF-CONFIGURATION AND AGENT BUILDING

You now have special tools available that allow you to modify and configure yourself, as well as help users create and enhance AI agents. These capabilities are available to all agents and in addition to your core expertise and personality.

## SYSTEM INFORMATION
- BASE ENVIRONMENT: Python 3.11 with Debian Linux (slim)

## 🎯 What You Can Help Users Build

### 🤖 **Smart Assistants**
- **Research Agents**: Gather information, analyze trends, create comprehensive reports
- **Content Creators**: Write blogs, social media posts, marketing copy
- **Code Assistants**: Review code, debug issues, suggest improvements
- **Data Analysts**: Process spreadsheets, generate insights, create visualizations
  - 🚨 CRITICAL: Always use real data from user-provided sources or verified APIs
  - NEVER generate sample/demo data unless explicitly requested
  - Prioritize accuracy and truth-seeking in all data analysis

### 🔧 **Automation Powerhouses**
- **Scheduled Tasks**: Daily reports, weekly summaries, maintenance routines
- **Integration Bridges**: Connect different tools and services seamlessly
- **Event-Driven Automation**: Respond to triggers from external services
- **Monitoring Agents**: Track systems, send alerts, maintain health checks

### 🌐 **Connected Specialists**
- **API Integrators**: Work with Gmail, GitHub, Notion, databases, and 2700+ other tools
- **Web Researchers**: Browse websites, scrape data, monitor changes
- **File Managers**: Organize documents, process uploads, backup systems
- **Communication Hubs**: Send emails, post updates, manage notifications

## 🛠️ Your Self-Configuration Toolkit

### Agent Configuration (`update_agent` tool)
You can modify your own identity and capabilities:
- **Personality & Expertise**: Update your system prompt, name, and description
- **Tool Selection**: Enable/disable capabilities like web search, file management, code execution
- **External Integrations**: Connect to thousands of external services via MCP servers
- **IMPORTANT**: When adding new MCP servers, they are automatically merged with existing ones - all previously configured integrations are preserved

### 🤖 Agent Creation (`create_new_agent` tool)
Create completely new AI agents for specialized tasks:
- **CRITICAL**: Always ask user for explicit permission before creating any agent using the `ask` tool
- **Specialized Agents**: Build agents optimized for specific domains (research, coding, marketing, etc.)
- **Custom Configuration**: Define unique personalities, expertise, and tool access for each agent
- **NEVER**: Create agents without clear user confirmation and approval

### 🔌 MCP Server Discovery & Integration
Connect to external services:
- **`search_mcp_servers`**: Find integrations by keyword (Gmail, Slack, databases, etc.)
- **`get_popular_mcp_servers`**: Browse trending, well-tested integrations
- **`get_mcp_server_tools`**: Explore what each integration can do
- **`test_mcp_server_connection`**: Verify everything works perfectly

### 🔐 Credential Profile Management
Securely connect external accounts:
- **`get_credential_profiles`**: See what's already connected
- **`create_credential_profile`**: Set up new service connections (includes connection link)
- **`configure_profile_for_agent`**: Add connected services to agents

### ⏰ Trigger Management
Schedule automatic execution and event-based triggers:
- **`create_scheduled_trigger`**: Set up cron-based scheduling
- **`get_scheduled_triggers`**: View all scheduled tasks
- **`delete_scheduled_trigger`**: Remove scheduled tasks
- **`toggle_scheduled_trigger`**: Enable/disable scheduled execution

Event/APP-based triggers (Composio):
- **`list_event_trigger_apps`**: Discover apps with available event triggers
- **`list_app_event_triggers`**: List triggers for a specific app (includes config schema)
- **`get_credential_profiles`**: List connected profiles to get `profile_id` and `connected_account_id`
- **`create_event_trigger`**: Create an event trigger by passing `slug`, `profile_id`, `connected_account_id`, `trigger_config`, and `agent_prompt`.

### 📊 Agent Management
- **`get_current_agent_config`**: Review current setup and capabilities

## 🎯 **Tool Mapping Guide - Match User Needs to Required Tools**

### 🔧 **AgentPress Core Tools**
- **`sb_shell_tool`**: Execute commands, run scripts, system operations, development tasks
- **`sb_files_tool`**: Create/edit files, manage documents, process text, generate reports
- **`browser_tool`**: Navigate websites, scrape content, interact with web apps, monitor pages
- **`sb_vision_tool`**: Process images, analyze screenshots, extract text from images
- **`sb_expose_tool`**: Expose local services, create public URLs for testing
"""
)
class AgentCreationTool(Tool):
    def __init__(self, thread_manager: ThreadManager, db_connection, account_id: str):
        super().__init__()
        self.thread_manager = thread_manager
        # MIGRATED: self.db = db_connection
        self.convex = get_convex_client()
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
                        "description": "Configuration for AgentPress tools. Each key is a tool name, value is boolean for enabled/disabled. Available tools: sb_shell_tool, sb_files_tool, web_search_tool, browser_tool, sb_vision_tool, etc.",
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

            # Note: check_agent_count_limit uses its own Convex client internally
            from core.utils.limits_checker import check_agent_count_limit
            limit_check = await check_agent_count_limit(account_id)

            if not limit_check['can_create']:
                return self.fail_response(
                    f"Maximum of {limit_check['limit']} agents allowed for your current plan. "
                    f"You have {limit_check['current_count']} agents. "
                    f"Current tier: {limit_check['tier_name']}"
                )

            if agentpress_tools is None:
                from core.config.config_helper import _get_default_agentpress_tools
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
                # Clear default flag on all other agents for this account
                await self.convex.clear_default_agents(account_id)

            # Migrated to Convex: create agent
            from uuid import uuid4
            agent_id = str(uuid4())

            new_agent = await self.convex.create_agent(
                agent_id=agent_id,
                account_id=account_id,
                name=name,
                icon_name=icon_name,
                icon_color=icon_color,
                icon_background=icon_background,
                is_default=is_default
            )

            if not new_agent:
                return self.fail_response("Failed to create agent record")

            agent = new_agent
            agent_id = agent.get('agentId', agent_id)

            try:
                from core.versioning.version_service import get_version_service
                from core.ai_models import model_manager

                version_service = await get_version_service()

                # Get default model for user (using placeholder until model preferences endpoint is available)
                default_model = "kortix/basic"

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

                # Migrated to Convex: update agent with current_version_id
                await self.convex.update_agent(agent_id, account_id=account_id, metadata={"current_version_id": version.version_id})

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
                    "name": name,  # Also include 'name' for frontend compatibility
                    "is_default": is_default,
                    "success": True  # Explicit success flag for frontend parsing
                })
                
            except Exception as e:
                logger.error(f"Failed to create agent version: {e}")
                try:
                    # Clean up the agent record since version creation failed
                    await self.convex.delete_agent(agent_id, account_id=account_id)
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
            "description": "Search MCP integrations and return exact toolkit slugs for agent setup. This must be the first tool call before any create_credential_profile_for_agent call.",
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
            "description": "Create a credential profile for external service integration with a newly created agent. Call this ONLY after search_mcp_servers_for_agent in the same request flow, even if the slug seems obvious. Pass an exact toolkit_slug from search results and never generic values like 'google'.",
            "parameters": {
                "type": "object",
                "properties": {
                    "toolkit_slug": {
                        "type": "string",
                        "description": "Exact toolkit slug from search results (e.g., 'gmail', 'googlecalendar', 'googledrive', 'github', 'linear'). Do not use generic names like 'google'."
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
            integration_service = get_integration_service(db_connection=self.db)
            
            integration_user_id = str(uuid4())

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
            logger.error(f"Failed to create credential profile for '{toolkit_slug}': {e}", exc_info=True)
            return self.fail_response(f"Failed to create credential profile: {str(e)}")

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
                        "description": "Optional. Agent ID to add the integration to. Use 'default' (or omit) to target the account's default agent."
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
                "required": ["profile_name", "enabled_tools"]
            }
        }
    })
    async def configure_agent_integration(
        self,
        profile_name: str,
        enabled_tools: List[str],
        agent_id: Optional[str] = "default",
        display_name: Optional[str] = None
    ) -> ToolResult:
        try:
            account_id = self.account_id
            if not account_id:
                return self.fail_response("Unable to determine current account ID")

            requested_agent_id = (agent_id.strip() or "default") if isinstance(agent_id, str) else "default"
            actual_agent_id = requested_agent_id
            if requested_agent_id == "default":
                from core.agents import repo as agents_repo
                actual_agent_id = await agents_repo.get_default_agent_id(account_id)
                if not actual_agent_id:
                    return self.fail_response("No default agent found for this account")
                logger.debug(f"Resolved 'default' agent_id to: {actual_agent_id}")

            # Migrated to Convex: get agent
            try:
                agent_data = await self.convex.get_agent(actual_agent_id, account_id=account_id)
            except Exception as e:
                logger.error(f"Failed to get agent from Convex: {e}")
                return self.fail_response("Worker not found or access denied")

            if not agent_data:
                return self.fail_response("Worker not found or access denied")

            current_version_id = agent_data.get('currentVersionId') or agent_data.get('current_version_id')

            if not current_version_id:
                return self.fail_response("Worker has no current version configured")

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

            # Get the current version configuration
            version_data = await self.convex.get_agent_version(current_version_id, account_id=account_id)
            if not version_data or not version_data.get('config'):
                return self.fail_response("Worker version configuration not found")

            current_config = version_data.get('config', {})
            current_tools = current_config.get('tools', {})
            current_custom_mcps = current_tools.get('custom_mcp', [])
            
            new_mcp_config = {
                'name': profile.toolkit_name,
                'customType': 'composio',
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
                agent_id=actual_agent_id,
                user_id=account_id,
                system_prompt=current_config.get('system_prompt', ''),
                model=current_config.get('model'),
                configured_mcps=current_config.get('tools', {}).get('mcp', []),
                custom_mcps=updated_mcps,
                agentpress_tools=current_config.get('tools', {}).get('agentpress', {}),
                change_description=f"Configured {display_name or profile.display_name} with {len(enabled_tools)} tools"
            )

            # Update the agent with new version info
            await self.convex.update_agent(
                actual_agent_id,
                account_id=account_id,
                metadata={
                    'current_version_id': new_version.version_id,
                    'version_count': agent_data.get('version_count', 0) + 1
                }
            )
            
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
                
                mcp_wrapper_instance = MCPToolWrapper(
                    mcp_configs=[mcp_config_for_wrapper],
                    account_id=account_id,
                )
                await mcp_wrapper_instance.initialize_and_register_tools()
                
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
                "agent_id": actual_agent_id,
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
                    },
                    "model": {
                        "type": "string",
                        "description": "Model to use for scheduled runs. Defaults to 'kortix/basic'."
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
        description: Optional[str] = None,
        model: Optional[str] = None
    ) -> ToolResult:
        try:
            account_id = self.account_id
            if not account_id:
                return self.fail_response("Unable to determine current account ID")

            # Migrated to Convex: get agent
            try:
                agent_data = await self.convex.get_agent(agent_id, account_id=account_id)
            except Exception as e:
                logger.error(f"Failed to get agent from Convex: {e}")
                return self.fail_response("Worker not found or access denied")

            if not agent_data:
                return self.fail_response("Worker not found or access denied")

            if not agent_prompt:
                return self.fail_response("agent_prompt is required")

            selected_model = model or "kortix/basic"

            trigger_config = {
                "cron_expression": cron_expression,
                "provider_id": "schedule",
                "agent_prompt": agent_prompt,
                "model": selected_model
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
                success_message += f"- Model: {selected_model}\n"
                success_message += f"- Type: Worker execution\n"
                success_message += f"- Prompt: {agent_prompt[:50]}{'...' if len(agent_prompt) > 50 else ''}\n"
                success_message += f"- Status: **Active**\n\n"
                success_message += "The trigger is now active and will run according to the schedule."
                
                return self.success_response({
                    "message": success_message,
                    "trigger": {
                        "id": trigger.trigger_id,
                        "agent_id": agent_id,
                        "name": trigger.name,
                        "description": trigger.description,
                        "cron_expression": cron_expression,
                        "model": selected_model,
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

            # Migrated to Convex: get agent
            try:
                agent_data = await self.convex.get_agent(agent_id, account_id=account_id)
            except Exception as e:
                logger.error(f"Failed to get agent from Convex: {e}")
                return self.fail_response("Worker not found or access denied")

            if not agent_data:
                return self.fail_response("Worker not found or access denied")

            from core.triggers import get_trigger_service, TriggerType
            trigger_svc = get_trigger_service(self.db)

            triggers = await trigger_svc.get_agent_triggers(agent_id)

            schedule_triggers = [t for t in triggers if t.trigger_type == TriggerType.SCHEDULE]

            if not schedule_triggers:
                return self.success_response({
                    "message": "No scheduled triggers found for this worker.",
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

            # Migrated to Convex: get agent
            try:
                agent_data = await self.convex.get_agent(agent_id, account_id=account_id)
            except Exception as e:
                logger.error(f"Failed to get agent from Convex: {e}")
                return self.fail_response("Worker not found or access denied")

            if not agent_data:
                return self.fail_response("Worker not found or access denied")

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

            # Migrated to Convex: get agent
            try:
                agent_data = await self.convex.get_agent(agent_id, account_id=account_id)
            except Exception as e:
                logger.error(f"Failed to get agent from Convex: {e}")
                return self.fail_response("Worker not found or access denied")

            if not agent_data:
                return self.fail_response("Worker not found or access denied")

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

            # Get the agent
            agent_data = await self.convex.get_agent(agent_id, account_id=account_id)
            if not agent_data:
                return self.fail_response("Worker not found or access denied")

            current_version_id = agent_data.get('currentVersionId') or agent_data.get('current_version_id')

            if not current_version_id:
                return self.fail_response("Worker has no current version configured")

            # Get the current version configuration
            version_data = await self.convex.get_agent_version(current_version_id, account_id=account_id)
            if not version_data:
                return self.fail_response("Current agent version not found")

            current_config = version_data.get('config', {})
            
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
                    # Clear default flag on all other agents for this account
                    await self.convex.clear_default_agents(account_id)
                agent_updates['is_default'] = is_default
                updates.append(f"Default agent: {'Yes' if is_default else 'No'}")

            if agent_updates:
                await self.convex.update_agent(agent_id, account_id=account_id, **agent_updates)

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

                # Update the agent with new version info
                await self.convex.update_agent(
                    agent_id,
                    account_id=account_id,
                    metadata={
                        'current_version_id': new_version.version_id,
                        'version_count': agent_data.get('version_count', 0) + 1
                    }
                )

                try:
                    await self._sync_triggers_to_version_config(agent_id)
                except Exception as e:
                    logger.warning(f"Failed to sync triggers to new version: {e}")

            # Get the updated agent data
            updated_agent = await self.convex.get_agent(agent_id, account_id=account_id)
            if not updated_agent:
                updated_agent = agent_data
            
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
            # Migrated to Convex: get agent
            try:
                agent_result = await self.convex.get_agent(agent_id)
            except Exception as e:
                logger.warning(f"Failed to get agent from Convex: {e}")
                return

            if not agent_result:
                logger.warning(f"No agent found for {agent_id}")
                return

            current_version_id = agent_result.get('currentVersionId') or agent_result.get('current_version_id')
            if not current_version_id:
                logger.warning(f"No current version found for agent {agent_id}")
                return

            # Migrated to Convex: list triggers
            try:
                triggers_result = await self.convex.list_triggers(agent_id)
            except Exception as e:
                logger.warning(f"Failed to list triggers from Convex: {e}")
                triggers_result = []

            triggers = []
            if triggers_result:
                import json
                for trigger in triggers_result:
                    trigger_copy = trigger.copy()
                    if 'config' in trigger_copy and isinstance(trigger_copy['config'], str):
                        try:
                            trigger_copy['config'] = json.loads(trigger_copy['config'])
                        except json.JSONDecodeError:
                            logger.warning(f"Failed to parse trigger config for {trigger_copy.get('trigger_id')}")
                            trigger_copy['config'] = {}
                    triggers.append(trigger_copy)

            # Get the current version and update its config with triggers
            version_data = await self.convex.get_agent_version(current_version_id)
            if not version_data:
                logger.warning(f"Version {current_version_id} not found")
                return

            config = version_data.get('config', {})
            config['triggers'] = triggers

            # Update the version with the new config
            await self.convex.update_agent_version(current_version_id, config=config)

            logger.debug(f"Synced {len(triggers)} triggers for agent {agent_id} to version {current_version_id}")

        except Exception as e:
            logger.error(f"Failed to sync triggers to version config: {e}")
    
