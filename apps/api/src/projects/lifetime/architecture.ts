/**
 * BOUNDED SANDBOX LIFETIME — LAYER 3 OF THE STRUCTURAL GUARD: the scanners.
 *
 * These are pure functions over `{ path, source }` pairs, NOT a test that walks
 * the disk inline, and that is deliberate. A guard you can only exercise by
 * being correct is a guard nobody has ever seen fire. Because these take their
 * input as data, `architecture.test.ts` runs each of them TWICE: once over the
 * real tree (which must be clean) and once over a synthetic file that VIOLATES
 * the rule (which must be caught). The second run is the only evidence that the
 * first one means anything.
 *
 * All scanning happens on COMMENT-STRIPPED source. Every one of these rules is
 * about what the code DOES; a file that explains the rule in prose — and the
 * files here all do — must not trip it, or the fix an annoyed engineer reaches
 * for is deleting the explanation.
 */

export interface SourceFile {
  /** Path relative to apps/api/src, with forward slashes. */
  path: string;
  source: string;
}

/** Strip block and line comments. Crude but sufficient: no rule below depends
 *  on a token that can legally appear inside a string containing `//`. */
export function stripComments(source: string): string {
  return source.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/\/\/.*$/gm, '');
}

const LIFETIME_COLUMN = /deadline_at|deadlineAt|active_since|activeSince/;

/**
 * Does this file contain a statement that could WRITE either lifetime column?
 *
 * Mentioning them is fine and unavoidable — the shadow reporter selects them,
 * DTOs name them, fixtures construct them. What must be confined to one module
 * is MUTATION, in either of the two forms this codebase can express it:
 *
 *   SQL      an UPDATE/INSERT statement in the same file as a column name
 *   Drizzle  a `.set({ ... deadlineAt / activeSince ... })`
 *
 * Deliberately over-broad rather than precise. A false positive costs one
 * reviewed line in the allowlist below; a false negative costs the invariant.
 */
export function writesLifetimeColumns(file: SourceFile): boolean {
  const code = stripComments(file.source);
  if (!LIFETIME_COLUMN.test(code)) return false;
  if (/\b(update|insert\s+into)\b/i.test(code) && /deadline_at|active_since/.test(code)) {
    return true;
  }
  return /\.set\s*\(\s*\{[\s\S]*?(deadlineAt|activeSince)\s*:/.test(code);
}

/**
 * THE ALLOWLIST. One entry, and adding a second is the point at which this test
 * fails and a human has to justify it in review.
 */
export const ALLOWED_LIFETIME_WRITERS = ['projects/lifetime/deadline.ts'];

export function findLifetimeColumnWriters(files: SourceFile[]): string[] {
  return files
    .filter(writesLifetimeColumns)
    .map((file) => file.path)
    .sort();
}

/**
 * The DB is a first-class writer in this design — two triggers and a backfill —
 * so a migration adding a THIRD trigger that touches these columns would be
 * invisible to any scan limited to TypeScript. Every original formulation of
 * this guard had that hole.
 */
export const ALLOWED_MIGRATION_WRITERS = [
  '20260730090000000_sandbox_deadline_columns.sql',
  '20260730090000002_backfill_sandbox_deadlines.sql',
  '20260730090000003_sandbox_deadline_check.sql',
  '20260730090000005_sandbox_anchor_guard.sql',
  '20260730090000006_usage_extends_sandbox_deadline.sql',
];
// NOT in that list, and correctly so: ...004_validate_sandbox_deadline_check
// names only the CONSTRAINT, never a column. The two-step NOT VALID → VALIDATE
// split means the promotion migration touches neither column, and pinning that
// is worth a line — if it ever starts naming one, something has changed.

/**
 * The guard's own two files. They are excluded from the scans below because
 * they DEFINE the rules: architecture.ts contains the banned identifiers as
 * regex literals and the column names as match text, and architecture.test.ts
 * contains synthetic violations as string fixtures. Without this the guard
 * flags itself, and the obvious "fix" is to weaken the patterns.
 *
 * Safe because neither file imports a database.
 */
export const GUARD_SELF = ['architecture.ts', 'architecture.test.ts'];

export function excludeGuardSelf(files: SourceFile[]): SourceFile[] {
  return files.filter((file) => !GUARD_SELF.some((name) => file.path.endsWith(name)));
}

/** SQL comments are `--` prefixed; the migrations are heavily commented. */
export function stripSqlComments(source: string): string {
  return source.replaceAll(/--.*$/gm, '');
}

export function findMigrationLifetimeWriters(files: SourceFile[]): string[] {
  return files
    .filter((file) => {
      const code = stripSqlComments(file.source);
      return /deadline_at|active_since/.test(code);
    })
    .map((file) => file.path)
    .sort();
}

/**
 * `observeExtension` / `observeControlPlaneEvent` must be the only producers of
 * an `ObservedExtension`. The brand makes the type unforgeable from outside
 * this module — unless someone writes `as ObservedExtension`, which is exactly
 * what this catches.
 */
export function findProofForgers(files: SourceFile[]): string[] {
  return files
    .filter((file) => /as\s+ObservedExtension/.test(stripComments(file.source)))
    .map((file) => file.path)
    .sort();
}

export const ALLOWED_PROOF_PRODUCERS = ['projects/lifetime/observation.ts'];

/**
 * `deadline.ts`'s FROZEN IMPORT ALLOWLIST — the crispest boundary available.
 *
 * The module cannot reach a request body, a provider adapter, a sandbox
 * response or a clock, because it cannot import anything that produces one. A
 * future engineer who wants to "just read the row first" has to add an import,
 * and adding an import fails CI.
 */
export const DEADLINE_IMPORT_ALLOWLIST = [
  '../../shared/db',
  './constants',
  './observation',
  'drizzle-orm',
];

export function importsOf(source: string): string[] {
  return [...stripComments(source).matchAll(/from\s+'([^']+)'/g)]
    .map((match) => match[1] ?? '')
    .sort();
}

/**
 * Mechanisms this design replaces. None of them may leak into the lifetime
 * module: the whole point is that the kill decision stops depending on a
 * sandbox-authored lease, a busy probe that classifies `retry` as busy, an idle
 * countdown that has never once fired in production, and an uncapped hard-stop
 * ceiling that a cron firing every 4h holds open forever.
 *
 * Scoped to `projects/lifetime/**` because those mechanisms still EXIST
 * elsewhere in the tree — this change does not delete them, it stops depending
 * on them.
 */
export const BANNED_IN_LIFETIME =
  /executionLeaseUntil|hasActiveExecutionLease|idleObservedAt|lastTurnAt|probeSandboxBusy|decideHardStop|provenActivityAt/;

export function findBannedMechanismUsage(files: SourceFile[]): string[] {
  return files
    .filter((file) => BANNED_IN_LIFETIME.test(stripComments(file.source)))
    .map((file) => file.path)
    .sort();
}
