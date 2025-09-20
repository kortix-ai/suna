export const AGENTPRESS_TOOL_DEFINITIONS: Record<string, { enabled: boolean; description: string; icon: string; color: string }> = {
    // Core sandbox tools
    'sb_shell_tool': { enabled: true, description: 'Execute shell commands in tmux sessions for terminal operations, CLI tools, and system management', icon: '💻', color: 'bg-slate-100 dark:bg-slate-800' },
    'sb_files_tool': { enabled: true, description: 'Create, read, update, and delete files in the workspace with comprehensive file management', icon: '📁', color: 'bg-blue-100 dark:bg-blue-800/50' },
    'sb_deploy_tool': { enabled: true, description: 'Deploy applications and services with automated deployment capabilities', icon: '🚀', color: 'bg-green-100 dark:bg-green-800/50' },
    'sb_expose_tool': { enabled: true, description: 'Expose services and manage ports for application accessibility', icon: '🔌', color: 'bg-orange-100 dark:bg-orange-800/20' },
    'web_search_tool': { enabled: true, description: 'Search the web using Tavily API and scrape webpages with Firecrawl for research', icon: '🔍', color: 'bg-yellow-100 dark:bg-yellow-800/50' },
    'sb_vision_tool': { enabled: true, description: 'Vision and image processing capabilities for visual content analysis', icon: '👁️', color: 'bg-pink-100 dark:bg-pink-800/50' },
    'sb_image_edit_tool': { enabled: true, description: 'Generate new images or edit existing images using OpenAI GPT Image 1', icon: '🎨', color: 'bg-purple-100 dark:bg-purple-800/50' },
    'sb_presentation_outline_tool': { enabled: false, description: 'Create structured presentation outlines with slide descriptions and speaker notes', icon: '📋', color: 'bg-purple-100 dark:bg-purple-800/50' },
    'sb_presentation_tool': { enabled: false, description: 'Create professional presentations with HTML slides, preview, and export capabilities', icon: '📊', color: 'bg-violet-100 dark:bg-violet-800/50' },

    'sb_docs_tool': { enabled: false, description: 'Create, read, update, and delete documents with TipTap editor', icon: '📄', color: 'bg-gray-100 dark:bg-gray-800/50' },
    'sb_design_tool': { enabled: false, description: 'Create, read, update, and delete documents with TipTap editor', icon: '🎨', color: 'bg-gray-100 dark:bg-gray-800/50' },

    'sb_sheets_tool': { enabled: false, description: 'Create, view, update, analyze, visualize, and format spreadsheets (XLSX/CSV) with Luckysheet viewer', icon: '📊', color: 'bg-purple-100 dark:bg-purple-800/50' },
    // 'sb_web_dev_tool': { enabled: false, description: 'Create Next.js projects with shadcn/ui pre-installed, manage dependencies, build and deploy modern web applications', icon: '⚛️', color: 'bg-cyan-100 dark:bg-cyan-800/50' },
    
    // Browser and interaction tools
    'browser_tool': { enabled: true, description: 'Browser automation for web navigation, clicking, form filling, and page interaction', icon: '🌐', color: 'bg-indigo-100 dark:bg-indigo-800/50' },
    
    // Data provider tools
    'data_providers_tool': { enabled: true, description: 'Access to data providers and external APIs', icon: '🔗', color: 'bg-cyan-100 dark:bg-cyan-800/50' },
    
    // Agent self-configuration tools
    'agent_config_tool': { enabled: true, description: 'Configure agent settings, tools, and integrations', icon: '⚙️', color: 'bg-gray-100 dark:bg-gray-800/50' },
    'mcp_search_tool': { enabled: true, description: 'Search and discover MCP servers and integrations for external services', icon: '🔍', color: 'bg-teal-100 dark:bg-teal-800/50' },
    'credential_profile_tool': { enabled: true, description: 'Manage credential profiles for secure integration authentication', icon: '🔐', color: 'bg-red-100 dark:bg-red-800/50' },
    'workflow_tool': { enabled: true, description: 'Create and manage automated workflows and task sequences', icon: '🔄', color: 'bg-emerald-100 dark:bg-emerald-800/50' },
    'trigger_tool': { enabled: true, description: 'Set up event triggers and scheduled automation', icon: '⏰', color: 'bg-amber-100 dark:bg-amber-800/50' },
};

export const DEFAULT_AGENTPRESS_TOOLS: Record<string, boolean> = Object.entries(AGENTPRESS_TOOL_DEFINITIONS).reduce((acc, [key, value]) => {
  acc[key] = value.enabled;
  return acc;
}, {} as Record<string, boolean>);

export const getToolDisplayName = (toolName: string): string => {
    const displayNames: Record<string, string> = {
      // Core sandbox tools
      'sb_shell_tool': 'Terminal',
      'sb_files_tool': 'File Manager',
      'sb_deploy_tool': 'Deploy Tool',
      'sb_expose_tool': 'Port Exposure',
      'web_search_tool': 'Web Search',
      'sb_vision_tool': 'Image Processing',
      'sb_image_edit_tool': 'Image Editor',
      'sb_presentation_outline_tool': 'Presentation Outline',
      'sb_presentation_tool': 'Presentation Creator',
      'sb_docs_tool': 'Document Editor',
      'sb_design_tool': 'Design Tool',

      'sb_sheets_tool': 'Spreadsheets',
      
      'browser_tool': 'Browser Automation',
      
      'data_providers_tool': 'Data Providers',
      
      'agent_config_tool': 'Agent Configuration',
      'mcp_search_tool': 'MCP Server Search',
      'credential_profile_tool': 'Credential Profiles',
      'workflow_tool': 'Workflow Management',
      'trigger_tool': 'Trigger Management',
    };
    
    return displayNames[toolName] || toolName.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
  };