/**
 * PREBUILD MODE (operational, for planned migrations). Selects a cohort of
 * projects by a CONFIGURABLE fan-out policy, builds their target ppwarm image in
 * the background at a bounded concurrency (real Platinum build capacity), and
 * records readiness per project — WITHOUT shifting any traffic. Traffic only
 * moves for a project when an on-demand switch adopts its ready prebuild row (a
 * project that gets a new commit before activation is rebuilt: the prebuild row
 * drifts and forks a fresh identity, same as the switch path).
 *
 * The prebuild uses the SAME transitions table + SAME content-addressed dedup
 * key as an on-demand switch, so a switch that lands mid-prebuild adopts the
 * in-flight/ready row rather than starting a duplicate build.
 */
import { and, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { projectSessions, projects, type Database } from '@kortix/db';
import { db as appDb } from '../../shared/db';
import { logger } from '../../lib/logger';
import { requestPrebuild } from './provider-transition-service';

export type CohortPolicy = 'recently-active' | 'opted-in' | 'all-active' | 'selected';

export interface PrebuildConfig {
  targetProvider: string;
  policy: CohortPolicy;
  /** recently-active window. */
  sinceMs: number;
  /** cohort cap. */
  limit: number;
  /** parallel builds (bound to real provider build capacity). */
  concurrency: number;
  /** explicit ids for policy='selected'. */
  projectIds: string[];
  /** dry-run: select + report only, never kick a build. */
  dryRun: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Parse env + argv into a config. Pure (no IO) so it unit-tests directly.
 *  argv wins over env; env wins over defaults. */
export function parsePrebuildConfig(
  env: Record<string, string | undefined>,
  argv: string[] = [],
): PrebuildConfig {
  const flags = new Map<string, string>();
  for (const a of argv) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) flags.set(m[1]!, m[2]!);
  }
  const pick = (k: string, e: string) => flags.get(k) ?? env[e];
  const policyRaw = (pick('policy', 'PREBUILD_POLICY') ?? 'recently-active') as CohortPolicy;
  const policy: CohortPolicy = ['recently-active', 'opted-in', 'all-active', 'selected'].includes(policyRaw)
    ? policyRaw
    : 'recently-active';
  const num = (k: string, e: string, dflt: number) => {
    const raw = Number(pick(k, e));
    return Number.isFinite(raw) && raw > 0 ? raw : dflt;
  };
  return {
    targetProvider: pick('provider', 'PREBUILD_PROVIDER') ?? 'platinum',
    policy,
    sinceMs: num('since-days', 'PREBUILD_SINCE_DAYS', 7) * DAY_MS,
    limit: num('limit', 'PREBUILD_LIMIT', 100),
    concurrency: num('concurrency', 'PREBUILD_CONCURRENCY', 3),
    projectIds: (pick('projects', 'PREBUILD_PROJECT_IDS') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    dryRun: (pick('dry-run', 'PREBUILD_DRY_RUN') ?? '') === 'true',
  };
}

/** Split ids into concurrency-sized batches — pure, unit-testable. */
export function chunkForConcurrency(ids: string[], concurrency: number): string[][] {
  const size = Math.max(1, concurrency);
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

/** Resolve the project cohort for the configured policy. */
export async function selectCohort(db: Database, cfg: PrebuildConfig): Promise<string[]> {
  if (cfg.policy === 'selected') return cfg.projectIds.slice(0, cfg.limit);

  if (cfg.policy === 'recently-active') {
    const cutoff = new Date(Date.now() - cfg.sinceMs);
    const rows = await db
      .selectDistinct({ projectId: projectSessions.projectId, updatedAt: projectSessions.updatedAt })
      .from(projectSessions)
      .innerJoin(projects, eq(projects.projectId, projectSessions.projectId))
      .where(and(eq(projects.status, 'active'), gt(projectSessions.updatedAt, cutoff)))
      .orderBy(desc(projectSessions.updatedAt))
      .limit(cfg.limit);
    return [...new Set(rows.map((r) => r.projectId))];
  }

  if (cfg.policy === 'opted-in') {
    const rows = await db
      .select({ projectId: projects.projectId })
      .from(projects)
      .where(
        and(
          eq(projects.status, 'active'),
          sql`${projects.metadata} @> ${JSON.stringify({ prebuild_platinum: true })}::jsonb`,
        ),
      )
      .limit(cfg.limit);
    return rows.map((r) => r.projectId);
  }

  const rows = await db
    .select({ projectId: projects.projectId })
    .from(projects)
    .where(eq(projects.status, 'active'))
    .orderBy(desc(projects.updatedAt))
    .limit(cfg.limit);
  return rows.map((r) => r.projectId);
}

export interface PrebuildResult {
  selected: number;
  kicked: number;
  skipped: number;
  errors: number;
  transitionIds: string[];
}

/**
 * Fan out prebuilds over the selected cohort at bounded concurrency. Records the
 * transition id per project (readiness lives on the row; the resume worker drives
 * each to `ready`). Best-effort per project — one failure never aborts the cohort.
 */
export async function runPrebuildMigration(
  db: Database = appDb,
  cfg?: Partial<PrebuildConfig>,
): Promise<PrebuildResult> {
  const config = { ...parsePrebuildConfig({}), ...cfg } as PrebuildConfig;
  const cohort = await selectCohort(db, config);
  const result: PrebuildResult = { selected: cohort.length, kicked: 0, skipped: 0, errors: 0, transitionIds: [] };
  if (config.dryRun) {
    logger.info('[provider-transition-prebuild] dry-run cohort', { policy: config.policy, count: cohort.length });
    return result;
  }
  for (const batch of chunkForConcurrency(cohort, config.concurrency)) {
    await Promise.all(
      batch.map(async (projectId) => {
        try {
          const row = await requestPrebuild({ projectId, targetProvider: config.targetProvider, database: db });
          if (row) {
            result.kicked += 1;
            result.transitionIds.push(row.transitionId);
          } else {
            result.skipped += 1;
          }
        } catch (err) {
          result.errors += 1;
          logger.warn('[provider-transition-prebuild] project failed', {
            projectId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }),
    );
  }
  logger.info('[provider-transition-prebuild] cohort complete', { ...result });
  return result;
}
