export const HIDDEN_TOOLS: ReadonlySet<string> = new Set([]);
export const STREAMABLE_TOOLS: ReadonlySet<string> = new Set(['browser_action', 'execute_command']);
export const HIDE_STREAMING_XML_TAGS: ReadonlySet<string> = new Set([]);

export function isHiddenTool(toolName: string): boolean {
  return HIDDEN_TOOLS.has(toolName);
}
