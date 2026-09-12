#!/usr/bin/env bun
/**
 * Project snapshot archives (S3 config provider) — operator tool.
 *
 *   bun run scripts/project-snapshot.ts ensure-bucket
 *   bun run scripts/project-snapshot.ts prepare <projectId> [--ref main] [--sha <40hex>] [--wait]
 *   bun run scripts/project-snapshot.ts status  <projectId> [--sha <40hex>]
 *   bun run scripts/project-snapshot.ts retry   <projectId> --sha <40hex>
 *   bun run scripts/project-snapshot.ts backfill [--limit 50] [--wait]
 *   bun run scripts/project-snapshot.ts worker-once
 *
 * Run through the API's env, e.g.
 *   cd apps/api && dotenvx run --ignore=MISSING_ENV_FILE -f .env.local -f .env -- bun run scripts/project-snapshot.ts status <projectId>
 *
 * `prepare` resolves the ref's tip from the API's Git mirror (or takes an exact
 * --sha), queues it, and with --wait runs the worker inline until the row is
 * ready or failed. `status` prints the ledger row and verifies the published
 * archive + manifest objects exist with the recorded size. `backfill` queues
 * the default-branch tip of every active project that has no ready row yet —
 * default branches only, never a scan of every branch or commit. `worker-once`
 * runs one worker pass in this process (the API's leader runs it continuously).
 */
import { and, eq, sql } from 'drizzle-orm';
import { HeadBucketCommand, CreateBucketCommand } from '@aws-sdk/client-s3';
import { projectSnapshotArchives, projects } from '@kortix/db';
import { db } from '../src/shared/db';
import { config } from '../src/config';
import {
  enqueueProjectSnapshot,
  queueProjectSnapshotForRef,
  readProjectSnapshot,
  retryProjectSnapshot,
} from '../src/git-proxy/project-snapshot';
import { runProjectSnapshotWorkerOnce } from '../src/git-proxy/project-snapshot-worker';
import {
  getObjectText,
  headObject,
  projectSnapshotArchiveKey,
  projectSnapshotBucket,
  projectSnapshotManifestKey,
  projectSnapshotS3Client,
  projectSnapshotStorageConfigured,
} from '../src/git-proxy/project-snapshot-store';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

function requireStorage(): void {
  if (!projectSnapshotStorageConfigured()) {
    console.error('KORTIX_PROJECT_SNAPSHOT_S3_BUCKET is not configured');
    process.exit(2);
  }
}

async function loadProject(projectId: string) {
  const [row] = await db
    .select({
      projectId: projects.projectId,
      repoUrl: projects.repoUrl,
      defaultBranch: projects.defaultBranch,
      manifestPath: projects.manifestPath,
    })
    .from(projects)
    .where(eq(projects.projectId, projectId))
    .limit(1);
  if (!row) {
    console.error(`project ${projectId} not found`);
    process.exit(2);
  }
  return { ...row, gitAuthToken: null };
}

async function waitFor(projectId: string, sha: string, timeoutMs = 10 * 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await runProjectSnapshotWorkerOnce();
    const row = await readProjectSnapshot(projectId, sha);
    if (row?.status === 'ready' || row?.status === 'failed') return;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  console.error('timed out waiting for the snapshot to settle');
  process.exit(1);
}

async function printStatus(projectId: string, sha: string): Promise<number> {
  const row = await readProjectSnapshot(projectId, sha);
  if (!row) {
    console.log(JSON.stringify({ projectId, sha, status: 'absent' }));
    return 1;
  }
  const out: Record<string, unknown> = {
    projectId,
    sha,
    ref: row.ref,
    status: row.status,
    attempts: row.attempts,
    next_attempt_at: row.nextAttemptAt,
    last_error: row.lastError,
    object_prefix: row.objectPrefix,
    archive_sha256: row.archiveSha256,
    archive_bytes: row.archiveBytes,
    entry_count: row.entryCount,
    ready_at: row.readyAt,
  };
  if (row.status === 'ready' && row.objectPrefix && row.archiveSha256) {
    const archiveKey = projectSnapshotArchiveKey(row.objectPrefix, row.archiveSha256);
    const head = await headObject(archiveKey);
    const manifest = await getObjectText(projectSnapshotManifestKey(row.objectPrefix));
    out.archive_object = head ? { bytes: head.bytes, matches_ledger: head.bytes === row.archiveBytes } : 'MISSING';
    out.manifest_object = manifest ? 'present' : 'MISSING';
  }
  console.log(JSON.stringify(out, null, 2));
  return row.status === 'ready' && out.archive_object !== 'MISSING' && out.manifest_object !== 'MISSING' ? 0 : 1;
}

const command = process.argv[2];
switch (command) {
  case 'ensure-bucket': {
    requireStorage();
    const Bucket = projectSnapshotBucket();
    try {
      await projectSnapshotS3Client().send(new HeadBucketCommand({ Bucket }));
      console.log(`bucket ${Bucket} exists`);
    } catch {
      await projectSnapshotS3Client().send(new CreateBucketCommand({ Bucket }));
      console.log(`bucket ${Bucket} created`);
    }
    break;
  }
  case 'prepare': {
    requireStorage();
    const projectId = process.argv[3];
    if (!projectId) {
      console.error('usage: prepare <projectId> [--ref main] [--sha <40hex>] [--wait]');
      process.exit(2);
    }
    const project = await loadProject(projectId);
    const ref = arg('ref') ?? project.defaultBranch;
    let sha = arg('sha');
    let outcome: string;
    if (sha) {
      outcome = await enqueueProjectSnapshot({ projectId, ref, commitSha: sha, repoUrl: project.repoUrl });
    } else {
      const queued = await queueProjectSnapshotForRef(project, ref);
      outcome = queued.outcome;
      sha = queued.commitSha ?? undefined;
    }
    console.log(JSON.stringify({ projectId, ref, sha, enqueue: outcome }));
    if (flag('wait') && sha) {
      await waitFor(projectId, sha);
      process.exit(await printStatus(projectId, sha));
    }
    break;
  }
  case 'status': {
    requireStorage();
    const projectId = process.argv[3];
    if (!projectId) {
      console.error('usage: status <projectId> [--sha <40hex>]');
      process.exit(2);
    }
    let sha = arg('sha');
    if (!sha) {
      const project = await loadProject(projectId);
      const { resolveCommitSha } = await import('../src/projects/git/commits');
      sha = await resolveCommitSha(project, project.defaultBranch);
    }
    process.exit(await printStatus(projectId, sha));
  }
  case 'retry': {
    requireStorage();
    const projectId = process.argv[3];
    const sha = arg('sha');
    if (!projectId || !sha) {
      console.error('usage: retry <projectId> --sha <40hex>');
      process.exit(2);
    }
    console.log(JSON.stringify({ projectId, sha, requeued: await retryProjectSnapshot(projectId, sha) }));
    break;
  }
  case 'backfill': {
    requireStorage();
    const limit = Number(arg('limit') ?? 50);
    const rows = (await db.execute(sql`
      select p.project_id, p.repo_url, p.default_branch, p.manifest_path
      from kortix.projects p
      where p.status = 'active'
        and not exists (
          select 1 from kortix.project_snapshot_archives s
          where s.project_id = p.project_id and s.status = 'ready'
        )
      order by p.last_opened_at desc nulls last
      limit ${limit}
    `)) as unknown as Array<{ project_id: string; repo_url: string; default_branch: string; manifest_path: string }>;
    let queued = 0;
    for (const row of rows) {
      try {
        const result = await queueProjectSnapshotForRef(
          {
            projectId: row.project_id,
            repoUrl: row.repo_url,
            defaultBranch: row.default_branch,
            manifestPath: row.manifest_path,
            gitAuthToken: null,
          },
          row.default_branch,
        );
        if (result.outcome === 'queued') queued += 1;
        console.log(JSON.stringify({ projectId: row.project_id, sha: result.commitSha, enqueue: result.outcome }));
      } catch (err) {
        console.log(JSON.stringify({ projectId: row.project_id, error: err instanceof Error ? err.message : String(err) }));
      }
    }
    console.log(JSON.stringify({ candidates: rows.length, queued }));
    if (flag('wait')) {
      for (let i = 0; i < 600; i += 1) {
        const processed = await runProjectSnapshotWorkerOnce();
        const [pending] = (await db
          .select({ n: sql<number>`count(*)::int` })
          .from(projectSnapshotArchives)
          .where(and(sql`${projectSnapshotArchives.status} in ('queued','building')`))) as Array<{ n: number }>;
        if (processed.length === 0 && (pending?.n ?? 0) === 0) break;
        await new Promise((r) => setTimeout(r, 1_000));
      }
    }
    break;
  }
  case 'worker-once': {
    requireStorage();
    const processed = await runProjectSnapshotWorkerOnce();
    console.log(JSON.stringify(processed, null, 2));
    break;
  }
  default:
    console.error('usage: project-snapshot.ts <ensure-bucket|prepare|status|retry|backfill|worker-once> …');
    process.exit(2);
}
process.exit(0);
