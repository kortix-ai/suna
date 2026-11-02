import { afterEach, describe, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import { grepRepoFiles, listRepoDirectory, listRepoFiles, readManifestFromRepo, readRepoFile, readRepoFileBytes } from './files';
import { rename } from 'node:fs/promises';
import { classifyGitError, ensureTreeContents, refreshMirror, repoCachePath, runGit } from './mirror';
import { gitVersionSupportsPartialStores, isObjectFetchTooLargeError, missingObjectIdsFromGitError } from './object-store';
import { config } from '../../config';
import { createPartialStoreFixture, type PartialStoreFixture } from './__tests__/partial-store-fixture';

const exec = promisify(execFile);

let fx: PartialStoreFixture | null = null;
afterEach(async () => {
  await fx?.cleanup();
  fx = null;
  config.KORTIX_GIT_OBJECT_STORE = 'partial';
});

/** A repository shaped like the one that broke prod: a small config next to large data files, with history. */
async function largeDataRepo(): Promise<PartialStoreFixture> {
  const fixture = await createPartialStoreFixture({
    'kortix.yaml': 'name: data-lab\nimports:\n  - .kortix/agents.yaml\n',
    '.kortix/agents.yaml': 'agents:\n  researcher:\n    description: Reads the data\n',
    'README.md': 'The notes say hello world.\n',
    'data/run-1.bin': randomBytes(300_000),
    'data/run-2.bin': randomBytes(300_000),
  });
  // History: every data file was rewritten twice. A whole clone carries all of it.
  await fixture.push({ 'data/run-1.bin': randomBytes(300_000) }, 'rerun 1');
  await fixture.push({ 'data/run-2.bin': randomBytes(300_000) }, 'rerun 2');
  return fixture;
}

async function storeBytes(path: string): Promise<number> {
  const { stdout } = await exec('du', ['-sb', `${path}/objects`]);
  return Number(stdout.split('\t')[0]);
}

describe('partial project store', () => {
  test('the store holds commits and the tip trees, and no file', async () => {
    fx = await largeDataRepo();
    const store = await refreshMirror(fx.project);
    const files = await listRepoFiles(fx.project);
    expect(files.map((file) => file.path).sort()).toEqual(
      ['.kortix/agents.yaml', 'README.md', 'data/run-1.bin', 'data/run-2.bin', 'kortix.yaml'],
    );
    // 9 file versions exist across 3 commits; none was downloaded.
    expect(await fx.missingObjectCount()).toBeGreaterThanOrEqual(5);
    expect(await fx.storeHas(await fx.upstreamBlob('kortix.yaml'))).toBe(false);
    // The upstream holds about 1.8 MB of incompressible data; the store holds KB.
    expect(await storeBytes(store)).toBeLessThan(100_000);
  });

  test('a manifest read fetches the manifest and its imports, nothing else', async () => {
    fx = await largeDataRepo();
    const manifest = await readManifestFromRepo(fx.project, ['kortix.yaml']);
    expect(manifest?.content).toContain('researcher');
    expect(await fx.storeHas(await fx.upstreamBlob('kortix.yaml'))).toBe(true);
    expect(await fx.storeHas(await fx.upstreamBlob('.kortix/agents.yaml'))).toBe(true);
    expect(await fx.storeHas(await fx.upstreamBlob('data/run-1.bin'))).toBe(false);
    expect(await fx.storeHas(await fx.upstreamBlob('README.md'))).toBe(false);
  });

  test('a file read fetches that one file, text and bytes alike', async () => {
    fx = await largeDataRepo();
    expect(await readRepoFile(fx.project, 'README.md')).toBe('The notes say hello world.\n');
    expect(await fx.storeHas(await fx.upstreamBlob('data/run-2.bin'))).toBe(false);
    const bytes = await readRepoFileBytes(fx.project, 'data/run-1.bin');
    expect(bytes.length).toBe(300_000);
    expect(await fx.storeHas(await fx.upstreamBlob('data/run-2.bin'))).toBe(false);
  });

  test('a missing path is still "not found", not a fetch failure', async () => {
    fx = await largeDataRepo();
    await expect(readRepoFile(fx.project, 'nope.md')).rejects.toMatchObject({ name: 'RepoFileNotFoundError' });
  });

  test('a folder listing reads trees only; a size shows once the file is fetched', async () => {
    fx = await largeDataRepo();
    const before = await listRepoDirectory(fx.project, undefined, 'data');
    expect(before.entries.map((entry) => entry.path)).toEqual(['data/run-1.bin', 'data/run-2.bin']);
    expect(before.entries.every((entry) => entry.size === undefined)).toBe(true);
    expect(await fx.storeHas(await fx.upstreamBlob('data/run-1.bin'))).toBe(false);
  });

  test('content search fetches the files it reads and finds the match', async () => {
    fx = await largeDataRepo();
    const matches = await grepRepoFiles(fx.project, 'hello world');
    expect(matches).toEqual([{ path: 'README.md', line_number: 1, line_text: 'The notes say hello world.' }]);
  });

  test('a whole-tree fetch over its limit keeps nothing', async () => {
    fx = await largeDataRepo();
    const store = await refreshMirror(fx.project);
    const error = await ensureTreeContents(store, 'main', { maxBytes: 100_000 }).catch((err) => err);
    expect(isObjectFetchTooLargeError(error)).toBe(true);
    expect(await fx.storeHas(await fx.upstreamBlob('data/run-1.bin'))).toBe(false);
  });

  test('a whole-tree fetch that was over its limit fails again without a download', async () => {
    fx = await largeDataRepo();
    const store = await refreshMirror(fx.project);
    await ensureTreeContents(store, 'main', { maxBytes: 100_000 }).catch(() => undefined);
    // With the upstream gone, only the memo can answer.
    await rename(fx.upstream, `${fx.upstream}.gone`);
    const again = await ensureTreeContents(store, 'main', { maxBytes: 100_000 }).catch((err) => err);
    expect(isObjectFetchTooLargeError(again)).toBe(true);
  });

  test('a file over the text read buffer is "too large", and its content never reaches the error', async () => {
    fx = await createPartialStoreFixture({ 'big.txt': 'x'.repeat(11 * 1024 * 1024), 'kortix.yaml': 'name: x\n' });
    const error = await readRepoFile(fx.project, 'big.txt').catch((err) => err);
    expect(error?.name).toBe('RepoContentTooLargeError');
    expect(String(error?.message)).not.toContain('xxxx');
  });

  test('a git error message never carries stdout', () => {
    const fromBuffer = classifyGitError(
      { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', message: 'stdout maxBuffer length exceeded', stdout: 'secret file body' },
      ['cat-file', 'blob', 'main:a'],
      30_000,
    );
    expect(fromBuffer.outputTooLarge).toBe(true);
    expect(fromBuffer.message).not.toContain('secret');
    const failed = classifyGitError({ code: 1, message: 'Command failed', stdout: 'secret file body', stderr: '' }, ['show', 'main:a'], 30_000);
    expect(failed.message).toBe('git show failed (exit 1)');
  });

  test('a git command that hits a missing object fetches it and runs again', async () => {
    fx = await largeDataRepo();
    const store = await refreshMirror(fx.project);
    // `diff --numstat` reads both versions of the changed file; nothing fetched them first.
    const diff = await runGit(['diff', '--numstat', 'main~1', 'main'], store, false);
    expect(diff.stdout).toContain('data/run-2.bin');
  });

  test('a whole-history store from before is replaced by a partial one', async () => {
    fx = await largeDataRepo();
    const store = repoCachePath(fx.project);
    await mkdir(dirname(store), { recursive: true });
    await exec('git', ['clone', '--quiet', '--bare', fx.project.repoUrl, store]);
    expect(await fx.missingObjectCount()).toBe(0);
    await refreshMirror(fx.project, true);
    expect(await fx.storeHas(await fx.upstreamBlob('data/run-1.bin'))).toBe(false);
  });

  test('KORTIX_GIT_OBJECT_STORE=full keeps the whole clone', async () => {
    config.KORTIX_GIT_OBJECT_STORE = 'full';
    fx = await largeDataRepo();
    await refreshMirror(fx.project);
    expect(await fx.missingObjectCount()).toBe(0);
  });
});

describe('object-store helpers', () => {
  test('git 2.45 or newer can refuse implicit fetches', () => {
    expect(gitVersionSupportsPartialStores('git version 2.47.3')).toBe(true);
    expect(gitVersionSupportsPartialStores('git version 2.45.0')).toBe(true);
    expect(gitVersionSupportsPartialStores('git version 2.39.5 (Apple Git-154)')).toBe(false);
    expect(gitVersionSupportsPartialStores('git version 3.0.0')).toBe(true);
    expect(gitVersionSupportsPartialStores('nonsense')).toBe(false);
  });

  test('missing object ids are read from every error shape git prints', () => {
    const a = 'a'.repeat(40);
    const b = 'b'.repeat(40);
    const c = 'c'.repeat(40);
    expect(missingObjectIdsFromGitError(`fatal: could not fetch ${a} from promisor remote`)).toEqual([a]);
    expect(missingObjectIdsFromGitError(`error: 'main:x': unable to read ${b}`)).toEqual([b]);
    expect(missingObjectIdsFromGitError(`fatal: unable to read tree (${c})`)).toEqual([c]);
    expect(missingObjectIdsFromGitError('fatal: bad object main:notes.md')).toEqual([]);
  });
});
