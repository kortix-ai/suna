/**
 * session-change-requests — the change requests one session opened, as the
 * thread's bottom cards (`SessionChangeRequests`).
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

type ChangeItem = Extract<ReviewItem, { kind: 'change' }>;

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
