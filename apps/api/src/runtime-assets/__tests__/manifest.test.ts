import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OPENCODE_VERSION } from '@kortix/shared/runtime-versions';
import {
  managedSkillOverlayFiles,
  managedSkillOverlayHash,
} from '../managed-skills';
import { _resetRuntimeAssetsCache, runtimeAssetsManifest } from '../manifest';

const CLI_BIN_ENV = 'KORTIX_SNAPSHOT_CLI_BIN_PATH';
const AGENT_BIN_ENV = 'KORTIX_SNAPSHOT_AGENT_BIN_PATH';
const ENTRYPOINT_ENV = 'KORTIX_SANDBOX_ENTRYPOINT_PATH';
const SELF_UPDATE_ENV = 'RUNTIME_AGENT_SELF_UPDATE';
const BUILD_ENV = 'RUNTIME_ASSETS_BUILD';
const VERSION_ENV = 'KORTIX_VERSION';
const COMMIT_ENV = 'KORTIX_COMMIT';
const MANAGED_ENV = [
  ENTRYPOINT_ENV,
  CLI_BIN_ENV,
  AGENT_BIN_ENV,
  SELF_UPDATE_ENV,
  BUILD_ENV,
  VERSION_ENV,
  COMMIT_ENV,
] as const;
const originalEnv = new Map(MANAGED_ENV.map((key) => [key, process.env[key]]));
const tempDirs: string[] = [];

async function stageBinary(name: string, bytes: string, version?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'runtime-assets-test-'));
  tempDirs.push(dir);
  const binaryPath = join(dir, name);
  await writeFile(binaryPath, bytes);
  if (version !== undefined) await writeFile(`${binaryPath}.version`, `${version}\n`);
  return binaryPath;
}

const stageCli = (bytes: string, version?: string) => stageBinary('kortix', bytes, version);
const stageAgent = (bytes: string) => stageBinary('kortix-agent', bytes);

beforeEach(() => {
  // Pin BOTH binaries away from the repo's real ~96 MB / ~104 MB dist artifacts.
  // Without this every case in this file would stream-hash 200 MB of real
  // binary, and the suite would pass or fail on whether a checkout happens to
  // have been built.
  process.env[CLI_BIN_ENV] = join(tmpdir(), 'kortix-runtime-assets-unset-cli');
  process.env[AGENT_BIN_ENV] = join(tmpdir(), 'kortix-runtime-assets-unset-agent');
  process.env[ENTRYPOINT_ENV] = join(tmpdir(), 'kortix-runtime-assets-unset-entrypoint');
  delete process.env[SELF_UPDATE_ENV];
  delete process.env[BUILD_ENV];
  delete process.env[VERSION_ENV];
  delete process.env[COMMIT_ENV];
  _resetRuntimeAssetsCache();
});

afterEach(async () => {
  for (const key of MANAGED_ENV) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
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
    // Not object identity: the returned object is assembled per call so `policy`
    // can be read live. Everything that costs a hash comes from the memo, which
    // is what this asserts — the rewritten file is NOT re-read.
    expect(second.cli_sha256).toBe(first.cli_sha256 as string);
    expect(second.cli_size).toBe(first.cli_size as number);
    expect(second.build).toBe(first.build);
    expect(second.components).toEqual(first.components);
  });

  test('two CONCURRENT first calls hash the binaries exactly once', async () => {
    const cliPath = await stageCli('concurrent-cli');
    const agentPath = await stageAgent('concurrent-agent');
    process.env[CLI_BIN_ENV] = cliPath;
    process.env[AGENT_BIN_ENV] = agentPath;
    _resetRuntimeAssetsCache();

    // Both calls are issued before either can settle, so they can only agree if
    // the memo stores the in-flight PROMISE rather than the resolved value.
    // Rewriting both files the instant the first read starts would make a second
    // hash observable as a different digest.
    const [a, b] = await Promise.all([runtimeAssetsManifest(), runtimeAssetsManifest()]);
    await writeFile(cliPath, 'mutated-cli');
    await writeFile(agentPath, 'mutated-agent');
    const c = await runtimeAssetsManifest();

    const expectedCli = new Bun.CryptoHasher('sha256').update('concurrent-cli').digest('hex');
    const expectedAgent = new Bun.CryptoHasher('sha256').update('concurrent-agent').digest('hex');
    for (const manifest of [a, b, c]) {
      expect(manifest.components.cli?.sha256).toBe(expectedCli);
      expect(manifest.components.agent?.sha256).toBe(expectedAgent);
    }
  });

  test('the supervising entrypoint is served as a digested component when the image carries it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'runtime-assets-entrypoint-'));
    const path = join(dir, 'entrypoint.sh');
    await writeFile(path, '#!/bin/bash\necho supervisor\n');
    process.env[ENTRYPOINT_ENV] = path;
    _resetRuntimeAssetsCache();
    const manifest = await runtimeAssetsManifest();
    const expected = new Bun.CryptoHasher('sha256').update('#!/bin/bash\necho supervisor\n').digest('hex');
    expect(manifest.components.entrypoint).toEqual({
      version: null,
      sha256: expected,
      size: '#!/bin/bash\necho supervisor\n'.length,
      path: '/v1/runtime-assets/entrypoint',
    });
    await rm(dir, { recursive: true, force: true });
  });

  test('no entrypoint file = no component, never a fabricated one', async () => {
    _resetRuntimeAssetsCache();
    expect((await runtimeAssetsManifest()).components.entrypoint).toBeUndefined();
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

/**
 * THE COMPATIBILITY GUARD. Deployed daemons read the v1 keys off this document
 * (apps/kortix-sandbox-agent-server/src/runtime-assets.ts). Dropping or renaming
 * one is invisible in a typecheck of the API alone and breaks every box already
 * in the field — the accept-encoding two-list divergence, again. This test is
 * what stops a future refactor from doing it quietly.
 */
describe('manifest v1 keys are permanent', () => {
  const V1_KEYS = [
    'cli_version',
    'cli_sha256',
    'cli_size',
    'managed_skills_hash',
    'managed_skills_count',
  ] as const;

  test('every v1 key is present with its v1 meaning, alongside the v2 keys', async () => {
    process.env[CLI_BIN_ENV] = await stageCli('v1-cli-bytes', '0.13.1+abc12345');
    process.env[AGENT_BIN_ENV] = await stageAgent('v1-agent-bytes');
    _resetRuntimeAssetsCache();

    const manifest = await runtimeAssetsManifest();
    for (const key of V1_KEYS) {
      expect(Object.hasOwn(manifest, key)).toBe(true);
    }
    // Meaning, not just presence: a key that survives a refactor as `undefined`
    // or as a renamed alias is the same outage.
    expect(manifest.cli_version).toBe('0.13.1+abc12345');
    expect(manifest.cli_sha256).toBe(
      new Bun.CryptoHasher('sha256').update('v1-cli-bytes').digest('hex'),
    );
    expect(manifest.cli_size).toBe('v1-cli-bytes'.length);
    expect(manifest.managed_skills_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.managed_skills_count).toBe(managedSkillOverlayFiles().length);

    // v2 is ADDITIVE — it sits beside v1, it does not replace it.
    expect(typeof manifest.build).toBe('number');
    expect(manifest.components).toBeDefined();
    expect(manifest.policy).toBeDefined();
  });

  test('the v1 CLI keys and components.cli describe the SAME bytes', async () => {
    process.env[CLI_BIN_ENV] = await stageCli('one-measurement', '0.13.1+deadbeef');
    _resetRuntimeAssetsCache();

    const manifest = await runtimeAssetsManifest();
    // A v1 daemon and a v2 daemon reading one manifest must converge on one
    // binary. Two spellings of one measurement, never two measurements.
    expect(manifest.components.cli?.sha256).toBe(manifest.cli_sha256 as string);
    expect(manifest.components.cli?.size).toBe(manifest.cli_size as number);
    expect(manifest.components.cli?.version).toBe(manifest.cli_version);
    expect(manifest.components.cli?.path).toBe('/v1/runtime-assets/cli');
  });

  test('the v1 skill keys and components["managed-skills"] agree', async () => {
    _resetRuntimeAssetsCache();
    const manifest = await runtimeAssetsManifest();
    expect(manifest.components['managed-skills'].hash).toBe(manifest.managed_skills_hash);
    expect(manifest.components['managed-skills'].count).toBe(manifest.managed_skills_count);
  });

  test('an absent CLI binary still reports the v1 nulls, not a missing key', async () => {
    _resetRuntimeAssetsCache();
    const manifest = await runtimeAssetsManifest();
    for (const key of V1_KEYS) expect(Object.hasOwn(manifest, key)).toBe(true);
    expect(manifest.cli_sha256).toBeNull();
    // The v2 spelling of "absent" is an omitted component, which is what tells a
    // v2 daemon to skip that half.
    expect(manifest.components.cli).toBeUndefined();
  });
});

describe('manifest v2 components', () => {
  test('agent reports version, digest, size, and its download path', async () => {
    process.env[AGENT_BIN_ENV] = await stageAgent('kortix-agent-bytes');
    process.env[VERSION_ENV] = '0.13.1-dev.abc12345';
    process.env[COMMIT_ENV] = 'abc12345def67890';
    _resetRuntimeAssetsCache();

    const agent = (await runtimeAssetsManifest()).components.agent;
    expect(agent?.sha256).toBe(
      new Bun.CryptoHasher('sha256').update('kortix-agent-bytes').digest('hex'),
    );
    expect(agent?.size).toBe('kortix-agent-bytes'.length);
    expect(agent?.path).toBe('/v1/runtime-assets/agent');
    // `<version>+<commit8>` — the same stamp shape the CLI stage bakes.
    expect(agent?.version).toBe('0.13.1-dev.abc12345+abc12345');
  });

  test('an unstamped image reports a null agent version, never a fabricated one', async () => {
    process.env[AGENT_BIN_ENV] = await stageAgent('unstamped');
    _resetRuntimeAssetsCache();
    const agent = (await runtimeAssetsManifest()).components.agent;
    expect(agent?.version).toBeNull();
    expect(agent?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test('an absent agent binary omits the component and keeps every other one', async () => {
    process.env[CLI_BIN_ENV] = await stageCli('cli-survives');
    _resetRuntimeAssetsCache();
    const manifest = await runtimeAssetsManifest();
    expect(manifest.components.agent).toBeUndefined();
    expect(manifest.components.cli).toBeDefined();
    expect(manifest.components.opencode.version).toBe(OPENCODE_VERSION);
    expect(manifest.components['managed-skills'].count).toBeGreaterThan(0);
  });

  test('an empty (truncated) agent binary is treated as absent', async () => {
    process.env[AGENT_BIN_ENV] = await stageAgent('');
    _resetRuntimeAssetsCache();
    expect((await runtimeAssetsManifest()).components.agent).toBeUndefined();
  });

  test('opencode states the expected npm version and is not proxied', async () => {
    _resetRuntimeAssetsCache();
    const opencode = (await runtimeAssetsManifest()).components.opencode;
    expect(opencode.version).toBe(OPENCODE_VERSION);
    expect(opencode.source).toBe('npm');
    // No `path`: 167 MB per stale box must not cross our control plane.
    expect(Object.hasOwn(opencode, 'path')).toBe(false);
  });
});

describe('manifest build number', () => {
  test('is stable across calls — it does not move per request', async () => {
    process.env[AGENT_BIN_ENV] = await stageAgent('stable-build');
    _resetRuntimeAssetsCache();

    const first = (await runtimeAssetsManifest()).build;
    await Bun.sleep(1100); // long enough that a request-time clock would differ
    const second = (await runtimeAssetsManifest()).build;
    expect(second).toBe(first);
    expect(first).toBeGreaterThan(0);
  });

  test('is the image build time — the mtime of the baked binary, in seconds', async () => {
    const agentPath = await stageAgent('mtime-derived');
    process.env[AGENT_BIN_ENV] = agentPath;
    const stamp = new Date('2026-08-20T12:00:00.000Z');
    await utimes(agentPath, stamp, stamp);
    _resetRuntimeAssetsCache();

    expect((await runtimeAssetsManifest()).build).toBe(Math.floor(stamp.getTime() / 1000));
  });

  test('moves FORWARD for a newer image and never backwards for the same one', async () => {
    const oldPath = await stageAgent('old-image');
    await utimes(oldPath, new Date('2026-08-01T00:00:00Z'), new Date('2026-08-01T00:00:00Z'));
    process.env[AGENT_BIN_ENV] = oldPath;
    _resetRuntimeAssetsCache();
    const oldBuild = (await runtimeAssetsManifest()).build;

    const newPath = await stageAgent('new-image');
    await utimes(newPath, new Date('2026-08-20T00:00:00Z'), new Date('2026-08-20T00:00:00Z'));
    process.env[AGENT_BIN_ENV] = newPath;
    _resetRuntimeAssetsCache();
    const newBuild = (await runtimeAssetsManifest()).build;

    // This is the anti-flap guard: during a rolling deploy the two live API
    // versions serve two builds, and a box takes only the higher one.
    expect(newBuild).toBeGreaterThan(oldBuild);
  });

  test('takes the max of the agent and CLI binaries so one missing file cannot regress it', async () => {
    const agentPath = await stageAgent('agent-newer');
    const cliPath = await stageCli('cli-older');
    await utimes(cliPath, new Date('2026-08-01T00:00:00Z'), new Date('2026-08-01T00:00:00Z'));
    await utimes(agentPath, new Date('2026-08-20T00:00:00Z'), new Date('2026-08-20T00:00:00Z'));
    process.env[AGENT_BIN_ENV] = agentPath;
    process.env[CLI_BIN_ENV] = cliPath;
    _resetRuntimeAssetsCache();

    expect((await runtimeAssetsManifest()).build).toBe(
      Math.floor(new Date('2026-08-20T00:00:00Z').getTime() / 1000),
    );
  });

  test('RUNTIME_ASSETS_BUILD overrides it — the rollback escape hatch', async () => {
    process.env[AGENT_BIN_ENV] = await stageAgent('rolled-back');
    process.env[BUILD_ENV] = '1900000000';
    _resetRuntimeAssetsCache();
    expect((await runtimeAssetsManifest()).build).toBe(1_900_000_000);
  });

  test('a malformed RUNTIME_ASSETS_BUILD falls back to the mtime instead of poisoning it', async () => {
    const agentPath = await stageAgent('bad-override');
    const stamp = new Date('2026-08-20T12:00:00.000Z');
    await utimes(agentPath, stamp, stamp);
    process.env[AGENT_BIN_ENV] = agentPath;
    for (const bad of ['not-a-number', '-5', '1.5e400', '']) {
      process.env[BUILD_ENV] = bad;
      _resetRuntimeAssetsCache();
      expect((await runtimeAssetsManifest()).build).toBe(Math.floor(stamp.getTime() / 1000));
    }
  });

  test('is 0 when the image carries no binary at all — degrades, never regresses', async () => {
    _resetRuntimeAssetsCache();
    // A box compares with a strict `<`, so 0 simply never out-ranks what it has.
    expect((await runtimeAssetsManifest()).build).toBe(0);
  });
});

describe('manifest policy — the agent self-update kill switch', () => {
  test('defaults to enabled', async () => {
    _resetRuntimeAssetsCache();
    expect((await runtimeAssetsManifest()).policy.agent_self_update).toBe(true);
  });

  test('RUNTIME_AGENT_SELF_UPDATE=false stops the rollout', async () => {
    process.env[SELF_UPDATE_ENV] = 'false';
    _resetRuntimeAssetsCache();
    expect((await runtimeAssetsManifest()).policy.agent_self_update).toBe(false);
  });

  test('accepts the operator spellings an operator actually types', async () => {
    for (const off of ['false', 'FALSE', 'False', '0', ' false ']) {
      process.env[SELF_UPDATE_ENV] = off;
      _resetRuntimeAssetsCache();
      expect((await runtimeAssetsManifest()).policy.agent_self_update).toBe(false);
    }
  });

  test('a typo fails SAFE — towards the default, not a silent fleet freeze', async () => {
    for (const noise of ['flase', 'no', 'off', 'true', '1', '']) {
      process.env[SELF_UPDATE_ENV] = noise;
      _resetRuntimeAssetsCache();
      expect((await runtimeAssetsManifest()).policy.agent_self_update).toBe(true);
    }
  });

  test('is read live — the switch does not wait on the digest memo', async () => {
    process.env[AGENT_BIN_ENV] = await stageAgent('live-policy');
    _resetRuntimeAssetsCache();
    expect((await runtimeAssetsManifest()).policy.agent_self_update).toBe(true);

    // No cache reset: this is the property that makes the kill switch a config
    // change and not a deploy.
    process.env[SELF_UPDATE_ENV] = 'false';
    const flipped = await runtimeAssetsManifest();
    expect(flipped.policy.agent_self_update).toBe(false);
    // …and flipping it did NOT invalidate the expensive half.
    expect(flipped.components.agent?.sha256).toBe(
      new Bun.CryptoHasher('sha256').update('live-policy').digest('hex'),
    );
  });
});
