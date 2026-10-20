import type { UiTranslator } from '../../i18n';
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
} from './approval-request';
import type { ProjectSession, SessionAuditAction } from '@kortix/sdk';

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
export function approvalArgsSummary(
  action: SessionAuditAction,
  /** Bound Slack conversation ids → names: the summary reads the name. */
  channelNames?: ReadonlyMap<string, string>,
): string | null {
  return previewArgsSummary(approvalArgsPreview(action), channelNames);
}

/** `approvalArgsSummary` for a preview record already in hand (a Review
 *  Center item's resolved or raw arguments). */
export function previewArgsSummary(
  preview: Record<string, unknown> | null | undefined,
  channelNames?: ReadonlyMap<string, string>,
): string | null {
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
    // A nested object reads as compact JSON, never `[object Object]`.
    const text = (item: unknown) =>
      item !== null && typeof item === 'object' ? JSON.stringify(item) : String(item);
    const rendered = Array.isArray(value) ? value.map(text).join(', ') : text(value);
    if (!rendered) continue;
    parts.push(`${key}: ${(typeof value === 'string' && channelNames?.get(value)) || rendered}`);
    if (parts.length === SUMMARY_FIELDS) break;
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** The summary of the content Kortix resolved, else of the call's own
 *  arguments. An empty resolved preview (`{}`) falls through. An email (the
 *  resolved content merged over the arguments has a recipient) reads
 *  `to · subject`, never the sender the server loaded. */
export function reviewArgsSummary(
  resolvedPreview: Record<string, unknown> | null | undefined,
  argsPreview: Record<string, unknown> | null | undefined,
): string | null {
  const merged = { ...argsPreview, ...resolvedPreview };
  const to = merged.to ?? merged.recipient_email ?? merged.recipients;
  if (to !== undefined) {
    const text = (value: unknown) =>
      Array.isArray(value) ? value.join(', ') : value === null || value === undefined ? '' : String(value);
    const parts = [text(to), text(merged.subject)].filter(Boolean);
    if (parts.length > 0) return parts.join(' · ');
  }
  return previewArgsSummary(resolvedPreview) ?? previewArgsSummary(argsPreview);
}

/**
 * Can a human actually judge this call from what we recorded?
 *
 * TRUNCATION IS NOT BLINDNESS. `reviewComplete` (server:
 * `args_preview_complete`) goes false whenever the preview builder elided
 * ANYTHING — an 11th recipient, a 96-char URL, a fourth nesting level, an
 * attachment body — and every elision is written into the preview the human
 * reads (`[+3 more]`, `[204800 chars omitted]`). Gating the decision on it made
 * an ordinary "email this PDF" call permanently un-approvable: a disabled
 * button beside a warning, with Deny as the only possible answer.
 *
 * Reviewability is the narrower question: is there anything to look at? A call
 * that shows its parameters is decidable, elisions and all. One that shows none
 * is not — and no approve path is offered for it, rather than a dead control.
 *
 * Content Kortix read from the provider (`resolvedPreview`) is reviewable on
 * its own. Mirrors `approvalPreviewReviewable` in apps/api
 * (connectors/args-preview.ts), which enforces the same rule on
 * POST /approvals/:executionId.
 */
export function approvalReviewable(
  argsPreview: Record<string, unknown> | null | undefined,
  reviewComplete: boolean | undefined,
  resolvedPreview?: Record<string, unknown> | null,
): boolean {
  if (argsPreview && Object.keys(argsPreview).length > 0) return true;
  if (resolvedPreview && Object.keys(resolvedPreview).length > 0) return true;
  // No preview is still reviewable when the server confirms nothing was
  // withheld — an argument-less call hides nothing.
  return reviewComplete !== false;
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
    approvalContext:
      typeof summary?.approval_context === 'string' ? summary.approval_context : null,
    // Content the server loaded for a reference-only call (the draft behind a
    // `draft_id`), labelled with the connector part of the action path.
    resolvedPreview:
      summary?.resolved_preview && typeof summary.resolved_preview === 'object' && !Array.isArray(summary.resolved_preview)
        ? (summary.resolved_preview as Record<string, unknown>)
        : null,
    resolvedFrom: action.action.split('.')[0] || null,
    resolvedError: typeof summary?.resolved_error === 'string' ? summary.resolved_error : null,
    // `!summary` used to count as complete, so a pending row that recorded
    // NOTHING offered an Approve button the server answers with 409
    // (`APPROVAL_PREVIEW_UNAVAILABLE`) — the client and the gate disagreed. A
    // pending row is complete only when it says so.
    reviewComplete: !pending || summary?.args_preview_complete === true,
    resolution: decision === 'approve' || decision === 'deny' ? decision : null,
    pending,
    // Absent from an API older than KRTX-1724: keep offering the decision.
    canResolve: action.can_resolve !== false,
    resolvers: action.resolvers ?? null,
    status: action.status,
    resolvedAt: action.resolved_at,
  };
}

/**
 * Who besides a project manager decides this session's calls today: the
 * person who started it (KRTX-1724). Null when that is not a person who can
 * decide — a service account, or a backend wrapper whose `created_by` names
 * nobody — or when the session row does not name its owner yet.
 */
export function approvalLauncherName(
  session: Pick<ProjectSession, 'owner_name' | 'owner_email' | 'owner_type' | 'origin'> | null | undefined,
): string | null {
  if (!session || session.owner_type !== 'user' || session.origin === 'backend') return null;
  return session.owner_name || session.owner_email || null;
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
export function approvalNoticeHeadline(
  pendingCount: number,
  tI18nComplete: UiTranslator,
): {
  title: string;
  hint: string | null;
} {
  if (pendingCount === 0) return { title: tI18nComplete.raw('text6f1de8b7c3e5'), hint: null };
  if (pendingCount === 1) {
    return {
      title: tI18nComplete.raw('textd24f71ceadfb'),
      hint: tI18nComplete.raw('textce033f75c938'),
    };
  }
  return {
    title: tI18nComplete('text54d14f0b67f3', { value0: pendingCount }),
    hint: tI18nComplete('text5726504025dc', { value0: pendingCount }),
  };
}
