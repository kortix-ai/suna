import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as tar from 'tar';
import {
  MAX_ARCHIVE_BYTES,
  appArtifactObjectPath,
  extractAppArchive,
  inspectAppArchive,
  retryAppArtifactStorage,
  validateArchiveEntry,
} from './artifacts';

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('App artifacts', () => {
  test('retries transient storage control-plane failures with bounded backoff', async () => {
    const delays: number[] = [];
    let calls = 0;

    const result = await retryAppArtifactStorage(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error('storage unavailable');
        return 'signed-upload-url';
      },
      async (delay) => { delays.push(delay); },
    );

    expect(result).toBe('signed-upload-url');
    expect(calls).toBe(3);
    expect(delays).toEqual([100, 250]);
  });

  test('stops artifact storage retries after three failed attempts', async () => {
    let calls = 0;

    await expect(retryAppArtifactStorage(
      async () => {
        calls += 1;
        throw new Error('storage unavailable');
      },
      async () => {},
    )).rejects.toThrow('storage unavailable');
    expect(calls).toBe(3);
  });

  test('keeps source archives within the managed Supabase Storage limit', () => {
    expect(MAX_ARCHIVE_BYTES).toBe(50 * 1024 * 1024);
  });

  test('uses account, project, and artifact identity in the private object path', () => {
    expect(appArtifactObjectPath('account-1', 'project-1', 'artifact-1')).toBe(
      'account-1/project-1/artifact-1/source.tar.gz',
    );
    expect(() => appArtifactObjectPath('../account', 'project-1', 'artifact-1')).toThrow(
      /invalid characters/,
    );
  });

  test('rejects traversal, absolute paths, devices, and escaping links', () => {
    for (const entry of [
      { path: '../secret', type: 'File' },
      { path: '/etc/passwd', type: 'File' },
      { path: 'device', type: 'CharacterDevice' },
      { path: 'safe/link', type: 'SymbolicLink', linkpath: '../../secret' },
      { path: 'safe/link', type: 'Link', linkpath: '../secret' },
    ]) {
      expect(() => validateArchiveEntry(entry)).toThrow();
    }
  });

  test('accepts links that remain inside the build context', () => {
    expect(() => validateArchiveEntry({
      path: 'assets/current',
      type: 'SymbolicLink',
      linkpath: '../public',
    })).not.toThrow();
    expect(() => validateArchiveEntry({
      path: 'assets/index-copy.html',
      type: 'Link',
      linkpath: 'public/index.html',
    })).not.toThrow();
  });

  test('accepts the standard dot root directory emitted by CLI tar archives', () => {
    expect(() => validateArchiveEntry({ path: './', type: 'Directory' })).not.toThrow();
    expect(() => validateArchiveEntry({ path: '.', type: 'File', size: 1 })).toThrow();
  });

  test('inspects and extracts a real compressed archive', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'kortix-artifact-test-'));
    cleanup.push(fixture);
    const source = join(fixture, 'source');
    const archive = join(fixture, 'source.tar.gz');
    const output = join(fixture, 'output');
    await mkdir(join(source, 'public'), { recursive: true });
    await writeFile(join(source, 'public', 'index.html'), '<h1>Kortix App</h1>');
    await tar.c({ cwd: source, file: archive, gzip: true }, ['public']);

    expect(await inspectAppArchive(archive)).toEqual({
      files: 1,
      extractedBytes: Buffer.byteLength('<h1>Kortix App</h1>'),
    });
    await extractAppArchive(archive, output);
    expect(await readFile(join(output, 'public', 'index.html'), 'utf8')).toBe(
      '<h1>Kortix App</h1>',
    );
  });

  // Each link passes the lexical check (`validateArchiveEntry`). Extracted in
  // this order, `e` resolves through `d/l` (created after it) to the parent of
  // the extraction root, and each further pair climbs one directory more.
  const ESCAPE_CHAIN: Array<[string, string | null]> = [
    ['d', null], ['d2', null], ['d3', null],
    ['e3', 'd3/l3/..'], ['d3/l3', '../e2'],
    ['e2', 'd2/l2/..'], ['d2/l2', '../e'],
    ['e', 'd/l/..'], ['d/l', '..'],
  ];

  async function chainArchive(entries: Array<[string, string | null]>): Promise<{ archive: string; output: string }> {
    const fixture = await mkdtemp(join(tmpdir(), 'kortix-artifact-chain-'));
    cleanup.push(fixture);
    const source = join(fixture, 'source');
    await mkdir(source);
    for (const [path, target] of entries) {
      if (target === null) await mkdir(join(source, path), { recursive: true });
      else await symlink(target, join(source, path));
    }
    const archive = join(fixture, 'source.tar.gz');
    // noDirRecurse keeps exactly this entry order in the archive.
    await tar.c({ cwd: source, file: archive, gzip: true, noDirRecurse: true }, entries.map(([path]) => path));
    return { archive, output: join(fixture, 'output') };
  }

  test('a symlink chain that resolves outside the root is refused after extraction, and the tree is removed', async () => {
    for (const [path, target] of ESCAPE_CHAIN) {
      if (target) expect(() => validateArchiveEntry({ path, type: 'SymbolicLink', linkpath: target })).not.toThrow();
    }
    const { archive, output } = await chainArchive(ESCAPE_CHAIN);
    await expect(extractAppArchive(archive, output)).rejects.toThrow(/escapes the build context/);
    await expect(stat(output)).rejects.toThrow();
  });

  test('a dangling link through an escaping link is refused', async () => {
    const { archive, output } = await chainArchive([['d', null], ['x', 'e/not-there'], ['e', 'd/l/..'], ['d/l', '..']]);
    await expect(extractAppArchive(archive, output)).rejects.toThrow(/escapes the build context/);
  });

  test('links that stay inside the root extract unchanged', async () => {
    const { archive, output } = await chainArchive([['public', null], ['current', 'public'], ['missing', 'public/later.html']]);
    await extractAppArchive(archive, output);
    expect(await readlink(join(output, 'current'))).toBe('public');
    expect(await readlink(join(output, 'missing'))).toBe('public/later.html');
  });
});
