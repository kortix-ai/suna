import { randomBytes } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { projectSnapshotArchives, projects } from '@kortix/db';
import type { GitBackedProject } from '../git/types';
import { db } from '../../lib/db';
import { PROJECT_SNAPSHOT_FORMAT, type ProjectSnapshotRepository } from './project-snapshot-store';
import { buildProjectSnapshotArchive, publishProjectSnapshot, ProjectSnapshotTooLargeError, type BuiltProjectSnapshot } from './project-snapshot-build';
import { exponentialBackoffMs } from '../../lib/backoff';

// ── Worker claim / settle ───────────────────────────────────────────────────

export const PROJECT_SNAPSHOT_MAX_ATTEMPTS = 5;
const BUILD_LEASE_MINUTES = 15;

export function projectSnapshotRetryDelayMs(attempts: number): number {
  return exponentialBackoffMs({ attempt: attempts, baseMs: 30_000, capMs: 3_600_000 });
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

async function loadSnapshotProject(projectId: string) {
  const [project] = await db
    .select({
      projectId: projects.projectId,
      repoUrl: projects.repoUrl,
      defaultBranch: projects.defaultBranch,
      manifestPath: projects.manifestPath,
    })
    .from(projects)
    .where(eq(projects.projectId, projectId))
    .limit(1);
  return project;
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
  const project = await loadSnapshotProject(row.projectId);
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
