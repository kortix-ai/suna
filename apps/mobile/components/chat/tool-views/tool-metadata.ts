import { 
  Globe, 
  Search, 
  Database,
  FilePen,
  Replace,
  Trash2,
  FileCode,
  Terminal,
  CheckSquare,
  Network,
  MonitorPlay,
  FileSearch,
  Clock,
  MessageSquare,
  CheckCircle,
  FileSpreadsheet,
  BookOpen,
  Users,
  Building2,
  GraduationCap,
  FileText,
  Phone,
  Server,
  Wand2,
  Upload,
  MessageSquarePlus,
  Palette,
  Presentation,
  Settings,
  type LucideIcon,
  ImageIcon,
  ListTodo
} from 'lucide-react-native';

export interface ToolMetadata {
  icon: LucideIcon;
  iconColor: string;
  iconBgColor: string;
  subtitle: string;
  getTitle?: (args: any) => string;
  defaultTitle: string;
}

/**
 * Maps tool names to their visual metadata
 * Used by ToolHeader to render consistent tool headers
 */
export const toolMetadataMap: Record<string, ToolMetadata> = {
  // Web Search Tools
  'web-search': {
    icon: Globe,
    iconColor: 'text-primary',
    iconBgColor: 'bg-primary/10',
    subtitle: 'Web Search',
    defaultTitle: 'Search Results',
    getTitle: (args) => args?.query || 'Search Results',
  },
  'image-search': {
    icon: Search,
    iconColor: 'text-primary',
    iconBgColor: 'bg-primary/10',
    subtitle: 'Image Search',
    defaultTitle: 'Image Results',
    getTitle: (args) => args?.query || 'Image Results',
  },

  // Web Operations
  'crawl-webpage': {
    icon: Globe,
    iconColor: 'text-purple-600',
    iconBgColor: 'bg-purple-50',
    subtitle: 'Web Crawl',
    defaultTitle: 'Crawled Page',
    getTitle: (args) => args?.url || 'Crawled Page',
  },
  'scrape-webpage': {
    icon: Globe,
    iconColor: 'text-teal-600',
    iconBgColor: 'bg-teal-50',
    subtitle: 'Web Scrape',
    defaultTitle: 'Scraped Content',
    getTitle: (args) => args?.url || 'Scraped Content',
  },

  // Browser Tools
  'browser-act': {
    icon: MonitorPlay,
    iconColor: 'text-blue-600',
    iconBgColor: 'bg-blue-50',
    subtitle: 'Browser',
    defaultTitle: 'Browser Action',
  },
  'browser-navigate-to': {
    icon: MonitorPlay,
    iconColor: 'text-blue-600',
    iconBgColor: 'bg-blue-50',
    subtitle: 'Browser',
    defaultTitle: 'Navigate',
  },
  'browser-click-element': {
    icon: MonitorPlay,
    iconColor: 'text-blue-600',
    iconBgColor: 'bg-blue-50',
    subtitle: 'Browser',
    defaultTitle: 'Click Element',
  },
  'browser-input-text': {
    icon: MonitorPlay,
    iconColor: 'text-blue-600',
    iconBgColor: 'bg-blue-50',
    subtitle: 'Browser',
    defaultTitle: 'Input Text',
  },
  'browser-scroll-down': {
    icon: MonitorPlay,
    iconColor: 'text-blue-600',
    iconBgColor: 'bg-blue-50',
    subtitle: 'Browser',
    defaultTitle: 'Scroll Down',
  },
  'browser-scroll-up': {
    icon: MonitorPlay,
    iconColor: 'text-blue-600',
    iconBgColor: 'bg-blue-50',
    subtitle: 'Browser',
    defaultTitle: 'Scroll Up',
  },
  'browser-go-back': {
    icon: MonitorPlay,
    iconColor: 'text-blue-600',
    iconBgColor: 'bg-blue-50',
    subtitle: 'Browser',
    defaultTitle: 'Go Back',
  },
  'browser-wait': {
    icon: MonitorPlay,
    iconColor: 'text-blue-600',
    iconBgColor: 'bg-blue-50',
    subtitle: 'Browser',
    defaultTitle: 'Wait',
  },
  'browser-send-keys': {
    icon: MonitorPlay,
    iconColor: 'text-blue-600',
    iconBgColor: 'bg-blue-50',
    subtitle: 'Browser',
    defaultTitle: 'Send Keys',
  },
  'browser-switch-tab': {
    icon: MonitorPlay,
    iconColor: 'text-blue-600',
    iconBgColor: 'bg-blue-50',
    subtitle: 'Browser',
    defaultTitle: 'Switch Tab',
  },
  'browser-close-tab': {
    icon: MonitorPlay,
    iconColor: 'text-blue-600',
    iconBgColor: 'bg-blue-50',
    subtitle: 'Browser',
    defaultTitle: 'Close Tab',
  },
  'browser-scroll-to-text': {
    icon: MonitorPlay,
    iconColor: 'text-blue-600',
    iconBgColor: 'bg-blue-50',
    subtitle: 'Browser',
    defaultTitle: 'Scroll To Text',
  },
  'browser-get-dropdown-options': {
    icon: MonitorPlay,
    iconColor: 'text-blue-600',
    iconBgColor: 'bg-blue-50',
    subtitle: 'Browser',
    defaultTitle: 'Get Dropdown',
  },

  // File Operations
  'create-file': {
    icon: FilePen,
    iconColor: 'text-green-600',
    iconBgColor: 'bg-green-50',
    subtitle: 'Create File',
    defaultTitle: 'New File',
    getTitle: (args) => {
      const path = args?.file_path || args?.path || args?.filename;
      return path ? path.split('/').pop() || 'New File' : 'New File';
    },
  },
  'read-file': {
    icon: FileCode,
    iconColor: 'text-indigo-600',
    iconBgColor: 'bg-indigo-50',
    subtitle: 'Read File',
    defaultTitle: 'File Content',
    getTitle: (args) => {
      const path = args?.file_path || args?.path || args?.filename;
      return path ? path.split('/').pop() || 'File Content' : 'File Content';
    },
  },
  'edit-file': {
    icon: Replace,
    iconColor: 'text-blue-600',
    iconBgColor: 'bg-blue-50',
    subtitle: 'Edit File',
    defaultTitle: 'File Changes',
    getTitle: (args) => {
      const path = args?.file_path || args?.path || args?.filename;
      return path ? path.split('/').pop() || 'File Changes' : 'File Changes';
    },
  },
  'delete-file': {
    icon: Trash2,
    iconColor: 'text-red-600',
    iconBgColor: 'bg-red-50',
    subtitle: 'Delete File',
    defaultTitle: 'Deleted File',
    getTitle: (args) => {
      const path = args?.file_path || args?.path || args?.filename;
      return path ? path.split('/').pop() || 'Deleted File' : 'Deleted File';
    },
  },
  'full-file-rewrite': {
    icon: Replace,
    iconColor: 'text-amber-600',
    iconBgColor: 'bg-amber-50',
    subtitle: 'Rewrite File',
    defaultTitle: 'Rewritten File',
    getTitle: (args) => {
      const path = args?.file_path || args?.path || args?.filename;
      return path ? path.split('/').pop() || 'Rewritten File' : 'Rewritten File';
    },
  },
  'str-replace': {
    icon: Replace,
    iconColor: 'text-blue-600',
    iconBgColor: 'bg-blue-50',
    subtitle: 'String Replace',
    defaultTitle: 'Text Replacement',
    getTitle: (args) => {
      const path = args?.file_path || args?.path || args?.filename;
      return path ? path.split('/').pop() || 'Text Replacement' : 'Text Replacement';
    },
  },

  // Command Tools
  'execute-command': {
    icon: Terminal,
    iconColor: 'text-primary',
    iconBgColor: 'bg-primary/10',
    subtitle: 'Execute Command',
    defaultTitle: 'Command Output',
    getTitle: (args) => args?.command || 'Command Output',
  },
  'list-commands': {
    icon: Terminal,
    iconColor: 'text-primary',
    iconBgColor: 'bg-primary/10',
    subtitle: 'List Commands',
    defaultTitle: 'Running Commands',
  },
  'check-command-output': {
    icon: Terminal,
    iconColor: 'text-primary',
    iconBgColor: 'bg-primary/10',
    subtitle: 'Check Output',
    defaultTitle: 'Command Status',
  },
  'terminate-command': {
    icon: Terminal,
    iconColor: 'text-red-600',
    iconBgColor: 'bg-red-50',
    subtitle: 'Terminate Command',
    defaultTitle: 'Stopped',
  },

  // Task Management
  'create-tasks': {
    icon: ListTodo,
    iconColor: 'text-green-600',
    iconBgColor: 'bg-green-50',
    subtitle: 'Task Management',
    defaultTitle: 'Tasks Created',
  },
  'update-tasks': {
    icon: ListTodo,
    iconColor: 'text-blue-600',
    iconBgColor: 'bg-blue-50',
    subtitle: 'Task Management',
    defaultTitle: 'Tasks Updated',
  },
  'view-tasks': {
    icon: ListTodo,
    iconColor: 'text-primary',
    iconBgColor: 'bg-primary/10',
    subtitle: 'Task Management',
    defaultTitle: 'Task List',
  },
  'delete-tasks': {
    icon: ListTodo,
    iconColor: 'text-red-600',
    iconBgColor: 'bg-red-50',
    subtitle: 'Task Management',
    defaultTitle: 'Tasks Deleted',
  },
  'clear-all': {
    icon: ListTodo,
    iconColor: 'text-red-600',
    iconBgColor: 'bg-red-50',
    subtitle: 'Task Management',
    defaultTitle: 'All Tasks Cleared',
  },

  // Port Management
  'expose-port': {
    icon: Network,
    iconColor: 'text-blue-600',
    iconBgColor: 'bg-blue-50',
    subtitle: 'Port Management',
    defaultTitle: 'Port Exposed',
    getTitle: (args) => args?.port ? `Port ${args.port}` : 'Port Exposed',
  },

  // Wait Tool
  'wait': {
    icon: Clock,
    iconColor: 'text-amber-600',
    iconBgColor: 'bg-amber-50',
    subtitle: 'Wait',
    defaultTitle: 'Waiting',
    getTitle: (args) => args?.duration ? `Wait ${args.duration}s` : 'Waiting',
  },

  // Knowledge Base
  'kb-init': {
    icon: Database,
    iconColor: 'text-blue-500',
    iconBgColor: 'bg-blue-500/10',
    subtitle: 'Knowledge Base',
    defaultTitle: 'Initialized',
  },
  'init-kb': {
    icon: BookOpen,
    iconColor: 'text-blue-600',
    iconBgColor: 'bg-blue-50',
    subtitle: 'Knowledge Base',
    defaultTitle: 'Initialized',
  },
  'kb-search': {
    icon: Database,
    iconColor: 'text-blue-500',
    iconBgColor: 'bg-blue-500/10',
    subtitle: 'Knowledge Base',
    defaultTitle: 'Search Results',
  },
  'kb-ls': {
    icon: Database,
    iconColor: 'text-blue-500',
    iconBgColor: 'bg-blue-500/10',
    subtitle: 'Knowledge Base',
    defaultTitle: 'Contents',
  },
  'global-kb-list-contents': {
    icon: BookOpen,
    iconColor: 'text-emerald-600',
    iconBgColor: 'bg-emerald-50',
    subtitle: 'Knowledge Base',
    defaultTitle: 'KB Contents',
  },
  'kb-sync': {
    icon: Database,
    iconColor: 'text-blue-500',
    iconBgColor: 'bg-blue-500/10',
    subtitle: 'Knowledge Base',
    defaultTitle: 'Synced',
  },

  // Ask & Complete
  'ask': {
    icon: MessageSquare,
    iconColor: 'text-purple-600',
    iconBgColor: 'bg-purple-50',
    subtitle: 'Ask User',
    defaultTitle: 'User Input',
  },
  'complete': {
    icon: CheckCircle,
    iconColor: 'text-green-600',
    iconBgColor: 'bg-green-50',
    subtitle: 'Complete',
    defaultTitle: 'Task Complete',
  },

  // Document Parser
  'document-parser': {
    icon: FileText,
    iconColor: 'text-orange-600',
    iconBgColor: 'bg-orange-50',
    subtitle: 'Document Parser',
    defaultTitle: 'Parsed Document',
  },

  // Docs Tool
  'docs': {
    icon: BookOpen,
    iconColor: 'text-blue-600',
    iconBgColor: 'bg-blue-50',
    subtitle: 'Documentation',
    defaultTitle: 'Docs',
  },

  // Research Tools
  'people-search': {
    icon: Users,
    iconColor: 'text-purple-600',
    iconBgColor: 'bg-purple-50',
    subtitle: 'People Search',
    defaultTitle: 'People Results',
  },
  'company-search': {
    icon: Building2,
    iconColor: 'text-indigo-600',
    iconBgColor: 'bg-indigo-50',
    subtitle: 'Company Search',
    defaultTitle: 'Company Results',
  },
  'paper-search': {
    icon: GraduationCap,
    iconColor: 'text-emerald-600',
    iconBgColor: 'bg-emerald-50',
    subtitle: 'Paper Search',
    defaultTitle: 'Papers Found',
  },
  'paper-details': {
    icon: GraduationCap,
    iconColor: 'text-emerald-600',
    iconBgColor: 'bg-emerald-50',
    subtitle: 'Paper Details',
    defaultTitle: 'Paper Information',
  },
  'author-search': {
    icon: GraduationCap,
    iconColor: 'text-blue-600',
    iconBgColor: 'bg-blue-50',
    subtitle: 'Author Search',
    defaultTitle: 'Authors Found',
  },
  'search-authors': {
    icon: GraduationCap,
    iconColor: 'text-blue-600',
    iconBgColor: 'bg-blue-50',
    subtitle: 'Author Search',
    defaultTitle: 'Authors Found',
  },
  'author-details': {
    icon: GraduationCap,
    iconColor: 'text-blue-600',
    iconBgColor: 'bg-blue-50',
    subtitle: 'Author Details',
    defaultTitle: 'Author Information',
  },
  'get-author-details': {
    icon: GraduationCap,
    iconColor: 'text-blue-600',
    iconBgColor: 'bg-blue-50',
    subtitle: 'Author Details',
    defaultTitle: 'Author Information',
  },
  'author-papers': {
    icon: GraduationCap,
    iconColor: 'text-blue-600',
    iconBgColor: 'bg-blue-50',
    subtitle: 'Author Papers',
    defaultTitle: 'Publications',
  },
  'paper-citations': {
    icon: GraduationCap,
    iconColor: 'text-green-600',
    iconBgColor: 'bg-green-50',
    subtitle: 'Citations',
    defaultTitle: 'Paper Citations',
  },
  'paper-references': {
    icon: GraduationCap,
    iconColor: 'text-amber-600',
    iconBgColor: 'bg-amber-50',
    subtitle: 'References',
    defaultTitle: 'Paper References',
  },

  // Sheets Tool
  'sheets': {
    icon: FileSpreadsheet,
    iconColor: 'text-green-600',
    iconBgColor: 'bg-green-50',
    subtitle: 'Sheets',
    defaultTitle: 'Spreadsheet',
  },

  // VAPI Tools
  'make-call': {
    icon: Phone,
    iconColor: 'text-green-600',
    iconBgColor: 'bg-green-50',
    subtitle: 'Phone Call',
    defaultTitle: 'Call Started',
  },
  'make-phone-call': {
    icon: Phone,
    iconColor: 'text-green-600',
    iconBgColor: 'bg-green-50',
    subtitle: 'Phone Call',
    defaultTitle: 'Call Started',
  },
  'call-status': {
    icon: Phone,
    iconColor: 'text-blue-600',
    iconBgColor: 'bg-blue-50',
    subtitle: 'Phone Call',
    defaultTitle: 'Call Status',
  },
  'end-call': {
    icon: Phone,
    iconColor: 'text-red-600',
    iconBgColor: 'bg-red-50',
    subtitle: 'Phone Call',
    defaultTitle: 'Call Ended',
  },
  'list-calls': {
    icon: Phone,
    iconColor: 'text-primary',
    iconBgColor: 'bg-primary/10',
    subtitle: 'Phone Call',
    defaultTitle: 'Call History',
  },
  'wait-for-call-completion': {
    icon: Phone,
    iconColor: 'text-amber-600',
    iconBgColor: 'bg-amber-50',
    subtitle: 'Phone Call',
    defaultTitle: 'Waiting for Call',
  },

  // MCP Server
  'mcp-server': {
    icon: Server,
    iconColor: 'text-violet-600',
    iconBgColor: 'bg-violet-50',
    subtitle: 'MCP Server',
    defaultTitle: 'Server Action',
  },
  'search-mcp-servers-for-agent': {
    icon: Server,
    iconColor: 'text-violet-600',
    iconBgColor: 'bg-violet-50',
    subtitle: 'MCP Server',
    defaultTitle: 'Servers Found',
  },
  'get-current-agent-config': {
    icon: Settings,
    iconColor: 'text-blue-600',
    iconBgColor: 'bg-blue-50',
    subtitle: 'Worker Config',
    defaultTitle: 'Current Configuration',
  },
  'update-agent-config': {
    icon: Settings,
    iconColor: 'text-green-600',
    iconBgColor: 'bg-green-50',
    subtitle: 'Worker Config',
    defaultTitle: 'Configuration Updated',
  },
  'initialize-tools': {
    icon: Settings,
    iconColor: 'text-purple-600',
    iconBgColor: 'bg-purple-50',
    subtitle: 'Mode',
    defaultTitle: 'Mode Activated',
  },

  // Agent Tool
  'agent': {
    icon: Wand2,
    iconColor: 'text-pink-600',
    iconBgColor: 'bg-pink-50',
    subtitle: 'Worker',
    defaultTitle: 'Worker Execution',
  },

  // Upload File
  'upload-file': {
    icon: Upload,
    iconColor: 'text-blue-600',
    iconBgColor: 'bg-blue-50',
    subtitle: 'Upload File',
    defaultTitle: 'File Uploaded',
  },

  // Expand Message
  'expand-message': {
    icon: MessageSquarePlus,
    iconColor: 'text-teal-600',
    iconBgColor: 'bg-teal-50',
    subtitle: 'Expand Message',
    defaultTitle: 'Expanded',
  },

  // Designer Tool
  'designer': {
    icon: Palette,
    iconColor: 'text-purple-600',
    iconBgColor: 'bg-purple-50',
    subtitle: 'Designer',
    defaultTitle: 'Design Generated',
  },
  'designer-create-or-edit': {
    icon: Palette,
    iconColor: 'text-purple-600',
    iconBgColor: 'bg-purple-50',
    subtitle: 'Designer',
    defaultTitle: 'Design Created',
  },

  // Image Edit
  'image-edit': {
    icon: Palette,
    iconColor: 'text-pink-600',
    iconBgColor: 'bg-pink-50',
    subtitle: 'Image Edit',
    defaultTitle: 'Image Edited',
  },
  'image-edit-or-generate': {
    icon: Palette,
    iconColor: 'text-pink-600',
    iconBgColor: 'bg-pink-50',
    subtitle: 'AI Image',
    defaultTitle: 'AI Image Generated',
  },

  // Load Image
  'load-image': {
    icon: ImageIcon,
    iconColor: 'text-blue-600',
    iconBgColor: 'bg-blue-50',
    subtitle: 'Image',
    defaultTitle: 'Image Loaded',
  },

  // Presentation Tools
  'presentation': {
    icon: Presentation,
    iconColor: 'text-orange-600',
    iconBgColor: 'bg-orange-50',
    subtitle: 'Presentation',
    defaultTitle: 'Slides Created',
  },
  'list-presentations': {
    icon: Presentation,
    iconColor: 'text-orange-600',
    iconBgColor: 'bg-orange-50',
    subtitle: 'Presentations',
    defaultTitle: 'Presentations Listed',
  },
  'create-presentation-outline': {
    icon: Presentation,
    iconColor: 'text-orange-600',
    iconBgColor: 'bg-orange-50',
    subtitle: 'Presentation',
    defaultTitle: 'Outline Created',
  },
  'list-presentation-templates': {
    icon: Presentation,
    iconColor: 'text-orange-600',
    iconBgColor: 'bg-orange-50',
    subtitle: 'Presentation',
    defaultTitle: 'Templates Listed',
  },
  'create-slide': {
    icon: Presentation,
    iconColor: 'text-orange-600',
    iconBgColor: 'bg-orange-50',
    subtitle: 'Presentation',
    defaultTitle: 'Slide Created',
  },
  'list-slides': {
    icon: Presentation,
    iconColor: 'text-orange-600',
    iconBgColor: 'bg-orange-50',
    subtitle: 'Presentation',
    defaultTitle: 'Slides Listed',
  },
  'delete-slide': {
    icon: Presentation,
    iconColor: 'text-orange-600',
    iconBgColor: 'bg-orange-50',
    subtitle: 'Presentation',
    defaultTitle: 'Slide Deleted',
  },
  'delete-presentation': {
    icon: Presentation,
    iconColor: 'text-orange-600',
    iconBgColor: 'bg-orange-50',
    subtitle: 'Presentation',
    defaultTitle: 'Presentation Deleted',
  },
  'validate-slide': {
    icon: Presentation,
    iconColor: 'text-orange-600',
    iconBgColor: 'bg-orange-50',
    subtitle: 'Presentation',
    defaultTitle: 'Slide Validated',
  },
  'export_presentation': {
    icon: Presentation,
    iconColor: 'text-blue-600',
    iconBgColor: 'bg-blue-50',
    subtitle: 'Export',
    defaultTitle: 'Exported Presentation',
    getTitle: (args) => args?.presentation_name ? `Exported ${args.presentation_name}` : 'Exported Presentation',
  },
  'export-presentation': {
    icon: Presentation,
    iconColor: 'text-blue-600',
    iconBgColor: 'bg-blue-50',
    subtitle: 'Export',
    defaultTitle: 'Exported Presentation',
    getTitle: (args) => args?.presentation_name ? `Exported ${args.presentation_name}` : 'Exported Presentation',
  },
  // Legacy support for old tool names (backward compatibility)
  'export-to-pdf': {
    icon: FileText,
    iconColor: 'text-blue-600',
    iconBgColor: 'bg-blue-50',
    subtitle: 'Export',
    defaultTitle: 'Exported to PDF',
    getTitle: (args) => args?.presentation_name ? `${args.presentation_name}.pdf` : 'Exported to PDF',
  },
  'export_to_pdf': {
    icon: FileText,
    iconColor: 'text-blue-600',
    iconBgColor: 'bg-blue-50',
    subtitle: 'Export',
    defaultTitle: 'Exported to PDF',
    getTitle: (args) => args?.presentation_name ? `${args.presentation_name}.pdf` : 'Exported to PDF',
  },
  'export-to-pptx': {
    icon: Presentation,
    iconColor: 'text-blue-600',
    iconBgColor: 'bg-blue-50',
    subtitle: 'Export',
    defaultTitle: 'Exported to PPTX',
    getTitle: (args) => args?.presentation_name ? `${args.presentation_name}.pptx` : 'Exported to PPTX',
  },
  'export_to_pptx': {
    icon: Presentation,
    iconColor: 'text-blue-600',
    iconBgColor: 'bg-blue-50',
    subtitle: 'Export',
    defaultTitle: 'Exported to PPTX',
    getTitle: (args) => args?.presentation_name ? `${args.presentation_name}.pptx` : 'Exported to PPTX',
  },
};

/**
 * Get tool metadata for a given tool name
 * Falls back to generic metadata if tool not found
 */
export function getToolMetadata(toolName: string, args?: any): ToolMetadata & { title: string } {
  const normalizedName = toolName.replace(/_/g, '-').toLowerCase();
  const metadata = toolMetadataMap[normalizedName];

  if (!metadata) {
    // Generic fallback
    return {
      icon: FileText,
      iconColor: 'text-primary',
      iconBgColor: 'bg-primary/10',
      subtitle: 'Tool',
      defaultTitle: toolName,
      title: toolName,
    };
  }

  const title = metadata.getTitle && args ? metadata.getTitle(args) : metadata.defaultTitle;

  return {
    ...metadata,
    title,
  };
}
