/**
 * Pure rules behind the activity sheet — the timeline a burst's summary row
 * opens on mobile (`components/session/turn/activity-sheet.tsx`).
 *
 * One entry per tool call. Thinking never shows, so a thought is not an entry.
 * Same-family group rows are unfolded, so every call is its own entry with its
 * own detail view. Grouping and plumbing come from `burstView` (and through it
 * `mergeBurstSteps`), so the sheet lists exactly the steps the summary row
 * counts.
 *
 * No React, no React Native.
 */

import {
  narrationToolName,
  normalizeActivityToolName,
  partOutcome,
  sessionLogOpenCall,
  stepLabel,
  type SessionLogBlock,
  type ToolCallBlock,
} from '@kortix/sdk';
import { activityIconKey, type ActivityIconKey, type BurstView } from './activity';
import { partRawOutput } from './tool-part-accessors';

export type ActivitySheetEntry =
  | {
      kind: 'tool';
      key: string;
      /** A tool call; any other block a burst keeps (a patch summary) is a bare "Used" entry. */
      block: SessionLogBlock;
      /** SDK step label: "Read a.ts", "Running bun test". */
      title: string;
      icon: ActivityIconKey;
      running: boolean;
      failed: boolean;
      /** The call has a body to show (`toolHasDetail`). */
      openable: boolean;
    };

// ─── Tool ────────────────────────────────────────────────────────────────────

/** Rows that navigate or render nothing instead of showing a body. */
const NO_DETAIL_TOOLS: ReadonlySet<string> = new Set(['project_select', 'project_create', 'todoread']);

function hasValue(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0;
  return value !== undefined && value !== null;
}

/** The call has something to show in a detail view: arguments, output, an error, or live progress. */
export function toolHasDetail(call: ToolCallBlock): boolean {
  if (NO_DETAIL_TOOLS.has(normalizeActivityToolName(call.name).replace(/^oc[-_]/, '').replace(/-/g, '_'))) return false;
  if (call.status !== 'complete') return true;
  if (hasValue(partRawOutput(call))) return true;
  const input = call.input;
  return typeof input === 'object' && input !== null && Object.values(input).some(hasValue);
}

const isCall = (block: SessionLogBlock): block is ToolCallBlock => block.type === 'tool_call';

function toolRunning(block: SessionLogBlock, burstRunning: boolean): boolean {
  return burstRunning && isCall(block) && (block.status === 'pending' || block.status === 'running');
}

function toolTitle(block: SessionLogBlock, running: boolean): string {
  const label = stepLabel(block);
  const verb = running ? label.running : label.verb;
  // An unregistered tool's object is its raw identifier; name it in words.
  const object = label.verb === 'Used' && isCall(block) ? narrationToolName(block.name) : label.object;
  return object ? `${verb} ${object}` : verb;
}

function toolEntry(given: SessionLogBlock, burstRunning: boolean): ActivitySheetEntry {
  // A call the closure rule closed reads as the open call it was, as its row does.
  const block = isCall(given) ? sessionLogOpenCall(given) : given;
  const running = toolRunning(block, burstRunning);
  return {
    kind: 'tool',
    key: block.id,
    block,
    title: toolTitle(block, running),
    icon: activityIconKey(block),
    running,
    failed: isCall(block) && !running && partOutcome(block) !== 'ok',
    openable: isCall(block) && toolHasDetail(block),
  };
}

export function activitySheetEntries(view: Pick<BurstView, 'steps' | 'running'>): ActivitySheetEntry[] {
  return view.steps.flatMap<ActivitySheetEntry>((step) => {
    if (step.kind === 'thought') return [];
    if (step.kind === 'group') return step.blocks.map((call) => toolEntry(call, view.running));
    return [toolEntry(step.block, view.running)];
  });
}

// ─── Ownership ───────────────────────────────────────────────────────────────

/**
 * A burst row still owns the open sheet when it shares any block with it. A
 * burst re-keys when its first block leaves (a call split out for a permission
 * prompt), so block identity, not the row, decides.
 */
export function ownsBurst(openBlockIds: ReadonlyArray<string>, blocks: ReadonlyArray<{ id: string }>): boolean {
  return blocks.some((block) => openBlockIds.includes(block.id));
}

/** A permission prompt waits on a call the sheet showed: the sheet must get out of its way. */
export function burstHasPendingPermission(
  callIds: ReadonlyArray<string>,
  permissions: ReadonlyArray<{ tool?: { callID: string } }>,
): boolean {
  return permissions.some((permission) => Boolean(permission.tool && callIds.includes(permission.tool.callID)));
}
