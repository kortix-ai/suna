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

/**
 * Tools that must never fold into a "Tool · Nx" group. Each call is a distinct
 * artifact the user needs on its own row:
 *   - write: distinct files (index.html, styles.css, …)
 *   - show / show-user: rendered output (preview, image, viewer) the user has
 *     to actually see — folding it behind a group means it can be missed.
 */
export const NO_GROUP_ACTIVITY_TOOLS = new Set(['write', 'show', 'show_user']);

export function isNoGroupActivityTool(toolName: string | undefined): boolean {
  return NO_GROUP_ACTIVITY_TOOLS.has(normalizeActivityToolName(toolName));
}

/**
 * Parts that render nothing in the activity steps list (internal snapshot/patch
 * bookkeeping and blank text fragments). They must not split a run of groupable
 * tool calls — otherwise consecutive shells, separated only by invisible parts,
 * fragment into inconsistent singles instead of one "Ran N commands" group.
 */
export function isInvisibleActivityPart(part: { type?: string; text?: string }): boolean {
  if (part.type === 'snapshot' || part.type === 'patch') return true;
  if (part.type === 'text' && !part.text?.trim()) return true;
  return false;
}
