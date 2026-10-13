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
import {
  PROJECT_ACTIONS,
  reviewItemTarget,
  type ProjectAction,
  type ReviewItemKind,
  type ReviewVerdict,
} from '@kortix/sdk';

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

const { PROJECT_WRITE, PROJECT_GITOPS_PUSH, PROJECT_GITOPS_MERGE, PROJECT_REVIEW_ACT } = PROJECT_ACTIONS;

/** The leaves the Review page's controls need, in one `useCans` probe. */
export const REVIEW_CONTROL_ACTIONS = [
  PROJECT_WRITE,
  PROJECT_GITOPS_PUSH,
  PROJECT_GITOPS_MERGE,
  PROJECT_REVIEW_ACT,
] as const;

/** A `useCans` result: only an explicit allow counts, so loading reads "no". */
type Cans = Partial<Record<string, { allowed: boolean } | undefined>>;
const holds = (cans: Cans, actions: readonly ProjectAction[]) =>
  actions.every((action) => cans[action]?.allowed === true);

/**
 * The leaves the route behind `plan` asserts (KRTX-1720). Every change request
 * and native route loads the project for write first. Merge asserts
 * project.gitops.merge. Request changes and `/act` assert project.review.act.
 * Close asserts project.write only; it is a review verdict too, so it shows
 * with review.act, as the other verdicts do. A connector call answers per call
 * (the person who launched the session may approve it), and the API sends no
 * per-item verdict yet: null leaves it to `status === 'needs_you'`.
 */
function verdictActions(plan: ReviewVerdictCall): readonly ProjectAction[] | null {
  switch (plan.call) {
    case 'merge':
      return [PROJECT_WRITE, PROJECT_GITOPS_MERGE];
    case 'close':
    case 'request_changes':
    case 'act':
      return [PROJECT_WRITE, PROJECT_REVIEW_ACT];
    case 'resolve_approval':
      return null;
  }
}

/** Whether to offer `verdict` on item `id` to a viewer whose probe answered `cans`. */
export function reviewVerdictAllowed(id: string, verdict: ReviewVerdict, cans: Cans): boolean {
  const plan = planReviewVerdict(id, verdict);
  if (!plan) return false;
  const actions = verdictActions(plan);
  return actions === null || holds(cans, actions);
}

/** Whether to offer + (open a change request): `POST /change-requests` asserts write + gitops.push. */
export function canOpenChangeRequest(cans: Cans): boolean {
  return holds(cans, [PROJECT_WRITE, PROJECT_GITOPS_PUSH]);
}

const VERDICTS_BY_KIND: Record<ReviewItemKind, ReviewVerdict[]> = {
  // The footer's verdicts. A change's Close (`dismiss`) is not among them: it
  // is the sheet's last row, apart from Merge (Jay, 2026-09-21 / 2026-09-27).
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
