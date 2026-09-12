/**
 * End-to-end repository snapshot: real database -> real publisher -> real S3 ->
 * real Supervisor extractor, with Git NETWORK blocked and counted on both sides.
 *
 * Nothing here is mocked. It runs the shipped modules against:
 *   - the local Postgres (`DATABASE_URL`),
 *   - a live S3 API server (MinIO by default; any endpoint the env names),
 *   - a real local Git repository as the upstream,
 *   - the real `apps/kortix-sandbox-agent-server` materializer.
 *
 * The Git guard is a PATH shim, not a log assertion. Every `git` invocation the
 * prepared start makes is recorded; any invocation that would touch the network
 * exits non-zero AND is counted, so "zero attempted Git network operations" is
 * proved rather than inferred from the absence of a message.
 *
 * Setup:
 *   docker run -d --name kortix-snapshot-minio -p 19000:9000 \
 *     -e MINIO_ROOT_USER=kortixsnapshots -e MINIO_ROOT_PASSWORD=kortixsnapshots123 \
 *     quay.io/minio/minio:latest server /data
 *   docker exec kortix-snapshot-minio mc alias set local http://127.0.0.1:9000 \
 *     kortixsnapshots kortixsnapshots123
 *   docker exec kortix-snapshot-minio mc mb --ignore-existing local/kortix-repo-snapshots
 *
 * Run:
 *   cd apps/api && dotenvx run -- bun test --isolate src/__tests__/integration-repo-snapshot-e2e.test.ts
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';

const ENDPOINT = process.env.KORTIX_REPO_SNAPSHOT_ENDPOINT || 'http://127.0.0.1:19000';
process.env.KORTIX_REPO_SNAPSHOT_ENDPOINT = ENDPOINT;
process.env.KORTIX_REPO_SNAPSHOT_BUCKET ||= 'kortix-repo-snapshots';
process.env.KORTIX_REPO_SNAPSHOT_ACCESS_KEY_ID ||= 'kortixsnapshots';
process.env.KORTIX_REPO_SNAPSHOT_SECRET_ACCESS_KEY ||= 'kortixsnapshots123';
process.env.KORTIX_REPO_SNAPSHOT_REGION ||= 'us-east-1';
process.env.KORTIX_REPO_SNAPSHOT_MODE = 'prefer';

const { db } = await import('../shared/db');
const { buildRepoSnapshot, discardBuiltRepoSnapshot } = await import('../repo-snapshots/build');
const { normalizeRepoSnapshotIdentity } = await import('../repo-snapshots/format');
const { publishRepoSnapshot } = await import('../repo-snapshots/publish');
const { requireRepoSnapshotBucket } = await import('../repo-snapshots/s3');
const { enqueueRepoSnapshot, markRepoSnapshotReady, claimRepoSnapshot, observeRepoRef } = await import(
  '../repo-snapshots/store'
);
const { pinSessionSnapshot, resolveOpencodeConfigDirFromSnapshot } = await import(
  '../repo-snapshots/session-pin'
);
const { readManifest } = await import('../projects/triggers');
const { materializeRepoSnapshotToStage } = await import(
  '../../../kortix-sandbox-agent-server/src/repo-snapshot'
);

const roots: string[] = [];
let live = false;
let hasDb = false;
let projectId = '';
let accountId = '';
let createdAccount = false;
let upstream = '';
let headSha = '';
let repositoryId = '';
/** Absolute path of the recording `git` shim's log. */
let gitLog = '';

function realGit(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Snapshot E2E',
      GIT_AUTHOR_EMAIL: 'e2e@example.invalid',
      GIT_COMMITTER_NAME: 'Snapshot E2E',
      GIT_COMMITTER_EMAIL: 'e2e@example.invalid',
    },
    encoding: 'utf8',
  }).trim();
}

/**
 * A `git` wrapper that records every invocation and FAILS any that would reach
 * the network. `GIT_ALLOW_PROTOCOL=''` is not enough on its own: it blocks
 * transports but leaves the attempt invisible, and the requirement is to count
 * attempts, not just to stop them.
 */
function installGitGuard(): { dir: string; attempts: () => string[]; networkAttempts: () => string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'kortix-git-guard-'));
  roots.push(dir);
  const log = join(dir, 'git-invocations.log');
  writeFileSync(log, '');
  const real = execFileSync('bash', ['-lc', 'command -v git'], { encoding: 'utf8' }).trim();
  const shim = join(dir, 'git');
  writeFileSync(
    shim,
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
for arg in "$@"; do
  case "$arg" in
    clone|fetch|ls-remote|push|pull|remote-https|remote-http)
      printf 'NETWORK %s\\n' "$*" >> ${JSON.stringify(log)}
      echo "git ${'$'}arg blocked by the snapshot E2E guard" >&2
      exit 128
      ;;
  esac
done
exec ${JSON.stringify(real)} "$@"
`,
  );
  chmodSync(shim, 0o755);
  gitLog = log;
  const read = () => readFileSync(log, 'utf8').split('\n').filter(Boolean);
  return {
    dir,
    attempts: read,
    networkAttempts: () => read().filter((line) => line.startsWith('NETWORK ')),
  };
}

async function endpointAlive(): Promise<boolean> {
  try {
    const res = await fetch(`${ENDPOINT}/minio/health/live`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  live = await endpointAlive();
  if (!live) return;
  try {
    const rows = (await db.execute(
      sql`select account_id from kortix.accounts limit 1`,
    )) as unknown as Array<{ account_id: string }>;
    if (rows[0]) {
      accountId = rows[0].account_id;
    } else {
      // A pristine local database has no account. Create one for this run and
      // remove it afterwards; the test needs a real FK target, not a fixture.
      accountId = crypto.randomUUID();
      await db.execute(sql`
        insert into kortix.accounts (account_id, name)
        values (${accountId}, ${'repo-snapshot-e2e'})`);
      createdAccount = true;
    }
    hasDb = true;
  } catch (error) {
    console.warn('[e2e] database unavailable:', error instanceof Error ? error.message : error);
    return;
  }

  const root = mkdtempSync(join(tmpdir(), 'kortix-e2e-source-'));
  roots.push(root);
  upstream = join(root, 'upstream');
  mkdirSync(upstream);
  realGit(['init', '-b', 'main'], upstream);
  writeFileSync(
    join(upstream, 'kortix.yaml'),
    'kortix_version: 2\ndefault_agent: kortix\nagents:\n  kortix:\n    description: e2e agent\n',
  );
  mkdirSync(join(upstream, '.kortix', 'opencode'), { recursive: true });
  writeFileSync(join(upstream, '.kortix', 'opencode', 'opencode.json'), '{"$schema":"https://opencode.ai/config.json"}\n');
  mkdirSync(join(upstream, '.kortix', 'skills', 'never-attached'), { recursive: true });
  writeFileSync(join(upstream, '.kortix', 'skills', 'never-attached', 'SKILL.md'), '# unused skill\n');
  writeFileSync(join(upstream, 'run.sh'), '#!/bin/sh\necho ok\n', { mode: 0o755 });
  realGit(['add', '-A'], upstream);
  realGit(['commit', '-m', 'e2e seed'], upstream);
  headSha = realGit(['rev-parse', 'HEAD'], upstream);

  repositoryId = String(900000000 + Math.floor(Math.random() * 90000000));
  projectId = crypto.randomUUID();
  await db.execute(sql`
    insert into kortix.projects (project_id, account_id, name, repo_url, default_branch, manifest_path, status, metadata)
    values (
      ${projectId}, ${accountId}, ${'repo-snapshot-e2e'}, ${`file://${upstream}`}, ${'main'},
      ${'kortix.yaml'}, ${'active'},
      ${JSON.stringify({ git: { provider: 'github', owner: 'kortix-ai', name: 'e2e-fixture', external_repo_id: repositoryId, auth: { method: 'none' } } })}::jsonb
    )`);

  const cache = mkdtempSync(join(tmpdir(), 'kortix-e2e-mirror-'));
  roots.push(cache);
  process.env.KORTIX_GIT_CACHE_DIR = cache;
  const snapshotCache = mkdtempSync(join(tmpdir(), 'kortix-e2e-snapshot-cache-'));
  roots.push(snapshotCache);
  process.env.KORTIX_REPO_SNAPSHOT_CACHE_DIR = snapshotCache;
});

afterAll(async () => {
  if (projectId && hasDb) {
    await db.execute(sql`delete from kortix.repo_snapshots where repository_id = ${repositoryId}`).catch(() => {});
    await db.execute(sql`delete from kortix.repo_snapshot_refs where repository_id = ${repositoryId}`).catch(() => {});
    await db.execute(sql`delete from kortix.projects where project_id = ${projectId}`).catch(() => {});
    if (createdAccount) {
      await db.execute(sql`delete from kortix.accounts where account_id = ${accountId}`).catch(() => {});
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('repository snapshot end to end', () => {
  test('publishes, pins and materializes with zero attempted Git network operations', async () => {
    if (!live || !hasDb) {
      console.warn('[e2e] skipped — needs a live S3 endpoint and a local database');
      return;
    }
    const identity = normalizeRepoSnapshotIdentity({
      repositoryId,
      owner: 'kortix-ai',
      repo: 'e2e-fixture',
      commitSha: headSha,
    });
    const project = {
      projectId,
      repoUrl: `file://${upstream}`,
      defaultBranch: 'main',
      manifestPath: 'kortix.yaml',
      // A non-null token short-circuits `ensureMirrorAccess`'s lazy DB lookup,
      // which would otherwise derive the real github.com URL from the metadata
      // coordinates this fixture uses for IDENTITY only.
      gitAuthToken: 'e2e-local',
    };

    // ── Preparation (Git IS allowed here: this is the publisher, not a start)
    const built = await buildRepoSnapshot(project, identity, { compression: 'gzip' });
    const published = await publishRepoSnapshot({
      bucket: requireRepoSnapshotBucket(),
      identity,
      manifest: built.manifest,
      archivePath: built.archivePath,
    });
    await discardBuiltRepoSnapshot(built);

    const queued = await enqueueRepoSnapshot({ identity, sourceProjectId: projectId, sourceRef: 'main' });
    const owner = `e2e:${process.pid}`;
    const claimed = await claimRepoSnapshot(owner);
    expect(claimed?.snapshotId).toBe(queued.snapshotId);
    const ready = await markRepoSnapshotReady({
      snapshotId: queued.snapshotId,
      owner,
      manifest: published.manifest,
      manifestKey: published.manifestKey,
    });
    expect(ready?.status).toBe('ready');
    await observeRepoRef({
      identity: { provider: 'github', repositoryId, owner: 'kortix-ai', repo: 'e2e-fixture' },
      ref: 'main',
      desiredSha: headSha,
      via: 'import',
    });

    // ── Prepared start. From here on, Git network access is blocked AND counted.
    const guard = installGitGuard();
    const originalPath = process.env.PATH;
    const originalCacheDir = process.env.KORTIX_GIT_CACHE_DIR;
    process.env.PATH = `${guard.dir}:${originalPath}`;
    // Point the mirror cache at a directory that does not exist, so any code
    // that tried to fall back to Git would have to clone — and be blocked.
    process.env.KORTIX_GIT_CACHE_DIR = join(guard.dir, 'no-mirror-here');
    try {
      const [projectRow] = (await db.execute(
        sql`select * from kortix.projects where project_id = ${projectId}`,
      )) as unknown as Array<Record<string, unknown>>;
      const row = {
        projectId,
        accountId,
        name: 'repo-snapshot-e2e',
        repoUrl: `file://${upstream}`,
        defaultBranch: 'main',
        manifestPath: 'kortix.yaml',
        status: 'active',
        metadata: (projectRow as { metadata?: unknown }).metadata,
      } as never;

      // 1. The pin resolves the revision, the artifact and the capability.
      const outcome = await pinSessionSnapshot({ project: row, ref: 'main' });
      expect(outcome.pinned).toBe(true);
      if (!outcome.pinned) return;
      expect(outcome.pin.commitSha).toBe(headSha);
      expect(outcome.pin.env.KORTIX_REPO_SNAPSHOT_COMMIT_SHA).toBe(headSha);
      expect(outcome.pin.env.KORTIX_REPO_SNAPSHOT_MODE).toBe('prefer');

      // 2. Config discovery reads the archive, not Git.
      const configDir = await resolveOpencodeConfigDirFromSnapshot(outcome.pin.row, 'kortix.yaml');
      expect(configDir).toBe('.kortix/opencode');
      const manifest = await readManifest(project, { snapshot: outcome.pin.row });
      expect(manifest?.commit).toBe(headSha);
      expect(JSON.stringify(manifest)).toContain('kortix');

      // 3. The Supervisor streams the archive from S3 and activates it.
      const stage = join(mkdtempSync(join(tmpdir(), 'kortix-e2e-stage-')), 'stage');
      roots.push(stage);
      const metrics = await materializeRepoSnapshotToStage(
        {
          url: outcome.pin.descriptor.url,
          sha256: outcome.pin.descriptor.sha256,
          compression: outcome.pin.descriptor.compression,
          commitSha: outcome.pin.descriptor.commitSha,
          repositoryId: outcome.pin.descriptor.repositoryId,
          compressedBytes: outcome.pin.descriptor.compressedBytes,
          expandedBytes: outcome.pin.descriptor.expandedBytes,
          entryCount: outcome.pin.descriptor.entryCount,
        },
        stage,
      );
      expect(metrics.commitSha).toBe(headSha);

      // The workspace is the real revision, unused skills included.
      expect(readFileSync(join(stage, 'kortix.yaml'), 'utf8')).toContain('kortix_version: 2');
      expect(existsSync(join(stage, '.kortix/skills/never-attached/SKILL.md'))).toBe(true);
      expect(realGit(['rev-parse', 'HEAD'], stage)).toBe(headSha);
      expect(realGit(['status', '--porcelain'], stage)).toBe('');

      // 4. THE ASSERTION: not one Git network operation was attempted.
      expect(guard.networkAttempts()).toEqual([]);
      // …and the guard was genuinely on the path for local Git work.
      expect(guard.attempts().length).toBeGreaterThan(0);
    } finally {
      process.env.PATH = originalPath;
      if (originalCacheDir) process.env.KORTIX_GIT_CACHE_DIR = originalCacheDir;
    }
  }, 180_000);

  test('the guard itself blocks and counts a Git network attempt', async () => {
    if (!live || !hasDb) return;
    // A guard that silently allowed everything would make the assertion above
    // vacuous. Prove it fires.
    const guard = installGitGuard();
    const probe = mkdtempSync(join(tmpdir(), 'kortix-e2e-probe-'));
    roots.push(probe);
    let failed = false;
    try {
      execFileSync(join(guard.dir, 'git'), ['clone', 'https://github.com/kortix-ai/suna.git', join(probe, 'x')], {
        encoding: 'utf8',
        stdio: 'pipe',
      });
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    expect(guard.networkAttempts().length).toBe(1);
  }, 60_000);
});
