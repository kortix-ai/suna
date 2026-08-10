import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  managedSkillOverlayFiles,
  managedSkillOverlayHash,
} from '../managed-skills';
import { _resetRuntimeAssetsCache, runtimeAssetsManifest } from '../manifest';

const CLI_BIN_ENV = 'KORTIX_SNAPSHOT_CLI_BIN_PATH';
const originalCliBin = process.env[CLI_BIN_ENV];
const tempDirs: string[] = [];

async function stageCli(bytes: string, version?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'runtime-assets-test-'));
  tempDirs.push(dir);
  const binaryPath = join(dir, 'kortix');
  await writeFile(binaryPath, bytes);
  if (version !== undefined) await writeFile(`${binaryPath}.version`, `${version}\n`);
  return binaryPath;
}

afterEach(async () => {
  if (originalCliBin === undefined) delete process.env[CLI_BIN_ENV];
  else process.env[CLI_BIN_ENV] = originalCliBin;
  _resetRuntimeAssetsCache();
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

describe('managed-skill overlay', () => {
  test('is non-empty, kortix-scoped, and deduplicated by path', () => {
    const files = managedSkillOverlayFiles();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(file.path.startsWith('kortix-')).toBe(true);
      expect(file.path.includes('..')).toBe(false);
      expect(file.path.startsWith('/')).toBe(false);
    }
    expect(new Set(files.map((f) => f.path)).size).toBe(files.length);
    // The overlay is what teaches every agent the platform; kortix-system is the
    // entry pointer every other managed skill references by name.
    expect(files.some((f) => f.path === 'kortix-system/SKILL.md')).toBe(true);
  });

  test('is emitted in a deterministic order', () => {
    const paths = managedSkillOverlayFiles().map((f) => f.path);
    expect([...paths].sort((a, b) => a.localeCompare(b))).toEqual(paths);
  });

  test('hash is stable across calls and identical for identical input', () => {
    const a = managedSkillOverlayFiles();
    const b = managedSkillOverlayFiles();
    expect(managedSkillOverlayHash(a)).toBe(managedSkillOverlayHash(b));
    expect(managedSkillOverlayHash(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  test('hash moves when any byte of any file changes', () => {
    const files = managedSkillOverlayFiles();
    const base = managedSkillOverlayHash(files);
    const mutated = files.map((f, i) => (i === 0 ? { ...f, content: `${f.content}x` } : f));
    expect(managedSkillOverlayHash(mutated)).not.toBe(base);
  });

  test('hash moves when a file is renamed but keeps its content', () => {
    const files = managedSkillOverlayFiles();
    const base = managedSkillOverlayHash(files);
    const renamed = files.map((f, i) => (i === 0 ? { ...f, path: `${f.path}.bak` } : f));
    expect(managedSkillOverlayHash(renamed)).not.toBe(base);
  });

  test('hash is not confusable across a path/content boundary shift', () => {
    // Length-prefixed framing: `ab` + `c` must not hash like `a` + `bc`.
    const left = managedSkillOverlayHash([{ path: 'ab', content: 'c' }]);
    const right = managedSkillOverlayHash([{ path: 'a', content: 'bc' }]);
    expect(left).not.toBe(right);
  });
});

describe('runtime assets manifest', () => {
  test('reports the staged binary digest, size, and stamped version', async () => {
    const binaryPath = await stageCli('kortix-binary-bytes', '0.12.9+abc12345');
    process.env[CLI_BIN_ENV] = binaryPath;
    _resetRuntimeAssetsCache();

    const manifest = await runtimeAssetsManifest();
    expect(manifest.cli_size).toBe('kortix-binary-bytes'.length);
    expect(manifest.cli_sha256).toBe(
      new Bun.CryptoHasher('sha256').update('kortix-binary-bytes').digest('hex'),
    );
    expect(manifest.cli_version).toBe('0.12.9+abc12345');
    expect(manifest.managed_skills_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.managed_skills_count).toBe(managedSkillOverlayFiles().length);
  });

  test('is memoized — repeat calls do not re-hash', async () => {
    const binaryPath = await stageCli('one');
    process.env[CLI_BIN_ENV] = binaryPath;
    _resetRuntimeAssetsCache();

    const first = await runtimeAssetsManifest();
    await writeFile(binaryPath, 'two');
    const second = await runtimeAssetsManifest();
    expect(second).toBe(first);
  });

  test('a missing version sidecar reports null, not a fabricated version', async () => {
    process.env[CLI_BIN_ENV] = await stageCli('no-sidecar-here');
    _resetRuntimeAssetsCache();
    const manifest = await runtimeAssetsManifest();
    expect(manifest.cli_version).toBeNull();
    expect(manifest.cli_sha256).not.toBeNull();
  });

  test('an absent CLI binary nulls the CLI half and keeps the skill half', async () => {
    process.env[CLI_BIN_ENV] = join(tmpdir(), 'kortix-runtime-assets-does-not-exist');
    _resetRuntimeAssetsCache();
    const manifest = await runtimeAssetsManifest();
    expect(manifest.cli_sha256).toBeNull();
    expect(manifest.cli_size).toBeNull();
    expect(manifest.cli_version).toBeNull();
    expect(manifest.managed_skills_count).toBeGreaterThan(0);
  });

  test('an empty (truncated) CLI binary is treated as absent', async () => {
    process.env[CLI_BIN_ENV] = await stageCli('');
    _resetRuntimeAssetsCache();
    const manifest = await runtimeAssetsManifest();
    expect(manifest.cli_sha256).toBeNull();
  });
});
