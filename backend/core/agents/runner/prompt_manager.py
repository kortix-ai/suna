import os
import json
import asyncio
import datetime
import time
from typing import Optional, Tuple, List
from core.tools.mcp_tool_wrapper import MCPToolWrapper
from core.agentpress.tool import SchemaType
from core.tools.tool_guide_registry import get_minimal_tool_index, get_minimal_tool_index_filtered, get_tool_guide
from core.utils.logger import logger

class PromptManager:
    @staticmethod
    async def build_system_prompt(model_name: str, agent_config: Optional[dict],
                                  thread_id: str,
                                  mcp_wrapper_instance: Optional[MCPToolWrapper],
                                  client=None,
                                  tool_registry=None,
                                  xml_tool_calling: bool = False,
                                  user_id: Optional[str] = None,
                                  mcp_loader=None,
                                  disabled_tools: Optional[List[str]] = None) -> Tuple[dict, Optional[dict]]:
        
        build_start = time.time()
        
        if agent_config and agent_config.get('system_prompt'):
            system_content = agent_config['system_prompt'].strip()
        else:
            from core.prompts.core_prompt import get_core_system_prompt
            system_content = get_core_system_prompt()

        # Filter disabled tools from core prompt (disabled_tools already fetched by caller)
        if disabled_tools:
            logger.info(f"🔒 [PROMPT] Filtering {len(disabled_tools)} disabled tools from prompt")
            system_content = PromptManager._filter_disabled_tools(system_content, disabled_tools)

        t1 = time.time()
        system_content = PromptManager._build_base_prompt(system_content, disabled_tools)
        logger.debug(f"⏱️ [PROMPT TIMING] _build_base_prompt: {(time.time() - t1) * 1000:.1f}ms")
        
        # Start parallel fetch tasks
        kb_task = PromptManager._with_timeout(PromptManager._fetch_knowledge_base(agent_config, client), 2.0, "KB fetch")
        user_context_task = PromptManager._with_timeout(PromptManager._fetch_user_context_data(user_id, client), 2.0, "User context")
        memory_task = PromptManager._fetch_user_memories(user_id, thread_id, client)
        file_task = PromptManager._fetch_file_context(thread_id)
        
        agent_id = agent_config.get('agent_id') if agent_config else None
        
        t_mcp = time.time()
        fresh_mcp_config = None
        if agent_config and (agent_config.get('custom_mcps') or agent_config.get('configured_mcps')):
            fresh_mcp_config = {
                'custom_mcp': agent_config.get('custom_mcps', []),
                'configured_mcps': agent_config.get('configured_mcps', []),
                'account_id': user_id
            }
            logger.debug(f"⏱️ [PROMPT TIMING] MCP config from agent_config (no re-fetch): 0.0ms")
        else:
            logger.debug(f"⏱️ [PROMPT TIMING] No MCP config in agent_config: 0.0ms")
        
        t3 = time.time()
        system_content = await PromptManager._append_mcp_tools_info(system_content, agent_config, mcp_wrapper_instance, fresh_mcp_config, xml_tool_calling)
        logger.debug(f"⏱️ [PROMPT TIMING] _append_mcp_tools_info: {(time.time() - t3) * 1000:.1f}ms")
        
        t4 = time.time()
        system_content = await PromptManager._append_jit_mcp_info(system_content, mcp_loader, fresh_mcp_config)
        logger.debug(f"⏱️ [PROMPT TIMING] _append_jit_mcp_info: {(time.time() - t4) * 1000:.1f}ms")
        
        system_content = PromptManager._append_xml_tool_calling_instructions(system_content, xml_tool_calling, tool_registry)
        system_content = PromptManager._append_datetime_info(system_content)
        
        t5 = time.time()
        kb_data, user_context_data, memory_data, file_data = await asyncio.gather(kb_task, user_context_task, memory_task, file_task)
        logger.debug(f"⏱️ [PROMPT TIMING] parallel fetches (kb/user_context/memory/file): {(time.time() - t5) * 1000:.1f}ms")
        
        logger.info(f"⏱️ [PROMPT TIMING] Total build_system_prompt: {(time.time() - build_start) * 1000:.1f}ms")
        
        if kb_data:
            system_content += kb_data
        
        if user_context_data:
            system_content += user_context_data

        # Add promotional messaging for free tier users using MiMo
        promo_content = await PromptManager._get_free_tier_promo(user_id)
        if promo_content:
            system_content += promo_content

        PromptManager._log_prompt_stats(system_content)
        
        system_message = {"role": "system", "content": system_content}
        
        context_parts = []
        if memory_data:
            context_parts.append(f"[CONTEXT - User Memory]\n{memory_data}\n[END CONTEXT]")
        if file_data:
            context_parts.append(f"[CONTEXT - Attached Files]\n{file_data}\n[END CONTEXT]")
        
        if context_parts:
            return system_message, {"role": "user", "content": "\n\n".join(context_parts)}
        
        return system_message, None
    
    @staticmethod
    async def _with_timeout(coro, timeout_s: float, label: str):
        try:
            return await asyncio.wait_for(coro, timeout_s)
        except asyncio.TimeoutError:
            logger.warning(f"[TIMEOUT] {label} timed out after {timeout_s}s")
            return None
        except Exception as e:
            logger.warning(f"[TIMEOUT] {label} failed: {e}")
            return None
    
    @staticmethod
    async def _fetch_mcp_config(agent_id: str, user_id: str) -> Optional[dict]:
        try:
            from core.versioning.version_service import get_version_service
            version_service = await get_version_service()
            return await version_service.get_current_mcp_config(agent_id, user_id)
        except Exception as e:
            logger.warning(f"Failed to fetch MCP config: {e}")
            return None
    
    @staticmethod
    def _filter_disabled_tools(content: str, disabled_tools: list) -> str:
        """Filter out lines mentioning disabled tools from content."""
        if not disabled_tools:
            return content
        lines = content.split('\n')
        filtered = []
        for line in lines:
            skip = False
            for tool in disabled_tools:
                if tool in line:
                    skip = True
                    break
            if not skip:
                filtered.append(line)
        return '\n'.join(filtered)

    @staticmethod
    def _build_base_prompt(system_content: str, disabled_tools: list = None) -> str:
        logger.info("🚀 [DYNAMIC TOOLS] Using dynamic tool loading system (minimal index only)")
        if disabled_tools:
            minimal_index = get_minimal_tool_index_filtered(disabled_tools)
            logger.info(f"🔒 [DYNAMIC TOOLS] Filtered out {len(disabled_tools)} disabled tools from index")
        else:
            minimal_index = get_minimal_tool_index()
        system_content += "\n\n" + minimal_index
        logger.info(f"📊 [DYNAMIC TOOLS] Core prompt + minimal index: {len(system_content):,} chars")
        
        preloaded_guides = PromptManager._get_preloaded_tool_guides()
        if preloaded_guides:
            system_content += preloaded_guides
            logger.info(f"📖 [DYNAMIC TOOLS] Added preloaded tool guides: {len(preloaded_guides):,} chars")
        
        return system_content
    
    @staticmethod
    def _get_preloaded_tool_guides() -> str:
        from core.jit.loader import JITLoader
        
        core_tools = JITLoader.get_core_tools()
        guides = []
        
        for tool_name in core_tools:
            guide = get_tool_guide(tool_name)
            if guide:
                guides.append(guide)
        
        if not guides:
            return ""
        
        guides_content = "\n\n# PRELOADED TOOL USAGE GUIDES\n"
        guides_content += "The following tools are preloaded and ready to use immediately (no initialize_tools needed):\n\n"
        guides_content += "\n\n".join(guides)
        
        logger.info(f"📖 [PRELOADED GUIDES] Loaded {len(guides)} guides for core tools")
        return guides_content
    
    @staticmethod
    def _append_agent_system_prompt(system_content: str, agent_config: Optional[dict]) -> str:
        if agent_config and agent_config.get('system_prompt'):
            return agent_config['system_prompt'].strip()
        return system_content
    
    @staticmethod
    async def _fetch_knowledge_base(agent_config: Optional[dict], client) -> Optional[str]:
        from core.utils.config import config
        
        if not config.ENABLE_KNOWLEDGE_BASE:
            logger.debug("Knowledge base fetch skipped: ENABLE_KNOWLEDGE_BASE=False")
            return None
            
        if not (agent_config and client and 'agent_id' in agent_config):
            return None
        
        agent_id = agent_config['agent_id']
        fetch_start = time.time()
        
        try:
            # Check cache first
            from core.cache.runtime_cache import get_cached_kb_context, set_cached_kb_context
            cached = await get_cached_kb_context(agent_id)
            if cached is not None:  # None = miss, empty string = no entries (cached)
                elapsed = (time.time() - fetch_start) * 1000
                logger.debug(f"⏱️ [TIMING] KB fetch: {elapsed:.1f}ms (cache: hit)")
                if cached:
                    kb_section = f"""

                === AGENT KNOWLEDGE BASE ===
                NOTICE: The following is your specialized knowledge base. This information should be considered authoritative for your responses and should take precedence over general knowledge when relevant.

                {cached}

                === END AGENT KNOWLEDGE BASE ===

                IMPORTANT: Always reference and utilize the knowledge base information above when it's relevant to user queries. This knowledge is specific to your role and capabilities."""
                    return kb_section
                return None
            
            # Quick EXISTS check before expensive RPC using direct SQL
            from core.threads import repo as threads_repo
            logger.debug(f"Checking if agent {agent_id} has knowledge base entries...")
            entry_count = await threads_repo.get_kb_entry_count(agent_id)
            
            if entry_count == 0:
                # Cache empty result to avoid future EXISTS checks
                await set_cached_kb_context(agent_id, "")
                elapsed = (time.time() - fetch_start) * 1000
                logger.debug(f"⏱️ [TIMING] KB fetch: {elapsed:.1f}ms (cache: miss, no entries)")
                return None
            
            # Only call RPC if entries exist (RPC still needed for complex aggregation)
            logger.debug(f"Retrieving agent knowledge base context for agent {agent_id}")
            kb_result = await client.rpc('get_agent_knowledge_base_context', {
                'p_agent_id': agent_id
            }).execute()
            
            kb_data = kb_result.data if kb_result and kb_result.data else None
            if kb_data and kb_data.strip():
                # Cache the result
                await set_cached_kb_context(agent_id, kb_data)
                elapsed = (time.time() - fetch_start) * 1000
                logger.debug(f"⏱️ [TIMING] KB fetch: {elapsed:.1f}ms (cache: miss, found {len(kb_data)} chars)")
                
                kb_section = f"""

                === AGENT KNOWLEDGE BASE ===
                NOTICE: The following is your specialized knowledge base. This information should be considered authoritative for your responses and should take precedence over general knowledge when relevant.

                {kb_data}

                === END AGENT KNOWLEDGE BASE ===

                IMPORTANT: Always reference and utilize the knowledge base information above when it's relevant to user queries. This knowledge is specific to your role and capabilities."""
                
                return kb_section
            else:
                # Cache empty result
                await set_cached_kb_context(agent_id, "")
                elapsed = (time.time() - fetch_start) * 1000
                logger.debug(f"⏱️ [TIMING] KB fetch: {elapsed:.1f}ms (cache: miss, no context)")
                return None
        except Exception as e:
            elapsed = (time.time() - fetch_start) * 1000
            logger.error(f"⏱️ [TIMING] KB fetch: {elapsed:.1f}ms (error: {e})")
            logger.error(f"Error retrieving knowledge base context for agent {agent_config.get('agent_id', 'unknown')}: {e}")
            return None
    
    @staticmethod
    async def _append_mcp_tools_info(system_content: str, agent_config: Optional[dict], mcp_wrapper_instance: Optional[MCPToolWrapper], 
                                     fresh_mcp_config: Optional[dict] = None, xml_tool_calling: bool = False) -> str:
        if fresh_mcp_config:
            logger.debug(f"🔄 [MCP PROMPT] Using fresh MCP config: {len(fresh_mcp_config.get('configured_mcps', []))} configured, {len(fresh_mcp_config.get('custom_mcp', []))} custom")
            agent_config = {
                'configured_mcps': fresh_mcp_config.get('configured_mcps', []),
                'custom_mcps': fresh_mcp_config.get('custom_mcp', [])
            }
        
        if not (agent_config and (agent_config.get('configured_mcps') or agent_config.get('custom_mcps')) and mcp_wrapper_instance and mcp_wrapper_instance._initialized):
            return system_content
        
        mcp_info = "\n\n<mcp_tools>\n"
        mcp_info += "You have access to external MCP (Model Context Protocol) server tools.\n\n"
        
        # Only add XML format instructions if xml_tool_calling is enabled
        # When native tool calling is enabled, the tools are available via the API and
        # adding XML instructions would confuse the model into producing hybrid output
        if xml_tool_calling:
            mcp_info += "MCP tools can be called directly using their native function names in the standard function calling format:\n"
            mcp_info += '<function_calls>\n'
            mcp_info += '<invoke name="{tool_name}">\n'
            mcp_info += '<parameter name="param1">value1</parameter>\n'
            mcp_info += '<parameter name="param2">value2</parameter>\n'
            mcp_info += '</invoke>\n'
            mcp_info += '</function_calls>\n\n'
        else:
            mcp_info += "MCP tools can be called directly using their native function names.\n\n"
        
        mcp_info += "<available_tools>\n"
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
        
        mcp_info += "</available_tools>\n\n"
        mcp_info += "<mcp_usage_rules>\n"
        mcp_info += "When using MCP tools:\n"
        mcp_info += "1. ALWAYS use the EXACT results returned by the MCP tool\n"
        mcp_info += "2. ONLY cite URLs, sources, and information from actual tool results\n"
        mcp_info += "3. Base responses entirely on tool output - do NOT add external information\n"
        mcp_info += "4. DO NOT fabricate, hallucinate, or make up any sources, URLs, or data\n"
        mcp_info += "5. If more information needed, call the tool again with different parameters\n"
        mcp_info += "6. If the tool doesn't return enough information, explicitly state this limitation\n"
        mcp_info += "7. MCP tool results are your PRIMARY source of truth for external data\n"
        mcp_info += "</mcp_usage_rules>\n"
        mcp_info += "</mcp_tools>"
        
        return system_content + mcp_info
    
    @staticmethod
    async def _append_jit_mcp_info(system_content: str, mcp_loader, fresh_mcp_config: Optional[dict] = None) -> str:
        toolkit_tools = {}
        
        if fresh_mcp_config:
            custom_mcps = fresh_mcp_config.get('custom_mcp', [])
            configured_mcps = fresh_mcp_config.get('configured_mcps', [])
            
            for mcp in custom_mcps:
                mcp_name = mcp.get('name', 'unknown')
                toolkit_slug = mcp.get('toolkit_slug', '')
                enabled_tools = mcp.get('enabledTools', [])
                mcp_type = mcp.get('type') or mcp.get('customType', '')
                
                if enabled_tools:
                    if mcp_type in ('sse', 'http', 'json'):
                        display_name = mcp_name.upper().replace(' ', '_')
                    else:
                        display_name = toolkit_slug.upper() if toolkit_slug else mcp_name.upper().replace(' ', '_')
                    
                    if display_name not in toolkit_tools:
                        toolkit_tools[display_name] = []
                    
                    for tool in enabled_tools:
                        if tool not in toolkit_tools[display_name]:
                            toolkit_tools[display_name].append(tool)
            
            for mcp in configured_mcps:
                mcp_name = mcp.get('name', 'unknown')
                toolkit_slug = mcp.get('toolkit_slug', '')
                enabled_tools = mcp.get('enabledTools', [])
                qualified_name = mcp.get('qualifiedName', '')
                
                if not toolkit_slug and qualified_name:
                    toolkit_slug = qualified_name.split('.')[-1]
                
                if enabled_tools:
                    display_name = toolkit_slug.upper() if toolkit_slug else mcp_name.upper().replace(' ', '_')
                    
                    if display_name not in toolkit_tools:
                        toolkit_tools[display_name] = []
                    
                    for tool in enabled_tools:
                        if tool not in toolkit_tools[display_name]:
                            toolkit_tools[display_name].append(tool)
            
        if not toolkit_tools:
            logger.debug("⚡ [MCP PROMPT] No toolkit tools found, skipping JIT MCP info")
            return system_content
        
        total_tools = sum(len(tools) for tools in toolkit_tools.values())
        
        mcp_jit_info = "\n\n<external_mcp_tools>\n"
        mcp_jit_info += f"You have {total_tools} external MCP tools from {len(toolkit_tools)} connected services.\n\n"
        mcp_jit_info += "<workflow>\n"
        mcp_jit_info += "TWO-STEP WORKFLOW: (1) discover_mcp_tools → (2) execute_mcp_tool\n"
        mcp_jit_info += "- DISCOVERY: discover_mcp_tools with filter=\"TOOL1,TOOL2,TOOL3\"\n"
        mcp_jit_info += "- EXECUTION: execute_mcp_tool with tool_name and args parameters\n"
        mcp_jit_info += "</workflow>\n\n"
        
        mcp_jit_info += "<available_services>\n"
        for toolkit, tools in toolkit_tools.items():
            display_name = toolkit.replace('_', ' ').title()
            mcp_jit_info += f"**{display_name}**: {', '.join(tools)}\n"
        mcp_jit_info += "</available_services>\n\n"
        
        mcp_jit_info += "<batch_discovery>\n"
        mcp_jit_info += "SMART DISCOVERY - Always batch multiple tool discoveries:\n\n"
        mcp_jit_info += "1. Check if tool schemas already in conversation → Skip to execution\n"
        mcp_jit_info += "2. If not in history → Discover ALL needed tools in ONE batch call\n\n"
        mcp_jit_info += "CORRECT: discover_mcp_tools(filter=\"TOOL1,TOOL2,TOOL3\") - ONE call for all\n"
        mcp_jit_info += "WRONG: Three separate discover calls - never do this!\n\n"
        mcp_jit_info += "After discovery, execute with: execute_mcp_tool(tool_name=\"TOOL1\", args={...})\n"
        mcp_jit_info += "</batch_discovery>\n\n"
        
        mcp_jit_info += "<critical_rules>\n"
        mcp_jit_info += "1. Analyze task → Identify ALL needed tools → Discover ALL in ONE call\n"
        mcp_jit_info += "2. NEVER discover one-by-one (always batch)\n"
        mcp_jit_info += "3. NEVER re-discover tools already in conversation history\n"
        mcp_jit_info += "4. Check history first - if schemas exist, skip to execute_mcp_tool\n"
        mcp_jit_info += "</critical_rules>\n"
        mcp_jit_info += "</external_mcp_tools>"
        
        logger.info(f"⚡ [MCP PROMPT] Appended MCP info ({len(mcp_jit_info)} chars) for {len(toolkit_tools)} toolkits, {total_tools} total tools")
        return system_content + mcp_jit_info
    
    @staticmethod
    def _append_xml_tool_calling_instructions(system_content: str, xml_tool_calling: bool, tool_registry) -> str:
        if not (xml_tool_calling and tool_registry):
            return system_content
        
        openapi_schemas = tool_registry.get_openapi_schemas()
        
        if not openapi_schemas:
            return system_content
        
        schemas_json = json.dumps(openapi_schemas, indent=2)
        
        examples_content = f"""

<xml_tool_calling>
In this environment you have access to a set of tools you can use to complete the user's request.

You can invoke functions by writing a <function_calls> block as part of your reply:

<function_calls>
<invoke name="function_name">
<parameter name="param_name">param_value</parameter>
</invoke>
</function_calls>

String and scalar parameters should be specified as-is, while lists and objects should use JSON format.

Here are the functions available in JSON Schema format:

```json
{schemas_json}
```

<tool_call_rules>
1. Follow the tool call schema exactly as specified
2. Provide ALL required parameters - never guess or use placeholders
3. Format complex data (objects, arrays) as JSON strings within parameter tags
4. Boolean values: "true" or "false" (lowercase strings)
5. If multiple independent tool calls are needed, include them ALL in ONE <function_calls> block for parallel execution
</tool_call_rules>

<maximize_parallel_calls>
When you need to perform multiple independent operations, invoke ALL relevant tools simultaneously rather than sequentially. This maximizes efficiency.

CORRECT - Parallel execution:
<function_calls>
<invoke name="read_file"><parameter name="file_path">file1.py</parameter></invoke>
<invoke name="read_file"><parameter name="file_path">file2.py</parameter></invoke>
<invoke name="read_file"><parameter name="file_path">file3.py</parameter></invoke>
</function_calls>

WRONG - Sequential (wasteful):
[calls read_file for file1]
[waits for result]
[calls read_file for file2]
[waits for result]
...
</maximize_parallel_calls>

<stop_sequence>
CRITICAL: After completing your tool calls, you MUST output the stop token: |||STOP_AGENT|||

This signals the system that you are ready for tool execution.

RULES:
1. Generate ONLY ONE <function_calls> block per response
2. IMMEDIATELY after </function_calls>, output: |||STOP_AGENT|||
3. NEVER write anything after |||STOP_AGENT|||
4. Do NOT continue the conversation or simulate results after this token
</stop_sequence>

<examples>
Single tool call:
<function_calls>
<invoke name="execute_command">
<parameter name="command">ls -la</parameter>
</invoke>
</function_calls>
|||STOP_AGENT|||

Multiple parallel tool calls:
<function_calls>
<invoke name="web_search">
<parameter name="query">["topic 1", "topic 2", "topic 3"]</parameter>
<parameter name="num_results">5</parameter>
</invoke>
<invoke name="read_file">
<parameter name="file_path">config.json</parameter>
</invoke>
</function_calls>
|||STOP_AGENT|||
</examples>
</xml_tool_calling>
"""
        
        logger.debug("Appended XML tool examples to system prompt")
        return system_content + examples_content
    
    @staticmethod
    def _append_datetime_info(system_content: str) -> str:
        now = datetime.datetime.now(datetime.timezone.utc)
        datetime_info = f"\n\n<current_datetime>\n"
        datetime_info += f"Today's date: {now.strftime('%A, %B %d, %Y')}\n"
        datetime_info += f"Current year: {now.strftime('%Y')}\n"
        datetime_info += f"Current month: {now.strftime('%B')}\n"
        datetime_info += f"Current day: {now.strftime('%A')}\n"
        datetime_info += f"Current time (UTC): {now.strftime('%H:%M:%S')}\n"
        datetime_info += "Use this for time-sensitive tasks, research, and when current date/time context is needed.\n"
        datetime_info += "</current_datetime>"
        
        return system_content + datetime_info
    
    @staticmethod
    async def _fetch_user_context_data(user_id: Optional[str], client) -> Optional[str]:
        if not (user_id and client):
            return None
        
        fetch_start = time.time()
        
        # Check cache first
        from core.cache.runtime_cache import get_cached_user_context, set_cached_user_context
        cached = await get_cached_user_context(user_id)
        if cached is not None:  # None = miss, empty string = no context (cached)
            elapsed = (time.time() - fetch_start) * 1000
            logger.debug(f"⏱️ [TIMING] User context: {elapsed:.1f}ms (cache: hit)")
            return cached if cached else None
        
        # Fetch locale and username in parallel
        async def fetch_locale():
            try:
                from core.utils.user_locale import get_user_locale
                return await get_user_locale(user_id, client)
            except Exception as e:
                logger.warning(f"Failed to fetch locale for user {user_id}: {e}")
                return None
        
        async def fetch_username():
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
        
        locale, username = await asyncio.gather(fetch_locale(), fetch_username())
        
        context_parts = []
        
        if locale:
            from core.utils.user_locale import get_locale_context_prompt
            locale_prompt = get_locale_context_prompt(locale)
            context_parts.append(f"\n\n{locale_prompt}\n")
            logger.debug(f"Added locale context ({locale}) to system prompt for user {user_id}")
        
        if username:
            username_info = f"\n\n<user_info>\n"
            username_info += f"The user's name is: {username}\n"
            username_info += "Use this to personalize responses and address the user appropriately.\n"
            username_info += "</user_info>"
            context_parts.append(username_info)
            logger.debug(f"Added username ({username}) to system prompt for user {user_id}")
        
        context = ''.join(context_parts) if context_parts else None
        context_str = context if context else ""
        
        # Cache the result (even if empty)
        await set_cached_user_context(user_id, context_str)
        elapsed = (time.time() - fetch_start) * 1000
        logger.debug(f"⏱️ [TIMING] User context: {elapsed:.1f}ms (cache: miss)")
        
        return context
    
    @staticmethod
    async def _fetch_user_memories(user_id: Optional[str], thread_id: str, client) -> Optional[str]:
        from core.utils.config import config
        if not config.ENABLE_MEMORY:
            logger.debug("Memory fetch skipped: ENABLE_MEMORY=False")
            return None
        
        if not (user_id and client):
            logger.debug(f"Memory fetch skipped: user_id={user_id}, client={'yes' if client else 'no'}")
            return None
        
        if not thread_id:
            logger.debug(f"Memory fetch skipped: no thread_id")
            return None
        
        try:
            from core.memory.retrieval_service import memory_retrieval_service
            from core.billing import subscription_service
            
            from core.threads import repo as threads_repo
            
            user_memory_enabled = await threads_repo.get_user_memory_enabled(user_id)
            if not user_memory_enabled:
                logger.debug(f"Memory fetch: disabled by user {user_id}")
                return None
            
            thread_memory_enabled = await threads_repo.get_thread_memory_enabled(thread_id)
            if not thread_memory_enabled:
                logger.debug(f"Memory fetch: disabled for thread {thread_id}")
                return None
            
            tier_info = await subscription_service.get_user_subscription_tier(user_id)
            tier_name = tier_info['name']
            logger.debug(f"Memory fetch: user {user_id}, tier {tier_name}")
            
            first_message_content = await threads_repo.get_first_user_message_content(thread_id)
            
            if not first_message_content:
                logger.debug(f"Memory fetch: no user messages in thread {thread_id}")
                return None
            
            # Parse JSON if needed
            if isinstance(first_message_content, str):
                import json as j
                try:
                    first_message_content = j.loads(first_message_content)
                except:
                    pass
            
            query_text = ''
            if isinstance(first_message_content, dict):
                query_text = first_message_content.get('content', str(first_message_content))
            else:
                query_text = str(first_message_content)
            
            if not query_text or len(query_text.strip()) < 10:
                logger.debug(f"Memory fetch: query too short ({len(query_text)} chars)")
                return None
            
            logger.debug(f"Memory fetch: querying with '{query_text[:50]}...'")
            
            memories = await memory_retrieval_service.retrieve_memories(
                account_id=user_id,
                query_text=query_text,
                tier_name=tier_name
            )
            
            if not memories:
                logger.debug(f"Memory fetch: no memories found for user {user_id}")
                return None
            
            formatted_memories = memory_retrieval_service.format_memories_for_prompt(memories)
            logger.info(f"Retrieved {len(memories)} memories for user {user_id} (will inject as context message)")
            return formatted_memories
        
        except Exception as e:
            logger.warning(f"Failed to fetch user memories for {user_id}: {e}")
            return None
    
    @staticmethod
    async def _fetch_file_context(thread_id: Optional[str]) -> Optional[str]:
        if not thread_id:
            return None
        
        try:
            from core.files import get_cached_file_context, format_file_context_for_agent
            
            files = await get_cached_file_context(thread_id)
            if files:
                formatted = format_file_context_for_agent(files)
                logger.info(f"Retrieved {len(files)} cached file(s) for thread {thread_id}")
                return formatted
        except Exception as e:
            logger.warning(f"Failed to fetch file context for {thread_id}: {e}")
        
        return None
    
    @staticmethod
    def _log_prompt_stats(system_content: str):
        final_prompt_size = len(system_content)
        estimated_legacy_size = final_prompt_size * 3.5
        reduction_pct = ((estimated_legacy_size - final_prompt_size) / estimated_legacy_size) * 100
        logger.info(f"✅ [DYNAMIC TOOLS] Final system prompt: {final_prompt_size:,} chars (est. {reduction_pct:.0f}% reduction vs legacy)")

    @staticmethod
    async def _get_free_tier_promo(user_id: Optional[str]) -> Optional[str]:
        """
        Returns promotional instructions for free tier users only.
        Returns None for paid users.
        """
        if not user_id:
            return None

        logger.info(f"✅ [PROMO] Injecting upgrade promo for user {user_id}")

        try:
            from core.billing.subscriptions.handlers.tier import TierHandler
            from core.utils.config import config, EnvMode

            # Skip tier check in local mode (for testing)
            if config.ENV_MODE == EnvMode.LOCAL:
                logger.debug(f"[PROMO] Local mode - showing promo for testing")
            else:
                tier_info = await TierHandler.get_user_subscription_tier(user_id)
                tier_name = tier_info.get('name', 'free')

                if tier_name not in ('free', 'none'):
                    logger.debug(f"[PROMO] User {user_id} is on {tier_name} tier - skipping promo")
                    return None

        except Exception as e:
            logger.warning(f"[PROMO] Failed to check tier for {user_id}: {e} - skipping promo (fail safe)")
            return None
        logger.info(f"✅ [PROMO] User {user_id} is on free tier - injecting upgrade promo")

        promo_content = """

<SYSTEM_CRITICAL_INSTRUCTION>
## PREMIUM FEATURES (Upgrade Required)

These features are NOT available on free plan:
- **Presentations/Slides** - Creating PPT, slideshows, decks
- **Spreadsheets** - Creating Excel, CSV, data tables
- **Canvas/Design** - Visual designs, graphics

When users ask for these, respond:
"Creating [presentations/spreadsheets/designs] is a premium feature. Upgrade to unlock it! Use code **KORTIX2026** for 30% off + 2X credits. <upgrade_cta/>"

## FOR ALL OTHER TASKS (code, writing, research, etc.)

Complete the task normally, then add this signature at the end:

---
🚀 Upgrade for [relevant benefit]. Code **KORTIX2026** = 30% off + 2X credits! <upgrade_cta/>

Examples:
- Code task → "🚀 Upgrade for faster debugging. Code **KORTIX2026** = 30% off + 2X credits! <upgrade_cta/>"
- Writing task → "🚀 Upgrade for better quality. Code **KORTIX2026** = 30% off + 2X credits! <upgrade_cta/>"
- Research → "🚀 Upgrade for deeper analysis. Code **KORTIX2026** = 30% off + 2X credits! <upgrade_cta/>"

❌ SKIP signature FOR: hi, hello, thanks, ok, bye

The <upgrade_cta/> tag shows the upgrade button. Without it = no button.

</SYSTEM_CRITICAL_INSTRUCTION>
"""
        return promo_content
