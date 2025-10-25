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
  'check-command-output': CommandToolView,
  'terminate-command': CommandToolView,
  
  // Task management
  'create-tasks': TaskListToolView,
  'update-tasks': TaskListToolView,
  'view-tasks': TaskListToolView,
  'delete-tasks': TaskListToolView,
  
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

