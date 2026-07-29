/**
 * BOUNDED SANDBOX LIFETIME — THE STRUCTURAL GUARD.
 *
 * THE MOST IMPORTANT FILE IN THIS FEATURE. Everything else fixes the leak once.
 * This is what stops it being re-introduced by someone who never read the
 * design — which is the only failure mode that actually matters, because this
 * exact class of bug has already regressed twice (PR #4228 reimbursed $161.92
 * for an earlier version of it; #4412's lease veto then invalidated #4228's
 * reasoning four days later).
 *
 * Four layers, and every one of them is proved BY VIOLATING IT:
 *
 *   Layer 0  the DB anchor guard + CHECK      (packages/db integration test)
 *   Layer 1  the branded proof type            §"proved by violating it" below
 *   Layer 2  one writer, frozen imports        §"the scanners" below
 *   Layer 3  the constants cannot widen        constants.test.ts
 *
 * A guard that has only ever been observed PASSING is not evidence of anything.
 * Every scanner here therefore runs twice: once over the real tree, which must
 * be clean, and once over a synthetic file that breaks the rule, which must be
 * caught. If the second assertion ever stops failing on the violation, the
 * guard has silently died and this test says so.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import {
  ALLOWED_LIFETIME_WRITERS,
  ALLOWED_MIGRATION_WRITERS,
  ALLOWED_PROOF_PRODUCERS,
  DEADLINE_IMPORT_ALLOWLIST,
  type SourceFile,
  excludeGuardSelf,
  findBannedMechanismUsage,
  findLifetimeColumnWriters,
  findMigrationLifetimeWriters,
  findProofForgers,
  importsOf,
  writesLifetimeColumns,
} from './architecture';

const API_SRC = resolve(import.meta.dir, '..', '..');
/**
 * apps/api/scripts is scanned too. It is not application code, but it runs
 * against PRODUCTION with a prod DATABASE_URL — the remediation drain lives
 * there — so a one-off script that hands a customer's box another week is
 * exactly as damaging as a route that does, and strictly more likely to be
 * written in a hurry.
 */
const API_SCRIPTS = resolve(import.meta.dir, '..', '..', '..', 'scripts');
const MIGRATIONS = resolve(import.meta.dir, '..', '..', '..', '..', '..', 'packages/db/migrations');

function walk(dir: string, filter: (path: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, filter));
    else if (filter(full)) out.push(full);
  }
  return out;
}

function load(root: string, filter: (path: string) => boolean): SourceFile[] {
  return walk(root, filter).map((full) => ({
    path: relative(root, full).replaceAll('\\', '/'),
    source: readFileSync(full, 'utf8'),
  }));
}

/**
 * Test files are excluded from the WRITER scan and only from that scan.
 * A `$inferSelect` fixture must name every column of the row it constructs, so
 * including them would make the allowlist grow by one line per test that ever
 * touches a sandbox row — and an allowlist that grows routinely is an allowlist
 * nobody reads. A test cannot write to production; the mutation rules below
 * still cover every non-test file.
 */
const PRODUCTION_TS = (path: string) => path.endsWith('.ts') && !path.includes('.test.');
const ANY_TS = (path: string) => path.endsWith('.ts');

describe('layer 2 — one writer, over the REAL tree', () => {
  test('A1: exactly one production module can write the lifetime columns', () => {
    // A file-set assertion, not a hit count: a count fails noisily on a harmless
    // refactor and then gets relaxed by the first person it annoys.
    expect(
      findLifetimeColumnWriters([
        ...excludeGuardSelf(load(API_SRC, PRODUCTION_TS)),
        ...load(API_SCRIPTS, PRODUCTION_TS).map((file) => ({
          ...file,
          path: `scripts/${file.path}`,
        })),
      ]),
    ).toEqual(ALLOWED_LIFETIME_WRITERS);
  });

  test('A2: exactly the known MIGRATIONS write them', () => {
    // The DB is a first-class writer here — two triggers and a backfill — so a
    // migration adding a third trigger would be invisible to any TypeScript-only
    // scan. Every original formulation of this guard had that hole.
    expect(findMigrationLifetimeWriters(load(MIGRATIONS, (p) => p.endsWith('.sql')))).toEqual(
      [...ALLOWED_MIGRATION_WRITERS].sort(),
    );
  });

  test('A4: observeExtension is the only producer of an ObservedExtension', () => {
    expect(findProofForgers(excludeGuardSelf(load(API_SRC, ANY_TS)))).toEqual(
      ALLOWED_PROOF_PRODUCERS,
    );
  });

  test('A7: deadline.ts has a frozen import allowlist', () => {
    // The crispest boundary available: this module cannot reach a request body,
    // a provider adapter, a sandbox response or a clock, because it cannot
    // import anything that produces one.
    const source = readFileSync(resolve(import.meta.dir, 'deadline.ts'), 'utf8');
    expect(importsOf(source)).toEqual([...DEADLINE_IMPORT_ALLOWLIST].sort());
  });

  test('A8: no replaced mechanism leaks into the lifetime module', () => {
    // The lease, the busy probe (which classifies `retry` as busy), the idle
    // countdown (a real timestamp on ZERO of 284 prod rows) and the uncapped
    // hard-stop ceiling. They still exist elsewhere; the kill decision must
    // stop depending on them.
    expect(findBannedMechanismUsage(excludeGuardSelf(load(import.meta.dir, ANY_TS)))).toEqual([]);
  });
});

describe('layer 2 — the same scanners, PROVED BY VIOLATING THEM', () => {
  test('a drizzle .set() that assigns deadlineAt is caught', () => {
    expect(
      writesLifetimeColumns({
        path: 'projects/routes/some-future-route.ts',
        source: `
          await db.update(sessionSandboxes)
            .set({ deadlineAt: new Date(Date.now() + 86_400_000) })
            .where(eq(sessionSandboxes.sandboxId, id));
        `,
      }),
    ).toBe(true);
  });

  test('a raw SQL UPDATE that assigns deadline_at is caught', () => {
    expect(
      writesLifetimeColumns({
        path: 'projects/reaping/some-future-sweep.ts',
        source: 'await db.execute(sql`UPDATE kortix.session_sandboxes SET deadline_at = now()`);',
      }),
    ).toBe(true);
  });

  test('a writer that slides the ANCHOR forward is caught too', () => {
    // The specific bypass every reviewer found: the CHECK constrains a
    // DIFFERENCE, so moving `active_since` is worth exactly as much as moving
    // the deadline. The DB trigger makes it impossible; this makes it VISIBLE.
    expect(
      writesLifetimeColumns({
        path: 'projects/routes/some-future-route.ts',
        source: 'await db.update(sessionSandboxes).set({ activeSince: new Date() });',
      }),
    ).toBe(true);
  });

  test('the whole scan reports the violating file, not just the boolean', () => {
    const violation: SourceFile = {
      path: 'projects/routes/rogue.ts',
      source: 'await db.update(sessionSandboxes).set({ deadlineAt: farFuture });',
    };
    expect(findLifetimeColumnWriters([violation])).toEqual(['projects/routes/rogue.ts']);
    // …and therefore A1's assertion above would fail with that file present.
    expect(
      findLifetimeColumnWriters([...excludeGuardSelf(load(API_SRC, PRODUCTION_TS)), violation]),
    ).not.toEqual(ALLOWED_LIFETIME_WRITERS);
  });

  test('a new migration touching the columns is caught', () => {
    expect(
      findMigrationLifetimeWriters([
        {
          path: '20260801000000000_rogue_trigger.sql',
          source:
            "CREATE FUNCTION f() RETURNS trigger AS $$ BEGIN UPDATE kortix.session_sandboxes SET deadline_at = now() + interval '7 days'; END; $$;",
        },
      ]),
    ).toEqual(['20260801000000000_rogue_trigger.sql']);
  });

  test('a forged proof is caught', () => {
    expect(
      findProofForgers([
        {
          path: 'projects/routes/rogue.ts',
          source:
            'await extendDeadline({ sandboxId }, ms, { at: new Date(body.turnStartedAt) } as ObservedExtension);',
        },
      ]),
    ).toEqual(['projects/routes/rogue.ts']);
  });

  test('a banned mechanism is caught', () => {
    expect(
      findBannedMechanismUsage([
        { path: 'x.ts', source: 'if (await hasActiveExecutionLease(row)) return;' },
      ]),
    ).toEqual(['x.ts']);
  });

  test('EXPLAINING the rules in prose does not trip them', () => {
    // The reason every scanner strips comments first. Without this, the fix an
    // annoyed engineer reaches for is deleting the explanation — and then the
    // next person has the rule with no reason attached, which is how a rule
    // gets removed.
    expect(
      writesLifetimeColumns({
        path: 'docs.ts',
        source: '// never UPDATE deadline_at outside deadline.ts\n/* nor active_since */\n',
      }),
    ).toBe(false);
    expect(
      findProofForgers([{ path: 'd.ts', source: '// do not write `as ObservedExtension`' }]),
    ).toEqual([]);
    expect(
      findBannedMechanismUsage([{ path: 'd.ts', source: '// the old lastTurnAt clock' }]),
    ).toEqual([]);
  });

  test('a SELECT of the columns is NOT a write — the scanner is not just a mention check', () => {
    // shadow-queries.ts must stay legal, or the guard is unusable and gets
    // turned off.
    expect(
      writesLifetimeColumns({
        path: 'projects/lifetime/shadow-queries.ts',
        source: 'sql`SELECT deadline_at, active_since FROM kortix.session_sandboxes`',
      }),
    ).toBe(false);
  });
});

/**
 * LAYER 1 — THE BRANDED PROOF TYPE, proved by violating it.
 *
 * Every statement below is a compile error TODAY. `@ts-expect-error` inverts
 * that: if the guard ever weakens so the call becomes legal, the directive
 * itself becomes an error ("Unused '@ts-expect-error' directive") and
 * `tsc --noEmit` FAILS — loudly, in CI, on the commit that broke it.
 *
 * This function is never called. Its entire job is to be type-checked.
 */
async function typeLevelGuardMustReject(): Promise<void> {
  const { extendDeadline, anchorDeadline } = await import('./deadline');
  const body = { turnStartedAt: '2026-07-29T00:00:00Z' };

  // THE MISTAKE THIS FEATURE EXISTS TO PREVENT: a timestamp the SANDBOX
  // authored, parsed out of a request body, used to extend that sandbox's life.
  // @ts-expect-error a Date is not an ObservedExtension
  await extendDeadline({ sandboxId: 'box' }, 1000, new Date(body.turnStartedAt));

  // The same mistake with a plain object literal — the brand is a unique symbol
  // that nothing outside observation.ts can name, so structural typing does not
  // rescue it.
  // @ts-expect-error { at } is not branded
  await extendDeadline({ sandboxId: 'box' }, 1000, { at: new Date() });

  // Passing the REFUSAL through. `observeExtension` returns null for a
  // self-authored request; the proof parameter is non-nullable precisely so a
  // call site cannot let that null mean "extend anyway".
  const { observeExtension } = await import('./observation');
  const maybe = observeExtension({ principalSessionId: 'a', recordSessionId: 'a' });
  // @ts-expect-error ObservedExtension | null is not assignable to ObservedExtension
  await extendDeadline({ sandboxId: 'box' }, 1000, maybe);

  // Anchoring needs a proof too, so a caller cannot mint a fresh 24h window
  // without one.
  // @ts-expect-error missing the proof argument
  await anchorDeadline('box', 1000);
}

test('layer 1: the proof type rejects every sandbox-authored extension', () => {
  // The real assertion is `tsc --noEmit`, which type-checks the function above
  // and fails if ANY of those calls becomes legal. This case exists so the
  // guard is discoverable from the test list rather than only from a comment.
  expect(typeof typeLevelGuardMustReject).toBe('function');
});
