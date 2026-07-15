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
export const PERM_ID_PREFIX = 'perm:';

/** Source prefixes used by adapted (non-native) review items. */
export function adapterSourceForId(id: string): 'cr' | 'exec' | 'perm' | null {
  if (id.startsWith(CR_ID_PREFIX)) return 'cr';
  if (id.startsWith(EXEC_ID_PREFIX)) return 'exec';
  if (id.startsWith(PERM_ID_PREFIX)) return 'perm';
  return null;
}

/** A live opencode permission (bash/edit/…) presented as an `approval` review
 *  item, so the SAME ask relayed to Telegram is also approvable from the web
 *  inbox. Its id is `perm:<sessionId>:<requestID>`, which the act endpoint parses
 *  to reply to the sandbox. Structural type — no import from the channel module. */
interface SandboxPermissionRow {
  sessionId: string;
  accountId: string;
  projectId: string;
  requestID: string;
  permission: string;
  detail: string;
}

const PERMISSION_TITLES: Record<string, string> = {
  bash: 'run a command',
  edit: 'edit a file',
  write: 'write a file',
  read: 'read a file',
  webfetch: 'fetch a URL',
  mcp: 'use an MCP tool',
};

export function sandboxPermissionToReviewItem(row: SandboxPermissionRow): ReviewItemDTO {
  const nowIso = new Date().toISOString();
  const highRisk =
    row.permission === 'bash' || row.permission === 'write' || row.permission === 'edit';
  return {
    review_item_id: `${PERM_ID_PREFIX}${row.sessionId}:${row.requestID}`,
    account_id: row.accountId,
    project_id: row.projectId,
    origin_session_id: row.sessionId,
    kind: 'approval',
    status: 'needs_you',
    risk: highRisk ? 'high' : 'medium',
    source: 'agent',
    title: `Approve: ${PERMISSION_TITLES[row.permission] ?? row.permission}`,
    summary: row.detail || `${row.permission} · awaiting approval`,
    detail: {
      session_id: row.sessionId,
      request_id: row.requestID,
      permission: row.permission,
      pattern: row.detail,
    },
    agent: '',
    created_by: '',
    acted_by: null,
    acted_at: null,
    feedback: null,
    metadata: { source: 'sandbox_permission' },
    created_at: nowIso,
    updated_at: nowIso,
  };
}

/** True if the id belongs to an adapted (source-of-truth-elsewhere) item. */
export function isAdaptedId(id: string): boolean {
  return adapterSourceForId(id) !== null;
}

/** Parse a `perm:<sessionId>:<requestID>` review id back to its parts (sessionId
 *  is a UUID, so the first `:` after the prefix splits it from the requestID). */
export function parsePermissionReviewId(
  id: string,
): { sessionId: string; requestID: string } | null {
  if (!id.startsWith(PERM_ID_PREFIX)) return null;
  const rest = id.slice(PERM_ID_PREFIX.length);
  const idx = rest.indexOf(':');
  if (idx <= 0 || idx >= rest.length - 1) return null;
  return { sessionId: rest.slice(0, idx), requestID: rest.slice(idx + 1) };
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
  // An OPEN change is always reviewable (you can read the diff + ship or ask for
  // more changes). Requested changes are shown as history — not a terminal state,
  // so the item never gets stuck waiting.
  const status: ReviewItemDTO['status'] =
    cr.status === 'merged' ? 'approved' : cr.status === 'closed' ? 'rejected' : 'needs_you';
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
