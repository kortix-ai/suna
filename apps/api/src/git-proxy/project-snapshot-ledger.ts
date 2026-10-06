import { and, eq, sql } from 'drizzle-orm';
import { projectGitConnections, projectSnapshotArchives } from '@kortix/db';
import { validateSha } from '../shared/git-ref';
import type { GitBackedProject } from '../projects/git/types';
import { db } from '../shared/db';
import { PROJECT_SNAPSHOT_FORMAT, headObject, projectSnapshotTreeKey, projectSnapshotBlobsKey, presignProjectSnapshotDownload, projectSnapshotStorageConfigured, type ProjectSnapshotRepository } from './project-snapshot-store';
import { normalizeSnapshotRef, type ReadyProjectSnapshot } from './project-snapshot-shared';


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
