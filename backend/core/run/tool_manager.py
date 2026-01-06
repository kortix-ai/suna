import time
from typing import Optional, List, Set
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
from core.utils.config import config
from core.utils.logger import logger


# Orchestrator mode detection
ORCHESTRATOR_MODELS = ['kortix/power', 'kortix-power', 'Kortix Power', 'Kortix Advanced Mode']

# Default core tools - can be overridden by agent config
DEFAULT_CORE_TOOLS = [
    'expand_msg_tool',      # Always needed for tool loading
    'message_tool',         # Always needed for user communication
    'task_list_tool',       # Task management
    'web_search_tool',      # Web search
    'image_search_tool',    # Image search
    'browser_tool',         # Web browsing
    'sb_shell_tool',        # Shell commands
    'sb_git_sync',          # Git operations
    'sb_files_tool',        # File operations
    'sb_file_reader_tool',  # File reading
    'sb_vision_tool',       # Image understanding
    'sb_image_edit_tool',   # Image generation
    'sb_upload_file_tool',  # File uploads
    'sb_expose_tool',       # Port exposure
]


class ToolManager:
    """
    Manages tool registration for agent threads.
    
    Tools are registered based on agent config:
    - Core tools (preloaded): Registered at startup if enabled in config
    - On-demand tools: Loaded via initialize_tools() when needed
    
    Agent config structure:
    {
        "agentpress_tools": {
            "web_search_tool": true,           # enabled
            "sb_presentation_tool": false,     # disabled
            "browser_tool": {"enabled": true}  # enabled with config
        }
    }
    """
    
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
        self.disabled_tools = self._get_disabled_tools()
        
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
    
    def _get_disabled_tools(self) -> Set[str]:
        """Get set of disabled tools from agent config."""
        if not self.agent_config or 'agentpress_tools' not in self.agent_config:
            return set()
        
        raw_tools = self.agent_config.get('agentpress_tools', {})
        if not isinstance(raw_tools, dict):
            return set()
        
        # For default Suna agent with no explicit config, enable all
        if self.agent_config.get('is_suna_default', False) and not raw_tools:
            return set()
        
        disabled = set()
        for tool_name, tool_config in raw_tools.items():
            if isinstance(tool_config, bool) and not tool_config:
                disabled.add(tool_name)
            elif isinstance(tool_config, dict) and not tool_config.get('enabled', True):
                disabled.add(tool_name)
        
        if disabled:
            logger.info(f"Tools disabled by config: {disabled}")
        return disabled
    
    def _is_tool_enabled(self, tool_name: str) -> bool:
        """Check if a tool is enabled based on agent config."""
        return tool_name not in self.disabled_tools
    
    def get_disabled_tools_from_config(self) -> List[str]:
        """Get list of disabled tools from agent config (for compatibility with agent_runner)."""
        return list(self.disabled_tools)
    
    def register_all_tools(self, agent_id: Optional[str] = None, disabled_tools: Optional[List[str]] = None, use_spark: bool = True):
        """Register all tools (alias for register_core_tools for compatibility)."""
        self.register_core_tools(use_spark=use_spark, agent_id=agent_id)
    
    def register_core_tools(self, use_spark: bool = True, agent_id: Optional[str] = None):
        """Register core tools that are enabled in agent config."""
        start = time.time()
        timings = {}
        
        self.migrated_tools = self._get_migrated_tools_config()
        disabled_tools = list(self.disabled_tools)
        
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
                disabled_tools = disabled_tools + ['sub_agent_tool']
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
        """Register core tools that are enabled."""
        disabled_tools = disabled_tools or []
        self._register_enabled_core_tools(disabled_tools)
    
    def _register_enabled_core_tools(self, disabled_tools: Optional[List[str]] = None):
        """Register core tools that are enabled."""
        from core.tools.tool_registry import get_tool_info, get_tool_class
        disabled_tools = disabled_tools or []
        
        # These are ALWAYS loaded (required for agent operation)
        self.thread_manager.add_tool(ExpandMessageTool, thread_id=self.thread_id, thread_manager=self.thread_manager)
        self.thread_manager.add_tool(MessageTool)
        self.thread_manager.add_tool(TaskListTool, project_id=self.project_id, thread_manager=self.thread_manager, thread_id=self.thread_id)
        
        # Only register SubAgentTool if not disabled (sub-agents can't spawn sub-agents)
        if 'sub_agent_tool' not in disabled_tools:
            self.thread_manager.add_tool(SubAgentTool, project_id=self.project_id, thread_manager=self.thread_manager, thread_id=self.thread_id)
        
        # Search tools (if API keys configured AND enabled in config)
        if (config.TAVILY_API_KEY or config.FIRECRAWL_API_KEY) and self._is_tool_enabled('web_search_tool'):
            enabled_methods = self._get_enabled_methods_for_tool('web_search_tool')
            self.thread_manager.add_tool(SandboxWebSearchTool, function_names=enabled_methods, thread_manager=self.thread_manager, project_id=self.project_id)
        
        if config.SERPER_API_KEY and self._is_tool_enabled('image_search_tool'):
            enabled_methods = self._get_enabled_methods_for_tool('image_search_tool')
            self.thread_manager.add_tool(SandboxImageSearchTool, function_names=enabled_methods, thread_manager=self.thread_manager, project_id=self.project_id)
        
        # Browser tool
        if self._is_tool_enabled('browser_tool'):
            from core.tools.browser_tool import BrowserTool
            enabled_methods = self._get_enabled_methods_for_tool('browser_tool')
            self.thread_manager.add_tool(
                BrowserTool, 
                function_names=enabled_methods, 
                project_id=self.project_id, 
                thread_id=self.thread_id, 
                thread_manager=self.thread_manager
            )
        
        # Core sandbox tools - only register if enabled
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
            if not self._is_tool_enabled(tool_name):
                logger.debug(f"Skipping disabled tool: {tool_name}")
                continue
                
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
                    logger.warning(f"Failed to load core tool {tool_name}: {e}")
    
    def _register_sandbox_tools(self, disabled_tools: Optional[List[str]] = None):
        """Register sandbox tools (legacy mode only)."""
        # Sandbox tools are now registered in _register_enabled_core_tools
        pass
    
    def _register_utility_tools(self, disabled_tools: Optional[List[str]] = None):
        """Register utility tools (legacy mode only)."""
        disabled_tools = disabled_tools or []
        
        # People search
        if config.SERPER_API_KEY and 'people_search_tool' not in disabled_tools:
            self.thread_manager.add_tool(PeopleSearchTool)
        
        # Company search
        if config.SERPER_API_KEY and 'company_search_tool' not in disabled_tools:
            self.thread_manager.add_tool(CompanySearchTool)
        
        # Paper search
        if config.SERPER_API_KEY and 'paper_search_tool' not in disabled_tools:
            self.thread_manager.add_tool(PaperSearchTool)
        
        # Voice tool
        if config.VAPI_API_KEY and 'vapi_voice_tool' not in disabled_tools:
            self.thread_manager.add_tool(VapiVoiceTool)
    
    def _register_agent_builder_tools(self, agent_id: str, disabled_tools: Optional[List[str]] = None):
        """Register agent builder tools (legacy mode only)."""
        disabled_tools = disabled_tools or []
        # Agent builder tools would go here if needed
        pass
    
    def _register_suna_specific_tools(self, disabled_tools: Optional[List[str]] = None):
        """Register Suna-specific tools (legacy mode only)."""
        disabled_tools = disabled_tools or []
        # Suna-specific tools would go here if needed
        pass
    
    def register_suna_specific_tools(self, disabled_tools: Optional[List[str]] = None, account_id: Optional[str] = None):
        """Register Suna-specific tools (public method for agent_runner compatibility)."""
        disabled_tools = disabled_tools or []
        # Suna-specific tools registration
        # This is called separately from register_core_tools for non-orchestrator agents
        pass
    
    def _get_migrated_tools_config(self) -> dict:
        """Get migrated tool configuration from agent config."""
        if not self.agent_config or 'agentpress_tools' not in self.agent_config:
            return {}
        
        from core.utils.tool_migration import migrate_legacy_tool_config
        
        raw_tools = self.agent_config['agentpress_tools']
        
        if not isinstance(raw_tools, dict):
            return {}
        
        return migrate_legacy_tool_config(raw_tools)
    
    def _get_enabled_methods_for_tool(self, tool_name: str) -> Optional[List[str]]:
        """Get list of enabled methods for a tool based on agent config."""
        if not hasattr(self, 'migrated_tools') or not self.migrated_tools:
            return None
        
        from core.utils.tool_discovery import get_enabled_methods_for_tool
        
        return get_enabled_methods_for_tool(tool_name, self.migrated_tools)
