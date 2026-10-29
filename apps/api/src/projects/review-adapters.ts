/**
 * Review Center adapters — fold sources that keep their own source-of-truth
 * tables (Change Requests now; connector/tunnel approvals next) into the inbox
 * read model as `ReviewItem`s. Adapted items carry a namespaced id (`cr:<id>`)
 * so the act endpoint can route a verdict back to the right source.
 *
 * This pass adapts Change Requests for VISIBILITY (read-only in the inbox); the
 * act dispatch (merge/close) routes through the existing CR flow.
 */

import type { changeRequests, connectorCalls, connectorHeldCalls } from '@kortix/db';
import { APPROVAL_RERUN_WINDOW_MS } from '../connectors/approval-expiry';
import { isPlainRecord } from '../connectors/args-preview';
import type { serializeReviewItem } from './review-items';
import type { ApprovalResolvers } from './lib/approval-authority';

type ReviewItemDTO = ReturnType<typeof serializeReviewItem>;
type ChangeRequestRow = typeof changeRequests.$inferSelect;
type ConnectorCallRow = typeof connectorCalls.$inferSelect;
/** The run of an approved held call (connectors/held-call-run.ts). */
export type HeldRun = Pick<typeof connectorHeldCalls.$inferSelect, 'state' | 'finishedAt' | 'outcome'>;

export const CR_ID_PREFIX = 'cr:';
export const CALL_ID_PREFIX = 'call:';

/** Source prefixes used by adapted (non-native) review items. */
export function adapterSourceForId(id: string): 'cr' | 'call' | null {
  if (id.startsWith(CR_ID_PREFIX)) return 'cr';
  if (id.startsWith(CALL_ID_PREFIX)) return 'call';
  return null;
}

/** True if the id belongs to an adapted (source-of-truth-elsewhere) item. */
export function isAdaptedId(id: string): boolean {
  return adapterSourceForId(id) !== null;
}

const CALL_RISK: Record<'read' | 'write' | 'destructive', ReviewItemDTO['risk']> = {
  read: 'low',
  write: 'medium',
  destructive: 'high',
};

/**
 * A pending-approval connector tool call, presented as an `approval` review item.
 * (Only `pending_approval` executions are adapted; the rest are terminal audit.)
 *
 * `canResolve` is the caller's verdict from the resolve route's rule
 * (`mayResolveApproval`). It decides three things for that caller: whether the
 * arguments are shown, `can_resolve`, and the status. A caller who may resolve
 * finds the call under Needs you; anyone else finds it under Waiting, because
 * the decision is someone else's (KRTX-1724). Absent means false (fail closed).
 * `resolvers` names who decides (`approvalResolvers`); null when unknown.
 */
export function connectorCallToReviewItem(
  ex: ConnectorCallRow & { connectorName?: string | null },
  options: { canResolve?: boolean; resolvers?: ApprovalResolvers } = {},
): ReviewItemDTO & {
  can_resolve: boolean;
  resolvers: ApprovalResolvers | null;
  expires_at: string | null;
} {
  const includeArgsPreview = options.canResolve === true;
  const summary =
    ex.resultSummary && typeof ex.resultSummary === 'object' && !Array.isArray(ex.resultSummary)
      ? ex.resultSummary
      : {};
  const argsPreview =
    summary.args_preview &&
    typeof summary.args_preview === 'object' &&
    !Array.isArray(summary.args_preview)
      ? summary.args_preview
      : null;
  return {
    review_item_id: `${CALL_ID_PREFIX}${ex.executionId}`,
    account_id: ex.accountId,
    project_id: ex.projectId,
    origin_session_id: ex.sessionId ?? null,
    kind: 'approval',
    status: includeArgsPreview ? 'needs_you' : 'waiting',
    can_resolve: includeArgsPreview,
    resolvers: options.resolvers ?? null,
    risk: ex.risk ? CALL_RISK[ex.risk] : 'medium',
    source: 'agent',
    title: `Approve: ${ex.actionPath}`,
    summary: `${ex.actionPath} · awaiting approval`,
    detail: {
      execution_id: ex.executionId,
      action_path: ex.actionPath,
      connector_id: ex.connectorId,
      // The display name ("GitHub"); the slug in `action_path` is not a name.
      ...(ex.connectorName ? { connector_name: ex.connectorName } : {}),
      request_digest: ex.requestDigest,
      risk: ex.risk,
      ...(includeArgsPreview ? { args_preview: argsPreview } : {}),
      // Same gate as the args: the agent's description can quote the payload.
      ...(includeArgsPreview && typeof summary.approval_context === 'string'
        ? { approval_context: summary.approval_context }
        : {}),
      // Content Kortix read from the provider (approval-enrichers.ts): the
      // same gate as the args, because it is the payload.
      ...(includeArgsPreview && isPlainRecord(summary.resolved_preview)
        ? { resolved_preview: summary.resolved_preview }
        : {}),
      ...(includeArgsPreview && typeof summary.resolved_error === 'string'
        ? { resolved_error: summary.resolved_error }
        : {}),
      args_preview_complete: includeArgsPreview && summary.args_preview_complete === true,
      args_preview_authorized: includeArgsPreview,
    },
    agent: '',
    created_by: ex.actingUserId ?? '',
    acted_by: ex.approvedBy ?? null,
    acted_at: null,
    feedback: null,
    metadata: { source: 'connector_call' },
    created_at: ex.createdAt.toISOString(),
    updated_at: ex.createdAt.toISOString(),
    /** When the approval stops being decidable; null = never. */
    expires_at: ex.expiresAt?.toISOString() ?? null,
  };
}

/**
 * A decided approval gate (approved or denied by a human), as the by-id read
 * shows it: the decision and one `next_step` sentence. A gate that held its
 * input (status `approved`) adds `run`: Kortix runs the call, the caller reads
 * the outcome. A gate without one (status `ok`) adds whether a repeated call
 * used the approval and the deadline to repeat it. Null for a row that is not
 * a decided gate (still pending, expired, or a real run with no approver).
 */
export function decidedCallState(ex: ConnectorCallRow, now: Date, run?: HeldRun | null) {
  if (!ex.approvedBy || !ex.resolvedAt) return null;
  if (ex.status === 'approved') return heldCallState(ex, ex.approvedBy, ex.resolvedAt, run ?? null);
  if (ex.status !== 'ok' && ex.status !== 'denied') return null;
  const summary = isPlainRecord(ex.resultSummary) ? ex.resultSummary : {};
  // Gates approved before `decision` was written read it from the status.
  const decision =
    summary.decision === 'approve' || summary.decision === 'deny'
      ? summary.decision
      : ex.status === 'ok'
        ? 'approve'
        : 'deny';
  const decidedAt = ex.resolvedAt.toISOString();
  const decided = { decision, decided_by: ex.approvedBy, decided_at: decidedAt };
  if (decision === 'deny') {
    const note =
      typeof summary.decision_note === 'string' && summary.decision_note
        ? ` Message from the approver: ${summary.decision_note}`
        : '';
    return {
      status: 'rejected' as const,
      summary: `${ex.actionPath} · denied`,
      detail: { ...decided, next_step: `Denied at ${decidedAt}.${note}` },
    };
  }
  const usedAt = typeof summary.consumed_at === 'string' ? summary.consumed_at : null;
  const rerunBy = new Date(ex.resolvedAt.getTime() + APPROVAL_RERUN_WINDOW_MS);
  const rerunByIso = rerunBy.toISOString();
  const nextStep = usedAt
    ? `Approved at ${decidedAt}. A repeated call claimed the approval at ${usedAt}. If the content changed after approval, that call asked for a new approval instead of running.`
    : now < rerunBy
      ? `Approved at ${decidedAt}. The call has not run. Repeat the exact same call (same arguments and account) before ${rerunByIso}, and it runs once.`
      : `Approved at ${decidedAt}, but the call was not repeated before ${rerunByIso} and did not run. Repeat it to ask for a new approval.`;
  return {
    status: 'approved' as const,
    summary: `${ex.actionPath} · approved`,
    detail: { ...decided, approval_used_at: usedAt, rerun_by: rerunByIso, next_step: nextStep },
  };
}

/** An approved gate that held its input: what its run did, or that it runs. */
function heldCallState(ex: ConnectorCallRow, decidedBy: string, resolvedAt: Date, run: HeldRun | null) {
  const decidedAt = resolvedAt.toISOString();
  const outcome = isPlainRecord(run?.outcome) ? run.outcome : null;
  const finishedAt = run?.finishedAt?.toISOString() ?? null;
  const state = run?.state ?? 'queued';
  const text = (key: string) => (typeof outcome?.[key] === 'string' ? (outcome[key] as string) : null);
  const approved = `Approved at ${decidedAt}.`;
  const nextStep =
    state === 'ok'
      ? `${approved} The call ran once at ${finishedAt} and succeeded. Do not repeat it.`
      : state === 'error'
        ? `${approved} The call ran at ${finishedAt}, but failed: ${text('message') ?? 'unknown error'}. Check its effect before you repeat it.`
        : state === 'unknown'
          ? `${approved} The call may have run: Kortix lost track of it. Check its effect before you repeat it.`
          : state === 'refused'
            ? text('reason') === 'content_changed'
              ? `${approved} The call did not run: the content changed after approval. A new approval ${text('new_execution_id') ?? ''} waits for a human. Do not repeat the call.`
              : `${approved} The call did not run: ${text('message') ?? text('reason') ?? 'refused'}. Repeat the call to ask for approval again.`
            : state === 'dispatched'
              ? `${approved} The call is running. Do not repeat it. Read this item again for the outcome.`
              : `${approved} Kortix runs the call once. Do not repeat it. Read this item again for the outcome.`;
  return {
    status: 'approved' as const,
    summary: `${ex.actionPath} · approved`,
    detail: {
      decision: 'approve' as const,
      decided_by: decidedBy,
      decided_at: decidedAt,
      // Only the redacted outcome (≤ 4 KB output preview); the held input never leaves its row.
      run: { state, finished_at: finishedAt, outcome },
      next_step: nextStep,
    },
  };
}

/**
 * The inbox status each Change Request status shows as. An OPEN change is
 * always reviewable (you can read the diff + ship or ask for more changes).
 * Requested changes are shown as history — not a terminal state, so the item
 * never gets stuck waiting. The paged inbox and the summary filter CRs in SQL
 * by this table, so it is the one place the mapping lives.
 */
export const CR_REVIEW_STATUS: Record<ChangeRequestRow['status'], ReviewItemDTO['status']> = {
  open: 'needs_you',
  merged: 'approved',
  closed: 'rejected',
};

/** A Change Request, presented as a `change` review item. */
export function changeRequestToReviewItem(cr: ChangeRequestRow): ReviewItemDTO {
  const rc = (cr.metadata as Record<string, unknown> | null)?.requested_changes;
  const requested = (Array.isArray(rc) ? rc : []) as Array<{ text?: string }>;
  const lastFeedback = requested.length > 0 ? (requested[requested.length - 1].text ?? null) : null;
  const status = CR_REVIEW_STATUS[cr.status] ?? 'needs_you';
  return {
    review_item_id: `${CR_ID_PREFIX}${cr.crId}`,
    account_id: cr.accountId,
    project_id: cr.projectId,
    origin_session_id: cr.originSessionId,
    kind: 'change',
    status,
    // Heuristic until the diff size is available; the friendly UI re-derives.
    risk: 'medium',
    source: 'web',
    title: cr.title,
    summary: `#${cr.number} · ${cr.headRef} → ${cr.baseRef}`,
    detail: {
      cr_id: cr.crId,
      number: cr.number,
      base_ref: cr.baseRef,
      head_ref: cr.headRef,
      description: cr.description,
      requested_changes: requested,
    },
    agent: '',
    created_by: cr.createdBy,
    acted_by: cr.mergedBy ?? cr.closedBy ?? null,
    acted_at: (cr.mergedAt ?? cr.closedAt)?.toISOString() ?? null,
    feedback: lastFeedback,
    metadata: { source: 'change_request' },
    created_at: cr.createdAt.toISOString(),
    updated_at: cr.updatedAt.toISOString(),
  };
}
