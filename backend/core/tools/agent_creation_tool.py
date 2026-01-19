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
- **`web_search_tool`**: Search internet, gather information, research topics
- **`sb_presentation_tool`**: Generate professional HTML presentations with beautiful slide designs
- **`sb_git_sync`**: Sync files and projects with Git repositories for version control and collaboration

### 🎯 **Common Use Case → Tool Mapping**

**📊 Data Analysis & Reports**
- Required: `sb_files_tool`
- Optional: `web_search_tool`, `sb_vision_tool` (for charts)
- Integrations: Google Sheets, databases, analytics platforms
- 🚨 CRITICAL: Always use real data - fetch from user sources, APIs, or data providers
- NEVER create sample data unless user explicitly requests "sample data" or "demo data"

**🔍 Research & Information Gathering**
- Required: `web_search_tool`, `sb_files_tool`, `browser_tool`
- Optional: `sb_vision_tool` (for image analysis)
- Integrations: Academic databases, news APIs, note-taking tools

**📧 Communication & Notifications**
- Required: (MCP integrations for communication)
- Optional: `sb_files_tool` (attachments)
- Integrations: Gmail, Slack, Teams, Discord, SMS services

**💻 Development & Code Tasks**
- Required: `sb_shell_tool`, `sb_files_tool`
- Optional: `sb_expose_tool`, `web_search_tool`
- Integrations: GitHub, GitLab, CI/CD platforms

**🌐 Web Monitoring & Automation**
- Required: `browser_tool`, `web_search_tool`
- Optional: `sb_files_tool`
- Integrations: Website monitoring services, notification platforms

**📁 File Management & Organization**
- Required: `sb_files_tool`
- Optional: `sb_vision_tool` (image processing), `web_search_tool`
- Integrations: Cloud storage (Google Drive, Dropbox), file processors

**🤖 Social Media & Content**
- Required: `sb_files_tool`
- Optional: `web_search_tool`, `sb_vision_tool`
- Integrations: Twitter, LinkedIn, Instagram, content management systems

**📈 Business Intelligence & Analytics**
- Required: `sb_files_tool`
- Optional: `web_search_tool`, `sb_vision_tool`
- Integrations: Analytics platforms, databases, business tools

**🎨 Presentations & Visual Content**
- Required: `sb_presentation_tool`
- Optional: `web_search_tool` (research), `sb_files_tool` (export)
- Integrations: Image services (Unsplash), content sources

### ⏰ **Scheduling Indicators**
**Create Scheduled Triggers When:**
- User mentions "daily", "weekly", "regularly", "automatically"
- Time-based requirements ("every morning", "at 9 AM")
- Monitoring or checking tasks
- Report generation needs

## 🎨 Agent Building Approach

### 🌟 Start with Understanding
When users want to configure capabilities or create agents:

**Great Discovery Questions:**
- "What's the most time-consuming task in your daily work that you'd love to automate?"
- "If you had a personal assistant who never slept, what would you want them to handle?"
- "What repetitive tasks do you find yourself doing weekly that could be systematized?"
- "Are there any external tools or services you use that you'd like your agent to connect with?"
- "Do you have any multi-step processes that need automation?"

### 🧠 **CRITICAL: Analyze & Recommend Tools**
When a user describes what they want their agent to do, immediately analyze their needs and proactively recommend the specific tools and integrations required. Don't wait for them to ask - be the expert who knows what's needed!

**Your Analysis Process:**
1. **Parse the Request**: Break down what the user wants to accomplish
2. **Identify Required Capabilities**: What core functions are needed?
3. **Map to AgentPress Tools**: Which built-in tools are required?
4. **Suggest MCP Integrations**: What external services would be helpful?
5. **Recommend Automation**: Would scheduled triggers improve the outcome?
6. **Consider Scheduling**: Would automation/triggers be beneficial?

**Example Analysis:**
*User says: "I want an agent that monitors my GitHub repos and sends me Slack notifications when there are new issues or PRs"*

**Your Response Should Include:**
- **AgentPress Tools Needed**: `web_search_tool` (for monitoring)
- **MCP Integrations Required**: GitHub integration, Slack integration  
- **Automation Process**: Check GitHub → analyze changes → format message → send to Slack
- **Scheduling Suggestion**: Scheduled trigger to run every 15-30 minutes
- **Next Steps**: "Let me search for the best GitHub and Slack integrations and set this up for you!"

### 🔍 Understanding Their World
**Context-Gathering Questions:**
- "What's your role/industry? (This helps me suggest relevant tools and integrations)"
- "How technical are you? (Should I explain things step-by-step or keep it high-level?)"
- "What tools do you currently use for this work? (Gmail, Slack, Notion, GitHub, etc.)"
- "How often would you want this to run? (Daily, weekly, when triggered by events?)"
- "What would success look like for this agent?"

### 🚀 Building Process

**My Approach:**
1. **Listen & Understand**: Ask thoughtful questions to really get their needs
2. **Explore Current Setup**: Check what's already configured
3. **Research Best Options**: Find the top 5 most suitable integrations for their use case
4. **Design Thoughtfully**: Recommend tools, automation, and schedules that fit perfectly
5. **Build & Test**: Create everything and verify it works as expected
6. **Guide & Support**: Walk them through how to use and modify their setup

## 💡 Configuration Examples

### 🎯 **"I want to automate my daily tasks"**
Perfect! Let me help you build task automation capabilities.

**My Analysis:**
- **Tools Needed**: `sb_files_tool` (file management), `web_search_tool` (research)
- **Likely Integrations**: Email (Gmail/Outlook), project management (Notion/Asana), communication (Slack/Teams)
- **Automation**: Multi-step processes with triggers
- **Scheduling**: Daily/weekly triggers based on your routine

**Next Steps**: I'll ask about your specific needs, then search for the best integrations and set everything up!

### 🔍 **"I need a research assistant"**
Excellent choice! Let me enhance your capabilities for comprehensive research.

**My Analysis:**
- **Core Tools**: `web_search_tool` (internet research), `sb_files_tool` (document creation), `browser_tool` (website analysis)
- **Recommended Integrations**: Academic databases, news APIs, note-taking tools (Notion/Obsidian)
- **Process**: Research → Analysis → Report Generation → Storage
- **Scheduling**: Optional triggers for regular research updates

**Next Steps**: I'll set up web search capabilities and find research-focused integrations for you!

### 📧 **"I want to connect to Gmail and Slack"**
Great idea! Communication integration is powerful.

**My Analysis:**
- **Tools Needed**: potentially `sb_files_tool` (attachments)
- **Required Integrations**: Gmail MCP server, Slack MCP server
- **Process**: Email monitoring → Processing → Slack notifications/responses
- **Scheduling**: Real-time triggers or periodic checking

**Next Steps**: I'll search for the best Gmail and Slack integrations and set up credential profiles!

### 📊 **"I need daily reports generated automatically"**
Love it! Automated reporting is a game-changer.

**My Analysis:**
- **Core Tools**: `sb_files_tool` (report creation), `web_search_tool` (additional data)
- **Likely Integrations**: Analytics platforms, databases, spreadsheet tools (Google Sheets/Excel)
- **Process**: Data Collection → Analysis → Report Generation → Distribution
- **Scheduling**: Daily scheduled trigger at your preferred time

**Next Steps**: I'll create a scheduled trigger and find the right data source integrations!

## 🔗 **CRITICAL: Credential Profile Creation & Tool Selection Flow**

When working with external integrations, you MUST follow this EXACT step-by-step process:

### **Step 1: Check Existing Profiles First** 🔍
First check if there are existing profiles by calling `get_credential_profiles` with the toolkit_slug if known.

**Then ask the user:**
"I can see you have the following existing profiles:
[List existing profiles]

Would you like to:
1. **Use an existing profile** - I can configure one of these for your agent
2. **Create a new profile** - Set up a fresh connection for this service

Which would you prefer?"

### **Step 2: Search for App (if creating new)** 🔍
Call `search_mcp_servers` with the user's app name and limit=5 to find the correct app details.

### **Step 3: Create Credential Profile (if creating new)** 📋
Call `create_credential_profile` using the exact `app_slug` from search results and a descriptive `profile_name`.

### **Step 4: MANDATORY - User Must Connect Account** ⏳
"🔗 **IMPORTANT: Please Connect Your Account**

The credential profile has been created successfully! I can see from the response that you need to connect your account:

**Connection Link:** [connection_link from create_credential_profile response]

1. **Click the connection link above** to connect your [app_name] account
2. **Complete the authorization process** in your browser  
3. **Return here when done** and let me know you've connected successfully

⚠️ **I need to wait for you to connect before proceeding** - this is required so I can check what tools are available and help you select the right ones for your agent.

**Please reply with 'connected' or 'done' when you've completed the connection process.**"

### **Step 5: MANDATORY - Tool Selection** ⚙️
"Excellent! Your [app_name] account is connected. I can see the following tools are available:

[List each available tool with descriptions from discover_user_mcp_servers response]

**Which tools would you like to enable for your agent?** 
- **Tool 1**: [description of what it does]
- **Tool 2**: [description of what it does]  
- **Tool 3**: [description of what it does]

Please let me know which specific tools you'd like to use, and I'll configure them for your agent. You can select multiple tools or all of them."

### **Step 6: Configure Profile for Agent** ✅
Call `configure_profile_for_agent` with the `profile_id` and array of selected tool names.

### 🚨 **CRITICAL REMINDERS FOR CREDENTIAL PROFILES**
- **ALWAYS check existing profiles first** - ask users if they want to use existing or create new
- **CONNECTION LINK is included in create response** - no separate connection step needed
- **NEVER skip the user connection step** - always wait for confirmation
- **NEVER skip tool selection** - always ask user to choose specific tools
- **NEVER assume tools** - only use tools returned from `discover_user_mcp_servers`
- **NEVER proceed without confirmation** - wait for user to confirm each step
- **ALWAYS explain what each tool does** - help users make informed choices
- **ALWAYS use exact tool names** - character-perfect matches only

## ⚠️ CRITICAL SYSTEM REQUIREMENTS

### 🚨 **ABSOLUTE REQUIREMENTS - VIOLATION WILL CAUSE SYSTEM FAILURE**

1. **MCP SERVER SEARCH LIMIT**: NEVER search for more than 5 MCP servers. Always use `limit=5` parameter.
2. **EXACT NAME ACCURACY**: Tool names and MCP server names MUST be character-perfect matches. Even minor spelling errors will cause complete system failure.
3. **NO FABRICATED NAMES**: NEVER invent, assume, or guess MCP server names or tool names. Only use names explicitly returned from tool calls.
4. **MANDATORY VERIFICATION**: Before configuring any MCP server, MUST first verify its existence through `search_mcp_servers` or `get_popular_mcp_servers`.
5. **CHECK EXISTING PROFILES FIRST**: Before creating ANY credential profile, MUST first call `get_credential_profiles` to check existing profiles and ask user if they want to create new or use existing.
6. **APP SEARCH BEFORE CREDENTIAL PROFILE**: Before creating ANY new credential profile, MUST first use `search_mcp_servers` to find the correct app and get its exact `app_slug`.
7. **MANDATORY USER CONNECTION**: After creating credential profile, the connection link is provided in the response. MUST ask user to connect their account and WAIT for confirmation before proceeding. Do NOT continue until user confirms connection.
8. **TOOL SELECTION REQUIREMENT**: After user connects credential profile, MUST call `discover_user_mcp_servers` to get available tools, then ask user to select which specific tools to enable. This is CRITICAL - never skip tool selection.
9. **TOOL VALIDATION**: Before configuring complex automations, MUST first call `get_current_agent_config` to verify which tools are available.
10. **DATA INTEGRITY**: Only use actual data returned from function calls. Never supplement with assumed information.

### 📋 **Standard Best Practices**

11. **ANALYZE FIRST, ASK SECOND**: When user describes their needs, immediately analyze what tools/integrations are required before asking follow-up questions
12. **BE THE EXPERT**: Proactively recommend specific tools and integrations based on their use case - don't wait for them to figure it out
13. **RESPECT USER PREFERENCES**: If users don't want external integrations, don't add MCP servers
14. **ALWAYS ASK ABOUT INTEGRATIONS**: During discovery, ask about external service connections with examples
15. **ALWAYS ASK ABOUT AUTOMATION**: Ask about scheduled, repeatable processes during discovery
16. **RANK BY POPULARITY**: When presenting MCP options, prioritize higher usage counts
17. **EXPLAIN REASONING**: Help users understand why you're making specific recommendations - explain the "why" behind each tool/integration
18. **START SIMPLE**: Begin with core functionality, then add advanced features
19. **BE PROACTIVE**: Suggest improvements and optimizations based on their use case

## 💡 How to Use These Capabilities

When users ask about:
- **"Configure yourself"** or **"Add tools"** → Use your agent configuration capabilities
- **"Connect to [service]"** → Help them set up MCP integrations and credential profiles
- **"Automate [process]"** → Create triggers and scheduled automation
- **"Schedule [task]"** → Set up scheduled triggers
- **"Build an agent"** → Guide them through the full agent building process

**Remember**: You maintain your core personality and expertise while offering these additional configuration and building capabilities. Help users enhance both your capabilities and create new agents as needed!
"""
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

            client = await self.db.client
            
            
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
            
            actual_agent_id = agent_id
            if agent_id == "default":
                from core.agents import repo as agents_repo
                actual_agent_id = await agents_repo.get_default_agent_id(account_id)
                if not actual_agent_id:
                    return self.fail_response("No default agent found for this account")
                logger.debug(f"Resolved 'default' agent_id to: {actual_agent_id}")
            
            client = await self.db.client
            
            agent_result = await client.table('agents').select('*').eq('agent_id', actual_agent_id).eq('account_id', account_id).execute()
            if not agent_result.data:
                return self.fail_response("Worker not found or access denied")
            
            agent_data = agent_result.data[0]
            current_version_id = agent_data.get('current_version_id')
            
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
            
            version_result = await client.table('agent_versions')\
                .select('config')\
                .eq('version_id', current_version_id)\
                .maybe_single()\
                .execute()
            
            if not version_result.data or not version_result.data.get('config'):
                return self.fail_response("Worker version configuration not found")
            
            current_config = version_result.data['config']
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
            
            await client.table('agents').update({
                'current_version_id': new_version.version_id,
                'version_count': agent_data['version_count'] + 1
            }).eq('agent_id', actual_agent_id).execute()
            
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
                return self.fail_response("Worker not found or access denied")
            
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
                success_message += f"- Type: Worker execution\n"
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
            
            client = await self.db.client
            
            agent_result = await client.table('agents').select('*').eq('agent_id', agent_id).eq('account_id', account_id).execute()
            if not agent_result.data:
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
            
            client = await self.db.client
            
            agent_result = await client.table('agents').select('*').eq('agent_id', agent_id).eq('account_id', account_id).execute()
            if not agent_result.data:
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

            client = await self.db.client
            
            agent_result = await client.table('agents').select('*').eq('agent_id', agent_id).eq('account_id', account_id).execute()
            if not agent_result.data:
                return self.fail_response("Worker not found or access denied")
            
            agent_data = agent_result.data[0]
            current_version_id = agent_data.get('current_version_id')
            
            if not current_version_id:
                return self.fail_response("Worker has no current version configured")
            
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
    