/**
 * Human-in-the-loop, read out of what the platform actually returns.
 *
 * Two upstream surfaces, deliberately not interchangeable:
 *
 * - READ is the per-SESSION audit (`GET /workspaces/{id}/sessions/{sid}/audit`),
 *   not the workspace-wide approval inbox. The inbox is manager-scoped and
 *   returns every end-user's pending gate; in wrapper mode ONE operator
 *   credential makes every call, so that inbox would hand this browser other
 *   Lumen users' execution ids — and an execution id is all the resolve route
 *   needs. The per-session audit is bounded to the session already on screen,
 *   so it is the only read that cannot leak across end-users.
 * - RESOLVE is `POST /workspaces/{id}/approvals/{executionId}` — the only route
 *   that decides a gate.
 *
 * `audit_access` is an Enterprise entitlement: without it the trail degrades to
 * unresolved pending approvals only (never a 402 — the approval control plane
 * has to keep working on every tier). That is a different statement from "this
 * session did nothing else", so the panel has to be told which it is looking at.
 */

import { serverErrorBody } from '@/lib/api-error-body';
import type { WorkspaceSessionAudit } from '@kortix/sdk';

type AuditAction = WorkspaceSessionAudit['actions'][number];

/** One gated action still waiting on a human decision. */
export interface PendingApprovalRow {
  executionId: string;
  /** `${connector}.${action}` when the connector is known — the fully-qualified
   *  tool path a workspace policy matches on. Falls back to the bare action. */
  action: string;
  /** read | write | destructive | null. */
  risk: string | null;
  requestedAt: string;
}

/** One governed action that is no longer waiting on anybody. */
export interface SettledActionRow {
  executionId: string;
  action: string;
  /** ok = ran (approved, or never gated), denied = refused, error = the call failed. */
  status: string;
  /** Who decided, when it was gated — an email when upstream resolved one, else
   *  the raw id. Null for an action that never needed a decision. */
  resolvedBy: string | null;
  resolvedAt: string | null;
}

export interface SessionApprovalsView {
  pending: PendingApprovalRow[];
  /** Most-recent-first governed actions that already settled. Empty when the
   *  account has no audit entitlement — see `trailLimited`. */
  recent: SettledActionRow[];
  /** True when `audit_access` came back false: `recent` is empty because the
   *  trail is withheld, NOT because nothing was ever gated. */
  trailLimited: boolean;
}

function qualified(action: AuditAction): string {
  return action.connector ? `${action.connector}.${action.action}` : action.action;
}

function isPending(action: AuditAction): boolean {
  // Belt and braces: upstream already excludes resolved rows from the pending
  // set, but an entitled account gets the FULL trail here — where a resolved
  // row keeps its original `pending_approval` status on some paths. A stale
  // Approve button on an already-decided action is a 409 waiting to happen.
  return action.status === 'pending_approval' && !action.resolved_at && !action.resolved_by;
}

export function sessionApprovalsView(
  audit: WorkspaceSessionAudit | null | undefined,
): SessionApprovalsView {
  const actions = audit?.actions ?? [];
  return {
    pending: actions.filter(isPending).map((a) => ({
      executionId: a.execution_id,
      action: qualified(a),
      risk: a.risk,
      requestedAt: a.at,
    })),
    recent: actions
      .filter((a) => !isPending(a))
      .map((a) => ({
        executionId: a.execution_id,
        action: qualified(a),
        status: a.status,
        resolvedBy: a.resolved_by_email ?? a.resolved_by,
        resolvedAt: a.resolved_at,
      })),
    // Absent on older backends, which served the full trail unconditionally —
    // treat only an explicit `false` as withheld.
    trailLimited: audit?.audit_access === false,
  };
}

export type ApprovalFailureKind =
  | 'requires_human'
  | 'already_resolved'
  | 'not_permitted'
  | 'unknown';

export interface ApprovalFailure {
  kind: ApprovalFailureKind;
  title: string;
  detail: string;
}

/**
 * Name a refused resolve.
 *
 * `APPROVAL_REQUIRES_HUMAN` is the one that must never render as a generic
 * failure. It means the credential that asked to resolve is bound to a session
 * — i.e. an agent asking to clear its own gate — and the platform refuses that
 * outright rather than narrowing it, because a gate its own subject can lift is
 * decoration. Retrying with the same credential can never succeed; the decision
 * has to come from a human's browser session.
 */
export function approvalFailure(err: unknown): ApprovalFailure {
  const body = serverErrorBody(err);
  const code = typeof body?.code === 'string' ? body.code : '';
  const status = (err as { status?: number } | null | undefined)?.status;
  const serverText = typeof body?.error === 'string' ? body.error.trim() : '';

  if (code === 'APPROVAL_REQUIRES_HUMAN') {
    return {
      kind: 'requires_human',
      title: 'A human has to decide this one',
      detail:
        serverText ||
        'An agent cannot resolve its own approval — a human must approve or deny this.',
    };
  }
  if (status === 409) {
    return {
      kind: 'already_resolved',
      title: 'Already decided',
      detail: serverText || 'Someone resolved this approval before you did.',
    };
  }
  if (status === 403) {
    return {
      kind: 'not_permitted',
      title: 'Not allowed to resolve this',
      detail: serverText || 'Only a workspace manager or the session launcher can resolve this.',
    };
  }
  return {
    kind: 'unknown',
    title: 'Could not record that decision',
    detail: serverText || 'The approval was left pending. Try again.',
  };
}
