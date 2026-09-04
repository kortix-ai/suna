#!/usr/bin/env bun
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(import.meta.dir, '..', 'migrations');
const GRANDFATHER_FILE = join(import.meta.dir, '..', 'grandfathered-migrations.json');
const BACKFILL_GRANDFATHER_FILE = join(
  import.meta.dir,
  '..',
  'backfill-grandfathered-migrations.json',
);
const CONCURRENT_LOCK_TIMEOUT_GRANDFATHER_FILE = join(
  import.meta.dir,
  '..',
  'concurrent-lock-timeout-grandfathered-migrations.json',
);
// Three valid migration file shapes:
//  - <ts>_<slug>.sql            hand-written or drizzle-generated, runs inside
//                                the batch transaction (see MIGRATIONS.md).
//  - <ts>_<slug>.concurrent.ts  the CONCURRENTLY escape hatch: a node-pg-migrate
//                                JS/TS migration that calls `pgm.noTransaction()`
//                                so `CREATE/DROP INDEX CONCURRENTLY` can run.
//                                Naming is deliberately distinct from a bare
//                                `.ts` so it can never be mistaken for a
//                                stray tooling file. See scripts/create-migration.ts.
//  - <ts>_<slug>.nontransaction.ts  a constrained expand/validate/contract
//                                sequence whose statements must commit
//                                separately to release DDL locks.
const SQL_NAME_RE = /^\d{17}_[A-Za-z0-9][A-Za-z0-9_-]*\.sql$/;
const CONCURRENT_NAME_RE = /^\d{17}_[A-Za-z0-9][A-Za-z0-9_-]*\.concurrent\.ts$/;
const NONTRANSACTION_NAME_RE = /^\d{17}_[A-Za-z0-9][A-Za-z0-9_-]*\.nontransaction\.ts$/;
const TS_RE = /^(\d{17})_/;
const DOWN_MARKER = /^\s*--[\s-]*down\s+migration/im;

// The mixed-version guard: any of these operations can 500 an old, still-running
// app version mid-rollout (the exact class of the 20260713220001000 incident,
// where dropping a unique index broke old code's ON CONFLICT upsert). Requires
// a `-- mixed-version-safe: <justification>` comment ANYWHERE in the file
// acknowledging the old-code-still-running window was considered.
const MIXED_VERSION_TRIGGERS: { re: RegExp; what: string }[] = [
  { re: /\bdrop\s+table\b/i, what: 'DROP TABLE' },
  { re: /\balter\s+table\b[\s\S]*?\bdrop\s+column\b/i, what: 'DROP COLUMN' },
  { re: /\balter\s+table\b[\s\S]*?\bdrop\s+constraint\b/i, what: 'DROP CONSTRAINT' },
  { re: /\bdrop\s+index\b/i, what: 'DROP INDEX' },
  { re: /\balter\s+table\b[\s\S]*?\brename\s+(column|to)\b/i, what: 'RENAME' },
  {
    re: /\balter\s+table\b[\s\S]*?\balter\s+column\b[\s\S]*?\btype\b/i,
    what: 'ALTER COLUMN ... TYPE',
  },
  { re: /\balter\s+table\b[\s\S]*?\bdrop\s+not\s+null\b/i, what: 'DROP NOT NULL' },
  { re: /\balter\s+type\b[\s\S]*?\brename\s+value\b/i, what: 'ALTER TYPE ... RENAME VALUE' },
];
// Accepts either SQL-style (`--`) or JS/TS-style (`//`) comments, since
// .concurrent.ts migrations can trigger these same checks.
const MIXED_VERSION_ANNOTATION_RE = /(?:--|\/\/)\s*mixed-version-safe\s*:\s*\S/i;

// Enum-value additions are the class of the prod sandbox_provider drift
// incident: a faked/rebaselined environment can silently SKIP an
// `ALTER TYPE ... ADD VALUE`, so code that later writes the new value 500s
// with 22P02 on that one environment only. Require an explicit
// acknowledgement comment rather than relying on memory.
const ENUM_ADD_VALUE_RE = /\balter\s+type\b[\s\S]*?\badd\s+value\b/i;
const ENUM_ANNOTATION_RE = /(?:--|\/\/)\s*enum-value-checked\s*:\s*\S/i;

// `pgm.noTransaction()` exists for TWO reasons, not one. The first is
// CONCURRENTLY, which cannot run inside a transaction. The second is the
// remedy MIGRATIONS.md prescribes for the 2026-08-10 centralized_audit_v2
// outage: "write data moves as batched, incrementally-committed .concurrent.ts
// passes" — a batch only commits, and only releases its row locks, because the
// file opted out of the wrapping transaction. Such a file legitimately contains
// no CONCURRENTLY statement, so it declares itself with
// `// batched-dml: <what is batched, batch size, bound on row count>` instead.
const BATCHED_DML_ANNOTATION_RE = /(?:--|\/\/)\s*batched-dml\s*:\s*\S/i;
const CONSTRAINT_TRANSITION_ANNOTATION_RE = /(?:--|\/\/)\s*constraint-transition\s*:\s*\S/i;

// CREATE INDEX CONCURRENTLY cannot land on a live database under the 2-5s
// `lock_timeout` a plain .sql migration uses. CIC has to wait for EVERY
// transaction that began before it (a ShareLock on each one's virtual
// transaction id), both before it starts and before it finishes, and
// `lock_timeout` governs that wait — table size is irrelevant. On prod, where
// audit_events takes a write on nearly every request and session turns run for
// seconds, some transaction outlives a 5s budget almost every time: the build
// is cancelled with 55P03 and leaves an INVALID index that makes a plain re-run
// fail with "already exists".
//
// The house 2-5s value exists to stop DDL blocking prod. It does not apply
// here: the only lock a CIC holds (ShareUpdateExclusive on the table) excludes
// other DDL and VACUUM, never queries or writes, so a long wait blocks no user.
//
// Incident: v0.13.0 deploy-prod run 32248002434 failed its migration job TWICE
// on `.concurrent` migrations that set `lock_timeout = '5s'` — once on a
// 6-row/80 kB table, which is what proved size was not the variable.
const MIN_CONCURRENT_LOCK_TIMEOUT_MS = 120_000;
const LOCK_TIMEOUT_RE = /\bset\s+lock_timeout\s*(?:=|\s+to\s+)\s*(?:'([^']*)'|([A-Za-z0-9]+))/gi;

/**
 * Postgres duration -> milliseconds. A bare number is milliseconds; `0` (in any
 * unit) disables the timeout entirely, which is the SAFEST setting for a CIC.
 * Returns null for anything unrecognized, which the caller reports rather than
 * silently passing.
 */
export function parseLockTimeoutMs(raw: string): number | null {
  const match = /^(\d+)\s*(us|ms|s|min|h|d)?$/.exec(raw.trim().toLowerCase());
  if (!match) return null;
  const value = Number.parseInt(match[1], 10);
  if (!Number.isFinite(value)) return null;
  if (value === 0) return Number.POSITIVE_INFINITY;
  switch (match[2]) {
    case 'us':
      return value / 1000;
    case undefined:
    case 'ms':
      return value;
    case 's':
      return value * 1000;
    case 'min':
      return value * 60_000;
    case 'h':
      return value * 3_600_000;
    case 'd':
      return value * 86_400_000;
    default:
      return null;
  }
}

export interface LintResult {
  errors: string[];
  warnings: string[];
}

// Set-level invariant: every migration's 17-digit timestamp must be unique.
// (Ordering within a checkout is the sorted filename order; "a new migration
// must come AFTER every merged one" is enforced by the git-aware sequence gate
// in db-migrations.yml, which a single checkout can't see.)
export function lintMigrationSet(filenames: string[]): string[] {
  const errors: string[] = [];
  const seen = new Map<string, string>();
  for (const f of filenames) {
    const ts = TS_RE.exec(f)?.[1];
    if (!ts) continue;
    const dup = seen.get(ts);
    if (dup) {
      errors.push(
        `${f}: duplicate migration timestamp ${ts} (also ${dup}). Each migration needs a unique timestamp — regenerate with \`pnpm migrate:create\`.`,
      );
    } else {
      seen.set(ts, f);
    }
  }
  return errors;
}

function stripComments(text: string): string {
  return text
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return t !== '' && !t.startsWith('--') && !t.startsWith('//');
    })
    .join('\n')
    .trim();
}

/**
 * Shared between .sql and .concurrent.ts migrations: the mixed-version guard
 * (20260713220001000 class) and the enum-value-addition guard (sandbox_provider
 * "platinum" drift class). `scanText` is what we search for the DDL trigger
 * patterns (comments stripped, so a DROP mentioned only in a comment doesn't
 * false-positive); `annotationText` is the ORIGINAL text (comments kept) we
 * search for the sign-off annotation.
 */
function checkMixedVersionAndEnum(
  filename: string,
  scanText: string,
  annotationText: string,
  grandfathered: boolean,
): string[] {
  if (grandfathered) return [];
  const errors: string[] = [];

  const mixedVersionHit = MIXED_VERSION_TRIGGERS.find((t) => t.re.test(scanText));
  if (mixedVersionHit && !MIXED_VERSION_ANNOTATION_RE.test(annotationText)) {
    errors.push(
      `${filename}: contains ${mixedVersionHit.what}, which can break an OLD app version still running against the NEW schema during a mixed-version deploy window (this is exactly what broke prod in 20260713220001000 — a dropped unique index + old code's ON CONFLICT upsert). ` +
        'Add a `-- mixed-version-safe: <why old code tolerates this, or why it cannot still be running>` comment (`//` in a .concurrent.ts file), or split this into expand/contract migrations (see MIGRATIONS.md).',
    );
  }

  if (ENUM_ADD_VALUE_RE.test(scanText) && !ENUM_ANNOTATION_RE.test(annotationText)) {
    errors.push(
      `${filename}: contains ALTER TYPE ... ADD VALUE. A faked/rebaselined environment (\`migrate:fake\`) can silently skip an enum value addition if it wasn't part of the baseline it was faked from — this is exactly the prod sandbox_provider "platinum" 22P02 incident. ` +
        'Add a `-- enum-value-checked: <how you verified every env — including any faked baseline — actually has this value>` comment (`//` in a .concurrent.ts file).',
    );
  }

  return errors;
}

/**
 * The CIC lock_timeout floor.
 *
 * Applies ONLY to files that actually run a CONCURRENTLY operation. A
 * .concurrent.ts that exists for a batched DML pass (`// batched-dml:`) holds
 * ROW locks, so a long lock_timeout there really would queue writers behind it
 * — the short house value is correct for that file, and the CIC rationale is
 * exactly inverted.
 */
function checkConcurrentLockTimeout(
  filename: string,
  scanText: string,
  grandfathered: boolean,
): string[] {
  if (grandfathered) return [];
  if (!/\bconcurrently\b/i.test(scanText)) return [];

  const errors: string[] = [];
  for (const match of scanText.matchAll(LOCK_TIMEOUT_RE)) {
    const literal = (match[1] ?? match[2] ?? '').trim();
    const ms = parseLockTimeoutMs(literal);

    if (ms === null) {
      errors.push(
        `${filename}: sets lock_timeout to an unrecognized value ('${literal}'). Use a plain Postgres duration (e.g. '180s' or '3min') so the CONCURRENTLY floor can be checked.`,
      );
      continue;
    }
    if (ms < MIN_CONCURRENT_LOCK_TIMEOUT_MS) {
      errors.push(
        `${filename}: sets lock_timeout = '${literal}' in a CONCURRENTLY migration, below the ${MIN_CONCURRENT_LOCK_TIMEOUT_MS / 1000}s floor. ` +
          'CREATE/DROP INDEX CONCURRENTLY must wait for every transaction that began before it, and lock_timeout governs that wait — on live prod some transaction outlives a short budget almost every time, whatever the table size, so the build is cancelled with 55P03 and leaves an INVALID index behind (v0.13.0 deploy-prod run 32248002434, which failed this way on a 6-row table). ' +
          "The short house value guards DDL that blocks queries; a CONCURRENTLY build holds only ShareUpdateExclusive and blocks no user. Use `set lock_timeout = '180s'` (what `pnpm migrate:create <slug> --concurrent` now scaffolds), or '0' to wait indefinitely.",
      );
    }
  }
  return errors;
}

function lintConcurrentMigration(
  filename: string,
  raw: string,
  grandfathered: boolean,
  lockTimeoutGrandfathered: boolean,
): LintResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (/^(<{7}|={7}|>{7})/m.test(raw)) {
    errors.push(
      `${filename}: contains an unresolved merge-conflict marker (<<<<<<< / ======= / >>>>>>>).`,
    );
  }
  if (raw.trim().length === 0) {
    errors.push(`${filename}: empty file.`);
    return { errors, warnings };
  }
  if (!/\bpgm\s*\.\s*noTransaction\s*\(\s*\)/.test(raw)) {
    errors.push(
      `${filename}: a .concurrent.ts migration must call \`pgm.noTransaction()\` — that's the entire reason this file isn't plain SQL. If this migration doesn't need CONCURRENTLY, write it as a normal .sql migration instead.`,
    );
  }
  if (!/\bconcurrently\b/i.test(raw) && !BATCHED_DML_ANNOTATION_RE.test(raw)) {
    errors.push(
      `${filename}: a .concurrent.ts migration must either contain a CONCURRENTLY operation (CREATE/DROP INDEX CONCURRENTLY, REINDEX CONCURRENTLY, ALTER TABLE ... DETACH PARTITION CONCURRENTLY) or declare a batched data pass with \`// batched-dml: <what is batched, batch size, bound on row count>\`. Opting out of the wrapping transaction loses the all-or-nothing guarantee — don't use this escape hatch for anything else.`,
    );
  }
  if (!/\bexport\s+const\s+up\b|\bexport\s+function\s+up\b/.test(raw)) {
    errors.push(`${filename}: missing \`export const up = (pgm) => { ... }\`.`);
  }
  if (/TODO/.test(raw)) {
    errors.push(
      `${filename}: has a leftover TODO placeholder from the scaffold — fill in the real table/index/column names.`,
    );
  }

  // The subtle footgun: a single pgm.sql(`...; ...;`) call with MULTIPLE
  // statements is sent to Postgres as one simple-query string, which Postgres
  // itself wraps in an IMPLICIT transaction — silently defeating
  // pgm.noTransaction() (CONCURRENTLY fails with the same "cannot run inside
  // a transaction block" error, even though noTransaction() worked correctly
  // at the node-pg-migrate level). Every pgm.sql() call in this file must be
  // a single statement.
  const sqlCallRe = /pgm\s*\.\s*sql\s*\(\s*`([^`]*)`\s*\)/gs;
  for (const m of raw.matchAll(sqlCallRe)) {
    const body = m[1] ?? '';
    const statements = stripComments(body)
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);
    if (statements.length > 1) {
      errors.push(
        `${filename}: a single pgm.sql() call has ${statements.length} statements. Postgres's simple query protocol wraps a multi-statement string in an IMPLICIT transaction, which breaks CONCURRENTLY even though pgm.noTransaction() ran. Use one pgm.sql() call per statement.`,
      );
    }
  }

  errors.push(...checkMixedVersionAndEnum(filename, stripComments(raw), raw, grandfathered));
  errors.push(
    ...checkConcurrentLockTimeout(filename, stripComments(raw), lockTimeoutGrandfathered),
  );

  return { errors, warnings };
}

function lintNontransactionMigration(
  filename: string,
  raw: string,
  grandfathered: boolean,
): LintResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (/^(<{7}|={7}|>{7})/m.test(raw)) {
    errors.push(
      `${filename}: contains an unresolved merge-conflict marker (<<<<<<< / ======= / >>>>>>>).`,
    );
  }
  if (raw.trim().length === 0) {
    errors.push(`${filename}: empty file.`);
    return { errors, warnings };
  }
  if (!/\bpgm\s*\.\s*noTransaction\s*\(\s*\)/.test(raw)) {
    errors.push(
      `${filename}: a .nontransaction.ts migration must call \`pgm.noTransaction()\` so each pgm.sql() statement commits separately.`,
    );
  }
  if (!CONSTRAINT_TRANSITION_ANNOTATION_RE.test(raw)) {
    errors.push(
      `${filename}: a .nontransaction.ts migration must declare \`// constraint-transition: <why each statement must commit separately>\`.`,
    );
  }
  if (!/\bexport\s+const\s+up\b|\bexport\s+function\s+up\b/.test(raw)) {
    errors.push(`${filename}: missing \`export const up = (pgm) => { ... }\`.`);
  }
  if (!/\bexport\s+const\s+down\s*=\s*false\b/.test(raw)) {
    errors.push(
      `${filename}: a constraint transition must be roll-forward only (\`export const down = false\`).`,
    );
  }
  if (/TODO/.test(raw)) {
    errors.push(
      `${filename}: has a leftover TODO placeholder from the scaffold — fill in the constraint names and compatibility rationale.`,
    );
  }

  const sqlCallRe = /pgm\s*\.\s*sql\s*\(\s*`([^`]*)`\s*\)/gs;
  const statements: string[] = [];
  for (const match of raw.matchAll(sqlCallRe)) {
    const body = match[1] ?? '';
    const parts = stripComments(body)
      .replace(/\$[a-zA-Z_]*\$[\s\S]*?\$[a-zA-Z_]*\$/g, "'body'")
      .split(';')
      .map((statement) => statement.trim())
      .filter(Boolean);
    if (parts.length !== 1) {
      errors.push(
        `${filename}: every pgm.sql() call must contain exactly one statement so node-pg-migrate can commit it independently.`,
      );
    }
    if (parts.length === 1) statements.push(stripComments(body));
  }

  const addIndex = statements.findIndex((statement) =>
    /\balter\s+table\b[\s\S]*?\badd\s+constraint\b[\s\S]*?\bnot\s+valid\b/i.test(statement),
  );
  const validateIndex = statements.findIndex((statement) =>
    /\balter\s+table\b[\s\S]*?\bvalidate\s+constraint\b/i.test(statement),
  );
  const dropIndex = statements.findIndex((statement) =>
    /\balter\s+table\b[\s\S]*?\bdrop\s+constraint\b/i.test(statement),
  );
  if (addIndex === -1 || validateIndex === -1 || validateIndex <= addIndex) {
    errors.push(
      `${filename}: a constraint transition must ADD ... NOT VALID before it VALIDATEs the replacement constraint.`,
    );
  }
  if (dropIndex !== -1 && (validateIndex === -1 || dropIndex <= validateIndex)) {
    errors.push(
      `${filename}: a constraint transition must VALIDATE the replacement before it DROPs the old constraint.`,
    );
  }
  const allowedStatement = (statement: string) =>
    /\bset\s+(?:local\s+)?(?:lock_timeout|statement_timeout)\b/i.test(statement) ||
    /\balter\s+table\b[\s\S]*?\badd\s+constraint\b[\s\S]*?\bnot\s+valid\b/i.test(statement) ||
    /\balter\s+table\b[\s\S]*?\bvalidate\s+constraint\b/i.test(statement) ||
    /\balter\s+table\b[\s\S]*?\bdrop\s+constraint\b/i.test(statement);
  if (statements.length === 0 || statements.some((statement) => !allowedStatement(statement))) {
    errors.push(
      `${filename}: .nontransaction.ts only permits timeout settings and an ADD NOT VALID → VALIDATE → optional DROP constraint transition.`,
    );
  }

  errors.push(...checkMixedVersionAndEnum(filename, stripComments(raw), raw, grandfathered));
  return { errors, warnings };
}

export interface LintOptions {
  /**
   * Pre-existing migrations (see grandfathered-migrations.json) are exempt
   * from checks introduced AFTER they landed — they're immutable, and we
   * don't rewrite history to retrofit a policy that didn't exist yet. Every
   * new migration (anything not in the list) gets full enforcement.
   */
  grandfathered?: boolean;
  /**
   * Same contract, separate cutoff: migrations that existed before the
   * backfill-DML guard landed (2026-08-10, centralized_audit_v2 outage) —
   * see backfill-grandfathered-migrations.json.
   */
  backfillGrandfathered?: boolean;
  /**
   * Same contract, separate cutoff: .concurrent.ts migrations that existed
   * before the CONCURRENTLY lock_timeout floor landed (2026-08-19, v0.13.0
   * deploy-prod run 32248002434) — see
   * concurrent-lock-timeout-grandfathered-migrations.json. They are immutable
   * and already applied; the floor governs every new one.
   */
  concurrentLockTimeoutGrandfathered?: boolean;
}

export function lintMigration(
  filename: string,
  raw: string,
  options: LintOptions = {},
): LintResult {
  if (CONCURRENT_NAME_RE.test(filename)) {
    return lintConcurrentMigration(
      filename,
      raw,
      options.grandfathered ?? false,
      options.concurrentLockTimeoutGrandfathered ?? false,
    );
  }
  if (NONTRANSACTION_NAME_RE.test(filename)) {
    return lintNontransactionMigration(filename, raw, options.grandfathered ?? false);
  }

  const errors: string[] = [];
  const warnings: string[] = [];

  if (!SQL_NAME_RE.test(filename)) {
    errors.push(
      `${filename}: invalid filename. Must be <17-digit-UTC-timestamp>_<slug>.sql, _<slug>.concurrent.ts, or _<slug>.nontransaction.ts — use \`pnpm migrate:create <slug>\` or \`pnpm migrate:generate <slug>\`. A bad prefix makes node-pg-migrate mis-order or skip the migration.`,
    );
  }

  if (/^(<{7}|={7}|>{7})/m.test(raw)) {
    errors.push(
      `${filename}: contains an unresolved merge-conflict marker (<<<<<<< / ======= / >>>>>>>).`,
    );
  }

  if (stripComments(raw).length === 0) {
    errors.push(
      `${filename}: contains no SQL (empty, or only comments / an unfilled template). Write the migration or delete the file.`,
    );
  }

  const hasPlaceholder = raw
    .split('\n')
    .some((l) => l.trim().startsWith('--') && /\b(TODO|FIXME|XXX)\b/i.test(l));
  if (hasPlaceholder) {
    errors.push(
      `${filename}: has a leftover TODO/FIXME/XXX placeholder. Finish the migration before committing.`,
    );
  }

  // Destructive/data checks consider only the UP portion — a Down Migration
  // section is expected to be destructive (it reverses the up). Keep the
  // COMMENTS in `up` (not `upStripped`) so annotation comments are visible to
  // the mixed-version / enum checks below.
  const up = raw.split(DOWN_MARKER)[0] ?? raw;
  const upStripped = stripComments(up);

  if (/\b(drop\s+table|drop\s+column|truncate\b|drop\s+not\s+null)\b/i.test(upStripped)) {
    warnings.push(
      `${filename}: destructive operation (DROP/TRUNCATE). Confirm the code reference was removed in a PRIOR deploy (expand→contract — see MIGRATIONS.md).`,
    );
  }
  if (
    /\bdelete\s+from\b/i.test(upStripped) &&
    !/\bdelete\s+from\b[\s\S]*?\bwhere\b/i.test(upStripped)
  ) {
    warnings.push(`${filename}: DELETE without a WHERE clause wipes the whole table. Intentional?`);
  }

  // Structural, not a new policy — applies even to grandfathered files (none
  // currently trigger it; the whole corpus was checked). A plain .sql
  // migration runs inside the batch transaction (singleTransaction: true),
  // and CONCURRENTLY operations cannot run inside ANY transaction — this
  // would fail at `pnpm migrate` time with "cannot run inside a transaction
  // block", not at lint time, which is exactly the kind of failure this
  // linter exists to catch before it reaches a shared database.
  if (/\bconcurrently\b/i.test(upStripped)) {
    errors.push(
      `${filename}: uses CONCURRENTLY in a plain .sql migration. This file runs inside the batch transaction and CONCURRENTLY cannot run inside any transaction — it will fail at \`pnpm migrate\` time. Use \`pnpm migrate:create <slug> --concurrent\` instead (see MIGRATIONS.md "Roll-forward safety").`,
    );
  }

  // Backfill guard (2026-08-10 v0.12.7 prod outage). A plain .sql migration
  // runs in ONE transaction, so its ALTER TABLE statements hold ACCESS
  // EXCLUSIVE on the target table until COMMIT — and any top-level DML in the
  // same file turns those milliseconds of lock into the full backfill
  // duration. centralized_audit_v2 updated all 30.5M rows of the hottest
  // table this way and every audit-writing request hung for ~15 minutes.
  // Data moves belong in batched, incrementally-committed passes (a
  // .concurrent.ts noTransaction migration or an out-of-band runbook), or
  // must be explicitly signed off as bounded.
  if (!(options.grandfathered ?? false) && !(options.backfillGrandfathered ?? false)) {
    // Dollar-quoted function bodies may legitimately contain DML (triggers);
    // drizzle appends `--> statement-breakpoint` on the statement line itself,
    // so it survives the line-based comment strip and must go too.
    const upNoBodies = upStripped
      .replace(/\$[a-zA-Z_]*\$[\s\S]*?\$[a-zA-Z_]*\$/g, "'body'")
      .replace(/-->\s*statement-breakpoint/g, '');
    const dml = upNoBodies.match(
      /(?:^|;)\s*(UPDATE\s|DELETE\s+FROM\s|INSERT\s+INTO\s|MERGE\s+INTO\s|WITH\s)/i,
    );
    if (dml && !/(?:--|\/\/)\s*backfill-safe\s*:\s*\S/i.test(up)) {
      errors.push(
        `${filename}: top-level DML (${dml[1].trim().toUpperCase()}…) in a single-transaction .sql migration. The file's DDL holds ACCESS EXCLUSIVE until COMMIT, so this backfill blocks every writer on the table for its whole duration — this is exactly the 2026-08-10 centralized_audit_v2 prod outage. ` +
          'Move the data pass into a batched .concurrent.ts migration or an out-of-band runbook, or add a `-- backfill-safe: <table + bounded row count + why writers cannot queue behind it>` sign-off.',
      );
    }
  }

  // Mixed-version guard + enum-value guard (shared with .concurrent.ts — see
  // checkMixedVersionAndEnum). Exempt for pre-existing (grandfathered)
  // migrations — see grandfathered-migrations.json.
  errors.push(
    ...checkMixedVersionAndEnum(filename, upStripped, up, options.grandfathered ?? false),
  );

  return { errors, warnings };
}

function loadGrandfatherSet(): Set<string> {
  try {
    const data = JSON.parse(readFileSync(GRANDFATHER_FILE, 'utf8')) as { files: string[] };
    return new Set(data.files);
  } catch {
    return new Set();
  }
}

function loadBackfillGrandfatherSet(): Set<string> {
  try {
    const data = JSON.parse(readFileSync(BACKFILL_GRANDFATHER_FILE, 'utf8')) as { files: string[] };
    return new Set(data.files);
  } catch {
    return new Set();
  }
}

function loadConcurrentLockTimeoutGrandfatherSet(): Set<string> {
  try {
    const data = JSON.parse(readFileSync(CONCURRENT_LOCK_TIMEOUT_GRANDFATHER_FILE, 'utf8')) as {
      files: string[];
    };
    return new Set(data.files);
  } catch {
    return new Set();
  }
}

function main(): void {
  const errors: string[] = [];
  const warnings: string[] = [];
  const grandfathered = loadGrandfatherSet();
  const backfillGrandfathered = loadBackfillGrandfatherSet();
  const lockTimeoutGrandfathered = loadConcurrentLockTimeoutGrandfatherSet();
  const files = readdirSync(DIR)
    .filter(
      (f) => f.endsWith('.sql') || f.endsWith('.concurrent.ts') || f.endsWith('.nontransaction.ts'),
    )
    .sort();
  if (files.length === 0) errors.push('No migration files found in packages/db/migrations/.');

  for (const f of files) {
    const { errors: e, warnings: w } = lintMigration(f, readFileSync(join(DIR, f), 'utf8'), {
      grandfathered: grandfathered.has(f),
      backfillGrandfathered: backfillGrandfathered.has(f),
      concurrentLockTimeoutGrandfathered: lockTimeoutGrandfathered.has(f),
    });
    errors.push(...e);
    warnings.push(...w);
  }
  errors.push(...lintMigrationSet(files));

  for (const w of warnings) console.log(`::warning::${w}`);
  for (const e of errors) console.error(`::error::${e}`);

  if (errors.length > 0) {
    console.error(`\n✗ ${errors.length} migration lint error(s) — fix before merging.`);
    process.exit(1);
  }
  console.log(
    `✓ ${files.length} migration file(s) pass lint${warnings.length ? ` (${warnings.length} warning(s))` : ''}.`,
  );
}

if (import.meta.main) main();
