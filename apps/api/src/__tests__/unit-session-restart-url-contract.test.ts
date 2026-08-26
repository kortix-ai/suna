import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  RUNTIME_READINESS_CLOCK_KEYS,
  STALE_OPENCODE_BOOT_HARD_MS,
  prepareInPlaceRestartMetadata,
  opencodeReadyWaitPatch,
  runtimeBootEpochMs,
  staleOpencodeReadyReason,
} from '../projects/session-lifecycle/readiness-clocks';
import { RUNTIME_WAKE_CLAIM_CLEARED_KEYS } from '../projects/routes/shared';

const source = readFileSync(
  new URL('../projects/session-lifecycle/actions.ts', import.meta.url),
  'utf8',
);

describe('session restart URL contract', () => {
  test('clears sandboxUrl only when a replacement runtime is required', () => {
    const replacementStart = source.indexOf('const provisionReplacementRuntime');
    const inPlaceStart = source.indexOf('if (\n    existingSandbox?.externalId');

    expect(replacementStart).toBeGreaterThan(-1);
    expect(inPlaceStart).toBeGreaterThan(replacementStart);
    expect(source.slice(replacementStart, inPlaceStart)).toContain('sandboxUrl: null');
    expect(source.slice(inPlaceStart)).not.toContain('sandboxUrl: null');
  });

  test('starts a fresh runtime clock and removes stale OpenCode clocks', () => {
    const now = new Date('2026-07-24T02:00:00.000Z');
    const metadata = prepareInPlaceRestartMetadata(
      {
        initSucceededAt: '2026-07-24T01:00:00.000Z',
        opencodeReadyWaitStartedAt: '2026-07-24T01:00:00.000Z',
        opencodeReadyWaitReason: 'unreachable',
        opencodeUnreachableWaitStartedAt: '2026-07-24T01:00:00.000Z',
        opencodeNotReadyWaitStartedAt: '2026-07-24T01:30:00.000Z',
      },
      now,
    );

    expect(metadata.runtimeWakeStartedAt).toBe(now.toISOString());
    expect(metadata.runtimeWakeProviderStatus).toBe('starting');
    expect(metadata.opencodeReadyWaitStartedAt).toBeUndefined();
    expect(metadata.opencodeReadyWaitReason).toBeUndefined();
    expect(metadata.opencodeUnreachableWaitStartedAt).toBeUndefined();
    expect(metadata.opencodeNotReadyWaitStartedAt).toBeUndefined();
  });

  test('tracks unreachable and not-ready deadlines independently across reason changes', () => {
    const metadata = {
      opencodeReadyWaitStartedAt: '2026-07-24T01:59:59.000Z',
      opencodeReadyWaitReason: 'not_ready',
      opencodeUnreachableWaitStartedAt: '2026-07-24T01:59:29.000Z',
      opencodeNotReadyWaitStartedAt: '2026-07-24T01:58:29.000Z',
    };
    const now = Date.parse('2026-07-24T02:00:00.000Z');

    expect(staleOpencodeReadyReason(metadata, 'unreachable', now, 30_000)).toBe(
      'runtime_unreachable_timeout',
    );
    expect(staleOpencodeReadyReason(metadata, 'not_ready', now, 90_000)).toBe(
      'runtime_not_ready_timeout',
    );
  });

  test('does not treat an old initial boot as a stale post-restart OpenCode wait', () => {
    expect(
      staleOpencodeReadyReason(
        { initSucceededAt: '2026-07-24T01:00:00.000Z' },
        'unreachable',
        Date.parse('2026-07-24T02:00:00.000Z'),
      ),
    ).toBeNull();

    expect(
      staleOpencodeReadyReason(
        { opencodeReadyWaitStartedAt: '2026-07-24T01:54:59.000Z' },
        'unreachable',
        Date.parse('2026-07-24T02:00:00.000Z'),
      ),
    ).toBe('runtime_unreachable_timeout');
  });
});

describe('progress-aware OpenCode boot budget (Essentia 2026-08-25 17:23 double runtime_boot_failed)', () => {
  const t0 = new Date('2026-08-25T17:23:04.000Z');

  test('a phase change restarts the reason clock; the first-seen clock never moves', () => {
    const first = opencodeReadyWaitPatch({}, 'not_ready', 'config-deps|opencode=starting', t0)!;
    expect(first.opencodeBootWaitFirstSeenAt).toBe(t0.toISOString());
    expect(first.opencodeNotReadyWaitStartedAt).toBe(t0.toISOString());
    expect(first.opencodeBootPhase).toBe('config-deps|opencode=starting');

    // Same phase 60 s later: nothing to write.
    const t1 = new Date(t0.getTime() + 60_000);
    expect(opencodeReadyWaitPatch(first, 'not_ready', 'config-deps|opencode=starting', t1)).toBeNull();

    // New phase 80 s later (install finished, OpenCode spawned): clock restarts.
    const t2 = new Date(t0.getTime() + 80_000);
    const second = opencodeReadyWaitPatch(first, 'not_ready', 'opencode-spawned|opencode=starting', t2)!;
    expect(second.opencodeNotReadyWaitStartedAt).toBe(t2.toISOString());
    expect(second.opencodeBootWaitFirstSeenAt).toBe(t0.toISOString());

    // 85 s after the FIRST poll the old rule parked the box; with progress it is not stale.
    const t3 = new Date(t0.getTime() + 85_000);
    expect(staleOpencodeReadyReason(second, 'not_ready', t3.getTime(), 90_000)).toBeNull();
    // ...but 90 s of NO progress after the last phase change still is.
    const t4 = new Date(t2.getTime() + 90_001);
    expect(staleOpencodeReadyReason(second, 'not_ready', t4.getTime(), 90_000)).toBe(
      'runtime_not_ready_timeout',
    );
  });

  test('a legacy row (single clock + reason) counts as a running clock for that reason', () => {
    const legacy = {
      opencodeReadyWaitStartedAt: '2026-08-25T17:23:04.000Z',
      opencodeReadyWaitReason: 'unreachable',
    };
    expect(opencodeReadyWaitPatch(legacy, 'unreachable', undefined, new Date(t0.getTime() + 31_000))).toBeNull();
    expect(staleOpencodeReadyReason(legacy, 'unreachable', t0.getTime() + 31_000, 30_000)).toBe(
      'runtime_unreachable_timeout',
    );
  });

  test('a daemon that reports no phase keeps the old fixed budget', () => {
    const first = opencodeReadyWaitPatch({}, 'not_ready', undefined, t0)!;
    expect(first.opencodeBootPhase).toBeUndefined();
    expect(opencodeReadyWaitPatch(first, 'not_ready', undefined, new Date(t0.getTime() + 80_000))).toBeNull();
    expect(
      staleOpencodeReadyReason(first, 'not_ready', t0.getTime() + 90_001, 90_000),
    ).toBe('runtime_not_ready_timeout');
  });

  test('the hard cap bounds a boot that keeps changing phase without ever becoming ready', () => {
    let metadata = opencodeReadyWaitPatch({}, 'not_ready', 'p0', t0)!;
    for (let i = 1; i <= 12; i += 1) {
      const t = new Date(t0.getTime() + i * 60_000);
      metadata = opencodeReadyWaitPatch(metadata, 'not_ready', `p${i}`, t) ?? metadata;
    }
    const now = t0.getTime() + 12 * 60_000 + 1_000;
    // Reason clock is only 1 s old, yet 12 min have passed since first seen.
    expect(staleOpencodeReadyReason(metadata, 'not_ready', now, 90_000, 10 * 60_000)).toBe(
      'runtime_not_ready_timeout',
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The automatic cooldown rung must not inherit the previous attempt's boot
// budget. Essentia 2026-08-26, session 29861dfa / box inqwpv4a: attempt 1
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
    opencodeBootWaitFirstSeenAt: attempt1.toISOString(),
    opencodeNotReadyWaitStartedAt: attempt1.toISOString(),
    opencodeReadyWaitReason: 'not_ready',
    opencodeBootPhase: 'config-deps|opencode=starting',
    providerRunningConfirmedAt: attempt2.toISOString(),
    // Survives the rung on purpose — it drives the cooldown escalation.
    runtimeStartFailureCount: 1,
  };

  test('THE INCIDENT: the inherited hard cap no longer parks attempt 2 mid-boot', () => {
    // 10m49s after attempt 1's first observation, 59s into attempt 2's boot.
    expect(park.getTime() - attempt1.getTime()).toBeGreaterThan(STALE_OPENCODE_BOOT_HARD_MS);
    expect(park.getTime() - attempt2.getTime()).toBeLessThan(STALE_OPENCODE_BOOT_HARD_MS);
    expect(staleOpencodeReadyReason(inherited, 'not_ready', park.getTime())).toBeNull();
  });

  test('the inherited PER-REASON clock does not stale a fresh boot either', () => {
    // 5-minute default budget, ~11 minutes of inherited clock.
    expect(
      staleOpencodeReadyReason(inherited, 'not_ready', park.getTime(), 5 * 60_000),
    ).toBeNull();
  });

  test('the next observation re-baselines both clocks onto this attempt', () => {
    const patch = opencodeReadyWaitPatch(
      inherited,
      'not_ready',
      'config-deps|opencode=starting',
      park,
    );
    // Written even though the phase is UNCHANGED: the clock it would have
    // returned null for belongs to the previous attempt.
    if (!patch) throw new Error('expected a re-baselining patch');
    expect(patch.opencodeBootWaitFirstSeenAt).toBe(park.toISOString());
    expect(patch.opencodeNotReadyWaitStartedAt).toBe(park.toISOString());
    // The cooldown accounting is untouched by a re-baseline.
    expect(patch.runtimeStartFailureCount).toBe(1);
  });

  test('the budget still bounds THIS attempt — the guard is causal, not a reset', () => {
    const rebaselined = {
      ...inherited,
      opencodeBootWaitFirstSeenAt: attempt2.toISOString(),
      opencodeNotReadyWaitStartedAt: attempt2.toISOString(),
    };
    const past = attempt2.getTime() + STALE_OPENCODE_BOOT_HARD_MS + 1_000;
    expect(staleOpencodeReadyReason(rebaselined, 'not_ready', past)).toBe(
      'runtime_not_ready_timeout',
    );
  });

  test('a stub launcher that changes phase for ever is still caught at the cap', () => {
    // The learning this must not undo: progress restarts the per-reason clock,
    // never the hard cap. Only a NEW boot attempt restarts the cap.
    let row: Record<string, unknown> = { providerRunningConfirmedAt: attempt2.toISOString() };
    for (let i = 0; i < 40; i += 1) {
      const t = new Date(attempt2.getTime() + i * 20_000);
      row = opencodeReadyWaitPatch(row, 'not_ready', `phase-${i}`, t) ?? row;
    }
    const past = attempt2.getTime() + STALE_OPENCODE_BOOT_HARD_MS + 1_000;
    expect(row.opencodeBootWaitFirstSeenAt).toBe(attempt2.toISOString());
    expect(staleOpencodeReadyReason(row, 'not_ready', past)).toBe('runtime_not_ready_timeout');
  });

  test('a boot with advancing phase is never staled inside the cap', () => {
    let row: Record<string, unknown> = { providerRunningConfirmedAt: attempt2.toISOString() };
    for (let i = 0; i < 8; i += 1) {
      const t = new Date(attempt2.getTime() + i * 60_000);
      row = opencodeReadyWaitPatch(row, 'not_ready', `phase-${i}`, t) ?? row;
      expect(staleOpencodeReadyReason(row, 'not_ready', t.getTime() + 59_000, 5 * 60_000)).toBeNull();
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
      staleOpencodeReadyReason(
        { opencodeBootWaitFirstSeenAt: attempt1.toISOString() },
        'not_ready',
        park.getTime(),
      ),
    ).toBe('runtime_not_ready_timeout');
  });
});

describe('who resets the retry accounting', () => {
  test('a human restart resets the failure episode; an automatic rung must not', () => {
    const failing = {
      stopReason: 'runtime_boot_failed',
      runtimeStartFailureCount: 3,
      runtimeStartFailedAt: '2026-08-26T13:27:00.000Z',
      runtimeStartRetryAfterAt: '2026-08-26T13:37:00.000Z',
      opencodeBootWaitFirstSeenAt: '2026-08-26T13:24:00.000Z',
      opencodeBootPhase: 'config-deps|opencode=starting',
    };
    // Human Restart: clocks AND accounting gone, so the ladder starts over.
    const restarted = prepareInPlaceRestartMetadata(failing, new Date('2026-08-26T13:40:00.000Z'));
    for (const key of RUNTIME_READINESS_CLOCK_KEYS) {
      if (key === 'runtimeWakeStartedAt' || key === 'runtimeWakeProviderStatus') continue;
      expect(restarted[key]).toBeUndefined();
    }
    expect(restarted.runtimeStartFailureCount).toBeUndefined();
    expect(restarted.runtimeStartFailedAt).toBeUndefined();
    expect(restarted.stopReason).toBeUndefined();

    // The automatic rung's claim keeps the accounting so the cooldown escalates.
    expect(RUNTIME_WAKE_CLAIM_CLEARED_KEYS).not.toContain('runtimeStartFailureCount');
    expect(RUNTIME_WAKE_CLAIM_CLEARED_KEYS).not.toContain('runtimeStartFailedAt');
    // …and it drops EVERY readiness clock, which is what the incident needed.
    for (const key of RUNTIME_READINESS_CLOCK_KEYS) {
      expect(RUNTIME_WAKE_CLAIM_CLEARED_KEYS).toContain(key);
    }
  });
});
