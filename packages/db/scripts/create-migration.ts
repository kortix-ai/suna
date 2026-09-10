#!/usr/bin/env bun
/**
 * Scaffold a new hand-written migration with the house-rules template baked
 * in (lock_timeout/statement_timeout header, expand/contract checklist,
 * mixed-version-safe annotation slot).
 *
 *   bun scripts/create-migration.ts <slug>                normal .sql migration
 *   bun scripts/create-migration.ts <slug> --concurrent    the CONCURRENTLY
 *                                                           escape hatch (.concurrent.ts)
 *   bun scripts/create-migration.ts <slug> --constraint-transition
 *                                                           ADD NOT VALID →
 *                                                           VALIDATE → DROP
 *                                                           (.nontransaction.ts)
 *
 * For schema-shape changes prefer `pnpm migrate:generate <slug>` (drizzle-kit
 * diffs kortix.ts) — this script is for RLS, functions, data backfills, and
 * the two cases drizzle-kit can't express: CONCURRENTLY operations and
 * anything else that must opt out of the wrapping transaction.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS_DIR = join(import.meta.dir, '..', 'migrations');

function utcStamp(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    d.getUTCFullYear().toString() +
    p(d.getUTCMonth() + 1) +
    p(d.getUTCDate()) +
    p(d.getUTCHours()) +
    p(d.getUTCMinutes()) +
    p(d.getUTCSeconds()) +
    p(d.getUTCMilliseconds(), 3)
  );
}

const args = process.argv.slice(2);
const concurrent = args.includes('--concurrent');
const constraintTransition = args.includes('--constraint-transition');
const slug = args.find((a) => !a.startsWith('--')) ?? '';

if (!/^[a-z0-9_]+$/.test(slug) || (concurrent && constraintTransition)) {
  console.error(
    'Usage: bun scripts/create-migration.ts <slug> [--concurrent | --constraint-transition]   (slug matches /^[a-z0-9_]+$/)',
  );
  process.exit(1);
}

const ts = utcStamp();

if (!existsSync(MIGRATIONS_DIR)) mkdirSync(MIGRATIONS_DIR, { recursive: true });

if (constraintTransition) {
  const target = join(MIGRATIONS_DIR, `${ts}_${slug}.nontransaction.ts`);
  writeFileSync(
    target,
    `// constraint-transition: TODO explain why ADD NOT VALID, VALIDATE, and DROP must commit separately
// mixed-version-safe: TODO explain why old code tolerates the constraint replacement

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  pgm.sql(\`set lock_timeout = '5s'\`);
  pgm.sql(\`set statement_timeout = '30min'\`);
  pgm.sql(\`
    alter table kortix.TODO_TABLE
      add constraint TODO_CONSTRAINT_V2 check (TODO_EXPRESSION) not valid
  \`);
  pgm.sql(\`
    alter table kortix.TODO_TABLE validate constraint TODO_CONSTRAINT_V2
  \`);
  pgm.sql(\`
    alter table kortix.TODO_TABLE drop constraint TODO_OLD_CONSTRAINT
  \`);
};

export const down = false;
`,
  );
  console.log(`Created: packages/db/migrations/${ts}_${slug}.nontransaction.ts`);
  console.log('Fill in the TODOs, then review with `pnpm --filter @kortix/db lint`.');
  process.exit(0);
}

if (concurrent) {
  const target = join(MIGRATIONS_DIR, `${ts}_${slug}.concurrent.ts`);
  writeFileSync(
    target,
    `// Migration: ${slug}  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
//
// This file exists ONLY because CREATE/DROP INDEX CONCURRENTLY (and a
// handful of other operations: REINDEX CONCURRENTLY, DETACH PARTITION
// CONCURRENTLY) cannot run inside a transaction -- and every plain .sql
// migration in this repo runs inside the single batch transaction
// node-pg-migrate wraps around \`pnpm migrate\` (singleTransaction: true,
// see packages/db/scripts/migrate.ts). \`pgm.noTransaction()\` is
// node-pg-migrate's own supported opt-out: when it hits a migration that
// called this, it COMMITs the outer transaction, runs THIS migration
// standalone (no transaction), then re-opens BEGIN for whatever runs after
// it in the same batch. See MIGRATIONS.md "Roll-forward safety".
//
// Rules for this file:
//   - ONE concurrent operation. Don't smuggle other DDL in here -- you lose
//     the all-or-nothing guarantee the moment you opt out of the transaction.
//   - Always use IF NOT EXISTS / IF EXISTS -- a CONCURRENTLY build can fail
//     partway through and leave an INVALID index; the migration must be safe
//     to re-run (check pg_index.indisvalid before retrying by hand if it does).
//   - lock_timeout MUST be generous here -- 180s below, never the 2-5s used by
//     a plain .sql migration. CREATE INDEX CONCURRENTLY does not just take a
//     brief lock at the end: before it can start, and again before it can
//     finish, it waits for EVERY transaction in the database that began before
//     it (it takes a ShareLock on each one's virtual transaction id), and
//     \`lock_timeout\` governs that wait. On a live system -- audit_events
//     writers on every request, multi-second session-turn transactions -- some
//     transaction outlives a 5-second budget almost every time, so the build is
//     cancelled with 55P03 and leaves an INVALID index behind, which then makes
//     a plain re-run fail with "already exists". The 2-5s house value exists to
//     stop DDL blocking prod; the one lock a CONCURRENTLY build holds
//     (ShareUpdateExclusive on the table) only excludes other DDL and VACUUM,
//     so a long wait here blocks no user and that rationale does not apply.
//     This is lint-enforced: a new .concurrent.ts file that sets lock_timeout
//     below 120s fails \`pnpm --filter @kortix/db lint\`.
//   - statement_timeout should be generous (index builds on large tables can
//     legitimately run long) -- 30min below.
//   - This is lint-enforced: packages/db/scripts/lint-migrations.ts requires
//     pgm.noTransaction() AND a CONCURRENTLY operation in every .concurrent.ts
//     file, or CI fails.
//   - DROPPING an index/constraint here (not just creating one) is ALSO
//     covered by the mixed-version guard, same as a plain .sql migration --
//     add \`// mixed-version-safe: <justification>\` above \`up\` if this drops
//     something old code might still read (see MIGRATIONS.md).

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  // IMPORTANT: separate pgm.sql() calls, NOT one multi-statement string.
  // Postgres's simple query protocol treats a single query string containing
  // multiple ;-separated statements as an IMPLICIT transaction block -- which
  // silently defeats pgm.noTransaction() (CONCURRENTLY still fails with
  // "cannot run inside a transaction block") even though noTransaction() IS
  // working correctly at the node-pg-migrate level. One statement per call.
  pgm.sql(\`set lock_timeout = '180s'\`);
  pgm.sql(\`set statement_timeout = '30min'\`);
  pgm.sql(\`
    create index concurrently if not exists idx_TODO_ON_TODO_TABLE
      on kortix.TODO_TABLE (TODO_COLUMN)
  \`);
};

// Most CONCURRENTLY migrations are one-way in practice (see MIGRATIONS.md --
// "Down Migration" sections are policy-optional and this repo doesn't write
// them). Flip this to a real down function only if you have a tested reason to.
export const down = false;
`,
  );
  console.log(`Created: packages/db/migrations/${ts}_${slug}.concurrent.ts`);
  console.log('Fill in the TODOs, then review with `pnpm --filter @kortix/db lint`.');
  process.exit(0);
}

const target = join(MIGRATIONS_DIR, `${ts}_${slug}.sql`);
writeFileSync(
  target,
  `-- Migration: ${slug}
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- Tune these down further for large/hot tables; raise statement_timeout only
-- for an operation you've deliberately reasoned about (e.g. a NOT VALID
-- constraint's later VALIDATE, or a batched backfill with its own paging).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Expand/contract checklist -- delete lines that don't apply, keep the rest honest:
--   [ ] New/renamed column is nullable OR has a DEFAULT (no bare NOT NULL on an
--       existing populated table without a prior backfill migration).
--   [ ] New index: use \`pnpm migrate:create ${slug}_index --concurrent\`
--       instead of a plain CREATE INDEX in this file -- see the .concurrent.ts
--       escape hatch. A plain CREATE INDEX on an existing table blocks writes
--       for the duration of the build.
--   [ ] Adding a FK or a new constraint on an existing table: add it NOT VALID,
--       VALIDATE CONSTRAINT in a follow-up migration (constraint-missing-not-valid).
--   [ ] Dropping/renaming a column, table, constraint, unique index, or enum
--       value: confirm every code path that reads or writes it was removed in
--       a PRIOR deploy that is ALREADY LIVE (expand -> contract, never both in
--       one migration). If old code MIGHT still be running when this deploys,
--       add the line below (this is enforced -- CI fails without it on any
--       DROP/RENAME/ALTER ... TYPE/DROP NOT NULL):
-- mixed-version-safe: <why old code tolerates this change, or why it cannot still be running>
--   [ ] Adding an enum value (ALTER TYPE ... ADD VALUE): a faked/rebaselined
--       environment can silently skip it (see the prod sandbox_provider
--       "platinum" 22P02 incident) -- this is enforced, add:
-- enum-value-checked: <how you verified every env, including any faked baseline, has this value>

-- Write your SQL below.
`,
);
console.log(`Created: packages/db/migrations/${ts}_${slug}.sql`);
console.log(
  "Fill it in, delete the checklist lines that don't apply, then review with `pnpm --filter @kortix/db lint`.",
);
