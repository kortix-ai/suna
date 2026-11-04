/**
 * Settled-turn fold: work vs deliverables vs final answer.
 *
 * While the agent works, every segment streams as is. Once the turn settles,
 * the process detail (bursts, interim sentences, sub-agent cards) folds into
 * one "Worked for 2m 14s" row, and only what the user asked for stays open:
 * the deliverables (`show`, `show_user`, `image_gen`) and the final message.
 *
 * Final text = scan from the end, skip deliverables and blank text; if the
 * next segment is a non-empty `text`, it is final. Every other segment before
 * it is work. Deliverables anywhere are hoisted, in order. A turn that ends on
 * a tool (abort, error) has no final text: everything else is work.
 *
 * Interim text that renders a card is a deliverable too: a generative-UI
 * (`openui`) fence, or a setup link (`/secret-intake/<token>`,
 * `/connect/<token>`) that renders a form the user must act on. Folded, the
 * reader never learns it exists, because the row is closed after the turn.
 *
 * Accepts `segmentTurn` output or its `groupShowSegments` post-pass, so a host
 * that never groups show calls uses the same rule.
 */
import { formatDuration } from '../state';
import { isNoGroupActivityTool, normalizeActivityToolName } from './session-activity-groups';
import type { ShowGroupedSegment } from './show-group';

export interface TurnWorkSplit<S extends ShowGroupedSegment = ShowGroupedSegment> {
  /** Folded behind the "Worked for" row. Never empty. */
  work: S[];
  /** Deliverable cards (`show`, `show_user`, `image_gen`, and interim text that renders a generative-UI block or a setup link) and the calls that started an agent or a workflow, in call order, rendered above the final text. */
  hoisted: S[];
  /** The final text segment, or empty when the turn did not end on text. */
  final: S[];
}

/**
 * Calls that started work the person tracks after the turn ends: a sub-agent
 * (`agent`, OpenCode's `task`, a teammate's `agent_spawn`) or a workflow run.
 * Folded behind "Worked for", the turn would say "I asked a researcher" with
 * no researcher in sight. Reading the roster (`list_agents`) stays work.
 */
const STARTED_WORK_TOOLS: ReadonlySet<string> = new Set(['agent', 'task', 'agent_spawn', 'workflow']);

function isDeliverableSegment(segment: ShowGroupedSegment): boolean {
  if (segment.kind === 'show-group') return true;
  if (segment.kind !== 'standalone') return false;
  return isNoGroupActivityTool(segment.part.tool) || STARTED_WORK_TOOLS.has(normalizeActivityToolName(segment.part.tool));
}

/**
 * A fence line that opens a generative-UI block (```openui, ~~~openui-v2, …) at
 * any container depth: top level, in a blockquote, or in a list item. The
 * renderer opens a block at all three (`genui/fence.ts`, `FENCE_START` and
 * `LIST_FENCE`).
 */
const GENUI_FENCE = /^[ \t>]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)?(?:`{3,}|~{3,})[ \t]*openui/im;
/**
 * A setup route the renderer turns into a card: as a link target, inline code,
 * or a bare URL (an autolink). A relative path is always ours. An absolute URL
 * counts only with the `ksl_` token prefix, the rule the web renderer applies
 * to a cross-origin link (`parseSetupLinkHref`).
 */
const SETUP_LINK =
  /(?:^|[\s(<`])(?:\/(?:secret-intake|connect)\/[^\s)>`]|https?:\/\/[^\s)>`/]+\/(?:secret-intake|connect)\/ksl_)/i;

function isCardText(segment: ShowGroupedSegment): boolean {
  if (segment.kind !== 'text') return false;
  const body = segment.part.text ?? '';
  return GENUI_FENCE.test(body) || SETUP_LINK.test(body);
}

function isBlankText(segment: ShowGroupedSegment): boolean {
  return segment.kind === 'text' && !segment.part.text?.trim();
}

/** `null` = render the turn as today: it is still working, or it has no work to fold. */
export function splitTurnWork<S extends ShowGroupedSegment = ShowGroupedSegment>(
  segments: ReadonlyArray<S>,
  opts: { working: boolean },
): TurnWorkSplit<S> | null {
  if (opts.working) return null;

  let finalIndex = -1;
  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i];
    if (isDeliverableSegment(segment) || isBlankText(segment)) continue;
    if (segment.kind === 'text') finalIndex = i;
    break;
  }

  const split: TurnWorkSplit<S> = { work: [], hoisted: [], final: [] };
  segments.forEach((segment, i) => {
    if (i === finalIndex) split.final.push(segment);
    else if (isDeliverableSegment(segment) || isCardText(segment)) split.hoisted.push(segment);
    else split.work.push(segment);
  });
  return split.work.length > 0 ? split : null;
}

/** `Worked for 2m 14s`, or `Worked` when the duration is unknown or under 1s. */
export function workedForLabel(durationMs: number | null): string {
  const duration = durationMs == null ? '' : formatDuration(durationMs);
  return duration ? `Worked for ${duration}` : 'Worked';
}
