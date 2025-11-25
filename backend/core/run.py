import os
import json
import asyncio
import datetime
from typing import Optional, Dict, List, Any, AsyncGenerator
from dataclasses import dataclass

from core.tools.message_tool import MessageTool
from core.tools.web_search_tool import SandboxWebSearchTool
from core.tools.image_search_tool import SandboxImageSearchTool
from dotenv import load_dotenv
from core.utils.config import config, EnvMode
from core.prompts.agent_builder_prompt import get_agent_builder_prompt
from core.agentpress.thread_manager import ThreadManager
from core.agentpress.response_processor import ProcessorConfig
from core.agentpress.error_processor import ErrorProcessor
from core.tools.data_providers_tool import DataProvidersTool
from core.tools.expand_msg_tool import ExpandMessageTool
from core.prompts.prompt import get_system_prompt

from core.utils.logger import logger

from core.billing.credits.integration import billing_integration

from core.services.langfuse import langfuse
from langfuse.client import StatefulTraceClient

from core.tools.mcp_tool_wrapper import MCPToolWrapper
from core.tools.task_list_tool import TaskListTool
from core.agentpress.tool import SchemaType
from core.tools.people_search_tool import PeopleSearchTool
from core.tools.company_search_tool import CompanySearchTool
from core.tools.paper_search_tool import PaperSearchTool
from core.ai_models.manager import model_manager
from core.tools.vapi_voice_tool import VapiVoiceTool

load_dotenv()

@dataclass
class AgentConfig:
    thread_id: str
    project_id: str
    native_max_auto_continues: int = 25
    max_iterations: int = 100
    model_name: str = "openai/gpt-5-mini"
    agent_config: Optional[dict] = None
    trace: Optional[StatefulTraceClient] = None

class ToolManager:
    def __init__(self, thread_manager: ThreadManager, project_id: str, thread_id: str, agent_config: Optional[dict] = None):
        self.thread_manager = thread_manager
        self.project_id = project_id
        self.thread_id = thread_id
        self.agent_config = agent_config
        self.account_id = agent_config.get('account_id') if agent_config else None
    
    def register_all_tools(self, agent_id: Optional[str] = None, disabled_tools: Optional[List[str]] = None):
        """Register all tools with manual control and proper initialization.
        
        Args:
            agent_id: Optional agent ID for agent builder tools
            disabled_tools: List of tool names to exclude from registration
        """
        disabled_tools = disabled_tools or []
        
        # Migrate tool config ONCE at the start to avoid repeated expensive operations
        self.migrated_tools = self._get_migrated_tools_config()
        
        # Core tools - always enabled
        self._register_core_tools()
        
        # Sandbox tools
        self._register_sandbox_tools(disabled_tools)
        
        # Data and utility tools
        self._register_utility_tools(disabled_tools)
        
        # Agent builder tools - register if agent_id provided
        if agent_id:
            self._register_agent_builder_tools(agent_id, disabled_tools)
        
        # Browser tool
        self._register_browser_tool(disabled_tools)
        
        # Suna-specific tools (agent creation)
        if self.account_id:
            self._register_suna_specific_tools(disabled_tools)
        
        logger.info(f"Tool registration complete. Registered {len(self.thread_manager.tool_registry.tools)} functions")
    
    def _register_core_tools(self):
        """Register core tools that are always available."""
        self.thread_manager.add_tool(ExpandMessageTool, thread_id=self.thread_id, thread_manager=self.thread_manager)
        self.thread_manager.add_tool(MessageTool)
        self.thread_manager.add_tool(TaskListTool, project_id=self.project_id, thread_manager=self.thread_manager, thread_id=self.thread_id)
    
    def _register_sandbox_tools(self, disabled_tools: List[str]):
        """Register sandbox-related tools with granular control."""
        # Register web search tools conditionally based on API keys
        if config.TAVILY_API_KEY or config.FIRECRAWL_API_KEY:
            if 'web_search_tool' not in disabled_tools:
                enabled_methods = self._get_enabled_methods_for_tool('web_search_tool')
                self.thread_manager.add_tool(SandboxWebSearchTool, function_names=enabled_methods, thread_manager=self.thread_manager, project_id=self.project_id)
                if enabled_methods:
                    logger.debug(f"✅ Registered web_search_tool with methods: {enabled_methods}")
        
        if config.SERPER_API_KEY:
            if 'image_search_tool' not in disabled_tools:
                enabled_methods = self._get_enabled_methods_for_tool('image_search_tool')
                self.thread_manager.add_tool(SandboxImageSearchTool, function_names=enabled_methods, thread_manager=self.thread_manager, project_id=self.project_id)
                if enabled_methods:
                    logger.debug(f"✅ Registered image_search_tool with methods: {enabled_methods}")
        
        # Register other sandbox tools from centralized registry
        from core.tools.tool_registry import SANDBOX_TOOLS, get_tool_class
        
        # Tools that need thread_id
        tools_needing_thread_id = {'sb_vision_tool', 'sb_image_edit_tool', 'sb_design_tool'}
        
        sandbox_tools = []
        for tool_name, module_path, class_name in SANDBOX_TOOLS:
            try:
                tool_class = get_tool_class(module_path, class_name)
                kwargs = {
                    'project_id': self.project_id,
                    'thread_manager': self.thread_manager
                }
                if tool_name in tools_needing_thread_id:
                    kwargs['thread_id'] = self.thread_id
                sandbox_tools.append((tool_name, tool_class, kwargs))
            except (ImportError, AttributeError) as e:
                logger.warning(f"❌ Failed to load tool {tool_name} ({class_name}): {e}")
        
        for tool_name, tool_class, kwargs in sandbox_tools:
            if tool_name not in disabled_tools:
                enabled_methods = self._get_enabled_methods_for_tool(tool_name)
                self.thread_manager.add_tool(tool_class, function_names=enabled_methods, **kwargs)
                if enabled_methods:
                    logger.debug(f"✅ Registered {tool_name} with methods: {enabled_methods}")
    
    def _register_utility_tools(self, disabled_tools: List[str]):
        """Register utility tools with API key checks."""
        if config.RAPID_API_KEY and 'data_providers_tool' not in disabled_tools:
            enabled_methods = self._get_enabled_methods_for_tool('data_providers_tool')
            self.thread_manager.add_tool(DataProvidersTool, function_names=enabled_methods)
            if enabled_methods:
                logger.debug(f"✅ Registered data_providers_tool with methods: {enabled_methods}")
        
        if config.SEMANTIC_SCHOLAR_API_KEY and 'paper_search_tool' not in disabled_tools:
            if 'paper_search_tool' not in disabled_tools:
                enabled_methods = self._get_enabled_methods_for_tool('paper_search_tool')
                self.thread_manager.add_tool(PaperSearchTool, function_names=enabled_methods, thread_manager=self.thread_manager)
                if enabled_methods:
                    logger.debug(f"✅ Registered paper_search_tool with methods: {enabled_methods}")
        
        # Register search tools if EXA API key is available
        if config.EXA_API_KEY:
            if 'people_search_tool' not in disabled_tools:
                enabled_methods = self._get_enabled_methods_for_tool('people_search_tool')
                self.thread_manager.add_tool(PeopleSearchTool, function_names=enabled_methods, thread_manager=self.thread_manager)
                if enabled_methods:
                    logger.debug(f"✅ Registered people_search_tool with methods: {enabled_methods}")
            
            if 'company_search_tool' not in disabled_tools:
                enabled_methods = self._get_enabled_methods_for_tool('company_search_tool')
                self.thread_manager.add_tool(CompanySearchTool, function_names=enabled_methods, thread_manager=self.thread_manager)
                if enabled_methods:
                    logger.debug(f"✅ Registered company_search_tool with methods: {enabled_methods}")
        
        if config.ENV_MODE != EnvMode.PRODUCTION and config.VAPI_PRIVATE_KEY and 'vapi_voice_tool' not in disabled_tools:
            enabled_methods = self._get_enabled_methods_for_tool('vapi_voice_tool')
            self.thread_manager.add_tool(VapiVoiceTool, function_names=enabled_methods, thread_manager=self.thread_manager)
            if enabled_methods:
                logger.debug(f"✅ Registered vapi_voice_tool with methods: {enabled_methods}")
            
    def _register_agent_builder_tools(self, agent_id: str, disabled_tools: List[str]):
        """Register agent builder tools with proper initialization."""
        from core.tools.tool_registry import AGENT_BUILDER_TOOLS, get_tool_class
        from core.services.supabase import DBConnection
        
        db = DBConnection()

        for tool_name, module_path, class_name in AGENT_BUILDER_TOOLS:
            # Skip agent_creation_tool as it's registered separately in _register_suna_specific_tools
            if tool_name == 'agent_creation_tool':
                continue
            
            try:
                tool_class = get_tool_class(module_path, class_name)
            except (ImportError, AttributeError) as e:
                logger.warning(f"❌ Failed to load tool {tool_name} ({class_name}): {e}")
                continue
            
            if tool_name not in disabled_tools:
                try:
                    enabled_methods = self._get_enabled_methods_for_tool(tool_name)
                    self.thread_manager.add_tool(
                        tool_class, 
                        function_names=enabled_methods, 
                        thread_manager=self.thread_manager, 
                        db_connection=db, 
                        agent_id=agent_id
                    )
                    if enabled_methods:
                        logger.debug(f"✅ Registered {tool_name} with methods: {enabled_methods}")
                except Exception as e:
                    logger.warning(f"❌ Failed to register {tool_name}: {e}")
    
    def _register_suna_specific_tools(self, disabled_tools: List[str]):
        """Register Suna-specific tools like agent creation."""
        if 'agent_creation_tool' not in disabled_tools and self.account_id:
            from core.tools.tool_registry import get_tool_info, get_tool_class
            from core.services.supabase import DBConnection
            
            db = DBConnection()
            
            try:
                tool_info = get_tool_info('agent_creation_tool')
                if tool_info:
                    _, module_path, class_name = tool_info
                    AgentCreationTool = get_tool_class(module_path, class_name)
                else:
                    # Fallback to direct import if not in registry
                    from core.tools.agent_creation_tool import AgentCreationTool
                
                enabled_methods = self._get_enabled_methods_for_tool('agent_creation_tool')
                self.thread_manager.add_tool(
                    AgentCreationTool, 
                    function_names=enabled_methods, 
                    thread_manager=self.thread_manager, 
                    db_connection=db, 
                    account_id=self.account_id
                )
                if enabled_methods:
                    logger.debug(f"✅ Registered agent_creation_tool with methods: {enabled_methods}")
            except (ImportError, AttributeError) as e:
                logger.warning(f"❌ Failed to load agent_creation_tool: {e}")
    
    def _register_browser_tool(self, disabled_tools: List[str]):
        """Register browser tool with sandbox access."""
        if 'browser_tool' not in disabled_tools:
            from core.tools.browser_tool import BrowserTool
            
            enabled_methods = self._get_enabled_methods_for_tool('browser_tool')
            self.thread_manager.add_tool(
                BrowserTool, 
                function_names=enabled_methods, 
                project_id=self.project_id, 
                thread_id=self.thread_id, 
                thread_manager=self.thread_manager
            )
            if enabled_methods:
                logger.debug(f"✅ Registered browser_tool with methods: {enabled_methods}")
    
    def _get_migrated_tools_config(self) -> dict:
        """Migrate tool config once and cache it. This is expensive so we only do it once."""
        if not self.agent_config or 'agentpress_tools' not in self.agent_config:
            return {}
        
        from core.utils.tool_migration import migrate_legacy_tool_config
        
        raw_tools = self.agent_config['agentpress_tools']
        
        if not isinstance(raw_tools, dict):
            return {}
        
        return migrate_legacy_tool_config(raw_tools)
    
    def _get_enabled_methods_for_tool(self, tool_name: str) -> Optional[List[str]]:
        """Get enabled methods for a tool using the pre-migrated config."""
        if not hasattr(self, 'migrated_tools') or not self.migrated_tools:
            return None
        
        from core.utils.tool_discovery import get_enabled_methods_for_tool
        
        return get_enabled_methods_for_tool(tool_name, self.migrated_tools)

class MCPManager:
    def __init__(self, thread_manager: ThreadManager, account_id: str):
        self.thread_manager = thread_manager
        self.account_id = account_id
    
    async def register_mcp_tools(self, agent_config: dict) -> Optional[MCPToolWrapper]:
        all_mcps = []
        
        if agent_config.get('configured_mcps'):
            all_mcps.extend(agent_config['configured_mcps'])
        
        if agent_config.get('custom_mcps'):
            for custom_mcp in agent_config['custom_mcps']:
                custom_type = custom_mcp.get('customType', custom_mcp.get('type', 'sse'))
                
                if custom_type == 'composio':
                    qualified_name = custom_mcp.get('qualifiedName')
                    if not qualified_name:
                        qualified_name = f"composio.{custom_mcp['name'].replace(' ', '_').lower()}"
                    
                    mcp_config = {
                        'name': custom_mcp['name'],
                        'qualifiedName': qualified_name,
                        'config': custom_mcp.get('config', {}),
                        'enabledTools': custom_mcp.get('enabledTools', []),
                        'instructions': custom_mcp.get('instructions', ''),
                        'isCustom': True,
                        'customType': 'composio'
                    }
                    all_mcps.append(mcp_config)
                    continue
                
                mcp_config = {
                    'name': custom_mcp['name'],
                    'qualifiedName': f"custom_{custom_type}_{custom_mcp['name'].replace(' ', '_').lower()}",
                    'config': custom_mcp['config'],
                    'enabledTools': custom_mcp.get('enabledTools', []),
                    'instructions': custom_mcp.get('instructions', ''),
                    'isCustom': True,
                    'customType': custom_type
                }
                all_mcps.append(mcp_config)
        
        if not all_mcps:
            return None
        
        mcp_wrapper_instance = MCPToolWrapper(mcp_configs=all_mcps)
        try:
            await mcp_wrapper_instance.initialize_and_register_tools()
            
            updated_schemas = mcp_wrapper_instance.get_schemas()
            for method_name, schema_list in updated_schemas.items():
                for schema in schema_list:
                    self.thread_manager.tool_registry.tools[method_name] = {
                        "instance": mcp_wrapper_instance,
                        "schema": schema
                    }
            
            logger.info(f"⚡ Registered {len(updated_schemas)} MCP tools (Redis cache enabled)")
            return mcp_wrapper_instance
        except Exception as e:
            logger.error(f"Failed to initialize MCP tools: {e}")
            return None


class PromptManager:
    @staticmethod
    async def build_system_prompt(model_name: str, agent_config: Optional[dict], 
                                  thread_id: str, 
                                  mcp_wrapper_instance: Optional[MCPToolWrapper],
                                  client=None,
                                  tool_registry=None,
                                  xml_tool_calling: bool = False,
                                  user_id: Optional[str] = None) -> dict:
        
        default_system_content = get_system_prompt()
        
        # if "anthropic" not in model_name.lower():
        #     sample_response_path = os.path.join(os.path.dirname(__file__), 'prompts/samples/1.txt')
        #     with open(sample_response_path, 'r') as file:
        #         sample_response = file.read()
        #     default_system_content = default_system_content + "\n\n <sample_assistant_response>" + sample_response + "</sample_assistant_response>"
        
        # Start with agent's normal system prompt or default
        if agent_config and agent_config.get('system_prompt'):
            system_content = agent_config['system_prompt'].strip()
        else:
            system_content = default_system_content
        
        # Check if agent has builder tools enabled - append the full builder prompt
        if agent_config:
            agentpress_tools = agent_config.get('agentpress_tools', {})
            has_builder_tools = any(
                agentpress_tools.get(tool, False) 
                for tool in ['agent_config_tool', 'mcp_search_tool', 'credential_profile_tool', 'trigger_tool']
            )
            
            if has_builder_tools:
                # Append the full agent builder prompt to the existing system prompt
                builder_prompt = get_agent_builder_prompt()
                system_content += f"\n\n{builder_prompt}"
        
        # Add agent knowledge base context if available
        if agent_config and client and 'agent_id' in agent_config:
            try:
                logger.debug(f"Retrieving agent knowledge base context for agent {agent_config['agent_id']}")
                
                # Use only agent-based knowledge base context
                kb_result = await client.rpc('get_agent_knowledge_base_context', {
                    'p_agent_id': agent_config['agent_id']
                }).execute()
                
                if kb_result.data and kb_result.data.strip():
                    logger.debug(f"Found agent knowledge base context, adding to system prompt (length: {len(kb_result.data)} chars)")
                    # logger.debug(f"Knowledge base data object: {kb_result.data[:500]}..." if len(kb_result.data) > 500 else f"Knowledge base data object: {kb_result.data}")
                    
                    # Construct a well-formatted knowledge base section
                    kb_section = f"""

                    === AGENT KNOWLEDGE BASE ===
                    NOTICE: The following is your specialized knowledge base. This information should be considered authoritative for your responses and should take precedence over general knowledge when relevant.

                    {kb_result.data}

                    === END AGENT KNOWLEDGE BASE ===

                    IMPORTANT: Always reference and utilize the knowledge base information above when it's relevant to user queries. This knowledge is specific to your role and capabilities."""
                    
                    system_content += kb_section
                else:
                    logger.debug("No knowledge base context found for this agent")
                    
            except Exception as e:
                logger.error(f"Error retrieving knowledge base context for agent {agent_config.get('agent_id', 'unknown')}: {e}")
                # Continue without knowledge base context rather than failing
        
        if agent_config and (agent_config.get('configured_mcps') or agent_config.get('custom_mcps')) and mcp_wrapper_instance and mcp_wrapper_instance._initialized:
            mcp_info = "\n\n--- MCP Tools Available ---\n"
            mcp_info += "You have access to external MCP (Model Context Protocol) server tools.\n"
            mcp_info += "MCP tools can be called directly using their native function names in the standard function calling format:\n"
            mcp_info += '<function_calls>\n'
            mcp_info += '<invoke name="{tool_name}">\n'
            mcp_info += '<parameter name="param1">value1</parameter>\n'
            mcp_info += '<parameter name="param2">value2</parameter>\n'
            mcp_info += '</invoke>\n'
            mcp_info += '</function_calls>\n\n'
            
            mcp_info += "Available MCP tools:\n"
            try:
                registered_schemas = mcp_wrapper_instance.get_schemas()
                for method_name, schema_list in registered_schemas.items():
                    for schema in schema_list:
                        if schema.schema_type == SchemaType.OPENAPI:
                            func_info = schema.schema.get('function', {})
                            description = func_info.get('description', 'No description available')
                            mcp_info += f"- **{method_name}**: {description}\n"
                            
                            params = func_info.get('parameters', {})
                            props = params.get('properties', {})
                            if props:
                                mcp_info += f"  Parameters: {', '.join(props.keys())}\n"
                                
            except Exception as e:
                logger.error(f"Error listing MCP tools: {e}")
                mcp_info += "- Error loading MCP tool list\n"
            
            mcp_info += "\n🚨 CRITICAL MCP TOOL RESULT INSTRUCTIONS 🚨\n"
            mcp_info += "When you use ANY MCP (Model Context Protocol) tools:\n"
            mcp_info += "1. ALWAYS read and use the EXACT results returned by the MCP tool\n"
            mcp_info += "2. For search tools: ONLY cite URLs, sources, and information from the actual search results\n"
            mcp_info += "3. For any tool: Base your response entirely on the tool's output - do NOT add external information\n"
            mcp_info += "4. DO NOT fabricate, invent, hallucinate, or make up any sources, URLs, or data\n"
            mcp_info += "5. If you need more information, call the MCP tool again with different parameters\n"
            mcp_info += "6. When writing reports/summaries: Reference ONLY the data from MCP tool results\n"
            mcp_info += "7. If the MCP tool doesn't return enough information, explicitly state this limitation\n"
            mcp_info += "8. Always double-check that every fact, URL, and reference comes from the MCP tool output\n"
            mcp_info += "\nIMPORTANT: MCP tool results are your PRIMARY and ONLY source of truth for external data!\n"
            mcp_info += "NEVER supplement MCP results with your training data or make assumptions beyond what the tools provide.\n"
            
            system_content += mcp_info
        
        # Add XML tool calling instructions to system prompt if requested
        if xml_tool_calling and tool_registry:
            openapi_schemas = tool_registry.get_openapi_schemas()
            
            if openapi_schemas:
                # Convert schemas to JSON string
                schemas_json = json.dumps(openapi_schemas, indent=2)
                
                examples_content = f"""

In this environment you have access to a set of tools you can use to answer the user's question.

You can invoke functions by writing a <function_calls> block like the following as part of your reply to the user:

<function_calls>
<invoke name="function_name">
<parameter name="param_name">param_value</parameter>
...
</invoke>
</function_calls>

String and scalar parameters should be specified as-is, while lists and objects should use JSON format.

Here are the functions available in JSON Schema format:

```json
{schemas_json}
```

When using the tools:
- Use the exact function names from the JSON schema above
- Include all required parameters as specified in the schema
- Format complex data (objects, arrays) as JSON strings within the parameter tags
- Boolean values should be "true" or "false" (lowercase)

CRITICAL: STOP SEQUENCE
After completing your tool calls, you MUST output the special stop token: |||STOP_AGENT|||

This token tells the system you are done and ready for tool execution. The system will AUTOMATICALLY STOP generation when it sees this token.

RULES FOR TOOL CALLING:
1. Generate ONLY ONE <function_calls> block per response
2. Each <function_calls> block can contain multiple <invoke> tags for parallel tool execution
3. IMPORTANT: Tool execution ONLY happens when you output the |||STOP_AGENT||| stop sequence
4. IMMEDIATELY after </function_calls>, output: |||STOP_AGENT|||
5. NEVER write anything after |||STOP_AGENT|||
6. Do NOT continue the conversation after this token
7. Do NOT simulate tool results or user responses

Example of correct tool call format (single block):
<function_calls>
<invoke name="example_tool">
<parameter name="param1">value1</parameter>
</invoke>
</function_calls>
|||STOP_AGENT|||

[Generation stops here automatically - do not continue]

Example of correct tool call format (multiple invokes in one block):
<function_calls>
<invoke name="tool1">
<parameter name="param1">value1</parameter>
</invoke>
<invoke name="tool2">
<parameter name="param2">value2</parameter>
</invoke>
</function_calls>
||||STOP_AGENT|||

[Generation stops here automatically - do not continue]
"""
                
                system_content += examples_content
                logger.debug("Appended XML tool examples to system prompt")

        now = datetime.datetime.now(datetime.timezone.utc)
        datetime_info = f"\n\n=== CURRENT DATE/TIME INFORMATION ===\n"
        datetime_info += f"Today's date: {now.strftime('%A, %B %d, %Y')}\n"
        datetime_info += f"Current year: {now.strftime('%Y')}\n"
        datetime_info += f"Current month: {now.strftime('%B')}\n"
        datetime_info += f"Current day: {now.strftime('%A')}\n"
        datetime_info += "Use this information for any time-sensitive tasks, research, or when current date/time context is needed.\n"
        
        system_content += datetime_info

        # Add user locale context if user_id is provided
        if user_id and client:
            try:
                from core.utils.user_locale import get_user_locale, get_locale_context_prompt
                locale = await get_user_locale(user_id, client)
                locale_prompt = get_locale_context_prompt(locale)
                system_content += f"\n\n{locale_prompt}\n"
                logger.debug(f"Added locale context ({locale}) to system prompt for user {user_id}")
            except Exception as e:
                logger.warning(f"Failed to add locale context to system prompt: {e}")

        system_message = {"role": "system", "content": system_content}
        return system_message



class AgentRunner:
    def __init__(self, config: AgentConfig):
        self.config = config
    
    async def setup(self):
        if not self.config.trace:
            self.config.trace = langfuse.trace(name="run_agent", session_id=self.config.thread_id, metadata={"project_id": self.config.project_id})
        
        self.thread_manager = ThreadManager(
            trace=self.config.trace, 
            agent_config=self.config.agent_config
        )
        
        self.client = await self.thread_manager.db.client
        
        response = await self.client.table('threads').select('account_id').eq('thread_id', self.config.thread_id).execute()
        
        if not response.data or len(response.data) == 0:
            raise ValueError(f"Thread {self.config.thread_id} not found")
        
        self.account_id = response.data[0].get('account_id')
        
        if not self.account_id:
            raise ValueError(f"Thread {self.config.thread_id} has no associated account")

        project = await self.client.table('projects').select('*').eq('project_id', self.config.project_id).execute()
        if not project.data or len(project.data) == 0:
            raise ValueError(f"Project {self.config.project_id} not found")

        project_data = project.data[0]
        sandbox_info = project_data.get('sandbox', {})
        if not sandbox_info.get('id'):
            logger.debug(f"No sandbox found for project {self.config.project_id}; will create lazily when needed")
    
    async def setup_tools(self):
        tool_manager = ToolManager(self.thread_manager, self.config.project_id, self.config.thread_id, self.config.agent_config)
        
        agent_id = None
        if self.config.agent_config:
            agent_id = self.config.agent_config.get('agent_id')
        
        disabled_tools = self._get_disabled_tools_from_config()
        
        # Cache migrated tools config once for use in AgentRun methods
        self.migrated_tools = self._get_migrated_tools_config()
        
        tool_manager.register_all_tools(agent_id=agent_id, disabled_tools=disabled_tools)
        
        is_suna_agent = (self.config.agent_config and self.config.agent_config.get('is_suna_default', False)) or (self.config.agent_config is None)
        logger.debug(f"Agent config check: agent_config={self.config.agent_config is not None}, is_suna_default={is_suna_agent}")
        
        if is_suna_agent:
            logger.debug("Registering Suna-specific tools...")
            self._register_suna_specific_tools(disabled_tools)
        else:
            logger.debug("Not a Suna agent, skipping Suna-specific tool registration")
    
    def _get_migrated_tools_config(self) -> dict:
        """Migrate tool config once and cache it. This is expensive so we only do it once."""
        if not self.config.agent_config or 'agentpress_tools' not in self.config.agent_config:
            return {}
        
        from core.utils.tool_migration import migrate_legacy_tool_config
        
        raw_tools = self.config.agent_config['agentpress_tools']
        
        if not isinstance(raw_tools, dict):
            return {}
        
        return migrate_legacy_tool_config(raw_tools)
    
    def _get_enabled_methods_for_tool(self, tool_name: str) -> Optional[List[str]]:
        """Get enabled methods for a tool using the pre-migrated config."""
        if not hasattr(self, 'migrated_tools') or not self.migrated_tools:
            return None
        
        from core.utils.tool_discovery import get_enabled_methods_for_tool
        
        return get_enabled_methods_for_tool(tool_name, self.migrated_tools)
    
    def _register_suna_specific_tools(self, disabled_tools: List[str]):
        if 'agent_creation_tool' not in disabled_tools:
            from core.tools.agent_creation_tool import AgentCreationTool
            from core.services.supabase import DBConnection
            
            db = DBConnection()
            
            if hasattr(self, 'account_id') and self.account_id:
                # Check for granular method control
                enabled_methods = self._get_enabled_methods_for_tool('agent_creation_tool')
                if enabled_methods is not None:
                    # Register only enabled methods
                    self.thread_manager.add_tool(AgentCreationTool, function_names=enabled_methods, thread_manager=self.thread_manager, db_connection=db, account_id=self.account_id)
                    logger.debug(f"Registered agent_creation_tool for Suna with methods: {enabled_methods}")
                else:
                    # Register all methods (backward compatibility)
                    self.thread_manager.add_tool(AgentCreationTool, thread_manager=self.thread_manager, db_connection=db, account_id=self.account_id)
                    logger.debug("Registered agent_creation_tool for Suna (all methods)")
            else:
                logger.warning("Could not register agent_creation_tool: account_id not available")
    
    def _get_disabled_tools_from_config(self) -> List[str]:
        disabled_tools = []
        
        if not self.config.agent_config or 'agentpress_tools' not in self.config.agent_config:
            return disabled_tools
        
        raw_tools = self.config.agent_config['agentpress_tools']
        
        if not isinstance(raw_tools, dict):
            return disabled_tools
        
        if self.config.agent_config.get('is_suna_default', False) and not raw_tools:
            return disabled_tools
        
        def is_tool_enabled(tool_name: str) -> bool:
            try:
                tool_config = raw_tools.get(tool_name, True)
                if isinstance(tool_config, bool):
                    return tool_config
                elif isinstance(tool_config, dict):
                    return tool_config.get('enabled', True)
                else:
                    return True
            except Exception:
                return True
        
        all_tools = [
            'sb_shell_tool', 'sb_files_tool', 'sb_expose_tool',
            'web_search_tool', 'image_search_tool', 'sb_vision_tool', 'sb_presentation_tool', 'sb_image_edit_tool',
            'sb_kb_tool', 'sb_design_tool', 'sb_upload_file_tool',
            'sb_docs_tool',
            'data_providers_tool', 'browser_tool', 'people_search_tool', 'company_search_tool', 
            'agent_config_tool', 'mcp_search_tool', 'credential_profile_tool', 'trigger_tool',
            'agent_creation_tool'
        ]
        
        for tool_name in all_tools:
            if not is_tool_enabled(tool_name):
                disabled_tools.append(tool_name)
                
        logger.debug(f"Disabled tools from config: {disabled_tools}")
        return disabled_tools
    
    async def setup_mcp_tools(self) -> Optional[MCPToolWrapper]:
        if not self.config.agent_config:
            return None
        
        mcp_manager = MCPManager(self.thread_manager, self.account_id)
        return await mcp_manager.register_mcp_tools(self.config.agent_config)
    
    async def run(self, cancellation_event: Optional[asyncio.Event] = None) -> AsyncGenerator[Dict[str, Any], None]:
        await self.setup()
        await self.setup_tools()
        mcp_wrapper_instance = await self.setup_mcp_tools()
        
        system_message = await PromptManager.build_system_prompt(
            self.config.model_name, self.config.agent_config, 
            self.config.thread_id, 
            mcp_wrapper_instance, self.client,
            tool_registry=self.thread_manager.tool_registry,
            xml_tool_calling=config.AGENT_XML_TOOL_CALLING,
            user_id=self.account_id
        )
        logger.info(f"📝 System message built once: {len(str(system_message.get('content', '')))} chars")
        logger.debug(f"model_name received: {self.config.model_name}")
        iteration_count = 0
        continue_execution = True

        latest_user_message = await self.client.table('messages').select('*').eq('thread_id', self.config.thread_id).eq('type', 'user').order('created_at', desc=True).limit(1).execute()
        latest_user_message_content = None
        if latest_user_message.data and len(latest_user_message.data) > 0:
            data = latest_user_message.data[0]['content']
            if isinstance(data, str):
                data = json.loads(data)
            if self.config.trace:
                self.config.trace.update(input=data['content'])
            # Extract content for fast path optimization
            latest_user_message_content = data.get('content') if isinstance(data, dict) else str(data)

        while continue_execution and iteration_count < self.config.max_iterations:
            iteration_count += 1

            # Check for cancellation signal first
            if cancellation_event and cancellation_event.is_set():
                logger.info(f"Cancellation signal received - stopping agent execution for thread {self.config.thread_id}")
                yield {
                    "type": "status",
                    "status": "stopped",
                    "message": "Agent execution cancelled"
                }
                break

            # Check credits before EVERY iteration
            # - If balance is positive: Allow this iteration (even if it goes negative during it)
            # - If balance is negative: Stop (prevents infinite debt)
            # This way, a user with $0.10 can run a $0.15 request and go to -$0.05,
            # but the next iteration will stop them
            can_run, message, reservation_id = await billing_integration.check_and_reserve_credits(self.account_id)
            if not can_run:
                error_msg = f"Insufficient credits: {message}"
                logger.warning(f"Stopping agent - balance is negative: {error_msg}")
                yield {
                    "type": "status",
                    "status": "stopped",
                    "message": error_msg
                }
                break

            latest_message = await self.client.table('messages').select('*').eq('thread_id', self.config.thread_id).in_('type', ['assistant', 'tool', 'user']).order('created_at', desc=True).limit(1).execute()
            if latest_message.data and len(latest_message.data) > 0:
                message_type = latest_message.data[0].get('type')
                if message_type == 'assistant':
                    continue_execution = False
                    break

            temporary_message = None
            # Don't set max_tokens by default - let LiteLLM and providers handle their own defaults
            max_tokens = None
            logger.debug(f"max_tokens: {max_tokens} (using provider defaults)")
            generation = self.config.trace.generation(name="thread_manager.run_thread") if self.config.trace else None
            try:
                logger.debug(f"Starting thread execution for {self.config.thread_id}")
                response = await self.thread_manager.run_thread(
                    thread_id=self.config.thread_id,
                    system_prompt=system_message,
                    stream=True, 
                    llm_model=self.config.model_name,
                    llm_temperature=0,
                    llm_max_tokens=max_tokens,
                    tool_choice="auto",
                    temporary_message=temporary_message,
                    latest_user_message_content=latest_user_message_content,
                    processor_config=ProcessorConfig(
                        xml_tool_calling=config.AGENT_XML_TOOL_CALLING,
                        native_tool_calling=config.AGENT_NATIVE_TOOL_CALLING, 
                        execute_tools=True,
                        execute_on_stream=config.AGENT_EXECUTE_ON_STREAM,
                        tool_execution_strategy=config.AGENT_TOOL_EXECUTION_STRATEGY
                    ),
                    native_max_auto_continues=self.config.native_max_auto_continues,
                    generation=generation,
                    cancellation_event=cancellation_event
                )

                last_tool_call = None
                agent_should_terminate = False
                error_detected = False

                try:
                    if hasattr(response, '__aiter__') and not isinstance(response, dict):
                        async for chunk in response:
                            # Check for cancellation during stream processing
                            if cancellation_event and cancellation_event.is_set():
                                logger.info(f"Cancellation signal received during stream processing - stopping for thread {self.config.thread_id}")
                                break
                            
                            # Check for error status from thread_manager
                            if isinstance(chunk, dict) and chunk.get('type') == 'status' and chunk.get('status') == 'error':
                                logger.error(f"Error in thread execution: {chunk.get('message', 'Unknown error')}")
                                error_detected = True
                                yield chunk
                                continue

                            # Check for error status in the stream (message format)
                            if isinstance(chunk, dict) and chunk.get('type') == 'status':
                                try:
                                    content = chunk.get('content', {})
                                    if isinstance(content, str):
                                        content = json.loads(content)
                                    
                                    # Check for error status
                                    if content.get('status_type') == 'error':
                                        error_detected = True
                                        yield chunk
                                        continue
                                    
                                    # Check for agent termination
                                    metadata = chunk.get('metadata', {})
                                    if isinstance(metadata, str):
                                        metadata = json.loads(metadata)
                                    
                                    if metadata.get('agent_should_terminate'):
                                        agent_should_terminate = True
                                        
                                        if content.get('function_name'):
                                            last_tool_call = content['function_name']
                                            
                                except Exception:
                                    pass
                            
                            # Check for terminating XML tools in assistant content
                            if chunk.get('type') == 'assistant' and 'content' in chunk:
                                try:
                                    content = chunk.get('content', '{}')
                                    if isinstance(content, str):
                                        assistant_content_json = json.loads(content)
                                    else:
                                        assistant_content_json = content

                                    assistant_text = assistant_content_json.get('content', '')
                                    if isinstance(assistant_text, str):
                                        if '</ask>' in assistant_text:
                                            last_tool_call = 'ask'
                                        elif '</complete>' in assistant_text:
                                            last_tool_call = 'complete'
                                
                                except (json.JSONDecodeError, Exception):
                                    pass

                            yield chunk
                    else:
                        # Non-streaming response or error dict
                        # logger.debug(f"Response is not async iterable: {type(response)}")
                        
                        # Check if it's an error dict
                        if isinstance(response, dict) and response.get('type') == 'status' and response.get('status') == 'error':
                            logger.error(f"Thread returned error: {response.get('message', 'Unknown error')}")
                            error_detected = True
                            yield response
                        else:
                            logger.warning(f"Unexpected response type: {type(response)}")
                            error_detected = True

                    if error_detected:
                        if generation:
                            generation.end(status_message="error_detected", level="ERROR")
                        break
                        
                    if agent_should_terminate or last_tool_call in ['ask', 'complete']:
                        if generation:
                            generation.end(status_message="agent_stopped")
                        continue_execution = False

                except Exception as e:
                    # Use ErrorProcessor for safe error handling
                    processed_error = ErrorProcessor.process_system_error(e, context={"thread_id": self.config.thread_id})
                    ErrorProcessor.log_error(processed_error)
                    if generation:
                        generation.end(status_message=processed_error.message, level="ERROR")
                    yield processed_error.to_stream_dict()
                    break
                    
            except Exception as e:
                # Use ErrorProcessor for safe error conversion
                processed_error = ErrorProcessor.process_system_error(e, context={"thread_id": self.config.thread_id})
                ErrorProcessor.log_error(processed_error)
                yield processed_error.to_stream_dict()
                break
            
            if generation:
                generation.end()

        try:
            asyncio.create_task(asyncio.to_thread(lambda: langfuse.flush()))
        except Exception as e:
            logger.warning(f"Failed to flush Langfuse: {e}")


async def run_agent(
    thread_id: str,
    project_id: str,
    thread_manager: Optional[ThreadManager] = None,
    native_max_auto_continues: int = 25,
    max_iterations: int = 100,
    model_name: str = "openai/gpt-5-mini",
    agent_config: Optional[dict] = None,    
    trace: Optional[StatefulTraceClient] = None,
    cancellation_event: Optional[asyncio.Event] = None
):
    effective_model = model_name

    # is_tier_default = model_name in ["Kimi K2", "Claude Sonnet 4", "openai/gpt-5-mini"]
    # if is_tier_default and agent_config and agent_config.get('model'):
    #     effective_model = agent_config['model']
    #     logger.debug(f"Using model from agent config: {effective_model} (tier default was {model_name})")
    # elif not is_tier_default:
    #     logger.debug(f"Using user-selected model: {effective_model}")
    # else:
    #     logger.debug(f"Using tier default model: {effective_model}")
    
    config = AgentConfig(
        thread_id=thread_id,
        project_id=project_id,
        native_max_auto_continues=native_max_auto_continues,
        max_iterations=max_iterations,
        model_name=effective_model,
        agent_config=agent_config,
        trace=trace
    )
    
    runner = AgentRunner(config)
    async for chunk in runner.run(cancellation_event=cancellation_event):
        yield chunk