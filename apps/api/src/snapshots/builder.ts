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

import { and, eq } from 'drizzle-orm';
import { copyFile, mkdir, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Image } from '@daytonaio/sdk';
import { projectRuntimeSnapshots } from '@kortix/db';
import { db } from '../shared/db';
import { getDaytona } from '../shared/daytona';
import { SANDBOX_VERSION } from '../config';
import type { SandboxProviderName } from '../config';

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

/** Cap how long the lazy-fallback path will wait for a build before giving up. */
const BUILD_TIMEOUT_MS = 10 * 60 * 1000;
/** Poll interval when waiting on a row already in `building` (e.g. another session triggered it). */
const POLL_INTERVAL_MS = 2_000;

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
 * Top-level entry point: returns a ready Daytona snapshot name, building
 * one inline if needed. Idempotent — concurrent calls for the same
 * (project, commit, provider) coalesce via the table's unique constraint.
 *
 * `provider` is on the API for extensibility — every provider that ever
 * lands here will need a build path. Today only 'daytona' is supported;
 * unsupported values throw inside `runBuild` so the call site doesn't
 * have to guard.
 */
export async function getOrBuildSnapshot(
  project: GitBackedProject,
  options: {
    /** Branch / tag / SHA to build from. Defaults to the project default branch. */
    ref?: string;
    /** Override the project account id (avoids re-querying the projects row). */
    accountId: string;
    /** Provider to build for. Defaults to 'daytona'. */
    provider?: SandboxProviderName;
  },
): Promise<SnapshotResolution> {
  const commitSha = await resolveCommitSha(project, options.ref);
  const provider = options.provider ?? 'daytona';

  // Cache lookup first — by far the common case.
  const existing = await findSnapshotRow(project.projectId, commitSha);
  if (existing?.status === 'ready' && existing.snapshotId) {
    return {
      daytonaName: existing.snapshotId,
      commitSha,
      contentHash: extractMetadataHash(existing.metadata) ?? '',
      built: false,
    };
  }
  if (existing?.status === 'building' || existing?.status === 'queued') {
    const resolved = await waitForBuild(project.projectId, commitSha);
    return { ...resolved, built: false };
  }
  if (existing?.status === 'failed') {
    // Retry from scratch — failures shouldn't pin a project forever.
    // (Could rate-limit later; for v1 a session-create retries inline.)
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

  // No row (or failed-and-cleared) — claim the build by inserting `queued`.
  // The unique (projectId, commitSha, provider) constraint makes concurrent
  // callers race and exactly one wins; losers fall through to the wait path.
  try {
    await db.insert(projectRuntimeSnapshots).values({
      accountId: options.accountId,
      projectId: project.projectId,
      provider,
      commitSha,
      status: 'queued',
      metadata: { source: 'lazy-fallback' },
    });
  } catch {
    // Lost the race — another session beat us to the insert. Wait on it.
    const resolved = await waitForBuild(project.projectId, commitSha);
    return { ...resolved, built: false };
  }

  // We own the build. Anything that throws below must mark the row failed.
  try {
    const result = await runBuild(project, commitSha, provider);
    await db
      .update(projectRuntimeSnapshots)
      .set({
        status: 'ready',
        snapshotId: result.daytonaName,
        metadata: {
          source: 'lazy-fallback',
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
  provider: SandboxProviderName,
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
  await copyFile(AGENT_BIN_PATH, join(contextDir, 'kortix-agent'));
  await copyFile(ENTRYPOINT_PATH, join(contextDir, 'kortix-entrypoint'));

  const composedPath = join(contextDir, '.kortix-snapshot.Dockerfile');
  const composed = buildLayeredDockerfile({
    userDockerfile,
    opencodeVersion: OPENCODE_VERSION,
    agentBinaryPath: 'kortix-agent',
    entrypointScriptPath: 'kortix-entrypoint',
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

async function resolveSandboxPaths(project: GitBackedProject, _commitSha: string): Promise<SandboxPaths> {
  // readManifest reads from the default branch HEAD — for v1 we accept
  // that as the source of truth even when building for a different
  // commit. A more conservative version would read the manifest at
  // commitSha; the difference only matters for projects that edit
  // [sandbox] paths on feature branches.
  const parsed = await readManifest(project);
  return extractSandboxPaths(parsed?.raw ?? null);
}

async function findSnapshotRow(projectId: string, commitSha: string) {
  const [row] = await db
    .select()
    .from(projectRuntimeSnapshots)
    .where(
      and(
        eq(projectRuntimeSnapshots.projectId, projectId),
        eq(projectRuntimeSnapshots.commitSha, commitSha),
        eq(projectRuntimeSnapshots.provider, 'daytona'),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function waitForBuild(projectId: string, commitSha: string): Promise<SnapshotResolution> {
  const deadline = Date.now() + BUILD_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const row = await findSnapshotRow(projectId, commitSha);
    if (row?.status === 'ready' && row.snapshotId) {
      return {
        daytonaName: row.snapshotId,
        commitSha,
        contentHash: extractMetadataHash(row.metadata) ?? '',
        built: false,
      };
    }
    if (row?.status === 'failed') {
      throw new SnapshotBuildError(`Snapshot build failed: ${row.error ?? 'unknown error'}`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new SnapshotBuildError(`Snapshot build timed out after ${BUILD_TIMEOUT_MS / 1000}s`);
}

function extractMetadataHash(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const value = (metadata as Record<string, unknown>).contentHash;
  return typeof value === 'string' ? value : null;
}
