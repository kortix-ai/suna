/**
 * The caller half of the approval authority rule, read from the request.
 *
 * `POST /approvals/:executionId` refuses a caller `mayResolveApproval` refuses.
 * The session audit reads and the Review Center list tell the same caller, per
 * pending call, whether that POST would succeed (`can_resolve`, KRTX-1724), and
 * the approval page (`GET /v1/approval-links/:token`) refuses the same caller.
 * Every side builds the caller here, so they cannot disagree.
 */
import type { Context } from 'hono';
import { PROJECT_ACTIONS } from '../../iam/actions';
import { actorOf } from '../../middleware/actor';
import { callerKortixSessionId } from '../../middleware/caller-session';
import {
  approvalResolvers,
  mayResolveApproval,
  type ApprovalCaller,
  type ApprovalResolvers,
} from './approval-authority';
import { assertProjectCapability } from './access';

export async function approvalCallerOf(
  c: Context,
  loaded: { userId: string; row: { accountId: string } },
  projectId: string,
): Promise<ApprovalCaller> {
  // A project manager is whoever holds `project.members.manage` — the leaf the
  // approval inbox asserts, so a custom role holding it qualifies too. The
  // assertion throws on denial; a non-manager still falls through to the
  // launcher half of the rule.
  let isManager = false;
  try {
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE,
    );
    isManager = true;
  } catch {
    isManager = false;
  }
  // The credential kind tells a person's own PAT (a human) from an agent or
  // service-account credential (never a human).
  const actor = await actorOf(c, loaded.row.accountId);
  return {
    isManager,
    callerUserId: loaded.userId,
    callerAuthType: (c.get('authType') as string | undefined) ?? null,
    callerCredentialKind: actor.credential.kind,
    callerSessionId: callerKortixSessionId(c),
  };
}

/**
 * The verdict a session read reports on that session's pending calls: GET
 * .../audit and the snapshot's `audit` leg spread it into
 * `readSessionAuditActions`. `canResolve` is asked only when a call is pending.
 * `resolvers` names who decides, for a viewer who may not.
 */
export function sessionApprovalVerdict(
  c: Context,
  loaded: { userId: string; row: { accountId: string } },
  projectId: string,
  session: { origin?: string | null; createdBy?: string | null },
): { canResolve: () => Promise<boolean>; resolvers: ApprovalResolvers } {
  const target = {
    targetSessionOrigin: session.origin ?? null,
    targetSessionCreatedBy: session.createdBy ?? null,
  };
  return {
    canResolve: async () =>
      mayResolveApproval({ ...(await approvalCallerOf(c, loaded, projectId)), ...target }).allowed,
    resolvers: approvalResolvers(target),
  };
}
