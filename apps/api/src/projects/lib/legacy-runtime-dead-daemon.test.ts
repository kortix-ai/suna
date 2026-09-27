import { describe, expect, test } from 'bun:test';

import {
  LEGACY_CHECK_METADATA_KEY,
  REQUIRED_RUNTIME_CAPABILITIES,
  bootstrapLegacyRuntime,
  type ExpectedRunningAssets,
  type LegacyBootstrapDeps,
} from './legacy-runtime-bootstrap';

/**
 * The third divergence axis: the provider says RUNNING and the daemon answers
 * nothing.
 *
 * Measured on dev 2026-09-27. The row was parked at 20:56:46, the daemon's
 * dead-token breaker tripped 69 s later and shut the daemon down with exit 0,
 * and the Platinum entrypoint read exit 0 as an intentional stop and never
 * relaunched it (`relaunchStrategyFor`: "pt-init launches it once and never
 * again"). At 21:07 the provider reported `running`, our row reported `active`,
 * every ingress port answered 502, and the process table held no daemon and no
 * opencode. The control plane still accepted a prompt against it (202,
 * delivery `succeeded`, turn `active`, then `abandoned`) — the user-visible
 * "thinking forever".
 *
 * The repair refused to touch it: `classifyDaemonHealth(null)` is
 * `unreachable`, and `unreachable` returned before the repair. The one state
 * that most needs the exec-channel relaunch was the one state the repair
 * skipped. A hand-run of the script's own relaunch command brought the box back
 * in 11 seconds.
 */
const MANIFEST: ExpectedRunningAssets = {
  cli_sha256: 'c'.repeat(64),
  managed_skills_hash: 'm'.repeat(64),
  agent_sha256: 'a'.repeat(64),
};
/** A fully converged daemon under #7859's contract: capabilities present, `running` matching the manifest sha-to-sha, nothing pending, nothing pinned. */
const CURRENT_HEALTH = {
  daemon: 'ok',
  opencode: 'ok',
  capabilities: [...REQUIRED_RUNTIME_CAPABILITIES],
  uptime_s: 600,
  runtime: {
    build: 1788044234,
    components: { agent: 'current', opencode: 'current', cli: 'current', skills: 'current' },
    agentSwapPending: false,
    pinned: false,
    running: {
      cli_sha256: MANIFEST.cli_sha256,
      managed_skills_hash: MANIFEST.managed_skills_hash,
      agent_sha256: MANIFEST.agent_sha256,
    },
  },
};

interface Calls {
  execs: string[][];
  patches: Record<string, unknown>[];
}

function deadDaemonDeps(
  over: Partial<LegacyBootstrapDeps> & { health?: unknown[] },
  calls: Calls,
): LegacyBootstrapDeps {
  // Unreachable first (no daemon), then healthy once the relaunch lands.
  const healths = over.health ?? [null, CURRENT_HEALTH];
  let i = 0;
  // The converge wait is a real clock loop: `sleep` must MOVE `now`, or the
  // budget never expires and the test hangs instead of failing.
  const clock = { t: 1_000_000 };
  return {
    now: () => clock.t,
    sleep: async (ms) => {
      clock.t += ms;
    },
    manifestBuild: async () => 1788044234,
    fetchHealth: async () => healths[Math.min(i++, healths.length - 1)],
    // A dead daemon proxies nothing, so OpenCode cannot answer either.
    fetchOpencodeStatus: async () => null,
    providerRunning: async () => true,
    expectedRunningAssets: async () => MANIFEST,
    exec: async (cmd) => {
      calls.execs.push(cmd);
      return {
        exitCode: 0,
        stdout: '{"ok":true,"stage":"relaunched","agent_sha256":"a","entrypoint_sha256":"e"}\n',
        stderr: '',
      };
    },
    patchMetadata: async (patch) => {
      calls.patches.push(patch);
    },
    audit: async () => {},
    log: () => {},
    ...over,
  };
}

const input = (metadata: Record<string, unknown> | null = null) => ({
  sandboxId: 'sb1',
  externalId: 'sbx_1',
  provider: 'platinum',
  metadata,
  reason: 'reaper' as const,
});

describe('a running box whose daemon is gone', () => {
  test('is relaunched through the exec channel, not skipped as unreachable', async () => {
    const calls: Calls = { execs: [], patches: [] };
    const result = await bootstrapLegacyRuntime(input(), deadDaemonDeps({}, calls));
    expect(result.outcome).toBe('converged');
    expect(calls.execs).toHaveLength(1);
    expect(calls.execs[0][0]).toBe('bash');
  });

  test('a box the provider does NOT report running is left alone', async () => {
    // A stopped box has no ingress and no daemon. That is not a divergence, and
    // an exec against it would only fail.
    const calls: Calls = { execs: [], patches: [] };
    const result = await bootstrapLegacyRuntime(
      input(),
      deadDaemonDeps({ providerRunning: async () => false }, calls),
    );
    expect(result.outcome).toBe('unreachable');
    expect(calls.execs).toHaveLength(0);
  });

  test('an unanswerable provider is not evidence, so nothing is relaunched', async () => {
    const calls: Calls = { execs: [], patches: [] };
    const result = await bootstrapLegacyRuntime(
      input(),
      deadDaemonDeps({
        providerRunning: async () => {
          throw new Error('provider 503');
        },
      }, calls),
    );
    expect(result.outcome).toBe('unreachable');
    expect(calls.execs).toHaveLength(0);
  });

  test('a silent OpenCode never blocks the relaunch of a dead daemon', async () => {
    // `skipped-busy` is the gate that protects a RUNNING turn. A box with no
    // daemon serves no turn: OpenCode is proxied by the daemon, so its silence
    // here is the same fact, not a second one.
    const calls: Calls = { execs: [], patches: [] };
    const result = await bootstrapLegacyRuntime(
      input(),
      deadDaemonDeps({ fetchOpencodeStatus: async () => null }, calls),
    );
    expect(result.outcome).not.toBe('skipped-busy');
    expect(calls.execs).toHaveLength(1);
  });

  test('a staged record does not park a dead daemon for ever', async () => {
    // `staged` means "the assets are in place, the provider's next start
    // converges them". A box that will never be started again by anything is
    // exactly the box that must be relaunched now.
    const calls: Calls = { execs: [], patches: [] };
    const metadata = {
      kortixLegacyBootstrap: {
        state: 'staged',
        attempts: 1,
        manifestBuild: 1788044234,
        lastAttemptAt: new Date(1_000_000 - 60_000).toISOString(),
        reason: 'reaper',
      },
    };
    const result = await bootstrapLegacyRuntime(input(metadata), deadDaemonDeps({}, calls));
    expect(result.outcome).toBe('converged');
    expect(calls.execs).toHaveLength(1);
  });

  test('a pinned daemon is blocked, never relaunched, however the box looks to the provider', async () => {
    // THE SEMANTIC TRAP between this branch and #7859's classification. A
    // `blocked` daemon ANSWERED: it latched updates off after its own
    // supervisor rolled one back, and a human has to look at it. This branch
    // keys strictly on `unreachable` — a daemon that says nothing at all — so
    // the two can never claim the same box. Asserted, not argued.
    const calls: Calls = { execs: [], patches: [] };
    const pinned = {
      daemon: 'ok',
      opencode: 'ok',
      runtime: {
        build: 1788044234,
        components: { agent: 'current', opencode: 'current' },
        pinned: true,
      },
    };
    const result = await bootstrapLegacyRuntime(
      input(),
      deadDaemonDeps({ health: [pinned], providerRunning: async () => true }, calls),
    );
    expect(result.outcome).toBe('skipped-blocked');
    expect(calls.execs).toHaveLength(0);
  });

  test('the 6h recent-check TTL still gates the probe, which bounds detection', async () => {
    // KNOWN BOUND, asserted so it cannot change silently. The TTL returns
    // before the health probe, so a box whose LAST check said `current` is not
    // asked again for 6 h — a daemon that dies a minute later is detected at
    // the next probe, or immediately when a session is opened. Every box is
    // still considered on every pass; only the probe cadence is bounded.
    // Removing the gate would multiply health probes across the whole fleet by
    // the pass rate, which is a measured trade-off, not a free one.
    const calls: Calls = { execs: [], patches: [] };
    const metadata = {
      [LEGACY_CHECK_METADATA_KEY]: {
        at: new Date(1_000_000 - 60_000).toISOString(),
        klass: 'current',
      },
    };
    const result = await bootstrapLegacyRuntime(input(metadata), deadDaemonDeps({}, calls));
    expect(result.outcome).toBe('skipped-recent-check');
    expect(calls.execs).toHaveLength(0);
  });
});
