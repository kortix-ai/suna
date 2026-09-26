import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildConfigArchive } from './builder';
import { publicDownloadTarget, serveConfigArchive, storageOriginIsPublic } from './serve-archive';
import { MemoryConfigArchiveStore, configArchiveKey } from './store';

let root = '';
let repo = '';
let tree = '';
let blob = '';
let commit = '';
let hugeTree = '';
const project = {
  projectId: '0b7c9f1e-2d3a-4b5c-8d9e-0f1a2b3c4d5e',
  repoUrl: '/dev/null',
  defaultBranch: 'main',
  manifestPath: 'kortix.yaml',
};

function git(...args: string[]): string {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'kortix-serve-archive-'));
  repo = join(root, 'repo');
  mkdirSync(join(repo, '.kortix/opencode/agents'), { recursive: true });
  git('init', '-q', '--initial-branch=main');
  git('config', 'user.email', 't@kortix.invalid');
  git('config', 'user.name', 'T');
  writeFileSync(join(repo, '.kortix/opencode/opencode.json'), '{}\n');
  writeFileSync(join(repo, '.kortix/opencode/agents/kortix.md'), 'agent\n');
  git('add', '-A');
  git('commit', '-qm', 'seed');
  commit = git('rev-parse', 'HEAD');
  tree = git('rev-parse', 'HEAD:.kortix/opencode');
  blob = git('rev-parse', 'HEAD:.kortix/opencode/opencode.json');
  mkdirSync(join(repo, 'huge'), { recursive: true });
  writeFileSync(join(repo, 'huge/blob.bin'), randomBytes(4 * 1024 * 1024 + 4096));
  git('add', '-A');
  git('commit', '-qm', 'huge');
  hugeTree = git('rev-parse', 'HEAD:huge');
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

function mirrors() {
  const calls = { warm: 0, forced: 0 };
  return {
    calls,
    mirror: async () => {
      calls.warm += 1;
      return repo;
    },
    forced: async () => {
      calls.forced += 1;
      return repo;
    },
  };
}

/** No public-endpoint override: the signed URL's own host decides. */
const PRIVATE = { publicOverride: null };
const PUBLIC = { publicOverride: null };

describe('storageOriginIsPublic', () => {
  test.each([
    ['http://127.0.0.1:54321', false],
    ['http://localhost:54321', false],
    ['http://supabase-kong:8000', false],
    ['http://10.0.3.4:8000', false],
    ['http://192.168.1.5', false],
    ['http://storage.svc', false],
    ['http://storage.cluster.local', false],
    ['http://[::1]:54321', false],
    ['not a url', false],
    ['https://abc.supabase.co', true],
    ['https://selfhost.example.test', true],
    ['https://acme.kortix.cloud', true],
    ['http://34.120.1.2', true],
  ])('%s -> %p', (origin, expected) => {
    expect(storageOriginIsPublic(origin)).toBe(expected);
  });

  test('publicDownloadTarget redirects only to a host a cloud sandbox can reach', () => {
    const signed = 'https://kortix-dev.s3.us-west-2.amazonaws.com/config-releases/k?X-Amz-Signature=a';
    expect(publicDownloadTarget(signed, null)).toBe(signed);
    expect(publicDownloadTarget('http://127.0.0.1:54321/storage/v1/s3/b/k?X-Amz-Signature=a', null)).toBeNull();
    expect(publicDownloadTarget('http://supabase-kong:8000/storage/v1/s3/b/k?t=1', '')).toBeNull();
    // The override replaces the origin the store signed for.
    expect(publicDownloadTarget('http://supabase-kong:8000/storage/v1/s3/b/k?t=1', 'https://box.example.com')).toBe(
      'https://box.example.com/storage/v1/s3/b/k?t=1',
    );
    // An unparseable URL is never redirected to.
    expect(publicDownloadTarget('not a url', 'https://box.example.com')).toBeNull();
  });
});

describe('serveConfigArchive', () => {
  test('a blob ID, a commit ID, or an unknown ID is 404 after one forced fetch', async () => {
    for (const id of [blob, commit, 'e'.repeat(40)]) {
      const m = mirrors();
      const response = await serveConfigArchive(project, id, m.mirror, m.forced, {
        store: new MemoryConfigArchiveStore(),
        ...PRIVATE,
      });
      expect(response.status).toBe(404);
      expect(m.calls.forced).toBe(1);
    }
  });

  test('private storage: streams the stored bytes', async () => {
    const store = new MemoryConfigArchiveStore();
    const archive = await buildConfigArchive(repo, tree);
    await store.putIfAbsent(configArchiveKey(project.projectId, tree), archive);
    const fetched: string[] = [];
    const m = mirrors();
    const response = await serveConfigArchive(project, tree, m.mirror, m.forced, {
      store,
      ...PRIVATE,
      fetch: async (url) => {
        fetched.push(url);
        return new Response(new Uint8Array(archive));
      },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/gzip');
    expect(response.headers.get('x-kortix-config-archive-source')).toBe('store');
    expect(Buffer.from(await response.arrayBuffer()).equals(archive)).toBe(true);
    expect(fetched).toHaveLength(1);
    expect(m.calls.forced).toBe(0);
  });

  test('private storage, missing object: streams a mirror build and stores it', async () => {
    const store = new MemoryConfigArchiveStore();
    const m = mirrors();
    const response = await serveConfigArchive(project, tree, m.mirror, m.forced, { store, ...PRIVATE });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-kortix-config-archive-source')).toBe('mirror');
    const body = Buffer.from(await response.arrayBuffer());
    expect(body.equals(await buildConfigArchive(repo, tree))).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(store.objects.get(configArchiveKey(project.projectId, tree))?.equals(body)).toBe(true);
  });

  test('public storage: 302 to the signed store URL', async () => {
    const store = new MemoryConfigArchiveStore();
    await store.putIfAbsent(configArchiveKey(project.projectId, tree), Buffer.from('x'));
    const signed = `https://abc.supabase.co/storage/v1/s3/b/k?X-Amz-Signature=t`;
    store.downloadUrl = async () => signed;
    const m = mirrors();
    const response = await serveConfigArchive(project, tree, m.mirror, m.forced, { store, ...PUBLIC });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(signed);
  });

  test('the public override rewrites the signed URL origin', async () => {
    const store = new MemoryConfigArchiveStore();
    store.downloadUrl = async () => 'http://supabase-kong:8000/storage/v1/s3/b/k?X-Amz-Signature=t';
    const m = mirrors();
    const response = await serveConfigArchive(project, tree, m.mirror, m.forced, {
      store,
      publicOverride: 'https://box.example.com',
    });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://box.example.com/storage/v1/s3/b/k?X-Amz-Signature=t');
  });

  test('public storage, store down: streams a mirror build', async () => {
    const store = new MemoryConfigArchiveStore();
    store.failWith = new Error('store down');
    const m = mirrors();
    const response = await serveConfigArchive(project, tree, m.mirror, m.forced, { store, ...PUBLIC });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-kortix-config-archive-source')).toBe('mirror');
  });

  test('CFG-7: a tree the mirror no longer has (repository replaced) still serves from the store', async () => {
    // A repository replacement points the project's origin at unrelated
    // history: no fetch of the CURRENT origin will ever reproduce a tree the
    // OLD origin built. The store still holds the byte-identical archive,
    // keyed by this project's own prefix, and must serve it without the
    // mirror ever containing the tree.
    const goneTree = 'e'.repeat(40);
    const store = new MemoryConfigArchiveStore();
    const archive = await buildConfigArchive(repo, tree);
    await store.putIfAbsent(configArchiveKey(project.projectId, goneTree), archive);
    const m = mirrors();
    const response = await serveConfigArchive(project, goneTree, m.mirror, m.forced, {
      store,
      ...PRIVATE,
      fetch: async () => new Response(new Uint8Array(archive)),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-kortix-config-archive-source')).toBe('store');
    expect(Buffer.from(await response.arrayBuffer()).equals(archive)).toBe(true);
    // Both the warm and the forced mirror were consulted and missed, exactly
    // like the plain-404 case, before the store fallback ran.
    expect(m.calls.forced).toBe(1);
  });

  test('CFG-7: a tree neither the mirror nor the store has is still 404', async () => {
    const goneTree = 'd'.repeat(40);
    const m = mirrors();
    const response = await serveConfigArchive(project, goneTree, m.mirror, m.forced, {
      store: new MemoryConfigArchiveStore(),
      ...PRIVATE,
    });
    expect(response.status).toBe(404);
    expect(m.calls.forced).toBe(1);
  });

  test('a tree over the archive limit is 413', async () => {
    const m = mirrors();
    const response = await serveConfigArchive(project, hugeTree, m.mirror, m.forced, {
      store: new MemoryConfigArchiveStore(),
      ...PRIVATE,
    });
    expect(response.status).toBe(413);
  });
});
