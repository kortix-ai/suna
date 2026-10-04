import { afterAll, describe, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  appleMetadataTarFlags,
  stagingTarArgs,
  stagingTarEnv,
  tarBuildContext,
} from './staging-tar';

const execFileAsync = promisify(execFile);
const dirs: string[] = [];

function stageDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kortix-staging-tar-'));
  dirs.push(dir);
  return dir;
}

async function stageContextWithAppleXattrs(): Promise<string> {
  const dir = stageDir();
  writeFileSync(join(dir, 'tool.ts'), 'export const tool = 1\n');
  writeFileSync(join(dir, 'opencode.jsonc'), '{}\n');
  if (process.platform === 'darwin') {
    await execFileAsync('xattr', ['-w', 'com.apple.provenance', 'staged', join(dir, 'tool.ts')]);
    await execFileAsync('xattr', [
      '-w',
      'com.apple.provenance',
      'staged',
      join(dir, 'opencode.jsonc'),
    ]);
  }
  return dir;
}

async function tarEntries(archive: string): Promise<string[]> {
  const { stdout } = await execFileAsync('tar', ['-tzf', archive]);
  return stdout.split('\n').filter(Boolean);
}

async function archiveContainsXattrHeaders(archive: string): Promise<boolean> {
  const { stdout } = await execFileAsync('bash', [
    '-lc',
    `gzip -dc ${JSON.stringify(archive)} | LC_ALL=C grep -a -c 'xattr.com.apple' || true`,
  ]);
  return Number(stdout.trim()) > 0;
}

afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('staging tar — Apple metadata never reaches a sandbox image', () => {
  test('the build context archive carries no AppleDouble entries and no Apple xattr headers', async () => {
    const contextDir = await stageContextWithAppleXattrs();
    const archive = join(stageDir(), 'context.tar.gz');

    await tarBuildContext(contextDir, archive);

    const entries = await tarEntries(archive);
    expect(entries).toContain('./tool.ts');
    expect(entries.filter((entry) => entry.split('/').pop()?.startsWith('._'))).toEqual([]);
    expect(await archiveContainsXattrHeaders(archive)).toBe(false);
  });

  test('an unguarded archive of the same context still leaks Apple xattr headers on darwin', async () => {
    if (process.platform !== 'darwin') return;
    const contextDir = await stageContextWithAppleXattrs();
    const archive = join(stageDir(), 'unguarded.tar.gz');

    await execFileAsync('tar', ['-czf', archive, '-C', contextDir, '.']);

    expect(await archiveContainsXattrHeaders(archive)).toBe(true);
  });

  test('applies the Apple metadata flags only on the platform that emits it', () => {
    expect(appleMetadataTarFlags('darwin')).toEqual(['--no-xattrs', '--exclude=._*']);
    expect(appleMetadataTarFlags('linux')).toEqual([]);
    expect(stagingTarArgs(['-cf', 'a.tar'], ['-C', '/src', '.git'], 'linux')).toEqual([
      '-cf',
      'a.tar',
      '-C',
      '/src',
      '.git',
    ]);
    expect(stagingTarArgs(['-cf', 'a.tar'], ['-C', '/src', '.git'], 'darwin')).toEqual([
      '-cf',
      'a.tar',
      '--no-xattrs',
      '--exclude=._*',
      '-C',
      '/src',
      '.git',
    ]);
  });

  test('sets Apple own opt-out in the tar environment on every platform', () => {
    expect(stagingTarEnv({ PATH: '/usr/bin' })).toEqual({
      PATH: '/usr/bin',
      COPYFILE_DISABLE: '1',
    });
  });
});
