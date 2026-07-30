/**
 * Turn segmentation.
 *
 * A burst is a maximal run of non-text parts. Only an assistant TEXT part
 * closes a burst. This replaces the old tool-identity grouping, which shattered
 * an interleaved run of read → web_search → read into three sibling cards.
 *
 * No React import. Every rule here is unit-tested in segment-turn.test.ts.
 */
import { isInvisibleActivityPart, isStandaloneActivityTool } from '../session-activity-groups';
import { isTextPart, isToolPart, type Part, type TextPart, type ToolPart } from '@/ui';

export type Segment =
  | { kind: 'burst'; parts: Part[] }
  | { kind: 'text'; part: TextPart }
  | { kind: 'standalone'; part: ToolPart };

export interface SegmentTurnOptions {
  /** callIDs with a pending permission or an active question — always standalone. */
  standaloneCallIds?: ReadonlySet<string>;
}

export function segmentTurn(
  parts: ReadonlyArray<Part>,
  opts: SegmentTurnOptions = {},
): Segment[] {
  const segments: Segment[] = [];
  let pending: Part[] = [];

  const flush = () => {
    if (pending.length > 0) {
      segments.push({ kind: 'burst', parts: pending });
      pending = [];
    }
  };

  for (const part of parts) {
    // Snapshot/patch bookkeeping and blank text render nothing. They must not
    // split a run of groupable tool calls — otherwise consecutive shells
    // fragment into inconsistent singles instead of one "Ran N commands" group.
    if (isInvisibleActivityPart(part)) continue;

    if (isTextPart(part)) {
      flush();
      segments.push({ kind: 'text', part });
      continue;
    }

    if (isToolPart(part)) {
      const standalone =
        isStandaloneActivityTool(part.tool) || !!opts.standaloneCallIds?.has(part.callID);
      if (standalone) {
        flush();
        segments.push({ kind: 'standalone', part });
        continue;
      }
    }

    pending.push(part);
  }

  flush();
  return segments;
}
