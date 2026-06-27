export function normalizeActivityToolName(toolName: string | undefined): string {
  return (toolName ?? '').replace(/^oc-/, '').replace(/-/g, '_');
}

export function isShellActivityTool(toolName: string | undefined): boolean {
  return normalizeActivityToolName(toolName) === 'bash';
}

export function shellActivityGroupLabel(count: number, running: boolean): string {
  const safeCount = Math.max(0, count);
  const prefix = running ? 'Running' : 'Ran';
  return `${prefix} ${safeCount} command${safeCount === 1 ? '' : 's'}`;
}
