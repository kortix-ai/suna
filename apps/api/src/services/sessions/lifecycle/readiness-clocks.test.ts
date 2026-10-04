import { describe, expect, test } from 'bun:test';
import { RUNTIME_WAKE_CLAIM_CLEARED_KEYS } from '../open/shared';
import {
  IN_PLACE_RESTART_CLEARED_KEYS,
  RUNTIME_READINESS_CLOCK_KEYS,
  STALE_RUNTIME_BOOT_HARD_MS,
  RUNTIME_PROVEN_AT_KEY,
  runtimeBootEpochMs,
  runtimeReadyWaitPatch,
  servesThroughProbeMiss,
  staleRuntimeReadyReason,
} from './readiness-clocks';
import { STOPPED_SANDBOX_CLEARED_KEYS } from './status-transitions';

describe('readiness clocks', () => {
  test('tracks unreachable and not-ready deadlines independently across reason changes', () => {
    const metadata = {
      runtimeReadyWaitStartedAt: '2026-07-24T01:59:59.000Z',
      runtimeReadyWaitReason: 'not_ready',
      runtimeUnreachableWaitStartedAt: '2026-07-24T01:59:29.000Z',
      runtimeNotReadyWaitStartedAt: '2026-07-24T01:58:29.000Z',
    };
    const now = Date.parse('2026-07-24T02:00:00.000Z');

    expect(staleRuntimeReadyReason(metadata, 'unreachable', now, 30_000)).toBe(
      'runtime_unreachable_timeout',
    );
    expect(staleRuntimeReadyReason(metadata, 'not_ready', now, 90_000)).toBe(
      'runtime_not_ready_timeout',
    );
  });

  test('does not treat an old initial boot as a stale post-restart OpenCode wait', () => {
    expect(
      staleRuntimeReadyReason(
        { initSucceededAt: '2026-07-24T01:00:00.000Z' },
        'unreachable',
        Date.parse('2026-07-24T02:00:00.000Z'),
      ),
    ).toBeNull();

    expect(
      staleRuntimeReadyReason(
        { runtimeReadyWaitStartedAt: '2026-07-24T01:54:59.000Z' },
        'unreachable',
        Date.parse('2026-07-24T02:00:00.000Z'),
      ),
    ).toBe('runtime_unreachable_timeout');
  });
});

describe('progress-aware OpenCode boot budget (SampleCo 2026-08-25 17:23 double runtime_boot_failed)', () => {
  const t0 = new Date('2026-08-25T17:23:04.000Z');

  test('a phase change restarts the reason clock; the first-seen clock never moves', () => {
    const first = runtimeReadyWaitPatch({}, 'not_ready', 'config-deps|opencode=starting', t0)!;
    expect(first.runtimeBootWaitFirstSeenAt).toBe(t0.toISOString());
    expect(first.runtimeNotReadyWaitStartedAt).toBe(t0.toISOString());
    expect(first.runtimeBootPhase).toBe('config-deps|opencode=starting');

    // Same phase 60 s later: nothing to write.
    const t1 = new Date(t0.getTime() + 60_000);
    expect(runtimeReadyWaitPatch(first, 'not_ready', 'config-deps|opencode=starting', t1)).toBeNull();

    // New phase 80 s later (install finished, OpenCode spawned): clock restarts.
    const t2 = new Date(t0.getTime() + 80_000);
    const second = runtimeReadyWaitPatch(first, 'not_ready', 'opencode-spawned|opencode=starting', t2)!;
    expect(second.runtimeNotReadyWaitStartedAt).toBe(t2.toISOString());
    expect(second.runtimeBootWaitFirstSeenAt).toBe(t0.toISOString());

    // 85 s after the FIRST poll the old rule parked the box; with progress it is not stale.
    const t3 = new Date(t0.getTime() + 85_000);
    expect(staleRuntimeReadyReason(second, 'not_ready', t3.getTime(), 90_000)).toBeNull();
    // ...but 90 s of NO progress after the last phase change still is.
    const t4 = new Date(t2.getTime() + 90_001);
    expect(staleRuntimeReadyReason(second, 'not_ready', t4.getTime(), 90_000)).toBe(
      'runtime_not_ready_timeout',
    );
  });

  test('a legacy row (single clock + reason) counts as a running clock for that reason', () => {
    const legacy = {
      runtimeReadyWaitStartedAt: '2026-08-25T17:23:04.000Z',
      runtimeReadyWaitReason: 'unreachable',
    };
    expect(runtimeReadyWaitPatch(legacy, 'unreachable', undefined, new Date(t0.getTime() + 31_000))).toBeNull();
    expect(staleRuntimeReadyReason(legacy, 'unreachable', t0.getTime() + 31_000, 30_000)).toBe(
      'runtime_unreachable_timeout',
    );
  });

  test('a daemon that reports no phase keeps the old fixed budget', () => {
    const first = runtimeReadyWaitPatch({}, 'not_ready', undefined, t0)!;
    expect(first.runtimeBootPhase).toBeUndefined();
    expect(runtimeReadyWaitPatch(first, 'not_ready', undefined, new Date(t0.getTime() + 80_000))).toBeNull();
    expect(
      staleRuntimeReadyReason(first, 'not_ready', t0.getTime() + 90_001, 90_000),
    ).toBe('runtime_not_ready_timeout');
  });

  test('the hard cap bounds a boot that keeps changing phase without ever becoming ready', () => {
    let metadata = runtimeReadyWaitPatch({}, 'not_ready', 'p0', t0)!;
    for (let i = 1; i <= 12; i += 1) {
      const t = new Date(t0.getTime() + i * 60_000);
      metadata = runtimeReadyWaitPatch(metadata, 'not_ready', `p${i}`, t) ?? metadata;
    }
    const now = t0.getTime() + 12 * 60_000 + 1_000;
    // Reason clock is only 1 s old, yet 12 min have passed since first seen.
    expect(staleRuntimeReadyReason(metadata, 'not_ready', now, 90_000, 10 * 60_000)).toBe(
      'runtime_not_ready_timeout',
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The automatic cooldown rung must not inherit the previous attempt's boot
// budget. SampleCo 2026-08-26, one session on an E2B box: attempt 1
// failed ~13:27; the rung re-attempted ~13:33; the daemon booted through
// 13:34:48.8, authenticated to the gateway 13:34:48.5-49.1 and claimed its
// initial turn at 13:34:49.216 — and `/start` parked the box at 13:34:49.202.
// It lost by 14 ms to a 10-minute cap that had been running since attempt 1.
// ───────────────────────────────────────────────────────────────────────────
describe('an automatic rung never inherits the previous attempt boot budget', () => {
  const attempt1 = new Date('2026-08-26T13:24:00.000Z');
  // The cooldown rung's wake finalized here — the boot epoch for attempt 2.
  const attempt2 = new Date('2026-08-26T13:33:50.000Z');
  const park = new Date('2026-08-26T13:34:49.202Z');

  /** The row as attempt 1 left it, after the park and the rung's resume. */
  const inherited = {
    runtimeBootWaitFirstSeenAt: attempt1.toISOString(),
    runtimeNotReadyWaitStartedAt: attempt1.toISOString(),
    runtimeReadyWaitReason: 'not_ready',
    runtimeBootPhase: 'config-deps|opencode=starting',
    providerRunningConfirmedAt: attempt2.toISOString(),
    // Survives the rung on purpose — it drives the cooldown escalation.
    runtimeStartFailureCount: 1,
  };

  test('THE INCIDENT: the inherited hard cap no longer parks attempt 2 mid-boot', () => {
    // 10m49s after attempt 1's first observation, 59s into attempt 2's boot.
    expect(park.getTime() - attempt1.getTime()).toBeGreaterThan(STALE_RUNTIME_BOOT_HARD_MS);
    expect(park.getTime() - attempt2.getTime()).toBeLessThan(STALE_RUNTIME_BOOT_HARD_MS);
    expect(staleRuntimeReadyReason(inherited, 'not_ready', park.getTime())).toBeNull();
  });

  test('the inherited PER-REASON clock does not stale a fresh boot either', () => {
    // 5-minute default budget, ~11 minutes of inherited clock.
    expect(
      staleRuntimeReadyReason(inherited, 'not_ready', park.getTime(), 5 * 60_000),
    ).toBeNull();
  });

  test('the next observation re-baselines both clocks onto this attempt', () => {
    const patch = runtimeReadyWaitPatch(
      inherited,
      'not_ready',
      'config-deps|opencode=starting',
      park,
    );
    // Written even though the phase is UNCHANGED: the clock it would have
    // returned null for belongs to the previous attempt.
    if (!patch) throw new Error('expected a re-baselining patch');
    expect(patch.runtimeBootWaitFirstSeenAt).toBe(park.toISOString());
    expect(patch.runtimeNotReadyWaitStartedAt).toBe(park.toISOString());
    // The cooldown accounting is untouched by a re-baseline.
    expect(patch.runtimeStartFailureCount).toBe(1);
  });

  test('a stub launcher that changes phase for ever is still caught at the cap', () => {
    // The learning this must not undo: progress restarts the per-reason clock,
    // never the hard cap. Only a NEW boot attempt restarts the cap.
    let row: Record<string, unknown> = { providerRunningConfirmedAt: attempt2.toISOString() };
    for (let i = 0; i < 40; i += 1) {
      const t = new Date(attempt2.getTime() + i * 20_000);
      row = runtimeReadyWaitPatch(row, 'not_ready', `phase-${i}`, t) ?? row;
    }
    const past = attempt2.getTime() + STALE_RUNTIME_BOOT_HARD_MS + 1_000;
    expect(row.runtimeBootWaitFirstSeenAt).toBe(attempt2.toISOString());
    expect(staleRuntimeReadyReason(row, 'not_ready', past)).toBe('runtime_not_ready_timeout');
  });

  test('a boot with advancing phase is never staled inside the cap', () => {
    let row: Record<string, unknown> = { providerRunningConfirmedAt: attempt2.toISOString() };
    for (let i = 0; i < 8; i += 1) {
      const t = new Date(attempt2.getTime() + i * 60_000);
      row = runtimeReadyWaitPatch(row, 'not_ready', `phase-${i}`, t) ?? row;
      expect(staleRuntimeReadyReason(row, 'not_ready', t.getTime() + 59_000, 5 * 60_000)).toBeNull();
    }
  });

  test('runtimeBootEpochMs takes the NEWEST mark, and is inert without one', () => {
    expect(runtimeBootEpochMs({})).toBeNull();
    expect(
      runtimeBootEpochMs({
        initSucceededAt: attempt1.toISOString(),
        providerRunningConfirmedAt: attempt2.toISOString(),
      }),
    ).toBe(attempt2.getTime());
    // No epoch ⇒ the guard cannot fire, so legacy rows behave exactly as before.
    expect(
      staleRuntimeReadyReason(
        { runtimeBootWaitFirstSeenAt: attempt1.toISOString() },
        'not_ready',
        park.getTime(),
      ),
    ).toBe('runtime_not_ready_timeout');
  });
});

describe('who resets the retry accounting', () => {
  // A human Restart clears the accounting (proven on real rows in
  // integration-sandbox-metadata-race). The automatic rung's claim must keep
  // it, so the cooldown escalates, and must drop every readiness clock, so the
  // next attempt boots against a clean budget.
  test('an automatic wake claim keeps the failure accounting and drops every readiness clock', () => {
    expect(RUNTIME_WAKE_CLAIM_CLEARED_KEYS).not.toContain('runtimeStartFailureCount');
    expect(RUNTIME_WAKE_CLAIM_CLEARED_KEYS).not.toContain('runtimeStartFailedAt');
    for (const key of RUNTIME_READINESS_CLOCK_KEYS) {
      expect(RUNTIME_WAKE_CLAIM_CLEARED_KEYS).toContain(key);
    }
  });
});

describe('servesThroughProbeMiss — a box proven this boot is never parked by its ingress', () => {
  const booted = { providerRunningConfirmedAt: '2026-09-29T21:19:31.000Z' };
  const proven = { ...booted, [RUNTIME_PROVEN_AT_KEY]: '2026-09-29T21:19:52.000Z' };
  const now = Date.parse('2026-09-29T21:48:27.000Z');

  test('an ingress timeout, 502 or bare edge 503 on a proven box keeps serving', () => {
    expect(servesThroughProbeMiss(proven, { reason: 'unreachable' }, now)).toBe(true);
    expect(servesThroughProbeMiss(proven, { reason: 'not_ready' }, now)).toBe(true);
  });

  test('a daemon that answers is believed', () => {
    expect(servesThroughProbeMiss(proven, { reason: 'unchanged' }, now)).toBe(false);
    expect(servesThroughProbeMiss(proven, { reason: 'healed' }, now)).toBe(false);
    // The daemon names its boot phase: OpenCode really is restarting.
    expect(servesThroughProbeMiss(proven, { reason: 'not_ready', bootPhase: 'opencode' }, now)).toBe(false);
    // The daemon listed zero sessions: it answered.
    expect(servesThroughProbeMiss(proven, { reason: 'not_ready', sessions: [] }, now)).toBe(false);
  });

  test('a box never proven this boot keeps the boot budgets', () => {
    expect(servesThroughProbeMiss(booted, { reason: 'unreachable' }, now)).toBe(false);
    // Proven before a wake: the wake moved the boot epoch past the proof.
    const woken = { ...proven, runtimeWakeStartedAt: '2026-09-29T21:30:00.000Z' };
    expect(servesThroughProbeMiss(woken, { reason: 'unreachable' }, now)).toBe(false);
  });

  test('a repair in flight is a real relaunch, not an ingress blip', () => {
    const repairing = {
      ...proven,
      legacyRuntimeBootstrap: { state: 'running', lastAttemptAt: '2026-09-29T21:47:00.000Z' },
    };
    expect(servesThroughProbeMiss(repairing, { reason: 'unreachable' }, now)).toBe(false);
  });

  test('a stopped row cannot keep the proof', () => {
    expect(STOPPED_SANDBOX_CLEARED_KEYS).toContain(RUNTIME_PROVEN_AT_KEY);
  });
});

describe('neutral readiness keys: runtime* written, pre-W4 opencode* still read', () => {
  const t0 = new Date('2026-09-30T10:00:00.000Z');
  const PRE_W4_SPELLING: Record<string, string> = {
    runtimeReadyWaitStartedAt: 'opencodeReadyWaitStartedAt',
    runtimeReadyWaitReason: 'opencodeReadyWaitReason',
    runtimeUnreachableWaitStartedAt: 'opencodeUnreachableWaitStartedAt',
    runtimeNotReadyWaitStartedAt: 'opencodeNotReadyWaitStartedAt',
    runtimeBootPhase: 'opencodeBootPhase',
    runtimeBootWaitFirstSeenAt: 'opencodeBootWaitFirstSeenAt',
    runtimeUnreachableCause: 'opencodeUnreachableCause',
    runtimeUnreachableCauseAt: 'opencodeUnreachableCauseAt',
    runtimeUnreachableResponder: 'opencodeUnreachableResponder',
    runtimeUnreachableDetail: 'opencodeUnreachableDetail',
  };

  test('an observation writes only runtime* keys', () => {
    expect(runtimeReadyWaitPatch({}, 'unreachable', 'boot|state=starting', t0)).toEqual({
      runtimeReadyWaitStartedAt: t0.toISOString(),
      runtimeReadyWaitReason: 'unreachable',
      runtimeUnreachableWaitStartedAt: t0.toISOString(),
      runtimeBootWaitFirstSeenAt: t0.toISOString(),
      runtimeBootPhase: 'boot|state=starting',
    });
  });

  test('a row an older API stamped keeps its budgets', () => {
    const preW4 = {
      opencodeReadyWaitStartedAt: t0.toISOString(),
      opencodeReadyWaitReason: 'not_ready',
      opencodeNotReadyWaitStartedAt: t0.toISOString(),
      opencodeBootWaitFirstSeenAt: t0.toISOString(),
      opencodeBootPhase: 'p0',
    };
    // Same phase, clock running: nothing to write.
    expect(runtimeReadyWaitPatch(preW4, 'not_ready', 'p0', new Date(t0.getTime() + 60_000))).toBeNull();
    // The per-reason clock still spends.
    expect(staleRuntimeReadyReason(preW4, 'not_ready', t0.getTime() + 90_001, 90_000)).toBe(
      'runtime_not_ready_timeout',
    );
    // The hard cap still spends.
    expect(
      staleRuntimeReadyReason(
        { opencodeBootWaitFirstSeenAt: t0.toISOString() },
        'not_ready',
        t0.getTime() + STALE_RUNTIME_BOOT_HARD_MS + 1_000,
      ),
    ).toBe('runtime_not_ready_timeout');
    // A new phase moves the first-seen clock to the neutral key without resetting it.
    const next = runtimeReadyWaitPatch(preW4, 'not_ready', 'p1', new Date(t0.getTime() + 80_000))!;
    expect(next.runtimeBootWaitFirstSeenAt).toBe(t0.toISOString());
    expect(next.runtimeBootPhase).toBe('p1');
  });

  test('the neutral key wins over a pre-W4 key on the same row', () => {
    const both = {
      opencodeNotReadyWaitStartedAt: t0.toISOString(),
      runtimeNotReadyWaitStartedAt: new Date(t0.getTime() + 80_000).toISOString(),
    };
    expect(staleRuntimeReadyReason(both, 'not_ready', t0.getTime() + 90_001, 90_000)).toBeNull();
  });

  test('every clearing list strips both spellings', () => {
    for (const [neutral, preW4] of Object.entries(PRE_W4_SPELLING)) {
      for (const list of [
        RUNTIME_READINESS_CLOCK_KEYS,
        RUNTIME_WAKE_CLAIM_CLEARED_KEYS,
        IN_PLACE_RESTART_CLEARED_KEYS,
      ]) {
        expect(list as readonly string[]).toContain(neutral);
        expect(list as readonly string[]).toContain(preW4);
      }
    }
  });
});
