from typing import Dict, List, Optional, Tuple
from dataclasses import dataclass
import threading


@dataclass
class ToolGuideEntry:
    tool_name: str
    display_name: str
    description: str
    usage_guide: Optional[str]


class ToolGuideRegistry:
    _instance = None
    _lock = threading.Lock()
    _initialized = False
    
    def __new__(cls):
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = super().__new__(cls)
        return cls._instance
    
    def __init__(self):
        if not ToolGuideRegistry._initialized:
            self._guides: Dict[str, ToolGuideEntry] = {}
            self._minimal_index: Optional[str] = None
            ToolGuideRegistry._initialized = True
    
    def initialize(self) -> None:
        from core.tools.tool_registry import ALL_TOOLS, get_tool_class
        from core.utils.logger import logger
        
        logger.info(f"🔧 [DYNAMIC TOOLS] Initializing Tool Guide Registry...")
        loaded_count = 0
        with_guides_count = 0
        
        for tool_name, module_path, class_name in ALL_TOOLS:
            try:
                tool_class = get_tool_class(module_path, class_name)
                if hasattr(tool_class, '__tool_metadata__'):
                    metadata = tool_class.__tool_metadata__
                    self._guides[tool_name] = ToolGuideEntry(
                        tool_name=tool_name,
                        display_name=metadata.display_name,
                        description=metadata.description,
                        usage_guide=metadata.usage_guide
                    )
                    loaded_count += 1
                    if metadata.usage_guide:
                        with_guides_count += 1
            except (ImportError, AttributeError) as e:
                logger.debug(f"Skipping tool {tool_name}: {e}")
        
        self._build_minimal_index()
        logger.info(f"✅ [DYNAMIC TOOLS] Registry initialized: {loaded_count} tools loaded, {with_guides_count} have usage guides")
        logger.info(f"📊 [DYNAMIC TOOLS] Minimal index size: {len(self._minimal_index):,} characters")
    
    def _build_minimal_index(self) -> None:
        lines = [
            "# 9. AVAILABLE TOOLS",
            "",
            "**🔴 MANDATORY:** Before using any tool, call `initialize_tools([\"tool1\", \"tool2\", ...])` to activate and get usage instructions.",
            "",
            "**Batch load ALL tools you need upfront:**",
            "- Analyze user request → Identify all needed tools → Load in ONE call",
            "- Example: `initialize_tools([\"web_search_tool\", \"browser_tool\", \"sb_files_tool\"])`",
            "- This is INTERNAL (invisible to users) - don't mention it",
            "",
            "**🚨 CRITICAL - Tool Guides Give You Function Names:**",
            "Each tool provides SPECIFIC FUNCTIONS. Loading the guide reveals what you can call:",
            "- `sb_presentation_tool` → `create_slide()`, `load_template_design()`, `validate_slide()`",
            "- `sb_files_tool` → `create_file()`, `read_file()`, `edit_file()`, `full_file_rewrite()`",
            "- `browser_tool` → `browser_navigate()`, `browser_click()`, `browser_screenshot()`",
            "- `web_search_tool` → `web_search()`, `web_search_streaming()`",
            "",
            "**⚠️ Use Specialized Functions, NOT Generic Ones:**",
            "- Creating presentations? Use `create_slide()` from `sb_presentation_tool`, NOT `create_file()`",
            "- Always load the guide FIRST to see what specialized functions exist!",
            "",
            "**Tool Names:**",
            ""
        ]
        
        categories = {
            'core': [],
            'files': [],
            'search': [],
            'browser': [],
            'media': [],
            'utility': [],
            'agent': []
        }
        
        category_map = {
            'expand_msg_tool': 'core',
            'message_tool': 'core',
            'task_list_tool': 'core',
            'sb_shell_tool': 'files',
            'sb_files_tool': 'files',
            'sb_expose_tool': 'files',
            'sb_kb_tool': 'files',
            'sb_upload_file_tool': 'files',
            'web_search_tool': 'search',
            'image_search_tool': 'search',
            'people_search_tool': 'search',
            'company_search_tool': 'search',
            'paper_search_tool': 'search',
            'browser_tool': 'browser',
            'sb_vision_tool': 'media',
            'sb_image_edit_tool': 'media',
            'sb_presentation_tool': 'media',
            'data_providers_tool': 'utility',
            'vapi_voice_tool': 'utility',
            'agent_config_tool': 'agent',
            'agent_creation_tool': 'agent',
            'mcp_search_tool': 'agent',
            'credential_profile_tool': 'agent',
            'trigger_tool': 'agent',
        }
        
        for tool_name, entry in self._guides.items():
            cat = category_map.get(tool_name, 'utility')
            categories[cat].append(tool_name)
        
        category_labels = {
            'core': 'Core',
            'files': 'Files',
            'search': 'Search',
            'browser': 'Browser',
            'media': 'Media',
            'utility': 'Utility',
            'agent': 'Agent Builder'
        }
        
        # Ultra-compact format: just comma-separated tool names per category
        for cat_key, cat_label in category_labels.items():
            tools_in_cat = categories.get(cat_key, [])
            if tools_in_cat:
                tools_str = ", ".join(sorted(tools_in_cat))
                lines.append(f"**{cat_label}:** {tools_str}")
        
        self._minimal_index = "\n".join(lines)
    
    def get_guide(self, tool_name: str) -> Optional[str]:
        from core.utils.logger import logger
        
        entry = self._guides.get(tool_name)
        if entry and entry.usage_guide:
            guide_content = f"## {entry.display_name} Usage Guide\n\n{entry.usage_guide}"
            logger.info(f"📖 [DYNAMIC TOOLS] Loaded guide for '{tool_name}' ({len(guide_content):,} chars)")
            return guide_content
        elif entry:
            logger.warning(f"⚠️  [DYNAMIC TOOLS] Tool '{tool_name}' exists but has no usage guide")
        else:
            logger.warning(f"❌ [DYNAMIC TOOLS] Tool '{tool_name}' not found in registry")
        return None
    
    def get_minimal_index(self) -> str:
        if self._minimal_index is None:
            self._build_minimal_index()
        return self._minimal_index
    
    def get_all_tool_names(self) -> List[str]:
        return list(self._guides.keys())
    
    def has_tool(self, tool_name: str) -> bool:
        return tool_name in self._guides
    
    def get_tool_info(self, tool_name: str) -> Optional[Tuple[str, str]]:
        entry = self._guides.get(tool_name)
        if entry:
            return (entry.display_name, entry.description)
        return None

_registry: Optional[ToolGuideRegistry] = None

def get_tool_guide_registry() -> ToolGuideRegistry:
    from core.utils.logger import logger
    
    global _registry
    if _registry is None:
        logger.debug("🔧 [DYNAMIC TOOLS] First access to registry, initializing...")
        _registry = ToolGuideRegistry()
        _registry.initialize()
    return _registry


def get_tool_guide(tool_name: str) -> Optional[str]:
    return get_tool_guide_registry().get_guide(tool_name)


def get_minimal_tool_index() -> str:
    return get_tool_guide_registry().get_minimal_index()
