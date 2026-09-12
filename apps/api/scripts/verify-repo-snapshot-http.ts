#!/usr/bin/env bun
/**
 * The descriptor and archive routes over REAL HTTP with a real Kortix token,
 * against a running API and a live object store.
 *
 * The `tests/` flow suite covers the auth boundary (the 401/400 cases) because
 * that is all a shared deployment can safely assert. This proves the parts a
 * boundary test cannot: the 200 path, that two projects on one revision receive
 * the SAME artifact, that a project on another repository cannot reach it, and
 * that an unprepared revision is a miss rather than a substitution.
 *
 * Requires a running API, a reachable object store, and a database this process
 * may write fixtures to. It creates three projects and one Personal Access
 * Token, and removes all of them before exiting.
 *
 * Usage:
 *   cd apps/api
 *   E2E_JWT=<supabase access token> E2E_ACCOUNT=<account uuid> \
 *   E2E_API=http://localhost:8008/v1 E2E_DB=<postgres url> \
 *   KORTIX_REPO_SNAPSHOT_BUCKET=… KORTIX_REPO_SNAPSHOT_ENDPOINT=… \
 *     bun run scripts/verify-repo-snapshot-http.ts
 *
 * Exits non-zero on the first failed assertion.
 */
const API = process.env.E2E_API ?? 'http://localhost:13608/v1';
const JWT = process.env.E2E_JWT!;
const ACCOUNT = process.env.E2E_ACCOUNT!;
const DB = process.env.E2E_DB ?? 'postgresql://postgres:postgres@127.0.0.1:13922/postgres';

// Storage configuration comes from the environment. No defaults: this script
// must never silently point at someone else's bucket.
process.env.DATABASE_URL = DB;
if (!process.env.KORTIX_REPO_SNAPSHOT_BUCKET) {
  console.error('KORTIX_REPO_SNAPSHOT_BUCKET is required.');
  process.exit(2);
}
if (!JWT || !ACCOUNT) {
  console.error('E2E_JWT and E2E_ACCOUNT are required.');
  process.exit(2);
}

const { execFileSync } = await import('node:child_process');
const { mkdirSync, mkdtempSync, writeFileSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const { SQL } = await import('bun');
const sql = new SQL(DB);
const { buildRepoSnapshot, discardBuiltRepoSnapshot } = await import('../src/repo-snapshots/build');
const { normalizeRepoSnapshotIdentity } = await import('../src/repo-snapshots/format');
const { publishRepoSnapshot } = await import('../src/repo-snapshots/publish');
const { requireRepoSnapshotBucket } = await import('../src/repo-snapshots/s3');

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    env: { ...process.env, GIT_AUTHOR_NAME: 'D', GIT_AUTHOR_EMAIL: 'd@e.invalid', GIT_COMMITTER_NAME: 'D', GIT_COMMITTER_EMAIL: 'd@e.invalid' },
    encoding: 'utf8',
  }).trim();
}

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  ok ? pass++ : fail++;
}

// ── A real Kortix PAT.
const patRes = await fetch(`${API}/accounts/tokens`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${JWT}` },
  body: JSON.stringify({ name: `snapshot-descriptor-${Date.now()}` }),
});
const patBody = (await patRes.json().catch(() => null)) as any;
const PAT = patBody?.secret_key ?? patBody?.token ?? patBody?.access_token;
console.log(`POST /accounts/tokens → ${patRes.status}${PAT ? ' (token acquired)' : ''}`);
if (!PAT) {
  console.log('  no token field in the response');
  process.exit(1);
}

// ── Two projects on ONE repository revision, plus an unrelated third.
const root = mkdtempSync(join(tmpdir(), 'kortix-desc-'));
const upstream = join(root, 'upstream');
mkdirSync(upstream);
git(upstream, 'init', '-b', 'main');
writeFileSync(join(upstream, 'kortix.yaml'), 'kortix_version: 2\ndefault_agent: kortix\nagents:\n  kortix:\n    description: d\n');
git(upstream, 'add', '-A');
git(upstream, 'commit', '-m', 'seed');
const sha = git(upstream, 'rev-parse', 'HEAD');
const repositoryId = String(960000000 + Math.floor(Math.random() * 30000000));
const otherRepositoryId = String(970000000 + Math.floor(Math.random() * 20000000));

async function makeProject(repoId: string): Promise<string> {
  const id = crypto.randomUUID();
  await sql`
    insert into kortix.projects (project_id, account_id, name, repo_url, default_branch, manifest_path, status, metadata)
    values (${id}, ${ACCOUNT}, ${'desc-http'}, ${`file://${upstream}`}, 'main', 'kortix.yaml', 'active',
            ${JSON.stringify({ git: { provider: 'github', owner: 'kortix-ai', name: 'desc-http', external_repo_id: repoId, auth: { method: 'none' } } })}::jsonb)`;
  return id;
}
const projectA = await makeProject(repositoryId);
const projectB = await makeProject(repositoryId);
const projectC = await makeProject(otherRepositoryId);

const identity = normalizeRepoSnapshotIdentity({ repositoryId, owner: 'kortix-ai', repo: 'desc-http', commitSha: sha });
const cache = mkdtempSync(join(tmpdir(), 'kortix-desc-mirror-'));
process.env.KORTIX_GIT_CACHE_DIR = cache;
const built = await buildRepoSnapshot(
  { projectId: projectA, repoUrl: `file://${upstream}`, defaultBranch: 'main', manifestPath: 'kortix.yaml', gitAuthToken: 'local' },
  identity,
  { compression: 'gzip' },
);
const published = await publishRepoSnapshot({ bucket: requireRepoSnapshotBucket(), identity, manifest: built.manifest, archivePath: built.archivePath });
await discardBuiltRepoSnapshot(built);
const m = published.manifest;
await sql`
  insert into kortix.repo_snapshots
    (provider, repository_id, owner, repo, commit_sha, format, status, manifest_key, payload_key,
     archive_sha256, compression, tree_sha, compressed_bytes, expanded_bytes, entry_count, producer_version, ready_at)
  values ('github', ${repositoryId}, ${identity.owner}, ${identity.repo}, ${sha}, ${m.format}, 'ready',
          ${published.manifestKey}, ${m.payload.key}, ${m.payload.sha256}, ${m.payload.compression},
          ${m.source.tree_sha}, ${m.payload.compressed_bytes}, ${m.payload.expanded_bytes},
          ${m.payload.entry_count}, ${m.producer_version}, now())
  on conflict (provider, repository_id, commit_sha, format) do update set status = 'ready'`;

const pat = (p: string, q = '') => fetch(`${API}/git/${p}/repo-snapshot${q}`, { headers: { authorization: `Bearer ${PAT}` } });

console.log('\nDescriptor route, real HTTP, real Kortix token:');
const ok = await pat(projectA, `?sha=${sha}`);
const body = (await ok.json().catch(() => null)) as any;
check('200 for a prepared revision', ok.status === 200, `status ${ok.status}`);
check('names the exact pinned commit', body?.commit_sha === sha);
check('carries the archive digest', /^[0-9a-f]{64}$/.test(body?.sha256 ?? ''));
check('declares the delivery mode', body?.delivery === 'proxy' || body?.delivery === 'presigned', String(body?.delivery));
check(
  'never leaks the bucket name',
  !JSON.stringify(body ?? {}).includes(process.env.KORTIX_REPO_SNAPSHOT_BUCKET!),
);
check('is not cacheable', (ok.headers.get('cache-control') ?? '').includes('no-store'));

// A SECOND project on the same repository gets the SAME artifact.
const shared = await pat(projectB, `?sha=${sha}`);
const sharedBody = (await shared.json().catch(() => null)) as any;
check('a second project on one revision reuses the artifact', shared.status === 200 && sharedBody?.sha256 === body?.sha256);

// A project on a DIFFERENT repository must not reach it.
const other = await pat(projectC, `?sha=${sha}`);
check('a project on another repository cannot reach it', other.status === 409, `status ${other.status}`);

// An unprepared revision is a miss, never a substitution.
const missing = await pat(projectA, `?sha=${'c'.repeat(40)}`);
const missBody = (await missing.json().catch(() => null)) as any;
check('an unprepared revision is 409, not a substitution', missing.status === 409 && missBody?.reason === 'not_prepared');

// A branch name is refused: a branch is never immutable identity.
const branch = await pat(projectA, '?sha=main');
check('a branch name is refused', branch.status === 400, `status ${branch.status}`);

console.log('\nArchive route:');
const archive = await fetch(`${API}/git/${projectA}/repo-snapshot/archive?sha=${sha}`, { headers: { authorization: `Bearer ${PAT}` } });
const bytes = archive.ok ? (await archive.arrayBuffer()).byteLength : 0;
check('200 and the exact published byte count', archive.status === 200 && bytes === m.payload.compressed_bytes, `status ${archive.status}, ${bytes} bytes`);
check('advertises the archive digest', archive.headers.get('x-kortix-artifact-sha256') === m.payload.sha256);
const archiveOther = await fetch(`${API}/git/${projectC}/repo-snapshot/archive?sha=${sha}`, { headers: { authorization: `Bearer ${PAT}` } });
check('another repository cannot stream it', archiveOther.status === 409, `status ${archiveOther.status}`);
const anon = await fetch(`${API}/git/${projectA}/repo-snapshot/archive?sha=${sha}`);
check('anonymous is refused', anon.status === 401 || anon.status === 403, `status ${anon.status}`);

console.log(`\n${pass} pass, ${fail} fail`);
for (const p of [projectA, projectB, projectC]) await sql`delete from kortix.projects where project_id = ${p}`.catch(() => {});
await sql`delete from kortix.repo_snapshots where repository_id = ${repositoryId}`.catch(() => {});
// Revoke the throwaway credential.
await fetch(`${API}/accounts/tokens/${patBody.token_id}`, {
  method: 'DELETE',
  headers: { authorization: `Bearer ${JWT}` },
}).catch(() => {});
await sql.close();
process.exit(fail === 0 ? 0 : 1);
