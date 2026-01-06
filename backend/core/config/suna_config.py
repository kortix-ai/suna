from core.prompts.core_prompt import CORE_SYSTEM_PROMPT

SUNA_CONFIG = {
    "name": "Kortix",
    "description": "Kortix is your AI assistant with access to various tools and integrations to help you with tasks across domains.",
    "model": "kortix/basic",
    "system_prompt": CORE_SYSTEM_PROMPT,
    "configured_mcps": [],
    "custom_mcps": [],
    "agentpress_tools": {
        # Core file and shell operations
        "sb_shell_tool": True,
        "sb_files_tool": True,
        "sb_expose_tool": True,
        "sb_upload_file_tool": True,
        "sb_git_sync": True,
        
        # Search and research tools
        "web_search_tool": True,
        "image_search_tool": True,
        
        # AI vision and image tools
        "sb_vision_tool": True,
        "sb_image_edit_tool": True,
        "sb_design_tool": True,
        
        # Document and content creation
        "sb_presentation_tool": True,
        "sb_kb_tool": True,

        # search tools (disabled - exa-py removed due to openai 2.x incompatibility)
        "people_search_tool": False,
        "company_search_tool": False,

        "browser_tool": True,
        
        # Agent builder tools
        "agent_config_tool": True,
        "agent_creation_tool": True,
        "mcp_search_tool": True,
        "credential_profile_tool": True,
        "trigger_tool": True
    },
    "is_default": True
}

