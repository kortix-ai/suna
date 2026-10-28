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
 * Accepts `segmentTurn` output or its `groupShowSegments` post-pass, so a host
 * that never groups show calls uses the same rule.
 */
import { formatDuration } from '../state';
import { isNoGroupActivityTool } from './session-activity-groups';
import type { ShowGroupedSegment } from './show-group';

export interface TurnWorkSplit<S extends ShowGroupedSegment = ShowGroupedSegment> {
  /** Folded behind the "Worked for" row. Never empty. */
  work: S[];
  /** Deliverable cards (`show`, `show_user`, `image_gen`), in call order, rendered above the final text. */
  hoisted: S[];
  /** The final text segment, or empty when the turn did not end on text. */
  final: S[];
}

function isDeliverableSegment(segment: ShowGroupedSegment): boolean {
  if (segment.kind === 'show-group') return true;
  return segment.kind === 'standalone' && isNoGroupActivityTool(segment.part.tool);
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
    else if (isDeliverableSegment(segment)) split.hoisted.push(segment);
    else split.work.push(segment);
  });
  return split.work.length > 0 ? split : null;
}

/** `Worked for 2m 14s`, or `Worked` when the duration is unknown or under 1s. */
export function workedForLabel(durationMs: number | null): string {
  const duration = durationMs == null ? '' : formatDuration(durationMs);
  return duration ? `Worked for ${duration}` : 'Worked';
}
