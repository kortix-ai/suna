/**
 * C9 — a prompt on a box that is behind converges first, then runs.
 *
 * Every dep is injected, so these assert the DECISION and its cost, not a
 * database or a sandbox. The one thing that matters commercially is the first
 * describe: a box that is already current must pay nothing.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import {
  convergeAssetsInBackground,
  convergeBeforeTurnStart,
  DESIRED_TTL_MS,
  invalidateDesiredRelease,
  scheduleAssetConvergence,
  type AssetConvergenceDeps,
  type TurnStartConvergenceDeps,
} from '../turn-start-convergence';
import {
  __clearRunningAssetsForTests,
  forgetRunningAssets,
  lastKnownAssetVerdict,
  noteRunningAssets,
  shouldReportPinned,
} from '../../../runtime-assets/running-assets';
import { notifyBaseBranchMoved } from '../config-convergence-triggers';
import {
  __clearRunningReleasesForTests,
  lastKnownRunningRelease,
  noteRunningRelease,
} from '../../../config-releases/running-release';
import type { SessionConfigConvergenceOutcome } from '../session-config-convergence';

const RELEASE_A = 'a'.repeat(64);
const RELEASE_B = 'b'.repeat(64);
const SESSION = 'sess-1';

const TARGET = {
  projectId: 'p1',
  accountId: 'acct-1',
  repoUrl: '/tmp/repo.git',
  defaultBranch: 'main',
  manifestPath: 'kortix.yaml',
  projectMetadata: {},
  baseRef: 'main',
  agentName: 'kortix',
  sessionMetadata: {},
  createdBy: 'user-1',
};

let desiredCalls = 0;
let convergeCalls = 0;
let probeCalls = 0;
let probeAnswer: string | null | undefined = undefined;
let clock = 0;

function deps(over: Partial<TurnStartConvergenceDeps> = {}): TurnStartConvergenceDeps {
  return {
    loadTarget: async () => TARGET as never,
    desiredReleaseId: async () => {
      desiredCalls += 1;
      return RELEASE_A;
    },
    runningReleaseId: lastKnownRunningRelease,
    probeRunningRelease: async () => {
      probeCalls += 1;
      return probeAnswer;
    },
    converge: async (): Promise<SessionConfigConvergenceOutcome> => {
      convergeCalls += 1;
      return 'converged';
    },
    releasesEnabled: () => true,
    now: () => (clock += 1),
    ...over,
  };
}

beforeEach(() => {
  desiredCalls = 0;
  convergeCalls = 0;
  probeCalls = 0;
  probeAnswer = undefined;
  clock = 0;
  __clearRunningReleasesForTests();
});

describe('a box that is already current pays nothing', () => {
  test('no convergence runs when the running release equals the desired one', async () => {
    noteRunningRelease(SESSION, RELEASE_A);
    const result = await convergeBeforeTurnStart(SESSION, deps());
    expect(result.decision).toBe('current');
    expect(result.outcome).toBeNull();
    expect(convergeCalls).toBe(0);
  });

  test('the flag OFF costs not even a desired-release resolve', async () => {
    const result = await convergeBeforeTurnStart(SESSION, deps({ releasesEnabled: () => false }));
    expect(result.decision).toBe('skipped');
    expect(desiredCalls).toBe(0);
    expect(convergeCalls).toBe(0);
  });

  test('a session that is gone is skipped, never an error', async () => {
    const result = await convergeBeforeTurnStart(SESSION, deps({ loadTarget: async () => null }));
    expect(result.decision).toBe('skipped');
    expect(convergeCalls).toBe(0);
  });
});

describe('a box that is behind converges before the turn runs', () => {
  test('a different running release converges', async () => {
    noteRunningRelease(SESSION, RELEASE_B);
    const result = await convergeBeforeTurnStart(SESSION, deps());
    expect(result.decision).toBe('converged');
    expect(result.outcome).toBe('converged');
    expect(convergeCalls).toBe(1);
  });

  test('an UNKNOWN running release is PROBED first, and a current box still pays no convergence', async () => {
    // After a deploy, or when another API process converged the box, this
    // process knows nothing. One health GET answers it. A convergence here
    // cost a real turn 10 907 ms for an `unchanged` answer.
    expect(lastKnownRunningRelease(SESSION)).toBeUndefined();
    probeAnswer = RELEASE_A;
    const result = await convergeBeforeTurnStart(SESSION, deps());
    expect(probeCalls).toBe(1);
    expect(result.decision).toBe('current');
    expect(convergeCalls).toBe(0);
  });

  test('a probe that cannot tell converges — silence is never "current"', async () => {
    probeAnswer = undefined;
    const result = await convergeBeforeTurnStart(SESSION, deps());
    expect(probeCalls).toBe(1);
    expect(result.decision).toBe('converged');
    expect(convergeCalls).toBe(1);
  });

  test('a probe that reports a different release converges', async () => {
    probeAnswer = RELEASE_B;
    const result = await convergeBeforeTurnStart(SESSION, deps());
    expect(result.decision).toBe('converged');
    expect(convergeCalls).toBe(1);
  });

  test('a known running release is never probed', async () => {
    noteRunningRelease(SESSION, RELEASE_B);
    await convergeBeforeTurnStart(SESSION, deps());
    expect(probeCalls).toBe(0);
  });

  test('a box that runs NO release converges', async () => {
    noteRunningRelease(SESSION, null);
    const result = await convergeBeforeTurnStart(SESSION, deps());
    expect(result.decision).toBe('converged');
  });

  test('an unresolvable desired release still converges, and never throws', async () => {
    noteRunningRelease(SESSION, RELEASE_A);
    const result = await convergeBeforeTurnStart(
      SESSION,
      deps({
        desiredReleaseId: async () => {
          throw new Error('base ref does not resolve');
        },
      }),
    );
    expect(result.decision).toBe('converged');
  });
});

describe('the gate never refuses a turn', () => {
  test('a convergence that throws is swallowed', async () => {
    const result = await convergeBeforeTurnStart(
      SESSION,
      deps({
        converge: async () => {
          throw new Error('daemon exploded');
        },
      }),
    );
    expect(result.decision).toBe('skipped');
  });

  test('a busy session reports busy and the turn proceeds', async () => {
    const result = await convergeBeforeTurnStart(SESSION, deps({ converge: async () => 'busy' }));
    expect(result.decision).toBe('converged');
    expect(result.outcome).toBe('busy');
  });

  test('it reports what it cost the turn', async () => {
    noteRunningRelease(SESSION, RELEASE_A);
    const result = await convergeBeforeTurnStart(SESSION, deps());
    expect(result.ms).toBeGreaterThanOrEqual(0);
  });
});

describe('the desired-release memo is dropped by a base move, not only by its TTL', () => {
  // Measured on a real Platinum box, 2026-09-24: a resolve costs 573-795 ms.
  // Paying it on every prompt is what the memo exists to avoid; serving a
  // release resolved BEFORE a push is what the invalidation exists to avoid.
  test('the TTL is a backstop, not the freshness mechanism', () => {
    expect(DESIRED_TTL_MS).toBeGreaterThanOrEqual(60_000);
  });

  test('a base move drops the project`s entries and never throws', () => {
    expect(() => invalidateDesiredRelease('11111111-1111-4111-8111-111111111111')).not.toThrow();
  });

  test('every base move the API sees reaches the invalidation', () => {
    // `notifyBaseBranchMoved` is the ONE place the API learns a base branch
    // moved — an API write and a proxied push both arrive there. It must never
    // throw: it runs inside the write that moved the branch.
    expect(() => notifyBaseBranchMoved('11111111-1111-4111-8111-111111111111', 'refs/heads/main', 'test')).not.toThrow();
  });
});

describe('the running-release memo', () => {
  test('a daemon report is what teaches it', () => {
    expect(lastKnownRunningRelease(SESSION)).toBeUndefined();
    noteRunningRelease(SESSION, RELEASE_A);
    expect(lastKnownRunningRelease(SESSION)).toBe(RELEASE_A);
    noteRunningRelease(SESSION, RELEASE_B);
    expect(lastKnownRunningRelease(SESSION)).toBe(RELEASE_B);
  });

  test('it is per session', () => {
    noteRunningRelease('s1', RELEASE_A);
    expect(lastKnownRunningRelease('s2')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// RUNTIME ASSETS — the lane beside the config gate, and the one rule that
// separates them: CONFIG BLOCKS THE TURN, BINARIES MUST NOT.
//
// Config changes what the agent IS, so `convergeBeforeTurnStart` awaits and a
// stale box pays 10,287-10,907 ms. A box one turn behind on the CLI is the state
// that already exists today; a box that makes the user wait for ~100 MB is a
// regression. So this half DETECTS and SCHEDULES. It never applies, and it is
// never awaited on the send path. Every later reviewer will want to "just await
// it" — these cases are why not.
// ---------------------------------------------------------------------------
describe('the runtime-asset lane never costs the send', () => {
  const FP = 'fingerprint-a';
  let refreshCalls: string[] = [];
  let probeCalls: string[] = [];

  function assetDeps(over: Partial<AssetConvergenceDeps> = {}): AssetConvergenceDeps {
    return {
      fingerprint: async () => FP,
      lastVerdict: lastKnownAssetVerdict,
      refresh: (sessionId) => {
        refreshCalls.push(sessionId);
      },
      probe: async (sessionId) => {
        probeCalls.push(sessionId);
      },
      forget: forgetRunningAssets,
      ...over,
    };
  }

  beforeEach(() => {
    refreshCalls = [];
    probeCalls = [];
    __clearRunningAssetsForTests();
  });

  test('a box the API last saw CURRENT costs zero network calls', async () => {
    noteRunningAssets(SESSION, FP, 'current');
    expect(await convergeAssetsInBackground(SESSION, assetDeps())).toBe('current');
    expect(refreshCalls).toEqual([]);
    expect(probeCalls).toEqual([]);
  });

  test('a box the API last saw BEHIND gets a refresh POSTed, not awaited', async () => {
    noteRunningAssets(SESSION, FP, 'behind');
    expect(await convergeAssetsInBackground(SESSION, assetDeps())).toBe('scheduled');
    expect(refreshCalls).toEqual([SESSION]);
    expect(probeCalls).toEqual([]);
  });

  // "dok run-uje, u pozadini spremi swap." A cold memo must NOT make the send
  // pay a probe: fire one off and let the verdict land for the NEXT send.
  test('a COLD memo schedules a probe and sends no refresh', async () => {
    expect(await convergeAssetsInBackground(SESSION, assetDeps())).toBe('probe-scheduled');
    expect(probeCalls).toEqual([SESSION]);
    expect(refreshCalls).toEqual([]);
  });

  // Refresh ONCE, then re-measure. Without this the `behind` entry stands for
  // its whole TTL and every turn in that window POSTs another refresh, stacking
  // `scheduleSandboxRuntimeRefresh` retry ladders on one box. Forgetting the
  // entry makes the next send a cold memo, which probes and records what the box
  // actually did with the refresh.
  test('a scheduled refresh forgets the verdict instead of re-sending it every turn', async () => {
    noteRunningAssets(SESSION, FP, 'behind');
    expect(await convergeAssetsInBackground(SESSION, assetDeps())).toBe('scheduled');
    expect(await convergeAssetsInBackground(SESSION, assetDeps())).toBe('probe-scheduled');
    expect(refreshCalls).toEqual([SESSION]);
    expect(probeCalls).toEqual([SESSION]);
  });

  // The rolling-deploy guard. Two API versions serve two manifests; the box's
  // epoch guard refuses to go backwards. A verdict computed against the other
  // manifest must not keep re-scheduling a pass the box will refuse.
  test('a verdict taken against another manifest is a miss, not a hit', async () => {
    noteRunningAssets(SESSION, 'fingerprint-b', 'current');
    expect(await convergeAssetsInBackground(SESSION, assetDeps())).toBe('probe-scheduled');
    expect(refreshCalls).toEqual([]);
  });

  test('a fingerprint that cannot be computed skips the lane entirely', async () => {
    const decision = await convergeAssetsInBackground(
      SESSION,
      assetDeps({
        fingerprint: async () => {
          throw new Error('no manifest');
        },
      }),
    );
    expect(decision).toBe('skipped');
    expect(refreshCalls).toEqual([]);
    expect(probeCalls).toEqual([]);
  });

  test('a refresh that throws never reaches the caller', async () => {
    noteRunningAssets(SESSION, FP, 'behind');
    const decision = await convergeAssetsInBackground(
      SESSION,
      assetDeps({
        refresh: () => {
          throw new Error('box unreachable');
        },
      }),
    );
    expect(decision).toBe('skipped');
  });

  test('the fire-and-forget form returns synchronously and never throws', () => {
    expect(() => scheduleAssetConvergence(SESSION, assetDeps())).not.toThrow();
  });
});

describe('a box that crash-looped an update is reported once, not once per turn', () => {
  beforeEach(() => {
    __clearRunningAssetsForTests();
  });

  // `pinned: true` means the supervisor rolled an update back and latched
  // updates OFF. The daemon re-reads the latch from disk on every health call
  // precisely so this is visible; until now nothing in the API read it.
  test('the first sighting reports, the next ones inside the window do not', () => {
    expect(shouldReportPinned('sess-pinned')).toBe(true);
    expect(shouldReportPinned('sess-pinned')).toBe(false);
    expect(shouldReportPinned('sess-other')).toBe(true);
  });
});
