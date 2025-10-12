import type { ElementType } from 'react';
import {
  FileText,
  Terminal,
  ExternalLink,
  FileEdit,
  Search,
  Globe,
  Code,
  MessageSquare,
  Folder,
  FileX,
  CloudUpload,
  Wrench,
  Cog,
  Network,
  FileSearch,
  FilePlus,
  PlugIcon,
  BookOpen,
  MessageCircleQuestion,
  CheckCircle2,
  Table2,
  ListTodo,
  List,
  Computer,
  Phone,
  PhoneOff,
} from 'lucide-react';
import { StopwatchIcon } from '@radix-ui/react-icons';

// Flag to control whether tool result messages are rendered
export const SHOULD_RENDER_TOOL_RESULTS = false;

// Helper function to safely parse JSON strings from content/metadata
export function safeJsonParse<T>(
  jsonString: string | undefined | null,
  fallback: T,
): T {
  if (!jsonString) {
    return fallback;
  }
  
  try {
    // First attempt: Parse as normal JSON
    const parsed = JSON.parse(jsonString);
    
    // Check if the result is a string that looks like JSON (double-escaped case)
    if (typeof parsed === 'string' && 
        (parsed.startsWith('{') || parsed.startsWith('['))) {
      try {
        // Second attempt: Parse the string result as JSON (handles double-escaped)
        return JSON.parse(parsed) as T;
      } catch (innerError) {
        // If inner parse fails, return the first parse result
        return parsed as unknown as T;
      }
    }
    
    return parsed as T;
  } catch (outerError) {
    // If the input is already an object/array (shouldn't happen but just in case)
    if (typeof jsonString === 'object') {
      return jsonString as T;
    }
    
    // Try one more time in case it's a plain string that should be returned as-is
    if (typeof jsonString === 'string') {
      // Check if it's a string representation of a simple value
      if (jsonString === 'true') return true as unknown as T;
      if (jsonString === 'false') return false as unknown as T;
      if (jsonString === 'null') return null as unknown as T;
      if (!isNaN(Number(jsonString))) return Number(jsonString) as unknown as T;
      
      // Return as string if it doesn't look like JSON
      if (!jsonString.startsWith('{') && !jsonString.startsWith('[')) {
        return jsonString as unknown as T;
      }
    }
    
    // console.warn('Failed to parse JSON string:', jsonString, outerError); // Optional: log errors
    return fallback;
  }
}

// Helper function to get an icon based on tool name
export const getToolIcon = (toolName: string): ElementType => {
  switch (toolName?.toLowerCase()) {
    case 'browser-navigate-to':
    case 'browser-act':
    case 'browser-extract-content':
    case 'browser-screenshot':
      return Globe;

    // File operations
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

    // Task operations
    case 'create-tasks':
      return List;
    case 'update-tasks':
      return ListTodo;

    // Shell commands
    case 'execute-command':
      return Terminal;
    case 'check-command-output':
      return Terminal;
    case 'terminate-command':
      return Terminal;

    // Port operations
    case 'expose-port':
      return Computer;

    // Web operations
    case 'web-search':
      return Search;
    case 'crawl-webpage':
      return Globe;
    case 'scrape-webpage':
        return Globe;

    // API and data operations
    case 'call-data-provider':
      return ExternalLink;
    case 'get-data-provider-endpoints':
      return Network;
    case 'execute-data-provider-call':
      return Network;

    // Sheets tools
    case 'create-sheet':
    case 'update-sheet':
    case 'view-sheet':
    case 'analyze-sheet':
    case 'visualize-sheet':
    case 'format-sheet':
      return Table2;

    // Code operations
    case 'delete-file':
      return FileX;


    // Tools and utilities
    case 'execute-code':
      return Code;

    // VAPI Call
    case 'make-phone-call':
      return Phone;
    case 'end-call':
      return PhoneOff;
    case 'get-call-details':
      return Phone;
    case 'list-calls':
      return Phone;
    case 'monitor-call':
      return Phone;
    case 'wait-for-call-completion':
      return StopwatchIcon;
    case 'wait_for_call_completion':
      return StopwatchIcon;

    // User interaction
    case 'ask':
      return MessageCircleQuestion;

    // Task completion
    case 'complete':
      return CheckCircle2;

    default:
      if (toolName?.startsWith('mcp_')) {
        const parts = toolName.split('_');
        if (parts.length >= 3) {
          const serverName = parts[1];
          const toolNamePart = parts.slice(2).join('_');
          
          // Map specific MCP tools to appropriate icons
          if (toolNamePart.includes('search') || toolNamePart.includes('web')) {
            return Search;
          } else if (toolNamePart.includes('research') || toolNamePart.includes('paper')) {
            return BookOpen;
          } else if (serverName === 'exa') {
            return Search; // Exa is primarily a search service
          }
        }
        return PlugIcon; // Default icon for MCP tools
      }
      
      // Add logging for debugging unhandled tool types
      return Wrench; // Default icon for tools
  }
};

// Helper function to extract a primary parameter from XML/arguments
export const extractPrimaryParam = (
  toolName: string,
  content: string | undefined,
): string | null => {
  if (!content) return null;

  try {
    // Handle browser tools with a prefix check
    if (toolName?.toLowerCase().startsWith('browser_')) {
      // Try to extract URL for navigation
      const urlMatch = content.match(/url=(?:"|')([^"|']+)(?:"|')/);
      if (urlMatch) return urlMatch[1];

      // For other browser operations, extract the goal or action
      const goalMatch = content.match(/goal=(?:"|')([^"|']+)(?:"|')/);
      if (goalMatch) {
        const goal = goalMatch[1];
        return goal.length > 30 ? goal.substring(0, 27) + '...' : goal;
      }

      return null;
    }

    // Special handling for XML content - extract file_path from the actual attributes
    if (content.startsWith('<') && content.includes('>')) {
      const xmlAttrs = content.match(/<[^>]+\s+([^>]+)>/);
      if (xmlAttrs && xmlAttrs[1]) {
        const attrs = xmlAttrs[1].trim();
        const filePathMatch = attrs.match(/file_path=["']([^"']+)["']/);
        if (filePathMatch) {
          return filePathMatch[1].split('/').pop() || filePathMatch[1];
        }

        // Try to get command for execute-command
        if (toolName?.toLowerCase() === 'execute-command') {
          const commandMatch = attrs.match(/(?:command|cmd)=["']([^"']+)["']/);
          if (commandMatch) {
            const cmd = commandMatch[1];
            return cmd.length > 30 ? cmd.substring(0, 27) + '...' : cmd;
          }
        }
      }
    }

    // Simple regex for common parameters - adjust as needed
    let match: RegExpMatchArray | null = null;

    switch (toolName?.toLowerCase()) {
      // File operations
      case 'create-file':
      case 'full-file-rewrite':
      case 'read-file':
      case 'delete-file':
      case 'str-replace':
        // Try to match file_path attribute
        match = content.match(/file_path=(?:"|')([^"|']+)(?:"|')/);
        // Return just the filename part
        return match ? match[1].split('/').pop() || match[1] : null;
      case 'edit-file':
        // Try to match target_file attribute for edit-file
        match = content.match(/target_file=(?:"|')([^"|']+)(?:"|')/) || content.match(/<parameter\s+name=["']target_file["']>([^<]+)/i);
        // Return just the filename part
        return match ? (match[1].split('/').pop() || match[1]).trim() : null;

      // Shell commands
      case 'execute-command':
        // Extract command content
        match = content.match(/command=(?:"|')([^"|']+)(?:"|')/);
        if (match) {
          const cmd = match[1];
          return cmd.length > 30 ? cmd.substring(0, 27) + '...' : cmd;
        }
        return null;

      // Web search
      case 'web-search':
      case 'image-search':
        match = content.match(/query=(?:"|')([^"|']+)(?:"|')/);
        return match
          ? match[1].length > 30
            ? match[1].substring(0, 27) + '...'
            : match[1]
          : null;

      // Data provider operations
      case 'call-data-provider':
        match = content.match(/service_name=(?:"|')([^"|']+)(?:"|')/);
        const route = content.match(/route=(?:"|')([^"|']+)(?:"|')/);
        return match && route
          ? `${match[1]}/${route[1]}`
          : match
            ? match[1]
            : null;

    }

    return null;
  } catch (e) {
    console.warn('Error parsing tool parameters:', e);
    return null;
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

  ['execute-data-provider-call', 'Calling data provider'],
  ['execute_data-provider_call', 'Calling data provider'],
  ['get-data-provider-endpoints', 'Getting endpoints'],
  
  ['ask', 'Ask'],
  ['wait', 'Wait'],
  ['create-tasks', 'Creating Tasks'],
  ['update-tasks', 'Updating Tasks'],
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
  ['load-image', 'Loading Image'],
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

  ['get-project-structure', 'Getting Project Structure'],
  ['build-project', 'Building Project'],

  //V2

  ['execute_command', 'Executing Command'],
  ['check_command_output', 'Checking Command Output'],
  ['terminate_command', 'Terminating Command'],
  ['list_commands', 'Listing Commands'],
  
  ['create_file', 'Creating File'],
  ['delete_file', 'Deleting File'],
  ['full_file_rewrite', 'Rewriting File'],
  ['str_replace', 'Editing Text'],
  ['edit_file', 'Editing File'],
  
  ['browser_navigate_to', 'Navigating to Page'],
  ['browser_act', 'Performing Action'],
  ['browser_extract_content', 'Extracting Content'],
  ['browser_screenshot', 'Taking Screenshot'],

  ['execute_data_provider_call', 'Calling data provider'],
  ['get_data_provider_endpoints', 'Getting endpoints'],
  
  ['get-paper-details', 'Getting Paper Details'],
  ['search-authors', 'Searching Authors'],
  ['get-author-details', 'Getting Author Details'],
  ['get-author-papers', 'Getting Author Papers'],
  ['get-paper-citations', 'Getting Paper Citations'],
  ['get-paper-references', 'Getting Paper References'],
  ['paper-search', 'Searching for Papers'],
  
  ['ask', 'Ask'],
  ['complete', 'Completing Task'],
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
]);


const MCP_SERVER_NAMES = new Map([
  ['exa', 'Exa Search'],
  ['github', 'GitHub'],
  ['notion', 'Notion'],
  ['slack', 'Slack'],
  ['filesystem', 'File System'],
  ['memory', 'Memory'],
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

export const HIDE_STREAMING_XML_TAGS = new Set([
  'create-tasks',
  'execute-command',
  'create-file',
  'delete-file',
  'full-file-rewrite',
  'edit-file',
  'str-replace',
  'browser-click-element',
  'browser-close-tab',
  'browser-drag-drop',
  'browser-get-dropdown-options',
  'browser-go-back',
  'browser-input-text',
  'browser-navigate-to',
  'browser-scroll-down',
  'browser-scroll-to-text',
  'browser-scroll-up',
  'browser-select-dropdown-option',
  'browser-send-keys',
  'browser-switch-tab',
  'browser-wait',
  'ask',
  'complete',
  'crawl-webpage',
  'web-search',
  'load-image',
  'execute_data_provider_call',
  'execute_data_provider_endpoint',

  'execute-data-provider-call',
  'execute-data-provider-endpoint',
]);