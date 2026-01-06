import React, { useMemo, useEffect } from 'react';
import { ToolViewProps } from '../types';
import { GenericToolView } from '../GenericToolView';
import { BrowserToolView } from '../BrowserToolView';
import { CommandToolView } from '../command-tool/CommandToolView';
import { CheckCommandOutputToolView } from '../command-tool/CheckCommandOutputToolView';
import { TerminateCommandToolView } from '../command-tool/TerminateCommandToolView';
import { ListCommandsToolView } from '../command-tool/ListCommandsToolView';
import { ExposePortToolView } from '../expose-port-tool/ExposePortToolView';
import { FileOperationToolView } from '../file-operation/FileOperationToolView';
import { WebCrawlToolView } from '../WebCrawlToolView';
import { WebScrapeToolView } from '../web-scrape-tool/WebScrapeToolView';
import { WebSearchToolView } from '../web-search-tool/WebSearchToolView';
import { PeopleSearchToolView } from '../people-search-tool/PeopleSearchToolView';
import { CompanySearchToolView } from '../company-search-tool/CompanySearchToolView';
import { DocumentParserToolView } from '../document-parser-tool/DocumentParserToolView';
import { SeeImageToolView } from '../see-image-tool/SeeImageToolView';
import { WaitToolView } from '../wait-tool/WaitToolView';
import { SearchMcpServersToolView } from '../search-mcp-servers/search-mcp-servers';
import { GetAppDetailsToolView } from '../get-app-details/get-app-details';
import { CreateCredentialProfileToolView } from '../create-credential-profile/create-credential-profile';
import { ConnectCredentialProfileToolView } from '../connect-credential-profile/connect-credential-profile';
import { CheckProfileConnectionToolView } from '../check-profile-connection/check-profile-connection';
import { ConfigureProfileForAgentToolView } from '../configure-profile-for-agent/configure-profile-for-agent';
import { GetCredentialProfilesToolView } from '../get-credential-profiles/get-credential-profiles';
import { GetCurrentAgentConfigToolView } from '../get-current-agent-config/get-current-agent-config';
import { TaskListToolView } from '../task-list/TaskListToolView';
import { ListPresentationTemplatesToolView } from '../presentation-tools/ListPresentationTemplatesToolView';
import { ListPresentationsToolView } from '../presentation-tools/ListPresentationsToolView';
import { DeleteSlideToolView } from '../presentation-tools/DeleteSlideToolView';
import { DeletePresentationToolView } from '../presentation-tools/DeletePresentationToolView';
// import { PresentationStylesToolView } from '../presentation-tools/PresentationStylesToolView';
import { ExportToolView } from '../presentation-tools/ExportToolView';
import { GetProjectStructureView } from '../web-dev/GetProjectStructureView';
import { ImageEditGenerateToolView } from '../image-edit-generate-tool/ImageEditGenerateToolView';
import { DesignerToolView } from '../designer-tool/DesignerToolView';
import dynamic from 'next/dynamic';
import { UploadFileToolView } from '../UploadFileToolView';

// Dynamically import heavy tool views to reduce initial bundle size
const CanvasToolView = dynamic(
  () => import('../canvas-tool/CanvasToolView').then((mod) => mod.CanvasToolView),
  { ssr: false }
);

// Syncfusion Spreadsheet is ~1-2 MB - must be lazy loaded
const SpreadsheetToolView = dynamic(
  () => import('../spreadsheet/SpreadsheetToolview').then((mod) => mod.SpreadsheetToolView),
  { ssr: false, loading: () => <div className="p-4 text-muted-foreground">Loading spreadsheet...</div> }
);

// SheetsToolView also uses heavy charting/table libraries
const SheetsToolView = dynamic(
  () => import('../sheets-tools/sheets-tool-view').then((mod) => mod.SheetsToolView),
  { ssr: false, loading: () => <div className="p-4 text-muted-foreground">Loading sheets...</div> }
);

// Presentation tools have heavy dependencies
const PresentationViewer = dynamic(
  () => import('../presentation-tools/PresentationViewer').then((mod) => mod.PresentationViewer),
  { ssr: false, loading: () => <div className="p-4 text-muted-foreground">Loading presentation...</div> }
);

import { CreateNewAgentToolView } from '../create-new-agent/create-new-agent';
import { UpdateAgentToolView } from '../update-agent/update-agent';
import { SearchMcpServersForAgentToolView } from '../search-mcp-servers-for-agent/search-mcp-servers-for-agent';
import { CreateCredentialProfileForAgentToolView } from '../create-credential-profile-for-agent/create-credential-profile-for-agent';
import { DiscoverMcpToolsForAgentToolView } from '../discover-mcp-tools-for-agent/discover-mcp-tools-for-agent';
import { DiscoverUserMcpServersToolView } from '../discover-user-mcp-servers/discover-user-mcp-servers';
import { ListAppEventTriggersToolView } from '../list-app-event-triggers/list-app-event-triggers';
import { CreateEventTriggerToolView } from '../create-event-trigger/create-event-trigger';
import { ConfigureAgentIntegrationToolView } from '../configure-agent-integration/configure-agent-integration';
import CreateAgentScheduledTriggerToolView from '../create-agent-scheduled-trigger/create-agent-scheduled-trigger';
import { MakeCallToolView } from '../vapi-call/MakeCallToolView';
import { CallStatusToolView } from '../vapi-call/CallStatusToolView';
import { EndCallToolView } from '../vapi-call/EndCallToolView';
import { ListCallsToolView } from '../vapi-call/ListCallsToolView';
import { MonitorCallToolView } from '../vapi-call/MonitorCallToolView';
import { WaitForCallCompletionToolView } from '../vapi-call/WaitForCallCompletionToolView';
import { createPresentationViewerToolContent, parsePresentationSlidePath } from '../utils/presentation-utils';
import { parseCanvasFilePath } from '../canvas-tool/_utils';
import { KbToolView } from '../KbToolView';
import { ExpandMessageToolView } from '../expand-message-tool/ExpandMessageToolView';
import { RealityDefenderToolView } from '../reality-defender-tool/RealityDefenderToolView';
import { ApifyToolView } from '../apify-tool/ToolView';
import { FileReaderToolView } from '../file-reader-tool/FileReaderToolView';
import { InitializeToolsToolView } from '../initialize-tools/InitializeToolsToolView';


export type ToolViewComponent = React.ComponentType<ToolViewProps>;

type ToolViewRegistryType = Record<string, ToolViewComponent>;

const defaultRegistry: ToolViewRegistryType = {
  // Initialization tools
  'initialize-tools': InitializeToolsToolView,
  'initialize_tools': InitializeToolsToolView,

  'browser-navigate-to': BrowserToolView,
  'browser-act': BrowserToolView,
  'browser-extract-content': BrowserToolView,
  'browser-screenshot': BrowserToolView,

  'execute-command': CommandToolView,
  'check-command-output': CheckCommandOutputToolView,
  'terminate-command': TerminateCommandToolView,
  'list-commands': ListCommandsToolView,

  'create-file': FileOperationToolView,
  'delete-file': FileOperationToolView,
  'full-file-rewrite': FileOperationToolView,
  'edit-file': FileOperationToolView,

  'parse-document': DocumentParserToolView,

  'read-file': FileReaderToolView,
  'read_file': FileReaderToolView,
  'search-file': FileReaderToolView,
  'search_file': FileReaderToolView,

  'str-replace': FileOperationToolView,

  
  'people-search': PeopleSearchToolView,
  'company-search': CompanySearchToolView,
  'crawl-webpage': WebCrawlToolView,
  'scrape-webpage': WebScrapeToolView,

  'image-search': WebSearchToolView,
  'web-search': WebSearchToolView,

  'spreadsheet-create': SpreadsheetToolView,
  'spreadsheet_create': SpreadsheetToolView,
  'spreadsheet-add-rows': SpreadsheetToolView,
  'spreadsheet_add_rows': SpreadsheetToolView,
  'spreadsheet-update-cell': SpreadsheetToolView,
  'spreadsheet_update_cell': SpreadsheetToolView,
  'spreadsheet-format-cells': SpreadsheetToolView,
  'spreadsheet_format_cells': SpreadsheetToolView,
  'spreadsheet-read': SpreadsheetToolView,
  'spreadsheet_read': SpreadsheetToolView,


  'search-apify-actors': ApifyToolView,
  'search_apify_actors': ApifyToolView,
  'get-actor-details': ApifyToolView,
  'get_actor_details': ApifyToolView,
  'request-apify-approval': ApifyToolView,
  'request_apify_approval': ApifyToolView,
  'approve-apify-request': ApifyToolView,
  'approve_apify_request': ApifyToolView,
  'get-apify-approval-status': ApifyToolView,
  'get_apify_approval_status': ApifyToolView,
  'run-apify-actor': ApifyToolView,
  'run_apify_actor': ApifyToolView,
  'get-actor-run-results': ApifyToolView,
  'get_actor_run_results': ApifyToolView,

  'search-mcp-servers': SearchMcpServersToolView,
  'get-app-details': GetAppDetailsToolView,
  'create-credential-profile': CreateCredentialProfileToolView,
  'connect-credential-profile': ConnectCredentialProfileToolView,
  'check-profile-connection': CheckProfileConnectionToolView,
  'configure-profile-for-agent': ConfigureProfileForAgentToolView,
  'get-credential-profiles': GetCredentialProfilesToolView,
  'get-current-agent-config': GetCurrentAgentConfigToolView,
  'create-tasks': TaskListToolView,
  'view-tasks': TaskListToolView,
  'update-tasks': TaskListToolView,
  'delete-tasks': TaskListToolView,
  'clear-all': TaskListToolView,


  'expose-port': ExposePortToolView,

  'load-image': SeeImageToolView,
  'clear-images-from-context': SeeImageToolView,
  'image-edit-or-generate': ImageEditGenerateToolView,
  'designer-create-or-edit': DesignerToolView,
  'designer_create_or_edit': DesignerToolView,

  'create-canvas': CanvasToolView,
  'create_canvas': CanvasToolView,
  'save-canvas': CanvasToolView,
  'save_canvas': CanvasToolView,
  'add-image-to-canvas': CanvasToolView,
  'add_image_to_canvas': CanvasToolView,
  'add-frame-to-canvas': CanvasToolView,
  'add_frame_to_canvas': CanvasToolView,
  'list-canvas-elements': CanvasToolView,
  'list_canvas_elements': CanvasToolView,
  'update-canvas-element': CanvasToolView,
  'update_canvas_element': CanvasToolView,
  'remove-canvas-element': CanvasToolView,
  'remove_canvas_element': CanvasToolView,
  'ai-process-canvas-element': CanvasToolView,
  'ai_process_canvas_element': CanvasToolView,

  'wait': WaitToolView,
  'expand_message': ExpandMessageToolView,
  'expand-message': ExpandMessageToolView,


  'list-templates': ListPresentationTemplatesToolView,
  'load-template-design': ListPresentationTemplatesToolView,

  // New per-slide presentation tools
  'create-slide': PresentationViewer,
  'list-slides': PresentationViewer,
  'list-presentations': ListPresentationsToolView,
  'delete-slide': DeleteSlideToolView,
  'delete-presentation': DeletePresentationToolView,
  'validate-slide': PresentationViewer,
  // 'presentation-styles': PresentationStylesToolView,
  'export-presentation': ExportToolView,
  'export_presentation': ExportToolView,
  // Legacy support for old tool names (backward compatibility)
  'export-to-pptx': ExportToolView,
  'export-to-pdf': ExportToolView,
  'export_to_pptx': ExportToolView,
  'export_to_pdf': ExportToolView,

  'create-sheet': SheetsToolView,
  'update-sheet': SheetsToolView,
  'view-sheet': SheetsToolView,
  'analyze-sheet': SheetsToolView,
  'visualize-sheet': SheetsToolView,
  'format-sheet': SheetsToolView,
  'spreadsheet-batch-update': SpreadsheetToolView,
  'spreadsheet_batch_update': SpreadsheetToolView,
  'spreadsheet-add-sheet': SpreadsheetToolView,
  'spreadsheet_add_sheet': SpreadsheetToolView,

  'get-project-structure': GetProjectStructureView,
  'list-web-projects': GenericToolView,

  'upload-file': UploadFileToolView,

  // Knowledge Base tools
  'init_kb': KbToolView,
  'init-kb': KbToolView,
  'search_files': KbToolView,
  'search-files': KbToolView,
  'ls_kb': KbToolView,
  'ls-kb': KbToolView,
  'cleanup_kb': KbToolView,
  'cleanup-kb': KbToolView,
  'global_kb_sync': KbToolView,
  'global-kb-sync': KbToolView,
  'global_kb_create_folder': KbToolView,
  'global-kb-create-folder': KbToolView,
  'global_kb_upload_file': KbToolView,
  'global-kb-upload-file': KbToolView,
  'global_kb_list_contents': KbToolView,
  'global-kb-list-contents': KbToolView,
  'global_kb_delete_item': KbToolView,
  'global-kb-delete-item': KbToolView,
  'global_kb_enable_item': KbToolView,
  'global-kb-enable-item': KbToolView,

  'default': GenericToolView,

  'create-new-agent': CreateNewAgentToolView,
  'update-agent': UpdateAgentToolView,
  'search-mcp-servers-for-agent': SearchMcpServersForAgentToolView,
  'create-credential-profile-for-agent': CreateCredentialProfileForAgentToolView,
  'discover-mcp-tools-for-agent': DiscoverMcpToolsForAgentToolView,
  'discover-user-mcp-servers': DiscoverUserMcpServersToolView,
  'list-app-event-triggers': ListAppEventTriggersToolView,
  'create-event-trigger': CreateEventTriggerToolView,
  'configure-agent-integration': ConfigureAgentIntegrationToolView,
  'create-agent-scheduled-trigger': CreateAgentScheduledTriggerToolView,

  'make_phone_call': MakeCallToolView,
  'make-phone-call': MakeCallToolView,
  'end_call': EndCallToolView,
  'end-call': EndCallToolView,
  'get_call_details': CallStatusToolView,
  'get-call-details': CallStatusToolView,
  'list_calls': ListCallsToolView,
  'list-calls': ListCallsToolView,
  'monitor_call': MonitorCallToolView,
  'monitor-call': MonitorCallToolView,
  'wait_for_call_completion': WaitForCallCompletionToolView,
  'wait-for-call-completion': WaitForCallCompletionToolView,

  'detect-deepfake': RealityDefenderToolView,
  'detect_deepfake': RealityDefenderToolView,
};

class ToolViewRegistry {
  private registry: ToolViewRegistryType;
  constructor(initialRegistry: Partial<ToolViewRegistryType> = {}) {
    this.registry = { ...defaultRegistry };
    Object.entries(initialRegistry).forEach(([key, value]) => {
      if (value !== undefined) {
        this.registry[key] = value;
      }
    });
  }

  register(toolName: string, component: ToolViewComponent): void {
    this.registry[toolName] = component;
  }

  registerMany(components: Partial<ToolViewRegistryType>): void {
    Object.assign(this.registry, components);
  }

  get(toolName: string): ToolViewComponent {
    return this.registry[toolName] || this.registry['default'];
  }

  has(toolName: string): boolean {
    return toolName in this.registry;
  }

  getToolNames(): string[] {
    return Object.keys(this.registry).filter(key => key !== 'default');
  }

  clear(): void {
    this.registry = { default: this.registry['default'] };
  }
}

export const toolViewRegistry = new ToolViewRegistry();

export function useToolView(toolName: string): ToolViewComponent {
  return useMemo(() => toolViewRegistry.get(toolName), [toolName]);
}



// Track which tool calls have already emitted canvas refresh events
const canvasRefreshedToolCalls = new Set<string>();

// Initialize pending events map on window for cross-component communication
if (typeof window !== 'undefined' && !(window as any).__pendingCanvasRefreshEvents) {
  (window as any).__pendingCanvasRefreshEvents = new Map<string, number>();
}

export function ToolView({ toolCall, toolResult, ...props }: ToolViewProps) {
  // Extract tool name from function_name (handle undefined case)
  const name = toolCall?.function_name?.replace(/_/g, '-').toLowerCase() || 'default';

  // Get file path directly from tool call arguments (from metadata)
  const filePath = toolCall?.arguments?.file_path || toolCall?.arguments?.target_file || toolCall?.arguments?.canvas_path;
  
  // Emit canvas refresh for ANY tool with canvas_path that completes successfully
  const canvasPath = toolCall?.arguments?.canvas_path;
  const toolCallId = (toolCall as any)?.tool_call_id;
  
  useEffect(() => {
    // Only emit once per tool call
    if (!toolCallId || canvasRefreshedToolCalls.has(toolCallId)) return;
    
    // Only emit if there's a canvas_path and tool completed successfully
    if (canvasPath && toolResult?.success) {
      console.log('[CANVAS_LIVE_DEBUG] ToolView emitting canvas refresh for:', {
        toolName: name,
        canvasPath,
        toolCallId,
      });
      canvasRefreshedToolCalls.add(toolCallId);
      
      // Store in pending events queue for canvas-renderer to pick up
      const pendingEvents = (window as any).__pendingCanvasRefreshEvents as Map<string, number> | undefined;
      if (pendingEvents) {
        pendingEvents.set(canvasPath, Date.now());
      }
      
      // Small delay to ensure file is written
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent('canvas-tool-updated', {
          detail: { canvasPath, timestamp: Date.now() }
        }));
      }, 300);
    }
  }, [toolCallId, canvasPath, toolResult?.success, name]);

  // check if the file path is a presentation slide
  const { isValid: isPresentationSlide, presentationName, slideNumber } = parsePresentationSlidePath(filePath);

  // check if the file path is a canvas file
  const { isValid: isCanvasFile, canvasName } = parseCanvasFilePath(filePath);

  // define presentation-related tools that shouldn't be transformed
  const presentationTools = [
    'create-slide',
    'list-slides',
    'delete-slide',
    'delete-presentation',
    'validate-slide',
    // 'presentation-styles',
  ]

  // define canvas-related tools that shouldn't be transformed
  const canvasTools = [
    'create-canvas', 'create_canvas',
    'save-canvas', 'save_canvas',
    'add-image-to-canvas', 'add_image_to_canvas',
    'add-frame-to-canvas', 'add_frame_to_canvas',
    'list-canvas-elements', 'list_canvas_elements',
    'update-canvas-element', 'update_canvas_element',
    'remove-canvas-element', 'remove_canvas_element',
    'ai-process-canvas-element', 'ai_process_canvas_element',
  ]

  const isAlreadyPresentationTool = presentationTools.includes(name);
  const isAlreadyCanvasTool = canvasTools.includes(name);

  // determine the effective tool name (must be computed before hook call)
  let effectiveToolName = name;
  if (isPresentationSlide && !isAlreadyPresentationTool) {
    effectiveToolName = 'create-slide';
  } else if (isCanvasFile && !isAlreadyCanvasTool) {
    effectiveToolName = 'create-canvas';
  }

  // use the tool view component - hook must be called unconditionally
  const ToolViewComponent = useToolView(effectiveToolName);

  // Defensive check - ensure toolCall is defined
  if (!toolCall || !toolCall.function_name) {
    console.warn('ToolView: toolCall is undefined or missing function_name. Tool views should use structured props.');
    // Fallback to GenericToolView with error handling
    return (
      <div className="h-full w-full max-h-full max-w-full overflow-hidden min-w-0 min-h-0" style={{ contain: 'layout style' }}>
        <GenericToolView toolCall={toolCall} toolResult={toolResult} {...props} />
      </div>
    );
  }

  // if the file path is a presentation slide, we need to modify the tool result to match the expected structure for PresentationViewer
  let modifiedToolResult = toolResult;
  if (isPresentationSlide && filePath && presentationName && slideNumber && !isAlreadyPresentationTool && toolResult) {
    const viewerContent = createPresentationViewerToolContent(presentationName, filePath, slideNumber);
    console.log('[ToolViewRegistry] Detected presentation slide in file operation:', {
      toolName: name,
      filePath,
      presentationName,
      slideNumber,
      viewerContent: JSON.parse(viewerContent),
    });
    modifiedToolResult = {
      ...toolResult,
      output: viewerContent,
    };
  }

  // if the file path is a canvas file, we need to modify the tool result for CanvasToolView
  if (isCanvasFile && filePath && canvasName && !isAlreadyCanvasTool && toolResult) {
    const canvasViewerContent = JSON.stringify({
      result: {
        output: JSON.stringify({
          canvas_name: canvasName,
          canvas_path: filePath,
        }),
        success: true
      },
      tool_name: 'canvas-viewer'
    });
    modifiedToolResult = {
      ...toolResult,
      output: canvasViewerContent,
    };
  }

  // Wrap all tool views in a container with CSS containment to prevent overflow
  return (
    <div className="h-full w-full max-h-full max-w-full overflow-hidden min-w-0 min-h-0" style={{ contain: 'layout style' }}>
      <ToolViewComponent toolCall={toolCall} toolResult={modifiedToolResult} {...props} />
    </div>
  );
}