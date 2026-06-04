export const TOOL_DISPLAY_NAMES: ReadonlyMap<string, string> = new Map([
  ['browser_action', 'Browser'],
  ['web_search', 'Web Search'],
  ['create_file', 'Create File'],
  ['read_file', 'Read File'],
  ['str_replace_editor', 'Edit File'],
  ['delete_file', 'Delete File'],
  ['execute_command', 'Terminal'],
  ['list_directory', 'List Files'],
  ['ask_user', 'Question'],
  ['complete', 'Complete'],
  ['sb-computer-use', 'Computer'],
]);

export const TOOL_COMPLETED_NAMES: ReadonlyMap<string, string> = new Map([
  ['browser_action', 'Browsed'],
  ['web_search', 'Searched'],
  ['create_file', 'Created File'],
  ['read_file', 'Read File'],
  ['str_replace_editor', 'Edited File'],
  ['delete_file', 'Deleted File'],
  ['execute_command', 'Ran Command'],
]);

export const HIDDEN_TOOLS: ReadonlySet<string> = new Set([]);
export const STREAMABLE_TOOLS: ReadonlySet<string> = new Set(['browser_action', 'execute_command']);
export const HIDE_STREAMING_XML_TAGS: ReadonlySet<string> = new Set([]);

export function isHiddenTool(toolName: string): boolean {
  return HIDDEN_TOOLS.has(toolName);
}
