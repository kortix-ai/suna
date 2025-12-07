from typing import Dict, List, Tuple, Type, Optional
from core.agentpress.tool import Tool

CORE_TOOLS = [
    ('expand_msg_tool', 'core.tools.expand_msg_tool', 'ExpandMessageTool'),
    ('message_tool', 'core.tools.message_tool', 'MessageTool'),
    ('task_list_tool', 'core.tools.task_list_tool', 'TaskListTool'),
    ('sb_git_sync', 'core.tools.sb_git_sync', 'SandboxGitTool'),
]

SANDBOX_TOOLS = [
    ('sb_shell_tool', 'core.tools.sb_shell_tool', 'SandboxShellTool'),
    ('sb_files_tool', 'core.tools.sb_files_tool', 'SandboxFilesTool'),
    ('sb_expose_tool', 'core.tools.sb_expose_tool', 'SandboxExposeTool'),
    ('sb_vision_tool', 'core.tools.sb_vision_tool', 'SandboxVisionTool'),
    ('sb_image_edit_tool', 'core.tools.sb_image_edit_tool', 'SandboxImageEditTool'),
    ('sb_kb_tool', 'core.tools.sb_kb_tool', 'SandboxKbTool'),
    ('sb_presentation_tool', 'core.tools.sb_presentation_tool', 'SandboxPresentationTool'),
    ('sb_upload_file_tool', 'core.tools.sb_upload_file_tool', 'SandboxUploadFileTool'),
    ('sb_git_sync', 'core.tools.sb_git_sync', 'SandboxGitTool'),
]

SEARCH_TOOLS = [
    ('web_search_tool', 'core.tools.web_search_tool', 'SandboxWebSearchTool'),
    ('image_search_tool', 'core.tools.image_search_tool', 'SandboxImageSearchTool'),
    ('people_search_tool', 'core.tools.people_search_tool', 'PeopleSearchTool'),
    ('company_search_tool', 'core.tools.company_search_tool', 'CompanySearchTool'),
    ('paper_search_tool', 'core.tools.paper_search_tool', 'PaperSearchTool'),
]

UTILITY_TOOLS = [
    ('data_providers_tool', 'core.tools.data_providers_tool', 'DataProvidersTool'),
    ('browser_tool', 'core.tools.browser_tool', 'BrowserTool'),
    ('vapi_voice_tool', 'core.tools.vapi_voice_tool', 'VapiVoiceTool'),
]

AGENT_BUILDER_TOOLS = [
    ('agent_config_tool', 'core.tools.agent_builder_tools.agent_config_tool', 'AgentConfigTool'),
    ('agent_creation_tool', 'core.tools.agent_creation_tool', 'AgentCreationTool'),
    ('mcp_search_tool', 'core.tools.agent_builder_tools.mcp_search_tool', 'MCPSearchTool'),
    ('credential_profile_tool', 'core.tools.agent_builder_tools.credential_profile_tool', 'CredentialProfileTool'),
    ('trigger_tool', 'core.tools.agent_builder_tools.trigger_tool', 'TriggerTool'),
]

ALL_TOOLS = CORE_TOOLS + SANDBOX_TOOLS + SEARCH_TOOLS + UTILITY_TOOLS + AGENT_BUILDER_TOOLS


def get_tool_class(module_path: str, class_name: str) -> Type[Tool]:
    import importlib
    module = importlib.import_module(module_path)
    return getattr(module, class_name)


def get_all_tools() -> Dict[str, Type[Tool]]:
    tools_map = {}
    for tool_name, module_path, class_name in ALL_TOOLS:
        try:
            tools_map[tool_name] = get_tool_class(module_path, class_name)
        except (ImportError, AttributeError) as e:
            from core.utils.logger import logger
            logger.debug(f"Skipping tool {tool_name}: {e}")
    
    return tools_map


def get_tool_info(tool_name: str) -> Optional[Tuple[str, str, str]]:
    for name, module_path, class_name in ALL_TOOLS:
        if name == tool_name:
            return (name, module_path, class_name)
    return None


def get_tools_by_category() -> Dict[str, List[Tuple[str, str, str]]]:
    return {
        'core': CORE_TOOLS,
        'sandbox': SANDBOX_TOOLS,
        'search': SEARCH_TOOLS,
        'utility': UTILITY_TOOLS,
        'agent_builder': AGENT_BUILDER_TOOLS,
    }


def get_tool_usage_guide(tool_name: str) -> Optional[str]:
    info = get_tool_info(tool_name)
    if not info:
        return None
    
    _, module_path, class_name = info
    try:
        tool_class = get_tool_class(module_path, class_name)
        if hasattr(tool_class, '__tool_metadata__') and tool_class.__tool_metadata__.usage_guide:
            return tool_class.__tool_metadata__.usage_guide
    except (ImportError, AttributeError):
        pass
    
    return None


def get_tool_metadata_summary(tool_name: str) -> Optional[Dict[str, str]]:
    info = get_tool_info(tool_name)
    if not info:
        return None
    
    _, module_path, class_name = info
    try:
        tool_class = get_tool_class(module_path, class_name)
        if hasattr(tool_class, '__tool_metadata__'):
            metadata = tool_class.__tool_metadata__
            return {
                'display_name': metadata.display_name,
                'description': metadata.description
            }
    except (ImportError, AttributeError):
        pass
    
    return None


def get_all_tool_summaries() -> Dict[str, Dict[str, str]]:
    summaries = {}
    for tool_name, module_path, class_name in ALL_TOOLS:
        try:
            tool_class = get_tool_class(module_path, class_name)
            if hasattr(tool_class, '__tool_metadata__'):
                metadata = tool_class.__tool_metadata__
                summaries[tool_name] = {
                    'display_name': metadata.display_name,
                    'description': metadata.description
                }
        except (ImportError, AttributeError):
            pass
    return summaries
