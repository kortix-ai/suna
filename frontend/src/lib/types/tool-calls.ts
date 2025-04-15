// Define types for parsed XML tags to be used across the application
export interface ParsedTag {
  tagName: string;
  attributes: Record<string, string>;
  content: string;
  isClosing: boolean;
  id: string; // Unique ID for each tool call instance
  rawMatch?: string; // Raw XML match for deduplication
  timestamp?: number; // Timestamp when the tag was created
  
  // Pairing and completion status
  resultTag?: ParsedTag; // Reference to the result tag if this is a tool call
  isToolCall?: boolean; // Whether this is a tool call (vs a result)
  isPaired?: boolean; // Whether this tag has been paired with its call/result
  status?: 'running' | 'completed' | 'error'; // Status of the tool call
  
  // VNC preview for browser-related tools
  vncPreview?: string; // VNC preview image URL
}

// Display mode for tool components
export type ToolDisplayMode = 'compact' | 'detailed';

// Props for tool components
export interface ToolComponentProps {
  tag: ParsedTag;
  mode: ToolDisplayMode;
  children?: React.ReactNode; // Added to fix TypeScript errors in tool components
}

// List of supported XML tags
export const SUPPORTED_XML_TAGS = [
  'ask',
  'str-replace',
  'notify',
  'create-file',
  'read-file',
  'execute-command',
  'create-directory',
  'list-directory',
  'search-code',
  'complete',
  'full-file-rewrite',
  'browser-navigate-to',
  'browser-click-element',
  'browser-input-text',
  'browser-go-back',
  'browser-wait',
  'browser-scroll-down',
  'browser-scroll-up',
  'browser-scroll-to-text',
  'browser-switch-tab',
  'browser-close-tab',
  'browser-get-dropdown-options',
  'browser-select-dropdown-option',
  'browser-drag-drop'
];

// Tool status labels
export const ToolStatusLabels = {
  running: 'Running',
  completed: 'Completed',
  error: 'Failed'
}; 