from typing import Dict, List, Any, Optional
from dataclasses import dataclass

@dataclass
class ToolMethod:
    name: str
    display_name: str
    description: str
    enabled: bool = True
    is_core: bool = False

@dataclass
class ToolGroup:
    name: str
    display_name: str
    description: str
    tool_class: str
    methods: List[ToolMethod]
    enabled: bool = True
    is_core: bool = False

TOOL_GROUPS: Dict[str, ToolGroup] = {
    "sb_files_tool": ToolGroup(
        name="sb_files_tool",
        display_name="File Operations",
        description="Create, read, edit, and manage files in the workspace",
        tool_class="SandboxFilesTool",
        methods=[
            ToolMethod(
                name="create_file",
                display_name="Create File",
                description="Create new files with content",
                enabled=True
            ),
            ToolMethod(
                name="str_replace",
                display_name="String Replace",
                description="Replace specific text in files",
                enabled=True
            ),
            ToolMethod(
                name="full_file_rewrite",
                display_name="Full File Rewrite",
                description="Completely rewrite file contents",
                enabled=True
            ),
            ToolMethod(
                name="edit_file",
                display_name="Edit File",
                description="AI-powered file editing with instructions",
                enabled=True
            ),
            ToolMethod(
                name="delete_file",
                display_name="Delete File",
                description="Delete files from workspace",
                enabled=True
            ),
        ]
    ),
    
    "sb_shell_tool": ToolGroup(
        name="sb_shell_tool",
        display_name="Shell Operations",
        description="Execute shell commands and manage terminal sessions",
        tool_class="SandboxShellTool",
        methods=[
            ToolMethod(
                name="execute_command",
                display_name="Execute Command",
                description="Execute shell commands in tmux sessions",
                enabled=True
            ),
            ToolMethod(
                name="check_command_output",
                display_name="Check Command Output",
                description="Check the output of running commands",
                enabled=True
            ),
            ToolMethod(
                name="terminate_command",
                display_name="Terminate Command",
                description="Terminate running commands",
                enabled=True
            ),
            ToolMethod(
                name="list_commands",
                display_name="List Commands",
                description="List all running commands",
                enabled=True
            ),
        ]
    ),
    
    "web_search_tool": ToolGroup(
        name="web_search_tool",
        display_name="Web Search",
        description="Search the web and scrape content for research",
        tool_class="SandboxWebSearchTool",
        methods=[
            ToolMethod(
                name="web_search",
                display_name="Web Search",
                description="Search the web using Tavily API",
                enabled=True
            ),
            ToolMethod(
                name="scrape_webpage",
                display_name="Scrape Webpage",
                description="Scrape webpage content using Firecrawl",
                enabled=True
            ),
        ]
    ),
    
    "sb_vision_tool": ToolGroup(
        name="sb_vision_tool",
        display_name="Vision & Image Analysis",
        description="Analyze images and visual content with AI",
        tool_class="SandboxVisionTool",
        methods=[
            ToolMethod(
                name="load_image",
                display_name="Load Image",
                description="Load and analyze images with AI vision",
                enabled=True
            ),
            ToolMethod(
                name="clear_images_from_context",
                display_name="Clear Images",
                description="Clear images from analysis context",
                enabled=True
            ),
        ]
    ),
    
    "sb_image_edit_tool": ToolGroup(
        name="sb_image_edit_tool",
        display_name="Image Editing",
        description="Edit and manipulate images with AI",
        tool_class="SandboxImageEditTool",
        methods=[
            ToolMethod(
                name="image_edit_or_generate",
                display_name="Edit or Generate Image",
                description="Edit existing images or generate new ones with AI",
                enabled=True
            ),
        ]
    ),
    
    "browser_tool": ToolGroup(
        name="browser_tool",
        display_name="Browser Automation",
        description="Automate web browser interactions and navigation",
        tool_class="BrowserTool",
        methods=[
            ToolMethod(
                name="browser_navigate_to",
                display_name="Navigate To URL",
                description="Navigate browser to specific URL",
                enabled=True
            ),
            ToolMethod(
                name="browser_act",
                display_name="Browser Action",
                description="Perform actions like clicking, typing, scrolling",
                enabled=True
            ),
            ToolMethod(
                name="browser_extract_content",
                display_name="Extract Content",
                description="Extract text and data from web pages",
                enabled=True
            ),
            ToolMethod(
                name="browser_screenshot",
                display_name="Take Screenshot",
                description="Capture screenshots of web pages",
                enabled=True
            ),
        ]
    ),
    
    "sb_presentation_tool": ToolGroup(
        name="sb_presentation_tool",
        display_name="Presentations",
        description="Create and manage presentations",
        tool_class="SandboxPresentationTool",
        methods=[
            ToolMethod(
                name="create_slide",
                display_name="Create Slide",
                description="Create individual slides with content",
                enabled=True
            ),
            ToolMethod(
                name="list_slides",
                display_name="List Slides",
                description="List all slides in presentations",
                enabled=True
            ),
            ToolMethod(
                name="delete_slide",
                display_name="Delete Slide",
                description="Delete slides from presentations",
                enabled=True
            ),
            ToolMethod(
                name="list_presentations",
                display_name="List Presentations",
                description="List all available presentations",
                enabled=True
            ),
            ToolMethod(
                name="delete_presentation",
                display_name="Delete Presentation",
                description="Delete entire presentations",
                enabled=True
            ),
        ]
    ),
    
    "sb_sheets_tool": ToolGroup(
        name="sb_sheets_tool",
        display_name="Spreadsheets",
        description="Create and manipulate spreadsheet data",
        tool_class="SandboxSheetsTool",
        methods=[
            ToolMethod(
                name="update_sheet",
                display_name="Update Sheet",
                description="Update spreadsheet cells and data",
                enabled=True
            ),
            ToolMethod(
                name="view_sheet",
                display_name="View Sheet",
                description="View and read spreadsheet data",
                enabled=True
            ),
            ToolMethod(
                name="create_sheet",
                display_name="Create Sheet",
                description="Create new spreadsheets",
                enabled=True
            ),
            ToolMethod(
                name="analyze_sheet",
                display_name="Analyze Sheet",
                description="Analyze spreadsheet data and patterns",
                enabled=True
            ),
            ToolMethod(
                name="visualize_sheet",
                display_name="Visualize Sheet",
                description="Create visualizations from spreadsheet data",
                enabled=True
            ),
            ToolMethod(
                name="format_sheet",
                display_name="Format Sheet",
                description="Format spreadsheet appearance and styling",
                enabled=True
            ),
        ]
    ),

    
    "task_list_tool": ToolGroup(
        name="task_list_tool",
        display_name="Task Management",
        description="Create and manage task lists",
        tool_class="TaskListTool",
        is_core=True,
        methods=[
            ToolMethod(
                name="create_task_list",
                display_name="Create Task List",
                description="Create and manage task lists",
                enabled=True,
                is_core=True
            ),
        ]
    ),
    
    "expand_message_tool": ToolGroup(
        name="expand_message_tool",
        display_name="Message Expansion",
        description="Expand truncated messages from conversations",
        tool_class="ExpandMessageTool",
        is_core=True,
        methods=[
            ToolMethod(
                name="expand_message",
                display_name="Expand Message",
                description="Expand truncated messages",
                enabled=True,
                is_core=True
            ),
        ]
    ),
    
    "sb_deploy_tool": ToolGroup(
        name="sb_deploy_tool",
        display_name="Deployment",
        description="Deploy applications and services",
        tool_class="SandboxDeployTool",
        methods=[
            ToolMethod(
                name="deploy",
                display_name="Deploy Application",
                description="Deploy applications and services",
                enabled=True
            ),
        ]
    ),

    "sb_expose_tool": ToolGroup(
        name="sb_expose_tool",
        display_name="Port Management",
        description="Expose services and manage ports",
        tool_class="SandboxExposeTool",
        methods=[
            ToolMethod(
                name="expose_port",
                display_name="Expose Port",
                description="Expose services on specific ports",
                enabled=True
            ),
        ]
    ),

    "image_search_tool": ToolGroup(
        name="image_search_tool",
        display_name="Image Search",
        description="Search for images using SERPER API",
        tool_class="SandboxImageSearchTool",
        methods=[
            ToolMethod(
                name="image_search",
                display_name="Image Search",
                description="Search for images with batch support",
                enabled=True
            ),
        ]
    ),

    "data_providers_tool": ToolGroup(
        name="data_providers_tool",
        display_name="Data Providers",
        description="Access to data providers and external APIs",
        tool_class="DataProvidersTool",
        methods=[
            ToolMethod(
                name="get_data_provider_endpoints",
                display_name="Get Data Provider Endpoints",
                description="List available data provider endpoints",
                enabled=True
            ),
            ToolMethod(
                name="execute_data_provider_call",
                display_name="Execute Data Provider Call",
                description="Execute calls to external data providers",
                enabled=True
            ),
        ]
    ),

    "agent_config_tool": ToolGroup(
        name="agent_config_tool",
        display_name="Agent Configuration",
        description="Configure agent settings, tools, and integrations",
        tool_class="AgentConfigTool",
        methods=[
            ToolMethod(
                name="update_agent",
                display_name="Update Agent",
                description="Update agent configuration and settings",
                enabled=True
            ),
            ToolMethod(
                name="get_current_agent_config",
                display_name="Get Agent Config",
                description="Get current agent configuration",
                enabled=True
            ),
        ]
    ),

    "mcp_search_tool": ToolGroup(
        name="mcp_search_tool",
        display_name="MCP Search",
        description="Search and discover MCP servers and integrations",
        tool_class="MCPSearchTool",
        methods=[
            ToolMethod(
                name="search_mcp_servers",
                display_name="Search MCP Servers",
                description="Search for available MCP server integrations",
                enabled=True
            ),
            ToolMethod(
                name="get_app_details",
                display_name="Get App Details",
                description="Get detailed information about MCP apps",
                enabled=True
            ),
            ToolMethod(
                name="discover_user_mcp_servers",
                display_name="Discover User MCP Servers",
                description="Discover user's available MCP servers",
                enabled=True
            ),
        ]
    ),

    "credential_profile_tool": ToolGroup(
        name="credential_profile_tool",
        display_name="Credential Management",
        description="Manage credential profiles for secure authentication",
        tool_class="CredentialProfileTool",
        methods=[
            ToolMethod(
                name="get_credential_profiles",
                display_name="Get Credential Profiles",
                description="List all available credential profiles",
                enabled=True
            ),
            ToolMethod(
                name="create_credential_profile",
                display_name="Create Credential Profile",
                description="Create new credential profiles for authentication",
                enabled=True
            ),
            ToolMethod(
                name="configure_profile_for_agent",
                display_name="Configure Profile for Agent",
                description="Configure credential profile for agent use",
                enabled=True
            ),
            ToolMethod(
                name="delete_credential_profile",
                display_name="Delete Credential Profile",
                description="Delete existing credential profiles",
                enabled=True
            ),
        ]
    ),

    "workflow_tool": ToolGroup(
        name="workflow_tool",
        display_name="Workflows",
        description="Create and manage automated workflows",
        tool_class="WorkflowTool",
        methods=[
            ToolMethod(
                name="create_workflow",
                display_name="Create Workflow",
                description="Create new automated workflows",
                enabled=True
            ),
            ToolMethod(
                name="get_workflows",
                display_name="Get Workflows",
                description="List all available workflows",
                enabled=True
            ),
            ToolMethod(
                name="update_workflow",
                display_name="Update Workflow",
                description="Update existing workflows",
                enabled=True
            ),
            ToolMethod(
                name="delete_workflow",
                display_name="Delete Workflow",
                description="Delete workflows",
                enabled=True
            ),
            ToolMethod(
                name="activate_workflow",
                display_name="Activate Workflow",
                description="Activate or deactivate workflows",
                enabled=True
            ),
        ]
    ),

    "trigger_tool": ToolGroup(
        name="trigger_tool",
        display_name="Triggers",
        description="Create and manage automated triggers",
        tool_class="TriggerTool",
        methods=[
            ToolMethod(
                name="create_scheduled_trigger",
                display_name="Create Scheduled Trigger",
                description="Create time-based scheduled triggers",
                enabled=True
            ),
            ToolMethod(
                name="get_scheduled_triggers",
                display_name="Get Scheduled Triggers",
                description="List all scheduled triggers",
                enabled=True
            ),
            ToolMethod(
                name="delete_scheduled_trigger",
                display_name="Delete Scheduled Trigger",
                description="Delete scheduled triggers",
                enabled=True
            ),
            ToolMethod(
                name="toggle_scheduled_trigger",
                display_name="Toggle Scheduled Trigger",
                description="Enable or disable scheduled triggers",
                enabled=True
            ),
            ToolMethod(
                name="list_event_trigger_apps",
                display_name="List Event Trigger Apps",
                description="List available apps for event triggers",
                enabled=True
            ),
            ToolMethod(
                name="list_app_event_triggers",
                display_name="List App Event Triggers",
                description="List event triggers for specific apps",
                enabled=True
            ),
            ToolMethod(
                name="create_event_trigger",
                display_name="Create Event Trigger",
                description="Create event-based triggers",
                enabled=True
            ),
        ]
    ),

    "sb_kb_tool": ToolGroup(
        name="sb_kb_tool",
        display_name="Knowledge Base",
        description="Manage knowledge base content",
        tool_class="SandboxKbTool",
        methods=[
            ToolMethod(
                name="init_kb",
                display_name="Initialize Knowledge Base",
                description="Initialize the kb-fusion binary and optionally sync knowledge base",
                enabled=True
            ),
            ToolMethod(
                name="search_files",
                display_name="Search Files",
                description="Perform semantic search on files using kb-fusion",
                enabled=True
            ),
            ToolMethod(
                name="cleanup_kb",
                display_name="Cleanup Knowledge Base",
                description="Perform maintenance and cleanup operations",
                enabled=True
            ),
            ToolMethod(
                name="ls_kb",
                display_name="List Knowledge Base Files",
                description="List indexed files in the knowledge base",
                enabled=True
            ),
            ToolMethod(
                name="global_kb_sync",
                display_name="Sync Global Knowledge Base",
                description="Sync agent's knowledge base files to sandbox",
                enabled=True
            ),
            ToolMethod(
                name="global_kb_create_folder",
                display_name="Create Knowledge Base Folder",
                description="Create a new folder in the global knowledge base",
                enabled=True
            ),
            ToolMethod(
                name="global_kb_upload_file",
                display_name="Upload File to Knowledge Base",
                description="Upload a file from sandbox to the global knowledge base",
                enabled=True
            ),
            ToolMethod(
                name="global_kb_delete_item",
                display_name="Delete Knowledge Base Item",
                description="Delete a file or folder from the global knowledge base",
                enabled=True
            ),
            ToolMethod(
                name="global_kb_enable_item",
                display_name="Enable/Disable Knowledge Base Item",
                description="Enable or disable a knowledge base file for this agent",
                enabled=True
            ),
            ToolMethod(
                name="global_kb_list_contents",
                display_name="List Knowledge Base Contents",
                description="List all folders and files in the global knowledge base",
                enabled=True
            ),
        ]
    ),

    "sb_design_tool": ToolGroup(
        name="sb_design_tool",
        display_name="Design Tool",
        description="Create and edit design elements",
        tool_class="SandboxDesignerTool",
        methods=[
            ToolMethod(
                name="designer_create_or_edit",
                display_name="Create or Edit Design",
                description="Create new designs or edit existing ones",
                enabled=True
            ),
        ]
    ),

    "sb_presentation_outline_tool": ToolGroup(
        name="sb_presentation_outline_tool",
        display_name="Presentation Outline",
        description="Create structured presentation outlines",
        tool_class="SandboxPresentationOutlineTool",
        methods=[
            ToolMethod(
                name="create_outline",
                display_name="Create Outline",
                description="Create presentation outlines",
                enabled=True
            ),
        ]
    ),

    "sb_upload_file_tool": ToolGroup(
        name="sb_upload_file_tool",
        display_name="File Upload",
        description="Upload files to the workspace",
        tool_class="SandboxUploadFileTool",
        methods=[
            ToolMethod(
                name="upload_file",
                display_name="Upload File",
                description="Upload files to workspace",
                enabled=True
            ),
        ]
    ),

    "sb_docs_tool": ToolGroup(
        name="sb_docs_tool",
        display_name="Document Editor",
        description="Create and edit documents with TipTap",
        tool_class="SandboxDocsTool",
        methods=[
            ToolMethod(
                name="create_document",
                display_name="Create Document",
                description="Create new documents with rich text content",
                enabled=True
            ),
            ToolMethod(
                name="read_document",
                display_name="Read Document",
                description="Read the content of a document",
                enabled=True
            ),
            ToolMethod(
                name="list_documents",
                display_name="List Documents",
                description="List all documents in the workspace",
                enabled=True
            ),
            ToolMethod(
                name="delete_document",
                display_name="Delete Document",
                description="Delete a document from the workspace",
                enabled=True
            ),
            ToolMethod(
                name="get_format_guide",
                display_name="Get Format Guide",
                description="Get TipTap-compatible HTML format guide",
                enabled=True
            ),
        ]
    ),

    "agent_creation_tool": ToolGroup(
        name="agent_creation_tool",
        display_name="Agent Creation",
        description="Create new agents (Suna only)",
        tool_class="AgentCreationTool",
        methods=[
            ToolMethod(
                name="create_new_agent",
                display_name="Create New Agent",
                description="Create completely new AI agents",
                enabled=True
            ),
            ToolMethod(
                name="search_mcp_servers_for_agent",
                display_name="Search MCP Servers",
                description="Search MCP servers for agent integration",
                enabled=True
            ),
            ToolMethod(
                name="get_mcp_server_details",
                display_name="Get MCP Server Details",
                description="Get detailed MCP server information",
                enabled=True
            ),
            ToolMethod(
                name="create_credential_profile_for_agent",
                display_name="Create Credential Profile",
                description="Create credential profiles for agents",
                enabled=True
            ),
            ToolMethod(
                name="discover_mcp_tools_for_agent",
                display_name="Discover MCP Tools",
                description="Discover available MCP tools for agents",
                enabled=True
            ),
            ToolMethod(
                name="configure_agent_integration",
                display_name="Configure Agent Integration",
                description="Configure integrations for new agents",
                enabled=True
            ),
            ToolMethod(
                name="create_agent_workflow",
                display_name="Create Agent Workflow",
                description="Create workflows for new agents",
                enabled=True
            ),
            ToolMethod(
                name="list_agent_workflows",
                display_name="List Agent Workflows",
                description="List workflows for agents",
                enabled=True
            ),
            ToolMethod(
                name="activate_agent_workflow",
                display_name="Activate Agent Workflow",
                description="Activate or deactivate agent workflows",
                enabled=True
            ),
            ToolMethod(
                name="delete_agent_workflow",
                display_name="Delete Agent Workflow",
                description="Delete agent workflows",
                enabled=True
            ),
            ToolMethod(
                name="create_agent_scheduled_trigger",
                display_name="Create Scheduled Trigger",
                description="Create scheduled triggers for agents",
                enabled=True
            ),
            ToolMethod(
                name="list_agent_scheduled_triggers",
                display_name="List Scheduled Triggers",
                description="List agent scheduled triggers",
                enabled=True
            ),
            ToolMethod(
                name="toggle_agent_scheduled_trigger",
                display_name="Toggle Scheduled Trigger",
                description="Enable/disable agent scheduled triggers",
                enabled=True
            ),
            ToolMethod(
                name="delete_agent_scheduled_trigger",
                display_name="Delete Scheduled Trigger",
                description="Delete agent scheduled triggers",
                enabled=True
            ),
            ToolMethod(
                name="update_agent_config",
                display_name="Update Agent Config",
                description="Update existing agent configurations",
                enabled=True
            ),
        ]
    ),

    "sb_browser_tool": ToolGroup(
        name="sb_browser_tool",
        display_name="Browser Automation (Advanced)",
        description="Advanced browser automation with full UI interaction capabilities",
        tool_class="SandboxBrowserTool",
        methods=[
            ToolMethod(
                name="browser_navigate_to",
                display_name="Navigate To URL",
                description="Navigate browser to specific URL",
                enabled=True
            ),
            ToolMethod(
                name="browser_go_back",
                display_name="Go Back",
                description="Navigate back in browser history",
                enabled=True
            ),
            ToolMethod(
                name="browser_wait",
                display_name="Wait",
                description="Wait for specified number of seconds",
                enabled=True
            ),
            ToolMethod(
                name="browser_click_element",
                display_name="Click Element",
                description="Click on an element by index",
                enabled=True
            ),
            ToolMethod(
                name="browser_input_text",
                display_name="Input Text",
                description="Input text into an element",
                enabled=True
            ),
            ToolMethod(
                name="browser_send_keys",
                display_name="Send Keys",
                description="Send keyboard keys (Enter, Escape, shortcuts)",
                enabled=True
            ),
            ToolMethod(
                name="browser_switch_tab",
                display_name="Switch Tab",
                description="Switch to a different browser tab",
                enabled=True
            ),
            ToolMethod(
                name="browser_close_tab",
                display_name="Close Tab",
                description="Close a browser tab",
                enabled=True
            ),
            ToolMethod(
                name="browser_scroll_down",
                display_name="Scroll Down",
                description="Scroll down the page",
                enabled=True
            ),
            ToolMethod(
                name="browser_scroll_up",
                display_name="Scroll Up",
                description="Scroll up the page",
                enabled=True
            ),
            ToolMethod(
                name="browser_scroll_to_text",
                display_name="Scroll To Text",
                description="Scroll to specific text on the page",
                enabled=True
            ),
            ToolMethod(
                name="browser_get_dropdown_options",
                display_name="Get Dropdown Options",
                description="Get all options from a dropdown element",
                enabled=True
            ),
            ToolMethod(
                name="browser_select_dropdown_option",
                display_name="Select Dropdown Option",
                description="Select an option from a dropdown by text",
                enabled=True
            ),
            ToolMethod(
                name="browser_drag_drop",
                display_name="Drag and Drop",
                description="Perform drag and drop operation",
                enabled=True
            ),
            ToolMethod(
                name="browser_click_coordinates",
                display_name="Click Coordinates",
                description="Click at specific X,Y coordinates",
                enabled=True
            ),
        ]
    ),

    "people_search_tool": ToolGroup(
        name="people_search_tool",
        display_name="People Search",
        description="Search for people using LinkedIn",
        tool_class="PeopleSearchTool",
        methods=[
            ToolMethod(
                name="people_search",
                display_name="People Search",
                description="Search for people using LinkedIn",
                enabled=True
            ),
        ]
    ),

    "company_search_tool": ToolGroup(
        name="company_search_tool",
        display_name="Company Search",
        description="Search for companies using natural language queries",
        tool_class="CompanySearchTool",
        methods=[
            ToolMethod(
                name="company_search",
                display_name="Company Search",
                description="Search for companies using natural language queries",
                enabled=True
            ),
        ]
    ),

    "paper_search_tool": ToolGroup(
        name="paper_search_tool",
        display_name="Paper Search",
        description="Search for papers using natural language queries",
        tool_class="PaperSearchTool",
        methods=[
            ToolMethod(
                name="paper_search",
                display_name="Paper Search",
                description="Search for papers using natural language queries",
                enabled=True
            ),
        ]
    ),

    # "sb_document_parser_tool": ToolGroup(
    #     name="sb_document_parser_tool",
    #     display_name="Document Parser",
    #     description="Parse documents using Chunkr AI",
    #     tool_class="SandboxDocumentParserTool",
    #     methods=[
    #         ToolMethod(
    #             name="parse_document",
    #             display_name="Parse Document",
    #             description="Parse documents using Chunkr AI",
    #             enabled=True
    #         ),
    #     ]
    # ),

    "sb_web_dev_tool": ToolGroup(
        name="sb_web_dev_tool",
        display_name="Web Development",
        description="Create and manage web development projects with Vite and React",
        tool_class="SandboxWebDevTool",
        methods=[
            ToolMethod(
                name="create_vite_react_project",
                display_name="Create Vite React Project",
                description="Create a new Vite React project",
                enabled=True
            ),
            ToolMethod(
                name="get_project_structure",
                display_name="Get Project Structure",
                description="Get the file structure of a project",
                enabled=True
            ),
            ToolMethod(
                name="build_project",
                display_name="Build Project",
                description="Build a web project for production",
                enabled=True
            ),
            ToolMethod(
                name="start_dev_server",
                display_name="Start Dev Server",
                description="Start development server",
                enabled=True
            ),
            ToolMethod(
                name="start_preview_server",
                display_name="Start Preview Server",
                description="Start preview server for built project",
                enabled=True
            ),
        ]
    ),

    "sb_templates_tool": ToolGroup(
        name="sb_templates_tool",
        display_name="Project Templates",
        description="Discover and scaffold web project templates",
        tool_class="SandboxTemplatesTool",
        methods=[
            ToolMethod(
                name="list_templates",
                display_name="List Templates",
                description="List available project templates",
                enabled=True
            ),
            ToolMethod(
                name="scaffold_from_template",
                display_name="Scaffold From Template",
                description="Create project from template",
                enabled=True
            ),
        ]
    ),

    "computer_use_tool": ToolGroup(
        name="computer_use_tool",
        display_name="Computer Automation",
        description="Automate computer interactions including GUI control",
        tool_class="ComputerUseTool",
        methods=[
            ToolMethod(
                name="screenshot",
                display_name="Take Screenshot",
                description="Capture screenshot of current screen",
                enabled=True
            ),
            ToolMethod(
                name="click",
                display_name="Click",
                description="Click at coordinates or on elements",
                enabled=True
            ),
            ToolMethod(
                name="type",
                display_name="Type Text",
                description="Type text into active element",
                enabled=True
            ),
            ToolMethod(
                name="key",
                display_name="Press Keys",
                description="Press keyboard keys and shortcuts",
                enabled=True
            ),
            ToolMethod(
                name="scroll",
                display_name="Scroll",
                description="Scroll in specified direction",
                enabled=True
            ),
        ]
    ),

    "message_tool": ToolGroup(
        name="message_tool",
        display_name="User Communication",
        description="Enhanced communication tools for user interaction",
        tool_class="MessageTool",
        is_core=True,
        methods=[
            ToolMethod(
                name="ask",
                display_name="Ask Question",
                description="Ask users questions during task execution",
                enabled=True,
                is_core=True
            ),
            ToolMethod(
                name="web_browser_takeover",
                display_name="Request Browser Takeover",
                description="Request user takeover of browser interaction",
                enabled=True
            ),
            ToolMethod(
                name="present_presentation",
                display_name="Present Presentation",
                description="Present completed presentations to user",
                enabled=True
            ),
            ToolMethod(
                name="complete",
                display_name="Complete Task",
                description="Signal task completion and enter complete state",
                enabled=True,
                is_core=True
            ),
            ToolMethod(
                name="wait",
                display_name="Wait",
                description="Pause execution for specified duration",
                enabled=True
            ),
        ]
    ),
}

def get_tool_group(tool_name: str) -> Optional[ToolGroup]:
    return TOOL_GROUPS.get(tool_name)

def get_all_tool_groups() -> Dict[str, ToolGroup]:
    return TOOL_GROUPS

def get_enabled_methods_for_tool(tool_name: str, config: Dict[str, Any]) -> List[str]:
    tool_group = get_tool_group(tool_name)
    if not tool_group:
        return []
    
    tool_config = config.get(tool_name, True)
    
    if isinstance(tool_config, bool) and not tool_config:
        return []
    
    if tool_config is True:
        return [method.name for method in tool_group.methods if method.enabled]
    
    if isinstance(tool_config, dict):
        if not tool_config.get('enabled', True):
            return []
        
        methods_config = tool_config.get('methods', {})
        enabled_methods = []
        
        for method in tool_group.methods:
            method_enabled = method.enabled
            
            if method.name in methods_config:
                method_config = methods_config[method.name]
                if isinstance(method_config, bool):
                    method_enabled = method_config
                elif isinstance(method_config, dict):
                    method_enabled = method_config.get('enabled', method.enabled)
            
            if method_enabled:
                enabled_methods.append(method.name)
        
        return enabled_methods
    
    return [method.name for method in tool_group.methods if method.enabled]

def validate_tool_config(config: Dict[str, Any]) -> Dict[str, Any]:
    normalized_config = {}
    
    for tool_name, tool_config in config.items():
        tool_group = get_tool_group(tool_name)
        if not tool_group:
            normalized_config[tool_name] = tool_config
            continue
        
        if tool_group.is_core:
            normalized_config[tool_name] = True
            continue
        
        if isinstance(tool_config, bool):
            normalized_config[tool_name] = tool_config
        elif isinstance(tool_config, dict):
            validated_config = {
                'enabled': tool_config.get('enabled', True),
                'methods': {}
            }
            
            methods_config = tool_config.get('methods', {})
            for method in tool_group.methods:
                if method.name in methods_config:
                    method_config = methods_config[method.name]
                    if isinstance(method_config, bool):
                        validated_config['methods'][method.name] = method_config
                    elif isinstance(method_config, dict):
                        validated_config['methods'][method.name] = {
                            'enabled': method_config.get('enabled', method.enabled)
                        }
                    else:
                        validated_config['methods'][method.name] = method.enabled
                else:
                    validated_config['methods'][method.name] = method.enabled
            
            normalized_config[tool_name] = validated_config
        else:
            normalized_config[tool_name] = True
    
    return normalized_config
