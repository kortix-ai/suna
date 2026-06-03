const HIDDEN_TOOLS: ReadonlySet<string> = new Set([]);
export const HIDE_STREAMING_XML_TAGS: ReadonlySet<string> = new Set([]);

export function isHiddenTool(toolName: string): boolean {
  return HIDDEN_TOOLS.has(toolName);
}
