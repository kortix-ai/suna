/**
 * Review Center adapters — fold sources that keep their own source-of-truth
 * tables (Change Requests now; executor/tunnel approvals next) into the inbox
 * read model as `ReviewItem`s. Adapted items carry a namespaced id (`cr:<id>`)
 * so the act endpoint can route a verdict back to the right source.
 *
 * This pass adapts Change Requests for VISIBILITY (read-only in the inbox); the
 * act dispatch (merge/close) routes through the existing CR flow. See
 * docs/REVIEW_CENTER_DESIGN.md.
 */

import type { changeRequests, executorExecutions } from '@kortix/db';
import type { serializeReviewItem } from './review-items';

type ReviewItemDTO = ReturnType<typeof serializeReviewItem>;
type ChangeRequestRow = typeof changeRequests.$inferSelect;
type ExecutorExecutionRow = typeof executorExecutions.$inferSelect;

export const CR_ID_PREFIX = 'cr:';
export const EXEC_ID_PREFIX = 'exec:';

/** Source prefixes used by adapted (non-native) review items. */
export function adapterSourceForId(id: string): 'cr' | 'exec' | null {
  if (id.startsWith(CR_ID_PREFIX)) return 'cr';
  if (id.startsWith(EXEC_ID_PREFIX)) return 'exec';
  return null;
}

/** True if the id belongs to an adapted (source-of-truth-elsewhere) item. */
export function isAdaptedId(id: string): boolean {
  return adapterSourceForId(id) !== null;
}

const EXEC_RISK: Record<'read' | 'write' | 'destructive', ReviewItemDTO['risk']> = {
  read: 'low',
  write: 'medium',
  destructive: 'high',
};

/**
 * A pending-approval executor tool call, presented as an `approval` review item.
 * (Only `pending_approval` executions are adapted; the rest are terminal audit.)
 */
export function executorExecutionToReviewItem(ex: ExecutorExecutionRow): ReviewItemDTO {
  return {
    review_item_id: `${EXEC_ID_PREFIX}${ex.executionId}`,
    account_id: ex.accountId,
    project_id: ex.projectId,
    origin_session_id: ex.sessionId ?? null,
    kind: 'approval',
    status: 'needs_you',
    risk: ex.risk ? EXEC_RISK[ex.risk] : 'medium',
    source: 'agent',
    title: `Approve: ${ex.actionPath}`,
    summary: `${ex.actionPath} · awaiting approval`,
    detail: {
      execution_id: ex.executionId,
      action_path: ex.actionPath,
      connector_id: ex.connectorId,
      request_digest: ex.requestDigest,
    },
    agent: '',
    created_by: ex.actingUserId ?? '',
    acted_by: ex.approvedBy ?? null,
    acted_at: null,
    feedback: null,
    metadata: { source: 'executor_execution' },
    created_at: ex.createdAt.toISOString(),
    updated_at: ex.createdAt.toISOString(),
  };
}

/** A Change Request, presented as a `change` review item. */
export function changeRequestToReviewItem(cr: ChangeRequestRow): ReviewItemDTO {
  const rc = (cr.metadata as Record<string, unknown> | null)?.requested_changes;
  const requested = (Array.isArray(rc) ? rc : []) as Array<{ text?: string }>;
  const lastFeedback = requested.length > 0 ? (requested[requested.length - 1].text ?? null) : null;
  const status: ReviewItemDTO['status'] =
    cr.status === 'merged'
      ? 'approved'
      : cr.status === 'closed'
        ? 'rejected'
        : requested.length > 0
          ? 'waiting' // open, but a human asked for changes → the agent is revising
          : 'needs_you';
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
