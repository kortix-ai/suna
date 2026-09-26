/**
 * needs-you — which sessions wait on the user, and why, from the project's
 * review inbox (`useReviewItems`: connector approvals, change requests,
 * agent-submitted reviews and decisions). Each inbox item carries its
 * originating session (`sessionId`); web's sidebar folds the same list the
 * same way (`summarizeReviewSessions`).
 *
 * Pending OpenCode permissions and `question`-tool questions are not in the
 * inbox: the API keeps no project-wide list of them, so a session waiting on
 * one only shows it inside its open thread.
 *
 * Pure data and pure functions only — unit-tested under `bun test`.
 */

import type { ReviewItem } from '@kortix/sdk';

/** The fields of a review item this module reads. */
export type NeedsYouItem = Pick<ReviewItem, 'status' | 'kind' | 'title' | 'createdAt'> & {
  sessionId?: string;
};

export interface SessionNeedsYou {
  /** `needs_you` items from this session. Always ≥ 1. */
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
 */
export function needsYouBySession(items: readonly NeedsYouItem[]): Map<string, SessionNeedsYou> {
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
  for (const [sessionId, { item, at, count }] of newest) {
    const reason = needsYouReason(item);
    result.set(sessionId, {
      count,
      reason: count > 1 ? `${reason} · ${count - 1} more` : reason,
      newestAt: at,
    });
  }
  return result;
}
