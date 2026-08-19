#!/usr/bin/env bun
/**
 * Verdict-parity runner: old engine vs canonical engine, over the full grid.
 *
 *   cd apps/api && KORTIX_URL=http://localhost:8008 dotenvx run -q -- \
 *     bun scripts/rbac-parity.ts
 *
 * Exit 0 = every triple agrees. Exit 1 = at least one disagrees, and every
 * disagreement is printed as (principal, credential, action, object) with both
 * verdicts. Spec §5 requires 0 mismatches for 24 h before the cutover PR, so
 * this is what the dual-read window runs on a schedule.
 *
 * Runs against whatever DATABASE_URL points at. It creates ONE throwaway
 * account and deletes it (cascade) on the way out, including on failure.
 */
import {
  dropParityFixture,
  runParity,
  seedParityFixture,
  type ParityMismatch,
} from '../src/iam/parity-harness';

function group(mismatches: ParityMismatch[]): Map<string, ParityMismatch[]> {
  const out = new Map<string, ParityMismatch[]>();
  for (const m of mismatches) {
    const key = `${m.old.allowed ? 'allow' : 'deny'}:${m.old.reason} -> ${m.next.allowed ? 'allow' : 'deny'}:${m.next.reason}`;
    const list = out.get(key);
    if (list) list.push(m);
    else out.set(key, [m]);
  }
  return out;
}

async function main(): Promise<void> {
  const started = Date.now();
  const fixture = await seedParityFixture();
  try {
    const result = await runParity(fixture, { concurrency: Number(process.env.PARITY_CONCURRENCY ?? 24) });
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    console.log(
      `rbac-parity: ${result.total} triple(s), ${result.mismatches.length} mismatch(es) in ${seconds}s`,
    );
    if (result.mismatches.length === 0) {
      console.log('rbac-parity: PASS — the canonical engine returns the same verdict and reason everywhere.');
      return;
    }
    for (const [transition, rows] of group(result.mismatches)) {
      console.log(`\n  ${transition}  (${rows.length})`);
      for (const r of rows.slice(0, 25)) {
        console.log(`    ${r.principal} | ${r.credential} | ${r.action} | ${r.object}`);
      }
      if (rows.length > 25) console.log(`    … ${rows.length - 25} more`);
    }
    process.exitCode = 1;
  } finally {
    await dropParityFixture(fixture.accountId);
  }
}

await main();
