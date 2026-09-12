/**
 * Real S3-protocol coverage for the snapshot client and publisher.
 *
 * Runs against a live S3 API server over real HTTP with real SigV4 and real
 * conditional writes — MinIO by default, or any endpoint/bucket the env names.
 * Nothing here is mocked: a stubbed `fetch` proves the code compiles, not that
 * the signature is accepted or that `If-None-Match: *` behaves.
 *
 *   docker run -d --name kortix-snapshot-minio -p 19000:9000 \
 *     -e MINIO_ROOT_USER=kortixsnapshots -e MINIO_ROOT_PASSWORD=kortixsnapshots123 \
 *     quay.io/minio/minio:latest server /data
 *   docker exec kortix-snapshot-minio mc alias set local http://127.0.0.1:9000 \
 *     kortixsnapshots kortixsnapshots123
 *   docker exec kortix-snapshot-minio mc mb --ignore-existing local/kortix-repo-snapshots
 *
 * Skipped (not failed) when no endpoint answers, so the hermetic unit gate stays
 * runnable on a laptop with no Docker.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

const ENDPOINT = process.env.KORTIX_REPO_SNAPSHOT_ENDPOINT || 'http://127.0.0.1:19000';
const BUCKET = process.env.KORTIX_REPO_SNAPSHOT_BUCKET || 'kortix-repo-snapshots';
const ACCESS_KEY = process.env.KORTIX_REPO_SNAPSHOT_ACCESS_KEY_ID || 'kortixsnapshots';
const SECRET_KEY = process.env.KORTIX_REPO_SNAPSHOT_SECRET_ACCESS_KEY || 'kortixsnapshots123';
const REGION = process.env.KORTIX_REPO_SNAPSHOT_REGION || 'us-east-1';

process.env.KORTIX_REPO_SNAPSHOT_ENDPOINT = ENDPOINT;
process.env.KORTIX_REPO_SNAPSHOT_BUCKET = BUCKET;
process.env.KORTIX_REPO_SNAPSHOT_ACCESS_KEY_ID = ACCESS_KEY;
process.env.KORTIX_REPO_SNAPSHOT_SECRET_ACCESS_KEY = SECRET_KEY;
process.env.KORTIX_REPO_SNAPSHOT_REGION = REGION;

const { buildRepoSnapshot, discardBuiltRepoSnapshot } = await import('./build');
const { normalizeRepoSnapshotIdentity, manifestKey, parseRepoSnapshotManifest } = await import('./format');
const { publishRepoSnapshot, readPublishedManifest } = await import('./publish');
const {
  presignRepoSnapshotGet,
  requireRepoSnapshotBucket,
  s3GetObjectText,
  s3HeadObject,
  s3PutObject,
  S3RequestError,
} = await import('./s3');

let live = false;
const roots: string[] = [];

async function endpointAlive(): Promise<boolean> {
  try {
    const res = await fetch(`${ENDPOINT}/minio/health/live`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    try {
      const res = await fetch(ENDPOINT, { method: 'HEAD', signal: AbortSignal.timeout(2000) });
      return res.status < 500;
    } catch {
      return false;
    }
  }
}

beforeAll(async () => {
  live = await endpointAlive();
});

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Snapshot Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Snapshot Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    },
    encoding: 'utf8',
  }).trim();
}

function makeSource(): { repoUrl: string; sha: string } {
  const root = mkdtempSync(join(tmpdir(), 'kortix-s3-source-'));
  roots.push(root);
  const source = join(root, 'source');
  mkdirSync(source);
  git(['init', '-b', 'main'], source);
  writeFileSync(join(source, 'kortix.yaml'), 'kortix_version: 2\n');
  mkdirSync(join(source, '.kortix', 'skills', 'spare'), { recursive: true });
  writeFileSync(join(source, '.kortix', 'skills', 'spare', 'SKILL.md'), '# spare\n');
  git(['add', '-A'], source);
  git(['commit', '-m', 'seed'], source);
  return { repoUrl: `file://${source}`, sha: git(['rev-parse', 'HEAD'], source) };
}

function isolatedMirror(): void {
  const cache = mkdtempSync(join(tmpdir(), 'kortix-s3-mirror-'));
  roots.push(cache);
  process.env.KORTIX_GIT_CACHE_DIR = cache;
}

describe('repo snapshot S3 publication (live endpoint)', () => {
  test('signs GET/PUT/HEAD and enforces If-None-Match against a real server', async () => {
    if (!live) return;
    const bucket = requireRepoSnapshotBucket();
    const key = `itest/${crypto.randomUUID()}/object.txt`;
    expect(await s3HeadObject(bucket, key)).toBeNull();

    await s3PutObject(bucket, key, Buffer.from('first\n'), {
      contentType: 'text/plain',
      ifNoneMatch: true,
    });
    expect(await s3GetObjectText(bucket, key)).toBe('first\n');
    const head = await s3HeadObject(bucket, key);
    expect(head?.contentLength).toBe(6);

    // The conditional create must LOSE, and it must not overwrite.
    let conflict: unknown;
    try {
      await s3PutObject(bucket, key, Buffer.from('second\n'), { ifNoneMatch: true });
    } catch (error) {
      conflict = error;
    }
    expect(conflict).toBeInstanceOf(S3RequestError);
    expect((conflict as InstanceType<typeof S3RequestError>).preconditionFailed).toBe(true);
    expect(await s3GetObjectText(bucket, key)).toBe('first\n');
  }, 60_000);

  test('a presigned GET reads exactly one object and nothing else', async () => {
    if (!live) return;
    const bucket = requireRepoSnapshotBucket();
    const key = `itest/${crypto.randomUUID()}/presigned.txt`;
    const other = `itest/${crypto.randomUUID()}/other.txt`;
    await s3PutObject(bucket, key, Buffer.from('scoped\n'));
    await s3PutObject(bucket, other, Buffer.from('hidden\n'));

    const { url, expiresAt } = await presignRepoSnapshotGet(bucket, key, 300);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('scoped\n');

    // The same signature must not read a different key.
    const swapped = url.replace(encodeURIComponent(key).replace(/%2F/g, '/'), encodeURIComponent(other).replace(/%2F/g, '/'));
    const denied = await fetch(swapped);
    expect(denied.status).toBeGreaterThanOrEqual(400);
  }, 60_000);

  test('publishes archive before manifest and adopts a concurrent winner', async () => {
    if (!live) return;
    isolatedMirror();
    const source = makeSource();
    const identity = normalizeRepoSnapshotIdentity({
      repositoryId: String(Math.floor(Math.random() * 1_000_000_000)),
      owner: 'kortix-ai',
      repo: 'itest',
      commitSha: source.sha,
    });
    const project = {
      projectId: crypto.randomUUID(),
      repoUrl: source.repoUrl,
      defaultBranch: 'main',
      manifestPath: 'kortix.yaml',
      gitAuthToken: null,
    };
    const bucket = requireRepoSnapshotBucket();
    expect(await readPublishedManifest(bucket, identity)).toBeNull();

    const built = await buildRepoSnapshot(project, identity, { compression: 'gzip' });
    try {
      const published = await publishRepoSnapshot({
        bucket,
        identity,
        manifest: built.manifest,
        archivePath: built.archivePath,
      });
      expect(published.created).toBe(true);
      expect(published.manifestKey).toBe(manifestKey(identity));

      // The payload is durable before the manifest names it.
      const payloadHead = await s3HeadObject(bucket, built.manifest.payload.key);
      expect(payloadHead?.contentLength).toBe(built.manifest.payload.compressed_bytes);

      const stored = parseRepoSnapshotManifest(await s3GetObjectText(bucket, published.manifestKey));
      expect(stored).toEqual(built.manifest);

      // A second publisher of the same revision adopts, never overwrites.
      const again = await publishRepoSnapshot({
        bucket,
        identity,
        manifest: built.manifest,
        archivePath: built.archivePath,
      });
      expect(again.created).toBe(false);
      expect(again.manifest.payload.sha256).toBe(built.manifest.payload.sha256);

      const readBack = await readPublishedManifest(bucket, identity);
      expect(readBack?.payload.key).toBe(built.manifest.payload.key);
    } finally {
      await discardBuiltRepoSnapshot(built);
    }
  }, 120_000);

  test('rejects a manifest whose identity does not match the request', async () => {
    if (!live) return;
    const bucket = requireRepoSnapshotBucket();
    const real = normalizeRepoSnapshotIdentity({
      repositoryId: '424242',
      owner: 'kortix-ai',
      repo: 'identity-check',
      commitSha: 'b'.repeat(40),
    });
    // Same owner/repo/SHA, DIFFERENT repository id: a reused repository name.
    const impostor = normalizeRepoSnapshotIdentity({ ...real, repositoryId: '999999' });
    await s3PutObject(
      bucket,
      manifestKey(real),
      Buffer.from(
        JSON.stringify({
          format: 'kortix.project-snapshot.v1',
          source: {
            provider: 'github',
            repository_id: impostor.repositoryId,
            owner: impostor.owner,
            repo: impostor.repo,
            commit_sha: impostor.commitSha,
            tree_sha: 'c'.repeat(40),
          },
          payload: {
            key: `kortix-ai/identity-check/${'b'.repeat(40)}/999999/project-snapshot-v1/${'d'.repeat(64)}.tar.gz`,
            compression: 'gzip',
            sha256: 'd'.repeat(64),
            compressed_bytes: 1,
            expanded_bytes: 1,
            entry_count: 1,
          },
          checkout: { git_metadata: 'sanitized-shallow', layout_version: 1 },
          producer_version: 'test',
        }),
      ),
      { contentType: 'application/json' },
    );
    await expect(readPublishedManifest(bucket, real)).rejects.toThrow(/identity/i);
  }, 60_000);
});
