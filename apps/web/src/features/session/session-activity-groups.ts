import { isShowPayloadEmpty } from './show-availability';

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
 * Parts that render nothing in the activity steps list (internal snapshot/patch/
 * step-start/step-finish bookkeeping and blank text fragments). They must not
 * split a run of groupable tool calls — otherwise consecutive shells, separated
 * only by invisible parts, fragment into inconsistent singles instead of one
 * "Ran N commands" group.
 *
 * step-start/step-finish specifically must never reach a burst: `stepLabel`
 * has no case for them (falls through to the generic 'Used'/'Using' primary
 * label), which would both inflate the collapsed burst title's tool count and
 * render nothing when expanded, since they are neither tool nor reasoning
 * parts. Filtering them here, at the one place both segmentation and title
 * counting read from, fixes both problems at once.
 *
 * A settled `show` with no artifact belongs to the same category (see
 * `isEmptyShowPart`), and for the same structural reason: returning `null` from
 * the renderer is not enough. The step still wraps it in a row, the chain still
 * draws its rail, and the reader gets a blank gap where a deliverable should
 * be. The part has to be dropped before segmentation, not after.
 */
export function isInvisibleActivityPart(part: ActivityPartLike): boolean {
  if (part.type === 'snapshot' || part.type === 'patch') return true;
  if (part.type === 'step-start' || part.type === 'step-finish') return true;
  if (part.type === 'text' && !part.text?.trim()) return true;
  if (isEmptyShowPart(part)) return true;
  return false;
}

/** The fields this module reads off a part. Deliberately structural — the turn
 *  modules pass real `Part`s, the tests pass literals. */
export interface ActivityPartLike {
  type?: string;
  text?: string;
  tool?: string;
  state?: { status?: string; input?: Record<string, unknown> | null } | null;
}

/**
 * A settled `show` that handed over nothing.
 *
 * The show tool rejects a call missing its required field and returns an error
 * string, but the tool part keeps the arguments the model sent — so the chat
 * drew a card with a header and an empty body. That reads as a broken UI, not
 * as a failed call, and there is nothing inside it to read.
 *
 * Two deliberate limits on when this fires:
 *
 *   - **`completed` only.** A `pending`/`running` call has not finished
 *     streaming its arguments; its input is empty because it has not arrived
 *     yet, and hiding it would make the row flicker in mid-turn. The running
 *     card carries its own spinner and stays.
 *   - **Never `error`.** A call whose STATE is an error renders the failure
 *     card from `ToolPartRenderer`, which is real content about a real event.
 *     Failures stay visible; only the blank card goes.
 *
 * No `type === 'tool'` check is needed: only a tool part carries `tool`, so a
 * text/reasoning/snapshot part normalizes to `''` and falls out on the name.
 * That keeps this callable from `shouldShowToolPartInActionsPanel`, which is
 * handed a `Pick<ToolPart, 'tool' | 'state'>` with no `type` on it.
 */
export function isEmptyShowPart(part: ActivityPartLike): boolean {
  const name = normalizeActivityToolName(part.tool);
  if (name !== 'show' && name !== 'show_user') return false;
  if (part.state?.status !== 'completed') return false;
  return isShowPayloadEmpty(part.state?.input);
}

/**
 * Tools that always render on their own, never folded into a burst.
 *
 *   - show / show_user: a deliverable handed to the user. Folding it behind a
 *     collapsed row means it can be missed.
 *   - agent_*: a spawned sub-agent has its own lifecycle and status. Folding it
 *     in would hide a running agent behind a collapsed row.
 */
export const STANDALONE_TOOLS: ReadonlySet<string> = new Set([
  'show',
  'show_user',
  'agent_spawn',
  'agent_status',
  'agent_message',
  'agent_task_update',
  'agent_stop',
]);

export function isStandaloneActivityTool(toolName: string | undefined): boolean {
  return STANDALONE_TOOLS.has(normalizeActivityToolName(toolName));
}
