import os
import json
import asyncio
import time
from typing import Optional, Dict, List, Any, AsyncGenerator

from dotenv import load_dotenv
from core.utils.config import config
from core.agentpress.thread_manager import ThreadManager
from core.agentpress.response_processor import ProcessorConfig
from core.agentpress.error_processor import ErrorProcessor
from core.utils.logger import logger
from core.billing.credits.integration import billing_integration
from core.services.langfuse import langfuse
from core.tools.mcp_tool_wrapper import MCPToolWrapper

from core.run.config import AgentConfig
from core.run.tool_manager import ToolManager
from core.run.mcp_manager import MCPManager
from core.run.prompt_manager import PromptManager

load_dotenv()

class AgentRunner:
    def __init__(self, config: AgentConfig):
        self.config = config
        self.enrichment_complete = False
        self.enrichment_task = None
        self.cancellation_event = None
        self.turn_number = 0
        self.mcp_wrapper_instance = None
    
    async def setup_bootstrap(self):
        from core.utils.config import config
        setup_start = time.time()
        
        if self.cancellation_event and self.cancellation_event.is_set():
            raise asyncio.CancelledError("Cancelled before bootstrap")
        
        if not self.config.trace:
            self.config.trace = langfuse.trace(name="run_agent", session_id=self.config.thread_id, metadata={"project_id": self.config.project_id})
        
        from core.jit.config import JITConfig
        disabled_tools = []
        jit_config = JITConfig.from_run_context(
            agent_config=self.config.agent_config,
            disabled_tools=disabled_tools
        )
        
        self.thread_manager = ThreadManager(
            trace=self.config.trace,
            agent_config=self.config.agent_config,
            project_id=self.config.project_id,
            thread_id=self.config.thread_id,
            account_id=self.config.account_id,
            jit_config=jit_config
        )
        
        self.client = await self.thread_manager.db.client
        
        if not self.config.account_id:
            response = await self.client.table('threads').select('account_id').eq('thread_id', self.config.thread_id).maybe_single().execute()
            if not response.data:
                raise ValueError(f"Thread {self.config.thread_id} not found")
            self.account_id = response.data.get('account_id')
            if not self.account_id:
                raise ValueError(f"Thread {self.config.thread_id} has no associated account")
        else:
            self.account_id = self.config.account_id
        
        await self._initialize_mcp_jit_loader(cache_only=False)
        
        elapsed_ms = (time.time() - setup_start) * 1000
        
        if config.ENABLE_BOOTSTRAP_MODE:
            if elapsed_ms > config.BOOTSTRAP_SLO_CRITICAL_MS:
                logger.warning(f"⚠️ [SLO_WARNING] Bootstrap took {elapsed_ms:.1f}ms (limit: {config.BOOTSTRAP_SLO_CRITICAL_MS}ms) - MCP discovery may have been slow")
            elif elapsed_ms > config.BOOTSTRAP_SLO_WARNING_MS:
                logger.warning(f"⚠️ [SLO_VIOLATION] Bootstrap took {elapsed_ms:.1f}ms (target: ≤500ms, warning: {config.BOOTSTRAP_SLO_WARNING_MS}ms)")
                if self.config.trace:
                    self.config.trace.event(name="bootstrap_slow", metadata={"duration_ms": elapsed_ms})
            else:
                logger.info(f"✅ [BOOTSTRAP] Phase A: {elapsed_ms:.1f}ms (under SLO)")
        
        if config.ENABLE_BOOTSTRAP_MODE:
            self.enrichment_task = asyncio.create_task(self.setup_enrichment())
        
        logger.debug(f"⏱️ [TIMING] setup_bootstrap() total: {elapsed_ms:.1f}ms")
    
    async def setup_enrichment(self):
        enrichment_start = time.time()
        try:
            if self.cancellation_event and self.cancellation_event.is_set():
                logger.info("⚠️ [ENRICHMENT] Cancelled before starting")
                return
            
            from core.runtime_cache import get_cached_project_metadata, set_cached_project_metadata
            
            cached_project = await get_cached_project_metadata(self.config.project_id)
            if not cached_project:
                project = await self.client.table('projects').select('project_id, sandbox').eq('project_id', self.config.project_id).execute()
                if project.data:
                    await set_cached_project_metadata(self.config.project_id, project.data[0].get('sandbox', {}))
            
            if hasattr(self.thread_manager, 'mcp_loader') and self.thread_manager.mcp_loader:
                if len(self.thread_manager.mcp_loader.tool_map) == 0:
                    mcp_jit_start = time.time()
                    await self._initialize_mcp_jit_loader(cache_only=False)
                    logger.info(f"⏱️ [ENRICHMENT] MCP JIT retry discovery: {(time.time() - mcp_jit_start) * 1000:.1f}ms")
                else:
                    logger.debug(f"⚡ [ENRICHMENT] MCP JIT already has {len(self.thread_manager.mcp_loader.tool_map)} tools, skipping")
            
            if self.config.agent_config and (self.config.agent_config.get("custom_mcps") or self.config.agent_config.get("configured_mcps")):
                if not (hasattr(self.thread_manager, 'mcp_loader') and self.thread_manager.mcp_loader):
                    mcp_start = time.time()
                    logger.info("⚠️ [ENRICHMENT] Setting up legacy MCP in background")
                    self.mcp_wrapper_instance = await self.setup_mcp_tools()
                    logger.info(f"⏱️ [ENRICHMENT] MCP setup: {(time.time() - mcp_start) * 1000:.1f}ms")
            
            from core.jit.tool_cache import get_tool_cache
            tool_cache = get_tool_cache()
            if tool_cache.enabled:
                from core.jit.config import JITConfig
                disabled_tools = self._get_disabled_tools_from_config()
                jit_config = JITConfig.from_run_context(
                    agent_config=self.config.agent_config,
                    disabled_tools=disabled_tools
                )
                allowed_tools = list(jit_config.get_allowed_tools())
                cache_stats = await tool_cache.get_stats()
                if cache_stats.get('cached_tools', 0) < len(allowed_tools) // 2:
                    logger.info(f"🔥 [CACHE WARM] Warming cache for {len(allowed_tools)} tools...")
                    asyncio.create_task(tool_cache.warm_cache(allowed_tools))
            
            self.enrichment_complete = True
            elapsed = (time.time() - enrichment_start) * 1000
            logger.info(f"✅ [ENRICHMENT] Phase B complete in {elapsed:.1f}ms - full capabilities now available")
        
        except asyncio.CancelledError:
            logger.info("⚠️ [ENRICHMENT] Phase B cancelled (run stopped)")
            raise
        except Exception as e:
            logger.warning(f"⚠️ [ENRICHMENT] Phase B failed (non-fatal): {e}")
            self.enrichment_complete = False
    
    async def setup(self):
        setup_start = time.time()
        
        if not self.config.trace:
            self.config.trace = langfuse.trace(name="run_agent", session_id=self.config.thread_id, metadata={"project_id": self.config.project_id})
        
        tm_start = time.time()

        from core.jit.config import JITConfig
        from core.jit.tool_cache import get_tool_cache
        
        disabled_tools = self._get_disabled_tools_from_config()
        jit_config = JITConfig.from_run_context(
            agent_config=self.config.agent_config,
            disabled_tools=disabled_tools
        )
        
        tool_cache = get_tool_cache()
        if tool_cache.enabled:
            allowed_tools = list(jit_config.get_allowed_tools())
            cache_stats = await tool_cache.get_stats()
            if cache_stats.get('cached_tools', 0) < len(allowed_tools) // 2:
                logger.info(f"🔥 [CACHE WARM] Warming cache for {len(allowed_tools)} tools...")
                asyncio.create_task(tool_cache.warm_cache(allowed_tools))
        
        self.thread_manager = ThreadManager(
            trace=self.config.trace, 
            agent_config=self.config.agent_config,
            project_id=self.config.project_id,
            thread_id=self.config.thread_id,
            account_id=self.config.account_id,
            jit_config=jit_config
        )
        logger.debug(f"⏱️ [TIMING] ThreadManager init: {(time.time() - tm_start) * 1000:.1f}ms")

        await self._initialize_mcp_jit_loader()
        
        db_start = time.time()
        self.client = await self.thread_manager.db.client
        logger.debug(f"⏱️ [TIMING] DB client acquire: {(time.time() - db_start) * 1000:.1f}ms")
        
        if self.config.account_id:
            self.account_id = self.config.account_id
            
            q_start = time.time()
            from core.runtime_cache import get_cached_project_metadata, set_cached_project_metadata
            
            cached_project = await get_cached_project_metadata(self.config.project_id)
            if cached_project:
                project_data = cached_project
                logger.debug(f"⏱️ [TIMING] ⚡ Project from cache: {(time.time() - q_start) * 1000:.1f}ms")
            else:
                project = await self.client.table('projects').select('project_id, sandbox').eq('project_id', self.config.project_id).execute()
                
                if not project.data or len(project.data) == 0:
                    raise ValueError(f"Project {self.config.project_id} not found")
                
                project_data = project.data[0]
                
                await set_cached_project_metadata(self.config.project_id, project_data.get('sandbox', {}))
                logger.debug(f"⏱️ [TIMING] Project query + cache set: {(time.time() - q_start) * 1000:.1f}ms")
        else:
            parallel_start = time.time()
            
            from core.runtime_cache import get_cached_project_metadata, set_cached_project_metadata
            
            thread_query = self.client.table('threads').select('account_id').eq('thread_id', self.config.thread_id).execute()
            project_query = self.client.table('projects').select('project_id, sandbox').eq('project_id', self.config.project_id).execute()
            
            response, project = await asyncio.gather(thread_query, project_query)
            logger.debug(f"⏱️ [TIMING] Parallel DB queries (thread + project): {(time.time() - parallel_start) * 1000:.1f}ms")
            
            if not response.data or len(response.data) == 0:
                raise ValueError(f"Thread {self.config.thread_id} not found")
            
            self.account_id = response.data[0].get('account_id')
            
            if not self.account_id:
                raise ValueError(f"Thread {self.config.thread_id} has no associated account")
            
            if not project.data or len(project.data) == 0:
                raise ValueError(f"Project {self.config.project_id} not found")

            project_data = project.data[0]
            
            await set_cached_project_metadata(self.config.project_id, project_data.get('sandbox', {}))
        
        sandbox_info = project_data.get('sandbox', {})
        if not sandbox_info.get('id'):
            logger.debug(f"No sandbox found for project {self.config.project_id}; will create lazily when needed")
        
        logger.debug(f"⏱️ [TIMING] setup() total: {(time.time() - setup_start) * 1000:.1f}ms")
    
    def setup_tools(self):
        start = time.time()
        
        tool_manager = ToolManager(self.thread_manager, self.config.project_id, self.config.thread_id, self.config.agent_config)
        
        agent_id = None
        if self.config.agent_config:
            agent_id = self.config.agent_config.get('agent_id')
        
        disabled_tools = self._get_disabled_tools_from_config()
        
        migrate_start = time.time()
        self.migrated_tools = self._get_migrated_tools_config()
        logger.debug(f"⏱️ [TIMING] Tool config migration: {(time.time() - migrate_start) * 1000:.1f}ms")
        
        register_start = time.time()
        use_spark = True
        tool_manager.register_all_tools(agent_id=agent_id, disabled_tools=disabled_tools, use_spark=use_spark)
        logger.info(f"⏱️ [TIMING] register_all_tools() with SPARK={use_spark}: {(time.time() - register_start) * 1000:.1f}ms")
        
        is_suna_agent = (self.config.agent_config and self.config.agent_config.get('is_suna_default', False)) or (self.config.agent_config is None)
        logger.debug(f"Agent config check: agent_config={self.config.agent_config is not None}, is_suna_default={is_suna_agent}")
        
        if is_suna_agent:
            suna_start = time.time()
            logger.debug("Registering Suna-specific tools...")
            self._register_suna_specific_tools(disabled_tools)
            logger.debug(f"⏱️ [TIMING] Suna-specific tools: {(time.time() - suna_start) * 1000:.1f}ms")
        else:
            logger.debug("Not a Suna agent, skipping Suna-specific tool registration")
        
        logger.info(f"⏱️ [TIMING] setup_tools() total: {(time.time() - start) * 1000:.1f}ms")
    
    async def _setup_tools_async(self):
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, self.setup_tools)
    
    def _get_migrated_tools_config(self) -> dict:
        if not self.config.agent_config or 'agentpress_tools' not in self.config.agent_config:
            return {}
        
        from core.utils.tool_migration import migrate_legacy_tool_config
        
        raw_tools = self.config.agent_config['agentpress_tools']
        
        if not isinstance(raw_tools, dict):
            return {}
        
        return migrate_legacy_tool_config(raw_tools)
    
    def _get_enabled_methods_for_tool(self, tool_name: str) -> Optional[List[str]]:
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
                enabled_methods = self._get_enabled_methods_for_tool('agent_creation_tool')
                if enabled_methods is not None:
                    self.thread_manager.add_tool(AgentCreationTool, function_names=enabled_methods, thread_manager=self.thread_manager, db_connection=db, account_id=self.account_id)
                else:
                    self.thread_manager.add_tool(AgentCreationTool, thread_manager=self.thread_manager, db_connection=db, account_id=self.account_id)
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
    
    async def _load_mcp_config_from_version(self) -> dict | None:
        if not self.config.agent_config:
            return None
        
        agent_id = self.config.agent_config.get('agent_id')
        current_version_id = self.config.agent_config.get('current_version_id')
        
        if not agent_id or not current_version_id:
            logger.error(f"❌ [MCP JIT] Missing agent_id ({agent_id}) or version_id ({current_version_id})")
            return None
        
        try:
            from core.versioning.version_service import get_version_service
            version_service = await get_version_service()
            
            version = await version_service.get_version(
                agent_id=agent_id,
                version_id=current_version_id,
                user_id=self.account_id
            )
            
            if not version:
                logger.error(f"❌ [MCP JIT] Version {current_version_id} not found for agent {agent_id}")
                return None
            
            version_dict = version.to_dict()
            
            config = version_dict.get('config', {})
            tools = config.get('tools', {})
            
            mcp_config = {
                'custom_mcp': tools.get('custom_mcp', []),
                'configured_mcps': tools.get('mcp', [])
            }
            
            logger.error(f"✅ [MCP JIT] Loaded version config: custom_mcp={len(mcp_config['custom_mcp'])}, configured_mcps={len(mcp_config['configured_mcps'])}")
            return mcp_config
            
        except Exception as e:
            logger.error(f"❌ [MCP JIT] Failed to load version data: {e}", exc_info=True)
            return None
    
    async def run(self, cancellation_event: Optional[asyncio.Event] = None) -> AsyncGenerator[Dict[str, Any], None]:
        from core.utils.config import config
        run_start = time.time()
        self.cancellation_event = cancellation_event
        
        try:
            setup_start = time.time()
            if config.ENABLE_BOOTSTRAP_MODE:
                await self.setup_bootstrap()
                logger.info(f"⏱️ [TIMING] AgentRunner.setup_bootstrap() completed in {(time.time() - setup_start) * 1000:.1f}ms")
            else:
                await self.setup()
                logger.info(f"⏱️ [TIMING] AgentRunner.setup() completed in {(time.time() - setup_start) * 1000:.1f}ms")
            
            parallel_start = time.time()
            setup_tools_task = asyncio.create_task(self._setup_tools_async())
            await setup_tools_task
            
            if (hasattr(self.thread_manager, 'mcp_loader') and 
                self.config.agent_config and 
                (self.config.agent_config.get("custom_mcps") or self.config.agent_config.get("configured_mcps"))):
                logger.info("⚡ [MCP JIT] Using JIT MCP system, legacy MCP deferred to enrichment")
                self._clean_legacy_mcp_tools()
                mcp_wrapper_instance = None
            else:
                logger.info("⚠️ [MCP] No MCP configs, skipping")
                mcp_wrapper_instance = None
            
            tools_elapsed = (time.time() - parallel_start) * 1000
            logger.info(f"⏱️ [TIMING] Tool setup: {tools_elapsed:.1f}ms (MCP deferred to enrichment)")
            
            prompt_start = time.time()
            
            logger.debug(f"⚡ [PROMPT_CHECK] ENABLE_MINIMAL={config.ENABLE_MINIMAL_PROMPT}, ENABLE_BOOTSTRAP={config.ENABLE_BOOTSTRAP_MODE}, enrichment_complete={self.enrichment_complete}")
            
            if config.ENABLE_MINIMAL_PROMPT and config.ENABLE_BOOTSTRAP_MODE and not self.enrichment_complete:
                system_message = await PromptManager.build_minimal_prompt(
                    self.config.agent_config,
                    tool_registry=self.thread_manager.tool_registry,
                    mcp_loader=getattr(self.thread_manager, 'mcp_loader', None)
                )
                logger.info(f"⏱️ [TIMING] build_minimal_prompt() in {(time.time() - prompt_start) * 1000:.1f}ms ({len(str(system_message.get('content', '')))} chars) [BOOTSTRAP MODE]")
            else:
                if self.enrichment_complete:
                    logger.info("⚡ [PROMPT] Using FULL prompt (enrichment complete)")
                else:
                    logger.warning(f"⚠️ [PROMPT] Using FULL prompt despite incomplete enrichment (flags: minimal={config.ENABLE_MINIMAL_PROMPT}, bootstrap={config.ENABLE_BOOTSTRAP_MODE})")
                system_message = await PromptManager.build_system_prompt(
                    self.config.model_name, self.config.agent_config, 
                    self.config.thread_id, 
                    getattr(self, 'mcp_wrapper_instance', None), self.client,
                    tool_registry=self.thread_manager.tool_registry,
                    xml_tool_calling=config.AGENT_XML_TOOL_CALLING,
                    user_id=self.account_id,
                    mcp_loader=getattr(self.thread_manager, 'mcp_loader', None)
                )
                logger.info(f"⏱️ [TIMING] build_system_prompt() in {(time.time() - prompt_start) * 1000:.1f}ms ({len(str(system_message.get('content', '')))} chars)")
            
            logger.debug(f"model_name received: {self.config.model_name}")
            iteration_count = 0
            continue_execution = True

            latest_user_message_content = None
            
            total_setup = (time.time() - run_start) * 1000
            logger.info(f"⏱️ [TIMING] 🚀 TOTAL AgentRunner setup: {total_setup:.1f}ms (ready for first LLM call) [Message query deferred]")

            while continue_execution and iteration_count < self.config.max_iterations:
                self.turn_number += 1
                iteration_count += 1
                
                if self.turn_number > 1 and config.ENABLE_MINIMAL_PROMPT and not self.enrichment_complete:
                    logger.debug(f"⏱️ Turn {self.turn_number}: Enrichment still pending, continuing with current prompt")
                elif self.turn_number > 1 and config.ENABLE_MINIMAL_PROMPT and self.enrichment_complete:
                    logger.info(f"⏱️ Turn {self.turn_number}: Enrichment complete, upgrading to full prompt")
                    prompt_upgrade_start = time.time()
                    system_message = await PromptManager.build_system_prompt(
                        self.config.model_name, self.config.agent_config, 
                        self.config.thread_id, 
                        mcp_wrapper_instance, self.client,
                        tool_registry=self.thread_manager.tool_registry,
                        xml_tool_calling=config.AGENT_XML_TOOL_CALLING,
                        user_id=self.account_id,
                        mcp_loader=getattr(self.thread_manager, 'mcp_loader', None)
                    )
                    logger.info(f"⏱️ [TIMING] Upgraded to full prompt in {(time.time() - prompt_upgrade_start) * 1000:.1f}ms ({len(str(system_message.get('content', '')))} chars)")
                    self.thread_manager._system_prompt = system_message

                if cancellation_event and cancellation_event.is_set():
                    logger.info(f"Cancellation signal received - stopping agent execution for thread {self.config.thread_id}")
                    yield {
                        "type": "status",
                        "status": "stopped",
                        "message": "Agent execution cancelled"
                    }
                    break

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

                latest_message = await self.client.table('messages').select('type').eq('thread_id', self.config.thread_id).in_('type', ['assistant', 'tool', 'user']).order('created_at', desc=True).limit(1).execute()
                if latest_message.data and len(latest_message.data) > 0:
                    message_type = latest_message.data[0].get('type')
                    if message_type == 'assistant':
                        continue_execution = False
                        break

                temporary_message = None
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
                                if cancellation_event and cancellation_event.is_set():
                                    logger.info(f"Cancellation signal received during stream processing - stopping for thread {self.config.thread_id}")
                                    break
                                
                                if isinstance(chunk, dict) and chunk.get('type') == 'status' and chunk.get('status') == 'error':
                                    logger.error(f"Error in thread execution: {chunk.get('message', 'Unknown error')}")
                                    error_detected = True
                                    yield chunk
                                    continue

                                if isinstance(chunk, dict) and chunk.get('type') == 'status':
                                    try:
                                        content = chunk.get('content', {})
                                        if isinstance(content, str):
                                            content = json.loads(content)
                                        
                                        if content.get('status_type') == 'error':
                                            error_detected = True
                                            yield chunk
                                            continue
                                        
                                        metadata = chunk.get('metadata', {})
                                        if isinstance(metadata, str):
                                            metadata = json.loads(metadata)
                                        
                                        if metadata.get('agent_should_terminate'):
                                            agent_should_terminate = True
                                            
                                            if content.get('function_name'):
                                                last_tool_call = content['function_name']
                                                
                                    except Exception:
                                        pass
                                
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
                        processed_error = ErrorProcessor.process_system_error(e, context={"thread_id": self.config.thread_id})
                        ErrorProcessor.log_error(processed_error)
                        if generation:
                            generation.end(status_message=processed_error.message, level="ERROR")
                        yield processed_error.to_stream_dict()
                        break
                        
                except Exception as e:
                    processed_error = ErrorProcessor.process_system_error(e, context={"thread_id": self.config.thread_id})
                    ErrorProcessor.log_error(processed_error)
                    yield processed_error.to_stream_dict()
                    break
                
                if generation:
                    generation.end()

        finally:
            if self.enrichment_task and not self.enrichment_task.done():
                logger.info("⚠️ [ENRICHMENT] Cancelling Phase B (run ending)")
                self.enrichment_task.cancel()
                try:
                    await self.enrichment_task
                except asyncio.CancelledError:
                    pass
                except Exception as e:
                    logger.warning(f"Error during enrichment cancellation: {e}")
            
            try:
                if hasattr(self, 'thread_manager') and self.thread_manager:
                    await self.thread_manager.cleanup()
            except Exception as e:
                logger.warning(f"Failed to cleanup ThreadManager: {e}")

            try:
                asyncio.create_task(asyncio.to_thread(lambda: langfuse.flush()))
            except Exception as e:
                logger.warning(f"Failed to flush Langfuse: {e}")
    
    async def _initialize_mcp_jit_loader(self, cache_only: bool = False) -> None:
        if not self.config.agent_config:
            return
        
        custom_mcps = self.config.agent_config.get("custom_mcps", [])
        configured_mcps = self.config.agent_config.get("configured_mcps", [])
        
        logger.debug(f"⚡ [MCP JIT] Loading MCPs: {len(custom_mcps)} custom, {len(configured_mcps)} configured")
        for i, mcp in enumerate(custom_mcps):
            logger.debug(f"⚡ [MCP JIT] Custom MCP {i}: name={mcp.get('name')}, toolkit_slug={mcp.get('toolkit_slug')}, type={mcp.get('type')}")
        
        if custom_mcps or configured_mcps:
            try:
                from core.jit.mcp_loader import MCPJITLoader
                
                mcp_config = {
                    'custom_mcp': custom_mcps,
                    'configured_mcps': configured_mcps,
                    'account_id': self.config.account_id or self.config.agent_config.get('account_id')
                }
                
                if not hasattr(self.thread_manager, 'mcp_loader') or self.thread_manager.mcp_loader is None:
                    self.thread_manager.mcp_loader = MCPJITLoader(mcp_config)
                
                await self.thread_manager.mcp_loader.build_tool_map(cache_only=cache_only)
                
                stats = self.thread_manager.mcp_loader.get_activation_stats()
                toolkits = await self.thread_manager.mcp_loader.get_toolkits()
                
                mode_str = "cache-only" if cache_only else "full discovery"
                logger.info(f"⚡ [MCP JIT] Initialized: {stats['total_tools']} tools from {len(toolkits)} toolkits ({mode_str})")
                
                if not cache_only:
                    from core.jit.mcp_registry import warm_cache_for_agent_toolkits
                    asyncio.create_task(warm_cache_for_agent_toolkits(mcp_config))
                
            except Exception as e:
                logger.error(f"❌ [MCP JIT] Initialization failed: {e}")
                if not hasattr(self.thread_manager, 'mcp_loader'):
                    self.thread_manager.mcp_loader = None
    
    def _clean_legacy_mcp_tools(self) -> None:
        tools_before = len(self.thread_manager.tool_registry.tools)
        
        for tool_name in list(self.thread_manager.tool_registry.tools.keys()):
            tool_info = self.thread_manager.tool_registry.tools[tool_name]
            instance = tool_info.get('instance')
            
            should_remove = (
                (hasattr(instance, '__class__') and 'MCPToolWrapper' in instance.__class__.__name__) or
                len(tool_name) > 64
            )
            
            if should_remove:
                del self.thread_manager.tool_registry.tools[tool_name]
        
        tools_after = len(self.thread_manager.tool_registry.tools)
        removed_count = tools_before - tools_after
        
        if removed_count > 0:
            logger.info(f"⚡ [MCP JIT] Registry cleaned: {tools_before} → {tools_after} tools ({removed_count} legacy tools removed)")

