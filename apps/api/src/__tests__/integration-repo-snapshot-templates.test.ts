/**
 * The template catalogue a PINNED session sees.
 *
 * A build declaration is not an authorization decision: the Dockerfile path,
 * the resource spec and the set of templates all describe what this session is
 * supposed to run, so they must come from the revision it is running. The
 * catalogue therefore comes from the pin — not from `sandbox_templates` rows
 * left behind by whatever revision last synced, and not from a default chosen
 * because a read quietly failed.
 *
 * Real database, real archives in the object store, real manifests.
 *
 * Run (from apps/api):
 *   dotenvx run -f .env.local -f .env --quiet -- bash -c 'export \
 *     DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:13922/postgres \
 *     KORTIX_URL=http://127.0.0.1:13608; bun test --isolate \
 *     src/__tests__/integration-repo-snapshot-templates.test.ts'
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
const { projects } = await import('@kortix/db');
const { eq } = await import('drizzle-orm');
const { buildRepoSnapshot, discardBuiltRepoSnapshot } = await import('../repo-snapshots/build');
const { normalizeRepoSnapshotIdentity } = await import('../repo-snapshots/format');
const { publishRepoSnapshot } = await import('../repo-snapshots/publish');
const { requireRepoSnapshotBucket } = await import('../repo-snapshots/s3');
const { findRepoSnapshot } = await import('../repo-snapshots/store');
const { listTemplatesForProject, invalidateTemplateCache } = await import('../snapshots/templates');
const { DEFAULT_SANDBOX_SLUG } = await import('../snapshots/dockerfile-layer');

const ALLOW_SKIP = process.env.KORTIX_REPO_SNAPSHOT_E2E === 'skip';
const roots: string[] = [];
let ready = false;
let reason = '';
let projectId = '';
let accountId = '';
let repositoryId = '';
let oldSha = '';
let newSha = '';
let bareSha = '';
/** The shared platform row THIS test inserted, if it had to insert one. */
let seededSharedTemplateId = '';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Template Fixture',
      GIT_AUTHOR_EMAIL: 'templates@example.invalid',
      GIT_COMMITTER_NAME: 'Template Fixture',
      GIT_COMMITTER_EMAIL: 'templates@example.invalid',
    },
    encoding: 'utf8',
  }).trim();
}

/** The OLD revision declares two templates; the NEW one renames and re-specs. */
function manifest(revision: 'old' | 'new'): string {
  return revision === 'old'
    ? [
        'kortix_version: 2',
        'sandbox:',
        '  templates:',
        '    - slug: legacy-image',
        '      name: Legacy',
        '      dockerfile: docker/legacy.Dockerfile',
        '      cpu: 1',
        '    - slug: builder',
        '      name: Builder (old)',
        '      dockerfile: docker/old.Dockerfile',
        '      cpu: 1',
        '      memory: 2',
        '',
      ].join('\n')
    : [
        'kortix_version: 2',
        'sandbox:',
        '  templates:',
        '    - slug: builder',
        '      name: Builder',
        '      dockerfile: docker/new.Dockerfile',
        '      cpu: 4',
        '      memory: 8',
        '',
      ].join('\n');
}

async function publish(upstream: string, commitSha: string): Promise<void> {
  const identity = normalizeRepoSnapshotIdentity({
    repositoryId,
    owner: 'kortix-ai',
    repo: 'template-fixture',
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
}

async function snapshotFor(commitSha: string) {
  const row = await findRepoSnapshot(
    normalizeRepoSnapshotIdentity({ repositoryId, owner: 'kortix-ai', repo: 'template-fixture', commitSha }),
  );
  if (!row) throw new Error(`no snapshot row for ${commitSha}`);
  return row;
}

async function projectRow() {
  const [row] = await db.select().from(projects).where(eq(projects.projectId, projectId)).limit(1);
  return row as never;
}

/** Rows a previous sync of the OLD revision would have left behind. */
async function seedTemplateRows(): Promise<void> {
  for (const [slug, name, source, dockerfile, cpu] of [
    ['legacy-image', 'Legacy', 'toml', 'docker/legacy.Dockerfile', 1],
    ['builder', 'Builder (old)', 'toml', 'docker/old.Dockerfile', 1],
    ['handmade', 'Handmade', 'ui', 'docker/handmade.Dockerfile', 2],
  ] as const) {
    await db.execute(sql`
      insert into kortix.sandbox_templates (project_id, slug, name, source, provider, dockerfile_path, cpu, is_shared)
      values (${projectId}, ${slug}, ${name}, ${source}, 'daytona', ${dockerfile}, ${cpu}, false)`);
  }
}

beforeAll(async () => {
  try {
    const { requireRepoSnapshotBucket: bucket, s3PutObject } = await import('../repo-snapshots/s3');
    await s3PutObject(bucket(), `preflight/${crypto.randomUUID()}`, Buffer.from('ok'));
    await db.execute(sql`select 1 from kortix.repo_snapshots limit 1`);
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error);
    return;
  }

  const root = mkdtempSync(join(tmpdir(), 'kortix-templates-'));
  roots.push(root);
  const upstream = join(root, 'upstream');
  mkdirSync(join(upstream, 'docker'), { recursive: true });
  git(upstream, 'init', '-b', 'main');
  // A revision with NO manifest at all.
  writeFileSync(join(upstream, 'docker', 'legacy.Dockerfile'), 'FROM scratch\n');
  git(upstream, 'add', '-A');
  git(upstream, 'commit', '-m', 'no manifest');
  bareSha = git(upstream, 'rev-parse', 'HEAD');

  writeFileSync(join(upstream, 'kortix.yaml'), manifest('old'));
  writeFileSync(join(upstream, 'docker', 'old.Dockerfile'), 'FROM scratch\nRUN echo old\n');
  git(upstream, 'add', '-A');
  git(upstream, 'commit', '-m', 'old templates');
  oldSha = git(upstream, 'rev-parse', 'HEAD');

  writeFileSync(join(upstream, 'kortix.yaml'), manifest('new'));
  writeFileSync(join(upstream, 'docker', 'new.Dockerfile'), 'FROM scratch\nRUN echo new\n');
  git(upstream, 'add', '-A');
  git(upstream, 'commit', '-m', 'new templates');
  newSha = git(upstream, 'rev-parse', 'HEAD');

  const accounts = (await db.execute(
    sql`select account_id from kortix.accounts limit 1`,
  )) as unknown as Array<{ account_id: string }>;
  accountId = accounts[0]?.account_id ?? crypto.randomUUID();
  if (!accounts[0]?.account_id) {
    await db.execute(
      sql`insert into kortix.accounts (account_id, name) values (${accountId}, ${'templates-e2e'})`,
    );
  }
  projectId = crypto.randomUUID();
  repositoryId = String(970000000 + Math.floor(Math.random() * 9000000));
  await db.execute(sql`
    insert into kortix.projects (project_id, account_id, name, repo_url, default_branch, manifest_path, status, metadata)
    values (${projectId}, ${accountId}, 'templates', ${`file://${upstream}`}, 'main', 'kortix.yaml', 'active',
            ${JSON.stringify({
              git: {
                provider: 'github',
                owner: 'kortix-ai',
                name: 'template-fixture',
                external_repo_id: repositoryId,
                upstream_url: `file://${upstream}`,
                auth: { method: 'none' },
              },
            })}::jsonb)`);

  const cache = mkdtempSync(join(tmpdir(), 'kortix-templates-snap-'));
  roots.push(cache);
  process.env.KORTIX_REPO_SNAPSHOT_CACHE_DIR = cache;

  // The platform default normally arrives with a migration. This database has
  // none, and the precedence assertion is meaningless without it.
  const shared = (await db.execute(
    sql`select count(*)::int as n from kortix.sandbox_templates where is_shared = true`,
  )) as unknown as Array<{ n: number }>;
  if ((shared[0]?.n ?? 0) === 0) {
    const inserted = (await db.execute(sql`
      insert into kortix.sandbox_templates (slug, name, source, provider, is_shared)
      values (${DEFAULT_SANDBOX_SLUG}, 'Platform default', 'platform', 'daytona', true)
      returning template_id`)) as unknown as Array<{ template_id: string }>;
    seededSharedTemplateId = inserted[0]?.template_id ?? '';
  }

  await publish(upstream, bareSha);
  await publish(upstream, oldSha);
  await publish(upstream, newSha);
  await seedTemplateRows();
  ready = true;
});

afterAll(async () => {
  if (projectId) {
    await db.execute(sql`delete from kortix.sandbox_templates where project_id = ${projectId}`).catch(() => {});
    await db.execute(sql`delete from kortix.repo_snapshots where repository_id = ${repositoryId}`).catch(() => {});
    await db.execute(sql`delete from kortix.projects where project_id = ${projectId}`).catch(() => {});
  }
  if (seededSharedTemplateId) {
    // Exactly the row this test inserted — never every shared platform row.
    await db
      .execute(sql`delete from kortix.sandbox_templates where template_id = ${seededSharedTemplateId}`)
      .catch(() => {});
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function guard(): boolean {
  if (ready) return true;
  if (!ALLOW_SKIP) throw new Error(`template catalogue prerequisites missing — ${reason}`);
  console.warn(`[templates] SKIPPED by KORTIX_REPO_SNAPSHOT_E2E=skip — ${reason}`);
  return false;
}

describe('a pinned session sees the catalogue its own revision declares', () => {
  test('a template the pin no longer declares is gone, stale row and all', async () => {
    if (!guard()) return;
    invalidateTemplateCache(projectId);
    const templates = await listTemplatesForProject(await projectRow(), {
      sessionSnapshot: await snapshotFor(newSha),
    });
    // `legacy-image` exists as a project-scoped `source: 'toml'` row, written
    // when the OLD revision synced. The new revision deleted it, so a session
    // pinned to the new revision must not see it — not even with its old path.
    expect(templates.map((t) => t.slug)).not.toContain('legacy-image');
  });

  test('the declaration, path and spec all come from the pin', async () => {
    if (!guard()) return;
    invalidateTemplateCache(projectId);
    const templates = await listTemplatesForProject(await projectRow(), {
      sessionSnapshot: await snapshotFor(newSha),
    });
    const builder = templates.find((t) => t.slug === 'builder');
    expect(builder).toBeTruthy();
    expect(builder?.dockerfilePath).toBe('docker/new.Dockerfile');
    expect(builder?.name).toBe('Builder');
    expect(builder?.cpu).toBe(4);
    expect(builder?.memoryGb).toBe(8);
    expect(builder?.builtFromCommit).toBe(newSha);
    // Resolved in memory: there is no row for it, and none is created.
    expect(builder?.templateId).toBeNull();
  });

  test('two revisions resolve their own declarations, not each other\'s', async () => {
    if (!guard()) return;
    invalidateTemplateCache(projectId);
    const older = await listTemplatesForProject(await projectRow(), {
      sessionSnapshot: await snapshotFor(oldSha),
    });
    const newer = await listTemplatesForProject(await projectRow(), {
      sessionSnapshot: await snapshotFor(newSha),
    });
    expect(older.find((t) => t.slug === 'builder')?.dockerfilePath).toBe('docker/old.Dockerfile');
    expect(newer.find((t) => t.slug === 'builder')?.dockerfilePath).toBe('docker/new.Dockerfile');
    expect(older.map((t) => t.slug)).toContain('legacy-image');
    expect(newer.map((t) => t.slug)).not.toContain('legacy-image');
  });

  test('a pinned read writes nothing to the project-global rows', async () => {
    if (!guard()) return;
    invalidateTemplateCache(projectId);
    await listTemplatesForProject(await projectRow(), { sessionSnapshot: await snapshotFor(newSha) });
    const rows = (await db.execute(sql`
      select slug, source, dockerfile_path from kortix.sandbox_templates
      where project_id = ${projectId} order by slug`)) as unknown as Array<{
      slug: string;
      source: string;
      dockerfile_path: string;
    }>;
    expect(rows.map((r) => r.slug)).toEqual(['builder', 'handmade', 'legacy-image']);
    // Untouched: a session on one revision must not rewrite the row another
    // revision's session reads.
    expect(rows.find((r) => r.slug === 'builder')?.dockerfile_path).toBe('docker/old.Dockerfile');
  });

  test('UI-owned and platform templates survive the pin', async () => {
    if (!guard()) return;
    invalidateTemplateCache(projectId);
    const templates = await listTemplatesForProject(await projectRow(), {
      sessionSnapshot: await snapshotFor(newSha),
    });
    const handmade = templates.find((t) => t.slug === 'handmade');
    expect(handmade?.source).toBe('ui');
    expect(handmade?.dockerfilePath).toBe('docker/handmade.Dockerfile');
    expect(templates.map((t) => t.slug)).toContain(DEFAULT_SANDBOX_SLUG);
  });

  test('a revision with no manifest declares no templates and does not fail', async () => {
    if (!guard()) return;
    invalidateTemplateCache(projectId);
    const templates = await listTemplatesForProject(await projectRow(), {
      sessionSnapshot: await snapshotFor(bareSha),
    });
    expect(templates.map((t) => t.slug)).not.toContain('builder');
    expect(templates.map((t) => t.slug)).not.toContain('legacy-image');
    // Absent is not broken: the UI template and the platform default remain.
    expect(templates.map((t) => t.slug)).toContain('handmade');
    expect(templates.map((t) => t.slug)).toContain(DEFAULT_SANDBOX_SLUG);
  });

  test('an unreadable snapshot fails the catalogue instead of defaulting', async () => {
    if (!guard()) return;
    invalidateTemplateCache(projectId);
    // A revision nothing has materialized yet, so the read really does have to
    // fetch the archive — reusing an already-extracted commit would hit the
    // local cache and prove nothing.
    const broken = {
      ...(await snapshotFor(newSha)),
      commitSha: 'f'.repeat(39) + '1',
      payloadKey: 'does/not/exist.tar.gz',
    };
    // Silently returning the platform default here would build the wrong image
    // and look completely normal doing it.
    await expect(
      listTemplatesForProject(await projectRow(), { sessionSnapshot: broken as never }),
    ).rejects.toThrow();
  });
});
