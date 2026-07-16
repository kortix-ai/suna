/**
 * Collapse an ordered ToolPart[] into the story Easy mode tells.
 *
 * Consecutive calls in the same family become one step ("Read 6 files"), which
 * is what turns a 60-call run into an ~8-line narrative. Three tools are exempt:
 * write / show / show_user are distinct artifacts the user has to actually see,
 * so folding them would hide output. That rule already exists in
 * `session-activity-groups.ts` — we reuse it rather than restate it.
 */

import type { ToolPart } from '@/ui';
import { isNoGroupActivityTool } from '../../session-activity-groups';
import { type StepFamily, familyForTool, narrateFailedStep, narrateStep } from './narration';

export interface Step {
  /** Stable across re-renders: the callID of the step's first part. */
  id: string;
  family: StepFamily;
  label: string;
  parts: ToolPart[];
  status: 'running' | 'error' | 'done';
  durationMs?: number;
}

function statusOf(parts: ToolPart[]): Step['status'] {
  if (parts.some((p) => p.state?.status === 'running' || p.state?.status === 'pending')) {
    return 'running';
  }
  if (parts.some((p) => p.state?.status === 'error')) return 'error';
  return 'done';
}

/**
 * Wall-clock duration of a step. `state.time` is not on the typed interface but
 * is present at runtime — `advanced/advanced-panel.tsx` reads it the same way.
 */
function durationOf(parts: ToolPart[]): number | undefined {
  let start = Number.POSITIVE_INFINITY;
  let end = 0;
  for (const p of parts) {
    const time = (p.state as unknown as { time?: { start?: number; end?: number } }).time;
    if (typeof time?.start === 'number') start = Math.min(start, time.start);
    if (typeof time?.end === 'number') end = Math.max(end, time.end);
  }
  if (!Number.isFinite(start) || end <= start) return undefined;
  return end - start;
}

function finalize(family: StepFamily, parts: ToolPart[]): Step {
  const status = statusOf(parts);
  return {
    id: parts[0].callID,
    family,
    // A failed step must never wear success wording — "Wrote budget.csv" for a
    // write that errored is the panel lying (W7).
    label: status === 'error' ? narrateFailedStep(family, parts) : narrateStep(family, parts),
    parts,
    status,
    // A duration must never sit next to a live spinner — a running step may
    // still carry stale/partial `time` data from a prior run of the same
    // callID, and pairing that with the shimmer would visually claim the
    // step is both finished and still going.
    durationMs: status === 'running' ? undefined : durationOf(parts),
  };
}

export function groupSteps(parts: ToolPart[]): Step[] {
  const steps: Step[] = [];
  let family: StepFamily | null = null;
  let buffer: ToolPart[] = [];

  const flush = () => {
    if (family && buffer.length) steps.push(finalize(family, buffer));
    family = null;
    buffer = [];
  };

  for (const part of parts) {
    const f = familyForTool(part.tool);
    if (f === 'hidden') continue; // dropped, and must not split a run

    // write / show / show_user each stand alone.
    if (isNoGroupActivityTool(part.tool)) {
      flush();
      steps.push(finalize(f, [part]));
      continue;
    }

    if (f !== family) {
      flush();
      family = f;
    }
    buffer.push(part);
  }
  flush();

  return steps;
}
