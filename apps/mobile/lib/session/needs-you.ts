/**
 * needs-you — which sessions wait on the user, and why, from the project's
 * review inbox (`useReviewItems`: connector approvals, change requests,
 * agent-submitted reviews and decisions) and from GET needs-input
 * (`useSessionsNeedingInput`: open `question`-tool questions and pending
 * connector approvals, per session; KRTX-1739). Each inbox item carries its
 * originating session (`sessionId`); web's lists fold the same two reads the
 * same way (`useSessionNeedsYouCounts`).
 *
 * Pending runtime permission requests are in neither read: a session waiting
 * on one only shows it inside its open thread.
 *
 * Pure data and pure functions only — unit-tested under `bun test`.
 */

import type { ReviewItem, SessionsNeedingInputResponse } from '@kortix/sdk';

/** The fields of a review item this module reads. */
export type NeedsYouItem = Pick<ReviewItem, 'status' | 'kind' | 'title' | 'createdAt'> & {
  sessionId?: string;
};

export interface SessionNeedsYou {
  /** What waits on the user in this session: inbox items, open agent questions, approvals. Always ≥ 1. */
  count: number;
  /** One line: the newest item's wait, then how many more ("Asked: … · 2 more"). */
  reason: string;
  /** Epoch ms of the newest item; orders the drawer's Needs you group. */
  newestAt: number;
}

const REASON_PREFIX: Record<ReviewItem['kind'], string> = {
  approval: 'Approve',
  change: 'Change request',
  decision: 'Asked',
  output: 'Review',
  batch: 'Review',
};

const REASON_WITHOUT_TITLE: Record<ReviewItem['kind'], string> = {
  approval: 'Waiting for your approval',
  change: 'Change request to review',
  decision: 'Waiting for your answer',
  output: 'Waiting for your review',
  batch: 'Waiting for your review',
};

/** One item's wait, in words: "Approve: (Gmail) Send Email", "Asked: Keep 3 tiers or 4?". */
export function needsYouReason(item: Pick<NeedsYouItem, 'kind' | 'title'>): string {
  const title = item.title.trim();
  return title ? `${REASON_PREFIX[item.kind]}: ${title}` : REASON_WITHOUT_TITLE[item.kind];
}

function createdAtMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

/**
 * Session id → what it waits on. Only `needs_you` items with a session count;
 * an item with no session belongs to the Review page alone.
 *
 * `needsInput` adds what GET needs-input lists. A session in both takes the
 * larger count, because a pending connector approval is in both reads. A
 * session it alone lists waits on an agent question: "Waiting for your answer",
 * ordered after the inbox items (`newestAt` 0: the read carries no time). The
 * read also keys each session by its runtime id; lookups go by `session_id`,
 * so those entries are inert.
 */
export function needsYouBySession(
  items: readonly NeedsYouItem[],
  needsInput?: SessionsNeedingInputResponse,
): Map<string, SessionNeedsYou> {
  const newest = new Map<string, { item: NeedsYouItem; at: number; count: number }>();
  for (const item of items) {
    if (item.status !== 'needs_you' || !item.sessionId) continue;
    const at = createdAtMs(item.createdAt);
    const entry = newest.get(item.sessionId);
    if (!entry) {
      newest.set(item.sessionId, { item, at, count: 1 });
      continue;
    }
    entry.count += 1;
    if (at > entry.at) {
      entry.item = item;
      entry.at = at;
    }
  }
  const result = new Map<string, SessionNeedsYou>();
  for (const [sessionId, { item, at, count: itemCount }] of newest) {
    const count = Math.max(itemCount, needsInput?.sessions[sessionId] ?? 0);
    const reason = needsYouReason(item);
    result.set(sessionId, {
      count,
      reason: count > 1 ? `${reason} · ${count - 1} more` : reason,
      newestAt: at,
    });
  }
  for (const [sessionId, count] of Object.entries(needsInput?.sessions ?? {})) {
    if (count > 0 && !result.has(sessionId)) {
      result.set(sessionId, { count, reason: REASON_WITHOUT_TITLE.decision, newestAt: 0 });
    }
  }
  return result;
}
