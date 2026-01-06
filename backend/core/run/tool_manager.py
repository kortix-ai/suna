import time
from typing import Optional, List
from core.tools.message_tool import MessageTool
from core.tools.web_search_tool import SandboxWebSearchTool
from core.tools.image_search_tool import SandboxImageSearchTool
from core.tools.expand_msg_tool import ExpandMessageTool
from core.tools.task_list_tool import TaskListTool
from core.tools.sub_agent_tool import SubAgentTool
from core.tools.people_search_tool import PeopleSearchTool
from core.tools.company_search_tool import CompanySearchTool
from core.tools.paper_search_tool import PaperSearchTool
from core.tools.vapi_voice_tool import VapiVoiceTool
from core.agentpress.thread_manager import ThreadManager
from core.utils.config import config, EnvMode
from core.utils.logger import logger


# Orchestrator mode detection
ORCHESTRATOR_MODELS = ['kortix/power', 'kortix-power', 'Kortix Power', 'Kortix Advanced Mode']


class ToolManager:
    def __init__(self, thread_manager: ThreadManager, project_id: str, thread_id: str, 
                 agent_config: Optional[dict] = None, model_name: Optional[str] = None,
                 thread_depth: int = 0):
        self.thread_manager = thread_manager
        self.project_id = project_id
        self.thread_id = thread_id
        self.agent_config = agent_config
        self.account_id = agent_config.get('account_id') if agent_config else None
        self.model_name = model_name
        self.thread_depth = thread_depth
        
        # Determine if this is orchestrator mode
        # Orchestrator: kortix/power (advanced) at depth 0 (main thread)
        # Workers: sub-agents (depth > 0) or kortix/basic
        self.is_orchestrator = self._is_orchestrator_mode()
        self.is_sub_agent = thread_depth > 0
        
        if self.is_orchestrator:
            logger.info(f"🎯 [ORCHESTRATOR MODE] Main thread running as orchestrator (model={model_name}, depth={thread_depth})")
        elif self.is_sub_agent:
            logger.info(f"⚙️ [WORKER MODE] Sub-agent running as worker (model={model_name}, depth={thread_depth})")
        else:
            logger.info(f"🔧 [STANDARD MODE] Running with full tools (model={model_name}, depth={thread_depth})")
    
    def _is_orchestrator_mode(self) -> bool:
        """Check if this agent should run in orchestrator mode.
        
        Orchestrator mode is enabled when:
        - Model is kortix/power (advanced mode)
        - Thread is at depth 0 (main thread, not a sub-agent)
        """
        if self.thread_depth > 0:
            # Sub-agents are never orchestrators
            return False
        
        if not self.model_name:
            return False
        
        # Check if model matches any orchestrator model
        model_lower = self.model_name.lower()
        for orch_model in ORCHESTRATOR_MODELS:
            if orch_model.lower() in model_lower or model_lower in orch_model.lower():
                return True
        
        return False
    
    def register_all_tools(self, agent_id: Optional[str] = None, disabled_tools: Optional[List[str]] = None, use_spark: bool = True):
        start = time.time()
        timings = {}
        
        disabled_tools = disabled_tools or []
        
        t = time.time()
        self.migrated_tools = self._get_migrated_tools_config()
        timings['migrate_config'] = (time.time() - t) * 1000
        
        # ORCHESTRATOR MODE: Only register orchestration tools
        if self.is_orchestrator:
            logger.info("🎯 [ORCHESTRATOR] Registering ORCHESTRATION TOOLS ONLY")
            t = time.time()
            self._register_orchestrator_tools()
            timings['orchestrator_tools'] = (time.time() - t) * 1000
            
            total = (time.time() - start) * 1000
            logger.info(f"🎯 [ORCHESTRATOR] Tool registration complete in {total:.1f}ms")
            logger.info(f"🎯 [ORCHESTRATOR] {len(self.thread_manager.tool_registry.tools)} orchestration functions registered")
            return
        
        # SUB-AGENT MODE: Register all tools EXCEPT SubAgentTool (no nested spawning)
        if self.is_sub_agent:
            # Add SubAgentTool to disabled list for sub-agents
            if 'sub_agent_tool' not in disabled_tools:
                disabled_tools = list(disabled_tools) + ['sub_agent_tool']
            logger.info("⚙️ [WORKER] Registering worker tools (no sub-agent spawning)")
        
        if use_spark:
            logger.info("⚡ [SPARK] Registering CORE TOOLS ONLY (JIT loading enabled)")
            t = time.time()
            self._register_core_tools(disabled_tools)
            timings['core_tools'] = (time.time() - t) * 1000
            
            total = (time.time() - start) * 1000
            logger.info(f"⚡ [SPARK] Core tool registration complete in {total:.1f}ms")
            logger.info(f"⚡ [SPARK] {len(self.thread_manager.tool_registry.tools)} core functions registered")
            logger.info(f"⚡ [JIT] Other tools will be activated on-demand via initialize_tools()")
        else:
            logger.info("⚠️  [LEGACY] Registering ALL TOOLS at startup")
            
            t = time.time()
            self._register_core_tools(disabled_tools)
            timings['core_tools'] = (time.time() - t) * 1000
            
            t = time.time()
            self._register_sandbox_tools(disabled_tools)
            timings['sandbox_tools'] = (time.time() - t) * 1000
            
            t = time.time()
            self._register_utility_tools(disabled_tools)
            timings['utility_tools'] = (time.time() - t) * 1000
            
            if agent_id:
                t = time.time()
                self._register_agent_builder_tools(agent_id, disabled_tools)
                timings['agent_builder_tools'] = (time.time() - t) * 1000
            
            if self.account_id:
                t = time.time()
                self._register_suna_specific_tools(disabled_tools)
                timings['suna_tools'] = (time.time() - t) * 1000
            
            total = (time.time() - start) * 1000
            timing_str = " | ".join([f"{k}: {v:.1f}ms" for k, v in timings.items()])
            logger.info(f"⏱️ [TIMING] Tool registration breakdown: {timing_str}")
            logger.info(f"⚠️  [LEGACY] Tool registration complete. {len(self.thread_manager.tool_registry.tools)} functions in {total:.1f}ms")
    
    def _register_orchestrator_tools(self):
        """Register only orchestration tools for advanced/power mode at depth 0.
        
        Orchestrators ONLY have:
        - MessageTool (ask, complete)
        - SubAgentTool (spawn_sub_agent, wait_for_sub_agents, etc.)
        - ExpandMessageTool (for tool initialization if needed)
        - TaskListTool (for planning - though sub-agents are the tasks)
        
        They do NOT have any work-doing tools (web_search, file creation, etc.)
        """
        from core.jit.loader import JITLoader
        from core.tools.tool_registry import get_tool_info, get_tool_class
        
        # Core orchestration tools
        self.thread_manager.add_tool(MessageTool)
        self.thread_manager.add_tool(SubAgentTool, project_id=self.project_id, thread_manager=self.thread_manager, thread_id=self.thread_id)
        
        # Minimal support tools
        self.thread_manager.add_tool(ExpandMessageTool, thread_id=self.thread_id, thread_manager=self.thread_manager)
        
        # File reader only (read-only access to see what sub-agents created)
        tool_info = get_tool_info('sb_file_reader_tool')
        if tool_info:
            _, module_path, class_name = tool_info
            try:
                tool_class = get_tool_class(module_path, class_name)
                self.thread_manager.add_tool(
                    tool_class, 
                    project_id=self.project_id, 
                    thread_manager=self.thread_manager
                )
            except (ImportError, AttributeError) as e:
                logger.warning(f"❌ Failed to load sb_file_reader_tool: {e}")
        
        logger.info("🎯 [ORCHESTRATOR] Registered: MessageTool, SubAgentTool, ExpandMessageTool, sb_file_reader_tool")
    
    def _register_core_tools(self, disabled_tools: Optional[List[str]] = None):
        disabled_tools = disabled_tools or []
        from core.jit.loader import JITLoader
        from core.tools.tool_registry import get_tool_info, get_tool_class
        
        self.thread_manager.add_tool(ExpandMessageTool, thread_id=self.thread_id, thread_manager=self.thread_manager)
        self.thread_manager.add_tool(MessageTool)
        self.thread_manager.add_tool(TaskListTool, project_id=self.project_id, thread_manager=self.thread_manager, thread_id=self.thread_id)
        
        # Only register SubAgentTool if not disabled (sub-agents can't spawn sub-agents)
        if 'sub_agent_tool' not in disabled_tools:
            self.thread_manager.add_tool(SubAgentTool, project_id=self.project_id, thread_manager=self.thread_manager, thread_id=self.thread_id)
        
        if config.TAVILY_API_KEY or config.FIRECRAWL_API_KEY:
            enabled_methods = self._get_enabled_methods_for_tool('web_search_tool')
            self.thread_manager.add_tool(SandboxWebSearchTool, function_names=enabled_methods, thread_manager=self.thread_manager, project_id=self.project_id)
        
        if config.SERPER_API_KEY:
            enabled_methods = self._get_enabled_methods_for_tool('image_search_tool')
            self.thread_manager.add_tool(SandboxImageSearchTool, function_names=enabled_methods, thread_manager=self.thread_manager, project_id=self.project_id)
        
        from core.tools.browser_tool import BrowserTool
        enabled_methods = self._get_enabled_methods_for_tool('browser_tool')
        self.thread_manager.add_tool(
            BrowserTool, 
            function_names=enabled_methods, 
            project_id=self.project_id, 
            thread_id=self.thread_id, 
            thread_manager=self.thread_manager
        )
        
        core_sandbox_tools = [
            'sb_shell_tool', 
            'sb_git_sync', 
            'sb_files_tool',
            'sb_file_reader_tool',
            'sb_vision_tool',
            'sb_image_edit_tool',
            'sb_upload_file_tool',
            'sb_expose_tool'
        ]
        tools_needing_thread_id = {'sb_vision_tool', 'sb_image_edit_tool', 'sb_design_tool'}
        
        for tool_name in core_sandbox_tools:
            tool_info = get_tool_info(tool_name)
            if tool_info:
                _, module_path, class_name = tool_info
                try:
                    tool_class = get_tool_class(module_path, class_name)
                    kwargs = {
                        'project_id': self.project_id,
                        'thread_manager': self.thread_manager
                    }
                    if tool_name in tools_needing_thread_id:
                        kwargs['thread_id'] = self.thread_id
                    
                    enabled_methods = self._get_enabled_methods_for_tool(tool_name)
                    self.thread_manager.add_tool(tool_class, function_names=enabled_methods, **kwargs)
                except (ImportError, AttributeError) as e:
                    logger.warning(f"❌ Failed to load core tool {tool_name} ({class_name}): {e}")
    
    def _register_sandbox_tools(self, disabled_tools: List[str]):
        core_tools_already_loaded = [
            'sb_shell_tool', 
            'sb_git_sync', 
            'sb_files_tool', 
            'sb_file_reader_tool',
            'web_search_tool',
            'image_search_tool',
            'sb_vision_tool',
            'sb_image_edit_tool',
            'sb_upload_file_tool',
            'sb_expose_tool'
        ]
        
        from core.tools.tool_registry import SANDBOX_TOOLS, get_tool_class
        
        tools_needing_thread_id = {'sb_vision_tool', 'sb_image_edit_tool', 'sb_design_tool'}
        
        sandbox_tools = []
        for tool_name, module_path, class_name in SANDBOX_TOOLS:
            if tool_name in core_tools_already_loaded:
                continue
            
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
    
    def _register_utility_tools(self, disabled_tools: List[str]):
        if config.SEMANTIC_SCHOLAR_API_KEY and 'paper_search_tool' not in disabled_tools:
            if 'paper_search_tool' not in disabled_tools:
                enabled_methods = self._get_enabled_methods_for_tool('paper_search_tool')
                self.thread_manager.add_tool(PaperSearchTool, function_names=enabled_methods, thread_manager=self.thread_manager)
        
        if config.EXA_API_KEY:
            if 'people_search_tool' not in disabled_tools:
                enabled_methods = self._get_enabled_methods_for_tool('people_search_tool')
                self.thread_manager.add_tool(PeopleSearchTool, function_names=enabled_methods, thread_manager=self.thread_manager)
            
            if 'company_search_tool' not in disabled_tools:
                enabled_methods = self._get_enabled_methods_for_tool('company_search_tool')
                self.thread_manager.add_tool(CompanySearchTool, function_names=enabled_methods, thread_manager=self.thread_manager)
        
        if config.ENV_MODE != EnvMode.PRODUCTION and config.VAPI_PRIVATE_KEY and 'vapi_voice_tool' not in disabled_tools:
            enabled_methods = self._get_enabled_methods_for_tool('vapi_voice_tool')
            self.thread_manager.add_tool(VapiVoiceTool, function_names=enabled_methods, thread_manager=self.thread_manager)
        
        if config.REALITY_DEFENDER_API_KEY and 'reality_defender_tool' not in disabled_tools:
            from core.tools.reality_defender_tool import RealityDefenderTool
            enabled_methods = self._get_enabled_methods_for_tool('reality_defender_tool')
            self.thread_manager.add_tool(RealityDefenderTool, function_names=enabled_methods, project_id=self.project_id, thread_manager=self.thread_manager)
            
        if config.APIFY_API_TOKEN and 'apify_tool' not in disabled_tools:
            from core.tools.apify_tool import ApifyTool
            enabled_methods = self._get_enabled_methods_for_tool('apify_tool')
            self.thread_manager.add_tool(ApifyTool, function_names=enabled_methods, project_id=self.project_id, thread_manager=self.thread_manager)
            
    def _register_agent_builder_tools(self, agent_id: str, disabled_tools: List[str]):
        from core.tools.tool_registry import AGENT_BUILDER_TOOLS, get_tool_class
        from core.services.supabase import DBConnection
        
        db = DBConnection()

        for tool_name, module_path, class_name in AGENT_BUILDER_TOOLS:
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
                except Exception as e:
                    logger.warning(f"❌ Failed to register {tool_name}: {e}")
    
    def _register_suna_specific_tools(self, disabled_tools: List[str]):
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
                    from core.tools.agent_creation_tool import AgentCreationTool
                
                enabled_methods = self._get_enabled_methods_for_tool('agent_creation_tool')
                self.thread_manager.add_tool(
                    AgentCreationTool, 
                    function_names=enabled_methods, 
                    thread_manager=self.thread_manager, 
                    db_connection=db, 
                    account_id=self.account_id
                )
            except (ImportError, AttributeError) as e:
                logger.warning(f"❌ Failed to load agent_creation_tool: {e}")
    
    def _register_browser_tool(self, disabled_tools: List[str]):
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
    
    def _get_migrated_tools_config(self) -> dict:
        if not self.agent_config or 'agentpress_tools' not in self.agent_config:
            return {}
        
        from core.utils.tool_migration import migrate_legacy_tool_config
        
        raw_tools = self.agent_config['agentpress_tools']
        
        if not isinstance(raw_tools, dict):
            return {}
        
        return migrate_legacy_tool_config(raw_tools)
    
    def _get_enabled_methods_for_tool(self, tool_name: str) -> Optional[List[str]]:
        if not hasattr(self, 'migrated_tools') or not self.migrated_tools:
            return None
        
        from core.utils.tool_discovery import get_enabled_methods_for_tool
        
        return get_enabled_methods_for_tool(tool_name, self.migrated_tools)
    
    def get_disabled_tools_from_config(self) -> List[str]:
        """Get list of disabled tools from agent config."""
        disabled_tools = []
        
        if not self.agent_config or 'agentpress_tools' not in self.agent_config:
            return disabled_tools
        
        raw_tools = self.agent_config['agentpress_tools']
        
        if not isinstance(raw_tools, dict):
            return disabled_tools
        
        if self.agent_config.get('is_suna_default', False) and not raw_tools:
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
            'browser_tool', 'people_search_tool', 'company_search_tool', 
            'apify_tool', 'reality_defender_tool', 'vapi_voice_tool', 'paper_search_tool',
            'agent_config_tool', 'mcp_search_tool', 'credential_profile_tool', 'trigger_tool',
            'agent_creation_tool'
        ]
        
        for tool_name in all_tools:
            if not is_tool_enabled(tool_name):
                disabled_tools.append(tool_name)
                
        logger.debug(f"Disabled tools from config: {disabled_tools}")
        return disabled_tools
    
    def register_suna_specific_tools(self, disabled_tools: List[str], account_id: Optional[str] = None):
        """Register Suna-specific tools like agent_creation_tool."""
        if 'agent_creation_tool' not in disabled_tools:
            from core.tools.agent_creation_tool import AgentCreationTool
            from core.services.supabase import DBConnection
            
            db = DBConnection()
            
            if account_id:
                enabled_methods = self._get_enabled_methods_for_tool('agent_creation_tool')
                if enabled_methods is not None:
                    self.thread_manager.add_tool(AgentCreationTool, function_names=enabled_methods, thread_manager=self.thread_manager, db_connection=db, account_id=account_id)
                else:
                    self.thread_manager.add_tool(AgentCreationTool, thread_manager=self.thread_manager, db_connection=db, account_id=account_id)
            else:
                logger.warning("Could not register agent_creation_tool: account_id not available")