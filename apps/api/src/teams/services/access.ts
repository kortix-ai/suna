import { and, eq, inArray, ne, or, sql, type SQL } from 'drizzle-orm';
import { sandboxes, sandboxMembers, type Database } from '@kortix/db';
import { isPlatformAdmin } from '../../shared/platform-roles';
import { NotFoundError } from '../domain/errors';
import type {
  AccessDecision,
  SandboxAction,
  SandboxRef,
} from '../domain/types';
import {
  getAccountRole,
  listUserMemberships,
} from '../repositories/accounts';
import {
  effectiveScopes,
  resolveRole,
  type Scope,
} from '../../permissions';

export interface UserTeamContext {
  userId: string;
  isPlatformAdmin: boolean;
  allAccountIds: string[];
  managerAccountIds: string[];
  ownerAccountIds: string[];
}

export async function loadUserTeamContext(
  db: Database,
  userId: string,
  primaryAccountId: string,
): Promise<UserTeamContext> {
  const [platformAdmin, memberships] = await Promise.all([
    isPlatformAdmin(primaryAccountId),
    listUserMemberships(db, userId),
  ]);
  return {
    userId,
    isPlatformAdmin: platformAdmin,
    allAccountIds: memberships.map((m) => m.accountId),
    managerAccountIds: memberships
      .filter((m) => m.role === 'owner' || m.role === 'admin')
      .map((m) => m.accountId),
    ownerAccountIds: memberships
      .filter((m) => m.role === 'owner')
      .map((m) => m.accountId),
  };
}

const ACTION_TO_SCOPE: Partial<Record<SandboxAction, Scope>> = {
  view: 'sandbox:use',
  execute: 'sandbox:use',
  write: 'sandbox:use',
  lifecycle: 'sandbox:use',
  manage_members: 'members:invite',
};

const OWNER_ONLY_ACTIONS: ReadonlySet<SandboxAction> = new Set([
  'rename',
  'delete',
]);

export async function decideAccess(
  db: Database,
  ctx: UserTeamContext,
  sandbox: SandboxRef,
  action: SandboxAction = 'view',
): Promise<AccessDecision> {
  const role = await resolveRole(db, ctx, sandbox);
  if (role === null) {
    return { allowed: false, reason: 'not_member' };
  }

  if (OWNER_ONLY_ACTIONS.has(action)) {
    const allowed = role === 'platform_admin' || role === 'owner';
    return allowed
      ? {
          allowed: true,
          reason: role === 'platform_admin' ? 'platform_admin' : 'account_manager',
        }
      : { allowed: false, reason: 'not_member' };
  }

  const scope = ACTION_TO_SCOPE[action];
  if (!scope) {
    return { allowed: false, reason: 'not_member' };
  }

  const scopes = await effectiveScopes(db, ctx, sandbox);
  const allowed = scopes.has(scope);
  const reason: AccessDecision['reason'] =
    role === 'platform_admin'
      ? 'platform_admin'
      : role === 'owner' || role === 'admin'
        ? 'account_manager'
        : 'sandbox_member';
  return allowed
    ? { allowed: true, reason }
    : { allowed: false, reason: 'not_member' };
}

export async function canAccess(
  db: Database,
  ctx: UserTeamContext,
  sandbox: SandboxRef,
  action: SandboxAction = 'view',
): Promise<boolean> {
  return (await decideAccess(db, ctx, sandbox, action)).allowed;
}

export function visibleSandboxFilter(
  db: Database,
  ctx: UserTeamContext,
): SQL | undefined {
  if (ctx.isPlatformAdmin) return undefined;

  const managerClause = ctx.managerAccountIds.length
    ? inArray(sandboxes.accountId, ctx.managerAccountIds)
    : sql`false`;

  const memberClause = ctx.allAccountIds.length
    ? and(
        inArray(sandboxes.accountId, ctx.allAccountIds),
        inArray(
          sandboxes.sandboxId,
          db
            .select({ sandboxId: sandboxMembers.sandboxId })
            .from(sandboxMembers)
            .where(eq(sandboxMembers.userId, ctx.userId)),
        ),
      )
    : sql`false`;

  return or(managerClause, memberClause) as SQL;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function canAccessPreviewTarget(
  db: Database,
  ctx: UserTeamContext,
  previewTargetId: string,
): Promise<boolean> {
  if (ctx.isPlatformAdmin) return true;

  const idCondition = UUID_RE.test(previewTargetId)
    ? or(
        eq(sandboxes.externalId, previewTargetId),
        eq(sandboxes.sandboxId, previewTargetId),
      )
    : eq(sandboxes.externalId, previewTargetId);

  const [hit] = await db
    .select({ sandboxId: sandboxes.sandboxId, accountId: sandboxes.accountId })
    .from(sandboxes)
    .where(and(idCondition, ne(sandboxes.status, 'pooled')))
    .limit(1);
  if (!hit) return false;

  if (ctx.ownerAccountIds.includes(hit.accountId)) return true;
  return canAccess(db, ctx, hit, 'view');
}

export async function loadSandboxForUser(
  db: Database,
  ctx: UserTeamContext,
  sandboxId: string,
  action: SandboxAction = 'view',
): Promise<{ sandbox: typeof sandboxes.$inferSelect; decision: AccessDecision }> {
  const [row] = await db
    .select()
    .from(sandboxes)
    .where(eq(sandboxes.sandboxId, sandboxId))
    .limit(1);
  if (!row) throw new NotFoundError('Sandbox not found');
  const decision = await decideAccess(
    db,
    ctx,
    { sandboxId: row.sandboxId, accountId: row.accountId },
    action,
  );
  return { sandbox: row, decision };
}

export { getAccountRole };
