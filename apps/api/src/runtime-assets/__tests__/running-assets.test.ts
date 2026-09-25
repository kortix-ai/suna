/**
 * "Is this box running what this deploy serves?" — the detection half.
 *
 * THE ASYMMETRY, restated so nobody re-derives it from the code: config BLOCKS
 * the turn, binaries MUST NOT. Everything here answers a question; nothing here
 * applies anything, and nothing here is ever awaited on the send path.
 *
 * The binaries are pinned away from the repo's real ~96 MB / ~104 MB dist
 * artifacts for the reason manifest.test.ts documents: otherwise every case
 * stream-hashes 200 MB and the suite passes or fails on whether the checkout
 * happens to have been built.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OPENCODE_VERSION } from '@kortix/shared/runtime-versions';
import { managedSkillOverlayFiles, managedSkillOverlayHash } from '../managed-skills';
import {
  _resetRuntimeAssetsCache,
  manifestFingerprint,
  runningAssetsVerdict,
  type RunningAssetsReport,
} from '../manifest';
import {
  RUNNING_ASSETS_TTL_MS,
  __clearRunningAssetsForTests,
  lastKnownAssetVerdict,
  noteRunningAssets,
} from '../running-assets';

const CLI_BIN_ENV = 'KORTIX_SNAPSHOT_CLI_BIN_PATH';
const AGENT_BIN_ENV = 'KORTIX_SNAPSHOT_AGENT_BIN_PATH';
const ENTRYPOINT_ENV = 'KORTIX_SANDBOX_ENTRYPOINT_PATH';
const SELF_UPDATE_ENV = 'RUNTIME_AGENT_SELF_UPDATE';
const BUILD_ENV = 'RUNTIME_ASSETS_BUILD';
const MANAGED_ENV = [CLI_BIN_ENV, AGENT_BIN_ENV, ENTRYPOINT_ENV, SELF_UPDATE_ENV, BUILD_ENV] as const;
const originalEnv = new Map(MANAGED_ENV.map((key) => [key, process.env[key]]));
const tempDirs: string[] = [];

/** sha256 of the staged bytes, computed the same way the manifest does. */
async function stage(name: string, bytes: string): Promise<{ path: string; sha256: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'running-assets-test-'));
  tempDirs.push(dir);
  const path = join(dir, name);
  await writeFile(path, bytes);
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(bytes);
  return { path, sha256: hasher.digest('hex') };
}

const SKILLS_HASH = managedSkillOverlayHash(managedSkillOverlayFiles());

function running(over: Partial<RunningAssetsReport> = {}): RunningAssetsReport {
  return {
    cli_sha256: null,
    managed_skills_hash: SKILLS_HASH,
    agent_sha256: null,
    staged_agent_sha256: null,
    opencode_version: OPENCODE_VERSION,
    ...over,
  };
}

beforeEach(() => {
  process.env[CLI_BIN_ENV] = join(tmpdir(), 'running-assets-unset-cli');
  process.env[AGENT_BIN_ENV] = join(tmpdir(), 'running-assets-unset-agent');
  process.env[ENTRYPOINT_ENV] = join(tmpdir(), 'running-assets-unset-entrypoint');
  delete process.env[SELF_UPDATE_ENV];
  delete process.env[BUILD_ENV];
  _resetRuntimeAssetsCache();
  __clearRunningAssetsForTests();
});

afterEach(async () => {
  for (const key of MANAGED_ENV) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  _resetRuntimeAssetsCache();
  __clearRunningAssetsForTests();
  while (tempDirs.length > 0) await rm(tempDirs.pop() as string, { recursive: true, force: true });
});

describe('runningAssetsVerdict', () => {
  test('a box whose digests all match this deploy is current', async () => {
    const cli = await stage('kortix', 'cli-bytes');
    const agent = await stage('kortix-agent', 'agent-bytes');
    process.env[CLI_BIN_ENV] = cli.path;
    process.env[AGENT_BIN_ENV] = agent.path;
    _resetRuntimeAssetsCache();
    expect(
      await runningAssetsVerdict(running({ cli_sha256: cli.sha256, agent_sha256: agent.sha256 })),
    ).toBe('current');
  });

  test('one differing digest is enough to be behind', async () => {
    const cli = await stage('kortix', 'cli-bytes');
    process.env[CLI_BIN_ENV] = cli.path;
    _resetRuntimeAssetsCache();
    expect(await runningAssetsVerdict(running({ cli_sha256: 'f'.repeat(64) }))).toBe('behind');
  });

  test('a stale OpenCode version is behind — the one component with no sha to compare', async () => {
    expect(await runningAssetsVerdict(running({ opencode_version: '0.0.1' }))).toBe('behind');
  });

  test('a stale managed-skill overlay is behind', async () => {
    expect(await runningAssetsVerdict(running({ managed_skills_hash: 'f'.repeat(64) }))).toBe(
      'behind',
    );
  });

  // The bytes are on disk but the box is NOT running them. Reporting `current`
  // here would be the memo's one way to lie: the swap would then never be asked
  // for, and a long-lived box would carry a staged binary for ever.
  test('an agent that is STAGED but not running is behind, not current', async () => {
    const agent = await stage('kortix-agent', 'agent-bytes');
    process.env[AGENT_BIN_ENV] = agent.path;
    _resetRuntimeAssetsCache();
    expect(
      await runningAssetsVerdict(
        running({ agent_sha256: 'f'.repeat(64), staged_agent_sha256: agent.sha256 }),
      ),
    ).toBe('behind');
  });

  // The kill switch is read LIVE on every comparison, so it never waits on a
  // memo. A fleet frozen by it is not "behind": telling the control plane it is
  // would have every turn schedule a pass the daemon is guaranteed to refuse.
  test('RUNTIME_AGENT_SELF_UPDATE=false takes the agent out of the comparison', async () => {
    const agent = await stage('kortix-agent', 'agent-bytes');
    process.env[AGENT_BIN_ENV] = agent.path;
    _resetRuntimeAssetsCache();
    const behindOnAgentOnly = running({ agent_sha256: 'f'.repeat(64) });
    expect(await runningAssetsVerdict(behindOnAgentOnly)).toBe('behind');
    process.env[SELF_UPDATE_ENV] = 'false';
    expect(await runningAssetsVerdict(behindOnAgentOnly)).toBe('current');
  });

  test('a component this deploy does not state is not a difference', async () => {
    // No CLI binary staged: a local checkout that never built one. The box's own
    // CLI digest cannot make it behind something never described.
    expect(await runningAssetsVerdict(running({ cli_sha256: 'f'.repeat(64) }))).toBe('current');
  });

  test('a daemon that reports nothing comparable is unknown, never behind', async () => {
    expect(await runningAssetsVerdict(null)).toBe('unknown');
    expect(
      await runningAssetsVerdict({
        cli_sha256: null,
        managed_skills_hash: null,
        agent_sha256: null,
        staged_agent_sha256: null,
        opencode_version: null,
      }),
    ).toBe('unknown');
  });
});

describe('manifestFingerprint', () => {
  test('it is stable for one deploy', async () => {
    expect(await manifestFingerprint()).toBe(await manifestFingerprint());
  });

  test('a moved binary moves the fingerprint', async () => {
    const before = await manifestFingerprint();
    const cli = await stage('kortix', 'cli-bytes');
    process.env[CLI_BIN_ENV] = cli.path;
    _resetRuntimeAssetsCache();
    expect(await manifestFingerprint()).not.toBe(before);
  });

  // `RUNTIME_ASSETS_BUILD` is env-only and needs no deploy, so the fingerprint
  // has to cover it or a rolled-back image would keep serving memo hits taken
  // against the image it replaced.
  test('RUNTIME_ASSETS_BUILD moves the fingerprint with no deploy', async () => {
    const before = await manifestFingerprint();
    process.env[BUILD_ENV] = '999999';
    _resetRuntimeAssetsCache();
    expect(await manifestFingerprint()).not.toBe(before);
  });
});

describe('the running-assets memo', () => {
  const FP_A = 'fingerprint-a';
  const FP_B = 'fingerprint-b';

  test('a box reported current costs the next send zero probes', () => {
    expect(lastKnownAssetVerdict('s1', FP_A)).toBeUndefined();
    noteRunningAssets('s1', FP_A, 'current');
    expect(lastKnownAssetVerdict('s1', FP_A)).toBe('current');
  });

  // THE LOAD-BEARING PART. During a rolling deploy two API versions serve two
  // manifests, and the box's epoch guard refuses to go backwards. Without this,
  // process A caches a `behind` verdict computed against B's manifest and
  // re-schedules, for the length of the rollout, a pass the box will refuse.
  test('a fingerprint change is a MISS, not a hit', () => {
    noteRunningAssets('s1', FP_A, 'behind');
    expect(lastKnownAssetVerdict('s1', FP_B)).toBeUndefined();
    expect(lastKnownAssetVerdict('s1', FP_A)).toBe('behind');
  });

  test('it is per session', () => {
    noteRunningAssets('s1', FP_A, 'current');
    expect(lastKnownAssetVerdict('s2', FP_A)).toBeUndefined();
  });

  test('it expires, so a box the API stopped hearing from is re-checked', () => {
    expect(RUNNING_ASSETS_TTL_MS).toBeGreaterThanOrEqual(60_000);
  });
});
