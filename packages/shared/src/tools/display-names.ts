/**
 * Tool display names - maps tool identifiers to human-readable names
 * Single source of truth for both frontend and mobile
 */

export const TOOL_COMPLETED_NAMES: ReadonlyMap<string, string> = new Map([
  ['web-search', 'Searched Web'],
  ['web_search', 'Searched Web'],
  ['image-search', 'Searched Images'],
  ['image_search', 'Searched Images'],
  ['scrape-webpage', 'Scraped Website'],
  ['scrape_webpage', 'Scraped Website'],
  ['crawl-webpage', 'Crawled Website'],
  ['crawl_webpage', 'Crawled Website'],
  ['execute-command', 'Executed Command'],
  ['execute_command', 'Executed Command'],
  ['create-file', 'Created File'],
  ['create_file', 'Created File'],
  ['edit-file', 'Edited File'],
  ['edit_file', 'Edited File'],
  ['read-file', 'Read File'],
  ['read_file', 'Read File'],
  ['delete-file', 'Deleted File'],
  ['delete_file', 'Deleted File'],
  ['create-slide', 'Created Slide'],
  ['create_slide', 'Created Slide'],
]);


export const TOOL_DISPLAY_NAMES: ReadonlyMap<string, string> = new Map([
  // Initialization
  ['initialize-tools', 'Mode Activated'],
  ['initialize_tools', 'Mode Activated'],

  // Command execution
  ['execute-command', 'Executing Command'],
  ['execute_command', 'Executing Command'],
  ['check-command-output', 'Checking Command Output'],
  ['check_command_output', 'Checking Command Output'],
  ['terminate-command', 'Terminating Command'],
  ['terminate_command', 'Terminating Command'],
  ['list-commands', 'Listing Commands'],
  ['list_commands', 'Listing Commands'],
  
  // File operations
  ['create-file', 'Creating File'],
  ['create_file', 'Creating File'],
  ['delete-file', 'Deleting File'],
  ['delete_file', 'Deleting File'],
  ['full-file-rewrite', 'Rewriting File'],
  ['full_file_rewrite', 'Rewriting File'],
  ['str-replace', 'Editing Text'],
  ['str_replace', 'Editing Text'],
  ['edit-file', 'Editing File'],
  ['edit_file', 'Editing File'],
  ['read-file', 'Reading File'],
  ['read_file', 'Reading File'],
  ['upload-file', 'Uploading File'],

  // Document operations
  ['create-document', 'Creating Document'],
  ['update-document', 'Updating Document'],
  ['read-document', 'Reading Document'],
  ['list-documents', 'Listing Documents'],
  ['delete-document', 'Deleting Document'],
  ['parse-document', 'Parsing Document'],
  ['parse_document', 'Parsing Document'],

  // Task operations
  ['create-tasks', 'Creating Tasks'],
  ['create_tasks', 'Creating Tasks'],
  ['update-tasks', 'Updating Tasks'],
  ['update_tasks', 'Updating Tasks'],
  
  // Browser operations
  ['browser-navigate-to', 'Navigating to Page'],
  ['browser_navigate_to', 'Navigating to Page'],
  ['browser-act', 'Performing Action'],
  ['browser_act', 'Performing Action'],
  ['browser-extract-content', 'Extracting Content'],
  ['browser_extract_content', 'Extracting Content'],
  ['browser-screenshot', 'Taking Screenshot'],
  ['browser_screenshot', 'Taking Screenshot'],
  ['browser-click-element', 'Clicking Element'],
  ['browser-close-tab', 'Closing Tab'],
  ['browser-input-text', 'Inputting Text'],
  ['browser-scroll-down', 'Scrolling Down'],
  ['browser-scroll-up', 'Scrolling Up'],
  ['browser-wait', 'Waiting'],

  // Data provider operations
  ['execute-data-provider-call', 'Calling Data Provider'],
  ['execute_data-provider_call', 'Calling Data Provider'],
  ['get-data-provider-endpoints', 'Getting Endpoints'],
  ['call-data-provider', 'Calling Data Provider'],
  
  // Core tools
  ['ask', 'Ask'],
  ['wait', 'Wait'],
  ['complete', 'Completing Task'],

  // Web operations
  ['crawl-webpage', 'Crawling Website'],
  ['crawl_webpage', 'Crawling Website'],
  ['scrape-webpage', 'Scraping Website'],
  ['scrape_webpage', 'Scraping Website'],
  ['web-search', 'Searching Web'],
  ['web_search', 'Searching Web'],
  ['image-search', 'Searching Images'],
  ['image_search', 'Searching Images'],
  
  // Port operations
  ['expose-port', 'Exposing Port'],
  ['expose_port', 'Exposing Port'],
  
  // Image operations
  ['load-image', 'Loaded Image'],
  ['load_image', 'Loaded Image'],
  ['clear-images-from-context', 'Clearing Images'],
  ['image-edit-or-generate', 'Generate Media'],
  ['image_edit_or_generate', 'Generate Media'],
  ['designer-create-or-edit', 'Designing'],

  // Presentation operations
  ['create-presentation', 'Creating Presentation'],
  ['create-presentation-outline', 'Creating Presentation Outline'],
  ['create_presentation_outline', 'Creating Presentation Outline'],
  ['create-slide', 'Creating Slide'],
  ['create_slide', 'Creating Slide'],
  ['load-template-design', 'Loading Template Design'],
  ['load_template_design', 'Loading Template Design'],
  ['validate-slide', 'Validating Slide'],
  ['validate_slide', 'Validating Slide'],

  // Spreadsheet operations
  ['create-sheet', 'Creating Sheet'],
  ['update-sheet', 'Updating Sheet'],
  ['view-sheet', 'Viewing Sheet'],
  ['analyze-sheet', 'Analyzing Sheet'],
  ['visualize-sheet', 'Visualizing Sheet'],
  ['format-sheet', 'Formatting Sheet'],
  ['spreadsheet-create', 'Creating Spreadsheet'],
  ['spreadsheet_create', 'Creating Spreadsheet'],
  ['spreadsheet-add-sheet', 'Adding Sheet'],
  ['spreadsheet_add_sheet', 'Adding Sheet'],
  ['spreadsheet-batch-update', 'Updating Spreadsheet'],
  ['spreadsheet_batch_update', 'Updating Spreadsheet'],

  // Agent/Worker operations
  ['update-agent', 'Updating Worker'],
  ['update_agent', 'Updating Worker'],
  ['get-current-agent-config', 'Getting Worker Config'],
  ['get_current_agent_config', 'Getting Worker Config'],
  ['create-new-agent', 'Creating New Worker'],

  // MCP operations
  ['search-mcp-servers', 'Searching MCP Servers'],
  ['search_mcp_servers', 'Searching MCP Servers'],
  ['get-mcp-server-tools', 'Getting MCP Server Tools'],
  ['configure-mcp-server', 'Configuring MCP Server'],
  ['get-popular-mcp-servers', 'Getting Popular MCP Servers'],
  ['get_popular_mcp_servers', 'Getting Popular MCP Servers'],
  ['test-mcp-server-connection', 'Testing MCP Server Connection'],
  ['test_mcp_server_connection', 'Testing MCP Server Connection'],
  ['discover-user-mcp-servers', 'Discovering Tools'],
  ['search-mcp-servers-for-agent', 'Searching MCP Servers'],
  ['discover-mcp-tools-for-agent', 'Discovering MCP Tools'],

  // Credential operations
  ['create-credential-profile', 'Creating Profile'],
  ['get-credential-profiles', 'Getting Profiles'],
  ['configure-profile-for-agent', 'Adding Tools to Worker'],
  ['create-credential-profile-for-agent', 'Creating Credential Profile'],
  ['configure-agent-integration', 'Configuring Worker Integration'],

  // Trigger operations
  ['list-app-event-triggers', 'Finding Event Triggers'],
  ['list_app_event_triggers', 'Finding Event Triggers'],
  ['create-event-trigger', 'Creating Event Trigger'],
  ['create_event_trigger', 'Creating Event Trigger'],
  ['create-agent-scheduled-trigger', 'Creating Scheduled Trigger'],
  ['list-agent-scheduled-triggers', 'Listing Scheduled Triggers'],

  // Project operations
  ['get-project-structure', 'Getting Project Structure'],
  ['build-project', 'Building Project'],

  // Research operations
  ['get-paper-details', 'Getting Paper Details'],
  ['search-authors', 'Searching Authors'],
  ['get-author-details', 'Getting Author Details'],
  ['get-author-papers', 'Getting Author Papers'],
  ['get-paper-citations', 'Getting Paper Citations'],
  ['get-paper-references', 'Getting Paper References'],
  ['paper-search', 'Searching for Papers'],

  // Phone/Call operations
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

  // Code execution
  ['execute-code', 'Executing Code'],
  ['execute_code', 'Executing Code'],
]);

/**
 * Tags to hide during streaming (show tool card instead of raw XML)
 */
export const HIDE_STREAMING_XML_TAGS: ReadonlySet<string> = new Set([
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
]);

/**
 * Tools that should be hidden from non-technical users
 * These are internal/initialization tools that don't provide meaningful user feedback
 */
export const HIDDEN_TOOLS: ReadonlySet<string> = new Set([
  // initialize_tools is now shown with a friendly message via InitializeToolsToolView
]);

/**
 * Check if a tool should be hidden from the user
 */
export function isHiddenTool(toolName: string): boolean {
  if (!toolName) return false;
  const normalizedName = toolName.toLowerCase().replace(/_/g, '-');
  return HIDDEN_TOOLS.has(normalizedName) || HIDDEN_TOOLS.has(toolName);
}

/**
 * Tools that support streaming content display
 * These tools show real-time content updates during execution
 */
export const STREAMABLE_TOOLS: ReadonlySet<string> = new Set([
  'create-tasks',
  'update-tasks',
  'execute-command',
  'create-file',
  'full-file-rewrite',
  'edit-file',
  'browser-navigate-to',
  'browser-input-text',
  'browser-click-element',
  'search-web',
  'crawl-website',
  'view-image',
  'expose-port',
  'get-agent-config',
  'search-mcp-servers',
  'create-credential-profile',
]);

