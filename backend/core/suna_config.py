from core.prompts.prompt import SYSTEM_PROMPT

# Suna default configuration - simplified and centralized
SUNA_CONFIG = {
    "name": "Suna",
    "description": "Suna is your AI assistant with access to various tools and integrations to help you with tasks across domains.",
    "model": "claude-sonnet-4.5",
    "system_prompt": SYSTEM_PROMPT,
    "configured_mcps": [],
    "custom_mcps": [],
    "agentpress_tools": {
        # Core file and shell operations
        "sb_shell_tool": True,
        "sb_files_tool": True,
        "sb_expose_tool": True,
        "sb_upload_file_tool": True,
        
        # Search and research tools
        "web_search_tool": True,
        "image_search_tool": True,
        "data_providers_tool": True,
        
        # AI vision and image tools
        "sb_vision_tool": True,
        "sb_image_edit_tool": True,
        "sb_design_tool": True,
        
        # Document and content creation
        "sb_docs_tool": True,
        "sb_presentation_tool": True,
        "sb_kb_tool": True,

        # search tools
        "people_search_tool": True,
        "company_search_tool": True,

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

