import time
from typing import Optional, List
from core.tools.message_tool import MessageTool
from core.tools.web_search_tool import SandboxWebSearchTool
from core.tools.image_search_tool import SandboxImageSearchTool
from core.tools.data_providers_tool import DataProvidersTool
from core.tools.expand_msg_tool import ExpandMessageTool
from core.tools.task_list_tool import TaskListTool
from core.tools.people_search_tool import PeopleSearchTool
from core.tools.company_search_tool import CompanySearchTool
from core.tools.paper_search_tool import PaperSearchTool
from core.tools.vapi_voice_tool import VapiVoiceTool
from core.agentpress.thread_manager import ThreadManager
from core.utils.config import config, EnvMode
from core.utils.logger import logger

class ToolManager:
    def __init__(self, thread_manager: ThreadManager, project_id: str, thread_id: str, agent_config: Optional[dict] = None):
        self.thread_manager = thread_manager
        self.project_id = project_id
        self.thread_id = thread_id
        self.agent_config = agent_config
        self.account_id = agent_config.get('account_id') if agent_config else None
    
    def register_all_tools(self, agent_id: Optional[str] = None, disabled_tools: Optional[List[str]] = None, use_spark: bool = True):
        start = time.time()
        timings = {}
        
        disabled_tools = disabled_tools or []
        
        t = time.time()
        self.migrated_tools = self._get_migrated_tools_config()
        timings['migrate_config'] = (time.time() - t) * 1000
        
        if use_spark:
            logger.info("⚡ [SPARK] Registering CORE TOOLS ONLY (JIT loading enabled)")
            t = time.time()
            self._register_core_tools()
            timings['core_tools'] = (time.time() - t) * 1000
            
            total = (time.time() - start) * 1000
            logger.info(f"⚡ [SPARK] Core tool registration complete in {total:.1f}ms")
            logger.info(f"⚡ [SPARK] {len(self.thread_manager.tool_registry.tools)} core functions registered")
            logger.info(f"⚡ [JIT] Other tools will be activated on-demand via initialize_tools()")
        else:
            logger.info("⚠️  [LEGACY] Registering ALL TOOLS at startup")
            
            t = time.time()
            self._register_core_tools()
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
    
    def _register_core_tools(self):
        from core.jit.loader import JITLoader
        from core.tools.tool_registry import get_tool_info, get_tool_class
        
        self.thread_manager.add_tool(ExpandMessageTool, thread_id=self.thread_id, thread_manager=self.thread_manager)
        self.thread_manager.add_tool(MessageTool)
        self.thread_manager.add_tool(TaskListTool, project_id=self.project_id, thread_manager=self.thread_manager, thread_id=self.thread_id)
        
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
        if config.RAPID_API_KEY and 'data_providers_tool' not in disabled_tools:
            enabled_methods = self._get_enabled_methods_for_tool('data_providers_tool')
            self.thread_manager.add_tool(DataProvidersTool, function_names=enabled_methods)
        
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
