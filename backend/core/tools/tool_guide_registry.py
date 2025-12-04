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
            except (ImportError, AttributeError):
                pass
        
        self._build_minimal_index()
    
    def _build_minimal_index(self) -> None:
        lines = [
            "# 9. AVAILABLE TOOLS",
            "",
            "Below are all available tools. **Before using any tool for the first time, call `load_tool_guide(tool_name)` to get detailed usage instructions, examples, and best practices.**",
            "",
            "You can load multiple guides at once: `load_tool_guide([\"tool1\", \"tool2\"])`",
            "",
            "## Tool Index",
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
            categories[cat].append((tool_name, entry))
        
        category_labels = {
            'core': '### Core Tools',
            'files': '### File & System Tools',
            'search': '### Search & Research Tools',
            'browser': '### Browser Automation',
            'media': '### Media & Presentation Tools',
            'utility': '### Utility Tools',
            'agent': '### Agent Builder Tools'
        }
        
        for cat_key, cat_label in category_labels.items():
            tools_in_cat = categories.get(cat_key, [])
            if tools_in_cat:
                lines.append(cat_label)
                for tool_name, entry in sorted(tools_in_cat, key=lambda x: x[1].display_name):
                    lines.append(f"- `{tool_name}` - {entry.description}")
                lines.append("")
        
        lines.append("---")
        lines.append("**Remember:** Call `load_tool_guide(tool_name)` before using any tool to get complete documentation.")
        
        self._minimal_index = "\n".join(lines)
    
    def get_guide(self, tool_name: str) -> Optional[str]:
        entry = self._guides.get(tool_name)
        if entry and entry.usage_guide:
            return f"## {entry.display_name} Usage Guide\n\n{entry.usage_guide}"
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
    global _registry
    if _registry is None:
        _registry = ToolGuideRegistry()
        _registry.initialize()
    return _registry


def get_tool_guide(tool_name: str) -> Optional[str]:
    return get_tool_guide_registry().get_guide(tool_name)


def get_minimal_tool_index() -> str:
    return get_tool_guide_registry().get_minimal_index()
