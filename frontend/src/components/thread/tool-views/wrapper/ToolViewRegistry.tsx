import React, { useMemo } from 'react';
import { ToolViewProps } from '../types';
import { GenericToolView } from '../GenericToolView';
import { BrowserToolView } from '../BrowserToolView';
import { CommandToolView } from '../command-tool/CommandToolView';
import { CheckCommandOutputToolView } from '../command-tool/CheckCommandOutputToolView';
import { ExposePortToolView } from '../expose-port-tool/ExposePortToolView';
import { FileOperationToolView } from '../file-operation/FileOperationToolView';
import { FileEditToolView } from '../file-operation/FileEditToolView';
import { StrReplaceToolView } from '../str-replace/StrReplaceToolView';
import { WebCrawlToolView } from '../WebCrawlToolView';
import { WebScrapeToolView } from '../web-scrape-tool/WebScrapeToolView';
import { WebSearchToolView } from '../web-search-tool/WebSearchToolView';
import { PeopleSearchToolView } from '../people-search-tool/PeopleSearchToolView';
import { CompanySearchToolView } from '../company-search-tool/CompanySearchToolView';
import { PaperSearchToolView } from '../paper-search-tool/PaperSearchToolView';
import { PaperDetailsToolView } from '../paper-details-tool/PaperDetailsToolView';
import { AuthorSearchToolView } from '../author-search-tool/AuthorSearchToolView';
import { AuthorDetailsToolView } from '../author-details-tool/AuthorDetailsToolView';
import { AuthorPapersToolView } from '../author-papers-tool/AuthorPapersToolView';
import { PaperCitationsToolView } from '../paper-citations-tool/PaperCitationsToolView';
import { PaperReferencesToolView } from '../paper-references-tool/PaperReferencesToolView';
import { DocumentParserToolView } from '../document-parser-tool/DocumentParserToolView';
import { SeeImageToolView } from '../see-image-tool/SeeImageToolView';
import { TerminateCommandToolView } from '../command-tool/TerminateCommandToolView';
import { AskToolView } from '../ask-tool/AskToolView';
import { CompleteToolView } from '../CompleteToolView';
import { WaitToolView } from '../wait-tool/WaitToolView';
import { ExecuteDataProviderCallToolView } from '../data-provider-tool/ExecuteDataProviderCallToolView';
import { DataProviderEndpointsToolView } from '../data-provider-tool/DataProviderEndpointsToolView';
import { SearchMcpServersToolView } from '../search-mcp-servers/search-mcp-servers';
import { GetAppDetailsToolView } from '../get-app-details/get-app-details';
import { CreateCredentialProfileToolView } from '../create-credential-profile/create-credential-profile';
import { ConnectCredentialProfileToolView } from '../connect-credential-profile/connect-credential-profile';
import { CheckProfileConnectionToolView } from '../check-profile-connection/check-profile-connection';
import { ConfigureProfileForAgentToolView } from '../configure-profile-for-agent/configure-profile-for-agent';
import { GetCredentialProfilesToolView } from '../get-credential-profiles/get-credential-profiles';
import { GetCurrentAgentConfigToolView } from '../get-current-agent-config/get-current-agent-config';
import { TaskListToolView } from '../task-list/TaskListToolView';
import { PresentationOutlineToolView } from '../presentation-tools/PresentationOutlineToolView';
import { ListPresentationTemplatesToolView } from '../presentation-tools/ListPresentationTemplatesToolView';
import { PresentationViewer } from '../presentation-tools/PresentationViewer';
import { ListPresentationsToolView } from '../presentation-tools/ListPresentationsToolView';
import { DeleteSlideToolView } from '../presentation-tools/DeleteSlideToolView';
import { DeletePresentationToolView } from '../presentation-tools/DeletePresentationToolView';
// import { PresentationStylesToolView } from '../presentation-tools/PresentationStylesToolView';
import { PresentPresentationToolView } from '../presentation-tools/PresentPresentationToolView';
import { SheetsToolView } from '../sheets-tools/sheets-tool-view';
import { GetProjectStructureView } from '../web-dev/GetProjectStructureView';
import { ImageEditGenerateToolView } from '../image-edit-generate-tool/ImageEditGenerateToolView';
import { DesignerToolView } from '../designer-tool/DesignerToolView';
import { UploadFileToolView } from '../UploadFileToolView';
import { DocsToolView, ListDocumentsToolView, DeleteDocumentToolView } from '../docs-tool';
import { CreateNewAgentToolView } from '../create-new-agent/create-new-agent';
import { UpdateAgentToolView } from '../update-agent/update-agent';
import { SearchMcpServersForAgentToolView } from '../search-mcp-servers-for-agent/search-mcp-servers-for-agent';
import { CreateCredentialProfileForAgentToolView } from '../create-credential-profile-for-agent/create-credential-profile-for-agent';
import { DiscoverMcpToolsForAgentToolView } from '../discover-mcp-tools-for-agent/discover-mcp-tools-for-agent';
import { DiscoverUserMcpServersToolView } from '../discover-user-mcp-servers/discover-user-mcp-servers';
import { ConfigureAgentIntegrationToolView } from '../configure-agent-integration/configure-agent-integration';
import CreateAgentScheduledTriggerToolView from '../create-agent-scheduled-trigger/create-agent-scheduled-trigger';
import { MakeCallToolView } from '../vapi-call/MakeCallToolView';
import { CallStatusToolView } from '../vapi-call/CallStatusToolView';
import { EndCallToolView } from '../vapi-call/EndCallToolView';
import { ListCallsToolView } from '../vapi-call/ListCallsToolView';
import { MonitorCallToolView } from '../vapi-call/MonitorCallToolView';
import { WaitForCallCompletionToolView } from '../vapi-call/WaitForCallCompletionToolView';
import { createPresentationViewerToolContent, parsePresentationSlidePath } from '../utils/presentation-utils';
import { extractToolData } from '../utils';
import { KbToolView } from '../KbToolView';
import { ExpandMessageToolView } from '../expand-message-tool/ExpandMessageToolView';


export type ToolViewComponent = React.ComponentType<ToolViewProps>;

type ToolViewRegistryType = Record<string, ToolViewComponent>;

const defaultRegistry: ToolViewRegistryType = {
  'browser-navigate-to': BrowserToolView,
  'browser-act': BrowserToolView,
  'browser-extract-content': BrowserToolView,
  'browser-screenshot': BrowserToolView,

  'execute-command': CommandToolView,
  'check-command-output': CheckCommandOutputToolView,
  'terminate-command': TerminateCommandToolView,
  'list-commands': GenericToolView,

  'create-file': FileOperationToolView,
  'delete-file': FileOperationToolView,
  'full-file-rewrite': FileOperationToolView,
  'read-file': FileOperationToolView,
  'edit-file': FileEditToolView,

  'parse-document': DocumentParserToolView,

  'str-replace': StrReplaceToolView,

  'web-search': WebSearchToolView,
  'people-search': PeopleSearchToolView,
  'company-search': CompanySearchToolView,
  'paper-search': PaperSearchToolView,
  'get-paper-details': PaperDetailsToolView,
  'search-authors': AuthorSearchToolView,
  'get-author-details': AuthorDetailsToolView,
  'get-author-papers': AuthorPapersToolView,
  'get-paper-citations': PaperCitationsToolView,
  'get-paper-references': PaperReferencesToolView,
  'crawl-webpage': WebCrawlToolView,
  'scrape-webpage': WebScrapeToolView,
  'image-search': WebSearchToolView,

  'execute-data-provider-call': ExecuteDataProviderCallToolView,
  'get-data-provider-endpoints': DataProviderEndpointsToolView,

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

  'ask': AskToolView,
  'complete': CompleteToolView,
  'wait': WaitToolView,
  'expand_message': ExpandMessageToolView,
  'expand-message': ExpandMessageToolView,


  'create-presentation-outline': PresentationOutlineToolView,
  'list-presentation-templates': ListPresentationTemplatesToolView,

  // New per-slide presentation tools
  'create-slide': PresentationViewer,
  'list-slides': PresentationViewer,
  'list-presentations': ListPresentationsToolView,
  'delete-slide': DeleteSlideToolView,
  'delete-presentation': DeletePresentationToolView,
  'validate-slide': PresentationViewer,
  // 'presentation-styles': PresentationStylesToolView,
  'present-presentation': PresentPresentationToolView,

  'create-sheet': SheetsToolView,
  'update-sheet': SheetsToolView,
  'view-sheet': SheetsToolView,
  'analyze-sheet': SheetsToolView,
  'visualize-sheet': SheetsToolView,
  'format-sheet': SheetsToolView,

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

  // Document operations - using specific views for different operations
  'create-document': DocsToolView,
  'update-document': DocsToolView,
  'read-document': DocsToolView,
  'list-documents': ListDocumentsToolView,
  'delete-document': DeleteDocumentToolView,
  'export-document': DocsToolView,
  'create_document': DocsToolView,
  'update_document': DocsToolView,
  'read_document': DocsToolView,
  'list_documents': ListDocumentsToolView,
  'delete_document': DeleteDocumentToolView,
  'export_document': DocsToolView,
  'get_tiptap_format_guide': DocsToolView,

  'default': GenericToolView,

  'create-new-agent': CreateNewAgentToolView,
  'update-agent': UpdateAgentToolView,
  'search-mcp-servers-for-agent': SearchMcpServersForAgentToolView,
  'create-credential-profile-for-agent': CreateCredentialProfileForAgentToolView,
  'discover-mcp-tools-for-agent': DiscoverMcpToolsForAgentToolView,
  'discover-user-mcp-servers': DiscoverUserMcpServersToolView,
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



export function ToolView({ name = 'default', assistantContent, toolContent, ...props }: ToolViewProps) {
  const toolToolData = extractToolData(toolContent);

  // find the file path from the tool arguments
  const toolArguments = toolToolData.arguments || {};
  const filePath = toolArguments.file_path || toolArguments.target_file;

  // check if the file path is a presentation slide
  const { isValid: isPresentationSlide, presentationName, slideNumber } = parsePresentationSlidePath(filePath);
  let modifiedToolContent = toolContent;

  // define presentation-related tools that shouldn't be transformed
  const presentationTools = [
    'create-slide',
    'list-slides',
    'delete-slide',
    'delete-presentation',
    'validate-slide',
    // 'presentation-styles',
    'present-presentation',
  ]

  const isAlreadyPresentationTool = presentationTools.includes(name);

  // if the file path is a presentation slide, we need to modify the tool content to match the expected structure for PresentationViewer
  if (isPresentationSlide && filePath && presentationName && slideNumber && !isAlreadyPresentationTool) {
    modifiedToolContent = createPresentationViewerToolContent(presentationName, filePath, slideNumber);
  }

  // determine the effective tool name
  const effectiveToolName = (isPresentationSlide && !isAlreadyPresentationTool) ? 'create-slide' : name;

  // use the tool view component
  const ToolViewComponent = useToolView(effectiveToolName);
  return <ToolViewComponent name={effectiveToolName} toolContent={modifiedToolContent} {...props} />;
}