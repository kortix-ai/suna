/**
 * Tool View Registry
 * 
 * Maps tool names to their specialized view components
 */

import type { ToolViewComponent } from './types';

// Import tool views
import { GenericToolView } from './GenericToolView';
import { CommandToolView } from './CommandToolView';
import { TaskListToolView } from './TaskListToolView';
import { ExposePortToolView } from './ExposePortToolView';
import { WebSearchToolView } from './web-search-tool/WebSearchToolView';
import { BrowserToolView } from './browser-tool/BrowserToolView';
import { WebCrawlToolView } from './web-crawl-tool/WebCrawlToolView';
import { WaitToolView } from './wait-tool/WaitToolView';
import { WebScrapeToolView } from './web-scrape-tool/WebScrapeToolView';
import { StrReplaceToolView } from './str-replace-tool/StrReplaceToolView';
import { FileOperationToolView } from './file-operation/FileOperationToolView';
import { CheckCommandOutputToolView } from './check-command-output-tool/CheckCommandOutputToolView';
import { TerminateCommandToolView } from './terminate-command-tool/TerminateCommandToolView';
import { AskToolView } from './ask-tool/AskToolView';
import { CompleteToolView } from './complete-tool/CompleteToolView';
import { DataProviderToolView } from './data-provider-tool/DataProviderToolView';
import { DocumentParserToolView } from './document-parser-tool/DocumentParserToolView';
import { DocsToolView } from './docs-tool/DocsToolView';
import { PeopleSearchToolView } from './people-search-tool/PeopleSearchToolView';
import { CompanySearchToolView } from './company-search-tool/CompanySearchToolView';
import { PaperSearchToolView } from './paper-search-tool/PaperSearchToolView';
import { PaperDetailsToolView } from './paper-details-tool/PaperDetailsToolView';
import { AuthorSearchToolView } from './author-search-tool/AuthorSearchToolView';
import { AuthorDetailsToolView } from './author-details-tool/AuthorDetailsToolView';
import { AuthorPapersToolView } from './author-papers-tool/AuthorPapersToolView';
import { PaperCitationsToolView } from './paper-citations-tool/PaperCitationsToolView';
import { PaperReferencesToolView } from './paper-references-tool/PaperReferencesToolView';
import { SheetsToolView } from './sheets-tool/SheetsToolView';
import { MakeCallToolView } from './vapi-call-tool/MakeCallToolView';
import { CallStatusToolView } from './vapi-call-tool/CallStatusToolView';
import { EndCallToolView } from './vapi-call-tool/EndCallToolView';
import { ListCallsToolView } from './vapi-call-tool/ListCallsToolView';
import { WaitForCallCompletionToolView } from './vapi-call-tool/WaitForCallCompletionToolView';
import { McpServerToolView } from './mcp-server-tool/McpServerToolView';
import { AgentToolView } from './agent-tool/AgentToolView';
import { KbToolView } from './kb-tool/KbToolView';
import { UploadFileToolView } from './upload-file-tool/UploadFileToolView';
import { ExpandMessageToolView } from './expand-message-tool/ExpandMessageToolView';
import { DesignerToolView } from './designer-tool/DesignerToolView';
import { ImageEditToolView } from './image-edit-tool/ImageEditToolView';
import { PresentationToolView } from './presentation-tool/PresentationToolView';

/**
 * Registry mapping tool names to their view components
 */
const toolViewRegistry: Record<string, ToolViewComponent> = {
  // File operations (NEW - mobile optimized)
  'create-file': FileOperationToolView,
  'read-file': FileOperationToolView,
  'edit-file': FileOperationToolView,
  'delete-file': FileOperationToolView,
  'full-file-rewrite': FileOperationToolView,
  
  // Command execution
  'execute-command': CommandToolView,
  'check-command-output': CheckCommandOutputToolView,
  'terminate-command': TerminateCommandToolView,
  
  // Task management
  'create-tasks': TaskListToolView,
  'update-tasks': TaskListToolView,
  'view-tasks': TaskListToolView,
  'delete-tasks': TaskListToolView,
  'clear-all': TaskListToolView,
  
  // Port management
  'expose-port': ExposePortToolView,
  
  // Web search
  'web-search': WebSearchToolView,
  'image-search': WebSearchToolView,
  
  // Web crawl
  'crawl-webpage': WebCrawlToolView,
  
  // Web scrape
  'scrape-webpage': WebScrapeToolView,
  
  // Browser operations
  'browser-navigate-to': BrowserToolView,
  'browser-click-element': BrowserToolView,
  'browser-input-text': BrowserToolView,
  'browser-scroll-down': BrowserToolView,
  'browser-scroll-up': BrowserToolView,
  'browser-go-back': BrowserToolView,
  'browser-wait': BrowserToolView,
  'browser-send-keys': BrowserToolView,
  'browser-switch-tab': BrowserToolView,
  'browser-close-tab': BrowserToolView,
  'browser-scroll-to-text': BrowserToolView,
  'browser-get-dropdown-options': BrowserToolView,
  'browser-select-dropdown-option': BrowserToolView,
  'browser-drag-drop': BrowserToolView,
  'browser-click-coordinates': BrowserToolView,
  
  // Wait tool
  'wait': WaitToolView,
  
  // String replace
  'str-replace': StrReplaceToolView,
  
  // User interaction
  'ask': AskToolView,
  'complete': CompleteToolView,
  
  // Data provider tools
  'execute-data-provider-call': DataProviderToolView,
  'get-data-provider-endpoints': DataProviderToolView,
  
  // Research tools
  'people-search': PeopleSearchToolView,
  'company-search': CompanySearchToolView,
  'paper-search': PaperSearchToolView,
  'get-paper-details': PaperDetailsToolView,
  'search-authors': AuthorSearchToolView,
  'get-author-details': AuthorDetailsToolView,
  'get-author-papers': AuthorPapersToolView,
  'get-paper-citations': PaperCitationsToolView,
  'get-paper-references': PaperReferencesToolView,
  
  // Sheets tools
  'create-sheet': SheetsToolView,
  'update-sheet': SheetsToolView,
  'view-sheet': SheetsToolView,
  'analyze-sheet': SheetsToolView,
  'visualize-sheet': SheetsToolView,
  'format-sheet': SheetsToolView,
  
  // Phone/Voice tools (Vapi)
  'make-phone-call': MakeCallToolView,
  'make_phone_call': MakeCallToolView,
  'end-call': EndCallToolView,
  'end_call': EndCallToolView,
  'get-call-details': CallStatusToolView,
  'get_call_details': CallStatusToolView,
  'list-calls': ListCallsToolView,
  'list_calls': ListCallsToolView,
  'wait-for-call-completion': WaitForCallCompletionToolView,
  'wait_for_call_completion': WaitForCallCompletionToolView,
  
  // MCP Server Management
  'search-mcp-servers': McpServerToolView,
  'get-app-details': McpServerToolView,
  'create-credential-profile': McpServerToolView,
  'connect-credential-profile': McpServerToolView,
  'check-profile-connection': McpServerToolView,
  'configure-profile-for-agent': McpServerToolView,
  'get-credential-profiles': McpServerToolView,
  'get-current-agent-config': McpServerToolView,
  'discover-user-mcp-servers': McpServerToolView,
  'search-mcp-servers-for-agent': McpServerToolView,
  'create-credential-profile-for-agent': McpServerToolView,
  'discover-mcp-tools-for-agent': McpServerToolView,
  'configure-agent-integration': McpServerToolView,
  
  // Agent Management
  'create-new-agent': AgentToolView,
  'update-agent': AgentToolView,
  'list-app-event-triggers': AgentToolView,
  'create-event-trigger': AgentToolView,
  'create-agent-scheduled-trigger': AgentToolView,
  
  // Knowledge Base tools
  'init-kb': KbToolView,
  'init_kb': KbToolView,
  'search-files': KbToolView,
  'search_files': KbToolView,
  'ls-kb': KbToolView,
  'ls_kb': KbToolView,
  'cleanup-kb': KbToolView,
  'cleanup_kb': KbToolView,
  'global-kb-sync': KbToolView,
  'global_kb_sync': KbToolView,
  'global-kb-create-folder': KbToolView,
  'global_kb_create_folder': KbToolView,
  'global-kb-upload-file': KbToolView,
  'global_kb_upload_file': KbToolView,
  'global-kb-list-contents': KbToolView,
  'global_kb_list_contents': KbToolView,
  'global-kb-delete-item': KbToolView,
  'global_kb_delete_item': KbToolView,
  'global-kb-enable-item': KbToolView,
  'global_kb_enable_item': KbToolView,
  
  // Misc tools
  'upload-file': UploadFileToolView,
  'expand-message': ExpandMessageToolView,
  'expand_message': ExpandMessageToolView,
  
  // Designer & Image AI tools
  'designer-create-or-edit': DesignerToolView,
  'designer_create_or_edit': DesignerToolView,
  'image-edit-or-generate': ImageEditToolView,
  
  // Presentation tools
  'create-presentation-outline': PresentationToolView,
  'list-presentation-templates': PresentationToolView,
  'create-slide': PresentationToolView,
  'list-slides': PresentationToolView,
  'list-presentations': PresentationToolView,
  'delete-slide': PresentationToolView,
  'delete-presentation': PresentationToolView,
  'validate-slide': PresentationToolView,
  
  // Document tools
  'parse-document': DocumentParserToolView,
  'create-document': DocsToolView,
  'update-document': DocsToolView,
  'read-document': DocsToolView,
  'list-documents': DocsToolView,
  'delete-document': DocsToolView,
  'export-document': DocsToolView,
  
  // Default fallback
  'default': GenericToolView,
};

/**
 * Get the appropriate ToolView component for a tool name
 */
export function getToolViewComponent(toolName: string): ToolViewComponent {
  const normalizedName = toolName.toLowerCase().replace(/_/g, '-');
  return toolViewRegistry[normalizedName] || toolViewRegistry['default'];
}

/**
 * Register a custom tool view
 */
export function registerToolView(toolName: string, component: ToolViewComponent): void {
  const normalizedName = toolName.toLowerCase().replace(/_/g, '-');
  toolViewRegistry[normalizedName] = component;
}

