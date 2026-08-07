import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
});
