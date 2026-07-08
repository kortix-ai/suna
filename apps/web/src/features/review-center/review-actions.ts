/**
 * Pure helpers for acting on adapted review items (Change Requests + executor
 * approvals) from the inbox. Kept free of React/query so the id-parsing and
 * URL-building logic — the part worth getting right — is unit-testable.
 *
 * Adapted items carry a namespaced id (`cr:<id>` / `exec:<id>`) so the inbox
 * can route a verdict to the right source instead of the native `/act`
 * endpoint, which 409s on them by design (see review-center-connected.tsx).
 */

import { type ReviewItem, type ReviewRisk, isSafeRisk } from './types';

export const CR_ID_PREFIX = 'cr:';
export const EXEC_ID_PREFIX = 'exec:';

/** Strip the `exec:` namespace prefix, returning the underlying
 *  `executorExecutions.executionId` that `resolveApproval` expects — or
 *  `null` if `id` isn't an adapted executor-approval id. */
export function execExecutionId(id: string): string | null {
  return id.startsWith(EXEC_ID_PREFIX) ? id.slice(EXEC_ID_PREFIX.length) : null;
}

/** Strip the `cr:` namespace prefix, returning the underlying Change Request
 *  id — or `null` if `id` isn't an adapted CR id. */
export function crChangeRequestId(id: string): string | null {
  return id.startsWith(CR_ID_PREFIX) ? id.slice(CR_ID_PREFIX.length) : null;
}

/**
 * True when the row can show Approve/Deny buttons directly — no modal hop —
 * because the item resolves to exactly one clear decision: a single-action
 * executor approval. Multi-action approvals (the prototype's bulk-approval
 * shape) still need the detail modal, since one button pair can't represent
 * several independent decisions.
 */
export function isQuickDecidableApproval(
  // `detail` is `unknown` (not `{ actions?: ... }`) so every ReviewItem union
  // member is assignable — ChangeDetail/OutputDetail have no `actions` and a
  // weak object type would reject them at the call sites.
  item: Pick<ReviewItem, 'kind' | 'id'> & { detail?: unknown },
): boolean {
  if (item.kind !== 'approval') return false;
  if (execExecutionId(item.id) === null) return false;
  const detail = item.detail as { actions?: readonly unknown[] } | undefined;
  const count = detail?.actions?.length ?? 0;
  return count <= 1;
}

/** Build the deep link that lands the user exactly where they can act on an
 *  item whose source view isn't reachable inline from the inbox — the
 *  item's originating session. Returns `null` when the item has no
 *  originating session to link to (nothing to deep-link into). */
export function itemDeepLink(
  projectId: string,
  sessionId: string | undefined | null,
): string | null {
  if (!projectId || !sessionId) return null;
  return `/projects/${projectId}/sessions/${sessionId}`;
}

/**
 * Split a set of selected ids into the ones a bulk verdict can cover
 * natively (`/review/bulk`) vs. ones that need their own per-item resolve
 * call (executor approvals) vs. ones with no bulk path at all (Change
 * Requests — merging in bulk needs full diff context per item, so they're
 * excluded rather than silently no-op'd).
 */
export interface BulkActionPlan {
  native: string[];
  resolvable: string[];
  unsupported: string[];
}

export function planBulkAction(ids: Iterable<string>): BulkActionPlan {
  const native: string[] = [];
  const resolvable: string[] = [];
  const unsupported: string[] = [];
  for (const id of ids) {
    if (execExecutionId(id) !== null) resolvable.push(id);
    else if (crChangeRequestId(id) !== null) unsupported.push(id);
    else native.push(id);
  }
  return { native, resolvable, unsupported };
}

/**
 * What a bulk verdict on a connected selection will REALLY do, decided before
 * any optimistic UI update so the toast/removal can never claim more than the
 * server was asked. The rules the buckets encode:
 *  - Executor approvals are a live question to the agent: "dismiss" doesn't
 *    answer it, so they're KEPT (never mapped to a deny) under any non-approve
 *    verdict, and an approve sweep still respects the safe-risk floor.
 *  - Change Requests have no bulk path at all (merging needs the diff in view).
 */
export interface BulkOutcome {
  /** Ids the verdict genuinely acts on — safe to optimistically update. */
  act: string[];
  /** Exec approvals blocked by the approve safe-risk floor. */
  skippedRisky: string[];
  /** Exec approvals kept under a non-approve verdict (dismiss ≠ deny). */
  skippedApprovals: string[];
  /** Change Requests — each needs its own review. */
  skippedChanges: string[];
}

export function resolveBulkOutcome(
  ids: Iterable<string>,
  verdict: 'approve' | 'dismiss',
  riskOf: (id: string) => ReviewRisk | undefined,
): BulkOutcome {
  const act: string[] = [];
  const skippedRisky: string[] = [];
  const skippedApprovals: string[] = [];
  const skippedChanges: string[] = [];
  for (const id of ids) {
    if (crChangeRequestId(id) !== null) {
      skippedChanges.push(id);
    } else if (execExecutionId(id) !== null) {
      if (verdict !== 'approve') skippedApprovals.push(id);
      else if (!isSafeRisk(riskOf(id) ?? 'high')) skippedRisky.push(id);
      else act.push(id);
    } else {
      act.push(id);
    }
  }
  return { act, skippedRisky, skippedApprovals, skippedChanges };
}

/** One compact sentence describing what a bulk verdict skipped (empty string
 *  when nothing was). Kept pure so the copy is unit-testable. */
export function bulkSkipMessage(outcome: BulkOutcome): string {
  const parts: string[] = [];
  const plural = (n: number, s: string, p: string) => (n === 1 ? s : p);
  if (outcome.skippedApprovals.length > 0)
    parts.push(
      `${outcome.skippedApprovals.length} ${plural(outcome.skippedApprovals.length, 'approval', 'approvals')} kept — dismissing doesn't answer the agent; approve or deny ${plural(outcome.skippedApprovals.length, 'it', 'them')}`,
    );
  if (outcome.skippedRisky.length > 0)
    parts.push(
      `${outcome.skippedRisky.length} risky ${plural(outcome.skippedRisky.length, 'approval', 'approvals')} skipped — review ${plural(outcome.skippedRisky.length, 'it', 'them')} individually`,
    );
  if (outcome.skippedChanges.length > 0)
    parts.push(
      `${outcome.skippedChanges.length} ${plural(outcome.skippedChanges.length, 'change', 'changes')} skipped — open ${plural(outcome.skippedChanges.length, 'it', 'each')} to review`,
    );
  return parts.join('. ');
}

/** Relative age like "7m", "3h", "2d" — the compact inbox-row idiom (see
 *  `TimeAgo` in review-center.tsx, which renders this client-only to avoid
 *  an SSR/hydration mismatch on `Date.now()`). */
export function formatItemAge(iso: string, now = Date.now()): string {
  const mins = Math.max(1, Math.round((now - new Date(iso).getTime()) / 60_000));
  if (mins < 60) return `${mins}m`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.round(hrs / 24)}d`;
}

/** Longer relative age with a trailing "ago" — the detail-modal idiom (see
 *  `rel` in review-detail-modal.tsx). */
export function formatItemAgeLong(iso: string, now = Date.now()): string {
  const mins = Math.max(1, Math.round((now - new Date(iso).getTime()) / 60_000));
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}
