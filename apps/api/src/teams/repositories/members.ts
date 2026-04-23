import { and, eq } from 'drizzle-orm';
import { sandboxMembers, type Database } from '@kortix/db';

export interface SandboxMemberRow {
  sandboxId: string;
  userId: string;
  addedBy: string | null;
  addedAt: Date;
  monthlySpendCapCents: number | null;
  currentPeriodCents: number;
}

export async function listMembersForSandbox(
  db: Database,
  sandboxId: string,
): Promise<SandboxMemberRow[]> {
  const rows = await db
    .select()
    .from(sandboxMembers)
    .where(eq(sandboxMembers.sandboxId, sandboxId));
  return rows.map((r) => ({
    sandboxId: r.sandboxId,
    userId: r.userId,
    addedBy: r.addedBy ?? null,
    addedAt: r.addedAt,
    monthlySpendCapCents: r.monthlySpendCapCents ?? null,
    currentPeriodCents: r.currentPeriodCents ?? 0,
  }));
}

export async function listSandboxIdsForUser(
  db: Database,
  userId: string,
): Promise<string[]> {
  const rows = await db
    .select({ sandboxId: sandboxMembers.sandboxId })
    .from(sandboxMembers)
    .where(eq(sandboxMembers.userId, userId));
  return rows.map((r) => r.sandboxId);
}

export async function isSandboxMember(
  db: Database,
  sandboxId: string,
  userId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ userId: sandboxMembers.userId })
    .from(sandboxMembers)
    .where(and(eq(sandboxMembers.sandboxId, sandboxId), eq(sandboxMembers.userId, userId)))
    .limit(1);
  return Boolean(row);
}

export async function addSandboxMember(
  db: Database,
  input: { sandboxId: string; userId: string; addedBy?: string | null },
): Promise<void> {
  await db
    .insert(sandboxMembers)
    .values({
      sandboxId: input.sandboxId,
      userId: input.userId,
      addedBy: input.addedBy ?? null,
    })
    .onConflictDoNothing();
}

export async function removeSandboxMember(
  db: Database,
  sandboxId: string,
  userId: string,
): Promise<void> {
  await db
    .delete(sandboxMembers)
    .where(and(eq(sandboxMembers.sandboxId, sandboxId), eq(sandboxMembers.userId, userId)));
}

export async function setSandboxMemberSpendCap(
  db: Database,
  sandboxId: string,
  userId: string,
  capCents: number | null,
): Promise<void> {
  await db
    .update(sandboxMembers)
    .set({ monthlySpendCapCents: capCents })
    .where(and(eq(sandboxMembers.sandboxId, sandboxId), eq(sandboxMembers.userId, userId)));
}
