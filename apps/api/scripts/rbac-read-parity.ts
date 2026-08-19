#!/usr/bin/env bun
/**
 * READ-model parity runner: the legacy grant stores vs `role_assignments`.
 *
 *   cd apps/api && dotenvx run -q -- bun scripts/rbac-read-parity.ts
 *
 * The sibling of `rbac-parity.ts`. That one proves the ENGINE agrees; this one
 * proves every access SCREEN agrees — the seven read models rebuilt on top of
 * `role_assignments` return the same rows as the queries they replaced.
 *
 * It reuses the verdict harness's fixture, which writes ONLY the legacy tables
 * and lets the dual-write mirror triggers populate the canonical one, so a
 * difference here is a difference in the PROJECTION and nowhere else.
 *
 * Exit 0 = zero diffs. Exit 1 = at least one, printed with both sides.
 */
import { dropParityFixture, seedParityFixture } from '../src/iam/parity-harness';
import { runReadParity } from '../src/iam/read-parity';
import { db } from '../src/shared/db';
import { sql } from 'drizzle-orm';

async function main(): Promise<void> {
  const started = Date.now();
  const fixture = await seedParityFixture();
  try {
    const memberRows = (await db.execute(
      sql`select user_id::text as user_id from kortix.account_members where account_id = ${fixture.accountId}::uuid`,
    )) as unknown as Array<{ user_id: string }>;
    const userIds = (
      (memberRows as unknown as { rows?: Array<{ user_id: string }> }).rows ?? memberRows
    ).map((r) => r.user_id);

    const result = await runReadParity({
      accountId: fixture.accountId,
      projectIds: [fixture.projectId, fixture.otherProjectId],
      userIds,
    });
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    console.log(
      `rbac-read-parity: ${result.compared} row(s) compared, ${result.diffs.length} diff(s) in ${seconds}s`,
    );
    if (result.diffs.length === 0) {
      console.log(
        'rbac-read-parity: PASS — every read model returns the same rows from role_assignments.',
      );
      return;
    }
    for (const d of result.diffs.slice(0, 40)) {
      console.log(`\n  ${d.model} · ${d.key}`);
      console.log(`    legacy:    ${JSON.stringify(d.legacy)}`);
      console.log(`    canonical: ${JSON.stringify(d.canonical)}`);
    }
    if (result.diffs.length > 40) console.log(`\n  … ${result.diffs.length - 40} more`);
    process.exitCode = 1;
  } finally {
    await dropParityFixture(fixture.accountId);
  }
}

await main();
