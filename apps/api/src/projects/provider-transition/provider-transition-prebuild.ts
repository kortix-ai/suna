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
import { defaultTransitionDeps, requestPrebuild } from './provider-transition-service';
import {
  BUILDING_POLL_MS,
  LEASE_TTL_MS,
  MAX_BUILDING_MS,
  driveProviderTransition,
  type DriveOutcome,
} from './provider-transition-runner';
import { getTransition, type ProviderTransitionRow } from './provider-transition-store';

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
  /** Cohort size. */
  selected: number;
  /** Reached ready/activated (image built + verified) during this run. */
  ready: number;
  /** Skipped because the row was ALREADY ready/activated (idempotent rerun). */
  alreadyReady: number;
  /** No-op: no repo / archived / disabled provider, or superseded by a newer identity. */
  skipped: number;
  /** Drive failed or threw. */
  failed: number;
  /** Still in-flight / gated when the run ended (SIGINT or the wall-clock bound) —
   *  left durable for a rerun or the resume worker + lease fence to finish. */
  unfinished: number;
  /** True when SIGINT stopped the run before the whole cohort was launched. */
  aborted: boolean;
  transitionIds: string[];
}

/**
 * Process exit code for the one-shot CLI: 130 on SIGINT interruption, 1 on any
 * drive failure, else 0. A rerun is idempotent (already-ready rows are skipped,
 * in-flight rows are adopted), so ops simply reruns on a 130/1.
 */
export function prebuildExitCode(result: PrebuildResult): number {
  if (result.aborted) return 130;
  return result.failed > 0 ? 1 : 0;
}

/** Injectable collaborators — real wiring by default, fakes in tests. */
export interface PrebuildRunDeps {
  requestPrebuild: (input: {
    projectId: string;
    targetProvider: string;
    database?: Database;
    autoDrive?: boolean;
  }) => Promise<ProviderTransitionRow | null>;
  /** Drive ONE transition to a terminal state (ready/activated/failed/…). */
  driveToTerminal: (transitionId: string) => Promise<DriveOutcome>;
  /** SIGINT-aware: once true, no NEW drive is launched; in-flight ones finish. */
  shouldStop: () => boolean;
}

const TERMINAL_OUTCOMES = new Set<DriveOutcome>([
  'activated',
  'prebuilt',
  'failed',
  'gone',
  'lost_cas',
  'superseded',
  'rebuilt',
]);
/** Row statuses that mean a prebuild transition needs no further driving. */
const TERMINAL_STATUSES = new Set(['ready', 'activated', 'failed', 'superseded', 'cancelled']);

function sleep(ms: number, shouldStop: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    if (shouldStop()) return resolve();
    const t = setTimeout(resolve, ms);
    (t as { unref?: () => void }).unref?.();
  });
}

/**
 * Default drive: loop {@link driveProviderTransition} until the row reaches a
 * terminal state. A fresh build blocks the FIRST drive for its whole duration (the
 * builder waits on the provider with lease heartbeats), so one drive usually
 * finishes it; the loop only re-polls the "already building elsewhere" case, where
 * a healthy `building`/`waiting` release parks the row behind a poll gate. Bounded
 * by the build wall-clock so a stuck provider can't spin forever. Stops early on
 * SIGINT, leaving the row durable for a rerun or the resume worker.
 */
async function driveToTerminalDefault(
  db: Database,
  transitionId: string,
  shouldStop: () => boolean,
): Promise<DriveOutcome> {
  const deps = defaultTransitionDeps(db);
  const deadline = Date.now() + MAX_BUILDING_MS + LEASE_TTL_MS;
  let last: DriveOutcome = 'not_leased';
  while (Date.now() < deadline) {
    if (shouldStop()) return last;
    last = await driveProviderTransition(deps, transitionId);
    if (TERMINAL_OUTCOMES.has(last)) return last;
    // Non-terminal (building / waiting / not_leased): a terminal ROW status means
    // another drive/replica finished it — stop; otherwise wait the poll gate + re-drive.
    const row = await getTransition(db, transitionId).catch(() => null);
    if (!row || TERMINAL_STATUSES.has(row.status)) return last;
    if (shouldStop()) return last;
    await sleep(BUILDING_POLL_MS, shouldStop);
  }
  return last;
}

/**
 * Bounded worker pool: `width` runners each pull the NEXT project and drive it to
 * terminal, so a 30-40 min straggler in one runner never blocks the others from
 * pulling more work (no per-batch barrier that would convoy behind one slow build).
 * The final `Promise.all` is a DRAIN of the fixed pool — it awaits every in-flight
 * drive before returning, so a normal completion abandons NOTHING.
 */
async function runPool(
  items: string[],
  width: number,
  worker: (item: string) => Promise<void>,
  shouldStop: () => boolean,
): Promise<void> {
  if (items.length === 0) return;
  let next = 0;
  const runner = async (): Promise<void> => {
    for (;;) {
      if (shouldStop()) return;
      const i = next++;
      if (i >= items.length) return;
      await worker(items[i]!);
    }
  };
  const runners = Array.from({ length: Math.min(Math.max(1, width), items.length) }, runner);
  await Promise.all(runners);
}

/**
 * Fan out prebuilds over the selected cohort and drive each to a TERMINAL state at
 * a concurrency that bounds ACTUAL builds (not just DB inserts). Every project's
 * prebuild row is inserted with `autoDrive:false` so it does NOT self-kick a
 * detached drive; the pool owns driving, so `cfg.concurrency` is the true build
 * ceiling. `allSettled` semantics — one project's failure never aborts a sibling,
 * and the exit code is derived from the pass/fail tally (see {@link prebuildExitCode}).
 * Idempotently resumable: a rerun skips already-ready rows and adopts in-flight
 * ones via the content-addressed dedup in insertPrebuildTransition. SIGINT stops
 * launching new drives and lets in-flight ones finish (or be recovered later).
 */
export async function runPrebuildMigration(
  db: Database = appDb,
  cfg?: Partial<PrebuildConfig>,
  runtime?: { signal?: AbortSignal; deps?: Partial<PrebuildRunDeps> },
): Promise<PrebuildResult> {
  const config = { ...parsePrebuildConfig({}), ...cfg } as PrebuildConfig;
  const shouldStop = runtime?.deps?.shouldStop ?? (() => runtime?.signal?.aborted ?? false);
  const deps: PrebuildRunDeps = {
    requestPrebuild: runtime?.deps?.requestPrebuild ?? requestPrebuild,
    driveToTerminal: runtime?.deps?.driveToTerminal ?? ((id) => driveToTerminalDefault(db, id, shouldStop)),
    shouldStop,
  };

  const cohort = await selectCohort(db, config);
  const result: PrebuildResult = {
    selected: cohort.length,
    ready: 0,
    alreadyReady: 0,
    skipped: 0,
    failed: 0,
    unfinished: 0,
    aborted: false,
    transitionIds: [],
  };
  if (config.dryRun) {
    logger.info('[provider-transition-prebuild] dry-run cohort', { policy: config.policy, count: cohort.length });
    return result;
  }

  await runPool(
    cohort,
    config.concurrency,
    async (projectId) => {
      let row: ProviderTransitionRow | null;
      try {
        row = await deps.requestPrebuild({
          projectId,
          targetProvider: config.targetProvider,
          database: db,
          autoDrive: false,
        });
      } catch (err) {
        result.failed += 1;
        logger.warn('[provider-transition-prebuild] request failed', {
          projectId,
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      if (!row) {
        result.skipped += 1;
        return;
      }
      result.transitionIds.push(row.transitionId);
      // Idempotent rerun: an already-ready/activated row needs no rebuild.
      if (row.status === 'ready' || row.status === 'activated') {
        result.alreadyReady += 1;
        return;
      }
      if (shouldStop()) {
        result.unfinished += 1;
        return;
      }
      let outcome: DriveOutcome;
      try {
        outcome = await deps.driveToTerminal(row.transitionId);
      } catch (err) {
        result.failed += 1;
        logger.warn('[provider-transition-prebuild] drive failed', {
          projectId,
          transitionId: row.transitionId,
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      switch (outcome) {
        case 'prebuilt':
        case 'activated':
          result.ready += 1;
          break;
        case 'superseded':
        case 'rebuilt':
          result.skipped += 1;
          break;
        case 'failed':
        case 'gone':
        case 'lost_cas':
          result.failed += 1;
          break;
        default:
          // building / waiting / not_leased — SIGINT or the wall-clock bound stopped
          // it before terminal; the durable row is resumed on rerun / by the worker.
          result.unfinished += 1;
          break;
      }
    },
    shouldStop,
  );

  result.aborted = shouldStop();
  logger.info('[provider-transition-prebuild] cohort complete', { ...result });
  return result;
}
