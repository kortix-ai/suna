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
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Image } from '@daytonaio/sdk';
import { projectRuntimeSnapshots } from '@kortix/db';
import { db } from '../shared/db';
import { getDaytona } from '../shared/daytona';
import { SANDBOX_VERSION } from '../config';

/**
 * Pinned opencode CLI version layered into every snapshot. Bump this
 * (and SANDBOX_VERSION) together when a new opencode release is the
 * target — the runtime fingerprint hash invalidates every project's
 * cache so the next session pulls the new binary.
 */
const OPENCODE_VERSION = '1.14.28';
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
  /** Daytona snapshot name a session can boot from. */
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
 * (project, commit) coalesce via the table's unique constraint.
 */
export async function getOrBuildSnapshot(
  project: GitBackedProject,
  options: {
    /** Branch / tag / SHA to build from. Defaults to the project default branch. */
    ref?: string;
    /** Override the project account id (avoids re-querying the projects row). */
    accountId: string;
  },
): Promise<SnapshotResolution> {
  const commitSha = await resolveCommitSha(project, options.ref);
  const provider = 'daytona' as const;

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
    const result = await runBuild(project, commitSha);
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

async function runBuild(project: GitBackedProject, commitSha: string): Promise<BuildOutcome> {
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
        eq(projectRuntimeSnapshots.provider, 'daytona'),
      ),
    )
    .catch(() => {});

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
  const daytonaName = formatSnapshotName(project.projectId, hash.contentHash);

  // Dedup against Daytona — content-addressed name means an identical
  // build done by another project (or an earlier commit with the same
  // content) is already there.
  const daytona = getDaytona();
  try {
    const existing = await daytona.snapshot.get(daytonaName);
    if (existing) {
      return { daytonaName, contentHash: hash.contentHash, shortHash: hash.shortHash, built: false };
    }
  } catch {
    // get() throws when the snapshot doesn't exist — proceed with build.
  }

  // Materialize context to a tmpdir + write the composed Dockerfile beside it.
  const contextDir = await materializeRepoContext(
    project,
    commitSha,
    sandboxPaths.context === '.' ? null : sandboxPaths.context,
  );
  try {
    const composedPath = join(contextDir, '.kortix-snapshot.Dockerfile');
    const composed = buildLayeredDockerfile({
      userDockerfile,
      opencodeVersion: OPENCODE_VERSION,
      // These paths are read by Daytona's builder, which copies from the
      // build context. We embed the binaries at known paths under the
      // snapshot-builder dir (out of scope for v1 — the builder
      // expects them present alongside the runtime).
      agentBinaryPath: 'kortix-agent',
      entrypointScriptPath: 'kortix-entrypoint',
    });
    await mkdir(contextDir, { recursive: true });
    await Bun.write(composedPath, composed);

    await daytona.snapshot.create(
      {
        name: daytonaName,
        image: Image.fromDockerfile(composedPath),
      },
      { timeout: Math.floor(BUILD_TIMEOUT_MS / 1000) },
    );

    return { daytonaName, contentHash: hash.contentHash, shortHash: hash.shortHash, built: true };
  } finally {
    await rm(contextDir, { recursive: true, force: true }).catch(() => {});
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
