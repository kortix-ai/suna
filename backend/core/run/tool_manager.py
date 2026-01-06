import time
from typing import Optional, List, Set
from core.tools.message_tool import MessageTool
from core.tools.web_search_tool import SandboxWebSearchTool
from core.tools.image_search_tool import SandboxImageSearchTool
from core.tools.expand_msg_tool import ExpandMessageTool
from core.tools.task_list_tool import TaskListTool
from core.agentpress.thread_manager import ThreadManager
from core.utils.config import config
from core.utils.logger import logger


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
    
    def __init__(self, thread_manager: ThreadManager, project_id: str, thread_id: str, agent_config: Optional[dict] = None):
        self.thread_manager = thread_manager
        self.project_id = project_id
        self.thread_id = thread_id
        self.agent_config = agent_config
        self.disabled_tools = self._get_disabled_tools()
    
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
    
    def register_core_tools(self):
        """Register core tools that are enabled in agent config."""
        start = time.time()
        
        self.migrated_tools = self._get_migrated_tools_config()
        
        self._register_enabled_core_tools()
        
        total = (time.time() - start) * 1000
        tool_count = len(self.thread_manager.tool_registry.tools)
        logger.info(f"✅ Registered {tool_count} core tool functions in {total:.1f}ms")
    
    def _register_enabled_core_tools(self):
        """Register core tools that are enabled."""
        from core.tools.tool_registry import get_tool_info, get_tool_class
        
        # These are ALWAYS loaded (required for agent operation)
        self.thread_manager.add_tool(ExpandMessageTool, thread_id=self.thread_id, thread_manager=self.thread_manager)
        self.thread_manager.add_tool(MessageTool)
        self.thread_manager.add_tool(TaskListTool, project_id=self.project_id, thread_manager=self.thread_manager, thread_id=self.thread_id)
        
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
