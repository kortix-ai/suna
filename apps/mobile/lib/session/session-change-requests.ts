/**
 * session-change-requests — the change requests one session opened, as cards
 * at the end of the turn that opened each one (`SessionChangeRequests`).
 *
 * Web shows each change request as an outcome card in the thread
 * (`features/session/outcomes/change-request-outcomes.ts`). Mobile reads them
 * from the Review list (`useReviewItems`) instead of a second query: every
 * change request of the project is a `kind: 'change'` item there, in every
 * state, with the session that opened it (`sessionId`). A tap then opens the
 * same `ReviewDetailSheet` the Review page opens.
 *
 * Pure data: unit-tested under `bun test`.
 */
import type { ReviewItem, ReviewItemStatus } from '@kortix/sdk';

export type ChangeItem = Extract<ReviewItem, { kind: 'change' }>;

/** The change requests `projectSessionId` opened, oldest first. */
export function sessionChangeRequests(
  items: readonly ReviewItem[] | undefined,
  projectSessionId: string | undefined,
): ChangeItem[] {
  if (!items || !projectSessionId) return [];
  return items
    .filter((item): item is ChangeItem => item.kind === 'change' && item.sessionId === projectSessionId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** A turn's key (its user message id) and its start, epoch ms. */
export interface TurnStart {
  key: string;
  startedAt: number | null;
}

/**
 * Which turn shows each change request: the turn with the latest start at or
 * before the change request's `createdAt` (web `anchorOutcomes`). Nothing is
 * dropped: one opened before the first loaded turn anchors to the first.
 * Turns that opened none have no entry.
 */
export function anchorChangeRequests(
  items: readonly ChangeItem[],
  turns: readonly TurnStart[],
): Map<string, ChangeItem[]> {
  const byTurn = new Map<string, ChangeItem[]>();
  if (turns.length === 0) return byTurn;
  for (const item of items) {
    const at = Date.parse(item.createdAt);
    let target = turns[0];
    let best = -Infinity;
    for (const turn of turns) {
      if (turn.startedAt === null) continue;
      if (turn.startedAt <= at && turn.startedAt > best) {
        best = turn.startedAt;
        target = turn;
      }
    }
    const list = byTurn.get(target.key);
    if (list) list.push(item);
    else byTurn.set(target.key, [item]);
  }
  return byTurn;
}

// Web's words (`change-request-outcomes.ts`): open · merged · closed.
const STATUS_LABEL: Partial<Record<ReviewItemStatus, string>> = {
  needs_you: 'Waiting for you',
  waiting: 'Waiting for you',
  approved: 'Applied',
  done: 'Applied',
  rejected: 'Closed',
  dismissed: 'Closed',
  changes_requested: 'Changes requested',
};

/** "Change request #8 · Waiting for you": the card's line under the title. */
export function changeRequestStatusLabel(item: ReviewItem): string {
  const number = item.kind === 'change' ? item.detail.number : undefined;
  const name = number != null ? `Change request #${number}` : 'Change request';
  return `${name} · ${STATUS_LABEL[item.status] ?? 'Waiting for you'}`;
}
