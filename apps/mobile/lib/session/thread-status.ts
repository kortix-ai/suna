/**
 * thread-status — the floating thread header's status line (COR-140): the
 * 13pt muted line under the session title reading "Working · 2 min",
 * "Needs you", or "Done · 3 min ago".
 *
 * Pure data and pure functions only. No React, no React Native, no expo —
 * this module is unit-tested under `bun test`, which cannot load native
 * modules. A caller feeds it the session's busy/question/permission state,
 * whether the session has any message yet, and the two timestamps (when the
 * working turn started, when the session was last updated); this module owns
 * only the words and the rounding.
 *
 * No screen renders it today: the thread header shows the title only (Jay,
 * 2026-09-23, `SessionThreadTitle`).
 */

import { spokenRelative } from './session-list';

export type ThreadStatusKind = 'working' | 'needs-you' | 'done';

export interface ThreadStatusInput {
  /** The sandbox is running this session's turn right now. */
  isBusy: boolean;
  /** A question or a permission prompt is pending on this session. Wins over
   *  `isBusy` — a session that is both busy and blocked on the reader reads
   *  "Needs you", matching the header's old status-dot precedence (amber
   *  over green). */
  needsYou: boolean;
  /** When the current working turn started, epoch ms. `null` when the run's
   *  start is not known (e.g. the working turn has not laid out yet) — the
   *  label then reads "Working" with no elapsed time. */
  workingStartedAtMs: number | null;
  /** The session's last activity, epoch ms — read only while idle. `null`
   *  when not yet known — the label then reads "Done" with no relative time. */
  lastActivityAtMs: number | null;
  /** The session has at least one message. A new, empty session has no
   *  status line: it is not "Done". Defaults to true. */
  hasMessages?: boolean;
  nowMs: number;
}

export interface ThreadStatusResult {
  kind: ThreadStatusKind;
  label: string;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** "2 min" under an hour (rounded), "3 hr" from an hour on (floored); `null`
 *  under a minute — the caller then omits the elapsed segment instead of
 *  reading "0 min". */
function elapsedLabel(ms: number): string | null {
  if (!Number.isFinite(ms) || ms < MINUTE_MS) return null;
  if (ms < HOUR_MS) return `${Math.min(59, Math.round(ms / MINUTE_MS))} min`;
  return `${Math.floor(ms / HOUR_MS)} hr`;
}

/**
 * `ms` ago in words: "just now", "3 minutes ago", "2 hours ago", "4 days
 * ago" — `session-list.ts`'s `spokenRelative` buckets, so this line and the
 * session list never disagree. Negative or non-finite input is "just now".
 */
export function relativeAgoLabel(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return 'just now';
  return spokenRelative(0, ms);
}

/**
 * The thread header's status line, or `null` for none. Precedence: a pending
 * question/permission always wins ("Needs you"), then a running turn
 * ("Working[ · elapsed]"), then a session with no message yet (no line),
 * then idle ("Done[ · ago]").
 */
export function threadStatus(input: ThreadStatusInput): ThreadStatusResult | null {
  if (input.needsYou) return { kind: 'needs-you', label: 'Needs you' };

  if (input.isBusy) {
    const elapsed =
      input.workingStartedAtMs !== null ? elapsedLabel(input.nowMs - input.workingStartedAtMs) : null;
    return { kind: 'working', label: elapsed ? `Working · ${elapsed}` : 'Working' };
  }

  if (input.hasMessages === false) return null;

  const ago = input.lastActivityAtMs !== null ? relativeAgoLabel(input.nowMs - input.lastActivityAtMs) : null;
  return { kind: 'done', label: ago ? `Done · ${ago}` : 'Done' };
}
