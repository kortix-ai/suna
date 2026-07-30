/**
 * Read-only audit that turns the entitlement invariant into a number someone can
 * look at. Reports; never writes.
 *
 * Deliberately NOT a corrector. The drift that prompted this was repaired by a
 * one-off reconciliation, and the explicit decision was that no recurring job
 * gets to move customer money on this rule — a silent auto-corrector on an
 * unwatched invariant is a worse failure mode than the drift it fixes. The job
 * of this module is to make the NEXT drift visible in days rather than months.
 */

import { creditAccounts } from '@kortix/db';
import { db } from '../../shared/db';
import {
  type EntitlementBreach,
  expiringCreditExceedsEntitlement,
  expiringCreditIsNegative,
} from './entitlement-invariant';

export interface EntitlementAuditRow extends EntitlementBreach {
  accountId: string;
  tier: string | null;
  billingModel: string | null;
  seatCount: number | null;
}

export interface EntitlementAuditReport {
  accountsScanned: number;
  overGrantedCount: number;
  overGrantedTotalUsd: number;
  negativeExpiringCount: number;
  negativeExpiringTotalUsd: number;
  worstOffenders: EntitlementAuditRow[];
}

/**
 * Scan every credit account and report the ones whose EXPIRING credit exceeds
 * what one cycle may grant. `worstOffenders` is capped so a report is readable;
 * the counts and totals cover every breach.
 *
 * No account identifiers are logged by the caller — the report carries ids so a
 * human can investigate a specific account deliberately, and the CLI in
 * scripts/audit-entitlement.ts prints only aggregates unless asked.
 */
export async function auditEntitlement(limit = 25): Promise<EntitlementAuditReport> {
  const rows = await db
    .select({
      accountId: creditAccounts.accountId,
      tier: creditAccounts.tier,
      billingModel: creditAccounts.billingModel,
      seatCount: creditAccounts.seatCount,
      expiringCredits: creditAccounts.expiringCredits,
    })
    .from(creditAccounts);

  const breaches: EntitlementAuditRow[] = [];
  let negativeExpiringCount = 0;
  let negativeExpiringTotalUsd = 0;

  for (const row of rows) {
    if (expiringCreditIsNegative(row)) {
      negativeExpiringCount += 1;
      negativeExpiringTotalUsd += Number(row.expiringCredits ?? 0) || 0;
    }

    const breach = expiringCreditExceedsEntitlement(row);
    if (!breach) continue;

    breaches.push({
      accountId: row.accountId,
      tier: row.tier ?? null,
      billingModel: row.billingModel ?? null,
      seatCount: row.seatCount ?? null,
      ...breach,
    });
  }

  breaches.sort((a, b) => b.excessUsd - a.excessUsd);

  return {
    accountsScanned: rows.length,
    overGrantedCount: breaches.length,
    overGrantedTotalUsd: breaches.reduce((sum, row) => sum + row.excessUsd, 0),
    negativeExpiringCount,
    negativeExpiringTotalUsd,
    worstOffenders: breaches.slice(0, limit),
  };
}
