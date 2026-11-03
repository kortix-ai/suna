/**
 * Config releases on a partial project store: the mirror holds commits and
 * trees, and an archive downloads exactly the files it packs, bounded by the
 * tar cap. Real upstream, real partial clone, real archives.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { refreshMirror } from '../projects/git/mirror';
import { createPartialStoreFixture, type PartialStoreFixture } from '../projects/git/__tests__/partial-store-fixture';
import { noteOverLimit, OVER_LIMIT_MEMO_TTL_MS } from '../shared/over-limit-memo';
import { MemoryConfigArchiveStore } from './__tests__/fakes';
import { __clearConfigReleaseCachesForTests, buildConfigRelease } from './builder';
import { serveConfigArchive } from './serve-archive';
import { configArchiveKey } from './store';

const MANIFEST = [
  'project:',
  '  name: partial-store-test',
  'default_agent: kortix',
  'tools:',
  '  lookup: tools/lookup.ts',
  'agents:',
  '  kortix:',
  '    prompt: You are the main agent.',
  '    tools: all',
  '  support:',
  '    description: support',
  '    prompt: Help.',
  '    workspace:',
  '      project_repository: false',
  '    tools: all',
  '',
].join('\n');

const FILES = {
  'kortix.yaml': MANIFEST,
  'tools/lookup.ts': "import { client } from './lib/client'\nexport default { description: 'd', parameters: { type: 'object' }, execute: () => client() }\n",
  'tools/lib/client.ts': 'export const client = () => 1\n',
  'tools/unused.ts': 'export const unused = 1\n',
  'notes.md': 'Notes.\n',
};

let fx: PartialStoreFixture | null = null;
let store: MemoryConfigArchiveStore;

beforeEach(() => {
  __clearConfigReleaseCachesForTests();
  store = new MemoryConfigArchiveStore();
});
afterEach(async () => {
  await fx?.cleanup();
  fx = null;
});

/** The file paths in a `tar.gz`. */
function archivePaths(archive: Buffer): string[] {
  const dir = mkdtempSync(join(fx!.root, 'extract-'));
  writeFileSync(join(dir, 'a.tar.gz'), archive);
  return execFileSync('tar', ['-tzf', 'a.tar.gz'], { cwd: dir, encoding: 'utf8' })
    .split('\n')
    .filter((path) => path && !path.endsWith('/'))
    .sort();
}

describe('config release on a partial store', () => {
  test('the project release downloads the files it ships and never an export-ignored one', async () => {
    fx = await createPartialStoreFixture({
      ...FILES,
      '.gitattributes': 'data/** export-ignore\n',
      'data/big.bin': randomBytes(600_000),
    }, { projectId: crypto.randomUUID() });
    const tip = await fx.push({ 'notes.md': 'Notes, second edit.\n' }, 'second');
    await refreshMirror(fx.project);
    const shipped = await fx.upstreamBlob('tools/unused.ts');
    const ignored = await fx.upstreamBlob('data/big.bin');
    expect(await fx.storeHas(shipped)).toBe(false);

    const release = await buildConfigRelease(fx.project, tip, 'project', { store, noCache: true });

    expect(release.reason).toBeNull();
    expect(release.archive).not.toBeNull();
    const archive = store.objects.get(configArchiveKey(fx.project.projectId, release.config_tree_id!))!;
    expect(archivePaths(archive)).toEqual(release.files!.map(([path]) => path));
    expect(release.files!.map(([path]) => path)).not.toContain('data/big.bin');
    expect(await fx.storeHas(shipped)).toBe(true);
    expect(await fx.storeHas(ignored)).toBe(false);
    // The first commit's version of an edited file is never read.
    expect(await fx.storeHas(await fx.upstreamBlob('notes.md', `${tip}~1`))).toBe(false);
  });

  test('over the cap: no archive, no downloaded file, and the project is remembered while its tree keeps the large file', async () => {
    fx = await createPartialStoreFixture({ ...FILES, 'data/big.bin': randomBytes(3_000_000) }, { projectId: crypto.randomUUID() });
    const tip = await fx.push({ 'notes.md': 'Notes, second edit.\n' }, 'second');
    const big = await fx.upstreamBlob('data/big.bin');
    // A 100 KB archive cap bounds the download at 400 KB.
    const options = { store, noCache: true, archiveLimit: 100_000 };

    const over = await buildConfigRelease(fx.project, tip, 'project', options);
    expect(over.archive).toBeNull();
    expect(over.archive_reason).toContain('exceeds the 100000-byte config archive limit');
    expect(over.release_id).not.toBeNull();
    expect(over.files!.map(([path]) => path)).toContain('data/big.bin');
    expect(await fx.storeHas(big)).toBe(false);
    expect(await fx.storeHas(await fx.upstreamBlob('tools/unused.ts'))).toBe(false);

    // A new tip that still holds the large file is answered by the memo, without a download.
    const edited = await fx.push({ 'notes.md': 'Notes, third edit.\n' }, 'third');
    const remembered = await buildConfigRelease(fx.project, edited, 'project', options);
    expect(remembered.archive).toBeNull();
    expect(remembered.archive_reason).toContain('exceeds');
    expect(await fx.storeHas(await fx.upstreamBlob('tools/unused.ts', edited))).toBe(false);

    // A tip that dropped it is measured again at once (CFG-14), and gets its archive.
    const small = await fx.push({ 'data/big.bin': null }, 'drop data');
    const rebuilt = await buildConfigRelease(fx.project, small, 'project', options);
    expect(rebuilt.archive).not.toBeNull();
    expect(await fx.storeHas(await fx.upstreamBlob('tools/unused.ts', small))).toBe(true);
  });

  test('a remembered result without a witness expires after 6 h', async () => {
    fx = await createPartialStoreFixture(FILES, { projectId: crypto.randomUUID() });
    const tip = await fx.push({ 'notes.md': 'Notes, second edit.\n' }, 'second');
    const options = { store, noCache: true };
    noteOverLimit(fx.project.projectId, 'config-archive', 1);
    expect((await buildConfigRelease(fx.project, tip, 'project', options)).archive).toBeNull();
    noteOverLimit(fx.project.projectId, 'config-archive', 1, { now: Date.now() - OVER_LIMIT_MEMO_TTL_MS - 1 });
    expect((await buildConfigRelease(fx.project, tip, 'project', options)).archive).not.toBeNull();
  });

  test('the agent variant downloads only the tool modules its agent loads', async () => {
    fx = await createPartialStoreFixture({ ...FILES, 'data/big.bin': randomBytes(600_000) }, { projectId: crypto.randomUUID() });
    const tip = await fx.push({ 'notes.md': 'Notes, second edit.\n' }, 'second');

    const release = await buildConfigRelease(fx.project, tip, 'agent:support', { store, noCache: true });

    expect(release.reason).toBeNull();
    expect(release.tools_only).toBe(true);
    expect(release.files!.map(([path]) => path)).toEqual(['tools/lib/client.ts', 'tools/lookup.ts']);
    const archive = store.objects.get(configArchiveKey(fx.project.projectId, release.config_tree_id!))!;
    expect(archivePaths(archive)).toEqual(['tools/lib/client.ts', 'tools/lookup.ts']);
    expect(await fx.storeHas(await fx.upstreamBlob('tools/lib/client.ts'))).toBe(true);
    expect(await fx.storeHas(await fx.upstreamBlob('tools/unused.ts'))).toBe(false);
    expect(await fx.storeHas(await fx.upstreamBlob('data/big.bin'))).toBe(false);
  });
});

describe('the archive route on a partial store', () => {
  const route = (archiveLimit?: number) => {
    const project = fx!.project;
    return (tree: string) =>
      serveConfigArchive(project, tree, () => refreshMirror(project), () => refreshMirror(project, true), {
        store,
        publicOverride: null,
        archiveLimit,
      });
  };
  const tipTree = (repo: string) =>
    execFileSync('git', ['log', '--no-walk', '--format=%T', 'main'], { cwd: repo, encoding: 'utf8' }).trim();

  test('a store miss builds the tip tree from the mirror after downloading its files', async () => {
    fx = await createPartialStoreFixture(FILES, { projectId: crypto.randomUUID() });
    const tree = tipTree(await refreshMirror(fx.project));
    expect(await fx.storeHas(await fx.upstreamBlob('notes.md'))).toBe(false);

    const response = await route()(tree);

    expect(response.status).toBe(200);
    expect(response.headers.get('x-kortix-config-archive-source')).toBe('mirror');
    expect(archivePaths(Buffer.from(await response.arrayBuffer()))).toEqual(Object.keys(FILES).sort());
  });

  test('a tree over the cap answers 413 and keeps no downloaded file', async () => {
    fx = await createPartialStoreFixture({ ...FILES, 'data/big.bin': randomBytes(3_000_000) }, { projectId: crypto.randomUUID() });
    const tree = tipTree(await refreshMirror(fx.project));

    const response = await route(100_000)(tree);

    expect(response.status).toBe(413);
    expect(await fx.storeHas(await fx.upstreamBlob('data/big.bin'))).toBe(false);
    expect(await fx.storeHas(await fx.upstreamBlob('notes.md'))).toBe(false);
  });
});
