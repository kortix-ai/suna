/**
 * review-optimistic — a verdict moves its item at the tap, not after the call.
 *
 * A Change Request merge runs git work on the server (manifest read, merge,
 * push) and takes seconds. The Review list must not wait for it: while a
 * verdict is in flight, its item shows the status the verdict lands it in
 * (always a Done status). A failure drops the override, so the item returns
 * to its segment and the caller toasts.
 *
 * Pure data: unit-tested under `bun test`.
 */
import type { ReviewItemStatus, ReviewVerdict } from '@kortix/sdk';

const RESULT_STATUS: Record<ReviewVerdict, ReviewItemStatus> = {
  approve: 'approved',
  reject: 'rejected',
  changes: 'changes_requested',
  dismiss: 'dismissed',
  answer: 'done',
};

/** The status a verdict lands its item in. */
export function verdictResultStatus(verdict: ReviewVerdict): ReviewItemStatus {
  return RESULT_STATUS[verdict];
}

/** `items` with each overridden item's status replaced. Untouched items keep their reference. */
export function applyReviewStatuses<T extends { id: string; status: ReviewItemStatus }>(
  items: T[],
  overrides: Record<string, ReviewItemStatus>,
): T[] {
  if (Object.keys(overrides).length === 0) return items;
  return items.map((item) => {
    const status = overrides[item.id];
    return status && status !== item.status ? { ...item, status } : item;
  });
}
