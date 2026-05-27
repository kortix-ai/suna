/**
 * Sandbox snapshot builder.
 *
 * One job: given (project, ref), make sure there's a Daytona snapshot
 * containing the project's layered sandbox image at that commit and
 * return its name so a session can boot from it.
 *
 * Pipeline:
 *
 *   1. Resolve the ref to a concrete commit SHA so the build is pinned
 *      even if the default branch moves underneath us.
 *   2. Look in `kortix.project_runtime_snapshots` for
 *      `(projectId, commitSha, provider=daytona)`. Cache hit on `ready`
 *      → return immediately. `building` → wait. `failed` → surface.
 *      Absent → kick off a build and return only when it's done (lazy
 *      fallback — the eager-on-push trigger is a separate change).
 *   3. Build: read Dockerfile + tree OID at the commit, compose the
 *      layered Dockerfile (user content + Kortix runtime layer),
 *      materialize the context to a tmpdir, hand it to Daytona via
 *      `Image.fromDockerfile`. If a Daytona snapshot with our
 *      content-addressed name already exists, skip the upload — the
 *      content hash dedupes across commits with the same Dockerfile.
 *
 * The snapshot name is content-addressed (`kortix-snap-{project[:8]}-
 * {contentHash[:12]}`), so two commits with byte-identical Dockerfiles
 * share one Daytona-side snapshot even though they each get their own
 * DB row keyed on commit.
 */

import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { copyFile, cp, rm, stat } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { Image } from '@daytonaio/sdk';
import { projectRuntimeSnapshots } from '@kortix/db';
import { db } from '../shared/db';
import {
  deleteDaytonaSnapshotById,
  getDaytona,
  isDaytonaConfigured,
  listDaytonaSnapshots,
} from '../shared/daytona';
import { SANDBOX_VERSION } from '../config';
import type { SandboxProviderName } from '../config';

/**
 * Pinned opencode CLI version layered into every snapshot. This value is
 * included in the runtime artifact fingerprint so changing it invalidates
 * the Daytona snapshot cache even if SANDBOX_VERSION is unchanged in dev.
 */
const OPENCODE_VERSION = '1.15.10';

/**
 * Pinned `agent-browser` (Vercel agent-browser) CLI version baked into every
 * snapshot alongside a Chrome-for-Testing build. Folded into the runtime
 * fingerprint below so bumping it invalidates the Daytona snapshot cache.
 */
const AGENT_BROWSER_VERSION = '0.27.0';

/**
 * Filesystem paths to the runtime artifacts the layered Dockerfile
 * COPYs into the image: the compiled `kortix-agent` (Linux ELF) and
 * the entrypoint shim that execs it. Defaults walk up from this file
 * to the repo root so the API works out-of-the-box in dev; override
 * via env in prod when the API runs from a packaged bundle.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../../..');
const AGENT_BIN_PATH = process.env.KORTIX_SNAPSHOT_AGENT_BIN_PATH
  || resolve(REPO_ROOT, 'apps/kortix-sandbox-agent-server/dist/kortix-agent');
const ENTRYPOINT_PATH = process.env.KORTIX_SNAPSHOT_ENTRYPOINT_PATH
  || resolve(REPO_ROOT, 'apps/sandbox/entrypoint.sh');
const AGENT_CLI_SRC_PATH = process.env.KORTIX_SNAPSHOT_AGENT_CLI_PATH
  || resolve(REPO_ROOT, 'apps/sandbox/agent-cli');
const EXECUTOR_SDK_SRC_PATH = process.env.KORTIX_SNAPSHOT_EXECUTOR_SDK_PATH
  || resolve(REPO_ROOT, 'packages/executor-sdk');
import {
  materializeRepoCheckoutTar,
  materializeRepoContext,
  readRepoFile,
  resolveCommitSha,
  resolveTreeOid,
  type GitBackedProject,
} from '../projects/git';
import { readManifest } from '../projects/triggers';
import {
  buildLayeredDockerfile,
  extractSandboxPaths,
  extractSandboxSpec,
  normalizeUserDockerfileForSnapshot,
  sandboxSpecIsEmpty,
  type SandboxPaths,
  type SandboxSpec,
} from './dockerfile-layer';
import { computeSnapshotHash, formatSnapshotName } from './hash';
import { buildRuntimeArtifactFingerprint } from './runtime-fingerprint';
import {
  classifySnapshotError,
  describeSnapshotError,
  type SnapshotErrorCategory,
} from './error-classify';

/** Cap how long the Daytona-side snapshot build is allowed to take. */
const BUILD_TIMEOUT_MS = 10 * 60 * 1000;
/** How many times to retry a snapshot build that fails with a transient error. */
const BUILD_ATTEMPTS = 3;
const BUILD_RETRY_BASE_MS = 2_000;
const SNAPSHOT_LOG_TAIL_LIMIT = 20;
const RUNTIME_LAYER_VERSION = 'baked-workspace-opencode-prewarm-v2';

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Default retention: how many `ready` snapshots we keep per
 * (projectId, branch, provider). Older `ready` rows are deleted from the
 * DB and the Daytona snapshot is removed *iff* no other DB row still
 * references the same `snapshotId` (content-hash dedupe may share names
 * across commits within the same project).
 *
 * Tunable via `KORTIX_SNAPSHOT_RETENTION_COUNT`.
 */
export const DEFAULT_SNAPSHOT_RETENTION = 5;

function snapshotRetentionCount(): number {
  const raw = Number.parseInt(process.env.KORTIX_SNAPSHOT_RETENTION_COUNT || '', 10);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return DEFAULT_SNAPSHOT_RETENTION;
}

/** What the builder reports back to its caller. */
export interface SnapshotResolution {
  /** Daytona snapshot name a session can boot from (`kortix-snap-…`). */
  daytonaName: string;
  /** Commit SHA the snapshot was built for. */
  commitSha: string;
  /** Content hash of the inputs — useful for telemetry / logging. */
  contentHash: string;
  /** Runtime artifact fingerprint used in the content hash. */
  runtimeFingerprint: string;
  /** Whether this call did the actual build (vs hit the cache). */
  built: boolean;
}

export class SnapshotBuildError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'SnapshotBuildError';
  }
}

/**
 * Sources we tag onto the snapshot row metadata for telemetry / debugging.
 *
 * - `project-create` — fired the first time a project is registered.
 * - `session-start` — fired async when a session starts and the latest
 *   commit on the project's default branch has no snapshot yet. Never
 *   awaited by the session-creation path.
 * - `manual` — user clicked "Rebuild now" in the dashboard or an admin
 *   ran the script.
 * - `cr-merge` — fired after a change request merges into the default branch
 *   so the new tip is built ahead of the next session (proactive pre-build).
 */
export type SnapshotBuildSource = 'project-create' | 'session-start' | 'manual' | 'cr-merge';

/**
 * Mark a snapshot row `failed`, recording both the raw error and its
 * classified category (merged into metadata) so the dashboard + the
 * fix-with-agent flow can route the failure. Best-effort — a DB blip here
 * must not mask the underlying build error to the caller.
 */
async function markSnapshotFailed(
  projectId: string,
  commitSha: string,
  provider: SandboxProviderName,
  message: string,
): Promise<void> {
  const errorCategory = classifySnapshotError(message);
  await db
    .update(projectRuntimeSnapshots)
    .set({
      status: 'failed',
      error: message.slice(0, 2000),
      // jsonb-merge so we keep any build-stage breadcrumbs (logs, contentHash)
      // already written by the live build and just stamp the category on top.
      metadata: sql`COALESCE(${projectRuntimeSnapshots.metadata}, '{}'::jsonb) || ${JSON.stringify({ errorCategory })}::jsonb`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(projectRuntimeSnapshots.projectId, projectId),
        eq(projectRuntimeSnapshots.commitSha, commitSha),
        eq(projectRuntimeSnapshots.provider, provider),
      ),
    )
    .catch(() => {});
}

/**
 * Build (or rebuild) the snapshot for a specific commit. Idempotent:
 * concurrent callers race on the unique (projectId, commitSha, provider)
 * insert; losers no-op and let the winner finish. This *always* runs the
 * build to completion — callers that want fire-and-forget semantics
 * should call this from a detached IIFE and ignore the promise.
 *
 * Returns the resolution (daytona snapshot name + content hash). On
 * cache hit (row already `ready`) returns immediately with `built=false`.
 */
export async function buildSnapshotForCommit(
  project: GitBackedProject,
  options: {
    /** Branch / tag / SHA to resolve. Defaults to project default branch. */
    ref?: string;
    accountId: string;
    provider?: SandboxProviderName;
    source: SnapshotBuildSource;
  },
): Promise<SnapshotResolution> {
  const commitSha = await resolveCommitSha(project, options.ref);
  const provider = options.provider ?? 'daytona';
  const branch = options.ref ?? project.defaultBranch;

  const existing = await findSnapshotRow(project.projectId, commitSha, provider);
  if (existing?.status === 'ready' && existing.snapshotId) {
    // Cheap identity compare — no context materialize / gzip needed just to
    // confirm the existing ready row still matches this commit's inputs.
    const identity = await computeSnapshotIdentity(project, commitSha);
    if (
      existing.snapshotId === identity.snapshotName &&
      extractMetadataHash(existing.metadata) === identity.contentHash &&
      extractMetadataRuntimeFingerprint(existing.metadata) === identity.runtimeFingerprint
    ) {
      return {
        daytonaName: existing.snapshotId,
        commitSha,
        contentHash: identity.contentHash,
        runtimeFingerprint: identity.runtimeFingerprint,
        built: false,
      };
    }

    // Non-destructive rebuild: the row is `ready` with a still-bootable image
    // and we're only rebuilding because the runtime fingerprint changed. Keep
    // the old snapshot `ready`/bootable throughout (so "latest ready" never
    // blanks out for an existing project) and swap to the new image atomically
    // on success.
    const rebuildAt = extractMetadataNumber(existing.metadata, 'rebuildStartedAt');
    if (rebuildAt != null && Date.now() - rebuildAt < BUILD_TIMEOUT_MS) {
      // Another worker is already rebuilding this commit for the new runtime —
      // boot the existing (older-runtime) image now instead of duplicating it.
      return {
        daytonaName: existing.snapshotId,
        commitSha,
        contentHash: extractMetadataHash(existing.metadata) ?? identity.contentHash,
        runtimeFingerprint:
          extractMetadataRuntimeFingerprint(existing.metadata) ?? identity.runtimeFingerprint,
        built: false,
      };
    }
    // Claim the rebuild by stamping a marker — without disturbing status/snapshotId.
    await db
      .update(projectRuntimeSnapshots)
      .set({
        metadata: sql`COALESCE(${projectRuntimeSnapshots.metadata}, '{}'::jsonb) || ${JSON.stringify({ rebuildStartedAt: Date.now() })}::jsonb`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(projectRuntimeSnapshots.projectId, project.projectId),
          eq(projectRuntimeSnapshots.commitSha, commitSha),
          eq(projectRuntimeSnapshots.provider, provider),
        ),
      )
      .catch(() => {});

    try {
      const result = await runBuild(project, commitSha, provider, undefined, { silent: true });
      await updateSnapshotRow(project.projectId, commitSha, provider, options.source, result);
      return {
        daytonaName: result.daytonaName,
        commitSha,
        contentHash: result.contentHash,
        runtimeFingerprint: result.runtimeFingerprint,
        built: result.built,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Keep the old ready snapshot bootable; clear the rebuild marker and note
      // the error so a later attempt retries cleanly.
      await db
        .update(projectRuntimeSnapshots)
        .set({
          status: 'ready',
          error: message.slice(0, 2000),
          metadata: sql`(COALESCE(${projectRuntimeSnapshots.metadata}, '{}'::jsonb) - 'rebuildStartedAt')`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(projectRuntimeSnapshots.projectId, project.projectId),
            eq(projectRuntimeSnapshots.commitSha, commitSha),
            eq(projectRuntimeSnapshots.provider, provider),
          ),
        )
        .catch(() => {});
      throw new SnapshotBuildError(`Snapshot rebuild failed: ${message}`, err);
    }
  }
  if (existing?.status === 'building' || existing?.status === 'queued') {
    const recovered = await recoverBootableInProgressSnapshotRow(
      project,
      commitSha,
      provider,
      options.source,
      existing,
    );
    if (recovered) {
      return {
        daytonaName: recovered.daytonaName,
        commitSha,
        contentHash: recovered.contentHash,
        runtimeFingerprint: recovered.runtimeFingerprint,
        built: false,
      };
    }

    if (!isInProgressSnapshotStale(existing)) {
      // Another build is in flight for this exact commit. Don't race it.
      throw new SnapshotBuildError(
        `Snapshot build for commit ${commitSha.slice(0, 8)} is already in progress`,
      );
    }

    const staleRecovered = await recoverInProgressSnapshotRow(project, commitSha, provider, options.source, existing);
    if (staleRecovered) {
      return {
        daytonaName: staleRecovered.daytonaName,
        commitSha,
        contentHash: staleRecovered.contentHash,
        runtimeFingerprint: staleRecovered.runtimeFingerprint,
        built: false,
      };
    }
    await deleteSnapshotRow(project.projectId, commitSha, provider);
  } else if (existing?.status === 'failed') {
    // Retry from scratch — failures shouldn't pin a project forever.
    await deleteSnapshotRow(project.projectId, commitSha, provider);
  }

  // Claim the build by inserting `queued`. The unique (projectId,
  // commitSha, provider) constraint makes concurrent callers race so
  // exactly one wins; losers throw and the caller can no-op.
  try {
    await db.insert(projectRuntimeSnapshots).values({
      accountId: options.accountId,
      projectId: project.projectId,
      provider,
      commitSha,
      branch,
      status: 'queued',
      metadata: { source: options.source },
    });
  } catch {
    throw new SnapshotBuildError(
      `Lost race to claim snapshot build for ${commitSha.slice(0, 8)} — another worker has it`,
    );
  }

  try {
    const result = await runBuild(project, commitSha, provider);
    await updateSnapshotRow(project.projectId, commitSha, provider, options.source, result);
    return {
      daytonaName: result.daytonaName,
      commitSha,
      contentHash: result.contentHash,
      runtimeFingerprint: result.runtimeFingerprint,
      built: result.built,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markSnapshotFailed(project.projectId, commitSha, provider, message);
    throw new SnapshotBuildError(`Snapshot build failed: ${message}`, err);
  }
}

/**
 * Return the most recent `ready` snapshot for a project + branch +
 * provider, or null if none exists yet. Cheap — one indexed lookup.
 * Sessions read this to pick the image they boot from.
 */
export async function getLatestReadySnapshot(
  projectId: string,
  branch: string,
  provider: SandboxProviderName = 'daytona',
): Promise<typeof projectRuntimeSnapshots.$inferSelect | null> {
  const rows = await db
    .select()
    .from(projectRuntimeSnapshots)
    .where(
      and(
        eq(projectRuntimeSnapshots.projectId, projectId),
        eq(projectRuntimeSnapshots.branch, branch),
        eq(projectRuntimeSnapshots.provider, provider),
        eq(projectRuntimeSnapshots.status, 'ready'),
      ),
    )
    .orderBy(desc(projectRuntimeSnapshots.createdAt))
    .limit(10);
  if (provider === 'local_docker') {
    return rows[0] ?? null;
  }
  const bootableRows = await filterProviderBootableReadyRows(rows, provider);
  if (bootableRows.length === 0) return null;
  const runtimeFingerprint = await currentRuntimeArtifactFingerprint();
  const currentRuntimeRow = bootableRows.find((row) =>
    extractMetadataRuntimeFingerprint(row.metadata) === runtimeFingerprint
  );
  // Prefer a current-runtime image, but do not make an existing project
  // unusable while a runtime rebuild is pending/failed. A retained older
  // snapshot is still a valid degraded boot target.
  return currentRuntimeRow ?? bootableRows[0] ?? null;
}

export async function getSnapshotForCommit(
  projectId: string,
  commitSha: string,
  provider: SandboxProviderName = 'daytona',
): Promise<typeof projectRuntimeSnapshots.$inferSelect | null> {
  const [row] = await db
    .select()
    .from(projectRuntimeSnapshots)
    .where(
      and(
        eq(projectRuntimeSnapshots.projectId, projectId),
        eq(projectRuntimeSnapshots.commitSha, commitSha),
        eq(projectRuntimeSnapshots.provider, provider),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Return a ready, current-runtime snapshot for a concrete commit,
 * regardless of which branch/ref originally created the row.
 *
 * This is the legacy snapshot-table equivalent of the runtime-artifacts
 * spec's "find ready artifact by content hash/commit" lookup. It fixes
 * session boot for cases where branch B points at a commit that was already
 * built under branch A: the artifact exists, but there may be no row with
 * branch = B.
 */
export async function getReadySnapshotForCommit(
  projectId: string,
  commitSha: string,
  provider: SandboxProviderName = 'daytona',
): Promise<typeof projectRuntimeSnapshots.$inferSelect | null> {
  const row = await getSnapshotForCommit(projectId, commitSha, provider);
  if (row?.status !== 'ready' || !row.snapshotId) return null;
  if (!(await isProviderBootableSnapshot(row, provider))) return null;

  const runtimeFingerprint = await currentRuntimeArtifactFingerprint();
  if (extractMetadataRuntimeFingerprint(row.metadata) !== runtimeFingerprint) {
    return null;
  }

  return row;
}

async function filterProviderBootableReadyRows(
  rows: Array<typeof projectRuntimeSnapshots.$inferSelect>,
  provider: SandboxProviderName,
): Promise<Array<typeof projectRuntimeSnapshots.$inferSelect>> {
  if (provider !== 'daytona' || !isDaytonaConfigured()) return rows;
  const checks = await Promise.all(
    rows.map(async (row) => ({
      row,
      bootable: await isProviderBootableSnapshot(row, provider),
    })),
  );
  const bootable = checks.filter((check) => check.bootable).map((check) => check.row);
  const stale = checks.filter((check) => !check.bootable).map((check) => check.row);
  if (stale.length > 0) {
    console.warn(
      `[snapshots] Ignoring ${stale.length} ready DB snapshot row(s) missing from Daytona: ` +
      stale.map((r) => r.snapshotId).join(', '),
    );
  }
  return bootable;
}

async function isProviderBootableSnapshot(
  row: typeof projectRuntimeSnapshots.$inferSelect,
  provider: SandboxProviderName,
): Promise<boolean> {
  if (provider !== 'daytona' || !isDaytonaConfigured() || !row.snapshotId) return true;
  return (await getProviderSnapshotState(row.snapshotId)) === 'active';
}

type ProviderSnapshotState = 'active' | 'building' | 'missing' | 'error' | 'other';

async function getProviderSnapshotState(snapshotId: string): Promise<ProviderSnapshotState> {
  try {
    const snapshot = await getDaytona().snapshot.get(snapshotId);
    const state = String((snapshot as { state?: string } | null)?.state ?? '').toLowerCase();
    if (state === 'active') return 'active';
    if (state === 'building' || state === 'pending' || state === 'queued' || state === 'creating') {
      return 'building';
    }
    if (state === 'error' || state === 'build_failed' || state === 'failed') return 'error';
    return 'other';
  } catch (err) {
    return 'missing';
  }
}

function isInProgressSnapshotStale(row: typeof projectRuntimeSnapshots.$inferSelect): boolean {
  const updatedAt = row.updatedAt instanceof Date
    ? row.updatedAt.getTime()
    : new Date(row.updatedAt).getTime();
  if (!Number.isFinite(updatedAt)) return false;
  return Date.now() - updatedAt > BUILD_TIMEOUT_MS;
}

async function deleteSnapshotRow(
  projectId: string,
  commitSha: string,
  provider: SandboxProviderName,
): Promise<void> {
  await db
    .delete(projectRuntimeSnapshots)
    .where(
      and(
        eq(projectRuntimeSnapshots.projectId, projectId),
        eq(projectRuntimeSnapshots.commitSha, commitSha),
        eq(projectRuntimeSnapshots.provider, provider),
      ),
    );
}

/**
 * Fire-and-forget: ensure a snapshot exists for the current tip of
 * `branch`. Returns immediately if one is already present (`ready` or
 * `building`); otherwise spawns a detached build. Used by:
 *
 *   - Project creation (initial build).
 *   - Session start (check for newer commits without blocking the boot).
 *   - Manual UI trigger.
 *
 * Always resolves to a status code so callers can surface UI hints:
 *   - `already-ready`  → tip already has a ready snapshot
 *   - `already-building` → another worker is mid-build for this commit
 *   - `started`        → we kicked off a new build
 *   - `failed-to-start` → couldn't even resolve the commit / claim row
 */
export async function ensureBuildForLatestCommit(
  project: GitBackedProject,
  options: {
    branch?: string;
    accountId: string;
    provider?: SandboxProviderName;
    source: SnapshotBuildSource;
  },
): Promise<{
  status: 'already-ready' | 'already-building' | 'started' | 'failed-to-start';
  commitSha?: string;
  error?: string;
}> {
  const provider = options.provider ?? 'daytona';
  const branch = options.branch ?? project.defaultBranch;

  let commitSha: string;
  try {
    commitSha = await resolveCommitSha(project, branch);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: 'failed-to-start', error: message };
  }

  let existing: typeof projectRuntimeSnapshots.$inferSelect | null =
    await findSnapshotRow(project.projectId, commitSha, provider);
  if (existing?.status === 'failed') {
    // Manual/session retry must actually retry. The unique key is
    // (projectId, commitSha, provider), so leaving the failed row in place makes
    // the later insert lose the race while the API misleadingly reports
    // "started".
    await deleteSnapshotRow(project.projectId, commitSha, provider);
    existing = null;
  }
  if (existing?.status === 'ready') {
    const providerState =
      provider === 'daytona' && existing.snapshotId
        ? await getProviderSnapshotState(existing.snapshotId)
        : 'active';
    if (providerState === 'building') {
      console.warn(
        `[snapshots] Ready DB snapshot ${existing.snapshotId ?? '(missing id)'} for project ` +
        `${project.projectId} commit ${commitSha.slice(0, 8)} is still building in ${provider}; not duplicating`,
      );
      return { status: 'already-building', commitSha };
    }
    if (providerState !== 'active') {
      console.warn(
        `[snapshots] Ready DB snapshot ${existing.snapshotId ?? '(missing id)'} for project ` +
        `${project.projectId} commit ${commitSha.slice(0, 8)} is ${providerState} in ${provider}; rebuilding`,
      );
      await deleteSnapshotRow(project.projectId, commitSha, provider);
      existing = null;
    }
  }

  if (existing?.status === 'ready') {
    try {
      const runtimeFingerprint = await currentRuntimeArtifactFingerprint();
      if (extractMetadataRuntimeFingerprint(existing.metadata) === runtimeFingerprint) {
        return { status: 'already-ready', commitSha };
      }
      if (extractMetadataNumber(existing.metadata, 'rebuildStartedAt') != null) {
        return { status: 'already-building', commitSha };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { status: 'failed-to-start', commitSha, error: message };
    }

    // This commit has a ready image from an older runtime. Rebuild through the
    // non-destructive path in buildSnapshotForCommit(): it keeps the existing
    // snapshot bootable and swaps to the new image only after success. Falling
    // through to the insert path would hit the unique index and report a bogus
    // "failed to start" instead of actually rebuilding.
    void (async () => {
      try {
        await buildSnapshotForCommit(project, {
          ref: branch,
          accountId: options.accountId,
          provider,
          source: options.source,
        });
        pruneOldSnapshots(project.projectId, branch, provider).catch((err) => {
          console.warn(
            `[snapshots] prune failed for project ${project.projectId} branch ${branch}:`,
            err,
          );
        });
      } catch (err) {
        console.warn(
          `[snapshots] background rebuild failed for project ${project.projectId} ` +
          `commit ${commitSha.slice(0, 8)} (source=${options.source}):`,
          err,
        );
      }
    })();

    return { status: 'started', commitSha };
  }
  if (existing) {
    const recovered = await recoverBootableInProgressSnapshotRow(
      project,
      commitSha,
      provider,
      options.source,
      existing,
    );
    if (recovered) return { status: 'already-ready', commitSha };

    if (!isInProgressSnapshotStale(existing)) {
      return { status: 'already-building', commitSha };
    }

    const staleRecovered = await recoverInProgressSnapshotRow(project, commitSha, provider, options.source, existing);
    if (staleRecovered) return { status: 'already-ready', commitSha };
    await deleteSnapshotRow(project.projectId, commitSha, provider);
  }

  // Detach the build — we promised the caller this is non-blocking.
  void (async () => {
    try {
      await buildSnapshotForCommit(project, {
        ref: branch,
        accountId: options.accountId,
        provider,
        source: options.source,
      });
      // Successful build → prune older snapshots for this branch in the
      // background. Errors here are non-fatal; we'll log and move on.
      pruneOldSnapshots(project.projectId, branch, provider).catch((err) => {
        console.warn(
          `[snapshots] prune failed for project ${project.projectId} branch ${branch}:`,
          err,
        );
      });
    } catch (err) {
      // buildSnapshotForCommit already marked the row failed in the DB;
      // this just surfaces the error in server logs for diagnosis.
      console.warn(
        `[snapshots] background build failed for project ${project.projectId} ` +
        `commit ${commitSha.slice(0, 8)} (source=${options.source}):`,
        err,
      );
    }
  })();

  return { status: 'started', commitSha };
}

/**
 * Recover or clear snapshot builds that cannot still be owned by this process.
 *
 * Snapshot builds run in detached promises. If the API restarts while one is in
 * progress, the DB row remains `queued`/`building`, but the promise that would
 * eventually flip it to `ready` is gone. Waiting for the full build timeout here
 * makes the UI show "Building first sandbox" and makes sessions spin even
 * though no local worker is alive to finish the row.
 *
 * Startup is the one moment we know all previous in-process builders are dead,
 * so we reconcile every in-progress row immediately:
 *   - if the named Daytona snapshot is now active, mark the row `ready`;
 *   - otherwise mark it `failed` so the next session/retry starts a fresh build.
 */
export async function sweepStaleSnapshotBuilds(): Promise<number> {
  const rows = await db
    .select()
    .from(projectRuntimeSnapshots)
    .where(inArray(projectRuntimeSnapshots.status, ['building', 'queued']));

  let recovered = 0;
  let failed = 0;
  for (const row of rows) {
    if (row.snapshotId && (await isProviderBootableSnapshot(row, row.provider))) {
      await db
        .update(projectRuntimeSnapshots)
        .set({
          status: 'ready',
          error: null,
          updatedAt: new Date(),
        })
        .where(eq(projectRuntimeSnapshots.snapshotRowId, row.snapshotRowId));
      recovered += 1;
      continue;
    }

    await db
      .update(projectRuntimeSnapshots)
      .set({
        status: 'failed',
        error: 'build orphaned (API restart or timeout) - rebuilds on next use',
        metadata: sql`COALESCE(${projectRuntimeSnapshots.metadata}, '{}'::jsonb) || ${JSON.stringify({ errorCategory: 'timeout' as SnapshotErrorCategory })}::jsonb`,
        updatedAt: new Date(),
      })
      .where(eq(projectRuntimeSnapshots.snapshotRowId, row.snapshotRowId));
    failed += 1;
  }

  const swept = recovered + failed;
  if (swept > 0) {
    console.warn(`[snapshots] swept ${swept} in-progress build row(s) on startup`, { recovered, failed });
  }
  return swept;
}

/**
 * List snapshot history for a project, most recent first. Powers the
 * "Sandbox snapshot" panel in the dashboard.
 */
export async function listSnapshotsForProject(
  projectId: string,
  options: { limit?: number; provider?: SandboxProviderName } = {},
): Promise<Array<typeof projectRuntimeSnapshots.$inferSelect>> {
  const limit = Math.min(Math.max(options.limit ?? 25, 1), 100);
  return db
    .select()
    .from(projectRuntimeSnapshots)
    .where(
      and(
        eq(projectRuntimeSnapshots.projectId, projectId),
        eq(projectRuntimeSnapshots.provider, options.provider ?? 'daytona'),
      ),
    )
    .orderBy(desc(projectRuntimeSnapshots.createdAt))
    .limit(limit);
}

/**
 * Project-level sandbox health for the alert/badge surfaces. DB-only (no git
 * HEAD resolution) so it's cheap enough to poll from the project sidebar.
 *
 * The key signals the UI needs:
 *   - `readyCount`  → how many *healthy* (current-runtime) ready snapshots
 *     exist for the branch. ≥1 means sessions can boot (possibly degraded);
 *     0 means the project is one failed build away from being unusable.
 *   - `building`    → a build is actively in flight (not stale).
 *   - `latestStatus`→ status of the most recent row for the branch.
 *   - `failure`     → present when the most recent build failed, carrying the
 *     classified category so the UI can show "retry" vs "fix with agent".
 */
export interface ProjectSandboxHealth {
  branch: string;
  provider: SandboxProviderName;
  /** Retained ready snapshots for the branch (any runtime) — what's kept as a fallback. */
  readyCount: number;
  /** Ready snapshots matching the CURRENT runtime — bootable for HEAD without a rebuild. */
  bootableCount: number;
  /** Total snapshot rows for the branch (any status) — 0 means the project never built. */
  totalCount: number;
  /** Configured retention target. */
  retention: number;
  /** ≥1 retained ready snapshot exists → a session can boot (possibly an older runtime). */
  healthy: boolean;
  /** A build is in flight (queued/building, not stale), or a ready row is rebuilding in place. */
  building: boolean;
  /** True the very first time a project builds (no rows yet). Distinguishes "first" from "updating". */
  firstBuild: boolean;
  /** Retained ready snapshots exist but none match the current runtime — a refresh is pending. */
  runtimeOutdated: boolean;
  /** SHA of the most recent ready snapshot, or null. */
  latestReadyCommitSha: string | null;
  /** Most recent row's status for the branch, or null when none exist. */
  latestStatus: ProjectSnapshotStatusValue | null;
  /** Present when the most recent build for the branch failed. */
  failure: {
    commitSha: string;
    error: string;
    category: SnapshotErrorCategory;
    fixableByAgent: boolean;
    failedAt: string;
  } | null;
}

type ProjectSnapshotStatusValue = typeof projectRuntimeSnapshots.$inferSelect['status'];

export async function getProjectSandboxHealth(
  projectId: string,
  branch: string,
  provider: SandboxProviderName = 'daytona',
): Promise<ProjectSandboxHealth> {
  const retention = snapshotRetentionCount();
  const runtimeFingerprint = await currentRuntimeArtifactFingerprint().catch(() => null);

  const rows = await db
    .select()
    .from(projectRuntimeSnapshots)
    .where(
      and(
        eq(projectRuntimeSnapshots.projectId, projectId),
        eq(projectRuntimeSnapshots.branch, branch),
        eq(projectRuntimeSnapshots.provider, provider),
      ),
    )
    .orderBy(desc(projectRuntimeSnapshots.createdAt))
    .limit(50);

  // Retained = every ready snapshot (any runtime). These are real, kept builds —
  // counting only current-runtime ones made an existing project read as "0
  // retained / building first sandbox" right after a runtime bump, which looked
  // like builds were vanishing. Bootable = the subset that matches the current
  // runtime (boots HEAD with no rebuild).
  const readyRows = rows.filter((r) => r.status === 'ready' && r.snapshotId);
  const bootableRows =
    runtimeFingerprint === null
      ? readyRows
      : readyRows.filter((r) => extractMetadataRuntimeFingerprint(r.metadata) === runtimeFingerprint);
  // A ready row carrying a `rebuildStartedAt` marker is mid non-destructive
  // rebuild (still bootable) — surface that as "building" too.
  const building = rows.some(
    (r) =>
      ((r.status === 'building' || r.status === 'queued') && !isInProgressSnapshotStale(r)) ||
      (r.status === 'ready' && extractMetadataNumber(r.metadata, 'rebuildStartedAt') != null),
  );

  const latest = rows[0] ?? null;
  let failure: ProjectSandboxHealth['failure'] = null;
  if (latest && latest.status === 'failed') {
    const message = latest.error ?? 'Snapshot build failed';
    const category =
      extractMetadataErrorCategory(latest.metadata) ?? classifySnapshotError(message);
    failure = {
      commitSha: latest.commitSha,
      error: message,
      category,
      fixableByAgent: describeSnapshotError(category).fixableByAgent,
      failedAt: (latest.updatedAt instanceof Date
        ? latest.updatedAt
        : new Date(latest.updatedAt)
      ).toISOString(),
    };
  }

  return {
    branch,
    provider,
    readyCount: Math.min(readyRows.length, retention),
    bootableCount: Math.min(bootableRows.length, retention),
    totalCount: rows.length,
    retention,
    healthy: readyRows.length > 0,
    building,
    // "First build" only when no usable ready snapshot has *ever* been produced
    // — so an existing project rebuilding for a runtime bump reads as "updating",
    // not "building first sandbox".
    firstBuild: rows.length === 0,
    runtimeOutdated: readyRows.length > 0 && bootableRows.length === 0,
    latestReadyCommitSha: readyRows[0]?.commitSha ?? null,
    latestStatus: latest?.status ?? null,
    failure,
  };
}

/**
 * Retention: keep the N most-recent `ready` snapshots for
 * (projectId, branch, provider); delete the rest from the DB and (when
 * safe) the Daytona side too.
 *
 * Reference-safety: snapshot names are content-addressed, so two
 * different commits can share the same `snapshotId` (same Dockerfile +
 * tree → same hash). We only remove the Daytona snapshot when *no other
 * surviving DB row* (across any branch in the project) still references
 * that same `snapshotId`. Without this guard, pruning an old branch row
 * would yank the image out from under a `ready` row on the default
 * branch.
 */
export async function pruneOldSnapshots(
  projectId: string,
  branch: string,
  provider: SandboxProviderName = 'daytona',
  retain: number = snapshotRetentionCount(),
): Promise<{ deletedRows: number; deletedDaytonaSnapshots: number }> {
  const readyRows = await db
    .select()
    .from(projectRuntimeSnapshots)
    .where(
      and(
        eq(projectRuntimeSnapshots.projectId, projectId),
        eq(projectRuntimeSnapshots.branch, branch),
        eq(projectRuntimeSnapshots.provider, provider),
        eq(projectRuntimeSnapshots.status, 'ready'),
      ),
    )
    .orderBy(desc(projectRuntimeSnapshots.createdAt));

  const expired = readyRows.slice(retain);
  if (expired.length === 0) {
    return { deletedRows: 0, deletedDaytonaSnapshots: 0 };
  }

  const expiredRowIds = expired.map((r) => r.snapshotRowId);
  const expiredSnapshotIds = Array.from(
    new Set(expired.map((r) => r.snapshotId).filter((s): s is string => Boolean(s))),
  );

  await db
    .delete(projectRuntimeSnapshots)
    .where(inArray(projectRuntimeSnapshots.snapshotRowId, expiredRowIds));

  // For each expired Daytona snapshot, check whether any *surviving* row
  // in the same project still references it. Only delete from Daytona
  // when no references remain. Cross-project sharing isn't possible
  // because snapshot names are project-scoped.
  let deletedDaytonaSnapshots = 0;
  if (provider === 'daytona' && expiredSnapshotIds.length > 0) {
    const daytona = getDaytona();
    for (const snapshotId of expiredSnapshotIds) {
      const stillReferenced = await db
        .select({ id: projectRuntimeSnapshots.snapshotRowId })
        .from(projectRuntimeSnapshots)
        .where(
          and(
            eq(projectRuntimeSnapshots.projectId, projectId),
            eq(projectRuntimeSnapshots.provider, provider),
            eq(projectRuntimeSnapshots.snapshotId, snapshotId),
          ),
        )
        .limit(1);
      if (stillReferenced.length > 0) continue;

      try {
        // SDK requires the full Snapshot object — fetch by name first,
        // then delete. If the get() throws "not found", the snapshot is
        // already gone (race with manual cleanup or a previous prune
        // attempt) and there's nothing to do.
        const snapshot = await daytona.snapshot.get(snapshotId).catch(() => null);
        if (snapshot) {
          await daytona.snapshot.delete(snapshot);
          deletedDaytonaSnapshots += 1;
        }
      } catch (err) {
        // Best-effort: any other failure we log and move on so retention
        // doesn't get stuck on a single bad snapshot.
        console.warn(
          `[snapshots] Daytona snapshot.delete('${snapshotId}') failed (continuing):`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  return { deletedRows: expired.length, deletedDaytonaSnapshots };
}

/** Content-addressed name prefix for every per-project session snapshot. */
const SNAPSHOT_NAME_PREFIX = 'kortix-snap-';

/**
 * Org-wide ceiling on how many `ready` per-project snapshots we let pile up on
 * Daytona. Daytona enforces a HARD global cap (100/org); per-project retention
 * (`DEFAULT_SNAPSHOT_RETENTION`, keep-N each) can't bound a *global* total —
 * N projects × keep-5 blows past 100. This budget is the real bound: stay
 * comfortably under the provider cap so a runtime-fingerprint bump (which
 * rebuilds every project at once) has headroom. Tunable via
 * `KORTIX_SNAPSHOT_GLOBAL_BUDGET`.
 */
const DEFAULT_GLOBAL_SNAPSHOT_BUDGET = 80;

function globalSnapshotBudget(): number {
  const raw = Number.parseInt(process.env.KORTIX_SNAPSHOT_GLOBAL_BUDGET || '', 10);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return DEFAULT_GLOBAL_SNAPSHOT_BUDGET;
}

/** Stale `failed` rows older than this are swept (a fresh build re-creates them). */
const FAILED_ROW_TTL_MS = 24 * 60 * 60 * 1000;

function rowUpdatedMs(row: { updatedAt: Date | string }): number {
  const t = row.updatedAt instanceof Date ? row.updatedAt.getTime() : new Date(row.updatedAt).getTime();
  return Number.isFinite(t) ? t : 0;
}

let reconcileRunning = false;

/**
 * Org-wide snapshot reconciliation — the global counterpart to the per-project
 * `pruneOldSnapshots`. Idempotent, best-effort, safe to run on a timer.
 *
 *   1. ORPHANS: Daytona snapshots named `kortix-snap-*` that no `ready` DB row
 *      references — leaked when a rebuild/version-bump replaced a row's
 *      snapshotId without deleting the old image. Deleted from Daytona.
 *   2. DEAD ROWS: DB rows marked `ready` whose image is gone from Daytona.
 *      Deleted so the next session rebuilds cleanly instead of booting a 404.
 *   3. GLOBAL BUDGET: if more than `budget` ready snapshots survive, evict the
 *      globally least-recently-updated ones (DB row + image) — never a
 *      project's most-recent row, so every project stays bootable.
 *   4. STALE FAILURES: `failed` rows older than `FAILED_ROW_TTL_MS`.
 *
 * Refuses to delete anything if the Daytona snapshot list can't be fetched
 * (never act on a partial view). No-op when Daytona isn't configured.
 */
export async function reconcileDaytonaSnapshots(opts: { budget?: number } = {}): Promise<{
  orphansDeleted: number;
  deadRowsCleared: number;
  evicted: number;
  failedCleared: number;
  liveBefore: number;
}> {
  const noop = { orphansDeleted: 0, deadRowsCleared: 0, evicted: 0, failedCleared: 0, liveBefore: 0 };
  if (!isDaytonaConfigured() || reconcileRunning) return noop;
  reconcileRunning = true;
  try {
    // Throws if the list is unavailable — we never delete based on a partial view.
    const live = (await listDaytonaSnapshots()).filter((s) => s.name.startsWith(SNAPSHOT_NAME_PREFIX));
    const liveByName = new Map(live.map((s) => [s.name, s]));
    const liveBefore = live.length;

    const snapshotRows = await db
      .select()
      .from(projectRuntimeSnapshots)
      .where(
        and(
          eq(projectRuntimeSnapshots.provider, 'daytona'),
          inArray(projectRuntimeSnapshots.status, ['queued', 'building', 'ready']),
        ),
      );

    const readyRows = snapshotRows.filter((row) => row.status === 'ready');
    const referenced = new Set(
      snapshotRows.map((r) => r.snapshotId).filter((s): s is string => Boolean(s)),
    );

    // 1. Orphans — on Daytona, named like ours, unreferenced.
    let orphansDeleted = 0;
    for (const snap of live) {
      if (referenced.has(snap.name)) continue;
      if (await deleteDaytonaSnapshotById(snap.id)) orphansDeleted += 1;
    }

    // 2. Dead cache rows — `ready` but the image no longer exists.
    //
    // Daytona's REST list endpoint is not authoritative for snapshots created
    // through the SDK in all regions/targets. We have observed `snapshot.get()`
    // and sandbox create-by-name succeed for a snapshot that was absent from
    // `/snapshots`, which made this reconciler delete the only ready DB row and
    // forced the next session back through the slow build/recovery path. Treat
    // the list as an optimization only: if a ready row is missing from the list,
    // verify it with the same provider lookup used by session boot before
    // clearing the row.
    const readyChecks = await Promise.all(
      readyRows.map(async (row) => {
        if (!row.snapshotId) return { row, bootable: false };
        if (liveByName.has(row.snapshotId)) return { row, bootable: true };
        return { row, bootable: await isProviderBootableSnapshot(row, row.provider) };
      }),
    );
    const deadRowIds = readyChecks
      .filter((check) => !check.bootable)
      .map((check) => check.row.snapshotRowId);
    if (deadRowIds.length > 0) {
      await db
        .delete(projectRuntimeSnapshots)
        .where(inArray(projectRuntimeSnapshots.snapshotRowId, deadRowIds));
    }

    // 3. Global budget — evict oldest-updated surviving rows beyond the cap,
    //    keeping each project's most-recent row as a protected floor.
    const deadSet = new Set(deadRowIds);
    const surviving = readyChecks
      .filter((check) => check.bootable && !deadSet.has(check.row.snapshotRowId))
      .map((check) => check.row);
    const budget = opts.budget ?? globalSnapshotBudget();
    let evicted = 0;
    if (surviving.length > budget) {
      const newestPerProject = new Map<string, string>();
      for (const r of [...surviving].sort((a, b) => rowUpdatedMs(b) - rowUpdatedMs(a))) {
        if (!newestPerProject.has(r.projectId)) newestPerProject.set(r.projectId, r.snapshotRowId);
      }
      const evictRows = [...surviving]
        .filter((r) => newestPerProject.get(r.projectId) !== r.snapshotRowId)
        .sort((a, b) => rowUpdatedMs(a) - rowUpdatedMs(b))
        .slice(0, surviving.length - budget);
      const evictRowIds = new Set(evictRows.map((r) => r.snapshotRowId));
      // Images still pointed at by a surviving (non-evicted) row must not be deleted.
      const keptRefs = new Set(
        surviving
          .filter((r) => !evictRowIds.has(r.snapshotRowId))
          .map((r) => r.snapshotId)
          .filter((s): s is string => Boolean(s)),
      );
      if (evictRowIds.size > 0) {
        await db
          .delete(projectRuntimeSnapshots)
          .where(inArray(projectRuntimeSnapshots.snapshotRowId, [...evictRowIds]));
        for (const sid of new Set(evictRows.map((r) => r.snapshotId).filter((s): s is string => Boolean(s)))) {
          if (keptRefs.has(sid)) continue;
          const snap = liveByName.get(sid);
          if (snap) await deleteDaytonaSnapshotById(snap.id);
        }
        evicted = evictRowIds.size;
      }
    }

    // 4. Stale failed rows.
    const failed = await db
      .delete(projectRuntimeSnapshots)
      .where(
        and(
          eq(projectRuntimeSnapshots.status, 'failed'),
          lt(projectRuntimeSnapshots.updatedAt, new Date(Date.now() - FAILED_ROW_TTL_MS)),
        ),
      )
      .returning({ id: projectRuntimeSnapshots.snapshotRowId });

    const result = {
      orphansDeleted,
      deadRowsCleared: deadRowIds.length,
      evicted,
      failedCleared: failed.length,
      liveBefore,
    };
    if (orphansDeleted || result.deadRowsCleared || evicted || result.failedCleared) {
      console.log('[snapshots] reconcile', { ...result, budget });
    }
    return result;
  } finally {
    reconcileRunning = false;
  }
}

/* ─── Internals ────────────────────────────────────────────────────────── */

interface BuildOutcome {
  daytonaName: string;
  contentHash: string;
  shortHash: string;
  runtimeFingerprint: string;
  built: boolean;
}

async function runBuild(
  project: GitBackedProject,
  commitSha: string,
  provider: SandboxProviderName,
  prepared?: PreparedContext,
  opts: { silent?: boolean } = {},
): Promise<BuildOutcome> {
  // `silent` = non-destructive rebuild: the row is currently `ready` with a
  // still-bootable snapshot (we're only rebuilding because the runtime
  // fingerprint changed). Keep it `ready` and avoid the progress writes that
  // would overwrite the live snapshotId — sessions keep booting the old image
  // until the new one is swapped in atomically by updateSnapshotRow on success.
  if (!opts.silent) {
    // Flip to `building` first so concurrent waiters can distinguish "in
    // progress" from "queued and stuck". Best-effort — if the update misses
    // (row vanished, db blip), the build still proceeds.
    await db
      .update(projectRuntimeSnapshots)
      .set({ status: 'building', updatedAt: new Date() })
      .where(
        and(
          eq(projectRuntimeSnapshots.projectId, project.projectId),
          eq(projectRuntimeSnapshots.commitSha, commitSha),
          eq(projectRuntimeSnapshots.provider, provider),
        ),
      )
      .catch(() => {});
  }

  // Daytona is the only provider with a build path today. New providers
  // can be added here as cases; the rest of the function stays the same.
  if (provider !== 'daytona') {
    throw new SnapshotBuildError(
      `snapshot builder not implemented for provider '${provider}'`,
    );
  }
  const daytona = getDaytona();

  // Identity-first: compute the cheap content-addressed name and probe the
  // registry BEFORE materializing the repo context / gzipping the ~99MB agent
  // binary. A content-hash hit (unchanged Dockerfile + deps — the common case
  // on every new code commit) returns here in well under a second.
  const identity = prepared ? null : await computeSnapshotIdentity(project, commitSha);
  const snapshotName = prepared ? prepared.snapshotName : identity!.snapshotName;
  if (await getUsableSnapshot(daytona, snapshotName)) {
    return {
      daytonaName: snapshotName,
      contentHash: prepared ? prepared.contentHash : identity!.contentHash,
      shortHash: prepared ? prepared.shortHash : identity!.shortHash,
      runtimeFingerprint: prepared ? prepared.runtimeFingerprint : identity!.runtimeFingerprint,
      built: false,
    };
  }

  // Cache miss — now pay for the expensive context (or reuse the caller's).
  const ctx = prepared ?? await prepareBuildContext(project, commitSha, identity!);
  try {
    if (!opts.silent) {
      await updateBuildingSnapshotStage(project.projectId, commitSha, provider, {
        snapshotId: ctx.snapshotName,
        stage: 'uploading-context',
        contentHash: ctx.contentHash,
        shortHash: ctx.shortHash,
        runtimeFingerprint: ctx.runtimeFingerprint,
        message: 'Uploading Daytona snapshot build context',
      });
    }

    // Daytona snapshot builds intermittently drop the control connection
    // ("Your socket connection ... idle connections will be closed"), a
    // transient gateway error that otherwise hard-fails the whole session
    // (build failures aren't retried by the provision loop). Retry transient
    // failures, and after any failure re-check the registry first — the socket
    // can drop AFTER the image finished building server-side.
    // A custom `[sandbox]` spec is baked into the snapshot here — Daytona
    // inherits a sandbox's resources from its snapshot, so this is the one
    // place they can be set. Empty spec → omit `resources` and take the
    // provider default.
    const resources = sandboxSpecIsEmpty(ctx.spec) ? undefined : ctx.spec;
    if (resources) {
      console.info(
        `[snapshots] ${ctx.snapshotName}: building with custom spec ${JSON.stringify(resources)}`,
      );
    }

    let lastErr: unknown;
    let quotaRecovered = false;
    for (let attempt = 1; attempt <= BUILD_ATTEMPTS; attempt++) {
      const buildLogs: string[] = [];
      try {
        await withTimeout(daytona.snapshot.create(
          {
            name: ctx.snapshotName,
            image: Image.fromDockerfile(ctx.composedPath),
            entrypoint: ['/usr/local/bin/kortix-entrypoint'],
            ...(resources ? { resources } : {}),
          },
          {
            timeout: Math.floor(BUILD_TIMEOUT_MS / 1000),
            onLogs: (chunk) => {
              const line = chunk.trim();
              if (!line) return;
              buildLogs.push(line);
              if (buildLogs.length > SNAPSHOT_LOG_TAIL_LIMIT) {
                buildLogs.splice(0, buildLogs.length - SNAPSHOT_LOG_TAIL_LIMIT);
              }
              console.info(`[snapshots] ${ctx.snapshotName}: ${line}`);
              if (!opts.silent) {
                void updateBuildingSnapshotStage(project.projectId, commitSha, provider, {
                  snapshotId: ctx.snapshotName,
                  stage: 'building-image',
                  contentHash: ctx.contentHash,
                  shortHash: ctx.shortHash,
                  runtimeFingerprint: ctx.runtimeFingerprint,
                  message: line,
                  logs: buildLogs,
                });
              }
            },
          },
        ), BUILD_TIMEOUT_MS, `Snapshot ${ctx.snapshotName} build timed out after ${Math.round(BUILD_TIMEOUT_MS / 1000)}s`);
        await waitForUsableSnapshot(daytona, ctx.snapshotName);
        return {
          daytonaName: ctx.snapshotName,
          contentHash: ctx.contentHash,
          shortHash: ctx.shortHash,
          runtimeFingerprint: ctx.runtimeFingerprint,
          built: true,
        };
      } catch (err) {
        lastErr = err;
        // The connection may have dropped after the build actually completed —
        // if the snapshot is now active, treat it as success. getUsableSnapshot
        // also reaps an errored/build_failed snapshot so the retry rebuilds
        // clean instead of seeing it as a (poisoned) cache hit.
        if (await getUsableSnapshot(daytona, ctx.snapshotName)) {
          return {
            daytonaName: ctx.snapshotName,
            contentHash: ctx.contentHash,
            shortHash: ctx.shortHash,
            runtimeFingerprint: ctx.runtimeFingerprint,
            built: true,
          };
        }
        if (isSnapshotAlreadyExistsError(err)) {
          const reaped = await reapUnusableSnapshot(daytona, ctx.snapshotName);
          if (reaped === 'active') {
            return {
              daytonaName: ctx.snapshotName,
              contentHash: ctx.contentHash,
              shortHash: ctx.shortHash,
              runtimeFingerprint: ctx.runtimeFingerprint,
              built: true,
            };
          }
          if (reaped === 'deleted') {
            console.warn(`[snapshots] deleted non-active existing snapshot ${ctx.snapshotName} after create conflict; retrying`);
            attempt--;
            continue;
          }
        }
        // Org-wide snapshot quota hit — reclaim orphaned / over-budget
        // snapshots once, then retry. Without this the cap is a death-spiral:
        // builds fail, so per-project prune (which only runs after a *successful*
        // build) never runs, so the quota never frees. Don't burn an attempt on
        // the pre-reconcile failure.
        if (isQuotaError(err) && !quotaRecovered) {
          quotaRecovered = true;
          const rec = await reconcileDaytonaSnapshots().catch(() => null);
          console.warn(`[snapshots] quota hit building ${ctx.snapshotName}; reconciled ${JSON.stringify(rec)} — retrying`);
          attempt--;
          continue;
        }
        if (!isTransientDaytonaError(err) || attempt === BUILD_ATTEMPTS) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[snapshots] build attempt ${attempt}/${BUILD_ATTEMPTS} for ${ctx.snapshotName} failed transiently — retrying: ${msg.slice(0, 120)}`);
        await new Promise((r) => setTimeout(r, BUILD_RETRY_BASE_MS * attempt));
      }
    }
    throw lastErr;
  } finally {
    await rm(ctx.contextDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function reapUnusableSnapshot(
  daytona: ReturnType<typeof getDaytona>,
  name: string,
): Promise<'active' | 'deleted' | 'missing'> {
  const snap = await daytona.snapshot.get(name).catch(() => null);
  if (!snap) return 'missing';
  const state = String((snap as { state?: string }).state ?? '').toLowerCase();
  if (state === 'active') return 'active';
  await daytona.snapshot.delete(snap).catch(() => {});
  return 'deleted';
}

/**
 * Return true only if a content-addressed snapshot already exists AND is usable
 * (`active`). Snapshots are content-addressed, so a build that errored leaves a
 * snapshot in `error`/`build_failed` under the SAME name — without this guard it
 * would be reused forever as a false cache hit (every session then fails with
 * "Snapshot … is error"). Reap those so the build runs fresh.
 */
async function getUsableSnapshot(
  daytona: ReturnType<typeof getDaytona>,
  name: string,
): Promise<boolean> {
  try {
    const snap = await daytona.snapshot.get(name);
    if (!snap) return false;
    const state = String((snap as { state?: string }).state ?? '').toLowerCase();
    if (state === 'active') return true;
    if (state === 'error' || state === 'build_failed') {
      await daytona.snapshot.delete(snap).catch(() => {});
    }
    return false;
  } catch {
    return false; // not found / transient — treat as absent, caller proceeds to build
  }
}

async function waitForUsableSnapshot(
  daytona: ReturnType<typeof getDaytona>,
  name: string,
): Promise<void> {
  const deadline = Date.now() + 120_000;
  let lastState = 'unknown';
  while (Date.now() < deadline) {
    try {
      const snap = await daytona.snapshot.get(name);
      lastState = String((snap as { state?: string } | null)?.state ?? 'missing').toLowerCase();
      if (lastState === 'active') return;
      if (lastState === 'error' || lastState === 'build_failed') {
        throw new Error(`Snapshot ${name} is ${lastState}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('build_failed') || message.includes('error')) throw err;
      lastState = message.slice(0, 120) || 'lookup failed';
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Snapshot ${name} did not become active after create (last state: ${lastState})`);
}

/** Org-wide snapshot quota exhaustion — recoverable by reconciling first. */
function isQuotaError(err: unknown): boolean {
  const m = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return m.includes('quota') || m.includes('maximum allowed');
}

function isSnapshotAlreadyExistsError(err: unknown): boolean {
  const m = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return m.includes('snapshot with name') && m.includes('already exists');
}

/** Transient Daytona build/transport errors worth retrying (vs a real build failure). */
function isTransientDaytonaError(err: unknown): boolean {
  const m = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    m.includes('socket connection') ||
    m.includes('idle connection') ||
    m.includes('not read from or written to') ||
    m.includes('socket hang up') ||
    (m.includes('snapshot with name') && m.includes('not found')) ||
    m.includes('timeout') ||
    m.includes('timed out') ||
    m.includes('econnreset') ||
    m.includes('econnrefused') ||
    m.includes('etimedout') ||
    m.includes('eof') ||
    m.includes('network') ||
    m.includes('gateway') ||
    m.includes(' 502') || m.includes(' 503') || m.includes(' 504')
  );
}

async function updateBuildingSnapshotStage(
  projectId: string,
  commitSha: string,
  provider: SandboxProviderName,
  build: {
    snapshotId: string;
    stage: 'uploading-context' | 'building-image';
    contentHash: string;
    shortHash: string;
    runtimeFingerprint: string;
    message: string;
    logs?: string[];
  },
): Promise<void> {
  const metadata: Record<string, unknown> = {
    stage: build.stage,
    contentHash: build.contentHash,
    shortHash: build.shortHash,
    runtimeFingerprint: build.runtimeFingerprint,
    sandboxVersion: SANDBOX_VERSION,
    lastMessage: build.message,
    updatedAt: new Date().toISOString(),
  };
  if (build.logs?.length) {
    metadata.logs = build.logs;
  }
  await db
    .update(projectRuntimeSnapshots)
    .set({
      snapshotId: build.snapshotId,
      metadata,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(projectRuntimeSnapshots.projectId, projectId),
        eq(projectRuntimeSnapshots.commitSha, commitSha),
        eq(projectRuntimeSnapshots.provider, provider),
      ),
    )
    .catch(() => {});
}

async function recoverInProgressSnapshotRow(
  project: GitBackedProject,
  commitSha: string,
  provider: SandboxProviderName,
  source: SnapshotBuildSource,
  row: typeof projectRuntimeSnapshots.$inferSelect,
): Promise<BuildOutcome | null> {
  if (provider !== 'daytona') return null;

  const ctx = await prepareBuildContext(project, commitSha);
  try {
    const expectedName = ctx.snapshotName;
    const rowSnapshotId = row.snapshotId?.trim();
    if (rowSnapshotId && rowSnapshotId !== expectedName) return null;

    const daytona = getDaytona();
    const existing = await daytona.snapshot.get(expectedName).catch(() => null);
    if (!existing) return null;
    if (String((existing as { state?: string }).state ?? '').toLowerCase() !== 'active') return null;

    const outcome: BuildOutcome = {
      daytonaName: expectedName,
      contentHash: ctx.contentHash,
      shortHash: ctx.shortHash,
      runtimeFingerprint: ctx.runtimeFingerprint,
      built: false,
    };
    await updateSnapshotRow(project.projectId, commitSha, provider, source, outcome);
    return outcome;
  } finally {
    await rm(ctx.contextDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function recoverBootableInProgressSnapshotRow(
  project: GitBackedProject,
  commitSha: string,
  provider: SandboxProviderName,
  source: SnapshotBuildSource,
  row: typeof projectRuntimeSnapshots.$inferSelect,
): Promise<BuildOutcome | null> {
  if (provider !== 'daytona' || !row.snapshotId) return null;

  const identity = await computeSnapshotIdentity(project, commitSha);
  if (row.snapshotId.trim() !== identity.snapshotName) return null;

  if (!(await getUsableSnapshot(getDaytona(), identity.snapshotName))) return null;

  const outcome: BuildOutcome = {
    daytonaName: identity.snapshotName,
    contentHash: identity.contentHash,
    shortHash: identity.shortHash,
    runtimeFingerprint: identity.runtimeFingerprint,
    built: false,
  };
  await updateSnapshotRow(project.projectId, commitSha, provider, source, outcome);
  return outcome;
}

/**
 * Shared prepare-step used by every build path: materializes the git
 * context to a tmpdir, copies the kortix-agent + entrypoint, composes the
 * layered Dockerfile, computes the content-addressed snapshot name.
 */
interface PreparedContext {
  contextDir: string;
  composedPath: string;
  snapshotName: string;
  contentHash: string;
  shortHash: string;
  runtimeFingerprint: string;
  /** Hardware spec to bake into the Daytona snapshot ({} == provider default). */
  spec: SandboxSpec;
}

interface SnapshotIdentity {
  snapshotName: string;
  contentHash: string;
  shortHash: string;
  runtimeFingerprint: string;
  /** Repo subdir used as the build context (null == repo root). */
  contextSubdir: string | null;
  userDockerfile: string;
  /** Hardware spec from `[sandbox]` ({} == provider default). */
  spec: SandboxSpec;
}

/**
 * Cheap half of the prepare step: read the project's Dockerfile + tree oid and
 * compute the content-addressed snapshot name. Deliberately does NOT touch the
 * ~99MB agent binary or materialize the repo context — callers check whether
 * the image already exists (a content-hash cache hit) before paying for the
 * gzip + tarball, which is the common case on every new code commit.
 */
async function computeSnapshotIdentity(
  project: GitBackedProject,
  commitSha: string,
): Promise<SnapshotIdentity> {
  const { paths: sandboxPaths, spec } = await resolveSandboxConfig(project, commitSha);
  const userDockerfile = normalizeUserDockerfileForSnapshot(
    await readRepoFile(project, sandboxPaths.dockerfile, commitSha),
  );
  if (!userDockerfile.trim()) {
    throw new SnapshotBuildError(
      `Empty Dockerfile at ${sandboxPaths.dockerfile} (commit ${commitSha.slice(0, 8)})`,
    );
  }
  const contextSubdir = sandboxPaths.context === '.' ? null : sandboxPaths.context;
  const contextTreeOid = await resolveTreeOid(project, commitSha, contextSubdir);
  const runtimeFingerprint = await currentRuntimeArtifactFingerprint();
  const hash = computeSnapshotHash({
    dockerfile: userDockerfile,
    contextTreeOid,
    spec,
    runtimeFingerprint,
  });
  return {
    snapshotName: formatSnapshotName(project.projectId, hash.contentHash),
    contentHash: hash.contentHash,
    shortHash: hash.shortHash,
    runtimeFingerprint,
    contextSubdir,
    userDockerfile,
    spec,
  };
}

/**
 * Expensive half: materialize the git context, stage the kortix-agent binary
 * (gzip ~99MB) + CLI/SDK, and compose the layered Dockerfile. Only call this
 * when an actual image build is required — runBuild() checks the snapshot
 * registry first and reaches here only on a miss.
 */
async function prepareBuildContext(
  project: GitBackedProject,
  commitSha: string,
  identity?: SnapshotIdentity,
): Promise<PreparedContext> {
  const id = identity ?? await computeSnapshotIdentity(project, commitSha);
  await assertExists(AGENT_BIN_PATH, 'KORTIX_SNAPSHOT_AGENT_BIN_PATH');
  await assertExists(ENTRYPOINT_PATH, 'KORTIX_SNAPSHOT_ENTRYPOINT_PATH');
  await assertExistsDir(AGENT_CLI_SRC_PATH, 'KORTIX_SNAPSHOT_AGENT_CLI_PATH');
  await assertExistsDir(EXECUTOR_SDK_SRC_PATH, 'KORTIX_SNAPSHOT_EXECUTOR_SDK_PATH');

  const contextDir = await materializeRepoContext(project, commitSha, id.contextSubdir);
  await materializeRepoCheckoutTar(project, commitSha, join(contextDir, 'kortix-workspace.tar.gz'));
  await gzipFile(AGENT_BIN_PATH, join(contextDir, 'kortix-agent.gz'));
  await copyFile(ENTRYPOINT_PATH, join(contextDir, 'kortix-entrypoint'));
  await cp(AGENT_CLI_SRC_PATH, join(contextDir, 'kortix-agent-cli'), { recursive: true });
  await cp(EXECUTOR_SDK_SRC_PATH, join(contextDir, 'kortix-executor-sdk'), { recursive: true });

  const composedPath = join(contextDir, '.kortix-snapshot.Dockerfile');
  const composed = buildLayeredDockerfile({
    userDockerfile: id.userDockerfile,
    opencodeVersion: OPENCODE_VERSION,
    agentBrowserVersion: AGENT_BROWSER_VERSION,
    agentBinaryPath: 'kortix-agent.gz',
    entrypointScriptPath: 'kortix-entrypoint',
    agentCliPath: 'kortix-agent-cli',
    executorSdkPath: 'kortix-executor-sdk',
    workspaceArchivePath: 'kortix-workspace.tar.gz',
  });
  await Bun.write(composedPath, composed);

  return {
    contextDir,
    composedPath,
    snapshotName: id.snapshotName,
    contentHash: id.contentHash,
    shortHash: id.shortHash,
    runtimeFingerprint: id.runtimeFingerprint,
    spec: id.spec,
  };
}

let runtimeFingerprintCache: { key: string; value: string } | null = null;

async function currentRuntimeArtifactFingerprint(): Promise<string> {
  // The fingerprint hashes the ~99MB agent binary; doing that on every session
  // start is wasteful since the runtime artifacts only change when the API is
  // rebuilt/redeployed. Memoize keyed on the agent binary's mtime+size so a dev
  // rebuild (which restages the CLI/SDK alongside it) still busts the cache.
  let key = '';
  try {
    const s = await stat(AGENT_BIN_PATH);
    key = `${s.mtimeMs}:${s.size}:${SANDBOX_VERSION}:${RUNTIME_LAYER_VERSION}:${OPENCODE_VERSION}:${AGENT_BROWSER_VERSION}`;
  } catch {
    key = ''; // couldn't stat — compute uncached this call
  }
  if (key && runtimeFingerprintCache?.key === key) {
    return runtimeFingerprintCache.value;
  }
  const value = await buildRuntimeArtifactFingerprint({
    sandboxVersion: `${SANDBOX_VERSION}:layer:${RUNTIME_LAYER_VERSION}:ab:${AGENT_BROWSER_VERSION}`,
    opencodeVersion: OPENCODE_VERSION,
    artifacts: [
      { label: 'kortix-agent', path: AGENT_BIN_PATH },
      { label: 'kortix-entrypoint', path: ENTRYPOINT_PATH },
      { label: 'kortix-agent-cli', path: AGENT_CLI_SRC_PATH },
      { label: 'kortix-executor-sdk', path: EXECUTOR_SDK_SRC_PATH },
    ],
  });
  if (key) runtimeFingerprintCache = { key, value };
  return value;
}

async function updateSnapshotRow(
  projectId: string,
  commitSha: string,
  provider: SandboxProviderName,
  source: SnapshotBuildSource,
  result: BuildOutcome,
): Promise<void> {
  await db
    .update(projectRuntimeSnapshots)
    .set({
      status: 'ready',
      snapshotId: result.daytonaName,
      error: null,
      metadata: {
        source,
        contentHash: result.contentHash,
        shortHash: result.shortHash,
        runtimeFingerprint: result.runtimeFingerprint,
        sandboxVersion: SANDBOX_VERSION,
      },
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(projectRuntimeSnapshots.projectId, projectId),
        eq(projectRuntimeSnapshots.commitSha, commitSha),
        eq(projectRuntimeSnapshots.provider, provider),
      ),
    );
}


async function assertExists(path: string, envVarHint: string): Promise<void> {
  if (!isAbsolute(path)) {
    throw new SnapshotBuildError(
      `${envVarHint} must be an absolute path (got "${path}")`,
    );
  }
  try {
    const s = await stat(path);
    if (!s.isFile()) {
      throw new SnapshotBuildError(`${envVarHint} (${path}) is not a regular file`);
    }
  } catch (err) {
    if (err instanceof SnapshotBuildError) throw err;
    throw new SnapshotBuildError(
      `Required artifact missing: ${path}. Set ${envVarHint} or run \`bun run build\` in apps/kortix-sandbox-agent-server.`,
      err,
    );
  }
}

async function assertExistsDir(path: string, envVarHint: string): Promise<void> {
  if (!isAbsolute(path)) {
    throw new SnapshotBuildError(
      `${envVarHint} must be an absolute path (got "${path}")`,
    );
  }
  try {
    const s = await stat(path);
    if (!s.isDirectory()) {
      throw new SnapshotBuildError(`${envVarHint} (${path}) is not a directory`);
    }
  } catch (err) {
    if (err instanceof SnapshotBuildError) throw err;
    throw new SnapshotBuildError(
      `Required directory missing: ${path}. Set ${envVarHint} or ship apps/sandbox/agent-cli.`,
      err,
    );
  }
}

async function resolveSandboxConfig(
  project: GitBackedProject,
  _commitSha: string,
): Promise<{ paths: SandboxPaths; spec: SandboxSpec }> {
  // readManifest reads from the default branch HEAD — for v1 we accept
  // that as the source of truth even when building for a different
  // commit. A more conservative version would read the manifest at
  // commitSha; the difference only matters for projects that edit
  // [sandbox] paths/spec on feature branches.
  const parsed = await readManifest(project);
  const raw = parsed?.raw ?? null;
  return {
    paths: extractSandboxPaths(raw),
    spec: extractSandboxSpec(raw),
  };
}

async function findSnapshotRow(
  projectId: string,
  commitSha: string,
  provider: SandboxProviderName = 'daytona',
) {
  const [row] = await db
    .select()
    .from(projectRuntimeSnapshots)
    .where(
      and(
        eq(projectRuntimeSnapshots.projectId, projectId),
        eq(projectRuntimeSnapshots.commitSha, commitSha),
        eq(projectRuntimeSnapshots.provider, provider),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function gzipFile(sourcePath: string, targetPath: string): Promise<void> {
  await pipeline(
    createReadStream(sourcePath),
    createGzip({ level: 9 }),
    createWriteStream(targetPath),
  );
}

function extractMetadataHash(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const value = (metadata as Record<string, unknown>).contentHash;
  return typeof value === 'string' ? value : null;
}

function extractMetadataRuntimeFingerprint(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const value = (metadata as Record<string, unknown>).runtimeFingerprint;
  return typeof value === 'string' ? value : null;
}

function extractMetadataErrorCategory(metadata: unknown): SnapshotErrorCategory | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const value = (metadata as Record<string, unknown>).errorCategory;
  return typeof value === 'string' ? (value as SnapshotErrorCategory) : null;
}

function extractMetadataNumber(metadata: unknown, key: string): number | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
