import { and, desc, eq, sql } from 'drizzle-orm';
import { sandboxes } from '@kortix/db';
import { db } from './db';
import { resolveAccountId } from './resolve-account';
import { isPlatformAdmin } from './platform-roles';

type SandboxRecord = typeof sandboxes.$inferSelect;

export interface SandboxAccessContext {
  userId: string;
  accountId: string;
  isAdmin: boolean;
}

export async function getSandboxAccessContext(userId: string): Promise<SandboxAccessContext> {
  const accountId = await resolveAccountId(userId);
  const admin = await isPlatformAdmin(accountId);
  return { userId, accountId, isAdmin: admin };
}

export async function findAccessibleSandboxById(
  context: SandboxAccessContext,
  sandboxId: string,
  options: { includeArchived?: boolean } = {},
): Promise<SandboxRecord | null> {
  const clauses = [eq(sandboxes.sandboxId, sandboxId)];
  if (!context.isAdmin) clauses.push(eq(sandboxes.accountId, context.accountId));
  if (!options.includeArchived) clauses.push(sql`${sandboxes.status} != 'archived'`);

  const [sandbox] = await db.select().from(sandboxes).where(and(...clauses)).limit(1);
  return sandbox ?? null;
}

export async function findPreferredSandboxForAction(
  context: SandboxAccessContext,
  requestedSandboxId?: string,
  options: { defaultStatus?: string; includeArchived?: boolean } = {},
): Promise<SandboxRecord | null> {
  if (requestedSandboxId) {
    return findAccessibleSandboxById(context, requestedSandboxId, options);
  }

  const clauses = [eq(sandboxes.accountId, context.accountId)];
  if (options.defaultStatus) clauses.push(eq(sandboxes.status, options.defaultStatus as any));
  if (!options.includeArchived) clauses.push(sql`${sandboxes.status} != 'archived'`);

  const [sandbox] = await db
    .select()
    .from(sandboxes)
    .where(and(...clauses))
    .orderBy(desc(sandboxes.createdAt))
    .limit(1);

  return sandbox ?? null;
}
