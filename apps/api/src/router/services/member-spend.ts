import { and, eq, sql } from 'drizzle-orm';

import { db } from '../../shared/db';
import { creditAccounts, sandboxMembers, sandboxes } from '@kortix/db';

export interface CapStatus {
  capCents: number | null;
  currentCents: number;
  ownerPeriodStart: number | null;
}

export async function getSandboxMemberCapStatus(
  sandboxId: string,
  userId: string,
): Promise<CapStatus | null> {
  const [row] = await db
    .select({
      capCents: sandboxMembers.monthlySpendCapCents,
      currentCents: sandboxMembers.currentPeriodCents,
      storedPeriodStart: sandboxMembers.currentPeriodStart,
      ownerPeriodStart: creditAccounts.lastRenewalPeriodStart,
    })
    .from(sandboxMembers)
    .innerJoin(sandboxes, eq(sandboxes.sandboxId, sandboxMembers.sandboxId))
    .leftJoin(creditAccounts, eq(creditAccounts.accountId, sandboxes.accountId))
    .where(
      and(
        eq(sandboxMembers.sandboxId, sandboxId),
        eq(sandboxMembers.userId, userId),
      ),
    )
    .limit(1);

  if (!row) return null;

  const ownerPeriodStart =
    typeof row.ownerPeriodStart === 'number' ? row.ownerPeriodStart : null;

  const periodAdvanced =
    ownerPeriodStart !== null && row.storedPeriodStart !== ownerPeriodStart;

  return {
    capCents: row.capCents ?? null,
    currentCents: periodAdvanced ? 0 : row.currentCents,
    ownerPeriodStart,
  };
}

export async function applyActorSpend(
  sandboxId: string,
  userId: string,
  cents: number,
): Promise<void> {
  if (cents <= 0) return;

  const [ownerRow] = await db
    .select({ ownerPeriodStart: creditAccounts.lastRenewalPeriodStart })
    .from(sandboxes)
    .leftJoin(creditAccounts, eq(creditAccounts.accountId, sandboxes.accountId))
    .where(eq(sandboxes.sandboxId, sandboxId))
    .limit(1);
  const ownerPeriodStart =
    typeof ownerRow?.ownerPeriodStart === 'number' ? ownerRow.ownerPeriodStart : null;

  await db
    .update(sandboxMembers)
    .set({
      currentPeriodCents: sql`CASE
        WHEN ${sandboxMembers.currentPeriodStart} IS DISTINCT FROM ${ownerPeriodStart}
          THEN ${cents}
        ELSE ${sandboxMembers.currentPeriodCents} + ${cents}
      END`,
      currentPeriodStart: ownerPeriodStart,
    })
    .where(
    and(
        eq(sandboxMembers.sandboxId, sandboxId),
        eq(sandboxMembers.userId, userId),
      ),
    );
}

export async function reserveActorSpend(
  sandboxId: string,
  userId: string,
  cents: number,
): Promise<{ success: true; reservedCents: number } | {
  success: false;
  capCents: number | null;
  currentCents: number;
}> {
  if (cents <= 0) return { success: true, reservedCents: 0 };

  const [ownerRow] = await db
    .select({ ownerPeriodStart: creditAccounts.lastRenewalPeriodStart })
    .from(sandboxes)
    .leftJoin(creditAccounts, eq(creditAccounts.accountId, sandboxes.accountId))
    .where(eq(sandboxes.sandboxId, sandboxId))
    .limit(1);
  const ownerPeriodStart =
    typeof ownerRow?.ownerPeriodStart === 'number' ? ownerRow.ownerPeriodStart : null;

  const currentForPeriod = sql<number>`CASE
    WHEN ${sandboxMembers.currentPeriodStart} IS DISTINCT FROM ${ownerPeriodStart}
      THEN 0
    ELSE ${sandboxMembers.currentPeriodCents}
  END`;

  const [updated] = await db
    .update(sandboxMembers)
    .set({
      currentPeriodCents: sql`${currentForPeriod} + ${cents}`,
      currentPeriodStart: ownerPeriodStart,
    })
    .where(
      and(
        eq(sandboxMembers.sandboxId, sandboxId),
        eq(sandboxMembers.userId, userId),
        sql`(
          ${sandboxMembers.monthlySpendCapCents} IS NULL
          OR ${currentForPeriod} + ${cents} <= ${sandboxMembers.monthlySpendCapCents}
        )`,
      ),
    )
    .returning({
      currentCents: sandboxMembers.currentPeriodCents,
    });

  if (updated) return { success: true, reservedCents: cents };

  const status = await getSandboxMemberCapStatus(sandboxId, userId);
  if (!status) return { success: true, reservedCents: 0 };
  return {
    success: false,
    capCents: status.capCents,
    currentCents: status.currentCents,
  };
}

export async function refundActorSpend(
  sandboxId: string,
  userId: string,
  cents: number,
): Promise<void> {
  if (cents <= 0) return;

  await db
    .update(sandboxMembers)
    .set({
      currentPeriodCents: sql`GREATEST(${sandboxMembers.currentPeriodCents} - ${cents}, 0)`,
    })
    .where(
      and(
        eq(sandboxMembers.sandboxId, sandboxId),
        eq(sandboxMembers.userId, userId),
      ),
    );
}

export function dollarsToCents(dollars: number): number {
  if (dollars <= 0) return 0;
  return Math.ceil(dollars * 100);
}
