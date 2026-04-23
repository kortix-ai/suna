/**
 * Back-compat shim. The canonical access logic lives in `src/teams`.
 *
 * This file keeps the old `findAccessibleSandbox(For)User`/
 * `listAccessibleSandbox(es)ForUser` signatures alive so callers in
 * sandbox-cloud.ts, ssh.ts, sandbox-update.ts, sandbox-backups.ts, etc.,
 * keep working — internally it now routes through the teams module's
 * visibleSandboxFilter + loadUserTeamContext.
 *
 * New callers should import from '@kortix/api/teams' directly.
 */

import { and, desc, eq, inArray, ne, type SQL } from 'drizzle-orm';
import { sandboxes, type Database } from '@kortix/db';
import {
  loadUserTeamContext,
  visibleSandboxFilter,
  getAccountRole,
  type UserTeamContext,
} from '../../teams';
import { can, type Scope } from '../../permissions';

type SandboxRecord = typeof sandboxes.$inferSelect;
type SandboxStatus = SandboxRecord['status'];
type AccountRole = 'owner' | 'admin' | 'member';

export interface SandboxAccessContext {
  userId: string;
  accountId: string;
  accountRole: AccountRole | null;
  isPlatformAdmin: boolean;
  /** Legacy alias kept for callers reading `access.isAdmin`. */
  isAdmin: boolean;
  isAccountManager: boolean;
  allAccountIds: string[];
  managerAccountIds: string[];
  ownerAccountIds: string[];
}

export interface SandboxLookupOptions {
  sandboxId?: string;
  includeArchived?: boolean;
  defaultStatus?: SandboxStatus;
  statuses?: SandboxStatus[];
}

interface SandboxLookupForUserOptions extends SandboxLookupOptions {
  db: Database;
  userId: string;
  resolveAccountId: (userId: string) => Promise<string>;
}

function buildExtraFilters(
  ctx: UserTeamContext,
  db: Database,
  options: SandboxLookupOptions,
): SQL | undefined {
  const clauses: any[] = [];

  if (options.sandboxId) {
    clauses.push(eq(sandboxes.sandboxId, options.sandboxId));
  }

  const visibility = visibleSandboxFilter(db, ctx);
  if (visibility) clauses.push(visibility);

  if (!options.includeArchived) {
    clauses.push(ne(sandboxes.status, 'archived'));
  }

  if (options.defaultStatus) {
    clauses.push(eq(sandboxes.status, options.defaultStatus));
  }

  if (options.statuses?.length) {
    clauses.push(inArray(sandboxes.status, options.statuses as SandboxStatus[]));
  }

  if (clauses.length === 0) return undefined;
  return clauses.length === 1 ? (clauses[0] as SQL) : (and(...clauses) as SQL);
}

function toLegacyAccess(
  ctx: UserTeamContext,
  primaryAccountId: string,
  primaryRole: AccountRole | null,
): SandboxAccessContext {
  const isAccountManager = primaryRole === 'owner' || primaryRole === 'admin';
  return {
    userId: ctx.userId,
    accountId: primaryAccountId,
    accountRole: primaryRole,
    isPlatformAdmin: ctx.isPlatformAdmin,
    isAdmin: ctx.isPlatformAdmin,
    isAccountManager,
    allAccountIds: ctx.allAccountIds,
    managerAccountIds: ctx.managerAccountIds,
    ownerAccountIds: ctx.ownerAccountIds,
  };
}

export async function resolveSandboxAccessContext(
  userId: string,
  resolveAccountId: (userId: string) => Promise<string>,
  db?: Database,
): Promise<SandboxAccessContext> {
  const accountId = await resolveAccountId(userId);
  if (!db) {
    // Legacy path without db — fall back to minimal context. Modern callers
    // always pass db through findAccessibleSandboxForUser / listAccessibleSandboxesForUser.
    return {
      userId,
      accountId,
      accountRole: null,
      isPlatformAdmin: false,
      isAdmin: false,
      isAccountManager: false,
      allAccountIds: [],
      managerAccountIds: [],
      ownerAccountIds: [],
    };
  }
  const ctx = await loadUserTeamContext(db, userId, accountId);
  const primaryRole = await getAccountRole(db, userId, accountId);
  return toLegacyAccess(ctx, accountId, primaryRole);
}

async function applyScopeFilter(
  db: Database,
  ctx: UserTeamContext,
  rows: SandboxRecord[],
): Promise<SandboxRecord[]> {
  if (ctx.isPlatformAdmin || rows.length === 0) return rows;
  const checked = await Promise.all(
    rows.map(async (row) => {
      if (ctx.ownerAccountIds.includes(row.accountId)) return row;
      const allowed = await can(
        db,
        ctx,
        { sandboxId: row.sandboxId, accountId: row.accountId },
        'sandbox:use',
      );
      return allowed ? row : null;
    }),
  );
  return checked.filter((r): r is SandboxRecord => r !== null);
}

export async function findAccessibleSandbox(
  db: Database,
  access: SandboxAccessContext,
  options: SandboxLookupOptions = {},
): Promise<SandboxRecord | null> {
  const ctx: UserTeamContext = {
    userId: access.userId,
    isPlatformAdmin: access.isPlatformAdmin,
    allAccountIds: access.allAccountIds,
    managerAccountIds: access.managerAccountIds,
    ownerAccountIds: access.ownerAccountIds,
  };
  const where = buildExtraFilters(ctx, db, options);
  const candidates = await db
    .select()
    .from(sandboxes)
    .where(where ?? undefined as any)
    .orderBy(desc(sandboxes.createdAt))
    .limit(5);
  const visible = await applyScopeFilter(db, ctx, candidates);
  return visible[0] ?? null;
}

export async function listAccessibleSandboxes(
  db: Database,
  access: SandboxAccessContext,
  options: SandboxLookupOptions = {},
): Promise<SandboxRecord[]> {
  const ctx: UserTeamContext = {
    userId: access.userId,
    isPlatformAdmin: access.isPlatformAdmin,
    allAccountIds: access.allAccountIds,
    managerAccountIds: access.managerAccountIds,
    ownerAccountIds: access.ownerAccountIds,
  };
  const where = buildExtraFilters(ctx, db, options);
  const rows = await db
    .select()
    .from(sandboxes)
    .where(where ?? undefined as any)
    .orderBy(desc(sandboxes.createdAt));
  return applyScopeFilter(db, ctx, rows);
}

export async function findAccessibleSandboxForUser(options: SandboxLookupForUserOptions) {
  const access = await resolveSandboxAccessContext(
    options.userId,
    options.resolveAccountId,
    options.db,
  );
  const sandbox = await findAccessibleSandbox(options.db, access, options);
  return { access, sandbox };
}

export async function listAccessibleSandboxesForUser(options: SandboxLookupForUserOptions) {
  const access = await resolveSandboxAccessContext(
    options.userId,
    options.resolveAccountId,
    options.db,
  );
  const sandboxesList = await listAccessibleSandboxes(options.db, access, options);
  return { access, sandboxes: sandboxesList };
}

export async function hasSandboxScope(
  db: Database,
  access: SandboxAccessContext,
  sandbox: { sandboxId: string; accountId: string },
  scope: Scope,
): Promise<boolean> {
  if (access.isPlatformAdmin) return true;
  if (access.ownerAccountIds.includes(sandbox.accountId)) return true;
  const ctx: UserTeamContext = {
    userId: access.userId,
    isPlatformAdmin: access.isPlatformAdmin,
    allAccountIds: access.allAccountIds,
    managerAccountIds: access.managerAccountIds,
    ownerAccountIds: access.ownerAccountIds,
  };
  return can(db, ctx, sandbox, scope);
}

export { getAccountRole };
