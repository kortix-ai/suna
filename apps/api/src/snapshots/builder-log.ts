import { and, desc, eq, gt, inArray, lt, or } from 'drizzle-orm';
import { projectSnapshotBuilds } from '@kortix/db';
import { db } from '../shared/db';
import { getSandboxProvider, type ProviderState } from './providers';
import { config, type SandboxProviderName } from '../config';
import { DEFAULT_SANDBOX_SLUG } from './dockerfile-layer';
import { classifySnapshotError } from './error-classify';
import type { SnapshotBuildSource } from './builder';

// ─── Build log (UI-only, never read on boot) ─────────────────────────────

export interface ProjectSnapshotBuildSummary {
  buildId: string;
  projectId: string;
  slug: string;
  snapshotName: string;
  contentHash: string;
  status: 'building' | 'ready' | 'failed';
  error: string | null;
  errorCategory: string | null;
  source: SnapshotBuildSource | null;
  provider: SandboxProviderName | null;
  startedAt: Date;
  finishedAt: Date | null;
}
function rowToSummary(row: typeof projectSnapshotBuilds.$inferSelect): ProjectSnapshotBuildSummary {
  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  const slug = typeof meta.slug === 'string' ? meta.slug : row.branch || DEFAULT_SANDBOX_SLUG;
  return {
    buildId: row.buildId,
    projectId: row.projectId,
    slug,
    snapshotName: row.snapshotName,
    contentHash: row.contentHash,
    status: row.status as 'building' | 'ready' | 'failed',
    error: row.error,
    errorCategory: row.errorCategory,
    source: typeof meta.source === 'string' ? (meta.source as SnapshotBuildSource) : null,
    provider: typeof meta.provider === 'string' && config.ALLOWED_SANDBOX_PROVIDERS.includes(meta.provider as SandboxProviderName)
      ? meta.provider as SandboxProviderName
      : null,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}

export async function listSnapshotBuilds(
  projectId: string,
  opts: { limit?: number } = {},
): Promise<ProjectSnapshotBuildSummary[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 25, 100));
  const rows = await db
    .select()
    .from(projectSnapshotBuilds)
    .where(eq(projectSnapshotBuilds.projectId, projectId))
    .orderBy(desc(projectSnapshotBuilds.startedAt))
    .limit(limit);
  return rows.map(rowToSummary);
}

/**
 * Builds that never reached a terminal state. The build log is closed inside
 * the same in-process promise that runs the build, so a process restart (very
 * common in dev) or crash mid-build orphans the row at `building` forever —
 * which is exactly why the dashboard showed two stuck "Building" entries even
 * though the image was actually live. This re-checks any `building` row older
 * than the max build window against the provider and closes it: `ready` if the
 * snapshot is active, `failed` otherwise. Idempotent and safe to run anywhere.
 *
 * The cutoff must exceed the longest legitimate build (Daytona build timeout +
 * activation poll); below that we'd race a build that's genuinely still going.
 */
const STALE_BUILD_MS = 20 * 60 * 1000;
const STALE_BUILD_BATCH = 50;

export async function reconcileStaleBuilds(
  opts: { projectId?: string; olderThanMs?: number } = {},
): Promise<{ checked: number; closedReady: number; closedFailed: number }> {
  const cutoff = new Date(Date.now() - (opts.olderThanMs ?? STALE_BUILD_MS));
  const conds = [
    eq(projectSnapshotBuilds.status, 'building'),
    lt(projectSnapshotBuilds.startedAt, cutoff),
  ];
  if (opts.projectId) conds.push(eq(projectSnapshotBuilds.projectId, opts.projectId));

  const rows = await db
    .select()
    .from(projectSnapshotBuilds)
    .where(and(...conds))
    .orderBy(desc(projectSnapshotBuilds.startedAt))
    .limit(STALE_BUILD_BATCH);
  if (rows.length === 0) return { checked: 0, closedReady: 0, closedFailed: 0 };

  let closedReady = 0;
  let closedFailed = 0;
  for (const row of rows) {
    const providerIds = buildLogProviderCandidates(row.metadata, config.ALLOWED_SANDBOX_PROVIDERS);
    const providers = providerIds.flatMap((providerId) => {
      try {
        const provider = getSandboxProvider(providerId);
        return provider.isConfigured() ? [provider] : [];
      } catch {
        return [];
      }
    });
    if (providers.length === 0) continue;

    const states = await Promise.all(providers.map(async (provider) => {
      try {
        return { provider: provider.id, state: await provider.getSnapshotState(row.snapshotName) };
      } catch {
        return { provider: provider.id, state: 'unknown' as ProviderState };
      }
    }));
    if (states.some(({ state }) => state === 'active')) {
      await closeBuildLogReady(row.buildId);
      closedReady += 1;
    } else if (states.some(({ state }) => state === 'building' || state === 'unknown')) {
      // Provider truth still says this build is in flight. Never turn it into a
      // false failure merely because a large provider build crossed our stale
      // row cutoff; a later poll will close it when the provider settles.
      continue;
    } else {
      await closeBuildLogFailed(
        row.buildId,
        `Build did not finish — provider state: ${states.map(({ provider, state }) => `${provider}=${state}`).join(', ')}.`,
      );
      closedFailed += 1;
    }
  }
  return { checked: rows.length, closedReady, closedFailed };
}

/**
 * New build rows record the exact provider in metadata. Historical rows do not,
 * and multi-provider builds predate this provenance, so legacy rows remain
 * unresolved instead of being guessed as Daytona or whichever provider happens
 * to be enabled today.
 */
export function buildLogProviderCandidates(
  metadata: unknown,
  allowedProviders: readonly string[],
): string[] {
  const provider = metadata && typeof metadata === 'object'
    ? (metadata as Record<string, unknown>).provider
    : null;
  return typeof provider === 'string' && allowedProviders.includes(provider)
    ? [provider]
    : [];
}

/** Reconcile only when provider truth confirms the current image needs a build. */
export function shouldReconcileProviderState(state: ProviderState): boolean {
  return state === 'missing' || state === 'build_failed';
}

export async function openBuildLog(args: {
  accountId: string;
  projectId: string;
  slug: string;
  snapshotName: string;
  contentHash: string;
  commitSha?: string;
  source: SnapshotBuildSource;
  provider: string;
}): Promise<string | null> {
  try {
    const [row] = await db
      .insert(projectSnapshotBuilds)
      .values({
        accountId: args.accountId,
        projectId: args.projectId,
        commitSha: args.commitSha ?? '',
        branch: args.slug,
        snapshotName: args.snapshotName,
        contentHash: args.contentHash,
        status: 'building',
        // FIX-K-lite forward hygiene: record the FULL projectId as first-class
        // snapshot build metadata (alongside the projectId column), so a warm
        // image's owning project is recoverable beyond the lossy 8-hex proj8 in
        // its name. Forward-only — legacy warm images churn out on the next commit.
        metadata: { source: args.source, slug: args.slug, provider: args.provider, projectId: args.projectId },
      })
      .returning({ buildId: projectSnapshotBuilds.buildId });
    return row?.buildId ?? null;
  } catch (err) {
    console.warn('[snapshots] failed to open build log:', err instanceof Error ? err.message : err);
    return null;
  }
}

export async function closeBuildLogReady(buildId: string): Promise<void> {
  await db
    .update(projectSnapshotBuilds)
    .set({ status: 'ready', finishedAt: new Date(), error: null, errorCategory: null })
    .where(eq(projectSnapshotBuilds.buildId, buildId))
    .catch((err) =>
      console.warn('[snapshots] failed to close build log (ready):', err instanceof Error ? err.message : err),
    );
}

export async function closeBuildLogFailed(buildId: string, message: string): Promise<void> {
  await db
    .update(projectSnapshotBuilds)
    .set({
      status: 'failed',
      error: message.slice(0, 2000),
      errorCategory: classifySnapshotError(message),
      finishedAt: new Date(),
    })
    .where(eq(projectSnapshotBuilds.buildId, buildId))
    .catch((err) =>
      console.warn('[snapshots] failed to close build log (failed):', err instanceof Error ? err.message : err),
    );
}
/**
 * How long a freshly-built PREDECESSOR identity is protected from the
 * supersession prune in {@link runInlineBuild}. Long: a stale-but-live code
 * version (dev's split-brain ran for days) keeps re-building its identity, so
 * every prune within the window would re-arm the mutual-destruction loop, and a
 * kept default costs only provider storage (Daytona's quota GC ranks defaults
 * by freshness; Platinum templates are CAS-chunked).
 */
export const PREDECESSOR_PRUNE_PROTECT_MS = 6 * 60 * 60 * 1000;

/**
 * Of `snapshotNames`, the ones with a successful build finished — or a build
 * started — within `withinMs`, per this environment's build log. Used as the
 * "another live runtime still serves this" signal before pruning superseded
 * snapshots. Fail-open (empty set) on a DB error: the callers' deletes then
 * behave exactly as before this guard existed.
 */
export async function recentlyBuiltSnapshotNames(
  snapshotNames: string[],
  withinMs: number,
): Promise<Set<string>> {
  if (snapshotNames.length === 0) return new Set();
  try {
    const cutoff = new Date(Date.now() - withinMs);
    const rows = await db
      .select({ snapshotName: projectSnapshotBuilds.snapshotName })
      .from(projectSnapshotBuilds)
      .where(
        and(
          inArray(projectSnapshotBuilds.snapshotName, snapshotNames),
          or(
            and(eq(projectSnapshotBuilds.status, 'ready'), gt(projectSnapshotBuilds.finishedAt, cutoff)),
            and(eq(projectSnapshotBuilds.status, 'building'), gt(projectSnapshotBuilds.startedAt, cutoff)),
          ),
        ),
      );
    return new Set(rows.map((row) => row.snapshotName));
  } catch (err) {
    console.warn(
      '[snapshots] recent-build lookup failed (skipping prune protection):',
      err instanceof Error ? err.message : err,
    );
    return new Set();
  }
}

/**
 * Which of `names` were built recently — same query as
 * `recentlyBuiltSnapshotNames`, but it lets a failure propagate.
 *
 * The difference is the whole point: that function returns an empty set when
 * the lookup fails, which a caller cannot distinguish from "none were recent".
 * For a reaper those two mean opposite things.
 *
 * Exported for the reap test, which needs to inject a failing lookup.
 */
export async function recentlyBuiltStrict(
  snapshotNames: string[],
  withinMs: number,
): Promise<Set<string>> {
  if (snapshotNames.length === 0) return new Set();
  const cutoff = new Date(Date.now() - withinMs);
  const rows = await db
    .select({ snapshotName: projectSnapshotBuilds.snapshotName })
    .from(projectSnapshotBuilds)
    .where(
      and(
        inArray(projectSnapshotBuilds.snapshotName, snapshotNames),
        or(
          and(eq(projectSnapshotBuilds.status, 'ready'), gt(projectSnapshotBuilds.finishedAt, cutoff)),
          and(eq(projectSnapshotBuilds.status, 'building'), gt(projectSnapshotBuilds.startedAt, cutoff)),
        ),
      ),
    );
  return new Set(rows.map((row) => row.snapshotName));
}
