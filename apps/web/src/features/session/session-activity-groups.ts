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
 * Tools that must never fold into a "Tool · Nx" group:
 *   - show / show-user: rendered output (preview, image, viewer) the user has
 *     to actually see — folding it behind a group means it can be missed.
 * `write` used to be here ("distinct files"), but a scaffold run writing six
 * JSON files as six rows buries the narrative — the grouped row lists every
 * file inside, nothing is lost.
 */
export const NO_GROUP_ACTIVITY_TOOLS = new Set(['show', 'show_user']);

export function isNoGroupActivityTool(toolName: string | undefined): boolean {
  return NO_GROUP_ACTIVITY_TOOLS.has(normalizeActivityToolName(toolName));
}

export function writeActivityGroupLabel(count: number, running: boolean): string {
  const safeCount = Math.max(0, count);
  const prefix = running ? 'Writing' : 'Wrote';
  return `${prefix} ${safeCount} file${safeCount === 1 ? '' : 's'}`;
}

/**
 * Part types that render nothing of their own in the activity steps list.
 *
 * `step-start` / `step-finish` are the important entries here: the runtime
 * emits a pair of them around EVERY model round-trip, so a run of N tool
 * calls arrives as `step-start, tool, step-finish, step-start, tool, …`. The
 * original bug was treating those as content — every single one broke a
 * group, so twelve consecutive `bash` calls rendered as twelve raw `$ …`
 * rows instead of one "Ran 12 commands" line. `agent` and `retry` paint
 * elsewhere (the agent chip, the retry banner), never in the step list, and
 * must be just as transparent. `snapshot` / `patch` are internal VCS
 * bookkeeping.
 *
 * Mirrors `isStructuralPart` in `activity/activity-model.ts` (kept as a
 * separate, dependency-free copy — `activity-model.ts` already imports FROM
 * this module, so importing back would cycle).
 */
const INVISIBLE_ACTIVITY_PART_TYPES = new Set([
  'snapshot',
  'patch',
  'step-start',
  'step-finish',
  'agent',
  'retry',
]);

/**
 * True when a part renders nothing in the activity steps list (internal
 * snapshot/patch/step/agent/retry bookkeeping and blank text fragments).
 * These must not split a run of groupable tool calls — otherwise consecutive
 * shells, separated only by invisible parts, fragment into inconsistent
 * singles instead of one "Ran N commands" group.
 */
export function isInvisibleActivityPart(part: { type?: string; text?: string }): boolean {
  if (part.type && INVISIBLE_ACTIVITY_PART_TYPES.has(part.type)) return true;
  if (part.type === 'text' && !part.text?.trim()) return true;
  return false;
}
