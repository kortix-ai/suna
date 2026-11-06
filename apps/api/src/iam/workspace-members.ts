/**
 * THE membership write (design.md §3.2 C3): every path that makes a person a
 * member of a workspace goes through `addWorkspaceMember` — the invite add, the
 * invite accept, the `/v1/accounts` auto-claim, SSO JIT and SCIM.
 *
 * Membership IS access: an account member reaches the account's one workspace
 * at the member tier (`iam/authorize.ts`, `effectiveProjectRole`), so a member
 * needs no second, project-scope grant. What this writes, per ladder role:
 *
 *   owner / admin  the identity row + that account-scope system role;
 *   manager        the identity row + account `member` + project `manager` on
 *                  the workspace's project (exclusive, like the old column);
 *   member         the identity row + account `member`.
 *
 * `explicitProjectGrants` exist only for a `split_pending` legacy account (2+
 * active projects), where a member still reaches a project only through a
 * grant on it. The route validates them (C3); this writes them.
 */
import { and, eq } from 'drizzle-orm';
import { accountMemberships } from '@kortix/db';
import { logger } from '../lib/logger';
import { db } from '../shared/db';
import { assignRole, SYSTEM_ACTOR, type AssignmentSource, type Writer } from './assignments';
import { workspaceFactsOf } from './workspace-facts';
import { invalidateIamCacheForUser } from './cache-invalidation';
import { accountRoleForWorkspaceRole, type ProjectRole, type WorkspaceRole } from './roles';

export interface ExplicitProjectGrant {
  projectId: string;
  role: ProjectRole;
}

export interface AddWorkspaceMemberOptions {
  /** Who writes the role. Default `SYSTEM_ACTOR`: the route authorized the caller. */
  writer?: Writer;
  /** Why the assignment exists (`invite`, `sso`, `scim`, …). Default `manual`. */
  source?: AssignmentSource;
  /** The human who granted the project rows; null for a system write. */
  grantedBy?: string | null;
  /** A current member keeps the role they hold (an invite re-entry never rewrites a demotion). */
  keepExistingRole?: boolean;
  /** SCIM's external id on the identity row (upserted). */
  scimExternalId?: string | null;
  /** The role writes are best-effort (SSO JIT inside the auth middleware): the identity row stands. */
  roleBestEffort?: boolean;
  /** The membership ends at this time (a time-boxed guest); null = no expiry. */
  expiresAt?: Date | null;
}

export interface AddWorkspaceMemberResult {
  /** The identity row was created by this call (false = already a member). */
  created: boolean;
}

export async function addWorkspaceMember(
  accountId: string,
  userId: string,
  role: WorkspaceRole,
  explicitProjectGrants: readonly ExplicitProjectGrant[] = [],
  opts: AddWorkspaceMemberOptions = {},
): Promise<AddWorkspaceMemberResult> {
  // IDENTITY first: it is what lets `assignRole`'s principal check resolve.
  const [existing] = await db
    .select({ userId: accountMemberships.userId })
    .from(accountMemberships)
    .where(and(eq(accountMemberships.userId, userId), eq(accountMemberships.accountId, accountId)))
    .limit(1);
  const created = !existing;
  if (opts.scimExternalId !== undefined) {
    await db
      .insert(accountMemberships)
      .values({ userId, accountId, scimExternalId: opts.scimExternalId })
      .onConflictDoUpdate({
        target: [accountMemberships.accountId, accountMemberships.userId],
        set: { scimExternalId: opts.scimExternalId },
      });
  } else if (created) {
    await db
      .insert(accountMemberships)
      .values({ userId, accountId })
      .onConflictDoNothing({ target: [accountMemberships.userId, accountMemberships.accountId] });
  }

  if (!(opts.keepExistingRole && !created)) {
    const writeRoles = async () => {
      const writer = opts.writer ?? SYSTEM_ACTOR;
      const source = opts.source ?? 'manual';
      await assignRole(writer, accountId, {
        principal: { type: 'user', id: userId },
        roleKey: accountRoleForWorkspaceRole(role),
        scope: { type: 'account' },
        expiresAt: opts.expiresAt ?? null,
        source,
        exclusive: true,
        grantedBy: opts.grantedBy ?? undefined,
      });
      const grants: ExplicitProjectGrant[] = [...explicitProjectGrants];
      if (role === 'manager') {
        const { soleProjectId } = await workspaceFactsOf(accountId);
        if (soleProjectId) grants.push({ projectId: soleProjectId, role: 'manager' });
      }
      for (const grant of grants) {
        await assignRole(SYSTEM_ACTOR, accountId, {
          principal: { type: 'user', id: userId },
          roleKey: grant.role,
          scope: { type: 'project', id: grant.projectId },
          expiresAt: opts.expiresAt ?? null,
          source,
          exclusive: true,
          grantedBy: opts.grantedBy ?? null,
        });
      }
    };
    if (opts.roleBestEffort) {
      await writeRoles().catch((err) => {
        logger.warn('[workspace-members] role write failed; the identity row stands', {
          accountId,
          userId,
          err: (err as Error)?.message,
        });
      });
    } else {
      await writeRoles();
    }
  }
  invalidateIamCacheForUser(userId);
  return { created };
}
