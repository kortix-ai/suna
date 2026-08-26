/**
 * Pure mapping + list logic behind every connector-approval surface.
 *
 * Three views read a `SessionAuditAction` and render the SAME decision: the
 * in-session notice above the composer (`session-approval-prompt.tsx`), the
 * Audit side panel (`session-audit-panel.tsx`), and the standalone
 * /approve/<token> page (via `ApprovalLinkDetails`, which the API derives from
 * the same row). Keeping the row → `ApprovalRequestData` translation here means
 * one definition of "what does this call touch?" instead of three drifting
 * copies, and makes it testable without rendering anything.
 */

import type {
  ApprovalDecisionValue,
  ApprovalRequestData,
} from '@/components/approvals/approval-request';
import type { SessionAuditAction } from '@kortix/sdk';

/** Fields that answer "what does this touch?" — surfaced first, in this order. */
const PRIORITY_ARGS = ['to', 'recipient', 'recipients', 'channel', 'url', 'subject'];

/** How many `key: value` pairs the one-line collapsed summary shows. */
const SUMMARY_FIELDS = 2;

/** A gated action still awaiting a human decision (unresolved `pending_approval`). */
function pendingByStatus(action: SessionAuditAction): boolean {
  return action.status === 'pending_approval' && !action.resolved_at;
}

/**
 * The REDACTED arguments the gateway recorded on the row. Null for a row
 * written before arg previews existed — callers then show the tool name alone.
 */
export function approvalArgsPreview(action: SessionAuditAction): Record<string, unknown> | null {
  const summary = action.result_summary;
  if (!summary || typeof summary !== 'object') return null;
  const preview = summary.args_preview;
  if (!preview || typeof preview !== 'object' || Array.isArray(preview)) return null;
  return preview as Record<string, unknown>;
}

/** One-line "where is this going?" rendering for a collapsed row. */
export function approvalArgsSummary(action: SessionAuditAction): string | null {
  const preview = approvalArgsPreview(action);
  if (!preview) return null;

  const rank = (key: string) => {
    const index = PRIORITY_ARGS.indexOf(key.toLowerCase());
    return index === -1 ? PRIORITY_ARGS.length : index;
  };
  const entries = Object.entries(preview).sort((left, right) => rank(left[0]) - rank(right[0]));

  const parts: string[] = [];
  for (const [key, value] of entries) {
    // '[redacted]' is the server's marker for a credential-shaped field; showing
    // it would add noise without adding information.
    if (value === null || value === undefined || value === '[redacted]') continue;
    const rendered = Array.isArray(value) ? value.join(', ') : String(value);
    if (!rendered) continue;
    parts.push(`${key}: ${rendered}`);
    if (parts.length === SUMMARY_FIELDS) break;
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** Row → the shape every approval surface renders. */
export function approvalRequestFromAction(
  action: SessionAuditAction,
  pending = pendingByStatus(action),
): ApprovalRequestData {
  const summary = action.result_summary;
  const decision = summary?.decision;
  return {
    action: action.action,
    risk: action.risk,
    requestedAt: action.at,
    argsPreview: approvalArgsPreview(action),
    // `!summary` used to count as complete, so a pending row that recorded
    // NOTHING offered an Approve button the server answers with 409
    // (`APPROVAL_PREVIEW_UNAVAILABLE`) — the client and the gate disagreed. A
    // pending row is complete only when it says so.
    reviewComplete: !pending || summary?.args_preview_complete === true,
    resolution: decision === 'approve' || decision === 'deny' ? decision : null,
    pending,
    status: action.status,
    resolvedAt: action.resolved_at,
  };
}

/** A decision this browser just made, kept so the card can confirm it in place. */
export interface DecidedApproval {
  /** Snapshot of the row as it was when the decision was taken. The audit poll
   *  drops a resolved row entirely when the account has no historical audit
   *  access, so the notice cannot re-read it from the query. */
  action: SessionAuditAction;
  decision: ApprovalDecisionValue;
}

export interface ApprovalNoticeRow {
  action: SessionAuditAction;
  /** Null while awaiting a decision; set once this browser resolved it. */
  decision: ApprovalDecisionValue | null;
}

/**
 * What the in-session notice renders: every unresolved approval, plus the ones
 * this browser just decided (so the card confirms the outcome in place instead
 * of vanishing mid-click). Newest first, matching the API's own ordering.
 */
export function approvalNoticeRows(
  actions: readonly SessionAuditAction[],
  decided: Readonly<Record<string, DecidedApproval>>,
): ApprovalNoticeRow[] {
  const rows = new Map<string, ApprovalNoticeRow>();
  for (const action of actions) {
    if (!pendingByStatus(action)) continue;
    rows.set(action.execution_id, { action, decision: null });
  }
  for (const [executionId, entry] of Object.entries(decided)) {
    rows.set(executionId, { action: entry.action, decision: entry.decision });
  }
  return [...rows.values()].sort((left, right) => {
    const delta = Date.parse(right.action.at) - Date.parse(left.action.at);
    if (delta !== 0) return delta;
    return left.action.execution_id.localeCompare(right.action.execution_id);
  });
}

/** Headline for the notice. `hint` is null once nothing is left to decide. */
export function approvalNoticeHeadline(pendingCount: number): {
  title: string;
  hint: string | null;
} {
  if (pendingCount === 0) return { title: 'Decision recorded', hint: null };
  if (pendingCount === 1) {
    return { title: 'The agent needs your approval', hint: 'waiting for one decision' };
  }
  return {
    title: `${pendingCount} actions need your approval`,
    hint: `waiting for ${pendingCount} decisions`,
  };
}

/** Accordion toggle — one open row at a time keeps the pinned notice small. */
export function nextExpandedApproval(current: string | null, executionId: string): string | null {
  return current === executionId ? null : executionId;
}
