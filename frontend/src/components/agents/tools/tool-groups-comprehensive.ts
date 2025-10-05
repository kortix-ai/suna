import { ToolGroup, ToolMethod } from './tool-groups';

export const TOOL_GROUPS: Record<string, ToolGroup> = {
  sb_files_tool: {
    name: 'sb_files_tool',
    displayName: 'File Operations',
    description: 'Create, read, edit, and manage files in the workspace',
    icon: 'FolderOpen',
    color: 'bg-blue-100 dark:bg-blue-800/50',
    toolClass: 'SandboxFilesTool',
    enabled: true,
    methods: [
      {
        name: 'create_file',
        displayName: 'Create File',
        description: 'Create new files with content',
        enabled: true,
      },
      {
        name: 'str_replace',
        displayName: 'String Replace',
        description: 'Replace specific text in files',
        enabled: true,
      },
      {
        name: 'full_file_rewrite',
        displayName: 'Full File Rewrite',
        description: 'Completely rewrite file contents',
        enabled: true,
      },
      {
        name: 'edit_file',
        displayName: 'Edit File',
        description: 'AI-powered file editing with instructions',
        enabled: true,
      },
      {
        name: 'delete_file',
        displayName: 'Delete File',
        description: 'Delete files from workspace',
        enabled: true,
      },
    ],
  },

  sb_shell_tool: {
    name: 'sb_shell_tool',
    displayName: 'Shell Operations',
    description: 'Execute shell commands and manage terminal sessions',
    icon: 'Terminal',
    color: 'bg-slate-100 dark:bg-slate-800',
    toolClass: 'SandboxShellTool',
    enabled: true,
    methods: [
      {
        name: 'execute_command',
        displayName: 'Execute Command',
        description: 'Execute shell commands in terminal',
        enabled: true,
      },
      {
        name: 'check_command_output',
        displayName: 'Check Command Output',
        description: 'Check the output of running commands',
        enabled: true,
      },
      {
        name: 'terminate_command',
        displayName: 'Terminate Command',
        description: 'Terminate running commands',
        enabled: true,
      },
      {
        name: 'list_commands',
        displayName: 'List Commands',
        description: 'List all running commands',
        enabled: true,
      },
    ],
  },

  web_search_tool: {
    name: 'web_search_tool',
    displayName: 'Web Search',
    description: 'Search the web and scrape content for research',
    icon: 'Search',
    color: 'bg-yellow-100 dark:bg-yellow-800/50',
    toolClass: 'SandboxWebSearchTool',
    enabled: true,
    methods: [
      {
        name: 'web_search',
        displayName: 'Web Search',
        description: 'Search the web for information',
        enabled: true,
      },
      {
        name: 'scrape_webpage',
        displayName: 'Scrape Webpage',
        description: 'Extract content from web pages',
        enabled: true,
      },
    ],
  },

  people_search_tool: {
    name: 'people_search_tool',
    displayName: 'People Search',
    description: 'Search for people and their professional profiles',
    icon: 'Users',
    color: 'bg-indigo-100 dark:bg-indigo-800/50',
    toolClass: 'PeopleSearchTool',
    enabled: true,
    methods: [
      {
        name: 'people_search',
        displayName: 'People Search',
        description: 'Search for people and their professional profiles',
        enabled: true,
      },
    ],
  },

  company_search_tool: {
    name: 'company_search_tool',
    displayName: 'Company Search',
    description: 'Search for companies and business information',
    icon: 'Building2',
    color: 'bg-blue-100 dark:bg-blue-800/50',
    toolClass: 'CompanySearchTool',
    enabled: true,
    methods: [
      {
        name: 'company_search',
        displayName: 'Company Search',
        description: 'Search for companies and business information',
        enabled: true,
      },
    ],
  },

  paper_search_tool: {
    name: 'paper_search_tool',
    displayName: 'Paper Search',
    description: 'Search for papers using natural language queries',
    icon: 'Book',
    color: 'bg-blue-100 dark:bg-blue-800/50',
    toolClass: 'PaperSearchTool',
    enabled: true,
    methods: [
      {
        name: 'paper_search',
        displayName: 'Paper Search',
        description: 'Search for papers using natural language queries',
        enabled: true,
      },
    ],
  },

  sb_vision_tool: {
    name: 'sb_vision_tool',
    displayName: 'Vision & Image Analysis',
    description: 'Analyze images and visual content with AI',
    icon: 'Eye',
    color: 'bg-purple-100 dark:bg-purple-800/50',
    toolClass: 'SandboxVisionTool',
    enabled: true,
    methods: [
      {
        name: 'load_image',
        displayName: 'Load Image',
        description: 'Load and analyze images with AI vision',
        enabled: true,
      },
      {
        name: 'clear_images_from_context',
        displayName: 'Clear Images',
        description: 'Clear images from analysis context',
        enabled: true,
      },
    ],
  },

  sb_image_edit_tool: {
    name: 'sb_image_edit_tool',
    displayName: 'Image Editing',
    description: 'Edit and manipulate images with AI',
    icon: 'ImageIcon',
    color: 'bg-pink-100 dark:bg-pink-800/50',
    toolClass: 'SandboxImageEditTool',
    enabled: true,
    methods: [
      {
        name: 'image_edit_or_generate',
        displayName: 'Edit or Generate Image',
        description: 'Edit existing images or generate new ones with AI',
        enabled: true,
      },
    ],
  },

  browser_tool: {
    name: 'browser_tool',
    displayName: 'Browser Automation',
    description: 'Automate web browser interactions and navigation',
    icon: 'Globe',
    color: 'bg-indigo-100 dark:bg-indigo-800/50',
    toolClass: 'BrowserTool',
    enabled: true,
    methods: [
      {
        name: 'browser_navigate_to',
        displayName: 'Navigate To URL',
        description: 'Navigate browser to specific URL',
        enabled: true,
      },
      {
        name: 'browser_act',
        displayName: 'Browser Action',
        description: 'Perform actions like clicking, typing, scrolling',
        enabled: true,
      },
      {
        name: 'browser_extract_content',
        displayName: 'Extract Content',
        description: 'Extract text and data from web pages',
        enabled: true,
      },
      {
        name: 'browser_screenshot',
        displayName: 'Take Screenshot',
        description: 'Capture screenshots of web pages',
        enabled: true,
      },
    ],
  },

  sb_browser_tool: {
    name: 'sb_browser_tool',
    displayName: 'Browser Automation (Advanced)',
    description: 'Advanced browser automation with full UI interaction capabilities',
    icon: 'Globe',
    color: 'bg-cyan-100 dark:bg-cyan-800/50',
    toolClass: 'SandboxBrowserTool',
    enabled: true,
    methods: [
      {
        name: 'browser_navigate_to',
        displayName: 'Navigate To URL',
        description: 'Navigate browser to specific URL',
        enabled: true,
      },
      {
        name: 'browser_go_back',
        displayName: 'Go Back',
        description: 'Navigate back in browser history',
        enabled: true,
      },
      {
        name: 'browser_wait',
        displayName: 'Wait',
        description: 'Wait for specified number of seconds',
        enabled: true,
      },
      {
        name: 'browser_click_element',
        displayName: 'Click Element',
        description: 'Click on an element by index',
        enabled: true,
      },
      {
        name: 'browser_input_text',
        displayName: 'Input Text',
        description: 'Input text into an element',
        enabled: true,
      },
      {
        name: 'browser_send_keys',
        displayName: 'Send Keys',
        description: 'Send keyboard keys (Enter, Escape, shortcuts)',
        enabled: true,
      },
      {
        name: 'browser_switch_tab',
        displayName: 'Switch Tab',
        description: 'Switch to a different browser tab',
        enabled: true,
      },
      {
        name: 'browser_close_tab',
        displayName: 'Close Tab',
        description: 'Close a browser tab',
        enabled: true,
      },
      {
        name: 'browser_scroll_down',
        displayName: 'Scroll Down',
        description: 'Scroll down the page',
        enabled: true,
      },
      {
        name: 'browser_scroll_up',
        displayName: 'Scroll Up',
        description: 'Scroll up the page',
        enabled: true,
      },
      {
        name: 'browser_scroll_to_text',
        displayName: 'Scroll To Text',
        description: 'Scroll to specific text on the page',
        enabled: true,
      },
      {
        name: 'browser_get_dropdown_options',
        displayName: 'Get Dropdown Options',
        description: 'Get all options from a dropdown element',
        enabled: true,
      },
      {
        name: 'browser_select_dropdown_option',
        displayName: 'Select Dropdown Option',
        description: 'Select an option from a dropdown by text',
        enabled: true,
      },
      {
        name: 'browser_drag_drop',
        displayName: 'Drag and Drop',
        description: 'Perform drag and drop operation',
        enabled: true,
      },
      {
        name: 'browser_click_coordinates',
        displayName: 'Click Coordinates',
        description: 'Click at specific X,Y coordinates',
        enabled: true,
      },
    ],
  },

  sb_web_dev_tool: {
    name: 'sb_web_dev_tool',
    displayName: 'Web Development',
    description: 'Create and manage web development projects',
    icon: 'Code',
    color: 'bg-emerald-100 dark:bg-emerald-800/50',
    toolClass: 'SandboxWebDevTool',
    enabled: true,
    methods: [
      {
        name: 'create_vite_react_project',
        displayName: 'Create React Project',
        description: 'Create a new React web application',
        enabled: true,
      },
      {
        name: 'get_project_structure',
        displayName: 'Get Project Structure',
        description: 'Get the file structure of a project',
        enabled: true,
      },
      {
        name: 'build_project',
        displayName: 'Build Project',
        description: 'Build a web project for production',
        enabled: true,
      },
      {
        name: 'start_dev_server',
        displayName: 'Start Dev Server',
        description: 'Start development server',
        enabled: true,
      },
      {
        name: 'start_preview_server',
        displayName: 'Start Preview Server',
        description: 'Start preview server for built project',
        enabled: true,
      },
    ],
  },

  sb_templates_tool: {
    name: 'sb_templates_tool',
    displayName: 'Project Templates',
    description: 'Discover and scaffold web project templates',
    icon: 'Layout',
    color: 'bg-violet-100 dark:bg-violet-800/50',
    toolClass: 'SandboxTemplatesTool',
    enabled: true,
    methods: [
      {
        name: 'list_templates',
        displayName: 'List Templates',
        description: 'List available project templates',
        enabled: true,
      },
      {
        name: 'scaffold_from_template',
        displayName: 'Scaffold From Template',
        description: 'Create project from template',
        enabled: true,
      },
    ],
  },

  computer_use_tool: {
    name: 'computer_use_tool',
    displayName: 'Computer Automation',
    description: 'Automate computer interactions including GUI control',
    icon: 'Monitor',
    color: 'bg-red-100 dark:bg-red-800/50',
    toolClass: 'ComputerUseTool',
    enabled: true,
    methods: [
      {
        name: 'screenshot',
        displayName: 'Take Screenshot',
        description: 'Capture screenshot of current screen',
        enabled: true,
      },
      {
        name: 'click',
        displayName: 'Click',
        description: 'Click at coordinates or on elements',
        enabled: true,
      },
      {
        name: 'type',
        displayName: 'Type Text',
        description: 'Type text into active element',
        enabled: true,
      },
      {
        name: 'key',
        displayName: 'Press Keys',
        description: 'Press keyboard keys and shortcuts',
        enabled: true,
      },
      {
        name: 'scroll',
        displayName: 'Scroll',
        description: 'Scroll in specified direction',
        enabled: true,
      },
    ],
  },

  sb_presentation_tool: {
    name: 'sb_presentation_tool',
    displayName: 'Presentations',
    description: 'Create and manage presentations',
    icon: 'Presentation',
    color: 'bg-emerald-100 dark:bg-emerald-800/50',
    toolClass: 'SandboxPresentationTool',
    enabled: true,
    methods: [
      {
        name: 'create_slide',
        displayName: 'Create Slide',
        description: 'Create individual slides with content',
        enabled: true,
      },
      {
        name: 'list_slides',
        displayName: 'List Slides',
        description: 'List all slides in presentations',
        enabled: true,
      },
      {
        name: 'delete_slide',
        displayName: 'Delete Slide',
        description: 'Delete slides from presentations',
        enabled: true,
      },
      {
        name: 'list_presentations',
        displayName: 'List Presentations',
        description: 'List all available presentations',
        enabled: true,
      },
      {
        name: 'delete_presentation',
        displayName: 'Delete Presentation',
        description: 'Delete entire presentations',
        enabled: true,
      },
    ],
  },

  sb_sheets_tool: {
    name: 'sb_sheets_tool',
    displayName: 'Spreadsheets',
    description: 'Create and manipulate spreadsheet data',
    icon: 'Table',
    color: 'bg-green-100 dark:bg-green-800/50',
    toolClass: 'SandboxSheetsTool',
    enabled: true,
    methods: [
      {
        name: 'update_sheet',
        displayName: 'Update Sheet',
        description: 'Update spreadsheet cells and data',
        enabled: true,
      },
      {
        name: 'view_sheet',
        displayName: 'View Sheet',
        description: 'View and read spreadsheet data',
        enabled: true,
      },
      {
        name: 'create_sheet',
        displayName: 'Create Sheet',
        description: 'Create new spreadsheets',
        enabled: true,
      },
      {
        name: 'analyze_sheet',
        displayName: 'Analyze Sheet',
        description: 'Analyze spreadsheet data and patterns',
        enabled: true,
      },
      {
        name: 'visualize_sheet',
        displayName: 'Visualize Sheet',
        description: 'Create visualizations from spreadsheet data',
        enabled: true,
      },
      {
        name: 'format_sheet',
        displayName: 'Format Sheet',
        description: 'Format spreadsheet appearance and styling',
        enabled: true,
      },
    ],
  },

  message_tool: {
    name: 'message_tool',
    displayName: 'User Communication',
    description: 'Enhanced communication tools for user interaction',
    icon: 'MessageSquare',
    color: 'bg-blue-100 dark:bg-blue-800/50',
    toolClass: 'MessageTool',
    enabled: true,
    isCore: true,
    methods: [
      {
        name: 'ask',
        displayName: 'Ask Question',
        description: 'Ask users questions during task execution',
        enabled: true,
        isCore: true,
      },
      {
        name: 'web_browser_takeover',
        displayName: 'Request Browser Takeover',
        description: 'Request user takeover of browser interaction',
        enabled: true,
      },
      {
        name: 'present_presentation',
        displayName: 'Present Presentation',
        description: 'Present completed presentations to user',
        enabled: true,
      },
      {
        name: 'complete',
        displayName: 'Complete Task',
        description: 'Signal task completion and enter complete state',
        enabled: true,
        isCore: true,
      },
      {
        name: 'wait',
        displayName: 'Wait',
        description: 'Pause execution for specified duration',
        enabled: true,
      },
    ],
  },

  task_list_tool: {
    name: 'task_list_tool',
    displayName: 'Task Management',
    description: 'Create and manage task lists',
    icon: 'ListTodo',
    color: 'bg-green-100 dark:bg-green-800/50',
    toolClass: 'TaskListTool',
    enabled: true,
    isCore: true,
    methods: [
      {
        name: 'create_task_list',
        displayName: 'Create Task List',
        description: 'Create and manage task lists',
        enabled: true,
        isCore: true,
      },
    ],
  },

  expand_message_tool: {
    name: 'expand_message_tool',
    displayName: 'Message Expansion',
    description: 'Expand truncated messages from conversations',
    icon: 'Expand',
    color: 'bg-purple-100 dark:bg-purple-800/50',
    toolClass: 'ExpandMessageTool',
    enabled: true,
    isCore: true,
    methods: [
      {
        name: 'expand_message',
        displayName: 'Expand Message',
        description: 'Expand truncated messages',
        enabled: true,
        isCore: true,
      },
    ],
  },

  data_providers_tool: {
    name: 'data_providers_tool',
    displayName: 'Data Providers',
    description: 'Access external data sources and services',
    icon: 'Link',
    color: 'bg-cyan-100 dark:bg-cyan-800/50',
    toolClass: 'DataProvidersTool',
    enabled: true,
    methods: [
      {
        name: 'get_data_provider_endpoints',
        displayName: 'Get Data Provider Endpoints',
        description: 'List available data provider endpoints',
        enabled: true,
      },
      {
        name: 'execute_data_provider_call',
        displayName: 'Execute Data Provider Call',
        description: 'Execute calls to external data providers',
        enabled: true,
      },
    ],
  },

  agent_config_tool: {
    name: 'agent_config_tool',
    displayName: 'Agent Configuration',
    description: 'Configure agent settings, tools, and integrations',
    icon: 'Settings',
    color: 'bg-gray-100 dark:bg-gray-800/50',
    toolClass: 'AgentConfigTool',
    enabled: true,
    methods: [
      {
        name: 'update_agent',
        displayName: 'Update Agent',
        description: 'Update agent configuration and settings',
        enabled: true,
      },
      {
        name: 'get_current_agent_config',
        displayName: 'Get Agent Config',
        description: 'Get current agent configuration',
        enabled: true,
      },
    ],
  },

  mcp_search_tool: {
    name: 'mcp_search_tool',
    displayName: 'MCP Search',
    description: 'Search and discover MCP servers and integrations',
    icon: 'Search',
    color: 'bg-teal-100 dark:bg-teal-800/50',
    toolClass: 'MCPSearchTool',
    enabled: true,
    methods: [
      {
        name: 'search_mcp_servers',
        displayName: 'Search MCP Servers',
        description: 'Search for available MCP server integrations',
        enabled: true,
      },
      {
        name: 'get_app_details',
        displayName: 'Get App Details',
        description: 'Get detailed information about MCP apps',
        enabled: true,
      },
      {
        name: 'discover_user_mcp_servers',
        displayName: 'Discover User MCP Servers',
        description: 'Discover user\'s available MCP servers',
        enabled: true,
      },
    ],
  },

  credential_profile_tool: {
    name: 'credential_profile_tool',
    displayName: 'Credential Management',
    description: 'Manage credential profiles for secure authentication',
    icon: 'KeyRound',
    color: 'bg-red-100 dark:bg-red-800/50',
    toolClass: 'CredentialProfileTool',
    enabled: true,
    methods: [
      {
        name: 'get_credential_profiles',
        displayName: 'Get Credential Profiles',
        description: 'List all available credential profiles',
        enabled: true,
      },
      {
        name: 'create_credential_profile',
        displayName: 'Create Credential Profile',
        description: 'Create new credential profiles for authentication',
        enabled: true,
      },
      {
        name: 'configure_profile_for_agent',
        displayName: 'Configure Profile for Agent',
        description: 'Configure credential profile for agent use',
        enabled: true,
      },
      {
        name: 'delete_credential_profile',
        displayName: 'Delete Credential Profile',
        description: 'Delete existing credential profiles',
        enabled: true,
      },
    ],
  },

  trigger_tool: {
    name: 'trigger_tool',
    displayName: 'Triggers',
    description: 'Create and manage automated triggers',
    icon: 'Zap',
    color: 'bg-yellow-100 dark:bg-yellow-800/50',
    toolClass: 'TriggerTool',
    enabled: true,
    methods: [
      {
        name: 'create_scheduled_trigger',
        displayName: 'Create Scheduled Trigger',
        description: 'Create time-based scheduled triggers',
        enabled: true,
      },
      {
        name: 'get_scheduled_triggers',
        displayName: 'Get Scheduled Triggers',
        description: 'List all scheduled triggers',
        enabled: true,
      },
      {
        name: 'delete_scheduled_trigger',
        displayName: 'Delete Scheduled Trigger',
        description: 'Delete scheduled triggers',
        enabled: true,
      },
      {
        name: 'toggle_scheduled_trigger',
        displayName: 'Toggle Scheduled Trigger',
        description: 'Enable or disable scheduled triggers',
        enabled: true,
      },
      {
        name: 'list_event_trigger_apps',
        displayName: 'List Event Trigger Apps',
        description: 'List available apps for event triggers',
        enabled: true,
      },
      {
        name: 'list_app_event_triggers',
        displayName: 'List App Event Triggers',
        description: 'List event triggers for specific apps',
        enabled: true,
      },
      {
        name: 'create_event_trigger',
        displayName: 'Create Event Trigger',
        description: 'Create event-based triggers',
        enabled: true,
      },
    ],
  },

  agent_creation_tool: {
    name: 'agent_creation_tool',
    displayName: 'Agent Creation (Suna)',
    description: 'Comprehensive agent creation and management (Suna only)',
    icon: 'Plus',
    color: 'bg-indigo-100 dark:bg-indigo-800/50',
    toolClass: 'AgentCreationTool',
    enabled: true,
    methods: [
      {
        name: 'create_new_agent',
        displayName: 'Create New Agent',
        description: 'Create completely new AI agents',
        enabled: true,
      },
      {
        name: 'search_mcp_servers_for_agent',
        displayName: 'Search MCP Servers',
        description: 'Search MCP servers for agent integration',
        enabled: true,
      },
      {
        name: 'get_mcp_server_details',
        displayName: 'Get MCP Server Details',
        description: 'Get detailed MCP server information',
        enabled: true,
      },
      {
        name: 'create_credential_profile_for_agent',
        displayName: 'Create Credential Profile',
        description: 'Create credential profiles for agents',
        enabled: true,
      },
      {
        name: 'discover_mcp_tools_for_agent',
        displayName: 'Discover MCP Tools',
        description: 'Discover available MCP tools for agents',
        enabled: true,
      },
      {
        name: 'configure_agent_integration',
        displayName: 'Configure Agent Integration',
        description: 'Configure integrations for new agents',
        enabled: true,
      },
      {
        name: 'create_agent_scheduled_trigger',
        displayName: 'Create Scheduled Trigger',
        description: 'Create scheduled triggers for agents',
        enabled: true,
      },
      {
        name: 'list_agent_scheduled_triggers',
        displayName: 'List Scheduled Triggers',
        description: 'List agent scheduled triggers',
        enabled: true,
      },
      {
        name: 'toggle_agent_scheduled_trigger',
        displayName: 'Toggle Scheduled Trigger',
        description: 'Enable/disable agent scheduled triggers',
        enabled: true,
      },
      {
        name: 'delete_agent_scheduled_trigger',
        displayName: 'Delete Scheduled Trigger',
        description: 'Delete agent scheduled triggers',
        enabled: true,
      },
      {
        name: 'update_agent_config',
        displayName: 'Update Agent Config',
        description: 'Update existing agent configurations',
        enabled: true,
      },
    ],
  },

  sb_deploy_tool: {
    name: 'sb_deploy_tool',
    displayName: 'Deployment',
    description: 'Deploy applications and services',
    icon: 'Rocket',
    color: 'bg-green-100 dark:bg-green-800/50',
    toolClass: 'SandboxDeployTool',
    enabled: true,
    methods: [
      {
        name: 'deploy',
        displayName: 'Deploy Application',
        description: 'Deploy applications and services',
        enabled: true,
      },
    ],
  },

  sb_expose_tool: {
    name: 'sb_expose_tool',
    displayName: 'Port Management',
    description: 'Expose services and manage ports',
    icon: 'Plug',
    color: 'bg-orange-100 dark:bg-orange-800/20',
    toolClass: 'SandboxExposeTool',
    enabled: true,
    methods: [
      {
        name: 'expose_port',
        displayName: 'Expose Port',
        description: 'Expose services on specific ports',
        enabled: true,
      },
    ],
  },

  image_search_tool: {
    name: 'image_search_tool',
    displayName: 'Image Search',
    description: 'Search for images on the web',
    icon: 'Image',
    color: 'bg-indigo-100 dark:bg-indigo-800/50',
    toolClass: 'SandboxImageSearchTool',
    enabled: true,
    methods: [
      {
        name: 'image_search',
        displayName: 'Image Search',
        description: 'Search for images with batch support',
        enabled: true,
      },
    ],
  },

//   sb_document_parser_tool: {
//     name: 'sb_document_parser_tool',
//     displayName: 'Document Parser',
//     description: 'Parse documents using Chunkr AI',
//     icon: 'FileText',
//     color: 'bg-gray-100 dark:bg-gray-800/50',
//     toolClass: 'SandboxDocumentParserTool',
//     enabled: true,
//     methods: [
//       {
//         name: 'parse_document',
//         displayName: 'Parse Document',
//         description: 'Parse documents using Chunkr AI',
//         enabled: true,
//       },
//     ],
//   },

  sb_kb_tool: {
    name: 'sb_kb_tool',
    displayName: 'Knowledge Base',
    description: 'Manage knowledge base content',
    icon: 'Database',
    color: 'bg-blue-100 dark:bg-blue-800/50',
    toolClass: 'SandboxKbTool',
    enabled: true,
    methods: [
      {
        name: 'init_kb',
        displayName: 'Initialize Knowledge Base',
        description: 'Initialize the kb-fusion binary and optionally sync knowledge base',
        enabled: true,
      },
      {
        name: 'search_files',
        displayName: 'Search Files',
        description: 'Perform semantic search on files using kb-fusion',
        enabled: true,
      },
      {
        name: 'cleanup_kb',
        displayName: 'Cleanup Knowledge Base',
        description: 'Perform maintenance and cleanup operations',
        enabled: true,
      },
      {
        name: 'ls_kb',
        displayName: 'List Knowledge Base Files',
        description: 'List indexed files in the knowledge base',
        enabled: true,
      },
      {
        name: 'global_kb_sync',
        displayName: 'Sync Global Knowledge Base',
        description: 'Sync agent\'s knowledge base files to sandbox',
        enabled: true,
      },
      {
        name: 'global_kb_create_folder',
        displayName: 'Create Knowledge Base Folder',
        description: 'Create a new folder in the global knowledge base',
        enabled: true,
      },
      {
        name: 'global_kb_upload_file',
        displayName: 'Upload File to Knowledge Base',
        description: 'Upload a file from sandbox to the global knowledge base',
        enabled: true,
      },
      {
        name: 'global_kb_delete_item',
        displayName: 'Delete Knowledge Base Item',
        description: 'Delete a file or folder from the global knowledge base',
        enabled: true,
      },
      {
        name: 'global_kb_enable_item',
        displayName: 'Enable/Disable Knowledge Base Item',
        description: 'Enable or disable a knowledge base file for this agent',
        enabled: true,
      },
      {
        name: 'global_kb_list_contents',
        displayName: 'List Knowledge Base Contents',
        description: 'List all folders and files in the global knowledge base',
        enabled: true,
      },
    ],
  },

  sb_design_tool: {
    name: 'sb_design_tool',
    displayName: 'Design Tool',
    description: 'Create and edit design elements',
    icon: 'Paintbrush',
    color: 'bg-purple-100 dark:bg-purple-800/50',
    toolClass: 'SandboxDesignerTool',
    enabled: true,
    methods: [
      {
        name: 'designer_create_or_edit',
        displayName: 'Create or Edit Design',
        description: 'Create new designs or edit existing ones',
        enabled: true,
      },
    ],
  },

  sb_presentation_outline_tool: {
    name: 'sb_presentation_outline_tool',
    displayName: 'Presentation Outline',
    description: 'Create structured presentation outlines',
    icon: 'ClipboardList',
    color: 'bg-purple-100 dark:bg-purple-800/50',
    toolClass: 'SandboxPresentationOutlineTool',
    enabled: true,
    methods: [
      {
        name: 'create_outline',
        displayName: 'Create Outline',
        description: 'Create presentation outlines',
        enabled: true,
      },
    ],
  },

  sb_upload_file_tool: {
    name: 'sb_upload_file_tool',
    displayName: 'File Upload',
    description: 'Upload files to the workspace',
    icon: 'Upload',
    color: 'bg-green-100 dark:bg-green-800/50',
    toolClass: 'SandboxUploadFileTool',
    enabled: true,
    methods: [
      {
        name: 'upload_file',
        displayName: 'Upload File',
        description: 'Upload files to workspace',
        enabled: true,
      },
    ],
  },

  sb_docs_tool: {
    name: 'sb_docs_tool',
    displayName: 'Document Editor',
    description: 'Create and edit rich text documents',
    icon: 'FileText',
    color: 'bg-gray-100 dark:bg-gray-800/50',
    toolClass: 'SandboxDocsTool',
    enabled: true,
    methods: [
      {
        name: 'create_document',
        displayName: 'Create Document',
        description: 'Create new documents with rich text content',
        enabled: true,
      },
      {
        name: 'read_document',
        displayName: 'Read Document',
        description: 'Read the content of a document',
        enabled: true,
      },
      {
        name: 'list_documents',
        displayName: 'List Documents',
        description: 'List all documents in the workspace',
        enabled: true,
      },
      {
        name: 'delete_document',
        displayName: 'Delete Document',
        description: 'Delete a document from the workspace',
        enabled: true,
      },
      {
        name: 'get_format_guide',
        displayName: 'Get Format Guide',
        description: 'Get TipTap-compatible HTML format guide',
        enabled: true,
      },
    ],
  },
};

export function getToolGroup(toolName: string): ToolGroup | undefined {
  return TOOL_GROUPS[toolName];
}

export function getAllToolGroups(): Record<string, ToolGroup> {
  return TOOL_GROUPS;
}

export function hasGranularControl(toolName: string): boolean {
  const group = getToolGroup(toolName);
  return group ? group.methods.length > 1 : false;
}

export function getEnabledMethodsForTool(toolName: string, config: any): string[] {
  const toolGroup = getToolGroup(toolName);
  if (!toolGroup) {
    return [];
  }

  const toolConfig = config[toolName];
  if (typeof toolConfig === 'boolean' && !toolConfig) {
    return [];
  }

  if (toolConfig === true || toolConfig === undefined) {
    return toolGroup.methods.filter(method => method.enabled).map(method => method.name);
  }

  if (typeof toolConfig === 'object' && toolConfig !== null) {
    if (!toolConfig.enabled) {
      return [];
    }

    const methodsConfig = toolConfig.methods || {};
    const enabledMethods: string[] = [];

    for (const method of toolGroup.methods) {
      let methodEnabled = method.enabled;
      if (method.name in methodsConfig) {
        const methodConfig = methodsConfig[method.name];
        if (typeof methodConfig === 'boolean') {
          methodEnabled = methodConfig;
        } else if (typeof methodConfig === 'object' && methodConfig !== null) {
          methodEnabled = methodConfig.enabled ?? method.enabled;
        }
      }

      if (methodEnabled) {
        enabledMethods.push(method.name);
      }
    }

    return enabledMethods;
  }

 
  return toolGroup.methods.filter(method => method.enabled).map(method => method.name);
}

export function validateToolConfig(config: Record<string, any>): Record<string, any> {
  const normalizedConfig: Record<string, any> = {};

  for (const [toolName, toolConfig] of Object.entries(config)) {
    const toolGroup = getToolGroup(toolName);
    if (!toolGroup) {
      normalizedConfig[toolName] = toolConfig;
      continue;
    }


    if (toolGroup.isCore) {
      normalizedConfig[toolName] = true;
      continue;
    }

    if (typeof toolConfig === 'boolean') {
      normalizedConfig[toolName] = toolConfig;
    } else if (typeof toolConfig === 'object' && toolConfig !== null) {
      const validatedConfig: any = {
        enabled: toolConfig.enabled ?? true,
        methods: {},
      };

      const methodsConfig = toolConfig.methods || {};
      for (const method of toolGroup.methods) {
        if (method.name in methodsConfig) {
          const methodConfig = methodsConfig[method.name];
          if (typeof methodConfig === 'boolean') {
            validatedConfig.methods[method.name] = methodConfig;
          } else if (typeof methodConfig === 'object' && methodConfig !== null) {
            validatedConfig.methods[method.name] = {
              enabled: methodConfig.enabled ?? method.enabled,
            };
          } else {
            validatedConfig.methods[method.name] = method.enabled;
          }
        } else {
          validatedConfig.methods[method.name] = method.enabled;
        }
      }

      normalizedConfig[toolName] = validatedConfig;
    } else {
      normalizedConfig[toolName] = true;
    }
  }

  return normalizedConfig;
}

export function convertLegacyToolConfig(legacyTools: Record<string, boolean | { enabled: boolean; description: string }>): Record<string, any> {
  const convertedConfig: Record<string, any> = {};

  for (const [toolName, toolConfig] of Object.entries(legacyTools)) {
    const toolGroup = getToolGroup(toolName);
    
    if (!toolGroup) {
      convertedConfig[toolName] = toolConfig;
      continue;
    }

    if (typeof toolConfig === 'boolean') {
      convertedConfig[toolName] = toolConfig;
    } else if (typeof toolConfig === 'object' && 'enabled' in toolConfig) {
      convertedConfig[toolName] = toolConfig.enabled;
    } else {
      convertedConfig[toolName] = true;
    }
  }

  return convertedConfig;
}