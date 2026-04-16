import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import { sandboxes, type Database } from '@kortix/db';
import { isPlatformAdmin } from '../../shared/platform-roles';

type SandboxRecord = typeof sandboxes.$inferSelect;
type SandboxStatus = SandboxRecord['status'];

export interface SandboxAccessContext {
  accountId: string;
  isAdmin: boolean;
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

function buildSandboxWhere(access: SandboxAccessContext, options: SandboxLookupOptions = {}) {
  const clauses: any[] = [];

  if (options.sandboxId) {
    clauses.push(eq(sandboxes.sandboxId, options.sandboxId));
    if (!access.isAdmin) {
      clauses.push(eq(sandboxes.accountId, access.accountId));
    }
  } else {
    clauses.push(eq(sandboxes.accountId, access.accountId));
  }

  if (!options.includeArchived) {
    clauses.push(ne(sandboxes.status, 'archived'));
  }

  if (options.defaultStatus) {
    clauses.push(eq(sandboxes.status, options.defaultStatus));
  }

  if (options.statuses?.length) {
    clauses.push(inArray(sandboxes.status, options.statuses as SandboxStatus[]));
  }

  return clauses.length === 1 ? clauses[0] : and(...clauses);
}

export async function resolveSandboxAccessContext(
  userId: string,
  resolveAccountId: (userId: string) => Promise<string>,
): Promise<SandboxAccessContext> {
  const accountId = await resolveAccountId(userId);
  const isAdmin = await isPlatformAdmin(accountId);
  return { accountId, isAdmin };
}

export async function findAccessibleSandbox(
  db: Database,
  access: SandboxAccessContext,
  options: SandboxLookupOptions = {},
): Promise<SandboxRecord | null> {
  const [sandbox] = await db
    .select()
    .from(sandboxes)
    .where(buildSandboxWhere(access, options))
    .orderBy(desc(sandboxes.createdAt))
    .limit(1);

  return sandbox ?? null;
}

export async function listAccessibleSandboxes(
  db: Database,
  access: SandboxAccessContext,
  options: SandboxLookupOptions = {},
): Promise<SandboxRecord[]> {
  return db
    .select()
    .from(sandboxes)
    .where(buildSandboxWhere(access, options))
    .orderBy(desc(sandboxes.createdAt));
}

export async function findAccessibleSandboxForUser(options: SandboxLookupForUserOptions) {
  const access = await resolveSandboxAccessContext(options.userId, options.resolveAccountId);
  const sandbox = await findAccessibleSandbox(options.db, access, options);
  return { access, sandbox };
}

export async function listAccessibleSandboxesForUser(options: SandboxLookupForUserOptions) {
  const access = await resolveSandboxAccessContext(options.userId, options.resolveAccountId);
  const sandboxesList = await listAccessibleSandboxes(options.db, access, options);
  return { access, sandboxes: sandboxesList };
}
