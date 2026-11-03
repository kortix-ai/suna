import { enterpriseContracts } from '@kortix/db';
import { and, eq, gt, isNotNull, lte } from 'drizzle-orm';
import { logger } from '../../lib/logger';
import { db } from '../../shared/db';
import { endExpiredManualContracts } from './enterprise-contracts';
import { claimOnce, notifyContractEnding } from './access-notices';

const DAY_MS = 24 * 60 * 60 * 1000;
export const CONTRACT_WARNING_DAYS = [30, 7, 1] as const;

/** Whole days until `endsAt`, rounded up (0 once it has passed). */
export function daysLeft(endsAt: string, nowMs: number): number {
  return Math.max(0, Math.ceil((new Date(endsAt).getTime() - nowMs) / DAY_MS));
}

/** The smallest warning threshold `left` days falls under, or null when none applies yet. */
export function warningThreshold(left: number, thresholds: readonly number[]): number | null {
  const due = thresholds.filter((t) => left <= t);
  return due.length > 0 ? Math.min(...due) : null;
}


/**
 * The hourly access sweep: end manual licenses whose term is over, and send the
 * warnings that are due.
 */
export async function runAccessSweep(now: Date = new Date()): Promise<{
  contractsEnded: number;
  warningsSent: number;
}> {
  const nowMs = now.getTime();
  const contractsEnded = await endExpiredManualContracts(now);
  let warningsSent = 0;

  const contracts = await db
    .select({ id: enterpriseContracts.id, accountId: enterpriseContracts.accountId, endsAt: enterpriseContracts.endsAt })
    .from(enterpriseContracts)
    .where(
      and(
        eq(enterpriseContracts.status, 'active'),
        eq(enterpriseContracts.autoRenews, false),
        isNotNull(enterpriseContracts.endsAt),
        gt(enterpriseContracts.endsAt, now.toISOString()),
        lte(enterpriseContracts.endsAt, new Date(nowMs + Math.max(...CONTRACT_WARNING_DAYS) * DAY_MS).toISOString()),
      ),
    );
  for (const contract of contracts) {
    if (!contract.endsAt) continue;
    const left = daysLeft(contract.endsAt, nowMs);
    const threshold = warningThreshold(left, CONTRACT_WARNING_DAYS);
    if (threshold === null) continue;
    if (!(await claimOnce(`billing:contract-ending:${contract.id}:${new Date(contract.endsAt).getTime()}:${threshold}`))) continue;
    await notifyContractEnding(contract.accountId, contract.endsAt, left)
      .then(() => warningsSent++)
      .catch((err) => logger.warn('[access-notices] contract warning failed', { error: (err as Error).message }));
  }

  return { contractsEnded, warningsSent };
}
