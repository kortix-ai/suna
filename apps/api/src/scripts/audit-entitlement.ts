/**
 * Report accounts whose monthly expiring allowance exceeds what their tier may
 * grant in one cycle.
 *
 *   bun run src/scripts/audit-entitlement.ts            # aggregates only
 *   bun run src/scripts/audit-entitlement.ts --detail    # + worst offenders
 *
 * READ-ONLY. It never grants, debits, or resets anything. Exits 1 when the
 * invariant is breached so it can be wired to an alert.
 */

import { auditEntitlement } from '../billing/services/entitlement-audit';

async function main() {
  const detail = process.argv.includes('--detail');
  const report = await auditEntitlement();

  console.log(`accounts scanned:              ${report.accountsScanned}`);
  console.log(`over-granted accounts:         ${report.overGrantedCount}`);
  console.log(`over-granted total:            $${report.overGrantedTotalUsd.toFixed(2)}`);
  console.log(`negative expiring accounts:    ${report.negativeExpiringCount}`);
  console.log(`negative expiring total:       $${report.negativeExpiringTotalUsd.toFixed(2)}`);

  if (detail && report.worstOffenders.length > 0) {
    console.log('\nworst offenders (expiring vs entitlement):');
    for (const row of report.worstOffenders) {
      const shape = row.billingModel === 'per_seat' ? `per_seat x${row.seatCount ?? 1}` : row.tier;
      console.log(
        `  ${row.accountId}  ${shape}  expected $${row.expectedUsd.toFixed(2)}  actual $${row.actualUsd.toFixed(2)}  excess $${row.excessUsd.toFixed(2)}`,
      );
    }
  }

  if (report.overGrantedCount > 0 || report.negativeExpiringCount > 0) {
    console.error('\nentitlement invariant BREACHED — investigate before the next cycle.');
    process.exit(1);
  }

  console.log('\nentitlement invariant holds.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
