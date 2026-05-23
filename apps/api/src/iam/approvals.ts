// Approval workflow engine for sensitive IAM actions. Two-phase:
//   1) the sensitive endpoint calls `requireApproval(...)`. When the
//      account requires approvals and the caller isn't pre-approved
//      (no `?approval_request_id=`), we create a pending request and
//      throw NEEDS_APPROVAL with the request_id. The handler returns
//      202 to the requester.
//   2) a different super-admin calls POST /iam/approvals/:id/approve,
//      which invokes the matching executor here.
//
// Executors are pure side-effect functions tied to a canonical action
// string. Adding a new gated action means: add to ACTION_EXECUTORS,
// add the action to GATED_ACTIONS, and call requireApproval() in the
// route handler.

import { and, eq, sql } from 'drizzle-orm';
import {
  accountMembers,
  accounts,
  iamApprovalRequests,
} from '@kortix/db';
import { db } from '../shared/db';

/** Sensitive actions that require approval when the account opts in.
 *  Anything not in this set executes immediately, even with the flag on. */
export const GATED_ACTIONS = new Set<string>([
  'member.super_admin.grant',
  'iam.mfa_required.disable',
  'account.delete',
]);

/** Default lifetime for a pending request — they auto-expire so an
 *  approver coming back from holiday doesn't authorise a stale change. */
const DEFAULT_EXPIRY_HOURS = 24;

export class NeedsApprovalError extends Error {
  constructor(public requestId: string) {
    super(`approval required: ${requestId}`);
    this.name = 'NeedsApprovalError';
  }
}

/**
 * Gate a sensitive action. Resolves to one of:
 *   - { status: 'proceed' } — caller can execute the action inline.
 *   - throws NeedsApprovalError(requestId) — handler should return 202
 *     with that id so the requester can show "Pending approval".
 *
 * Behaviour matrix:
 *   approvals OFF on account                → always proceed
 *   approvals ON, no approval id in request → create pending → throw
 *   approvals ON, valid approval id matches → proceed
 */
export async function requireApproval(args: {
  accountId: string;
  action: string;
  requestedBy: string;
  payload: Record<string, unknown>;
  /** Pulled from the request: `?approval_request_id=<uuid>` or
   *  `X-Approval-Request-Id` header. */
  approvalRequestId?: string;
  /** Optional resource id this action targets. Captured for audit. */
  targetId?: string;
  /** Optional human reason. Surfaced to approvers. */
  reason?: string;
}): Promise<{ status: 'proceed' }> {
  // Only the curated set is gated. Unlisted actions proceed regardless.
  if (!GATED_ACTIONS.has(args.action)) return { status: 'proceed' };

  const [acct] = await db
    .select({ iamApprovalsRequired: accounts.iamApprovalsRequired })
    .from(accounts)
    .where(eq(accounts.accountId, args.accountId))
    .limit(1);
  if (!acct || !acct.iamApprovalsRequired) return { status: 'proceed' };

  // Caller might be re-presenting a previously-approved request token.
  if (args.approvalRequestId) {
    const ok = await consumePreApprovedRequest({
      accountId: args.accountId,
      requestId: args.approvalRequestId,
      action: args.action,
    });
    if (ok) return { status: 'proceed' };
    // Token didn't match — fall through and create a fresh request so
    // the requester knows their previous approval is unusable.
  }

  const [row] = await db
    .insert(iamApprovalRequests)
    .values({
      accountId: args.accountId,
      action: args.action,
      targetId: args.targetId ?? null,
      payload: args.payload,
      requesterReason: args.reason ?? null,
      requestedBy: args.requestedBy,
      expiresAt: new Date(Date.now() + DEFAULT_EXPIRY_HOURS * 60 * 60 * 1000),
    })
    .returning({ requestId: iamApprovalRequests.requestId });

  if (!row) throw new Error('failed to create approval request');
  throw new NeedsApprovalError(row.requestId);
}

/**
 * Approvers re-execute the action with a previously-approved request
 * id. We accept only requests that are:
 *   - in the same account
 *   - for the exact same action key
 *   - status='approved'
 *   - not yet executed (execution_result IS NULL)
 *   - not expired
 *
 * Returns true on consume — caller should proceed. The execution_result
 * stamp prevents replay: once consumed, the same id won't work twice.
 */
async function consumePreApprovedRequest(args: {
  accountId: string;
  requestId: string;
  action: string;
}): Promise<boolean> {
  const updated = await db
    .update(iamApprovalRequests)
    .set({ executionResult: 'executed' })
    .where(
      and(
        eq(iamApprovalRequests.accountId, args.accountId),
        eq(iamApprovalRequests.requestId, args.requestId),
        eq(iamApprovalRequests.action, args.action),
        eq(iamApprovalRequests.status, 'approved'),
        // Replay guard — execution_result IS NULL means "not yet run".
        sql`${iamApprovalRequests.executionResult} IS NULL`,
        sql`${iamApprovalRequests.expiresAt} > now()`,
      ),
    )
    .returning({ requestId: iamApprovalRequests.requestId });
  return updated.length > 0;
}

/**
 * Caller invoked by POST /iam/approvals/:id/approve. Validates that:
 *   - request exists and belongs to the account
 *   - approver is a different user than the requester (no self-approve)
 *   - approver is a super-admin
 *   - status is still 'pending'
 *   - not expired
 *
 * On success, flips status to 'approved'. The actual side-effect runs
 * when the requester re-submits with `?approval_request_id=`.
 *
 * Returns { ok, error?, request } so the route can render a useful
 * message.
 */
export async function approveRequest(args: {
  accountId: string;
  requestId: string;
  approverUserId: string;
  decisionReason?: string;
}): Promise<
  | { ok: true; request: { action: string; targetId: string | null } }
  | { ok: false; error: string; status: 404 | 409 | 403 }
> {
  const [request] = await db
    .select({
      requestId: iamApprovalRequests.requestId,
      action: iamApprovalRequests.action,
      targetId: iamApprovalRequests.targetId,
      requestedBy: iamApprovalRequests.requestedBy,
      status: iamApprovalRequests.status,
      expiresAt: iamApprovalRequests.expiresAt,
    })
    .from(iamApprovalRequests)
    .where(
      and(
        eq(iamApprovalRequests.accountId, args.accountId),
        eq(iamApprovalRequests.requestId, args.requestId),
      ),
    )
    .limit(1);

  if (!request) return { ok: false, error: 'approval request not found', status: 404 };
  if (request.status !== 'pending') {
    return { ok: false, error: `request already ${request.status}`, status: 409 };
  }
  if (request.expiresAt < new Date()) {
    return { ok: false, error: 'request expired', status: 409 };
  }
  if (request.requestedBy === args.approverUserId) {
    return { ok: false, error: 'requesters cannot approve their own requests', status: 403 };
  }

  // Approver must be a super-admin OR have an explicit policy granting
  // them approval rights. v1: super-admin only — keeps the surface tight.
  const [admin] = await db
    .select({ isSuperAdmin: accountMembers.isSuperAdmin })
    .from(accountMembers)
    .where(
      and(
        eq(accountMembers.accountId, args.accountId),
        eq(accountMembers.userId, args.approverUserId),
      ),
    )
    .limit(1);
  if (!admin || !admin.isSuperAdmin) {
    return { ok: false, error: 'only super-admins can approve requests', status: 403 };
  }

  await db
    .update(iamApprovalRequests)
    .set({
      status: 'approved',
      decidedBy: args.approverUserId,
      decidedAt: new Date(),
      decisionReason: args.decisionReason ?? null,
    })
    .where(eq(iamApprovalRequests.requestId, args.requestId));

  return {
    ok: true,
    request: { action: request.action, targetId: request.targetId },
  };
}

/** Same shape as approveRequest but stamps 'rejected'. */
export async function rejectRequest(args: {
  accountId: string;
  requestId: string;
  approverUserId: string;
  decisionReason?: string;
}): Promise<
  | { ok: true }
  | { ok: false; error: string; status: 404 | 409 | 403 }
> {
  const [request] = await db
    .select({
      status: iamApprovalRequests.status,
      requestedBy: iamApprovalRequests.requestedBy,
    })
    .from(iamApprovalRequests)
    .where(
      and(
        eq(iamApprovalRequests.accountId, args.accountId),
        eq(iamApprovalRequests.requestId, args.requestId),
      ),
    )
    .limit(1);

  if (!request) return { ok: false, error: 'approval request not found', status: 404 };
  if (request.status !== 'pending') {
    return { ok: false, error: `request already ${request.status}`, status: 409 };
  }
  if (request.requestedBy === args.approverUserId) {
    return { ok: false, error: 'requesters cannot reject their own requests', status: 403 };
  }

  await db
    .update(iamApprovalRequests)
    .set({
      status: 'rejected',
      decidedBy: args.approverUserId,
      decidedAt: new Date(),
      decisionReason: args.decisionReason ?? null,
    })
    .where(eq(iamApprovalRequests.requestId, args.requestId));

  return { ok: true };
}
