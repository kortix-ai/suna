/**
 * BOUNDED SANDBOX LIFETIME — shadow mode.
 *
 * The property that matters most here is a NEGATIVE one: this pass must be
 * incapable of stopping a box. It is asserted three ways — the module imports
 * no provider, it makes no provider call, and its result's `stopped` is
 * structurally 0.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let candidates: unknown[] = [];
let divergent: unknown[] = [];
let candidateError: Error | null = null;
let lastCandidateOpts: { perAccountCap: number; limit: number } | null = null;
let lastDivergenceWindowMs: number | null = null;

mock.module('./shadow-queries', () => ({
  selectExpiredDeadlineCandidates: async (opts: { perAccountCap: number; limit: number }) => {
    lastCandidateOpts = opts;
    if (candidateError) throw candidateError;
    return candidates;
  },
  selectDivergentOldModelStops: async (sinceMs: number) => {
    lastDivergenceWindowMs = sinceMs;
    return divergent;
  },
}));

const { runSandboxDeadlineShadowPass } = await import('./shadow');

const HOUR = 3_600_000;

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    sandboxId: 'box-1',
    sessionId: 'sess-1',
    accountId: 'acct-1',
    projectId: 'proj-1',
    provider: 'daytona',
    externalId: 'ext-1',
    status: 'active',
    activeSince: new Date(Date.now() - 23 * HOUR),
    deadlineAt: new Date(Date.now() - HOUR),
    overdueMs: HOUR,
    ageHours: 23,
    source: 'trigger:cron',
    harness: 'opencode',
    transport: 'rest',
    cohort: 'backfilled',
    lastUsageAgeMs: null,
    lastAcpRelayAgeMs: null,
    perAccountRank: 1,
    ...overrides,
  };
}

beforeEach(() => {
  candidates = [];
  divergent = [];
  candidateError = null;
  lastCandidateOpts = null;
  lastDivergenceWindowMs = null;
});

const RUN = { perAccountCap: 5, limit: 25, divergenceWindowMs: 300_000 };

describe('runSandboxDeadlineShadowPass — it must not act', () => {
  test('reports zero stops even with a full batch of overdue boxes', async () => {
    candidates = [candidate(), candidate({ sandboxId: 'box-2' })];
    const result = await runSandboxDeadlineShadowPass(RUN);
    expect(result.stopped).toBe(0);
    expect(result.wouldStop).toBe(2);
    expect(result.matching).toBe(2);
  });

  test('the module cannot stop a box because it cannot reach a provider', () => {
    // Stronger than a flag check: there is no import to forget to gate.
    const source = readFileSync(resolve(import.meta.dir, 'shadow.ts'), 'utf8');
    expect(source).not.toContain('platform/providers');
    expect(source).not.toContain('applyStoppedState');
    expect(source).not.toMatch(/\.stop\(/);
  });
});

describe('the two directions of the comparison', () => {
  test('would_stop counts boxes the OLD model kept alive', async () => {
    // Anything still active with an expired deadline survived this tick's
    // reaper, which is exactly "old kept it, new would kill it".
    candidates = [candidate(), candidate({ sandboxId: 'box-2' })];
    expect((await runSandboxDeadlineShadowPass(RUN)).wouldStop).toBe(2);
  });

  test('would_keep counts boxes the OLD model stopped that the new model would have kept', async () => {
    // The direction a naive shadow implementation drops. This design deletes
    // the busy probe, the lease, the idle countdown and the hard-stop ceiling —
    // four killers it gives up — so "are the new rules too LENIENT" has to be
    // measurable too.
    divergent = [
      {
        sandboxId: 'box-9',
        sessionId: 'sess-9',
        accountId: 'acct-1',
        provider: 'daytona',
        deadlineAt: new Date(Date.now() + 2 * HOUR),
        remainingMs: 2 * HOUR,
        stoppedAt: new Date(),
        source: 'ui',
        cohort: 'live',
      },
    ];
    expect((await runSandboxDeadlineShadowPass(RUN)).wouldKeep).toBe(1);
  });

  test('asks for divergence over exactly the tick it was given', async () => {
    await runSandboxDeadlineShadowPass({ ...RUN, divergenceWindowMs: 123_000 });
    expect(lastDivergenceWindowMs).toBe(123_000);
  });
});

describe('bucketing — without it the acceptance criteria pass vacuously', () => {
  test('separates the backfilled noise floor from the live cohort', async () => {
    // ~150 backfilled zombies would otherwise bury a handful of genuine
    // live-cohort false positives, and "wrong rate < 1%" would pass for the
    // wrong reason.
    candidates = [
      candidate({ cohort: 'backfilled' }),
      candidate({ sandboxId: 'box-2', cohort: 'backfilled' }),
      candidate({ sandboxId: 'box-3', cohort: 'live' }),
    ];
    expect((await runSandboxDeadlineShadowPass(RUN)).byCohort).toEqual({
      backfilled: 2,
      live: 1,
    });
  });

  test('buckets by progress channel, so a BYOK box is not read as a dead one', async () => {
    candidates = [
      candidate({ harness: 'opencode', transport: 'rest' }),
      candidate({ sandboxId: 'box-2', harness: 'claude', transport: 'acp' }),
      candidate({ sandboxId: 'box-3', harness: null, transport: null }),
    ];
    expect((await runSandboxDeadlineShadowPass(RUN)).byProgressChannel).toEqual({
      gateway: 1,
      acp: 1,
      none: 1,
    });
  });

  test('buckets by metadata.source, which is NOT project_sessions.origin', async () => {
    // The two disagree badly in prod (metadata: 154 trigger:cron / 41 ui;
    // origin: 26 schedule / 170 user), so reporting on the wrong one would
    // mislabel the entire population.
    candidates = [
      candidate({ source: 'trigger:cron' }),
      candidate({ sandboxId: 'b2', source: 'ui' }),
    ];
    expect((await runSandboxDeadlineShadowPass(RUN)).bySource).toEqual({
      'trigger:cron': 1,
      ui: 1,
    });
  });
});

describe('the leading false-kill indicator', () => {
  test('counts a candidate with recent BILLED progress', async () => {
    candidates = [candidate({ lastUsageAgeMs: 60_000 })];
    expect((await runSandboxDeadlineShadowPass(RUN)).withRecentUsage).toBe(1);
  });

  test('counts a candidate with recent ACP RELAY progress and no usage at all', async () => {
    // The BYOK case: usage age is null by construction, and treating null as
    // "did nothing" is exactly the mistake that would certify a fleet-wide
    // mid-turn kill as safe.
    candidates = [candidate({ lastUsageAgeMs: null, lastAcpRelayAgeMs: 30_000 })];
    expect((await runSandboxDeadlineShadowPass(RUN)).withRecentUsage).toBe(1);
  });

  test('does not count a box whose only progress is older than the grant', async () => {
    candidates = [candidate({ lastUsageAgeMs: 5 * HOUR, lastAcpRelayAgeMs: 5 * HOUR })];
    expect((await runSandboxDeadlineShadowPass(RUN)).withRecentUsage).toBe(0);
  });
});

describe('the observer must never break the tick it rides on', () => {
  test('a failing candidate query is counted, not thrown', async () => {
    candidateError = new Error('db down');
    const result = await runSandboxDeadlineShadowPass(RUN);
    expect(result.errors).toBe(1);
    expect(result.matching).toBe(0);
  });

  test('passes the pacing caps straight through to the kill query', async () => {
    await runSandboxDeadlineShadowPass({ ...RUN, perAccountCap: 5, limit: 25 });
    expect(lastCandidateOpts).toEqual({ perAccountCap: 5, limit: 25 });
  });
});
