from agent.prompts.prompt import SYSTEM_PROMPT

# Omni default configuration - updated branding from Suna
OMNI_CONFIG = {
    "name": "Omni",
    "description": "Omni is your AI assistant with access to various tools and integrations to help you with tasks across domains.",
    "avatar": "🌟",
    "avatar_color": "#8B5CF6",
    "model": "openrouter/anthropic/sonnet-4",
    "system_prompt": SYSTEM_PROMPT,
    "configured_mcps": [],
    "custom_mcps": [],
    "agentpress_tools": {
        "sb_shell_tool": True,
        "sb_files_tool": True,
        "sb_deploy_tool": True,
        "sb_expose_tool": True,
        "web_search_tool": True,
        "sb_vision_tool": True,
        "sb_image_edit_tool": True,
        "sb_presentation_outline_tool": False,
        "sb_presentation_tool": False,
        "sb_presentation_tool_v2": False,
        "sb_sheets_tool": True,
        "sb_web_dev_tool": False,
        "browser_tool": True,
        "data_providers_tool": True,
        "agent_config_tool": True,
        "mcp_search_tool": True,
        "credential_profile_tool": True,
        "workflow_tool": True,
        "trigger_tool": True
    },
    "is_default": True
}
