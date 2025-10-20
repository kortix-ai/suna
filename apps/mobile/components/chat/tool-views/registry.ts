/**
 * Tool View Registry
 * 
 * Maps tool names to their specialized view components
 */

import type { ToolViewComponent } from './types';

// Import tool views
import { GenericToolView } from './GenericToolView';
import { FileOperationToolView } from './FileOperationToolView';
import { CommandToolView } from './CommandToolView';
import { TaskListToolView } from './TaskListToolView';
import { ExposePortToolView } from './ExposePortToolView';

/**
 * Registry mapping tool names to their view components
 */
const toolViewRegistry: Record<string, ToolViewComponent> = {
  // File operations
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
  
  // Wait tool
  'wait': GenericToolView,
  
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

