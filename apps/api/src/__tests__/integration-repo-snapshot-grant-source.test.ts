/**
 * A feature branch cannot widen its own grant — proved against a real database
 * and a live object store, with two genuinely different manifests published.
 *
 * The default branch declares a NARROW grant. A feature branch declares a wide
 * one. A session on the feature branch gets the workspace from the feature
 * branch, and the grant from the default branch. If those two ever came from
 * the same snapshot, this test fails.
 *
 * Run:
 *   cd apps/api && dotenvx run -f .env.local -f .env -- bun test --isolate \
 *     src/__tests__/integration-repo-snapshot-grant-source.test.ts
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';

process.env.KORTIX_REPO_SNAPSHOT_ENDPOINT ??= 'http://127.0.0.1:19000';
process.env.KORTIX_REPO_SNAPSHOT_BUCKET ??= 'kortix-repo-snapshots';
process.env.KORTIX_REPO_SNAPSHOT_ACCESS_KEY_ID ??= 'kortixsnapshots';
process.env.KORTIX_REPO_SNAPSHOT_SECRET_ACCESS_KEY ??= 'kortixsnapshots123';
process.env.KORTIX_REPO_SNAPSHOT_REGION ??= 'us-east-1';
process.env.KORTIX_REPO_SNAPSHOT_MODE = 'prefer';

const { db } = await import('../shared/db');
const { buildRepoSnapshot, discardBuiltRepoSnapshot } = await import('../repo-snapshots/build');
const { normalizeRepoSnapshotIdentity } = await import('../repo-snapshots/format');
const { publishRepoSnapshot } = await import('../repo-snapshots/publish');
const { requireRepoSnapshotBucket } = await import('../repo-snapshots/s3');
const { pinSessionSnapshot, resolveDefaultBranchGrantSnapshot } = await import(
  '../repo-snapshots/session-pin'
);
const { observeRepoRef } = await import('../repo-snapshots/store');
const { resolveAgentGrant } = await import('../projects/agents');

const ALLOW_SKIP = process.env.KORTIX_REPO_SNAPSHOT_E2E === 'skip';
const roots: string[] = [];
let ready = false;
let reason = '';
let projectId = '';
let repositoryId = '';
let defaultSha = '';
let featureSha = '';
let projectRow: Record<string, unknown> | null = null;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Grant Fixture',
      GIT_AUTHOR_EMAIL: 'grant@example.invalid',
      GIT_COMMITTER_NAME: 'Grant Fixture',
      GIT_COMMITTER_EMAIL: 'grant@example.invalid',
    },
    encoding: 'utf8',
  }).trim();
}

/** `narrow` sees one secret; `wide` claims every secret and every connector. */
function manifest(scope: 'narrow' | 'wide'): string {
  return scope === 'narrow'
    ? [
        'kortix_version: 2',
        'default_agent: kortix',
        'agents:',
        '  kortix:',
        '    description: narrow default-branch agent',
        '    secrets:',
        '      - NARROW_ONLY',
        '    connectors: []',
        '',
      ].join('\n')
    : [
        'kortix_version: 2',
        'default_agent: kortix',
        'agents:',
        '  kortix:',
        '    description: WIDE feature-branch agent',
        "    secrets: 'all'",
        "    connectors: 'all'",
        "    kortix_cli: 'all'",
        '',
      ].join('\n');
}

async function publish(
  upstream: string,
  commitSha: string,
  ref: string,
): Promise<void> {
  const identity = normalizeRepoSnapshotIdentity({
    repositoryId,
    owner: 'kortix-ai',
    repo: 'grant-fixture',
    commitSha,
  });
  const built = await buildRepoSnapshot(
    {
      projectId,
      repoUrl: `file://${upstream}`,
      defaultBranch: 'main',
      manifestPath: 'kortix.yaml',
      gitAuthToken: 'local',
    },
    identity,
    { compression: 'gzip' },
  );
  const published = await publishRepoSnapshot({
    bucket: requireRepoSnapshotBucket(),
    identity,
    manifest: built.manifest,
    archivePath: built.archivePath,
  });
  await discardBuiltRepoSnapshot(built);
  const m = published.manifest;
  await db.execute(sql`
    insert into kortix.repo_snapshots
      (provider, repository_id, owner, repo, commit_sha, format, status, manifest_key, payload_key,
       archive_sha256, compression, tree_sha, compressed_bytes, expanded_bytes, entry_count,
       producer_version, ready_at)
    values ('github', ${repositoryId}, ${identity.owner}, ${identity.repo}, ${commitSha}, ${m.format},
            'ready', ${published.manifestKey}, ${m.payload.key}, ${m.payload.sha256},
            ${m.payload.compression}, ${m.source.tree_sha}, ${m.payload.compressed_bytes},
            ${m.payload.expanded_bytes}, ${m.payload.entry_count}, ${m.producer_version}, now())
    on conflict (provider, repository_id, commit_sha, format) do update set status = 'ready'`);
  await observeRepoRef({
    identity: { provider: 'github', repositoryId, owner: 'kortix-ai', repo: 'grant-fixture' },
    ref,
    desiredSha: commitSha,
    via: 'import',
  });
}

beforeAll(async () => {
  try {
    const { requireRepoSnapshotBucket: bucket, s3PutObject } = await import('../repo-snapshots/s3');
    // A signed WRITE, not a HEAD: proving absence needs s3:ListBucket, which a
    // correctly minimal role does not have.
    await s3PutObject(bucket(), `preflight/${crypto.randomUUID()}`, Buffer.from('ok'));
    await db.execute(sql`select 1 from kortix.repo_snapshots limit 1`);
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error);
    return;
  }

  const root = mkdtempSync(join(tmpdir(), 'kortix-grant-source-'));
  roots.push(root);
  const upstream = join(root, 'upstream');
  mkdirSync(upstream);
  git(upstream, 'init', '-b', 'main');
  writeFileSync(join(upstream, 'kortix.yaml'), manifest('narrow'));
  git(upstream, 'add', '-A');
  git(upstream, 'commit', '-m', 'narrow default branch');
  defaultSha = git(upstream, 'rev-parse', 'HEAD');

  git(upstream, 'checkout', '-q', '-b', 'attacker');
  writeFileSync(join(upstream, 'kortix.yaml'), manifest('wide'));
  git(upstream, 'add', '-A');
  git(upstream, 'commit', '-m', 'WIDE feature branch');
  featureSha = git(upstream, 'rev-parse', 'HEAD');
  git(upstream, 'checkout', '-q', 'main');
  expect(featureSha).not.toBe(defaultSha);

  const accounts = (await db.execute(
    sql`select account_id from kortix.accounts limit 1`,
  )) as unknown as Array<{ account_id: string }>;
  let accountId = accounts[0]?.account_id;
  if (!accountId) {
    accountId = crypto.randomUUID();
    await db.execute(
      sql`insert into kortix.accounts (account_id, name) values (${accountId}, ${'grant-source-e2e'})`,
    );
  }
  projectId = crypto.randomUUID();
  repositoryId = String(930000000 + Math.floor(Math.random() * 9000000));
  await db.execute(sql`
    insert into kortix.projects (project_id, account_id, name, repo_url, default_branch, manifest_path, status, metadata)
    values (${projectId}, ${accountId}, 'grant-source', ${`file://${upstream}`}, 'main', 'kortix.yaml',
            'active',
            ${JSON.stringify({
              git: {
                provider: 'github',
                owner: 'kortix-ai',
                name: 'grant-fixture',
                external_repo_id: repositoryId,
                upstream_url: `file://${upstream}`,
                auth: { method: 'none' },
              },
            })}::jsonb)`);

  const cache = mkdtempSync(join(tmpdir(), 'kortix-grant-mirror-'));
  roots.push(cache);
  process.env.KORTIX_GIT_CACHE_DIR = cache;
  const snapshotCache = mkdtempSync(join(tmpdir(), 'kortix-grant-snap-'));
  roots.push(snapshotCache);
  process.env.KORTIX_REPO_SNAPSHOT_CACHE_DIR = snapshotCache;

  await publish(upstream, defaultSha, 'main');
  // The webhook spelling, deliberately: the pin must still find it.
  await publish(upstream, featureSha, 'refs/heads/attacker');

  // Through Drizzle, not raw SQL: the resolver reads `project.defaultBranch`,
  // and a raw row would hand it `default_branch` and silently resolve nothing.
  const { projects } = await import('@kortix/db');
  const { eq } = await import('drizzle-orm');
  const [row] = await db.select().from(projects).where(eq(projects.projectId, projectId)).limit(1);
  projectRow = (row ?? null) as Record<string, unknown> | null;
  ready = true;
});

afterAll(async () => {
  if (projectId) {
    await db.execute(sql`delete from kortix.repo_snapshots where repository_id = ${repositoryId}`).catch(() => {});
    await db.execute(sql`delete from kortix.repo_snapshot_refs where repository_id = ${repositoryId}`).catch(() => {});
    await db.execute(sql`delete from kortix.projects where project_id = ${projectId}`).catch(() => {});
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function guard(): boolean {
  if (ready) return true;
  if (!ALLOW_SKIP) throw new Error(`grant-source prerequisites missing — ${reason}`);
  console.warn(`[grant-source] SKIPPED by KORTIX_REPO_SNAPSHOT_E2E=skip — ${reason}`);
  return false;
}

describe('a feature branch cannot widen its own grant', () => {
  test('the workspace pin follows the session ref', async () => {
    if (!guard()) return;
    const onFeature = await pinSessionSnapshot({ project: projectRow as never, ref: 'attacker' });
    expect(onFeature.pinned).toBe(true);
    if (!onFeature.pinned) return;
    // Written as `refs/heads/attacker`, read as `attacker`: the normalization
    // this depends on is the bug that used to make the webhook's row invisible.
    expect(onFeature.pin.commitSha).toBe(featureSha);
  }, 120_000);

  test('the grant source stays on the default branch', async () => {
    if (!guard()) return;
    const grant = await resolveDefaultBranchGrantSnapshot(projectRow as never);
    expect(grant?.commitSha).toBe(defaultSha);
    expect(grant?.commitSha).not.toBe(featureSha);
  }, 120_000);

  test('the resolved grant is the NARROW one, from the default branch', async () => {
    if (!guard()) return;
    const grantSnapshot = await resolveDefaultBranchGrantSnapshot(projectRow as never);
    const project = {
      projectId,
      repoUrl: (projectRow as { repoUrl: string }).repoUrl,
      defaultBranch: 'main',
      manifestPath: 'kortix.yaml',
      gitAuthToken: 'local',
    };
    const resolved = await resolveAgentGrant('kortix', project, grantSnapshot);
    // The wide manifest on `attacker` claims every secret, connector and CLI
    // action. None of that may appear.
    expect(JSON.stringify(resolved)).not.toContain('all');
    expect(JSON.stringify(resolved)).toContain('NARROW_ONLY');
  }, 120_000);

  test('the feature-branch snapshot WOULD have granted more — the boundary is what stops it', async () => {
    if (!guard()) return;
    // Control. Without this the test above could pass because the fixture never
    // actually differed. Feeding the feature-branch snapshot in directly shows
    // the wide grant is really there and really reachable.
    const onFeature = await pinSessionSnapshot({ project: projectRow as never, ref: 'attacker' });
    expect(onFeature.pinned).toBe(true);
    if (!onFeature.pinned) return;
    const project = {
      projectId,
      repoUrl: (projectRow as { repoUrl: string }).repoUrl,
      defaultBranch: 'main',
      manifestPath: 'kortix.yaml',
      gitAuthToken: 'local',
    };
    const widened = await resolveAgentGrant('kortix', project, onFeature.pin.row);
    expect(JSON.stringify(widened)).toContain('all');
    // …and the production path never passes that row, which the unit tests in
    // `repo-snapshots/grant-source.test.ts` pin at every call site.
  }, 120_000);
});
