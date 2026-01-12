import os
import json
import asyncio
import datetime
import time
from typing import Optional, Tuple
from core.tools.mcp_tool_wrapper import MCPToolWrapper
from core.agentpress.tool import SchemaType
from core.tools.tool_guide_registry import get_minimal_tool_index, get_tool_guide
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
                                  mcp_loader=None) -> Tuple[dict, Optional[dict]]:
        
        build_start = time.time()
        
        if agent_config and agent_config.get('system_prompt'):
            system_content = agent_config['system_prompt'].strip()
        else:
            from core.prompts.core_prompt import get_core_system_prompt
            system_content = get_core_system_prompt()
        
        t1 = time.time()
        system_content = PromptManager._build_base_prompt(system_content)
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
        system_content = await PromptManager._append_mcp_tools_info(system_content, agent_config, mcp_wrapper_instance, fresh_mcp_config)
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
    def _build_base_prompt(system_content: str) -> str:
        logger.info("🚀 [DYNAMIC TOOLS] Using dynamic tool loading system (minimal index only)")
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
                                     fresh_mcp_config: Optional[dict] = None) -> str:
        if fresh_mcp_config:
            logger.debug(f"🔄 [MCP PROMPT] Using fresh MCP config: {len(fresh_mcp_config.get('configured_mcps', []))} configured, {len(fresh_mcp_config.get('custom_mcp', []))} custom")
            agent_config = {
                'configured_mcps': fresh_mcp_config.get('configured_mcps', []),
                'custom_mcps': fresh_mcp_config.get('custom_mcp', [])
            }
        
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
        
        mcp_jit_info = "\n\n--- EXTERNAL MCP TOOLS ---\n"
        mcp_jit_info += f"🔥 You have {total_tools} external MCP tools from {len(toolkit_tools)} connected services.\n"
        mcp_jit_info += "⚡ TWO-STEP WORKFLOW: (1) discover_mcp_tools → (2) execute_mcp_tool\n"
        mcp_jit_info += "🎯 DISCOVERY: use discover_mcp_tools with filter parameter \"TOOL1,TOOL2,TOOL3\"\n"
        mcp_jit_info += "🎯 EXECUTION: use execute_mcp_tool with tool_name parameter and args parameter\n\n"
        
        for toolkit, tools in toolkit_tools.items():
            display_name = toolkit.replace('_', ' ').title()
            mcp_jit_info += f"**{display_name} Functions**: {', '.join(tools)}\n"
        
        mcp_jit_info += "\n🎯 **SMART BATCH DISCOVERY:**\n\n"
        mcp_jit_info += "**STEP 1: Check conversation history**\n"
        mcp_jit_info += "- Are the tool schemas already in this conversation? → Skip to execution!\n"
        mcp_jit_info += "- Not in history? → Discover ALL needed tools in ONE batch call\n\n"
        mcp_jit_info += "**✅ CORRECT - Batch Discovery:**\n"
        mcp_jit_info += "use discover_mcp_tools with filter parameter \"NOTION_CREATE_PAGE,NOTION_APPEND_BLOCK,NOTION_SEARCH\"\n"
        mcp_jit_info += "→ Returns: All 3 schemas in ONE call\n"
        mcp_jit_info += "→ Schemas cached in conversation forever\n"
        mcp_jit_info += "→ NEVER discover these tools again!\n\n"
        mcp_jit_info += "**❌ WRONG - Multiple Discoveries:**\n"
        mcp_jit_info += "Never call discover 3 times for 3 tools - batch them!\n\n"
        mcp_jit_info += "**STEP 2: Execute tools with schemas:**\n"
        mcp_jit_info += "use execute_mcp_tool with tool_name \"NOTION_CREATE_PAGE\" and args parameter\n"
        mcp_jit_info += "use execute_mcp_tool with tool_name \"NOTION_APPEND_BLOCK\" and args parameter\n\n"
        mcp_jit_info += "⛔ **CRITICAL RULES**:\n"
        mcp_jit_info += "1. Analyze task → Identify ALL tools → Discover ALL in ONE call\n"
        mcp_jit_info += "2. NEVER discover one-by-one (always batch!)\n"
        mcp_jit_info += "3. NEVER re-discover tools already in conversation history\n"
        mcp_jit_info += "4. Check history first - if schemas exist, skip directly to execute_mcp_tool!\n\n"
        
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
            username_info = f"\n\n=== USER INFORMATION ===\n"
            username_info += f"The user's name is: {username}\n"
            username_info += "Use this information to personalize your responses and address the user appropriately.\n"
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
