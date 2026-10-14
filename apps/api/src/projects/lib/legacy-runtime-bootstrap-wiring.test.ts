import { describe, expect, test } from 'bun:test';
import type { LegacyBootstrapDeps, LegacyBootstrapResult } from './legacy-runtime-bootstrap';
import {
  MAX_IN_FLIGHT,
  __resetLegacyBootstrapInFlightForTests,
  guaranteeCurrentRuntimeOnOpen,
  scheduleLegacyRuntimeBootstrap,
  type LegacyBootstrapRow,
} from './legacy-runtime-bootstrap-wiring';

const row = (sandboxId: string): LegacyBootstrapRow => ({
  sandboxId,
  sessionId: null,
  accountId: null,
  provider: 'platinum',
  externalId: `ext_${sandboxId}`,
  metadata: null,
});

describe('scheduleLegacyRuntimeBootstrap — repair-storm guard', () => {
  test(`N stale boxes: at most MAX_IN_FLIGHT (${MAX_IN_FLIGHT}) run at once; the rest are skipped THIS pass, not dropped`, async () => {
    __resetLegacyBootstrapInFlightForTests();
    let concurrent = 0;
    let maxConcurrent = 0;
    const releases: Array<() => void> = [];
    const runner = (): Promise<LegacyBootstrapResult> =>
      new Promise((resolve) => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        releases.push(() => {
          concurrent -= 1;
          resolve({ outcome: 'converged' });
        });
      });

    const N = MAX_IN_FLIGHT + 3;
    const scheduled = Array.from({ length: N }, (_, i) => scheduleLegacyRuntimeBootstrap(row(`sb-storm-${i}`), 'reaper', runner));

    expect(scheduled.filter(Boolean).length).toBe(MAX_IN_FLIGHT);
    expect(scheduled.filter((s) => !s).length).toBe(N - MAX_IN_FLIGHT);
    expect(maxConcurrent).toBeLessThanOrEqual(MAX_IN_FLIGHT);

    releases.forEach((release) => release());
    await new Promise((r) => setTimeout(r, 0));
    __resetLegacyBootstrapInFlightForTests();
  });

  test('the same box is never double-scheduled while its own attempt is in flight', async () => {
    __resetLegacyBootstrapInFlightForTests();
    let calls = 0;
    const state: { release: (() => void) | null } = { release: null };
    const runner = (): Promise<LegacyBootstrapResult> =>
      new Promise((resolve) => {
        calls += 1;
        state.release = () => resolve({ outcome: 'converged' });
      });
    const target = row('sb-same-box');
    expect(scheduleLegacyRuntimeBootstrap(target, 'reaper', runner)).toBe(true);
    expect(scheduleLegacyRuntimeBootstrap(target, 'reaper', runner)).toBe(false);
    expect(calls).toBe(1);
    state.release?.();
    await new Promise((r) => setTimeout(r, 0));
    __resetLegacyBootstrapInFlightForTests();
  });
});

function fakeDeps(over: Partial<LegacyBootstrapDeps> & { health?: unknown; status?: Record<string, unknown> | null }): LegacyBootstrapDeps {
  return {
    now: () => Date.parse('2026-09-27T00:00:00.000Z'),
    sleep: async () => {},
    manifestBuild: async () => 1790538288,
    fetchHealth: async () => over.health ?? null,
    fetchOpencodeStatus: async () => (over.status === undefined ? {} : over.status),
    exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    patchMetadata: async () => {},
    claimRun: async () => true,
    audit: async () => {},
    log: () => {},
    ...over,
  };
}

const REAL_STALE_HEALTH = {
  daemon: 'ok',
  opencode: 'ok',
  uptime_s: 2663144,
  runtime: {
    build: 1790538288,
    running: {},
    components: { cli: 'failed', skills: 'current', agent: 'staged', opencode: 'current' },
    agentSwapPending: true,
  },
  pty: [{ title: 'Session terminal', status: 'running', pid: 4088 }],
};

const CURRENT_HEALTH = {
  daemon: 'ok',
  opencode: 'ok',
  capabilities: ['config.release.v1'],
  uptime_s: 600,
  runtime: {
    build: 1790538288,
    components: { agent: 'current', opencode: 'current', cli: 'current', skills: 'current' },
    agentSwapPending: false,
    pinned: false,
    running: { cli_sha256: 'x', managed_skills_hash: 'y', agent_sha256: 'z' },
  },
};

const PINNED_HEALTH = {
  daemon: 'ok',
  opencode: 'ok',
  uptime_s: 2745710,
  runtime: {
    build: 1790538288,
    components: { cli: 'failed', skills: 'current', agent: 'staged', opencode: 'current' },
    agentSwapPending: true,
    pinned: true,
  },
};

describe('guaranteeCurrentRuntimeOnOpen — the session-open guarantee', () => {
  test('a current box: proceed, nothing scheduled', async () => {
    let scheduled = 0;
    const outcome = await guaranteeCurrentRuntimeOnOpen(
      row('sb-current'),
      fakeDeps({ health: CURRENT_HEALTH }),
      () => {
        scheduled += 1;
        return true;
      },
    );
    expect(outcome.action).toBe('proceed');
    expect(outcome.classification?.klass).toBe('current');
    expect(scheduled).toBe(0);
  });

  test('THE REAL BOX health body: idle → repairing, and the repair IS scheduled', async () => {
    let scheduled = 0;
    let scheduledReason: string | undefined;
    const outcome = await guaranteeCurrentRuntimeOnOpen(
      row('sb-real-stale'),
      fakeDeps({ health: REAL_STALE_HEALTH, status: {} }),
      (_r, reason) => {
        scheduled += 1;
        scheduledReason = reason;
        return true;
      },
    );
    expect(outcome.action).toBe('repairing');
    expect(outcome.classification?.klass).toBe('stale');
    expect(scheduled).toBe(1);
    expect(scheduledReason).toBe('session-open');
  });

  test('THE REAL BOX health body: a turn is running → defer, NEVER relaunch under it', async () => {
    let scheduled = 0;
    const outcome = await guaranteeCurrentRuntimeOnOpen(
      row('sb-real-stale-busy'),
      fakeDeps({ health: REAL_STALE_HEALTH, status: { ses_1: { type: 'busy' } } }),
      () => {
        scheduled += 1;
        return true;
      },
    );
    expect(outcome.action).toBe('defer_turn_running');
    expect(scheduled).toBe(0);
  });

  test('a pinned box: blocked, never scheduled, regardless of turn state', async () => {
    let scheduled = 0;
    const outcome = await guaranteeCurrentRuntimeOnOpen(
      row('sb-pinned'),
      fakeDeps({ health: PINNED_HEALTH, status: {} }),
      () => {
        scheduled += 1;
        return true;
      },
    );
    expect(outcome.action).toBe('blocked');
    expect(outcome.classification?.klass).toBe('blocked');
    expect(scheduled).toBe(0);
  });

  test('a box whose budget is exhausted on this manifest build: exhausted, nothing re-scheduled', async () => {
    let scheduled = 0;
    const metadata = {
      legacyRuntimeBootstrap: {
        state: 'failed',
        attempts: 3,
        manifestBuild: 1790538288,
        lastAttemptAt: '2026-09-26T00:00:00.000Z',
        error: 'agent: download failed',
      },
    };
    const outcome = await guaranteeCurrentRuntimeOnOpen(
      { ...row('sb-exhausted'), metadata },
      fakeDeps({ health: REAL_STALE_HEALTH, status: {} }),
      () => {
        scheduled += 1;
        return true;
      },
    );
    expect(outcome.action).toBe('exhausted');
    expect(outcome.retry?.status).toBe('exhausted');
    expect(outcome.retry?.lastError).toBe('agent: download failed');
    expect(scheduled).toBe(0);
  });

  test('a box mid-cooldown from a recent failed attempt: repairing is reported (client keeps polling) but NOT re-scheduled yet', async () => {
    let scheduled = 0;
    const metadata = {
      legacyRuntimeBootstrap: {
        state: 'failed',
        attempts: 1,
        manifestBuild: 1790538288,
        lastAttemptAt: '2026-09-27T00:00:00.000Z', // "now" in fakeDeps
      },
    };
    const outcome = await guaranteeCurrentRuntimeOnOpen(
      { ...row('sb-cooldown'), metadata },
      fakeDeps({ health: REAL_STALE_HEALTH, status: {} }),
      () => {
        scheduled += 1;
        return true;
      },
    );
    expect(outcome.action).toBe('repairing');
    expect(outcome.retry?.status).toBe('cooldown');
    expect(scheduled).toBe(0);
  });

  // Dev 2026-10-14: three deploys, three idle boxes answered `starting` for
  // 122-390 s. Each box held a `current` check from before the deploy, so the
  // repair the guarantee scheduled returned `skipped-recent-check` and never
  // ran; the stall ended only when the daemon swapped itself.
  test('a box with a recent current check: proceed — the repair would skip it, so never report repairing', async () => {
    let scheduled = 0;
    const metadata = { legacyRuntimeCheck: { at: '2026-09-26T23:00:00.000Z', klass: 'current', staleReasons: [], manifestBuild: 1790538288, externalId: 'ext_sb-recent-current' } };
    const outcome = await guaranteeCurrentRuntimeOnOpen(
      { ...row('sb-recent-current'), metadata },
      fakeDeps({ health: REAL_STALE_HEALTH, status: {} }),
      () => {
        scheduled += 1;
        return true;
      },
    );
    expect(outcome.action).toBe('proceed');
    expect(outcome.classification?.klass).toBe('stale');
    expect(scheduled).toBe(0);
  });

  // A `current` check proves only what was true for one manifest build on one
  // box. Each case below would otherwise proceed on a box that needs the repair.
  const repairsDespiteCheck = (name: string, check: Record<string, unknown>, health: unknown) =>
    test(name, async () => {
      let scheduled = 0;
      const sandboxId = `sb-${name.length}`;
      const outcome = await guaranteeCurrentRuntimeOnOpen(
        { ...row(sandboxId), metadata: { legacyRuntimeCheck: { at: '2026-09-26T23:00:00.000Z', klass: 'current', staleReasons: [], externalId: `ext_${sandboxId}`, ...check } } },
        fakeDeps({ health, status: {} }),
        () => {
          scheduled += 1;
          return true;
        },
      );
      expect(outcome.action).toBe('repairing');
      expect(scheduled).toBe(1);
    });
  const { capabilities: _dropped, ...MISSING_CAPABILITY_HEALTH } = CURRENT_HEALTH;
  repairsDespiteCheck('a deploy added a required capability: a check from the previous build repairs', { manifestBuild: 1790538287 }, MISSING_CAPABILITY_HEALTH);
  repairsDespiteCheck('the row got a new box: a check from another box repairs', { manifestBuild: 1790538288, externalId: 'ext_an-older-box' }, REAL_STALE_HEALTH);
  repairsDespiteCheck('a check written before checks carried a build repairs (one extra probe per box)', { manifestBuild: undefined }, REAL_STALE_HEALTH);

  test('a current check older than the 6 h TTL still repairs', async () => {
    let scheduled = 0;
    const metadata = { legacyRuntimeCheck: { at: '2026-09-26T17:00:00.000Z', klass: 'current', staleReasons: [] } };
    const outcome = await guaranteeCurrentRuntimeOnOpen(
      { ...row('sb-old-current'), metadata },
      fakeDeps({ health: REAL_STALE_HEALTH, status: {} }),
      () => {
        scheduled += 1;
        return true;
      },
    );
    expect(outcome.action).toBe('repairing');
    expect(scheduled).toBe(1);
  });

  test('a box already staged on this build (Daytona/E2B): proceed — it converges at its next start', async () => {
    let scheduled = 0;
    const metadata = {
      legacyRuntimeBootstrap: { state: 'staged', attempts: 1, manifestBuild: 1790538288, lastAttemptAt: '2026-09-26T23:00:00.000Z' },
    };
    const outcome = await guaranteeCurrentRuntimeOnOpen(
      { ...row('sb-staged'), provider: 'daytona', metadata },
      fakeDeps({ health: REAL_STALE_HEALTH, status: {} }),
      () => {
        scheduled += 1;
        return true;
      },
    );
    expect(outcome.action).toBe('proceed');
    expect(outcome.retry?.status).toBe('staged');
    expect(scheduled).toBe(0);
  });

  test('the guarantee kill switch fails open and never even reads the classification', async () => {
    process.env.LEGACY_RUNTIME_BOOTSTRAP = 'off';
    try {
      let fetchHealthCalls = 0;
      const deps = fakeDeps({ health: REAL_STALE_HEALTH });
      const outcome = await guaranteeCurrentRuntimeOnOpen(row('sb-killswitch'), {
        ...deps,
        fetchHealth: async () => {
          fetchHealthCalls += 1;
          return REAL_STALE_HEALTH;
        },
      });
      expect(outcome.action).toBe('proceed');
      expect(outcome.classification).toBeNull();
      expect(fetchHealthCalls).toBe(0);
    } finally {
      delete process.env.LEGACY_RUNTIME_BOOTSTRAP;
    }
  });
});
