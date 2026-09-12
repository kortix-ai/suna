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
import { randomBytes, createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
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
  PROJECT_SNAPSHOT_ARCHIVE_CONTENT_TYPE,
  PROJECT_SNAPSHOT_FORMAT,
  getObjectText,
  headObject,
  projectSnapshotArchiveKey,
  projectSnapshotManifestKey,
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
  archiveSha256: string;
  archiveBytes: number;
  entryCount: number;
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
    })
    .onConflictDoNothing({ target: [projectSnapshotArchives.projectId, projectSnapshotArchives.commitSha] })
    .returning({ snapshotId: projectSnapshotArchives.snapshotId });
  return inserted.length > 0 ? 'queued' : 'exists';
}

/** Resolve the ref's tip from the mirror, then enqueue that exact SHA. */
export async function queueProjectSnapshotForRef(
  project: GitBackedProject,
  ref: string,
): Promise<{ outcome: EnqueueOutcome; commitSha: string | null }> {
  if (!projectSnapshotStorageConfigured()) return { outcome: 'unconfigured', commitSha: null };
  const { resolveCommitSha } = await import('../projects/git/commits');
  const commitSha = await resolveCommitSha(project, normalizeSnapshotRef(ref));
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
    !row.objectPrefix ||
    !row.archiveSha256 ||
    row.archiveBytes === null ||
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
 * Session-create helper: the pin the sandbox env carries when an archive is
 * ready, and a recorded cache miss (plus an enqueue, so the NEXT session finds
 * it) when it is not.
 */
export async function resolveProjectSnapshotPinForSession(input: {
  projectId: string;
  ref: string;
  commitSha: string | undefined;
  repoUrl: string;
}): Promise<{ pin: string | null; cache: 'hit' | 'miss' | 'no-sha' | 'unconfigured' }> {
  if (!projectSnapshotStorageConfigured()) return { pin: null, cache: 'unconfigured' };
  if (!input.commitSha || !/^[0-9a-f]{40}$/.test(input.commitSha)) return { pin: null, cache: 'no-sha' };
  const ready = await readReadyProjectSnapshot(input.projectId, input.commitSha);
  if (ready) {
    return { pin: `${ready.commitSha}:${ready.archiveSha256}:${ready.archiveBytes}`, cache: 'hit' };
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
  return { pin: null, cache: 'miss' };
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
  result: { objectPrefix: string; sha256: string; bytes: number; entries: number },
): Promise<void> {
  await db
    .update(projectSnapshotArchives)
    .set({
      status: 'ready',
      objectPrefix: result.objectPrefix,
      archiveSha256: result.sha256,
      archiveBytes: result.bytes,
      entryCount: result.entries,
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
  archivePath: string;
  sha256: string;
  bytes: number;
  entries: number;
  /** Delete the build directory. */
  cleanup: () => Promise<void>;
}

/**
 * Build the archive for ONE exact commit from the API's bare mirror. The
 * checkout is a single-commit shallow fetch (`uploadpack.allowAnySHA1InWant`
 * lets a local mirror serve an arbitrary reachable SHA, so a ref that already
 * moved on does not change what this builds). The `.git` that ships is
 * sanitized: no remote, no hooks, no reflogs, a fresh index with no stat data.
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
  const archivePath = join(root, `${sha}.tar.gz`);
  try {
    await mkdir(checkout);
    await runGit(['init', '-q', '-b', ref, checkout], undefined, false);
    await runGit(
      [
        '-c',
        'uploadpack.allowAnySHA1InWant=true',
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
        file: archivePath,
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
    const bytes = (await stat(archivePath)).size;
    const maxBytes = config.KORTIX_PROJECT_SNAPSHOT_MAX_ARCHIVE_BYTES;
    if (bytes > maxBytes) throw new ProjectSnapshotTooLargeError(maxBytes, bytes);
    const sha256 = await sha256File(archivePath);
    await rm(checkout, { recursive: true, force: true });
    return { archivePath, sha256, bytes, entries, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

export interface PublishedProjectSnapshot {
  objectPrefix: string;
  archiveKey: string;
  sha256: string;
  bytes: number;
  entries: number;
  archive: 'created' | 'exists';
  manifest: 'created' | 'exists';
}

/**
 * Publish archive then manifest. If a manifest already exists (another
 * producer won), its archive is the truth: verify it is really there and
 * report ITS digest, never overwrite.
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
    const head = await headObject(manifest.archive.key);
    if (!head || head.bytes !== manifest.archive.bytes) {
      throw new Error(`published manifest at ${manifestKey} names an archive that is missing or truncated`);
    }
    return {
      objectPrefix,
      archiveKey: manifest.archive.key,
      sha256: manifest.archive.sha256,
      bytes: manifest.archive.bytes,
      entries: manifest.archive.entries,
      archive: 'exists',
      manifest: 'exists',
    };
  }

  const archiveKey = projectSnapshotArchiveKey(objectPrefix, input.built.sha256);
  const archive = await putObjectIfAbsent({
    key: archiveKey,
    body: { path: input.built.archivePath, bytes: input.built.bytes },
    contentType: PROJECT_SNAPSHOT_ARCHIVE_CONTENT_TYPE,
  });
  // The object must be fully there before the manifest advertises it.
  const head = await headObject(archiveKey);
  if (!head || head.bytes !== input.built.bytes) {
    throw new Error(`archive upload verification failed for ${archiveKey}`);
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
    archive: {
      key: archiveKey,
      sha256: input.built.sha256,
      bytes: input.built.bytes,
      entries: input.built.entries,
      container: 'tar',
      compression: 'gzip',
      content_type: PROJECT_SNAPSHOT_ARCHIVE_CONTENT_TYPE,
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
    return {
      objectPrefix,
      archiveKey: winner.archive.key,
      sha256: winner.archive.sha256,
      bytes: winner.archive.bytes,
      entries: winner.archive.entries,
      archive: 'exists',
      manifest: 'exists',
    };
  }
  return {
    objectPrefix,
    archiveKey,
    sha256: input.built.sha256,
    bytes: input.built.bytes,
    entries: input.built.entries,
    archive,
    manifest: 'created',
  };
}

export function parseManifest(text: string, expectedSha: string): ProjectSnapshotManifest {
  let parsed: ProjectSnapshotManifest;
  try {
    parsed = JSON.parse(text) as ProjectSnapshotManifest;
  } catch {
    throw new Error('published manifest is not valid JSON');
  }
  if (
    parsed?.format !== PROJECT_SNAPSHOT_FORMAT ||
    parsed.commit_sha !== expectedSha ||
    typeof parsed.archive?.key !== 'string' ||
    !/^[0-9a-f]{64}$/.test(parsed.archive?.sha256 ?? '') ||
    !Number.isInteger(parsed.archive?.bytes) ||
    parsed.archive.bytes <= 0
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
  bytes?: number;
  entries?: number;
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
    });
    return {
      ...base,
      outcome: 'ready',
      buildMs,
      publishMs,
      bytes: published.bytes,
      entries: published.entries,
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
