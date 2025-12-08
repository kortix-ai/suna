import os
import json
import asyncio
import datetime
from typing import Optional
from core.tools.mcp_tool_wrapper import MCPToolWrapper
from core.agentpress.tool import SchemaType
from core.prompts.agent_builder_prompt import get_agent_builder_prompt
from core.prompts.prompt import get_system_prompt
from core.prompts.core_prompt import get_dynamic_system_prompt
from core.tools.tool_guide_registry import get_minimal_tool_index
from core.utils.logger import logger

class PromptManager:
    @staticmethod
    async def build_minimal_prompt(agent_config: Optional[dict], tool_registry=None, mcp_loader=None) -> dict:
        import datetime
        
        if agent_config and agent_config.get('system_prompt'):
            content = agent_config['system_prompt'].strip()
        else:
            from core.prompts.core_prompt import get_core_system_prompt
            content = get_core_system_prompt()
        
        now = datetime.datetime.now(datetime.timezone.utc)
        content += f"\n\n=== CURRENT DATE/TIME ===\n"
        content += f"Today's date: {now.strftime('%A, %B %d, %Y')}\n"
        content += f"Current time: {now.strftime('%H:%M UTC')}\n"
        
        content += """

⚠️ BOOTSTRAP MODE - FAST START:
You are currently in fast-start mode. Core capabilities are ready NOW:
✅ Available immediately: files, shell, web_search, git operations
⏳ Loading shortly: advanced tools (browser, presentations, image editing), knowledge base, user context

If you need specialized tools, they will become available during execution.
If relevant context seems missing, ask a clarifying question.

"""
        
        content = await PromptManager._append_jit_mcp_info(content, mcp_loader)
        
        return {"role": "system", "content": content}
    
    @staticmethod
    async def build_system_prompt(model_name: str, agent_config: Optional[dict], 
                                  thread_id: str, 
                                  mcp_wrapper_instance: Optional[MCPToolWrapper],
                                  client=None,
                                  tool_registry=None,
                                  xml_tool_calling: bool = False,
                                  user_id: Optional[str] = None,
                                  use_dynamic_tools: bool = True,
                                  mcp_loader=None) -> dict:
        
        system_content = PromptManager._build_base_prompt(use_dynamic_tools)
        system_content = PromptManager._append_agent_system_prompt(system_content, agent_config, use_dynamic_tools)
        system_content = await PromptManager._append_builder_tools_prompt(system_content, agent_config)
        
        kb_task = PromptManager._fetch_knowledge_base(agent_config, client)
        user_context_task = PromptManager._fetch_user_context_data(user_id, client)
        
        system_content = PromptManager._append_mcp_tools_info(system_content, agent_config, mcp_wrapper_instance)
        system_content = await PromptManager._append_jit_mcp_info(system_content, mcp_loader)
        system_content = PromptManager._append_xml_tool_calling_instructions(system_content, xml_tool_calling, tool_registry)
        system_content = PromptManager._append_datetime_info(system_content)
        
        kb_data, user_context_data = await asyncio.gather(kb_task, user_context_task)
        
        if kb_data:
            system_content += kb_data
        
        if user_context_data:
            system_content += user_context_data
        
        PromptManager._log_prompt_stats(system_content, use_dynamic_tools)
        
        return {"role": "system", "content": system_content}
    
    @staticmethod
    def _build_base_prompt(use_dynamic_tools: bool) -> str:
        if use_dynamic_tools:
            logger.info("🚀 [DYNAMIC TOOLS] Using dynamic tool loading system (minimal index only)")
            minimal_index = get_minimal_tool_index()
            default_system_content = get_dynamic_system_prompt(minimal_index)
            logger.info(f"📊 [DYNAMIC TOOLS] Core prompt + minimal index: {len(default_system_content):,} chars")
        else:
            logger.info("⚠️  [LEGACY MODE] Using full embedded prompt (all tool documentation included)")
            default_system_content = get_system_prompt()
            logger.info(f"📊 [LEGACY MODE] Full prompt size: {len(default_system_content):,} chars")
        
        return default_system_content
    
    @staticmethod
    def _append_agent_system_prompt(system_content: str, agent_config: Optional[dict], use_dynamic_tools: bool) -> str:
        if agent_config and agent_config.get('system_prompt'):
            return agent_config['system_prompt'].strip()
        return system_content
    
    @staticmethod
    async def _append_builder_tools_prompt(system_content: str, agent_config: Optional[dict]) -> str:
        if not agent_config:
            return system_content
        
        agentpress_tools = agent_config.get('agentpress_tools', {})
        has_builder_tools = any(
            agentpress_tools.get(tool, False) 
            for tool in ['agent_config_tool', 'mcp_search_tool', 'credential_profile_tool', 'trigger_tool']
        )
        
        if has_builder_tools:
            builder_prompt = get_agent_builder_prompt()
            system_content += f"\n\n{builder_prompt}"
        
        return system_content
    
    @staticmethod
    async def _fetch_knowledge_base(agent_config: Optional[dict], client) -> Optional[str]:
        if not (agent_config and client and 'agent_id' in agent_config):
            return None
        
        try:
            logger.debug(f"Retrieving agent knowledge base context for agent {agent_config['agent_id']}")
            kb_result = await client.rpc('get_agent_knowledge_base_context', {
                'p_agent_id': agent_config['agent_id']
            }).execute()
            
            if kb_result and kb_result.data and kb_result.data.strip():
                logger.debug(f"Found agent knowledge base context, adding to system prompt (length: {len(kb_result.data)} chars)")
                
                kb_section = f"""

                === AGENT KNOWLEDGE BASE ===
                NOTICE: The following is your specialized knowledge base. This information should be considered authoritative for your responses and should take precedence over general knowledge when relevant.

                {kb_result.data}

                === END AGENT KNOWLEDGE BASE ===

                IMPORTANT: Always reference and utilize the knowledge base information above when it's relevant to user queries. This knowledge is specific to your role and capabilities."""
                
                return kb_section
            else:
                logger.debug("No knowledge base context found for this agent")
                return None
        except Exception as e:
            logger.error(f"Error retrieving knowledge base context for agent {agent_config.get('agent_id', 'unknown')}: {e}")
            return None
    
    @staticmethod
    async def _append_knowledge_base(system_content: str, agent_config: Optional[dict], client) -> str:
        kb_data = await PromptManager._fetch_knowledge_base(agent_config, client)
        if kb_data:
            system_content += kb_data
        return system_content
    
    @staticmethod
    def _append_mcp_tools_info(system_content: str, agent_config: Optional[dict], mcp_wrapper_instance: Optional[MCPToolWrapper]) -> str:
        if not (agent_config and (agent_config.get('configured_mcps') or agent_config.get('custom_mcps')) and mcp_wrapper_instance and mcp_wrapper_instance._initialized):
            return system_content
        
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
        
        return system_content + mcp_info
    
    @staticmethod
    async def _append_jit_mcp_info(system_content: str, mcp_loader) -> str:
        if not mcp_loader:
            return system_content
        
        try:
            available_tools = await mcp_loader.get_available_tools()
            toolkits = await mcp_loader.get_toolkits()
            
            if not available_tools:
                return system_content
            
            mcp_jit_info = "\n\n--- EXTERNAL MCP TOOLS ---\n"
            mcp_jit_info += f"🔥 You have {len(available_tools)} external MCP tools from {len(toolkits)} connected services.\n"
            mcp_jit_info += "⚡ TWO-STEP WORKFLOW: (1) discover_mcp_tools() → (2) execute_mcp_tool()\n"
            mcp_jit_info += "🎯 DISCOVERY: discover_mcp_tools(filter=\"TOOL1,TOOL2,TOOL3\")\n"
            mcp_jit_info += "🎯 EXECUTION: execute_mcp_tool(tool_name=\"TOOL_NAME\", args={...})\n\n"
            
            toolkit_tools = {}
            for tool_name in available_tools:
                tool_info = await mcp_loader.get_tool_info(tool_name)
                if tool_info:
                    toolkit = tool_info.toolkit_slug.upper()
                    if toolkit not in toolkit_tools:
                        toolkit_tools[toolkit] = []

                    api_name = tool_name
                    if not api_name.startswith(toolkit + '_'):
                        api_name = f"{toolkit}_{tool_name.upper()}"
                    toolkit_tools[toolkit].append(api_name)
            
            for toolkit, tools in toolkit_tools.items():
                if toolkit == "TWITTER":
                    mcp_jit_info += f"**Twitter Functions**: {', '.join(tools)}\n"
                elif toolkit == "GOOGLESHEETS":
                    mcp_jit_info += f"**Google Sheets Functions**: {', '.join(tools)}\n"
                else:
                    mcp_jit_info += f"**{toolkit} Functions**: {', '.join(tools)}\n"
            
            mcp_jit_info += "\n🎯 **SMART BATCH DISCOVERY:**\n\n"
            mcp_jit_info += "**STEP 1: Check conversation history**\n"
            mcp_jit_info += "- Are the tool schemas already in this conversation? → Skip to execution!\n"
            mcp_jit_info += "- Not in history? → Discover ALL needed tools in ONE batch call\n\n"
            mcp_jit_info += "**✅ CORRECT - Batch Discovery:**\n"
            mcp_jit_info += "`discover_mcp_tools(filter=\"NOTION_CREATE_PAGE,NOTION_APPEND_BLOCK,NOTION_SEARCH\")`\n"
            mcp_jit_info += "→ Returns: All 3 schemas in ONE call\n"
            mcp_jit_info += "→ Schemas cached in conversation forever\n"
            mcp_jit_info += "→ NEVER discover these tools again!\n\n"
            mcp_jit_info += "**❌ WRONG - Multiple Discoveries:**\n"
            mcp_jit_info += "Never call discover 3 times for 3 tools - batch them!\n\n"
            mcp_jit_info += "**STEP 2: Execute tools with schemas:**\n"
            mcp_jit_info += "`execute_mcp_tool(tool_name=\"NOTION_CREATE_PAGE\", args={\"title\": \"My Page\", ...})`\n"
            mcp_jit_info += "`execute_mcp_tool(tool_name=\"NOTION_APPEND_BLOCK\", args={\"page_id\": \"...\", ...})`\n\n"
            mcp_jit_info += "⛔ **CRITICAL RULES**:\n"
            mcp_jit_info += "1. Analyze task → Identify ALL tools → Discover ALL in ONE call\n"
            mcp_jit_info += "2. NEVER discover one-by-one (always batch!)\n"
            mcp_jit_info += "3. NEVER re-discover tools already in conversation history\n"
            mcp_jit_info += "4. Check history first - if schemas exist, skip directly to execute_mcp_tool!\n\n"
            
            return system_content + mcp_jit_info
        except Exception as e:
            logger.warning(f"⚠️  [MCP JIT] Failed to load dynamic tools for prompt: {e}")
            return system_content
    
    @staticmethod
    def _append_xml_tool_calling_instructions(system_content: str, xml_tool_calling: bool, tool_registry) -> str:
        if not (xml_tool_calling and tool_registry):
            return system_content
        
        openapi_schemas = tool_registry.get_openapi_schemas()
        
        if not openapi_schemas:
            return system_content
        
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
|||STOP_AGENT|||

[Generation stops here automatically - do not continue]
"""
        
        logger.debug("Appended XML tool examples to system prompt")
        return system_content + examples_content
    
    @staticmethod
    def _append_datetime_info(system_content: str) -> str:
        now = datetime.datetime.now(datetime.timezone.utc)
        datetime_info = f"\n\n=== CURRENT DATE/TIME INFORMATION ===\n"
        datetime_info += f"Today's date: {now.strftime('%A, %B %d, %Y')}\n"
        datetime_info += f"Current year: {now.strftime('%Y')}\n"
        datetime_info += f"Current month: {now.strftime('%B')}\n"
        datetime_info += f"Current day: {now.strftime('%A')}\n"
        datetime_info += "Use this information for any time-sensitive tasks, research, or when current date/time context is needed.\n"
        
        return system_content + datetime_info
    
    @staticmethod
    async def _fetch_user_context_data(user_id: Optional[str], client) -> Optional[str]:
        if not (user_id and client):
            return None
        
        locale_task = PromptManager._fetch_user_locale(user_id, client)
        username_task = PromptManager._fetch_username(user_id, client)
        
        locale, username = await asyncio.gather(locale_task, username_task)
        
        context_parts = []
        
        if locale:
            from core.utils.user_locale import get_locale_context_prompt
            locale_prompt = get_locale_context_prompt(locale)
            context_parts.append(f"\n\n{locale_prompt}\n")
            logger.debug(f"Added locale context ({locale}) to system prompt for user {user_id}")
        
        if username:
            username_info = f"\n\n=== USER INFORMATION ===\n"
            username_info += f"The user's name is: {username}\n"
            username_info += "Use this information to personalize your responses and address the user appropriately.\n"
            context_parts.append(username_info)
            logger.debug(f"Added username ({username}) to system prompt for user {user_id}")
        
        return ''.join(context_parts) if context_parts else None
    
    @staticmethod
    async def _append_user_context(system_content: str, user_id: Optional[str], client) -> str:
        user_context_data = await PromptManager._fetch_user_context_data(user_id, client)
        if user_context_data:
            system_content += user_context_data
        return system_content
    
    @staticmethod
    async def _fetch_user_locale(user_id: str, client):
        try:
            from core.utils.user_locale import get_user_locale
            return await get_user_locale(user_id, client)
        except Exception as e:
            logger.warning(f"Failed to fetch locale for user {user_id}: {e}")
            return None
    
    @staticmethod
    async def _fetch_username(user_id: str, client):
        try:
            user = await client.auth.admin.get_user_by_id(user_id)
            if user and user.user:
                user_metadata = user.user.user_metadata or {}
                email = user.user.email
                
                username = (
                    user_metadata.get('full_name') or
                    user_metadata.get('name') or
                    user_metadata.get('display_name') or
                    (email.split('@')[0] if email else None)
                )
                return username
            return None
        except Exception as e:
            logger.warning(f"Failed to fetch username for user {user_id}: {e}")
            return None
    
    @staticmethod
    def _log_prompt_stats(system_content: str, use_dynamic_tools: bool):
        final_prompt_size = len(system_content)
        if use_dynamic_tools:
            estimated_legacy_size = final_prompt_size * 3.5
            reduction_pct = ((estimated_legacy_size - final_prompt_size) / estimated_legacy_size) * 100
            logger.info(f"✅ [DYNAMIC TOOLS] Final system prompt: {final_prompt_size:,} chars (est. {reduction_pct:.0f}% reduction vs legacy)")
        else:
            logger.info(f"📝 [LEGACY MODE] Final system prompt: {final_prompt_size:,} chars")
