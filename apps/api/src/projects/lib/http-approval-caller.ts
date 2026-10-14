/**
 * The caller half of the approval authority rule, read from the request.
 *
 * `POST /approvals/:executionId` refuses a caller `mayResolveApproval` refuses.
 * The session audit reads and the Review Center list tell the same caller, per
 * pending call, whether that POST would succeed (`can_resolve`, KRTX-1724).
 * Both sides build the caller here, so the list and the route cannot disagree.
 */
import type { Context } from 'hono';
import { PROJECT_ACTIONS } from '../../iam/actions';
import { actorOf } from '../../middleware/actor';
import { callerKortixSessionId } from '../../middleware/caller-session';
import type { ApprovalCaller } from './approval-authority';
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
