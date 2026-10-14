/**
 * Offboarding: what member removal, leave and SCIM deactivation do to one
 * member of one account. One sequence, so the three exits cannot drift apart
 * again (KRTX-1722). Callers run their authorization and last-owner guard
 * first.
 *
 * Order:
 * 1. Grants, groups and notification rows, then the identity row. Grants
 *    first: a failure between the two leaves the person without access rather
 *    than with access and no identity.
 * 2. Their tokens in the account, at once.
 * 3. What keeps acting on their identity: computer accounts that reach their
 *    machines, and reminders they set. One audit event records the counts.
 * 4. Their legacy gateway (YOLO) token in the account. Members are unlimited
 *    and free, so there is no seat to release.
 * 5. Their personal drives pass to an owner.
 */
import { accountGroupMembers, accountMemberships } from '@kortix/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { revokeYoloTokenForMember } from '../../billing/services/yolo-tokens';
import { revokeComputersOfDepartedOwner } from '../../connectors/computers';
import { isAudienceObjectType } from '../../iam/audience-grants';
import {
  SYSTEM_ACTOR,
  auditAssignmentRevoked,
  deleteAccountScopeAssignments,
  deleteProjectScopeAssignments,
  listAssignments,
  type Writer,
} from '../../iam/assignments';
import { invalidateIamCacheForUser } from '../../iam/cache-invalidation';
import { accountGroupIds } from '../../iam/group-read';
import { logger } from '../../lib/logger';
import { deleteMemberNotificationData } from '../../notifications/cleanup';
import { revokeAllAccountTokensForUser } from '../../repositories/account-tokens';
import { recordAuditEvent } from '../../shared/audit';
import { db } from '../../shared/db';

/** An admin removed the member, the member left, or the identity provider deprovisioned them. */
export type OffboardReason = 'removed' | 'left' | 'deprovisioned';

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Offboard `userId` from `accountId`. `writer` is the person who removes or
 * leaves, or `SYSTEM_ACTOR` for SCIM. Returns the token-revocation error, if
 * any, for the caller's own audit event: membership removal always proceeds.
 */
export async function offboardMember(
  writer: Writer,
  accountId: string,
  userId: string,
  reason: OffboardReason,
): Promise<{ tokenRevocationError: string | null }> {
  await revokeAssignments(writer, accountId, userId);
  // Group grants are independent rows. Left behind, a re-invite restores them.
  await db.delete(accountGroupMembers).where(
    and(eq(accountGroupMembers.userId, userId), inArray(accountGroupMembers.groupId, accountGroupIds(accountId))),
  );
  // KRTX-1742: their inbox and watcher rows here would keep naming sessions.
  await deleteMemberNotificationData(accountId, userId);
  await db
    .delete(accountMemberships)
    .where(and(eq(accountMemberships.accountId, accountId), eq(accountMemberships.userId, userId)));
  // A removal is an account-scoped deprovisioning decision. Keep the directory
  // row as an inactive tombstone so the next SAML login cannot recreate this
  // member. A later SCIM active:true update is the explicit IdP action that may
  // restore access. SCIM writes its own directory row; a leaver may return.
  if (reason === 'removed') {
    await db.execute(sql`
      INSERT INTO kortix.account_scim_users
        (scim_id, account_id, user_id, user_name, active, profile, created_at, updated_at)
      SELECT gen_random_uuid(), ${accountId}::uuid, target.id, lower(target.email), false, '{}'::jsonb, now(), now()
      FROM auth.users target
      WHERE target.id=${userId}::uuid AND target.email IS NOT NULL
      ON CONFLICT (account_id, user_name) DO UPDATE SET
        user_id=excluded.user_id,
        active=false,
        updated_at=now()
    `);
  }
  invalidateIamCacheForUser(userId);

  // PATs and live sandbox session tokens, so neither the person nor their
  // running agents keep acting on a bearer. A failure is never silent: a
  // removed member holding live tokens is an offboarding hole.
  const tokenRevocationError = await revokeAllAccountTokensForUser(userId, accountId).then(
    () => null,
    (err) => {
      logger.error('[offboarding] token revocation FAILED: the member may keep live tokens', {
        accountId,
        userId,
        reason,
        error: errorMessage(err),
      });
      return errorMessage(err);
    },
  );

  await endWhatTheyLeftRunning(writer, accountId, userId, reason);

  // Their legacy gateway (YOLO) token stops working. Awaited: it is one DB
  // write, so every exit answers after it is gone.
  await revokeYoloTokenForMember(userId, accountId).catch((err) =>
    logger.error('[offboarding] YOLO token revoke FAILED', { accountId, userId, reason, error: errorMessage(err) }),
  );
  // Their personal drives in this account pass to an owner.
  await import('../../drives/service').then(({ releaseMemberDrives }) => releaseMemberDrives(accountId, userId));

  return { tokenRevocationError };
}

/**
 * Every assignment the person holds in the account, with one revoke event
 * each. The events are written before the delete, from rows read first, so
 * each names what was taken away. An audit failure never blocks the delete.
 * Audience grants stay: deleting a value's last one would share it with the
 * whole project (`iam/audience-grants.ts`).
 */
async function revokeAssignments(writer: Writer, accountId: string, userId: string): Promise<void> {
  try {
    const rows = await listAssignments({ accountId, principal: { type: 'user', id: userId }, liveOnly: false });
    for (const row of rows) {
      if (!isAudienceObjectType(row.objectType)) await auditAssignmentRevoked(writer, accountId, row);
    }
  } catch (err) {
    logger.warn('[offboarding] assignment revoke audit failed', { accountId, userId, error: errorMessage(err) });
  }
  await deleteProjectScopeAssignments(accountId, userId);
  await deleteAccountScopeAssignments(accountId, userId);
}

/**
 * Computer accounts that reach the person's machines, and reminders they set,
 * keep acting on their identity after access ends. Revoke and pause them, and
 * record one event with the counts (null: that step failed). Best effort: the
 * token revoke and drive hand-over still run, and the call-time guard
 * (`tunnel/core/rpc-core.ts`) and fire-time guard (`projects/lib/trigger-fire.ts`)
 * still refuse both.
 */
async function endWhatTheyLeftRunning(
  writer: Writer,
  accountId: string,
  userId: string,
  reason: OffboardReason,
): Promise<void> {
  const count = (step: string, run: () => Promise<number>) =>
    run().catch((err) => {
      logger.error(`[offboarding] ${step} FAILED`, { accountId, userId, reason, error: errorMessage(err) });
      return null;
    });
  const computersRevoked = await count('computer revocation', () => revokeComputersOfDepartedOwner(accountId, userId));
  const { disableRemindersAuthoredBy } = await import('../../projects/surface');
  const remindersDisabled = await count('reminder pause', () =>
    disableRemindersAuthoredBy(accountId, userId, new Date()),
  );
  await recordAuditEvent({
    accountId,
    actorUserId: writer === SYSTEM_ACTOR ? null : writer.userId,
    action: 'member.offboarded',
    resourceType: 'account_member',
    resourceId: userId,
    ip: writer === SYSTEM_ACTOR ? null : (writer.ctx.ip ?? null),
    metadata: { reason, computers_revoked: computersRevoked, reminders_disabled: remindersDisabled },
  }).catch((err) =>
    logger.error('[offboarding] summary audit event FAILED', { accountId, userId, error: errorMessage(err) }),
  );
}
