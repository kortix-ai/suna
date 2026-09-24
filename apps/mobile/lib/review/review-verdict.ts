/**
 * review-verdict — which call carries a verdict on a review item.
 *
 * The Review inbox unions native rows with adapted Change Requests (`cr:<id>`)
 * and connector calls (`call:<id>`). The native `/act` endpoint rejects adapted
 * ids, so each verdict routes to the flow that owns it (`reviewItemTarget` in
 * `@kortix/sdk`):
 *
 * - Change Request: approve merges, dismiss or reject closes, changes records
 *   the feedback and delivers it to the change's agent. No "answer".
 * - Connector call: approve or deny through `resolveApproval`, the same call the
 *   in-session approval prompt makes. It is never dismissed or sent back.
 * - Native row: `/act` with the verdict and optional feedback.
 *
 * Pure data: unit-tested under `bun test`.
 */
import { reviewItemTarget, type ReviewItemKind, type ReviewVerdict } from '@kortix/sdk';

export type ReviewVerdictCall =
  | { call: 'act'; reviewItemId: string; verdict: ReviewVerdict; feedback: string | undefined }
  | { call: 'merge'; changeRequestId: string }
  | { call: 'close'; changeRequestId: string }
  | { call: 'request_changes'; changeRequestId: string; feedback: string }
  | { call: 'resolve_approval'; executionId: string; decision: 'approve' | 'deny' };

/** The call for `verdict` on item `id`, or null when that flow has no such verdict. */
export function planReviewVerdict(
  id: string,
  verdict: ReviewVerdict,
  feedback?: string,
): ReviewVerdictCall | null {
  const target = reviewItemTarget(id);
  if (target.type === 'change_request') {
    const { changeRequestId } = target;
    if (verdict === 'approve') return { call: 'merge', changeRequestId };
    if (verdict === 'dismiss' || verdict === 'reject') return { call: 'close', changeRequestId };
    if (verdict === 'changes') return { call: 'request_changes', changeRequestId, feedback: feedback ?? '' };
    return null;
  }
  if (target.type === 'connector_call') {
    const { executionId } = target;
    if (verdict === 'approve') return { call: 'resolve_approval', executionId, decision: 'approve' };
    if (verdict === 'reject') return { call: 'resolve_approval', executionId, decision: 'deny' };
    return null;
  }
  return { call: 'act', reviewItemId: target.reviewItemId, verdict, feedback };
}

const VERDICTS_BY_KIND: Record<ReviewItemKind, ReviewVerdict[]> = {
  // No Close on a change (Jay, 2026-09-21): merge it or send it back.
  change: ['approve', 'changes'],
  approval: ['approve', 'reject'],
  output: ['approve', 'changes', 'dismiss'],
  decision: ['answer', 'dismiss'],
  batch: ['approve', 'dismiss'],
};

/** The verdicts a kind offers, primary first. */
export function reviewVerdictsFor(kind: ReviewItemKind): ReviewVerdict[] {
  return VERDICTS_BY_KIND[kind];
}
