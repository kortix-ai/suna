/**
 * Durable runner for the user-triggered Suna → opencode account migration.
 * Mirrors legacy-migration-runner exactly (idempotent phases, time-boxed
 * heartbeat lease, resumable by the worker), but keyed on ACCOUNT: one row →
 * one new project with N sessions. The user clicks "Migrate" once; the backend
 * owns it from there and finishes even across redeploys.
 */
import { and, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import { sunaAccountMigrations, type Database } from '@kortix/db';
import { logger as appLogger } from '../../lib/logger';
import { extractStep, repoStep, pushStep, dbStep } from './suna-migration-phases';

export type SunaPhase = 'extract' | 'repo' | 'push' | 'db' | 'done';
export const PHASE_ORDER: SunaPhase[] = ['extract', 'repo', 'push', 'db', 'done'];
export const LEASE_TTL_MS = 10 * 60 * 1000;
export const MAX_PHASE_ATTEMPTS = 5;

type MigrationRow = typeof sunaAccountMigrations.$inferSelect;

export interface SunaMigrationContext {
  database: Database;
  migrationId: string;
  runId: string;
  accountId: string;
  progress: Record<string, unknown>;
  checkpoint: (patch: Record<string, unknown>) => Promise<void>;
  heartbeat: () => Promise<void>;
  log: (message: string, extra?: Record<string, unknown>) => void;
}

const STEPS: Record<Exclude<SunaPhase, 'done'>, (ctx: SunaMigrationContext) => Promise<void>> = {
  extract: extractStep, repo: repoStep, push: pushStep, db: dbStep,
};

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

async function acquireLease(database: Database, migrationId: string): Promise<MigrationRow | null> {
  const staleBefore = new Date(Date.now() - LEASE_TTL_MS);
  const rows = await database
    .update(sunaAccountMigrations)
    .set({ status: 'running', heartbeatAt: new Date(), updatedAt: new Date() })
    .where(and(
      eq(sunaAccountMigrations.migrationId, migrationId),
      inArray(sunaAccountMigrations.status, ['planned', 'running']),
      or(sql`${sunaAccountMigrations.heartbeatAt} IS NULL`, lt(sunaAccountMigrations.heartbeatAt, staleBefore)),
    ))
    .returning();
  return rows[0] ?? null;
}

export async function driveSunaMigration(database: Database, migrationId: string): Promise<void> {
  const leased = await acquireLease(database, migrationId);
  if (!leased) return;

  const progress = asObject(leased.progress);
  const log = (message: string, extra?: Record<string, unknown>) =>
    appLogger.info(`[suna-migration] ${message}`, { migrationId, accountId: leased.accountId, ...extra });
  const heartbeat = async () => {
    await database.update(sunaAccountMigrations)
      .set({ heartbeatAt: new Date(), updatedAt: new Date() })
      .where(eq(sunaAccountMigrations.migrationId, migrationId));
  };
  const checkpoint = async (patch: Record<string, unknown>) => {
    Object.assign(progress, patch);
    await database.update(sunaAccountMigrations)
      .set({ progress: { ...progress }, heartbeatAt: new Date(), updatedAt: new Date() })
      .where(eq(sunaAccountMigrations.migrationId, migrationId));
  };

  const ctx: SunaMigrationContext = { database, migrationId, runId: leased.runId, accountId: leased.accountId, progress, checkpoint, heartbeat, log };

  let phaseIndex = Math.max(0, PHASE_ORDER.indexOf((leased.phase as SunaPhase) ?? 'extract'));
  for (; phaseIndex < PHASE_ORDER.length; phaseIndex++) {
    const phase = PHASE_ORDER[phaseIndex]!;
    if (phase === 'done') {
      await database.update(sunaAccountMigrations)
        .set({ status: 'completed', phase: 'done', error: null, appliedAt: leased.appliedAt ?? new Date(), verifiedAt: new Date(), updatedAt: new Date() })
        .where(eq(sunaAccountMigrations.migrationId, migrationId));
      log('completed');
      return;
    }
    try {
      await heartbeat();
      log(`phase:start ${phase}`);
      await STEPS[phase](ctx);
      await database.update(sunaAccountMigrations)
        .set({ phase: PHASE_ORDER[phaseIndex + 1]!, attempts: 0, error: null, heartbeatAt: new Date(), updatedAt: new Date() })
        .where(eq(sunaAccountMigrations.migrationId, migrationId));
      log(`phase:done ${phase}`);
    } catch (error) {
      await recordPhaseFailure(database, migrationId, phase, error, log);
      return;
    }
  }
}

async function recordPhaseFailure(database: Database, migrationId: string, phase: SunaPhase, error: unknown, log: (m: string, e?: Record<string, unknown>) => void): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const [row] = await database.select({ attempts: sunaAccountMigrations.attempts })
    .from(sunaAccountMigrations).where(eq(sunaAccountMigrations.migrationId, migrationId)).limit(1);
  const attempts = (row?.attempts ?? 0) + 1;
  const dead = attempts >= MAX_PHASE_ATTEMPTS;
  await database.update(sunaAccountMigrations)
    .set({ attempts, error: `phase ${phase} failed (attempt ${attempts}): ${message}`, status: dead ? 'failed' : 'running', heartbeatAt: dead ? new Date() : null, updatedAt: new Date() })
    .where(eq(sunaAccountMigrations.migrationId, migrationId));
  log(`phase:error ${phase}`, { attempts, dead, error: message });
}

export async function findActiveSunaMigration(database: Database, accountId: string): Promise<MigrationRow | null> {
  const [row] = await database.select().from(sunaAccountMigrations)
    .where(and(eq(sunaAccountMigrations.accountId, accountId), inArray(sunaAccountMigrations.status, ['planned', 'running', 'completed'])))
    .orderBy(desc(sunaAccountMigrations.updatedAt)).limit(1);
  return row ?? null;
}

export async function latestSunaMigration(database: Database, accountId: string): Promise<MigrationRow | null> {
  const [row] = await database.select().from(sunaAccountMigrations)
    .where(eq(sunaAccountMigrations.accountId, accountId))
    .orderBy(desc(sunaAccountMigrations.updatedAt)).limit(1);
  return row ?? null;
}

export async function startSunaMigration(input: { database: Database; accountId: string; autoDrive?: boolean }): Promise<{ migration: MigrationRow; created: boolean }> {
  const { database, accountId } = input;
  const existing = await findActiveSunaMigration(database, accountId);
  if (existing) return { migration: existing, created: false };

  const now = new Date();
  const [migration] = await database.insert(sunaAccountMigrations).values({
    runId: `suna-${accountId}`, accountId, status: 'running', mode: 'apply', phase: 'extract',
    plan: {}, progress: {}, attempts: 0, startedAt: now, heartbeatAt: null, appliedAt: null, updatedAt: now,
  }).returning();

  if (input.autoDrive !== false) {
    void driveSunaMigration(database, migration!.migrationId).catch((err) =>
      appLogger.error('[suna-migration] initial drive failed', { migrationId: migration!.migrationId, error: err instanceof Error ? err.message : String(err) }));
  }
  return { migration: migration!, created: true };
}
