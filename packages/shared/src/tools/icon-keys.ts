/**
 * Tool icon key mapping - platform-agnostic icon identifiers
 * Each platform (web/mobile) maps these keys to actual icon components
 */

/**
 * Icon key type - these are the canonical icon identifiers
 * Each platform must provide icon components for these keys
 */
export type ToolIconKey =
  | 'globe'
  | 'file-edit'
  | 'file-search'
  | 'file-plus'
  | 'file-text'
  | 'file-x'
  | 'list'
  | 'list-todo'
  | 'terminal'
  | 'computer'
  | 'search'
  | 'external-link'
  | 'network'
  | 'table'
  | 'code'
  | 'phone'
  | 'phone-off'
  | 'message-question'
  | 'check-circle'
  | 'wrench'
  | 'book-open'
  | 'plug'
  | 'clock'
  | 'presentation'
  | 'image'
  | 'pencil'
  | 'hammer';

/**
 * Get the icon key for a tool name
 * This is platform-agnostic - each platform resolves the key to an actual icon component
 * 
 * @param toolName - The tool name (can be kebab-case or snake_case)
 * @returns The icon key to use
 */
export function getToolIconKey(toolName: string | undefined): ToolIconKey {
  if (!toolName) return 'wrench';
  
  const normalized = toolName.toLowerCase();
  
  switch (normalized) {
    // Initialization
    case 'initialize-tools':
    case 'initialize_tools':
      return 'hammer';

    // Browser operations
    case 'browser-navigate-to':
    case 'browser-act':
    case 'browser-extract-content':
    case 'browser-screenshot':
    case 'browser_navigate_to':
    case 'browser_act':
    case 'browser_extract_content':
    case 'browser_screenshot':
    case 'crawl-webpage':
    case 'crawl_webpage':
    case 'scrape-webpage':
    case 'scrape_webpage':
      return 'globe';

    // Web search
    case 'web-search':
    case 'web_search':
      return 'globe';
    
    case 'image-search':
    case 'image_search':
      return 'image';

    // File operations
    case 'create-file':
    case 'create_file':
    case 'edit-file':
    case 'edit_file':
      return 'file-edit';
    
    case 'str-replace':
    case 'str_replace':
      return 'file-search';
    
    case 'full-file-rewrite':
    case 'full_file_rewrite':
      return 'file-plus';
    
    case 'read-file':
    case 'read_file':
    case 'parse-document':
    case 'parse_document':
    case 'read-document':
    case 'read_document':
      return 'file-text';
    
    case 'delete-file':
    case 'delete_file':
      return 'file-x';

    // Design tools
    case 'designer-create-or-edit':
    case 'image-edit-or-generate':
      return 'pencil';

    // Task operations
    case 'create-tasks':
    case 'create_tasks':
      return 'list';
    
    case 'update-tasks':
    case 'update_tasks':
      return 'list-todo';

    // Command operations
    case 'execute-command':
    case 'execute_command':
    case 'check-command-output':
    case 'check_command_output':
    case 'terminate-command':
    case 'terminate_command':
    case 'list-commands':
    case 'list_commands':
      return 'terminal';

    // Port operations
    case 'expose-port':
    case 'expose_port':
      return 'computer';

    // Search
    case 'search-authors':
    case 'paper-search':
      return 'search';

    // Spreadsheet operations
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
    case 'spreadsheet-create':
    case 'spreadsheet_create':
    case 'spreadsheet-add-sheet':
    case 'spreadsheet_add_sheet':
    case 'spreadsheet-batch-update':
    case 'spreadsheet_batch_update':
      return 'table';

    // Code execution
    case 'execute-code':
    case 'execute_code':
      return 'code';

    // Phone operations
    case 'make-phone-call':
    case 'make_phone_call':
    case 'get-call-details':
    case 'get_call_details':
    case 'list-calls':
    case 'list_calls':
    case 'monitor-call':
    case 'monitor_call':
      return 'phone';
    
    case 'end-call':
    case 'end_call':
      return 'phone-off';
    
    case 'wait-for-call-completion':
    case 'wait_for_call_completion':
      return 'clock';

    // User interaction
    case 'ask':
      return 'message-question';

    // Task completion
    case 'complete':
      return 'check-circle';

    // Presentation
    case 'create-presentation-outline':
    case 'create_presentation_outline':
    case 'create-slide':
    case 'create_slide':
    case 'load-template-design':
    case 'load_template_design':
    case 'validate-slide':
    case 'validate_slide':
      return 'presentation';

    // Research
    case 'get-paper-details':
    case 'get-author-details':
    case 'get-author-papers':
    case 'get-paper-citations':
    case 'get-paper-references':
      return 'book-open';

    // MCP tools
    default:
      if (normalized.startsWith('mcp_')) {
        const parts = normalized.split('_');
        if (parts.length >= 3) {
          const serverName = parts[1];
          const toolNamePart = parts.slice(2).join('_');
          
          if (toolNamePart.includes('search') || toolNamePart.includes('web')) {
            return 'search';
          } else if (toolNamePart.includes('research') || toolNamePart.includes('paper')) {
            return 'book-open';
          } else if (serverName === 'exa') {
            return 'search';
          }
        }
        return 'plug';
      }
      
      return 'wrench';
  }
}

