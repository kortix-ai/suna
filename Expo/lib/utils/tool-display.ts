import {
  Globe,
  FileEdit,
  FileSearch,
  FilePlus,
  FileText,
  FileX,
  List,
  ListTodo,
  Terminal,
  Computer,
  Search,
  ExternalLink,
  Network,
  Table2,
  Code,
  Phone,
  PhoneOff,
  MessageCircleQuestion,
  CheckCircle2,
  Wrench,
  BookOpen,
  Plug,
  Clock,
  type LucideIcon,
  Presentation,
  ImageIcon,
  Pencil,
} from 'lucide-react-native';

export const getToolIcon = (toolName: string): LucideIcon => {
  switch (toolName?.toLowerCase()) {
    case 'browser-navigate-to':
    case 'browser-act':
    case 'browser-extract-content':
    case 'browser-screenshot':
    case 'browser_navigate_to':
    case 'browser_act':
    case 'browser_extract_content':
    case 'browser_screenshot':
      return Globe;

    case 'create-tasks':
        return ListTodo;

    case 'web-search':
    case 'web_search':
        return Globe;
    case 'image-search':
    case 'image_search':
      return ImageIcon;

    case 'create-file':
      return FileEdit;
    case 'str-replace':
      return FileSearch;
    case 'full-file-rewrite':
      return FilePlus;
    case 'read-file':
      return FileText;
    case 'edit-file':
      return FileEdit;

    case 'designer-create-or-edit':
      return Pencil;
    case 'image-edit-or-generate':
      return Pencil;

    case 'parse-document':
    case 'parse_document':
      return FileText;
    case 'create-document':
    case 'create_document':
      return FileEdit;
    case 'update-document':
    case 'update_document':
      return FileEdit;
    case 'read-document':
    case 'read_document':
      return FileText;

    case 'create-tasks':
    case 'create_tasks':
      return List;
    case 'update-tasks':
    case 'update_tasks':
      return ListTodo;

    case 'execute-command':
    case 'execute_command':
    case 'check-command-output':
    case 'check_command_output':
    case 'terminate-command':
    case 'terminate_command':
      return Terminal;

    case 'expose-port':
    case 'expose_port':
      return Computer;

    case 'web-search':
    case 'web_search':
    case 'image-search':
    case 'image_search':
      return Search;
    case 'crawl-webpage':
    case 'crawl_webpage':
    case 'scrape-webpage':
    case 'scrape_webpage':
      return Globe;

    case 'call-data-provider':
    case 'call_data_provider':
      return ExternalLink;
    case 'get-data-provider-endpoints':
    case 'get_data_provider_endpoints':
    case 'execute-data-provider-call':
    case 'execute_data_provider_call':
      return Network;

    case 'create-sheet':
    case 'create_sheet':
    case 'update-sheet':
    case 'update_sheet':
    case 'view-sheet':
    case 'view_sheet':
    case 'analyze-sheet':
    case 'analyze_sheet':
    case 'visualize-sheet':
    case 'visualize_sheet':
    case 'format-sheet':
    case 'format_sheet':
      return Table2;

    case 'delete-file':
    case 'delete_file':
      return FileX;

    case 'execute-code':
    case 'execute_code':
      return Code;

    case 'make-phone-call':
    case 'make_phone_call':
    case 'get-call-details':
    case 'get_call_details':
    case 'list-calls':
    case 'list_calls':
    case 'monitor-call':
    case 'monitor_call':
      return Phone;
    case 'end-call':
    case 'end_call':
      return PhoneOff;
    case 'wait-for-call-completion':
    case 'wait_for_call_completion':
      return Clock;

    case 'ask':
      return MessageCircleQuestion;

    case 'complete':
      return CheckCircle2;

    case 'create-presentation-outline':
    case 'create_presentation_outline':
      return Presentation;
    
    case 'get-paper-details':
        return BookOpen;
    case 'search-authors':
        return Search;
    case 'get-author-details':
        return BookOpen;
    case 'get-author-papers':
        return BookOpen;
    case 'get-paper-citations':
        return BookOpen;
    case 'get-paper-references':
        return BookOpen;
    case 'paper-search':
        return Search;
    
    case 'create-slide':
      return Presentation;


    default:
      if (toolName?.startsWith('mcp_')) {
        const parts = toolName.split('_');
        if (parts.length >= 3) {
          const serverName = parts[1];
          const toolNamePart = parts.slice(2).join('_');
          
          if (toolNamePart.includes('search') || toolNamePart.includes('web')) {
            return Search;
          } else if (toolNamePart.includes('research') || toolNamePart.includes('paper')) {
            return BookOpen;
          } else if (serverName === 'exa') {
            return Search;
          }
        }
        return Plug;
      }
      
      return Wrench;
  }
};

const TOOL_DISPLAY_NAMES = new Map([
  ['execute-command', 'Executing Command'],
  ['check-command-output', 'Checking Command Output'],
  ['terminate-command', 'Terminating Command'],
  ['list-commands', 'Listing Commands'],
  
  ['create-file', 'Creating File'],
  ['delete-file', 'Deleting File'],
  ['full-file-rewrite', 'Rewriting File'],
  ['str-replace', 'Editing Text'],
  ['str_replace', 'Editing Text'],
  ['edit_file', 'Editing File'],
  ['edit-file', 'Editing File'],
  ['upload-file', 'Uploading File'],

  ['create-document', 'Creating Document'],
  ['update-document', 'Updating Document'],
  ['read-document', 'Reading Document'],
  ['list-documents', 'Listing Documents'],
  ['delete-document', 'Deleting Document'],

  ['create-tasks', 'Creating Tasks'],
  ['update-tasks', 'Updating Tasks'],
  
  ['browser_navigate_to', 'Navigating to Page'],
  ['browser_act', 'Performing Action'],
  ['browser_extract_content', 'Extracting Content'],
  ['browser_screenshot', 'Taking Screenshot'],
  ['browser-navigate-to', 'Navigating to Page'],
  ['browser-act', 'Performing Action'],
  ['browser-extract-content', 'Extracting Content'],
  ['browser-screenshot', 'Taking Screenshot'],

  ['execute-data-provider-call', 'Calling data provider'],
  ['execute_data-provider_call', 'Calling data provider'],
  ['get-data-provider-endpoints', 'Getting endpoints'],
  
  ['ask', 'Ask'],
  ['wait', 'Wait'],
  ['complete', 'Completing Task'],
  ['crawl-webpage', 'Crawling Website'],
  ['expose-port', 'Exposing Port'],
  ['scrape-webpage', 'Scraping Website'],
  ['web-search', 'Searching Web'],
  ['load-image', 'Loading Image'],
  ['create-presentation-outline', 'Creating Presentation Outline'],
  ['create-presentation', 'Creating Presentation'],
  ['present-presentation', 'Presenting'],
  ['clear-images-from-context', 'Clearing Images from context'],
  ['image-search', 'Searching Image'],

  ['create-sheet', 'Creating Sheet'],
  ['update-sheet', 'Updating Sheet'],
  ['view-sheet', 'Viewing Sheet'],
  ['analyze-sheet', 'Analyzing Sheet'],
  ['visualize-sheet', 'Visualizing Sheet'],
  ['format-sheet', 'Formatting Sheet'],

  ['update-agent', 'Updating Agent'],
  ['get-current-agent-config', 'Getting Agent Config'],
  ['search-mcp-servers', 'Searching MCP Servers'],
  ['get-mcp-server-tools', 'Getting MCP Server Tools'],
  ['configure-mcp-server', 'Configuring MCP Server'],
  ['get-popular-mcp-servers', 'Getting Popular MCP Servers'],
  ['test-mcp-server-connection', 'Testing MCP Server Connection'],
  ['list_app_event_triggers', 'Finding event triggers'],
  ['list-app-event-triggers', 'Finding event triggers'],
  ['create-event-trigger', 'Creating event trigger'],
  ['create_event_trigger', 'Creating event trigger'],

  ['get-project-structure', 'Getting Project Structure'],
  ['build-project', 'Building Project'],

  ['execute_command', 'Executing Command'],
  ['check_command_output', 'Checking Command Output'],
  ['terminate_command', 'Terminating Command'],
  ['list_commands', 'Listing Commands'],
  
  ['create_file', 'Creating File'],
  ['delete_file', 'Deleting File'],
  ['full_file_rewrite', 'Rewriting File'],
  ['str_replace', 'Editing Text'],
  ['edit_file', 'Editing File'],

  ['execute_data_provider_call', 'Calling data provider'],
  ['get_data_provider_endpoints', 'Getting endpoints'],
  
  ['get-paper-details', 'Getting Paper Details'],
  ['search-authors', 'Searching Authors'],
  ['get-author-details', 'Getting Author Details'],
  ['get-author-papers', 'Getting Author Papers'],
  ['get-paper-citations', 'Getting Paper Citations'],
  ['get-paper-references', 'Getting Paper References'],
  ['paper-search', 'Searching for Papers'],
  
  ['crawl_webpage', 'Crawling Website'],
  ['expose_port', 'Exposing Port'],
  ['scrape_webpage', 'Scraping Website'],
  ['web_search', 'Searching Web'],
  ['load_image', 'Loading Image'],
  
  ['update_agent', 'Updating Agent'],
  ['get_current_agent_config', 'Getting Agent Config'],
  ['search_mcp_servers', 'Searching MCP Servers'],
  ['get_popular_mcp_servers', 'Getting Popular MCP Servers'],
  ['test_mcp_server_connection', 'Testing MCP Server Connection'],
  ['discover-user-mcp-servers', 'Discovering tools'],
  ['create-credential-profile', 'Creating profile'],
  ['get-credential-profiles', 'Getting profiles'],
  ['configure-profile-for-agent', 'Adding tools to agent'],

  ['create-new-agent', 'Creating New Agent'],
  ['search-mcp-servers-for-agent', 'Searching MCP Servers'],
  ['create-credential-profile-for-agent', 'Creating Credential Profile'],
  ['discover-mcp-tools-for-agent', 'Discovering MCP Tools'],
  ['configure-agent-integration', 'Configuring Agent Integration'],
  ['create-agent-scheduled-trigger', 'Creating Scheduled Trigger'],
  ['list-agent-scheduled-triggers', 'Listing Agent Scheduled Triggers'],

  ['make-phone-call', 'Making Phone Call'],
  ['make_phone_call', 'Making Phone Call'],
  ['end-call', 'Ending Call'],
  ['end_call', 'Ending Call'],
  ['get-call-details', 'Getting Call Details'],
  ['get_call_details', 'Getting Call Details'],
  ['list-calls', 'Listing Calls'],
  ['list_calls', 'Listing Calls'],
  ['monitor-call', 'Monitoring Call'],
  ['monitor_call', 'Monitoring Call'],
  ['wait-for-call-completion', 'Waiting for Completion'],
  ['wait_for_call_completion', 'Waiting for Completion'],

  ['create-slide', 'Creating Slide'],
  ['create_slide', 'Creating Slide'],

  ['designer-create-or-edit', 'Designing'],
]);

function formatMCPToolName(serverName: string, toolName: string): string {
  const serverMappings: Record<string, string> = {
    'exa': 'Exa Search',
    'github': 'GitHub',
    'notion': 'Notion', 
    'slack': 'Slack',
    'filesystem': 'File System',
    'memory': 'Memory',
    'anthropic': 'Anthropic',
    'openai': 'OpenAI',
    'composio': 'Composio',
    'langchain': 'LangChain',
    'llamaindex': 'LlamaIndex'
  };
  
  const formattedServerName = serverMappings[serverName.toLowerCase()] || 
    serverName.charAt(0).toUpperCase() + serverName.slice(1);
  
  let formattedToolName = toolName;
  
  if (toolName.includes('-')) {
    formattedToolName = toolName
      .split('-')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }
  else if (toolName.includes('_')) {
    formattedToolName = toolName
      .split('_')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }
  else if (/[a-z][A-Z]/.test(toolName)) {
    formattedToolName = toolName
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .split(' ')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }
  else {
    formattedToolName = toolName.charAt(0).toUpperCase() + toolName.slice(1);
  }
  
  return `${formattedServerName}: ${formattedToolName}`;
}

export function getUserFriendlyToolName(toolName: string): string {
  if (toolName.startsWith('mcp_')) {
    const parts = toolName.split('_');
    if (parts.length >= 3) {
      const serverName = parts[1];
      const toolNamePart = parts.slice(2).join('_');
      return formatMCPToolName(serverName, toolNamePart);
    }
  }
  if (toolName.includes('-') && !TOOL_DISPLAY_NAMES.has(toolName)) {
    const parts = toolName.split('-');
    if (parts.length >= 2) {
      const serverName = parts[0];
      const toolNamePart = parts.slice(1).join('-');
      return formatMCPToolName(serverName, toolNamePart);
    }
  }
  return TOOL_DISPLAY_NAMES.get(toolName) || toolName;
}

