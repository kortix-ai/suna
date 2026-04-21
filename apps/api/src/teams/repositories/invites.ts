import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { sandboxes, sandboxInvites, type Database } from '@kortix/db';
import type { SandboxInvite } from '../domain/types';

function toDomain(row: typeof sandboxInvites.$inferSelect): SandboxInvite {
  return {
    inviteId: row.inviteId,
    sandboxId: row.sandboxId,
    accountId: row.accountId,
    email: row.email,
    invitedBy: row.invitedBy ?? null,
    acceptedAt: row.acceptedAt ?? null,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

// "Pending" means: not accepted AND not expired. Every list query uses this
// predicate so callers never see expired rows — they're cleaned up separately
// by the background cleanup job.
function pendingClause() {
  return and(isNull(sandboxInvites.acceptedAt), gt(sandboxInvites.expiresAt, sql`now()`));
}

export async function findInviteById(
  db: Database,
  inviteId: string,
): Promise<(SandboxInvite & { sandboxName: string | null }) | null> {
  const [row] = await db
    .select({
      inviteId: sandboxInvites.inviteId,
      sandboxId: sandboxInvites.sandboxId,
      accountId: sandboxInvites.accountId,
      email: sandboxInvites.email,
      invitedBy: sandboxInvites.invitedBy,
      acceptedAt: sandboxInvites.acceptedAt,
      createdAt: sandboxInvites.createdAt,
      expiresAt: sandboxInvites.expiresAt,
      sandboxName: sandboxes.name,
    })
    .from(sandboxInvites)
    .leftJoin(sandboxes, eq(sandboxInvites.sandboxId, sandboxes.sandboxId))
    .where(eq(sandboxInvites.inviteId, inviteId))
    .limit(1);
  if (!row) return null;
  return {
    inviteId: row.inviteId,
    sandboxId: row.sandboxId,
    accountId: row.accountId,
    email: row.email,
    invitedBy: row.invitedBy ?? null,
    acceptedAt: row.acceptedAt ?? null,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    sandboxName: row.sandboxName ?? null,
  };
}

export async function findPendingInviteForSandbox(
  db: Database,
  sandboxId: string,
  email: string,
): Promise<SandboxInvite | null> {
  const [row] = await db
    .select()
    .from(sandboxInvites)
    .where(
      and(
        eq(sandboxInvites.sandboxId, sandboxId),
        sql`lower(${sandboxInvites.email}) = ${email.toLowerCase()}`,
        pendingClause(),
      ),
    )
    .limit(1);
  return row ? toDomain(row) : null;
}

export async function listPendingInvitesForSandbox(
  db: Database,
  sandboxId: string,
): Promise<SandboxInvite[]> {
  const rows = await db
    .select()
    .from(sandboxInvites)
    .where(and(eq(sandboxInvites.sandboxId, sandboxId), pendingClause()));
  return rows.map(toDomain);
}

export async function listPendingInvitesForEmail(
  db: Database,
  email: string,
): Promise<SandboxInvite[]> {
  const rows = await db
    .select()
    .from(sandboxInvites)
    .where(
      and(
        sql`lower(${sandboxInvites.email}) = ${email.toLowerCase()}`,
        pendingClause(),
      ),
    );
  return rows.map(toDomain);
}

/**
 * Hard-delete every invite that's expired and never accepted. Returns the
 * number of rows removed — handy for the cleanup job log. Accepted invites
 * are left alone (they're historical, not pending).
 */
export async function deleteExpiredInvites(db: Database): Promise<number> {
  const result = await db
    .delete(sandboxInvites)
    .where(
      and(
        isNull(sandboxInvites.acceptedAt),
        sql`${sandboxInvites.expiresAt} <= now()`,
      ),
    );
  // drizzle's postgres-js driver returns { count } on delete; pg-node returns rowCount.
  const anyResult = result as any;
  return anyResult?.count ?? anyResult?.rowCount ?? 0;
}

export async function createInvite(
  db: Database,
  input: {
    sandboxId: string;
    accountId: string;
    email: string;
    invitedBy: string | null;
  },
): Promise<SandboxInvite | null> {
  const [row] = await db
    .insert(sandboxInvites)
    .values({
      sandboxId: input.sandboxId,
      accountId: input.accountId,
      email: input.email.toLowerCase(),
      invitedBy: input.invitedBy,
    })
    .onConflictDoNothing()
    .returning();
  return row ? toDomain(row) : null;
}

export async function markInviteAccepted(
  db: Database,
  inviteId: string,
): Promise<void> {
  await db
    .update(sandboxInvites)
    .set({ acceptedAt: new Date() })
    .where(eq(sandboxInvites.inviteId, inviteId));
}

export async function deleteInvite(
  db: Database,
  inviteId: string,
  sandboxId?: string,
): Promise<void> {
  const clause = sandboxId
    ? and(eq(sandboxInvites.inviteId, inviteId), eq(sandboxInvites.sandboxId, sandboxId))
    : eq(sandboxInvites.inviteId, inviteId);
  await db.delete(sandboxInvites).where(clause);
}
