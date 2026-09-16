/**
 * Project snapshot archives — the producer side of the S3 config provider.
 *
 * A snapshot is the committed project tree at ONE exact commit, plus a
 * sanitized shallow `.git` (one commit, no remotes, no hooks, no reflogs),
 * packed as `.tar.gz` and published to object storage under an immutable,
 * revision-addressed prefix (see project-snapshot-store.ts). A fresh session
 * downloads it through a short-lived descriptor instead of cloning through the
 * Git proxy.
 *
 * Three concerns live here, deliberately in one small module:
 *   - the readiness LEDGER (`kortix.project_snapshot_archives`): one row per
 *     (project, sha); `queued` → `building` → `ready` | `failed`;
 *   - ENQUEUE helpers used by every place the API learns a base tip
 *     (registration, proxy push, CR merge, session create);
 *   - the BUILD + PUBLISH step the leader worker runs for a claimed row.
 *
 * What the archive deliberately does NOT carry: credentials, credential-bearing
 * remotes, hooks, reflogs, untracked files, LFS objects (pointers only — the
 * Git path has the same semantics), submodule contents (`.gitmodules` only,
 * like a clone without `--recurse-submodules`).
 */
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as tar from 'tar';
import { and, eq, sql } from 'drizzle-orm';
import { projectGitConnections, projectSnapshotArchives, projects } from '@kortix/db';
import { config } from '../config';
import { validateRef, validateSha } from '../projects/git-ref';
import { refreshMirror, runGit } from '../projects/git/mirror';
import type { GitBackedProject } from '../projects/git/types';
import { db } from '../shared/db';
import {
  presignProjectSnapshotDownload,
  PROJECT_SNAPSHOT_ARCHIVE_CONTENT_TYPE,
  PROJECT_SNAPSHOT_BLOBS_CONTENT_TYPE,
  PROJECT_SNAPSHOT_FORMAT,
  getObjectText,
  headObject,
  projectSnapshotBlobsKey,
  projectSnapshotManifestKey,
  projectSnapshotTreeKey,
  projectSnapshotObjectPrefix,
  projectSnapshotStorageConfigured,
  putObjectIfAbsent,
  type ProjectSnapshotManifest,
  type ProjectSnapshotRepository,
} from './project-snapshot-store';

export const PROJECT_SNAPSHOT_MODES = ['git', 'prefer-s3', 'require-s3'] as const;
export type ProjectSnapshotMode = (typeof PROJECT_SNAPSHOT_MODES)[number];

/** Platform mode, overridable per project through `metadata.project_snapshot_mode` (the canary lever). */
export function resolveProjectSnapshotMode(projectMetadata: unknown): ProjectSnapshotMode {
  const override = (projectMetadata as { project_snapshot_mode?: unknown } | null)?.project_snapshot_mode;
  if (typeof override === 'string' && (PROJECT_SNAPSHOT_MODES as readonly string[]).includes(override)) {
    return override as ProjectSnapshotMode;
  }
  return config.KORTIX_PROJECT_SNAPSHOT_MODE;
}

/** `refs/heads/main` and `main` are one identity. */
export function normalizeSnapshotRef(ref: string): string {
  return validateRef(ref.trim().replace(/^refs\/heads\//, ''));
}

/** Marker the daemon reads after extraction to verify identity before activation. */
export const PROJECT_SNAPSHOT_MARKER_PATH = '.git/kortix-project-snapshot.json';

export interface ProjectSnapshotMarker {
  format: typeof PROJECT_SNAPSHOT_FORMAT;
  repository: { owner: string; name: string; external_id: string };
  ref: string;
  commit_sha: string;
}

export type ProjectSnapshotStatus = 'queued' | 'building' | 'ready' | 'failed';

export interface ReadyProjectSnapshot {
  snapshotId: string;
  projectId: string;
  ref: string;
  commitSha: string;
  repository: ProjectSnapshotRepository;
  objectPrefix: string;
  /** Boot object (working tree + blobless .git): digest, size, tar entries. */
  archiveSha256: string;
  archiveBytes: number;
  entryCount: number;
  /** Hydration object (the tip's blob pack). */
  blobsSha256: string;
  blobsBytes: number;
  readyAt: Date;
}

// ── Repository identity ─────────────────────────────────────────────────────

function repoNameFromUrl(repoUrl: string): { owner: string; name: string } | null {
  const trimmed = repoUrl.trim().replace(/\/+$/, '').replace(/\.git$/, '');
  const parts = trimmed.split(/[/:]/).filter(Boolean);
  const name = parts[parts.length - 1];
  const owner = parts[parts.length - 2];
  if (!name || !owner) return null;
  return { owner: owner.toLowerCase(), name };
}

/**
 * Identity for the object layout, from the project's Git connection — never a
 * provider lookup. A connection without an external repository id (a linked
 * bare repo, a legacy row) falls back to a Kortix-owned id so the layout stays
 * total; its owner/name come from the URL.
 */
export async function resolveSnapshotRepository(
  projectId: string,
  repoUrl: string,
): Promise<ProjectSnapshotRepository> {
  const [connection] = await db
    .select({
      repoOwner: projectGitConnections.repoOwner,
      repoName: projectGitConnections.repoName,
      externalRepoId: projectGitConnections.externalRepoId,
      upstreamUrl: projectGitConnections.upstreamUrl,
      connectionRepoUrl: projectGitConnections.repoUrl,
    })
    .from(projectGitConnections)
    .where(eq(projectGitConnections.projectId, projectId))
    .limit(1);
  const parsed = repoNameFromUrl(connection?.upstreamUrl || connection?.connectionRepoUrl || repoUrl);
  const owner = (connection?.repoOwner || parsed?.owner || 'unknown').toLowerCase();
  const name = connection?.repoName || parsed?.name || projectId;
  const externalId = connection?.externalRepoId?.trim() || `kortix-${projectId}`;
  return {
    owner: owner.replace(/[^A-Za-z0-9._-]/g, '-'),
    name: name.replace(/[^A-Za-z0-9._-]/g, '-'),
    externalId: externalId.replace(/[^A-Za-z0-9._-]/g, '-'),
  };
}

// ── Ledger ──────────────────────────────────────────────────────────────────

export type EnqueueOutcome = 'queued' | 'exists' | 'unconfigured';

/** Idempotent: (project, sha) is unique, a repeat is a no-op. */
export async function enqueueProjectSnapshot(input: {
  projectId: string;
  ref: string;
  commitSha: string;
  repoUrl: string;
}): Promise<EnqueueOutcome> {
  if (!projectSnapshotStorageConfigured()) return 'unconfigured';
  const ref = normalizeSnapshotRef(input.ref);
  const commitSha = validateSha(input.commitSha);
  const repository = await resolveSnapshotRepository(input.projectId, input.repoUrl);
  const inserted = await db
    .insert(projectSnapshotArchives)
    .values({
      projectId: input.projectId,
      ref,
      commitSha,
      repoOwner: repository.owner,
      repoName: repository.name,
      externalRepoId: repository.externalId,
      status: 'queued',
      format: PROJECT_SNAPSHOT_FORMAT,
    })
    // A row built as an OLDER layout is a cache miss for this API: re-queue it
    // under the current format (its objects live under another prefix and are
    // left alone). A row already at the current format is untouched.
    .onConflictDoUpdate({
      target: [projectSnapshotArchives.projectId, projectSnapshotArchives.commitSha],
      set: {
        status: 'queued',
        format: PROJECT_SNAPSHOT_FORMAT,
        attempts: 0,
        nextAttemptAt: new Date(),
        lockedBy: null,
        lockedUntil: null,
        objectPrefix: null,
        archiveSha256: null,
        archiveBytes: null,
        entryCount: null,
        blobsSha256: null,
        blobsBytes: null,
        lastError: null,
        readyAt: null,
        updatedAt: new Date(),
      },
      setWhere: sql`${projectSnapshotArchives.format} <> ${PROJECT_SNAPSHOT_FORMAT}`,
    })
    .returning({ snapshotId: projectSnapshotArchives.snapshotId });
  return inserted.length > 0 ? 'queued' : 'exists';
}

/**
 * Resolve the ref's CURRENT tip, then enqueue that exact SHA. The remote is
 * asked first (`ls-remote`, one round trip, always fresh): a push hook runs
 * seconds after the tip moved, and the mirror's refresh memo would otherwise
 * hand back the previous tip — an older prepared SHA silently standing in for
 * the new one. The mirror is the fallback when the remote cannot be listed
 * (no credential on this call path); the worker refreshes it at build time.
 */
export async function queueProjectSnapshotForRef(
  project: GitBackedProject,
  ref: string,
): Promise<{ outcome: EnqueueOutcome; commitSha: string | null }> {
  if (!projectSnapshotStorageConfigured()) return { outcome: 'unconfigured', commitSha: null };
  const normalized = normalizeSnapshotRef(ref);
  let commitSha: string | null = null;
  try {
    const { resolveRemoteBranchTip } = await import('../projects/git/branches');
    commitSha = await resolveRemoteBranchTip(project, normalized);
  } catch {
    commitSha = null;
  }
  if (!commitSha) {
    const { resolveCommitSha } = await import('../projects/git/commits');
    commitSha = await resolveCommitSha(project, normalized);
  }
  const outcome = await enqueueProjectSnapshot({
    projectId: project.projectId,
    ref,
    commitSha,
    repoUrl: project.repoUrl,
  });
  return { outcome, commitSha };
}

/** Re-arm a `failed` (or stuck) row so the worker picks it up again. */
export async function retryProjectSnapshot(projectId: string, commitSha: string): Promise<boolean> {
  const rows = await db
    .update(projectSnapshotArchives)
    .set({
      status: 'queued',
      nextAttemptAt: new Date(),
      lockedBy: null,
      lockedUntil: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(projectSnapshotArchives.projectId, projectId),
        eq(projectSnapshotArchives.commitSha, validateSha(commitSha)),
        sql`${projectSnapshotArchives.status} <> 'ready'`,
      ),
    )
    .returning({ snapshotId: projectSnapshotArchives.snapshotId });
  return rows.length > 0;
}

function toReady(row: typeof projectSnapshotArchives.$inferSelect): ReadyProjectSnapshot | null {
  if (
    row.status !== 'ready' ||
    row.format !== PROJECT_SNAPSHOT_FORMAT ||
    !row.objectPrefix ||
    !row.archiveSha256 ||
    row.archiveBytes === null ||
    !row.blobsSha256 ||
    row.blobsBytes === null ||
    row.readyAt === null
  ) {
    return null;
  }
  return {
    snapshotId: row.snapshotId,
    projectId: row.projectId,
    ref: row.ref,
    commitSha: row.commitSha,
    repository: { owner: row.repoOwner, name: row.repoName, externalId: row.externalRepoId },
    objectPrefix: row.objectPrefix,
    archiveSha256: row.archiveSha256,
    archiveBytes: row.archiveBytes,
    entryCount: row.entryCount ?? 0,
    blobsSha256: row.blobsSha256,
    blobsBytes: row.blobsBytes,
    readyAt: row.readyAt,
  };
}

export async function readProjectSnapshot(
  projectId: string,
  commitSha: string,
): Promise<typeof projectSnapshotArchives.$inferSelect | null> {
  const [row] = await db
    .select()
    .from(projectSnapshotArchives)
    .where(
      and(
        eq(projectSnapshotArchives.projectId, projectId),
        eq(projectSnapshotArchives.commitSha, validateSha(commitSha)),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** The prepared archive for (project, sha), or null when none is `ready`. */
export async function readReadyProjectSnapshot(
  projectId: string,
  commitSha: string,
): Promise<ReadyProjectSnapshot | null> {
  if (!projectSnapshotStorageConfigured()) return null;
  const row = await readProjectSnapshot(projectId, commitSha);
  return row ? toReady(row) : null;
}

/**
 * A `ready` row whose objects are no longer in the bucket — a lifecycle
 * expiration, an operator delete — must not keep advertising itself: every
 * fresh session would pin it, fail the download and fall back. Verify both
 * objects (two HeadObject calls, ~10 ms in-region) and on a miss re-queue the
 * row so the leader rebuilds and republishes; the caller treats the row as
 * not prepared. Returns the row only when both objects are present.
 */
export async function verifyReadyProjectSnapshotObjects(
  ready: ReadyProjectSnapshot,
): Promise<ReadyProjectSnapshot | null> {
  const [tree, blobs] = await Promise.all([
    headObject(projectSnapshotTreeKey(ready.objectPrefix, ready.archiveSha256)),
    headObject(projectSnapshotBlobsKey(ready.objectPrefix, ready.blobsSha256)),
  ]);
  if (tree && blobs) return ready;
  const missing = !tree ? 'tree object' : 'blob pack';
  await db
    .update(projectSnapshotArchives)
    .set({
      status: 'queued',
      attempts: 0,
      nextAttemptAt: new Date(),
      lockedBy: null,
      lockedUntil: null,
      objectPrefix: null,
      archiveSha256: null,
      archiveBytes: null,
      entryCount: null,
      blobsSha256: null,
      blobsBytes: null,
      readyAt: null,
      lastError: `published ${missing} is no longer in the bucket; re-queued`,
      updatedAt: new Date(),
    })
    .where(and(eq(projectSnapshotArchives.snapshotId, ready.snapshotId), eq(projectSnapshotArchives.status, 'ready')));
  console.warn('[project-snapshot] ready row lost its published object; re-queued', {
    event: 'project_snapshot_object_missing',
    projectId: ready.projectId,
    sha: ready.commitSha,
    missing,
  });
  return null;
}

/**
 * The same check, OFF the request path: a row whose object expired is
 * re-queued for the NEXT session, while THIS session's daemon meets a 404 from
 * the store and takes the Git path (`missing`, no retry). Nothing on the
 * create or descriptor path waits for the bucket any more.
 */
export function verifyReadyProjectSnapshotObjectsInBackground(ready: ReadyProjectSnapshot): void {
  void verifyReadyProjectSnapshotObjects(ready).catch((err) => {
    console.warn('[project-snapshot] background object check failed', {
      projectId: ready.projectId,
      sha: ready.commitSha,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

/** What `GET …/project-snapshot` serves, and what session create presigns into the sandbox env. */
export interface ProjectSnapshotDescriptorPayload {
  format: typeof PROJECT_SNAPSHOT_FORMAT;
  commit_sha: string;
  ref: string;
  repository: { owner: string; name: string; external_id: string };
  /** The boot object: working tree + blobless .git. Its digest/size is the session pin. */
  tree: { url: string; sha256: string; bytes: number; entries: number; expires_at: string };
  /** The hydration object: the tip's blob pack, fetched after activation. */
  blobs: { url: string; sha256: string; bytes: number; expires_at: string };
}

/** Presign both objects of a ready row. Local signing only — no bucket call. */
export async function buildProjectSnapshotDescriptor(ready: ReadyProjectSnapshot): Promise<ProjectSnapshotDescriptorPayload> {
  const [tree, blobs] = await Promise.all([
    presignProjectSnapshotDownload(projectSnapshotTreeKey(ready.objectPrefix, ready.archiveSha256)),
    presignProjectSnapshotDownload(projectSnapshotBlobsKey(ready.objectPrefix, ready.blobsSha256)),
  ]);
  return {
    format: PROJECT_SNAPSHOT_FORMAT,
    commit_sha: ready.commitSha,
    ref: ready.ref,
    repository: {
      owner: ready.repository.owner,
      name: ready.repository.name,
      external_id: ready.repository.externalId,
    },
    tree: {
      url: tree.url,
      sha256: ready.archiveSha256,
      bytes: ready.archiveBytes,
      entries: ready.entryCount,
      expires_at: tree.expiresAt.toISOString(),
    },
    blobs: {
      url: blobs.url,
      sha256: ready.blobsSha256,
      bytes: ready.blobsBytes,
      expires_at: blobs.expiresAt.toISOString(),
    },
  };
}

/** Env encoding of the descriptor: base64 of the JSON, one value, no quoting hazards across providers. */
export function encodeProjectSnapshotDescriptorForEnv(descriptor: ProjectSnapshotDescriptorPayload): string {
  return Buffer.from(JSON.stringify(descriptor)).toString('base64');
}

/**
 * Session-create helper: the pin the sandbox env carries when an archive is
 * ready — plus the presigned descriptor, so the daemon's first attempt is one
 * direct GET from the store — and a recorded cache miss (plus an enqueue, so
 * the NEXT session finds it) when it is not.
 */
export async function resolveProjectSnapshotPinForSession(input: {
  projectId: string;
  ref: string;
  commitSha: string | undefined;
  repoUrl: string;
}): Promise<{ pin: string | null; descriptor: string | null; cache: 'hit' | 'miss' | 'no-sha' | 'unconfigured' }> {
  if (!projectSnapshotStorageConfigured()) return { pin: null, descriptor: null, cache: 'unconfigured' };
  if (!input.commitSha || !/^[0-9a-f]{40}$/.test(input.commitSha)) return { pin: null, descriptor: null, cache: 'no-sha' };
  const ready = await readReadyProjectSnapshot(input.projectId, input.commitSha);
  if (ready) {
    // Off the create path: an object that expired re-queues the row for the
    // next session; this session's daemon meets the 404 and boots from Git.
    verifyReadyProjectSnapshotObjectsInBackground(ready);
    const pin = `${ready.commitSha}:${ready.archiveSha256}:${ready.archiveBytes}`;
    // Presigning is local signing. If it fails, the pin still ships and the
    // daemon fetches the descriptor from the proxy as before.
    const descriptor = await buildProjectSnapshotDescriptor(ready)
      .then(encodeProjectSnapshotDescriptorForEnv)
      .catch((err) => {
        console.warn('[project-snapshot] presign at create failed; the daemon will fetch the descriptor', {
          projectId: input.projectId,
          sha: input.commitSha,
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      });
    return { pin, descriptor, cache: 'hit' };
  }
  void enqueueProjectSnapshot({
    projectId: input.projectId,
    ref: input.ref,
    commitSha: input.commitSha,
    repoUrl: input.repoUrl,
  }).catch((err) => {
    console.warn('[project-snapshot] enqueue on cache miss failed', {
      projectId: input.projectId,
      sha: input.commitSha,
      error: err instanceof Error ? err.message : String(err),
    });
  });
  return { pin: null, descriptor: null, cache: 'miss' };
}

// ── Worker claim / settle ───────────────────────────────────────────────────

export const PROJECT_SNAPSHOT_MAX_ATTEMPTS = 5;
const BUILD_LEASE_MINUTES = 15;

export function projectSnapshotRetryDelayMs(attempts: number): number {
  return Math.min(3_600_000, 30_000 * 2 ** Math.max(0, attempts - 1));
}

interface ClaimedRow extends Record<string, unknown> {
  snapshotId: string;
}

/**
 * Claim due rows. `queued` rows past `next_attempt_at`, or `building` rows
 * whose lease expired (a worker that died mid-build). `attempts` is bumped at
 * claim time so a crash still counts. Postgres `SKIP LOCKED` keeps N replicas
 * from double-claiming even though only the leader runs the worker.
 */
export async function claimProjectSnapshots(workerId: string, limit: number): Promise<string[]> {
  const rows = await db.execute<ClaimedRow>(sql`
    WITH picked AS (
      SELECT snapshot_id
      FROM kortix.project_snapshot_archives
      WHERE (
          (status = 'queued' AND next_attempt_at <= now())
          OR (status = 'building' AND locked_until < now())
        )
      ORDER BY next_attempt_at, created_at
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE kortix.project_snapshot_archives s
       SET status = 'building', locked_by = ${workerId},
           locked_until = now() + (${BUILD_LEASE_MINUTES} * interval '1 minute'),
           attempts = s.attempts + 1, updated_at = now()
      FROM picked
     WHERE s.snapshot_id = picked.snapshot_id
    RETURNING s.snapshot_id AS "snapshotId"
  `);
  return Array.from(rows as unknown as ClaimedRow[]).map((row) => row.snapshotId);
}

async function settleReady(
  snapshotId: string,
  workerId: string,
  result: {
    objectPrefix: string;
    sha256: string;
    bytes: number;
    entries: number;
    blobsSha256: string;
    blobsBytes: number;
  },
): Promise<void> {
  await db
    .update(projectSnapshotArchives)
    .set({
      status: 'ready',
      format: PROJECT_SNAPSHOT_FORMAT,
      objectPrefix: result.objectPrefix,
      archiveSha256: result.sha256,
      archiveBytes: result.bytes,
      entryCount: result.entries,
      blobsSha256: result.blobsSha256,
      blobsBytes: result.blobsBytes,
      lastError: null,
      lockedBy: null,
      lockedUntil: null,
      readyAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(projectSnapshotArchives.snapshotId, snapshotId),
        eq(projectSnapshotArchives.lockedBy, workerId),
        sql`${projectSnapshotArchives.status} <> 'ready'`,
      ),
    );
}

async function settleFailure(
  snapshotId: string,
  workerId: string,
  attempts: number,
  error: unknown,
  retryable: boolean,
): Promise<'requeued' | 'failed'> {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
  const exhausted = !retryable || attempts >= PROJECT_SNAPSHOT_MAX_ATTEMPTS;
  await db
    .update(projectSnapshotArchives)
    .set({
      status: exhausted ? 'failed' : 'queued',
      nextAttemptAt: new Date(Date.now() + projectSnapshotRetryDelayMs(attempts)),
      lastError: message,
      lockedBy: null,
      lockedUntil: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(projectSnapshotArchives.snapshotId, snapshotId),
        eq(projectSnapshotArchives.lockedBy, workerId),
        sql`${projectSnapshotArchives.status} <> 'ready'`,
      ),
    );
  return exhausted ? 'failed' : 'requeued';
}

// ── Build ───────────────────────────────────────────────────────────────────

export class ProjectSnapshotTooLargeError extends Error {
  constructor(maxBytes: number, actualBytes: number) {
    super(`project snapshot exceeds ${maxBytes} bytes (${actualBytes})`);
    this.name = 'ProjectSnapshotTooLargeError';
  }
}

export class ProjectSnapshotSourceMissingError extends Error {
  constructor(sha: string) {
    super(`commit ${sha} is not present in the project mirror`);
    this.name = 'ProjectSnapshotSourceMissingError';
  }
}

function buildRoot(): string {
  return process.env.KORTIX_PROJECT_SNAPSHOT_BUILD_DIR || join(tmpdir(), 'kortix-project-snapshot');
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function mirrorHasCommit(mirror: string, sha: string): Promise<boolean> {
  try {
    await runGit(['cat-file', '-e', `${sha}^{commit}`], mirror, false);
    return true;
  } catch {
    return false;
  }
}

export interface BuiltProjectSnapshot {
  /** Boot object: working tree + blobless `.git`, tar.gz. */
  treePath: string;
  treeSha256: string;
  treeBytes: number;
  entries: number;
  /** Hydration object: the tip's blob pack. */
  blobsPath: string;
  blobsSha256: string;
  blobsBytes: number;
  /** Delete the build directory. */
  cleanup: () => Promise<void>;
}

/**
 * `git` with a stdin payload and/or stdout captured to a file — pack-objects
 * reads its revisions from stdin and writes the pack to stdout, which the
 * plain exec helper cannot do.
 */
function spawnGit(
  args: string[],
  cwd: string,
  io: { stdin?: string; stdinPath?: string; stdoutPath?: string },
  timeoutMs = 120_000,
): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      reject(err);
    };
    const timer = setTimeout(() => fail(new Error(`git ${args[0]} timed out after ${timeoutMs}ms`)), timeoutMs);
    child.on('error', fail);
    child.stdin.on('error', () => {});
    child.stderr.on('data', (d) => {
      stderr += String(d);
    });
    let sinkDone: Promise<void> = Promise.resolve();
    if (io.stdoutPath) {
      const sink = createWriteStream(io.stdoutPath);
      sinkDone = new Promise((res, rej) => {
        sink.on('finish', res);
        sink.on('error', rej);
      });
      child.stdout.pipe(sink);
    } else {
      child.stdout.on('data', (d) => {
        stdout += String(d);
      });
    }
    if (io.stdinPath) createReadStream(io.stdinPath).on('error', fail).pipe(child.stdin);
    else child.stdin.end(io.stdin ?? '');
    child.on('close', (code) => {
      sinkDone.then(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code === 0) resolve({ stdout });
        else reject(new Error(`git ${args.join(' ')} exited ${code}: ${stderr.slice(0, 300)}`));
      }, fail);
    });
  });
}

/**
 * Build the two objects for ONE exact commit from the API's bare mirror. The
 * checkout is a single-commit shallow fetch (`uploadpack.allowAnySHA1InWant`
 * lets a local mirror serve an arbitrary reachable SHA, so a ref that already
 * moved on does not change what this builds). The `.git` that ships is
 * sanitized: no remote, no hooks, no reflogs, a fresh index with no stat data
 * — and no blobs: its one pack holds the commit and trees and is marked
 * promisor, so the box is a valid partial clone the moment it is extracted.
 * The blobs travel separately (the hydration object) and are imported by the
 * daemon after activation, off the boot path.
 */
export async function buildProjectSnapshotArchive(
  project: GitBackedProject,
  repository: ProjectSnapshotRepository,
  refInput: string,
  shaInput: string,
): Promise<BuiltProjectSnapshot> {
  const ref = normalizeSnapshotRef(refInput);
  const sha = validateSha(shaInput);
  let mirror = await refreshMirror(project);
  if (!(await mirrorHasCommit(mirror, sha))) {
    mirror = await refreshMirror(project, true);
    if (!(await mirrorHasCommit(mirror, sha))) throw new ProjectSnapshotSourceMissingError(sha);
  }

  await mkdir(buildRoot(), { recursive: true });
  const root = await mkdtemp(join(buildRoot(), 'build-'));
  const cleanup = () => rm(root, { recursive: true, force: true });
  const checkout = join(root, 'checkout');
  const treePath = join(root, `${sha}.tree.tar.gz`);
  const blobsPath = join(root, `${sha}.blobs.pack`);
  const treePackPath = join(root, `${sha}.tree.pack`);
  try {
    await mkdir(checkout);
    await runGit(['init', '-q', '-b', ref, checkout], undefined, false);
    await runGit(
      [
        '-c',
        'uploadpack.allowAnySHA1InWant=true',
        // Keep what arrives as ONE pack: below transfer.unpackLimit (100
        // objects) git would explode a small fetch into loose objects, and
        // the object-store split below must be able to remove all of it.
        '-c',
        'transfer.unpackLimit=1',
        'fetch',
        '-q',
        '--depth',
        '1',
        '--no-tags',
        pathToFileURL(mirror).href,
        sha,
      ],
      checkout,
      false,
      undefined,
      undefined,
      undefined,
      120_000,
    );
    await runGit(['checkout', '-q', '-B', ref, 'FETCH_HEAD'], checkout, false);
    const head = (await runGit(['rev-parse', '--verify', 'HEAD'], checkout, false)).stdout.trim();
    if (head !== sha) throw new Error(`project snapshot checkout mismatch: expected ${sha}, got ${head}`);

    // Sanitize: nothing that names a remote, a credential, a hook, or this
    // machine's stat cache leaves with the archive.
    await rm(join(checkout, '.git', 'logs'), { recursive: true, force: true });
    await rm(join(checkout, '.git', 'hooks'), { recursive: true, force: true });
    await rm(join(checkout, '.git', 'FETCH_HEAD'), { force: true });
    await rm(join(checkout, '.git', 'index'), { force: true });
    await runGit(['read-tree', 'HEAD'], checkout, false);

    // Split the object store. The hydration pack is everything reachable from
    // the tip (commit, trees, blobs — the small non-blob part is duplicated on
    // purpose so the pack stands alone). The boot `.git` keeps only a pack of
    // the commit, the trees and the SYMLINK blobs: `git status` compares a
    // symlink against its blob's content (ce_compare_link), so those bytes-
    // sized blobs must be local for the tree to be refreshable without a
    // fetch; every regular file is hashed from the working tree. That pack is
    // imported through index-pack so it is named and indexed the way git
    // expects, the fetched pack is removed, and the boot pack is marked
    // promisor: git reads "missing" as "fetchable", never as corruption.
    const packDir = join(checkout, '.git', 'objects', 'pack');
    const fetchedPacks = (await readdir(packDir)).filter((n) => /\.(pack|idx|keep|promisor|rev|mtimes)$/.test(n));
    await spawnGit(['pack-objects', '--revs', '--stdout', '-q'], checkout, { stdin: 'HEAD\n', stdoutPath: blobsPath });
    const nonBlobs = (await spawnGit(['rev-list', '--objects', '--filter=blob:none', 'HEAD'], checkout, {})).stdout;
    const symlinkBlobs = (await spawnGit(['ls-tree', '-r', 'HEAD'], checkout, {})).stdout
      .split('\n')
      .filter((line) => line.startsWith('120000 blob '))
      .map((line) => line.split(/\s+/)[2] ?? '');
    const bootObjects = [...nonBlobs.split('\n').map((l) => l.slice(0, 40)), ...symlinkBlobs].filter((id) => /^[0-9a-f]{40}$/.test(id));
    await spawnGit(['pack-objects', '--stdout', '-q'], checkout, {
      stdin: `${bootObjects.join('\n')}\n`,
      stdoutPath: treePackPath,
    });
    const indexed = await spawnGit(['index-pack', '--stdin'], checkout, { stdinPath: treePackPath });
    const packSum = indexed.stdout.match(/^pack\t([0-9a-f]{40,64})/m)?.[1];
    if (!packSum) throw new Error(`git index-pack did not name the blobless pack: ${indexed.stdout.slice(0, 200)}`);
    // Only the boot pack may remain: the fetched pack(s) and any loose object
    // (a fetch below transfer.unpackLimit, a stray write) carry blobs.
    for (const name of fetchedPacks) await rm(join(packDir, name), { force: true });
    const objectsDir = join(checkout, '.git', 'objects');
    for (const entry of await readdir(objectsDir)) {
      if (/^[0-9a-f]{2}$/.test(entry)) await rm(join(objectsDir, entry), { recursive: true, force: true });
    }
    const leftover = (await readdir(packDir)).filter((n) => !n.startsWith(`pack-${packSum}.`));
    if (leftover.length > 0) throw new Error(`unexpected objects next to the boot pack: ${leftover.join(', ')}`);
    await writeFile(join(packDir, `pack-${packSum}.promisor`), '');
    await rm(treePackPath, { force: true });
    const shipped = (await runGit(['rev-parse', '--verify', 'HEAD'], checkout, false)).stdout.trim();
    if (shipped !== sha) throw new Error(`blobless checkout lost its commit: expected ${sha}, got ${shipped}`);

    const marker: ProjectSnapshotMarker = {
      format: PROJECT_SNAPSHOT_FORMAT,
      repository: {
        owner: repository.owner,
        name: repository.name,
        external_id: repository.externalId,
      },
      ref,
      commit_sha: sha,
    };
    await writeFile(join(checkout, PROJECT_SNAPSHOT_MARKER_PATH), `${JSON.stringify(marker)}\n`, {
      mode: 0o644,
    });

    let entries = 0;
    await tar.create(
      {
        cwd: checkout,
        file: treePath,
        gzip: { level: 6 },
        portable: true,
        noMtime: true,
        filter: () => {
          entries += 1;
          return true;
        },
      },
      ['.'],
    );
    const treeBytes = (await stat(treePath)).size;
    const blobsBytes = (await stat(blobsPath)).size;
    const maxBytes = config.KORTIX_PROJECT_SNAPSHOT_MAX_ARCHIVE_BYTES;
    if (treeBytes > maxBytes) throw new ProjectSnapshotTooLargeError(maxBytes, treeBytes);
    if (blobsBytes > maxBytes) throw new ProjectSnapshotTooLargeError(maxBytes, blobsBytes);
    const [treeSha256, blobsSha256] = await Promise.all([sha256File(treePath), sha256File(blobsPath)]);
    await rm(checkout, { recursive: true, force: true });
    return { treePath, treeSha256, treeBytes, entries, blobsPath, blobsSha256, blobsBytes, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

export interface PublishedProjectSnapshot {
  objectPrefix: string;
  treeKey: string;
  sha256: string;
  bytes: number;
  entries: number;
  blobsKey: string;
  blobsSha256: string;
  blobsBytes: number;
  archive: 'created' | 'exists';
  manifest: 'created' | 'exists';
}

function fromManifest(objectPrefix: string, manifest: ProjectSnapshotManifest): PublishedProjectSnapshot {
  return {
    objectPrefix,
    treeKey: manifest.tree.key,
    sha256: manifest.tree.sha256,
    bytes: manifest.tree.bytes,
    entries: manifest.tree.entries,
    blobsKey: manifest.blobs.key,
    blobsSha256: manifest.blobs.sha256,
    blobsBytes: manifest.blobs.bytes,
    archive: 'exists',
    manifest: 'exists',
  };
}

/**
 * Publish tree object, then blob pack, then manifest. If a manifest already
 * exists (another producer won), ITS objects are the truth: verify they are
 * really there and report their digests, never overwrite.
 */
export async function publishProjectSnapshot(input: {
  repository: ProjectSnapshotRepository;
  ref: string;
  commitSha: string;
  built: BuiltProjectSnapshot;
}): Promise<PublishedProjectSnapshot> {
  const objectPrefix = projectSnapshotObjectPrefix(input.repository, input.commitSha);
  const manifestKey = projectSnapshotManifestKey(objectPrefix);
  const existingManifest = await getObjectText(manifestKey);
  if (existingManifest) {
    const manifest = parseManifest(existingManifest, input.commitSha);
    let [tree, blobs] = await Promise.all([headObject(manifest.tree.key), headObject(manifest.blobs.key)]);
    if (!tree || !blobs) {
      // The manifest outlived its objects (a lifecycle rule expires them by
      // age; the manifest is written last and can survive a window, or an
      // operator removed an object). The build is deterministic — same tree,
      // same gzip, same pack — so this build's digests are the manifest's
      // digests and the objects can be republished under their own keys. The
      // manifest itself is immutable by design (no overwrite, no delete): a
      // digest that differs is a real inconsistency and stops here loudly.
      if (manifest.tree.sha256 !== input.built.treeSha256 || manifest.blobs.sha256 !== input.built.blobsSha256) {
        throw new Error(
          `published manifest at ${manifestKey} names objects that are missing and this build's digests differ (tree ${manifest.tree.sha256} vs ${input.built.treeSha256}); remove the prefix to rebuild`,
        );
      }
      if (!tree) {
        await putObjectIfAbsent({
          key: manifest.tree.key,
          body: { path: input.built.treePath, bytes: input.built.treeBytes },
          contentType: PROJECT_SNAPSHOT_ARCHIVE_CONTENT_TYPE,
        });
      }
      if (!blobs) {
        await putObjectIfAbsent({
          key: manifest.blobs.key,
          body: { path: input.built.blobsPath, bytes: input.built.blobsBytes },
          contentType: PROJECT_SNAPSHOT_BLOBS_CONTENT_TYPE,
        });
      }
      [tree, blobs] = await Promise.all([headObject(manifest.tree.key), headObject(manifest.blobs.key)]);
    }
    if (!tree || tree.bytes !== manifest.tree.bytes || !blobs || blobs.bytes !== manifest.blobs.bytes) {
      throw new Error(`published manifest at ${manifestKey} names an object that is missing or truncated`);
    }
    return fromManifest(objectPrefix, manifest);
  }

  const treeKey = projectSnapshotTreeKey(objectPrefix, input.built.treeSha256);
  const blobsKey = projectSnapshotBlobsKey(objectPrefix, input.built.blobsSha256);
  const treeOutcome = await putObjectIfAbsent({
    key: treeKey,
    body: { path: input.built.treePath, bytes: input.built.treeBytes },
    contentType: PROJECT_SNAPSHOT_ARCHIVE_CONTENT_TYPE,
  });
  const blobsOutcome = await putObjectIfAbsent({
    key: blobsKey,
    body: { path: input.built.blobsPath, bytes: input.built.blobsBytes },
    contentType: PROJECT_SNAPSHOT_BLOBS_CONTENT_TYPE,
  });
  // Both objects must be fully there before the manifest advertises them.
  const [treeHead, blobsHead] = await Promise.all([headObject(treeKey), headObject(blobsKey)]);
  if (!treeHead || treeHead.bytes !== input.built.treeBytes) {
    throw new Error(`tree object upload verification failed for ${treeKey}`);
  }
  if (!blobsHead || blobsHead.bytes !== input.built.blobsBytes) {
    throw new Error(`blob pack upload verification failed for ${blobsKey}`);
  }
  const manifest: ProjectSnapshotManifest = {
    format: PROJECT_SNAPSHOT_FORMAT,
    repository: {
      owner: input.repository.owner,
      name: input.repository.name,
      external_id: input.repository.externalId,
    },
    ref: normalizeSnapshotRef(input.ref),
    commit_sha: input.commitSha,
    tree: {
      key: treeKey,
      sha256: input.built.treeSha256,
      bytes: input.built.treeBytes,
      entries: input.built.entries,
      container: 'tar',
      compression: 'gzip',
      content_type: PROJECT_SNAPSHOT_ARCHIVE_CONTENT_TYPE,
    },
    blobs: {
      key: blobsKey,
      sha256: input.built.blobsSha256,
      bytes: input.built.blobsBytes,
      container: 'git-pack',
      content_type: PROJECT_SNAPSHOT_BLOBS_CONTENT_TYPE,
    },
    limits: { max_archive_bytes: config.KORTIX_PROJECT_SNAPSHOT_MAX_ARCHIVE_BYTES },
    produced_at: new Date().toISOString(),
  };
  const manifestOutcome = await putObjectIfAbsent({
    key: manifestKey,
    body: `${JSON.stringify(manifest)}\n`,
    contentType: 'application/json',
  });
  if (manifestOutcome === 'exists') {
    // Lost the race between our manifest read and write: re-read the winner.
    const winner = parseManifest((await getObjectText(manifestKey)) ?? '', input.commitSha);
    return fromManifest(objectPrefix, winner);
  }
  return {
    objectPrefix,
    treeKey,
    sha256: input.built.treeSha256,
    bytes: input.built.treeBytes,
    entries: input.built.entries,
    blobsKey,
    blobsSha256: input.built.blobsSha256,
    blobsBytes: input.built.blobsBytes,
    archive: treeOutcome === 'created' && blobsOutcome === 'created' ? 'created' : 'exists',
    manifest: 'created',
  };
}

const DIGEST_RE = /^[0-9a-f]{64}$/;

export function parseManifest(text: string, expectedSha: string): ProjectSnapshotManifest {
  let parsed: ProjectSnapshotManifest;
  try {
    parsed = JSON.parse(text) as ProjectSnapshotManifest;
  } catch {
    throw new Error('published manifest is not valid JSON');
  }
  const objectOk = (o: { key?: unknown; sha256?: unknown; bytes?: unknown } | undefined) =>
    typeof o?.key === 'string' &&
    DIGEST_RE.test(typeof o.sha256 === 'string' ? o.sha256 : '') &&
    Number.isInteger(o.bytes) &&
    (o.bytes as number) > 0;
  if (
    parsed?.format !== PROJECT_SNAPSHOT_FORMAT ||
    parsed.commit_sha !== expectedSha ||
    !objectOk(parsed.tree) ||
    !objectOk(parsed.blobs)
  ) {
    throw new Error(`published manifest does not describe commit ${expectedSha}`);
  }
  return parsed;
}

// ── One claimed row, end to end ─────────────────────────────────────────────

export interface ProcessedProjectSnapshot {
  snapshotId: string;
  projectId: string;
  commitSha: string;
  outcome: 'ready' | 'requeued' | 'failed';
  error?: string;
  buildMs: number;
  publishMs: number;
  /** Boot object size. */
  bytes?: number;
  entries?: number;
  /** Hydration object size. */
  blobsBytes?: number;
  archive?: 'created' | 'exists';
}

export async function processProjectSnapshot(
  snapshotId: string,
  workerId: string,
): Promise<ProcessedProjectSnapshot | null> {
  const [row] = await db
    .select()
    .from(projectSnapshotArchives)
    .where(
      and(
        eq(projectSnapshotArchives.snapshotId, snapshotId),
        eq(projectSnapshotArchives.lockedBy, workerId),
      ),
    )
    .limit(1);
  if (!row) return null;
  const base = { snapshotId, projectId: row.projectId, commitSha: row.commitSha };
  const [project] = await db
    .select({
      projectId: projects.projectId,
      repoUrl: projects.repoUrl,
      defaultBranch: projects.defaultBranch,
      manifestPath: projects.manifestPath,
    })
    .from(projects)
    .where(eq(projects.projectId, row.projectId))
    .limit(1);
  if (!project) {
    await settleFailure(snapshotId, workerId, row.attempts, new Error('project no longer exists'), false);
    return { ...base, outcome: 'failed', error: 'project no longer exists', buildMs: 0, publishMs: 0 };
  }
  const repository: ProjectSnapshotRepository = {
    owner: row.repoOwner,
    name: row.repoName,
    externalId: row.externalRepoId,
  };
  const gitProject: GitBackedProject = { ...project, gitAuthToken: null };
  const buildStart = Date.now();
  let built: BuiltProjectSnapshot | null = null;
  try {
    built = await buildProjectSnapshotArchive(gitProject, repository, row.ref, row.commitSha);
    const buildMs = Date.now() - buildStart;
    const publishStart = Date.now();
    const published = await publishProjectSnapshot({
      repository,
      ref: row.ref,
      commitSha: row.commitSha,
      built,
    });
    const publishMs = Date.now() - publishStart;
    await settleReady(snapshotId, workerId, {
      objectPrefix: published.objectPrefix,
      sha256: published.sha256,
      bytes: published.bytes,
      entries: published.entries,
      blobsSha256: published.blobsSha256,
      blobsBytes: published.blobsBytes,
    });
    return {
      ...base,
      outcome: 'ready',
      buildMs,
      publishMs,
      bytes: published.bytes,
      entries: published.entries,
      blobsBytes: published.blobsBytes,
      archive: published.archive,
    };
  } catch (error) {
    const retryable = !(error instanceof ProjectSnapshotTooLargeError);
    const outcome = await settleFailure(snapshotId, workerId, row.attempts, error, retryable);
    return {
      ...base,
      outcome,
      error: error instanceof Error ? error.message : String(error),
      buildMs: Date.now() - buildStart,
      publishMs: 0,
    };
  } finally {
    await built?.cleanup().catch(() => {});
  }
}

export function newProjectSnapshotWorkerId(): string {
  return `project-snapshot-${process.pid}-${randomBytes(4).toString('hex')}`;
}
