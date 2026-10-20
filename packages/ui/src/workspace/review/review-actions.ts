/**
 * Pure helpers for acting on adapted review items (Change Requests + connector
 * approvals) from the inbox. Kept free of React/query so the id-parsing and
 * URL-building logic — the part worth getting right — is unit-testable.
 *
 * Adapted items carry a namespaced id (`cr:<id>` / `call:<id>`) so the inbox
 * can route a verdict to the right source instead of the native `/act`
 * endpoint, which 409s on them by design (see review-center-connected.tsx).
 */

import type { ReviewVerdict } from '@kortix/sdk';
import { uiRoutes } from '../../lib/routes';
import { approvalReviewable } from '../../session/prompts/session-approval-review';
import { type ReviewItem, type ReviewRisk, segmentForStatus } from './types';

export const CR_ID_PREFIX = 'cr:';
export const CALL_ID_PREFIX = 'call:';

/** Strip the `call:` namespace prefix, returning the underlying
 *  `connectorCalls.executionId` that `resolveApproval` expects — or
 *  `null` if `id` isn't an adapted connector-approval id. */
export function connectorCallId(id: string): string | null {
  return id.startsWith(CALL_ID_PREFIX) ? id.slice(CALL_ID_PREFIX.length) : null;
}

/** Strip the `cr:` namespace prefix, returning the underlying Change Request
 *  id — or `null` if `id` isn't an adapted CR id. */
export function crChangeRequestId(id: string): string | null {
  return id.startsWith(CR_ID_PREFIX) ? id.slice(CR_ID_PREFIX.length) : null;
}

/**
 * Connector approvals are never quick-decidable. The approver must open the
 * parameter-review modal before either decision becomes available.
 */
export function isQuickDecidableApproval(
  // `detail` is `unknown` (not `{ actions?: ... }`) so every ReviewItem union
  // member is assignable — ChangeDetail/OutputDetail have no `actions` and a
  // weak object type would reject them at the call sites.
  item: Pick<ReviewItem, 'kind' | 'id'> & { detail?: unknown },
): boolean {
  void item;
  return false;
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
  return uiRoutes().session(projectId, sessionId);
}

/**
 * What a bulk verdict on a connected selection will REALLY do, decided before
 * any optimistic UI update so the toast/removal can never claim more than the
 * server was asked. The rules the buckets encode:
 *  - Connector approvals are a live question to the agent. Bulk verdicts never
 *    answer them. Each exact call needs a complete parameter review.
 *  - Change Requests have no bulk path at all (merging needs the diff in view).
 */
export interface BulkOutcome {
  /** Ids the verdict genuinely acts on — safe to optimistically update. */
  act: string[];
  /** Retained for compatibility with native bulk-outcome consumers. */
  skippedRisky: string[];
  /** Connector-call approvals that require individual parameter review. */
  skippedApprovals: string[];
  /** Change Requests — each needs its own review. */
  skippedChanges: string[];
}

export function resolveBulkOutcome(
  ids: Iterable<string>,
  verdict: 'approve' | 'dismiss',
  riskOf: (id: string) => ReviewRisk | undefined,
): BulkOutcome {
  void riskOf;
  const act: string[] = [];
  const skippedRisky: string[] = [];
  const skippedApprovals: string[] = [];
  const skippedChanges: string[] = [];
  for (const id of ids) {
    if (crChangeRequestId(id) !== null) {
      skippedChanges.push(id);
    } else if (connectorCallId(id) !== null) {
      skippedApprovals.push(id);
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
      `${outcome.skippedApprovals.length} ${plural(outcome.skippedApprovals.length, 'approval', 'approvals')} kept — review the parameters and decide ${plural(outcome.skippedApprovals.length, 'it', 'each one')} individually`,
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

/** A verb of the select-mode bar. */
export type BulkVerb = 'approve' | 'deny' | 'dismiss';

/** The most ids one `/review/bulk` request takes (the API answers 400 above it). */
export const BULK_MAX = 50;

export const BULK_VERDICT: Record<BulkVerb, ReviewVerdict> = {
  approve: 'approve',
  deny: 'reject',
  dismiss: 'dismiss',
};

/**
 * Whether a bar verb acts on `item`, decided before the request so the bar
 * never sends an id the server must refuse. Approve and Deny decide a pending
 * approval; Approve also needs a call this viewer could review
 * (`approvalReviewable`) that has not expired. Dismiss acts on native items only. A `cr:` id takes no verb.
 */
export function bulkSupports(
  item: ReviewItem,
  verb: BulkVerb,
  allows: (item: ReviewItem, verdict: ReviewVerdict) => boolean,
  now = Date.now(),
): boolean {
  if (segmentForStatus(item.status) !== 'needs_you') return false;
  if (crChangeRequestId(item.id) !== null || !allows(item, BULK_VERDICT[verb])) return false;
  if (verb === 'dismiss') return connectorCallId(item.id) === null;
  if (item.kind !== 'approval') return false;
  if (item.expiresAt && Date.parse(item.expiresAt) <= now) return false;
  const call = item.detail.actions?.[0];
  if (call?.canResolve === false) return false;
  if (verb === 'deny') return true;
  if (call?.previewAuthorized === false) return false;
  return approvalReviewable(call?.rawArgsPreview, call?.reviewComplete);
}

/** True when any bar verb acts on `item`: the row shows a checkbox. */
export function bulkSelectable(
  item: ReviewItem,
  allows: (item: ReviewItem, verdict: ReviewVerdict) => boolean,
): boolean {
  return (['approve', 'deny', 'dismiss'] as const).some((verb) => bulkSupports(item, verb, allows));
}

/** One `/review/bulk` result. */
export interface BulkResult {
  id: string;
  ok: boolean;
  code?: string;
}

const BULK_DONE_KEY = { approve: 'approved', deny: 'denied', dismiss: 'dismissed' } as const;
const BULK_REASON_KEY: Record<string, BulkReasonKey | undefined> = {
  expired: 'reasonExpired',
  already_resolved: 'reasonAlreadyResolved',
  preview_unavailable: 'reasonPreviewUnavailable',
  forbidden: 'reasonForbidden',
  not_found: 'reasonNotFound',
  not_bulk_actionable: 'reasonNotBulkActionable',
};
type BulkReasonKey =
  | 'reasonExpired'
  | 'reasonAlreadyResolved'
  | 'reasonPreviewUnavailable'
  | 'reasonForbidden'
  | 'reasonNotFound'
  | 'reasonNotBulkActionable';
/** The `hardcodedUi.reviewBulk` keys the result line reads. */
export type BulkResultTranslator = (
  key: (typeof BULK_DONE_KEY)[BulkVerb] | BulkReasonKey | 'skipped',
  values?: Record<string, string | number>,
) => string;

/** The toast after a bulk verb: "Approved 4 · 1 skipped (expired)". */
export function bulkResultMessage(
  t: BulkResultTranslator,
  verb: BulkVerb,
  results: readonly BulkResult[],
): string {
  const ok = results.filter((r) => r.ok).length;
  const skipped = results.filter((r) => !r.ok);
  const parts = ok > 0 || skipped.length === 0 ? [t(BULK_DONE_KEY[verb], { count: ok })] : [];
  if (skipped.length > 0) {
    const reasons = [...new Set(skipped.map((r) => r.code ?? 'not_found'))]
      .map((code) => {
        const key = BULK_REASON_KEY[code];
        return key ? t(key) : code;
      })
      .join(', ');
    parts.push(t('skipped', { count: skipped.length, reasons }));
  }
  return parts.join(' · ');
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

/** Time left on a pending approval, in the row's compact idiom ("3h"), and
 *  whether it is under one hour. Null when it has no expiry or already passed. */
export function formatExpiresIn(
  iso: string | undefined,
  now = Date.now(),
): { time: string; soon: boolean } | null {
  const left = iso ? new Date(iso).getTime() - now : Number.NaN;
  if (!(left > 0)) return null;
  // Floored at every step: time left never reads longer than it is, so the
  // under-one-hour glyph never sits beside "1h".
  const mins = Math.max(1, Math.floor(left / 60_000));
  const hrs = Math.floor(mins / 60);
  const time = mins < 60 ? `${mins}m` : hrs < 24 ? `${hrs}h` : `${Math.floor(hrs / 24)}d`;
  return { time, soon: left < 3_600_000 };
}

/** True when the API reports the approval expired before this decision (HTTP 409). */
export function isApprovalExpiredError(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'APPROVAL_EXPIRED';
}

/** Longer relative age with a trailing "ago" — the detail-modal idiom (see
 *  `rel` in review-detail.tsx). */
export function formatItemAgeLong(iso: string, now = Date.now()): string {
  const mins = Math.max(1, Math.round((now - new Date(iso).getTime()) / 60_000));
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}
