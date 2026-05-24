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

import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import { copyFile, cp, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Image } from '@daytonaio/sdk';
import { projectRuntimeSnapshots } from '@kortix/db';
import { db } from '../shared/db';
import { getDaytona } from '../shared/daytona';
import { SANDBOX_VERSION } from '../config';
import type { SandboxProviderName } from '../config';

/**
 * Providers that participate in the per-project snapshot system. Today
 * only `daytona`. Platinum sandboxes boot from a shared template and
 * never hit the snapshot builder — see session-sandbox.ts where the
 * provider guard short-circuits this path.
 */
type SnapshotProviderName = Extract<SandboxProviderName, 'daytona'>;

/**
 * Pinned opencode CLI version layered into every snapshot. Bump this
 * (and SANDBOX_VERSION) together when a new opencode release is the
 * target — the runtime fingerprint hash invalidates every project's
 * cache so the next session pulls the new binary.
 */
const OPENCODE_VERSION = '1.14.28';

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
import {
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
  type SandboxPaths,
} from './dockerfile-layer';
import { computeSnapshotHash, formatSnapshotName } from './hash';

/** Cap how long the Daytona-side snapshot build is allowed to take. */
const BUILD_TIMEOUT_MS = 10 * 60 * 1000;

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
 */
export type SnapshotBuildSource = 'project-create' | 'session-start' | 'manual';

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
    provider?: SnapshotProviderName;
    source: SnapshotBuildSource;
  },
): Promise<SnapshotResolution> {
  const commitSha = await resolveCommitSha(project, options.ref);
  const provider = options.provider ?? 'daytona';
  const branch = options.ref ?? project.defaultBranch;

  const existing = await findSnapshotRow(project.projectId, commitSha, provider);
  if (existing?.status === 'ready' && existing.snapshotId) {
    return {
      daytonaName: existing.snapshotId,
      commitSha,
      contentHash: extractMetadataHash(existing.metadata) ?? '',
      built: false,
    };
  }
  if (existing?.status === 'building' || existing?.status === 'queued') {
    // Another build is in flight for this exact commit. Don't race it.
    throw new SnapshotBuildError(
      `Snapshot build for commit ${commitSha.slice(0, 8)} is already in progress`,
    );
  }
  if (existing?.status === 'failed') {
    // Retry from scratch — failures shouldn't pin a project forever.
    await db
      .delete(projectRuntimeSnapshots)
      .where(
        and(
          eq(projectRuntimeSnapshots.projectId, project.projectId),
          eq(projectRuntimeSnapshots.commitSha, commitSha),
          eq(projectRuntimeSnapshots.provider, provider),
        ),
      );
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
    await db
      .update(projectRuntimeSnapshots)
      .set({
        status: 'ready',
        snapshotId: result.daytonaName,
        metadata: {
          source: options.source,
          contentHash: result.contentHash,
          shortHash: result.shortHash,
          sandboxVersion: SANDBOX_VERSION,
        },
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(projectRuntimeSnapshots.projectId, project.projectId),
          eq(projectRuntimeSnapshots.commitSha, commitSha),
          eq(projectRuntimeSnapshots.provider, provider),
        ),
      );
    return {
      daytonaName: result.daytonaName,
      commitSha,
      contentHash: result.contentHash,
      built: result.built,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(projectRuntimeSnapshots)
      .set({
        status: 'failed',
        error: message.slice(0, 2000),
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
  provider: SnapshotProviderName = 'daytona',
): Promise<typeof projectRuntimeSnapshots.$inferSelect | null> {
  const [row] = await db
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
    .limit(1);
  return row ?? null;
}

/**
 * Find any (non-failed) row for a specific commit. Used by the rebuild-
 * check fast path so we don't re-claim a commit that's already built or
 * actively building.
 */
async function findActiveRowForCommit(
  projectId: string,
  commitSha: string,
  provider: SnapshotProviderName,
): Promise<typeof projectRuntimeSnapshots.$inferSelect | null> {
  const [row] = await db
    .select()
    .from(projectRuntimeSnapshots)
    .where(
      and(
        eq(projectRuntimeSnapshots.projectId, projectId),
        eq(projectRuntimeSnapshots.commitSha, commitSha),
        eq(projectRuntimeSnapshots.provider, provider),
        ne(projectRuntimeSnapshots.status, 'failed'),
      ),
    )
    .limit(1);
  return row ?? null;
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
    provider?: SnapshotProviderName;
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

  const existing = await findActiveRowForCommit(project.projectId, commitSha, provider);
  if (existing?.status === 'ready') {
    return { status: 'already-ready', commitSha };
  }
  if (existing) {
    return { status: 'already-building', commitSha };
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
 * List snapshot history for a project, most recent first. Powers the
 * "Sandbox snapshot" panel in the dashboard.
 */
export async function listSnapshotsForProject(
  projectId: string,
  options: { limit?: number; provider?: SnapshotProviderName } = {},
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
  provider: SnapshotProviderName = 'daytona',
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

/* ─── Internals ────────────────────────────────────────────────────────── */

interface BuildOutcome {
  daytonaName: string;
  contentHash: string;
  shortHash: string;
  built: boolean;
}

async function runBuild(
  project: GitBackedProject,
  commitSha: string,
  provider: SnapshotProviderName,
): Promise<BuildOutcome> {
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

  const ctx = await prepareBuildContext(project, commitSha);
  try {
    // Daytona is the only provider with a build path today. New providers
    // can be added here as cases; the rest of the function stays the same.
    if (provider !== 'daytona') {
      throw new SnapshotBuildError(
        `snapshot builder not implemented for provider '${provider}'`,
      );
    }
    const daytona = getDaytona();
    try {
      const existing = await daytona.snapshot.get(ctx.snapshotName);
      if (existing) {
        return { daytonaName: ctx.snapshotName, contentHash: ctx.contentHash, shortHash: ctx.shortHash, built: false };
      }
    } catch { /* not present — proceed with build */ }
    await daytona.snapshot.create(
      { name: ctx.snapshotName, image: Image.fromDockerfile(ctx.composedPath) },
      { timeout: Math.floor(BUILD_TIMEOUT_MS / 1000) },
    );
    return { daytonaName: ctx.snapshotName, contentHash: ctx.contentHash, shortHash: ctx.shortHash, built: true };
  } finally {
    await rm(ctx.contextDir, { recursive: true, force: true }).catch(() => {});
  }
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
}

async function prepareBuildContext(
  project: GitBackedProject,
  commitSha: string,
): Promise<PreparedContext> {
  const sandboxPaths = await resolveSandboxPaths(project, commitSha);
  const userDockerfile = await readRepoFile(project, sandboxPaths.dockerfile, commitSha);
  if (!userDockerfile.trim()) {
    throw new SnapshotBuildError(
      `Empty Dockerfile at ${sandboxPaths.dockerfile} (commit ${commitSha.slice(0, 8)})`,
    );
  }
  const contextTreeOid = await resolveTreeOid(
    project,
    commitSha,
    sandboxPaths.context === '.' ? null : sandboxPaths.context,
  );
  const hash = computeSnapshotHash({ dockerfile: userDockerfile, contextTreeOid });
  const snapshotName = formatSnapshotName(project.projectId, hash.contentHash);

  const contextDir = await materializeRepoContext(
    project,
    commitSha,
    sandboxPaths.context === '.' ? null : sandboxPaths.context,
  );
  await assertExists(AGENT_BIN_PATH, 'KORTIX_SNAPSHOT_AGENT_BIN_PATH');
  await assertExists(ENTRYPOINT_PATH, 'KORTIX_SNAPSHOT_ENTRYPOINT_PATH');
  await assertExistsDir(AGENT_CLI_SRC_PATH, 'KORTIX_SNAPSHOT_AGENT_CLI_PATH');
  await copyFile(AGENT_BIN_PATH, join(contextDir, 'kortix-agent'));
  await copyFile(ENTRYPOINT_PATH, join(contextDir, 'kortix-entrypoint'));
  await cp(AGENT_CLI_SRC_PATH, join(contextDir, 'kortix-agent-cli'), { recursive: true });

  const composedPath = join(contextDir, '.kortix-snapshot.Dockerfile');
  const composed = buildLayeredDockerfile({
    userDockerfile,
    opencodeVersion: OPENCODE_VERSION,
    agentBinaryPath: 'kortix-agent',
    entrypointScriptPath: 'kortix-entrypoint',
    agentCliPath: 'kortix-agent-cli',
  });
  await Bun.write(composedPath, composed);

  return {
    contextDir,
    composedPath,
    snapshotName,
    contentHash: hash.contentHash,
    shortHash: hash.shortHash,
  };
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

async function resolveSandboxPaths(project: GitBackedProject, _commitSha: string): Promise<SandboxPaths> {
  // readManifest reads from the default branch HEAD — for v1 we accept
  // that as the source of truth even when building for a different
  // commit. A more conservative version would read the manifest at
  // commitSha; the difference only matters for projects that edit
  // [sandbox] paths on feature branches.
  const parsed = await readManifest(project);
  return extractSandboxPaths(parsed?.raw ?? null);
}

async function findSnapshotRow(
  projectId: string,
  commitSha: string,
  provider: SnapshotProviderName = 'daytona',
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

function extractMetadataHash(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const value = (metadata as Record<string, unknown>).contentHash;
  return typeof value === 'string' ? value : null;
}
