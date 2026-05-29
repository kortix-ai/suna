/**
 * Durable runner for the lazy, user-triggered legacy-sandbox migration.
 *
 * The user clicks "Migrate" in /projects exactly once; from then on the
 * migration is owned by the backend and CANNOT be cancelled. It must complete
 * even across crashes/redeploys, so the DB row (kortix.legacy_sandbox_migrations)
 * is the source of truth, not the running process.
 *
 * Shape:
 *   - The migration is an ordered pipeline of idempotent PHASES:
 *       extract -> repo -> push -> db -> done
 *     Each phase re-runs harmlessly: it checks `progress` for what it already
 *     did and skips that part. So resuming = "run phases from the current one".
 *   - A worker takes a time-boxed LEASE (heartbeat_at) on a row before driving
 *     it. Only the lease holder advances the row. If the holder dies, the lease
 *     goes stale and the resume loop (legacy-migration-worker.ts) reclaims it.
 *   - After each phase succeeds we persist `phase = next` + merged `progress`.
 *     A crash between phases simply re-runs the last phase (idempotent) or the
 *     next one — never both the full pipeline.
 *
 * Long I/O (SSH backup, git push) lives in phases and runs OUTSIDE any DB
 * transaction. Only the final `db` phase opens a transaction to atomically
 * create the project + sessions and flip the row to completed.
 */
import { and, eq, inArray, lt, or, sql } from 'drizzle-orm';
import { legacySandboxMigrations, sandboxes, type Database } from '@kortix/db';
import { logger as appLogger } from '../lib/logger';
import { buildPlan, type LegacySandboxMigrationPlan } from './legacy-migration';
import { extractStep, repoStep, pushStep, dbStep } from './legacy-migration-steps';

export type MigrationPhase = 'extract' | 'repo' | 'push' | 'db' | 'done';

// Pipeline. `done` is the terminal marker, not a step. No eager provision:
// migrated sessions are created listable-but-dormant; a sandbox is provisioned
// (and its chat rehydrated) on-demand when the user opens a session.
export const PHASE_ORDER: MigrationPhase[] = ['extract', 'repo', 'push', 'db', 'done'];

/** How long a worker's lease is trusted before the resume loop may reclaim it.
 *  Must comfortably exceed the slowest single phase's heartbeat interval. */
export const LEASE_TTL_MS = 10 * 60 * 1000;

/** Per-phase retry ceiling before the row is dead-lettered (status=failed). */
export const MAX_PHASE_ATTEMPTS = 5;

type LegacySandboxRow = typeof sandboxes.$inferSelect;
type MigrationRow = typeof legacySandboxMigrations.$inferSelect;

/**
 * Handed to each phase. Phases MUST be idempotent: read `progress` to see what
 * prior runs already accomplished, do only the missing work, then `checkpoint`
 * the new artifacts. `checkpoint` also refreshes the lease, so calling it
 * periodically inside a long phase keeps the row from being reclaimed mid-step.
 */
export interface MigrationContext {
  database: Database;
  migrationId: string;
  runId: string;
  legacy: LegacySandboxRow;
  plan: LegacySandboxMigrationPlan;
  /** Live snapshot of accumulated checkpoint state; mutated by `checkpoint`. */
  progress: Record<string, unknown>;
  /** Merge `patch` into `progress`, persist it, and refresh the lease. */
  checkpoint: (patch: Record<string, unknown>) => Promise<void>;
  /** Refresh the lease without changing progress (call inside long loops). */
  heartbeat: () => Promise<void>;
  log: (message: string, extra?: Record<string, unknown>) => void;
}

type PhaseStep = (ctx: MigrationContext) => Promise<void>;

const STEPS: Record<Exclude<MigrationPhase, 'done'>, PhaseStep> = {
  extract: extractStep,
  repo: repoStep,
  push: pushStep,
  db: dbStep,
};

function normalizeJsonObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

/**
 * Atomically claim the row for this worker. Succeeds only if the row is live
 * (status running/planned) AND currently unleased or stale. The conditional
 * UPDATE is the mutual-exclusion primitive — two workers can't both win it.
 * Returns the freshly-leased row, or null if someone else owns it / it's done.
 */
async function acquireLease(database: Database, migrationId: string): Promise<MigrationRow | null> {
  const staleBefore = new Date(Date.now() - LEASE_TTL_MS);
  const rows = await database
    .update(legacySandboxMigrations)
    .set({ status: 'running', heartbeatAt: new Date(), updatedAt: new Date() })
    .where(and(
      eq(legacySandboxMigrations.migrationId, migrationId),
      inArray(legacySandboxMigrations.status, ['planned', 'running']),
      or(
        sql`${legacySandboxMigrations.heartbeatAt} IS NULL`,
        lt(legacySandboxMigrations.heartbeatAt, staleBefore),
      ),
    ))
    .returning();
  return rows[0] ?? null;
}

/**
 * Drive a single migration row from its current phase to completion (or until a
 * phase errors / the lease can't be acquired). Safe to call repeatedly and
 * concurrently: the lease ensures only one caller makes progress at a time.
 */
export async function driveMigration(database: Database, migrationId: string): Promise<void> {
  const leased = await acquireLease(database, migrationId);
  if (!leased) return; // owned by another worker, or already terminal

  const [legacy] = await database
    .select()
    .from(sandboxes)
    .where(eq(sandboxes.sandboxId, leased.sandboxId))
    .limit(1);
  if (!legacy) {
    await failRow(database, migrationId, 'Source legacy sandbox row no longer exists');
    return;
  }

  const progress = normalizeJsonObject(leased.progress);
  const log = (message: string, extra?: Record<string, unknown>) =>
    appLogger.info(`[legacy-migration] ${message}`, { migrationId, sandboxId: leased.sandboxId, ...extra });

  const heartbeat = async () => {
    await database
      .update(legacySandboxMigrations)
      .set({ heartbeatAt: new Date(), updatedAt: new Date() })
      .where(eq(legacySandboxMigrations.migrationId, migrationId));
  };

  const checkpoint = async (patch: Record<string, unknown>) => {
    Object.assign(progress, patch);
    await database
      .update(legacySandboxMigrations)
      .set({ progress: { ...progress }, heartbeatAt: new Date(), updatedAt: new Date() })
      .where(eq(legacySandboxMigrations.migrationId, migrationId));
  };

  const ctx: MigrationContext = {
    database,
    migrationId,
    runId: leased.runId,
    legacy,
    plan: leased.plan as unknown as LegacySandboxMigrationPlan,
    progress,
    checkpoint,
    heartbeat,
    log,
  };

  let phaseIndex = Math.max(0, PHASE_ORDER.indexOf((leased.phase as MigrationPhase) ?? 'extract'));

  for (; phaseIndex < PHASE_ORDER.length; phaseIndex++) {
    const phase = PHASE_ORDER[phaseIndex]!;

    if (phase === 'done') {
      await database
        .update(legacySandboxMigrations)
        .set({
          status: 'completed',
          phase: 'done',
          error: null,
          appliedAt: leased.appliedAt ?? new Date(),
          verifiedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(legacySandboxMigrations.migrationId, migrationId));
      log('completed');
      return;
    }

    try {
      await heartbeat();
      log(`phase:start ${phase}`);
      await STEPS[phase](ctx);

      // Phase succeeded — advance pointer and reset the retry counter so the
      // next phase gets a fresh budget. A crash before this persists just
      // re-runs the (idempotent) phase.
      const next = PHASE_ORDER[phaseIndex + 1]!;
      await database
        .update(legacySandboxMigrations)
        .set({ phase: next, attempts: 0, error: null, heartbeatAt: new Date(), updatedAt: new Date() })
        .where(eq(legacySandboxMigrations.migrationId, migrationId));
      log(`phase:done ${phase}`);
    } catch (error) {
      await recordPhaseFailure(database, migrationId, phase, error, log);
      return; // resume loop (or a later drive) retries from this phase
    }
  }
}

/**
 * Record a phase error. Below the attempt ceiling we leave the row `running`
 * (the resume loop will reclaim + retry from the same phase); at the ceiling we
 * dead-letter it to `failed` so it stops looping and surfaces to an operator.
 */
async function recordPhaseFailure(
  database: Database,
  migrationId: string,
  phase: MigrationPhase,
  error: unknown,
  log: (message: string, extra?: Record<string, unknown>) => void,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const [row] = await database
    .select({ attempts: legacySandboxMigrations.attempts })
    .from(legacySandboxMigrations)
    .where(eq(legacySandboxMigrations.migrationId, migrationId))
    .limit(1);
  const attempts = (row?.attempts ?? 0) + 1;
  const dead = attempts >= MAX_PHASE_ATTEMPTS;

  await database
    .update(legacySandboxMigrations)
    .set({
      attempts,
      error: `phase ${phase} failed (attempt ${attempts}): ${message}`,
      status: dead ? 'failed' : 'running',
      // Release the lease immediately on retryable failure so the resume loop
      // can pick it up without waiting out the full TTL.
      heartbeatAt: dead ? new Date() : null,
      updatedAt: new Date(),
    })
    .where(eq(legacySandboxMigrations.migrationId, migrationId));

  log(`phase:error ${phase}`, { attempts, dead, error: message });
}

async function failRow(database: Database, migrationId: string, reason: string): Promise<void> {
  await database
    .update(legacySandboxMigrations)
    .set({ status: 'failed', error: reason, updatedAt: new Date() })
    .where(eq(legacySandboxMigrations.migrationId, migrationId));
}

export interface StartMigrationInput {
  database: Database;
  sandboxId: string;
  /** Optional: caller may scope by account for an extra safety check. */
  accountId?: string;
  repoUrlTemplate?: string;
  /** Kick the initial in-process drive (default true). Set false to drive it
   *  yourself synchronously — used by the manual test script. */
  autoDrive?: boolean;
}

export interface StartMigrationResult {
  migration: MigrationRow;
  created: boolean;
}

/**
 * Entry point for the "Migrate" button. Idempotent: if an active migration for
 * this sandbox already exists (enforced by the partial unique index), returns
 * it instead of starting a second. On a fresh start it kicks off driveMigration
 * in the background — but durability does NOT depend on that call surviving:
 * the row exists, so the resume loop will finish it regardless.
 */
export async function startMigration(input: StartMigrationInput): Promise<StartMigrationResult> {
  const { database, sandboxId, accountId } = input;

  const [legacy] = await database
    .select()
    .from(sandboxes)
    .where(accountId
      ? and(eq(sandboxes.sandboxId, sandboxId), eq(sandboxes.accountId, accountId))
      : eq(sandboxes.sandboxId, sandboxId))
    .limit(1);
  if (!legacy) throw new Error('Legacy sandbox not found');

  const existing = await findActiveMigration(database, sandboxId);
  if (existing) return { migration: existing, created: false };

  const plan = await buildPlan(database, legacy, input.repoUrlTemplate);
  const runId = `lazy-${sandboxId}`;
  const now = new Date();

  try {
    const [migration] = await database
      .insert(legacySandboxMigrations)
      .values({
        runId,
        sandboxId: legacy.sandboxId,
        accountId: legacy.accountId,
        status: 'running',
        mode: 'apply',
        phase: 'extract',
        plan: plan as unknown as Record<string, unknown>,
        progress: {},
        attempts: 0,
        startedAt: now,
        heartbeatAt: null, // unleased: first driver acquires it
        appliedAt: null,
        updatedAt: now,
      })
      .returning();

    // Fire-and-forget; the resume loop is the durability guarantee, not this.
    if (input.autoDrive !== false) {
      void driveMigration(database, migration!.migrationId).catch((err) => {
        appLogger.error('[legacy-migration] initial drive failed', {
          migrationId: migration!.migrationId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    return { migration: migration!, created: true };
  } catch (error) {
    // Lost the race against a concurrent start — the unique index rejected us.
    // Return whatever active row won.
    const winner = await findActiveMigration(database, sandboxId);
    if (winner) return { migration: winner, created: false };
    throw error;
  }
}

/** The single live (non-terminal, non-rolled-back) migration for a sandbox. */
export async function findActiveMigration(database: Database, sandboxId: string): Promise<MigrationRow | null> {
  const [row] = await database
    .select()
    .from(legacySandboxMigrations)
    .where(and(
      eq(legacySandboxMigrations.sandboxId, sandboxId),
      inArray(legacySandboxMigrations.status, ['planned', 'running', 'applied', 'verified', 'completed']),
    ))
    .limit(1);
  return row ?? null;
}
